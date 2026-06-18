/**
 * @file src/executor/index.ts
 * @description Public API for the executor module.
 *
 * Consumers should import from this file, not from the individual
 * sub-modules, so internal refactors do not break callers.
 */

export {
  buildArbitrageBundle,
  encodeSwapExactTokensForTokens,
  calculateDeadline,
} from './bundleBuilder.js';
export { simulateBundle } from './simulator.js';
export type { BuiltBundle, BundleTransaction } from './bundleBuilder.js';
