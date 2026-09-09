/**
 * @file src/detector/multiHop.test.ts
 * @description Unit tests for triangular arbitrage path generation.
 *
 * Path generation is pure (no network), so we verify its combinatorics and
 * structural invariants directly: the correct path count, that the start
 * token never appears as an intermediate hop, and that every generated path
 * forms a valid closed cycle whose pool addresses match its token legs.
 */

import assert from 'node:assert';
import { getAddress } from 'ethers';
import {
  generateTriangularPaths,
  simulateTriangularPathFromReserves,
  HUB_TOKENS,
} from './multiHop.js';
import { getAmountOut } from './math.js';
import type { PoolReserves } from '../types/index.js';
import {
  computePairAddress,
  sortTokens,
  UNISWAP_V2_FACTORY,
  UNISWAP_V2_INIT_CODE_HASH,
} from './pools.js';

const WETH = '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9';

// Test 1: correct number of paths for the 3 hub tokens.
// Starting from WETH (a hub), 2 hub tokens remain -> 2 * 1 = 2 ordered paths.
{
  const paths = generateTriangularPaths(WETH, HUB_TOKENS);
  assert.strictEqual(paths.length, 2, `Test 1 failed: expected 2 paths, got ${paths.length}`);
}

// Test 1b: a start token outside the hub set keeps all 3 hubs as candidates,
// yielding 3 * 2 = 6 ordered paths — confirms the k*(k-1) formula generally.
{
  const outsider = '0x000000000000000000000000000000000000dEaD';
  const paths = generateTriangularPaths(outsider, HUB_TOKENS);
  assert.strictEqual(paths.length, 6, `Test 1b failed: expected 6 paths, got ${paths.length}`);
}

// Test 2: no generated path revisits the start token mid-path, and the two
// intermediate hops are always distinct from each other.
{
  const paths = generateTriangularPaths(WETH, HUB_TOKENS);
  for (const path of paths) {
    const [start, b, c] = path.tokens;
    assert.notStrictEqual(b.toLowerCase(), start.toLowerCase(), 'Test 2 failed: hop B equals start');
    assert.notStrictEqual(c.toLowerCase(), start.toLowerCase(), 'Test 2 failed: hop C equals start');
    assert.notStrictEqual(b.toLowerCase(), c.toLowerCase(), 'Test 2 failed: hops B and C are identical');
  }
}

// Test 3: every path is a valid cycle — three legs whose pools match the
// token pairs (t0->t1), (t1->t2), (t2->t0), closing the loop back to t0.
{
  const paths = generateTriangularPaths(WETH, HUB_TOKENS);
  for (const path of paths) {
    const [t0, t1, t2] = path.tokens;
    const [p0, p1, p2] = path.pools;

    const expected0 = computePairAddress(t0, t1, UNISWAP_V2_FACTORY, UNISWAP_V2_INIT_CODE_HASH);
    const expected1 = computePairAddress(t1, t2, UNISWAP_V2_FACTORY, UNISWAP_V2_INIT_CODE_HASH);
    const expected2 = computePairAddress(t2, t0, UNISWAP_V2_FACTORY, UNISWAP_V2_INIT_CODE_HASH);

    assert.strictEqual(getAddress(p0), expected0, 'Test 3 failed: leg 0 pool mismatch');
    assert.strictEqual(getAddress(p1), expected1, 'Test 3 failed: leg 1 pool mismatch');
    assert.strictEqual(getAddress(p2), expected2, 'Test 3 failed: leg 2 pool mismatch (loop not closed)');
  }
}

// Test 4: the two WETH loops name the same three pools, because
// computePairAddress sorts its pair — so a batched, de-duplicated fetch costs
// 3 pool reads rather than the 6 that per-path fetching would issue.
{
  const paths = generateTriangularPaths(WETH, HUB_TOKENS);
  const allPools = paths.flatMap((path) => path.pools);
  const unique = new Set(allPools.map((pool) => pool.toLowerCase()));
  assert.strictEqual(allPools.length, 6, 'Test 4 failed: expected 6 pool slots across 2 paths');
  assert.strictEqual(unique.size, 3, `Test 4 failed: expected 3 unique pools, got ${unique.size}`);
}

// Test 5: pure evaluation against a snapshot — no network. A loop through
// three balanced pools must lose exactly the compounded 0.3% fee, and a
// snapshot missing any leg must collapse to 0n rather than guess.
{
  const paths = generateTriangularPaths(WETH, HUB_TOKENS);
  const path = paths[0];
  assert.ok(path !== undefined, 'Test 5 setup: expected at least one path');

  const reserve = 1000n * 10n ** 18n;
  const snapshot = new Map<string, PoolReserves>();
  for (const [index, pool] of path.pools.entries()) {
    const [token0, token1] = sortTokens(
      path.tokens[index] as string,
      path.tokens[(index + 1) % 3] as string,
    );
    snapshot.set(pool.toLowerCase(), {
      reserve0: reserve,
      reserve1: reserve,
      token0,
      token1,
      fee: 30,
    });
  }

  const amountIn = 10n ** 18n;
  const out = simulateTriangularPathFromReserves(path, amountIn, snapshot);

  // Three balanced hops, each charging 0.3%: strictly lossy, but close to 1.
  assert.ok(out > 0n, 'Test 5 failed: expected a non-zero result');
  assert.ok(out < amountIn, `Test 5 failed: balanced loop must lose to fees, got ${out}`);
  assert.ok(out > (amountIn * 98n) / 100n, `Test 5 failed: loss too large, got ${out}`);

  // Chained by hand: three getAmountOut hops through identical reserves.
  let expected = amountIn;
  for (let i = 0; i < 3; i++) expected = getAmountOut(expected, reserve, reserve);
  assert.strictEqual(out, expected, 'Test 5 failed: does not match hand-chained getAmountOut');

  // Drop one leg -> the loop cannot be priced.
  const incomplete = new Map(snapshot);
  incomplete.delete(path.pools[1].toLowerCase());
  assert.strictEqual(
    simulateTriangularPathFromReserves(path, amountIn, incomplete),
    0n,
    'Test 5 failed: missing pool must yield 0n',
  );
}

console.log('✓ All multi-hop tests passed');
