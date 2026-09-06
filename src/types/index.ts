/**
 * @file src/types/index.ts
 * @description Central type definitions for the MEV Searcher Bot.
 *
 * All ETH and token amounts use bigint to prevent floating-point
 * precision loss. JavaScript's number type cannot safely represent
 * values above 2^53, but ETH values in wei routinely exceed this.
 *
 * These types are shared across all modules — never duplicate them.
 */

export interface PendingTransaction {
  /** Keccak-256 hash of the signed transaction */
  hash: string;
  /** EOA or contract address that signed and submitted the transaction */
  from: string;
  /** Recipient address; null when this is a contract deployment */
  to: string | null;
  /** ETH transferred in this transaction, denominated in wei */
  value: bigint;
  /** Legacy (pre-EIP-1559) gas price in wei per gas unit */
  gasPrice: bigint;
  /** EIP-1559 absolute cap on total fee per gas unit, in wei */
  maxFeePerGas: bigint | null;
  /** EIP-1559 tip paid to the block proposer per gas unit, in wei */
  maxPriorityFeePerGas: bigint | null;
  /** ABI-encoded calldata passed to the recipient contract */
  data: string;
  /** Account nonce; must match the sender's on-chain nonce exactly */
  nonce: number;
  /** EIP-155 chain identifier protecting against replay attacks */
  chainId: number;
}

export interface UniswapV2Swap {
  /** Hash of the pending transaction that contains this swap call */
  txHash: string;
  /** Address of the token being sold by the user */
  tokenIn: string;
  /** Address of the token being bought by the user */
  tokenOut: string;
  /** Exact amount of tokenIn the user is selling, in smallest token unit */
  amountIn: bigint;
  /** Minimum acceptable amount of tokenOut; slippage protection floor */
  amountOutMin: bigint;
  /** Unix timestamp after which the transaction reverts automatically */
  deadline: bigint;
  /** Ordered list of token addresses defining the swap route */
  path: string[];
  /** Uniswap V2 router contract that will execute the swap */
  router: string;
  /** Block number when this swap was observed in the mempool */
  blockNumber: number;
}

/** Which detection strategy surfaced an opportunity. */
export type ArbitrageStrategy = 'v2-v2' | 'v2-v3' | 'triangular';

export interface ArbitrageOpportunity {
  /** Unique identifier for this opportunity (UUID v4) */
  id: string;
  /** Detection strategy that found this opportunity */
  strategyType: ArbitrageStrategy;
  /** Unix timestamp in milliseconds when this opportunity was detected */
  timestamp: number;
  /** The victim swap transaction that creates the price impact we exploit */
  swapTx: UniswapV2Swap;
  /** First token in the arbitrage pair (common base asset, e.g. WETH) */
  tokenA: string;
  /** Second token in the arbitrage pair (the swapped asset) */
  tokenB: string;
  /** Address of the Uniswap V2 pool used for the first leg of arbitrage */
  poolA: string;
  /** Address of the Uniswap V2 pool used for the second leg of arbitrage */
  poolB: string;
  /** Gross profit estimate before gas deduction, in wei */
  estimatedProfitWei: bigint;
  /** Estimated gas cost for the full arbitrage bundle, in wei */
  estimatedGasCostWei: bigint;
  /** Net profit after gas deduction; negative means unprofitable */
  netProfitWei: bigint;
  /** True when netProfitWei exceeds the configured minProfitWei threshold */
  isProfitable: boolean;
  /** Model confidence in the profit estimate; 0.0 = uncertain, 1.0 = high certainty */
  confidence: number;
}

export interface BotConfig {
  /** Alchemy WebSocket endpoint URL for mempool subscription */
  wsUrl: string;
  /** Alchemy HTTP endpoint URL for eth_call simulations */
  httpUrl: string;
  /** Flashbots bundle relay URL (mainnet or Sepolia) */
  flashbotsRelayUrl: string;
  /** Hex-encoded private key of the searcher execution wallet */
  executorPrivateKey: string;
  /** On-chain address of the deployed FlashExecutor.sol contract */
  executorContractAddress: string;
  /** EIP-155 chain ID; 1 for mainnet, 11155111 for Sepolia */
  chainId: number;
  /** Pino log level string: trace | debug | info | warn | error */
  logLevel: string;
  /** Filesystem path to the SQLite database file */
  dbPath: string;
  /** Minimum net profit required to submit a bundle, in wei */
  minProfitWei: bigint;
  /** Upper gas price ceiling; opportunities above this are skipped, in gwei */
  maxGasPriceGwei: bigint;
}

export interface BundleResult {
  /** True when the bundle was accepted and included in a block */
  success: boolean;
  /** Flashbots bundle hash returned by the relay; null on submission failure */
  bundleHash: string | null;
  /** Target block number the bundle was submitted for */
  blockNumber: number;
  /** Actual profit captured if included, or estimated profit if simulated, in wei */
  profitWei: bigint;
  /** Total gas units consumed by all transactions in the bundle */
  gasUsed: bigint;
  /** Human-readable error message when success is false */
  error: string | undefined;
}

export interface PoolReserves {
  /** Raw reserve of token0 held by the pool, in token0's smallest unit */
  reserve0: bigint;
  /** Raw reserve of token1 held by the pool, in token1's smallest unit */
  reserve1: bigint;
  /** Canonical address of token0 (lower address by Uniswap sort order) */
  token0: string;
  /** Canonical address of token1 (higher address by Uniswap sort order) */
  token1: string;
  /** Pool swap fee in basis points; 30 for standard Uniswap V2 (0.3%) */
  fee: number;
}

export interface SimulationResult {
  /** True when the simulated bundle executes without reverting */
  success: boolean;
  /** Net profit from the simulation, in wei */
  profitWei: bigint;
  /** Gas units consumed during simulation */
  gasUsed: bigint;
  /** EVM revert reason string when success is false */
  revertReason: string | undefined;
}

export interface MetricsSummary {
  /** Seconds elapsed since the bot process started */
  uptimeSeconds: number;
  /** Total number of mempool transactions inspected */
  txScanned: number;
  /** Number of arbitrage opportunities detected above the profit threshold */
  opportunitiesFound: number;
  /** Number of Flashbots bundles submitted to the relay */
  bundlesSubmitted: number;
  /** Cumulative profit captured across all successful bundles, in wei */
  totalProfitWei: bigint;
  /** Human-readable profit formatted to 6 decimal places in ETH */
  totalProfitEth: string;
  /** Bundle success rate as a percentage string, e.g. "42.50%" */
  successRate: string;
}
