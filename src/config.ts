/**
 * @file src/config.ts
 * @description Centralized environment configuration loader and validator.
 *
 * Loads all environment variables from .env at startup.
 * Throws a descriptive error immediately if any required variable is missing
 * so the bot fails fast rather than crashing mid-operation.
 *
 * SECURITY: The full private key is never logged.
 * Only the last 4 characters are shown for verification.
 */

// IMPORTANT: this side-effect import must come first. It calls dotenv.config()
// during its own module evaluation, guaranteeing the chosen .env file is loaded
// before any other module (e.g. the logger, which reads LOG_LEVEL at import
// time) is evaluated. In ES modules, top-level statements run only after all
// imports have been evaluated, so an inline dotenv.config() here would run too
// late — hence the dedicated side-effect module.
import './loadEnv.js';
import type { BotConfig } from './types/index.js';
import { createModuleLogger } from './utils/logger.js';

const logger = createModuleLogger('config');

function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

/**
 * Parses INJECT_FAULT_RATE into a probability in [0, 1].
 *
 * Rejects anything outside that range rather than silently clamping: a typo
 * like `INJECT_FAULT_RATE=10` meaning "10%" would otherwise fail every RPC
 * call and look like a broken provider rather than a misconfiguration.
 */
function parseFaultRate(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `Invalid INJECT_FAULT_RATE: "${raw}". Must be a number between 0 and 1 ` +
        '(e.g. 0.25 to fault a quarter of guarded RPC calls). Unset or 0 disables it.',
    );
  }
  return value;
}

const rawChainId = parseInt(getRequiredEnv('CHAIN_ID'), 10);
if (rawChainId !== 1 && rawChainId !== 11155111) {
  throw new Error(
    `Invalid CHAIN_ID: ${rawChainId}. Must be 1 (Ethereum mainnet) or 11155111 (Sepolia testnet)`,
  );
}

export const config: BotConfig = {
  wsUrl: getRequiredEnv('ALCHEMY_WS_URL'),
  httpUrl: getRequiredEnv('ALCHEMY_HTTP_URL'),
  flashbotsRelayUrl: getRequiredEnv('FLASHBOTS_RELAY_URL'),
  executorPrivateKey: getRequiredEnv('EXECUTOR_PRIVATE_KEY'),
  executorContractAddress: getRequiredEnv('EXECUTOR_CONTRACT_ADDRESS'),
  chainId: rawChainId,
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
  dbPath: process.env['DB_PATH'] ?? './data/mev-bot.db',
  minProfitWei: BigInt(process.env['MIN_PROFIT_WEI'] ?? '1000000000000000'),
  maxGasPriceGwei: BigInt(process.env['MAX_GAS_PRICE_GWEI'] ?? '50'),
  // Hard safety switch. When true, bundle submission is physically disabled.
  // Defaults to false so an existing .env without this key is unaffected.
  readOnlyMode: process.env['READ_ONLY_MODE'] === 'true',
  // Test-only. Fraction of guarded RPC calls that throw a synthetic 429 so the
  // rate-limit recovery paths can be exercised on demand rather than waiting
  // for a real provider to throttle us. Defaults to 0 (off).
  injectFaultRate: parseFaultRate(process.env['INJECT_FAULT_RATE']),
  // Test-only. Pushes one synthetic, clearly-labelled opportunity through the
  // pipeline at startup so the whole chain can be observed end to end.
  injectOpportunity: process.env['INJECT_OPPORTUNITY'] === 'true',
};

export function validateConfig(): void {
  /* eslint-disable no-console -- intentional: runs before pino logger is initialised */

  // Validate private key: must be 64 hex chars (with or without 0x prefix)
  const rawKey = config.executorPrivateKey.startsWith('0x')
    ? config.executorPrivateKey.slice(2)
    : config.executorPrivateKey;
  if (!/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    throw new Error(
      'EXECUTOR_PRIVATE_KEY is not a valid 32-byte hex private key. ' +
      'Set it to a real 64-character hex key in .env (never commit real keys to git).',
    );
  }

  const keyPreview = config.executorPrivateKey.slice(-4);
  console.info('✓ Chain ID: ' + config.chainId);
  console.info('✓ Relay URL: ' + config.flashbotsRelayUrl);
  console.info('✓ Min profit: ' + (config.minProfitWei / 1_000_000_000_000_000n).toString() + ' finney');
  console.info('✓ Max gas: ' + config.maxGasPriceGwei + ' gwei');
  console.info('✓ Private key: ...****' + keyPreview);
  /* eslint-enable no-console */

  if (config.readOnlyMode) {
    logger.warn('⚠️  READ-ONLY MODE ACTIVE — bundle submission is disabled');
  }

  // Loud on purpose. Injected faults look identical to real provider
  // throttling in the logs, so leaving this on unnoticed would make healthy
  // runs look broken and skew the 429 counters on the dashboard.
  if (config.injectOpportunity) {
    logger.warn(
      '🧪 SYNTHETIC OPPORTUNITY INJECTION ENABLED — one fabricated opportunity ' +
        'will be pushed through the pipeline and stored flagged as synthetic. ' +
        'Unset INJECT_OPPORTUNITY for normal operation.',
    );
  }

  if (config.injectFaultRate > 0) {
    logger.warn(
      { injectFaultRate: config.injectFaultRate },
      `🧪 FAULT INJECTION ACTIVE — ${Math.round(config.injectFaultRate * 100)}% of guarded ` +
        'RPC calls will throw a synthetic 429. Unset INJECT_FAULT_RATE for normal operation.',
    );
  }
}
