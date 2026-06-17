/**
 * @file src/mempool/parser.ts
 * @description Uniswap V2 transaction decoder.
 *
 * Raw pending transactions arrive as hex-encoded calldata.
 * This module decodes that calldata to extract swap parameters.
 *
 * We target Uniswap V2's swap functions because:
 * 1. They are the most common swap type by volume
 * 2. The amountOutMin parameter reveals the slippage tolerance
 * 3. Large swaps with high slippage create the best arb opportunities
 *
 * The function selector (first 4 bytes of calldata) identifies
 * which function is being called. We check for known Uniswap V2
 * swap selectors before attempting to decode.
 */

import { Interface, id } from 'ethers';
import { createModuleLogger } from '../utils/logger.js';
import type { PendingTransaction, UniswapV2Swap } from '../types/index.js';

const logger = createModuleLogger('parser');

const UNISWAP_V2_ABI: readonly string[] = [
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
];

export const UNISWAP_V2_ROUTERS: ReadonlySet<string> = new Set([
  '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Uniswap V2 mainnet
  '0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008', // Sepolia test router
]);

export const UNISWAP_V2_WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
export const SEPOLIA_WETH = '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9';

const uniswapV2Interface = new Interface(UNISWAP_V2_ABI);

// Lowercase mirror of UNISWAP_V2_ROUTERS used for case-insensitive address matching.
// Ethereum addresses from providers may arrive in any casing.
const ROUTERS_LOWER: ReadonlySet<string> = new Set(
  [...UNISWAP_V2_ROUTERS].map((addr) => addr.toLowerCase()),
);

const SWAP_SELECTORS: ReadonlySet<string> = new Set([
  id('swapExactTokensForTokens(uint256,uint256,address[],address,uint256)').slice(0, 10),
  id('swapTokensForExactTokens(uint256,uint256,address[],address,uint256)').slice(0, 10),
  id('swapExactETHForTokens(uint256,address[],address,uint256)').slice(0, 10),
  id('swapExactTokensForETH(uint256,uint256,address[],address,uint256)').slice(0, 10),
]);

export function isUniswapV2Swap(tx: PendingTransaction): boolean {
  if (tx.data.length < 10) return false;
  if (tx.to === null) return false;
  if (!ROUTERS_LOWER.has(tx.to.toLowerCase())) return false;
  if (!SWAP_SELECTORS.has(tx.data.slice(0, 10))) return false;
  return true;
}

export function parseUniswapV2Swap(tx: PendingTransaction): UniswapV2Swap | null {
  if (!isUniswapV2Swap(tx)) return null;

  try {
    const parsed = uniswapV2Interface.parseTransaction({ data: tx.data, value: tx.value });
    if (parsed === null) return null;

    const { name, args } = parsed;

    let path: string[];
    let amountIn: bigint;
    let amountOutMin: bigint;
    let deadline: bigint;

    switch (name) {
      case 'swapExactTokensForTokens':
        // args: amountIn, amountOutMin, path, to, deadline
        amountIn = args[0] as bigint;
        amountOutMin = args[1] as bigint;
        path = Array.from(args[2] as ArrayLike<string>);
        deadline = args[4] as bigint;
        break;

      case 'swapTokensForExactTokens':
        // args: amountOut, amountInMax, path, to, deadline
        amountIn = args[1] as bigint; // amountInMax — max the user will spend
        amountOutMin = args[0] as bigint; // amountOut — exact output desired
        path = Array.from(args[2] as ArrayLike<string>);
        deadline = args[4] as bigint;
        break;

      case 'swapExactETHForTokens':
        // args: amountOutMin, path, to, deadline  |  ETH in = tx.value
        amountIn = tx.value;
        amountOutMin = args[0] as bigint;
        path = Array.from(args[1] as ArrayLike<string>);
        deadline = args[3] as bigint;
        break;

      case 'swapExactTokensForETH':
        // args: amountIn, amountOutMin, path, to, deadline
        amountIn = args[0] as bigint;
        amountOutMin = args[1] as bigint;
        path = Array.from(args[2] as ArrayLike<string>);
        deadline = args[4] as bigint;
        break;

      default:
        return null;
    }

    if (path.length < 2) return null;

    const tokenIn = path[0];
    const tokenOut = path[path.length - 1];
    if (tokenIn === undefined || tokenOut === undefined) return null;

    logger.debug({ tokenIn, tokenOut, amountIn: amountIn.toString() }, 'Decoded Uniswap V2 swap');

    return {
      txHash: tx.hash,
      tokenIn,
      tokenOut,
      amountIn,
      amountOutMin,
      deadline,
      path,
      router: tx.to as string, // non-null guaranteed by isUniswapV2Swap
      blockNumber: 0, // pending — block number assigned when mined
    };
  } catch {
    return null;
  }
}

export function getSwapAmountIn(tx: PendingTransaction): bigint | null {
  if (!isUniswapV2Swap(tx)) return null;

  try {
    const parsed = uniswapV2Interface.parseTransaction({ data: tx.data, value: tx.value });
    if (parsed === null) return null;

    switch (parsed.name) {
      case 'swapExactTokensForTokens':
      case 'swapExactTokensForETH':
        return parsed.args[0] as bigint;

      case 'swapTokensForExactTokens':
        return parsed.args[1] as bigint; // amountInMax

      case 'swapExactETHForTokens':
        return tx.value; // ETH sent as msg.value

      default:
        return null;
    }
  } catch {
    return null;
  }
}
