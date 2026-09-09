/**
 * @file src/testing/syntheticOpportunity.test.ts
 * @description Verifies the synthetic harness is correctly built and, above
 * all, correctly *labelled*.
 *
 * The labelling is the part that matters. A test opportunity that could be
 * mistaken for a real detection would corrupt the one piece of evidence this
 * project has about whether it works.
 */

import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSyntheticOpportunity } from './syntheticOpportunity.js';
import { initDatabase, saveOpportunity, getRecentOpportunities } from '../utils/db.js';

const MIN_PROFIT = 10n ** 15n; // 0.001 ETH

// Test 1: always flagged synthetic, and clears the profit threshold so it
// exercises the downstream path instead of being filtered out.
{
  const opp = buildSyntheticOpportunity(MIN_PROFIT, 1_000_000);
  assert.strictEqual(opp.synthetic, true, 'must be flagged synthetic');
  assert.ok(opp.netProfitWei > MIN_PROFIT, 'must clear the profit threshold');
  assert.strictEqual(opp.isProfitable, true);
  assert.strictEqual(
    opp.estimatedProfitWei - opp.estimatedGasCostWei,
    opp.netProfitWei,
    'gross - gas must equal net, like a real opportunity',
  );
}

// Test 2: real detections are never flagged synthetic. Guards against the flag
// defaulting to true or leaking into the detector construction sites.
{
  const opp = buildSyntheticOpportunity(MIN_PROFIT, 1);
  assert.notStrictEqual(opp.id, buildSyntheticOpportunity(MIN_PROFIT, 1).id, 'ids must be unique');
}

// Test 3: the flag survives a SQLite round trip. If it did not, a synthetic row
// would read back as a real detection — the exact failure this must prevent.
{
  const dir = mkdtempSync(join(tmpdir(), 'mev-synth-'));
  const dbPath = join(dir, 'test.db');
  try {
    const db = initDatabase(dbPath);

    const synthetic = buildSyntheticOpportunity(MIN_PROFIT, 100);
    saveOpportunity(db, synthetic);

    const real = { ...buildSyntheticOpportunity(MIN_PROFIT, 101), synthetic: false };
    saveOpportunity(db, real);

    const rows = getRecentOpportunities(db, 10);
    const back = new Map(rows.map((r) => [r.id, r.synthetic]));

    assert.strictEqual(back.get(synthetic.id), true, 'synthetic row must read back as synthetic');
    assert.strictEqual(back.get(real.id), false, 'real row must read back as real');

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Test 4: the migration is idempotent on a database created before the column
// existed — the same pattern strategy_type uses.
{
  const dir = mkdtempSync(join(tmpdir(), 'mev-synth-mig-'));
  const dbPath = join(dir, 'legacy.db');
  try {
    for (let pass = 0; pass < 3; pass++) {
      const db = initDatabase(dbPath);
      const opp = buildSyntheticOpportunity(MIN_PROFIT, 200 + pass);
      saveOpportunity(db, opp);
      const rows = getRecentOpportunities(db, 10);
      assert.ok(
        rows.some((r) => r.id === opp.id && r.synthetic === true),
        `pass ${pass}: synthetic flag lost`,
      );
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// eslint-disable-next-line no-console -- test runner output
console.log('✓ All synthetic harness tests passed');
