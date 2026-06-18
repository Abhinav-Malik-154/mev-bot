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

import 'dotenv/config';
import type { BotConfig } from './types/index.js';

function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(`Missing required env var: ${key}`);
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
}
