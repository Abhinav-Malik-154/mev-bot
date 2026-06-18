/**
 * @file src/executor/bundleBuilder.ts
 * @description Flashbots bundle construction.
 *
 * A Flashbots bundle is an ordered list of transactions that
 * must be mined together in a single block, in exact order.
 * If any transaction in the bundle reverts, the entire bundle
 * is rejected — protecting us from partial execution losses.
 *
 * Our bundle structure for a two-leg arbitrage:
 *   TX A (optional):  ERC20 approve tokenA on routerA (if allowance insufficient)
 *   TX B:             swapExactTokensForTokens on poolA — buy tokenB with tokenA
 *   TX C (optional):  ERC20 approve tokenB on routerB (if allowance insufficient)
 *   TX D:             swapExactTokensForTokens on poolB — sell tokenB back for tokenA
 *
 * Approve transactions are included only when the current on-chain allowance
 * is below the required swap amount — typical after first wallet deployment.
 *
 * Amounts are recalculated from fresh pool reserves at build time rather than
 * relying on detection-time values, minimising stale-data risk between
 * the detector and executor phases.
 *
 * All transactions use EIP-1559 fee fields. maxFeePerGas is set to 2× the
 * current base fee to guarantee inclusion even if the base fee rises by one
 * doubling period (the maximum allowed per block).
 */

import { Wallet, JsonRpcProvider, Contract, parseUnits, Interface } from 'ethers';
import { createModuleLogger } from '../utils/logger.js';
import { config } from '../config.js';
import { getAmountOut, findOptimalAmountIn } from '../detector/math.js';
import {
  getPoolReserves,
  sortTokens,
  computePairAddress,
  UNISWAP_V2_FACTORY,
  UNISWAP_V2_INIT_CODE_HASH,
} from '../detector/pools.js';
import type { ArbitrageOpportunity } from '../types/index.js';

const logger = createModuleLogger('bundleBuilder');

// Deployed router addresses — these route through pool pairs on their respective DEXes
const UNISWAP_V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const SUSHISWAP_ROUTER = '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F';

// Every known DEX with factory+initCodeHash (for deterministic pair address) and router address.
// Used to resolve which router contract to call for a given pool address.
const KNOWN_DEXES: ReadonlyArray<{
  readonly factory: string;
  readonly initCodeHash: string;
  readonly router: string;
  readonly name: string;
}> = [
  {
    factory: UNISWAP_V2_FACTORY,
    initCodeHash: UNISWAP_V2_INIT_CODE_HASH,
    router: UNISWAP_V2_ROUTER,
    name: 'Uniswap V2',
  },
  {
    factory: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
    initCodeHash: '0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303',
    router: SUSHISWAP_ROUTER,
    name: 'SushiSwap',
  },
];

const ROUTER_ABI = [
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external payable returns (uint256[] memory amounts)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
];

// Max uint256 — standard max-approval pattern used by MEV bots to avoid repeated approve txs
const MAX_UINT256 = 2n ** 256n - 1n;

// 1% total slippage budget per leg (applied as minimum-out floor)
const SLIPPAGE_NUMERATOR = 990n;
const SLIPPAGE_DENOMINATOR = 1000n;

const APPROVE_GAS_LIMIT = 60_000n;
const SWAP_GAS_LIMIT = 200_000n;

interface ERC20AllowanceReader {
  allowance(owner: string, spender: string): Promise<bigint>;
}

export interface BundleTransaction {
  to: string;
  data: string;
  value: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonce: number;
  chainId: number;
}

export interface BuiltBundle {
  transactions: BundleTransaction[];
  targetBlockNumber: number;
  expectedProfitWei: bigint;
  estimatedGasUsed: bigint;
}

/**
 * Resolves the router address for a given pool by deterministically computing
 * the pair address for each known DEX factory and comparing to the supplied
 * pool address. Falls back to the Uniswap V2 router for unrecognised pools.
 */
