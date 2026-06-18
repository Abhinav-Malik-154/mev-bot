/**
 * @file src/flashbots/index.ts
 * @description Public API for the flashbots module.
 *
 * Consumers import from this file, not from the individual sub-modules,
 * so internal refactors do not break callers.
 */

export {
  createFlashbotsProvider,
  submitBundle,
  callBundle,
} from './relay.js';
export type { FlashbotsRelayClient } from './relay.js';
export { BundleTracker, bundleTracker } from './tracker.js';
export type { BundleStats } from './tracker.js';
