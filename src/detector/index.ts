/**
 * @file src/detector/index.ts
 * @description Public API for the detector module.
 */

export { detectArbitrageOpportunity, getCurrentGasPrice } from './arbitrage.js';
export {
  getAmountOut,
  getAmountIn,
  calculatePriceImpactBps,
  findOptimalAmountIn,
  formatEthAmount,
} from './math.js';
export { computePairAddress, getPoolReserves, sortTokens } from './pools.js';
