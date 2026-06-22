/**
 * @file src/detector/index.ts
 * @description Public API for the detector module.
 */

export {
  detectArbitrageOpportunity,
  detectV2V3CrossArbitrage,
  getCurrentGasPrice,
} from './arbitrage.js';
export {
  getAmountOut,
  getAmountIn,
  calculatePriceImpactBps,
  findOptimalAmountIn,
  formatEthAmount,
} from './math.js';
export { computePairAddress, getPoolReserves, sortTokens } from './pools.js';
export {
  getV3PoolState,
  sqrtPriceX96ToPrice,
  estimateV3AmountOut,
  computeV3PoolAddress,
  UNISWAP_V3_FACTORY,
  V3_FEE_TIERS,
  type V3PoolState,
} from './uniswapV3.js';
export {
  generateTriangularPaths,
  simulateTriangularPath,
  findBestTriangularArbitrage,
  HUB_TOKENS,
  type TriangularPath,
  type TriangularOpportunity,
} from './multiHop.js';
export {
  loadWasmMath,
  getAmountOutWasm,
  calculatePriceImpactBpsWasm,
  calculateArbitrageProfitWasm,
} from './wasmMath.js';
