/**
 * @file src/loadEnv.ts
 * @description Side-effect module that loads environment variables from the
 * chosen .env file at the earliest possible moment.
 *
 * Import this module (for its side effect) before anything that reads
 * process.env at module-evaluation time — notably the logger, which reads
 * LOG_LEVEL when it is first imported.
 *
 * File selection order (first match wins):
 *   1. `--env-file <path>` CLI flag
 *   2. ENV_FILE_PATH environment variable
 *   3. '.env' (default — preserves all pre-existing behaviour exactly)
 */

import dotenv from 'dotenv';

function resolveEnvFilePath(): string {
  const flagIndex = process.argv.indexOf('--env-file');
  const flagValue = flagIndex !== -1 ? process.argv[flagIndex + 1] : undefined;
  if (flagValue !== undefined && flagValue !== '') {
    return flagValue;
  }
  return process.env['ENV_FILE_PATH'] ?? '.env';
}

dotenv.config({ path: resolveEnvFilePath() });