function resolveRouter(poolAddress: string, tokenA: string, tokenB: string): string {
  const normalizedPool = poolAddress.toLowerCase();
  for (const dex of KNOWN_DEXES) {
    const computed = computePairAddress(tokenA, tokenB, dex.factory, dex.initCodeHash);
    if (computed.toLowerCase() === normalizedPool) {
      logger.debug({ poolAddress, dex: dex.name }, 'Resolved router');
      return dex.router;
    }
  }
  logger.warn({ poolAddress }, 'Pool not matched to any known DEX — defaulting to Uniswap V2 router');
  return UNISWAP_V2_ROUTER;
}

/**
 * Encodes a Uniswap V2 swapExactTokensForTokens call.
 * Returns the ABI-encoded calldata as a hex string.
 */
export function encodeSwapExactTokensForTokens(
  amountIn: bigint,
  amountOutMin: bigint,
  path: string[],
  recipient: string,
  deadline: bigint,
): string {
  const iface = new Interface(ROUTER_ABI);
  return iface.encodeFunctionData('swapExactTokensForTokens', [
    amountIn,
    amountOutMin,
    path,
    recipient,
    deadline,
  ]);
}

/**
 * Calculates the deadline timestamp for a swap.
 * Default: current timestamp + 2 minutes (120 seconds).
 */
export function calculateDeadline(offsetSeconds: number): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + offsetSeconds);
}

/**
 * Builds an arbitrage bundle for a detected opportunity.
 *
 * Recalculates optimal input amount from fresh pool reserves to minimise
 * stale-data exposure between detection and execution. Includes approve
 * transactions only when the existing on-chain allowance is insufficient.
 *
 * Throws if reserves are unavailable or no profitable amount can be found
 * with the fresh reserve snapshot (market may have moved).
 */
