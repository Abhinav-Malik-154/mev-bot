/**
 * @file src/detector/wasmMath.ts
 * @description TypeScript bindings for the Rust WASM AMM math module.
 *
 * Loads the compiled WASM module and exposes a typed interface
 * identical in behavior to src/detector/math.ts, but backed by
 * Rust execution with zero GC overhead.
 *
 * IMPORTANT LIMITATION: WASM exports use u64/i64, which JavaScript
 * represents as BigInt automatically via wasm-bindgen, but the
 * practical safe range here is values fitting in u64 (~18.4 * 10^18).
 * This covers all realistic ETH/token reserve values in wei, but
 * is NOT a drop-in replacement for arbitrary-precision bigint math
 * on values that could exceed u64 — callers should prefer the
 * pure-TS implementation in math.ts unless profiling shows this
 * path is a bottleneck.
 */

import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('wasmMath');

/** Largest value representable by the WASM module's u64 parameters. */
const U64_MAX = 2n ** 64n - 1n;

/**
 * Shape of the wasm-bindgen (nodejs target) exports. We declare it locally
 * rather than importing the generated `.d.ts` so the WASM build artifact
 * stays out of the TypeScript program graph (it lives outside `rootDir`).
 * 64-bit integer params/returns are marshalled as `bigint` by wasm-bindgen.
 */
interface WasmMathExports {
  get_amount_out(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint;
  calculate_price_impact_bps(amountIn: bigint, reserveIn: bigint): bigint;
  calculate_arbitrage_profit(
    amountIn: bigint,
    reserveInA: bigint,
    reserveOutA: bigint,
    reserveInB: bigint,
    reserveOutB: bigint,
  ): bigint;
}

let wasmModule: WasmMathExports | undefined;

/**
 * Lazily loads the WASM module on first use.
 * Returns true on success; logs a warning and returns false (graceful
 * fallback) if the artifact is missing or fails to load — callers should
 * branch to the pure-TS math.ts implementation in that case.
 *
 * Idempotent: repeated calls after a successful load are no-ops.
 */
export async function loadWasmMath(): Promise<boolean> {
  if (wasmModule !== undefined) return true;
  try {
    // Resolve the artifact relative to this module so it works regardless of
    // CWD. A runtime-computed specifier also keeps tsc from pulling the
    // generated bindings into the build (they live outside src/rootDir).
    const moduleUrl = new URL('../../rust/amm-math/pkg/amm_math.js', import.meta.url).href;
    const loaded = (await import(moduleUrl)) as unknown as WasmMathExports;
    if (typeof loaded.get_amount_out !== 'function') {
      throw new Error('WASM module missing expected get_amount_out export');
    }
    wasmModule = loaded;
    logger.info('Rust WASM AMM math module loaded');
    return true;
  } catch (err: unknown) {
    logger.warn(
      { err },
      'WASM AMM math unavailable — falling back to pure-TS math.ts. ' +
        'Run `wasm-pack build --target nodejs` in rust/amm-math to enable it.',
    );
    return false;
  }
}

/**
 * Asserts every argument fits in the WASM u64 ceiling.
 *
 * The Rust exports take u64 parameters (max ~1.8 * 10^19). Silently
 * truncating a larger bigint would corrupt a financial calculation, so we
 * fail loudly instead. All realistic wei-denominated reserves/amounts fit;
 * if you genuinely need more headroom, use the pure-TS math.ts path.
 */
function assertU64(...values: bigint[]): void {
  for (const value of values) {
    if (value < 0n || value > U64_MAX) {
      throw new RangeError(
        `wasmMath: value ${value} is outside the u64 range [0, ${U64_MAX}] — ` +
          'use the pure-TS math.ts implementation for values this large',
      );
    }
  }
}

/** True once loadWasmMath() has successfully loaded the module. */
export function isWasmMathLoaded(): boolean {
  return wasmModule !== undefined;
}

function requireModule(): WasmMathExports {
  if (wasmModule === undefined) {
    throw new Error('wasmMath: module not loaded — call loadWasmMath() first');
  }
  return wasmModule;
}

/**
 * WASM-accelerated getAmountOut — identical behavior to the math.ts version.
 *
 * u64 ceiling: amountIn, reserveIn, and reserveOut must each be <= 2^64 - 1.
 * Throws if the module is not loaded (call loadWasmMath() first) or any
 * argument exceeds u64.
 */
export function getAmountOutWasm(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
): bigint {
  const mod = requireModule();
  assertU64(amountIn, reserveIn, reserveOut);
  return mod.get_amount_out(amountIn, reserveIn, reserveOut);
}

/**
 * WASM-accelerated price-impact (basis points). Same u64 ceiling as above.
 */
export function calculatePriceImpactBpsWasm(amountIn: bigint, reserveIn: bigint): bigint {
  const mod = requireModule();
  assertU64(amountIn, reserveIn);
  return mod.calculate_price_impact_bps(amountIn, reserveIn);
}

/**
 * WASM-accelerated two-leg arbitrage profit. Returns signed profit (negative
 * when the round trip loses money). Same u64 ceiling on every input.
 */
export function calculateArbitrageProfitWasm(
  amountIn: bigint,
  reserveInA: bigint,
  reserveOutA: bigint,
  reserveInB: bigint,
  reserveOutB: bigint,
): bigint {
  const mod = requireModule();
  assertU64(amountIn, reserveInA, reserveOutA, reserveInB, reserveOutB);
  return mod.calculate_arbitrage_profit(amountIn, reserveInA, reserveOutA, reserveInB, reserveOutB);
}
