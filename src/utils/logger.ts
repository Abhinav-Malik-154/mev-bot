/**
 * @file src/utils/logger.ts
 * @description Production-grade structured logger using pino.
 *
 * Uses JSON format in production for log aggregation tools (Datadog, CloudWatch).
 * Uses pretty colored output in development for readability.
 * Every module gets its own child logger tagged with the module name,
 * making it easy to filter logs by component in production.
 */

import { pino } from 'pino';

const isDev: boolean = process.env['NODE_ENV'] !== 'production';
const logLevel: string = process.env['LOG_LEVEL'] ?? 'info';

/* eslint-disable @typescript-eslint/no-unsafe-argument -- pino.transport return type is `any` in library typedefs */
export const rootLogger: pino.Logger = isDev
  ? pino(
      { level: logLevel },
      pino.transport({
        target: 'pino-pretty',
        options: { colorize: true },
      }),
    )
  : pino({ level: logLevel });
/* eslint-enable @typescript-eslint/no-unsafe-argument */

export function createModuleLogger(moduleName: string): pino.Logger {
  return rootLogger.child({ module: moduleName });
}

export default rootLogger;
