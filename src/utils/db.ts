/**
 * @file src/utils/db.ts
 * @description SQLite database module using better-sqlite3.
 *
 * better-sqlite3 is synchronous and zero-latency — perfect for a bot
 * where async DB calls would complicate the hot path.
 * bigint values are stored as TEXT strings in SQLite since SQLite
 * integers are 64-bit signed and cannot hold all uint256 values.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ArbitrageOpportunity, ArbitrageStrategy, BundleResult } from '../types/index.js';

interface OpportunityRow {
  id: string;
  strategy_type: string;
  timestamp: number;
  swap_tx: string;
  token_a: string;
  token_b: string;
  pool_a: string;
  pool_b: string;
  estimated_profit_wei: string;
  estimated_gas_cost_wei: string;
  net_profit_wei: string;
  is_profitable: number;
  confidence: number;
}

interface BundleRow {
  id: string;
  success: number;
  bundle_hash: string | null;
  block_number: number;
  profit_wei: string;
  gas_used: string;
  error: string | null;
}

interface SerializableSwapTx {
  txHash: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOutMin: string;
  deadline: string;
  path: string[];
  router: string;
  blockNumber: number;
}

export function initDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS opportunities (
      id                    TEXT    PRIMARY KEY,
      strategy_type         TEXT    NOT NULL DEFAULT 'v2-v2',
      timestamp             INTEGER NOT NULL,
      swap_tx               TEXT    NOT NULL,
      token_a               TEXT    NOT NULL,
      token_b               TEXT    NOT NULL,
      pool_a                TEXT    NOT NULL,
      pool_b                TEXT    NOT NULL,
      estimated_profit_wei  TEXT    NOT NULL,
      estimated_gas_cost_wei TEXT   NOT NULL,
      net_profit_wei        TEXT    NOT NULL,
      is_profitable         INTEGER NOT NULL,
      confidence            REAL    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bundles (
      id           TEXT    PRIMARY KEY,
      success      INTEGER NOT NULL,
      bundle_hash  TEXT,
      block_number INTEGER NOT NULL,
      profit_wei   TEXT    NOT NULL,
      gas_used     TEXT    NOT NULL,
      error        TEXT
    );

    CREATE TABLE IF NOT EXISTS metrics_snapshots (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at         INTEGER NOT NULL,
      uptime_seconds      INTEGER NOT NULL,
      tx_scanned          INTEGER NOT NULL,
      opportunities_found INTEGER NOT NULL,
      bundles_submitted   INTEGER NOT NULL,
      total_profit_wei    TEXT    NOT NULL
    );
  `);

  // Migration: back-fill strategy_type on databases created before it existed.
  // CREATE TABLE IF NOT EXISTS never alters a pre-existing table, so add the
  // column here; the ADD throws "duplicate column" once present — safely ignored.
  try {
    db.exec(`ALTER TABLE opportunities ADD COLUMN strategy_type TEXT NOT NULL DEFAULT 'v2-v2'`);
  } catch {
    // Column already exists — nothing to do.
  }

  return db;
}

export function saveOpportunity(db: Database.Database, opp: ArbitrageOpportunity): void {
  const swapTxForStorage: SerializableSwapTx = {
    txHash: opp.swapTx.txHash,
    tokenIn: opp.swapTx.tokenIn,
    tokenOut: opp.swapTx.tokenOut,
    amountIn: opp.swapTx.amountIn.toString(),
    amountOutMin: opp.swapTx.amountOutMin.toString(),
    deadline: opp.swapTx.deadline.toString(),
    path: opp.swapTx.path,
    router: opp.swapTx.router,
    blockNumber: opp.swapTx.blockNumber,
  };

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO opportunities
      (id, strategy_type, timestamp, swap_tx, token_a, token_b, pool_a, pool_b,
       estimated_profit_wei, estimated_gas_cost_wei, net_profit_wei,
       is_profitable, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    opp.id,
    opp.strategyType,
    opp.timestamp,
    JSON.stringify(swapTxForStorage),
    opp.tokenA,
    opp.tokenB,
    opp.poolA,
    opp.poolB,
    opp.estimatedProfitWei.toString(),
    opp.estimatedGasCostWei.toString(),
    opp.netProfitWei.toString(),
    opp.isProfitable ? 1 : 0,
    opp.confidence,
  );
}

export function saveBundle(db: Database.Database, result: BundleResult & { id: string }): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO bundles
      (id, success, bundle_hash, block_number, profit_wei, gas_used, error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    result.id,
    result.success ? 1 : 0,
    result.bundleHash,
    result.blockNumber,
    result.profitWei.toString(),
    result.gasUsed.toString(),
    result.error ?? null,
  );
}

export function getRecentBundles(
  db: Database.Database,
  limit: number,
): Array<BundleResult & { id: string }> {
  const stmt = db.prepare(`
    SELECT * FROM bundles
    ORDER BY rowid DESC
    LIMIT ?
  `);

  const rows = stmt.all(limit) as BundleRow[];

  return rows.map((row): BundleResult & { id: string } => ({
    id: row.id,
    success: row.success === 1,
    bundleHash: row.bundle_hash,
    blockNumber: row.block_number,
    profitWei: BigInt(row.profit_wei),
    gasUsed: BigInt(row.gas_used),
    error: row.error ?? undefined,
  }));
}

export function getRecentOpportunities(
  db: Database.Database,
  limit: number,
): ArbitrageOpportunity[] {
  const stmt = db.prepare(`
    SELECT * FROM opportunities
    ORDER BY timestamp DESC
    LIMIT ?
  `);

  const rows = stmt.all(limit) as OpportunityRow[];

  return rows.map((row): ArbitrageOpportunity => {
    const rawSwapTx = JSON.parse(row.swap_tx) as SerializableSwapTx;

    return {
      id: row.id,
      strategyType: (row.strategy_type as ArbitrageStrategy | undefined) ?? 'v2-v2',
      timestamp: row.timestamp,
      swapTx: {
        txHash: rawSwapTx.txHash,
        tokenIn: rawSwapTx.tokenIn,
        tokenOut: rawSwapTx.tokenOut,
        amountIn: BigInt(rawSwapTx.amountIn),
        amountOutMin: BigInt(rawSwapTx.amountOutMin),
        deadline: BigInt(rawSwapTx.deadline),
        path: rawSwapTx.path,
        router: rawSwapTx.router,
        blockNumber: rawSwapTx.blockNumber,
      },
      tokenA: row.token_a,
      tokenB: row.token_b,
      poolA: row.pool_a,
      poolB: row.pool_b,
      estimatedProfitWei: BigInt(row.estimated_profit_wei),
      estimatedGasCostWei: BigInt(row.estimated_gas_cost_wei),
      netProfitWei: BigInt(row.net_profit_wei),
      isProfitable: row.is_profitable === 1,
      confidence: row.confidence,
    };
  });
}
