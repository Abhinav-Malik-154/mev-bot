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
import { generateTriangularPaths, HUB_TOKENS } from './multiHop.js';
import {
  computePairAddress,
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

console.log('✓ All multi-hop tests passed');