export async function buildArbitrageBundle(
  opportunity: ArbitrageOpportunity,
  wallet: Wallet,
  provider: JsonRpcProvider,
  targetBlockNumber: number,
): Promise<BuiltBundle> {
  const routerA = resolveRouter(opportunity.poolA, opportunity.tokenA, opportunity.tokenB);
  const routerB = resolveRouter(opportunity.poolB, opportunity.tokenA, opportunity.tokenB);

  // Fetch both pools' reserves in parallel for speed
  const [reservesA, reservesB] = await Promise.all([
    getPoolReserves(opportunity.poolA, provider),
    getPoolReserves(opportunity.poolB, provider),
  ]);

  if (reservesA === null || reservesB === null) {
    throw new Error(
      `Cannot fetch reserves — poolA=${opportunity.poolA} poolB=${opportunity.poolB}`,
    );
  }

  // Determine which reserve slot corresponds to tokenA vs tokenB
  // Uniswap V2 always stores token0 < token1 by address sort order
  const [token0] = sortTokens(opportunity.tokenA, opportunity.tokenB);
  const tokenAIsToken0 = opportunity.tokenA.toLowerCase() === token0.toLowerCase();

  // poolA leg: input tokenA, output tokenB
  const rInA  = tokenAIsToken0 ? reservesA.reserve0 : reservesA.reserve1;
  const rOutA = tokenAIsToken0 ? reservesA.reserve1 : reservesA.reserve0;

  // poolB leg: input tokenB, output tokenA (reversed perspective)
  const rInB  = tokenAIsToken0 ? reservesB.reserve1 : reservesB.reserve0;
  const rOutB = tokenAIsToken0 ? reservesB.reserve0 : reservesB.reserve1;

  // Cap at 10% of smaller reserve to avoid catastrophic price impact on either pool
  const maxAmountIn = (rInA < rInB ? rInA : rInB) / 10n;
  const { optimalAmountIn, expectedProfit } = findOptimalAmountIn(
    rInA, rOutA, rInB, rOutB, maxAmountIn,
  );

  if (optimalAmountIn === 0n || expectedProfit === 0n) {
    throw new Error('No profitable amount found with fresh reserves — market may have moved');
  }

  // Intermediate token amount: tokenB received from the first swap leg
  const midAmount = getAmountOut(optimalAmountIn, rInA, rOutA);

  // Apply slippage floor: accept at least 99% of the expected output per leg
  const amountOutMinLeg1 = (midAmount * SLIPPAGE_NUMERATOR) / SLIPPAGE_DENOMINATOR;
  const finalAmount = getAmountOut(midAmount, rInB, rOutB);
  const amountOutMinLeg2 = (finalAmount * SLIPPAGE_NUMERATOR) / SLIPPAGE_DENOMINATOR;

  // EIP-1559 parameters: bid 2× base fee to survive a full doubling period.
  // baseFeePerGas is available on Block in ethers v6; fall back to 20 gwei if
  // we're on a legacy network or the field is absent (e.g. some private forks).
  const latestBlock = await provider.getBlock('latest');
  const baseFee = latestBlock?.baseFeePerGas ?? parseUnits('20', 'gwei');
  const maxFeePerGas = baseFee * 2n;
  const maxPriorityFeePerGas = parseUnits('2', 'gwei');

  let nonce = await provider.getTransactionCount(wallet.address, 'pending');
  const chainId = config.chainId;
  const deadline = calculateDeadline(120);
  const erc20Iface = new Interface(ERC20_ABI);

  const transactions: BundleTransaction[] = [];

  // Approve tokenA on routerA only if current allowance is insufficient
  const erc20A = new Contract(opportunity.tokenA, ERC20_ABI, provider) as unknown as ERC20AllowanceReader;
  const allowanceA = await erc20A.allowance(wallet.address, routerA);
  if (allowanceA < optimalAmountIn) {
    transactions.push({
      to: opportunity.tokenA,
      data: erc20Iface.encodeFunctionData('approve', [routerA, MAX_UINT256]),
      value: 0n,
      gasLimit: APPROVE_GAS_LIMIT,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce,
      chainId,
    });
    nonce += 1;
  }

  // Leg 1: swap tokenA → tokenB on poolA (buy tokenB where it is cheaper)
  transactions.push({
    to: routerA,
    data: encodeSwapExactTokensForTokens(
      optimalAmountIn,
      amountOutMinLeg1,
      [opportunity.tokenA, opportunity.tokenB],
      wallet.address,
      deadline,
    ),
    value: 0n,
    gasLimit: SWAP_GAS_LIMIT,
    maxFeePerGas,
    maxPriorityFeePerGas,
    nonce,
    chainId,
  });
  nonce += 1;

  // Approve tokenB on routerB only if current allowance is insufficient
  const erc20B = new Contract(opportunity.tokenB, ERC20_ABI, provider) as unknown as ERC20AllowanceReader;
  const allowanceB = await erc20B.allowance(wallet.address, routerB);
  if (allowanceB < midAmount) {
    transactions.push({
      to: opportunity.tokenB,
      data: erc20Iface.encodeFunctionData('approve', [routerB, MAX_UINT256]),
      value: 0n,
      gasLimit: APPROVE_GAS_LIMIT,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce,
      chainId,
    });
    nonce += 1;
  }

  // Leg 2: swap tokenB → tokenA on poolB (sell tokenB where it is more expensive)
  transactions.push({
    to: routerB,
    data: encodeSwapExactTokensForTokens(
      midAmount,
      amountOutMinLeg2,
      [opportunity.tokenB, opportunity.tokenA],
      wallet.address,
      deadline,
    ),
    value: 0n,
    gasLimit: SWAP_GAS_LIMIT,
    maxFeePerGas,
    maxPriorityFeePerGas,
    nonce,
    chainId,
  });

  // Sum all per-tx gas limits for a conservative upper-bound estimate
  const estimatedGasUsed = transactions.reduce((acc, tx) => acc + tx.gasLimit, 0n);

  logger.debug(
    {
      poolA: opportunity.poolA,
      routerA,
      poolB: opportunity.poolB,
      routerB,
      optimalAmountIn: optimalAmountIn.toString(),
      midAmount: midAmount.toString(),
      expectedProfit: expectedProfit.toString(),
      txCount: transactions.length,
      targetBlockNumber,
    },
    'Bundle assembled',
  );

  return {
    transactions,
    targetBlockNumber,
    expectedProfitWei: expectedProfit,
    estimatedGasUsed,
  };
}
