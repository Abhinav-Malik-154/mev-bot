/* @ts-self-types="./amm_math.d.ts" */

/**
 * Net profit of a two-leg arbitrage: swap `amount_in` through pool A
 * (in → out), then route the proceeds through pool B (in → out), and
 * compare the final amount against the original `amount_in`.
 *
 * Returns a **signed** `i64`: positive when the round trip is profitable,
 * negative when fees/slippage make it a loss. Callers use the sign to
 * decide whether an opportunity is worth pursuing.
 * @param {bigint} amount_in
 * @param {bigint} reserve_in_a
 * @param {bigint} reserve_out_a
 * @param {bigint} reserve_in_b
 * @param {bigint} reserve_out_b
 * @returns {bigint}
 */
function calculate_arbitrage_profit(amount_in, reserve_in_a, reserve_out_a, reserve_in_b, reserve_out_b) {
    const ret = wasm.calculate_arbitrage_profit(amount_in, reserve_in_a, reserve_out_a, reserve_in_b, reserve_out_b);
    return ret;
}
exports.calculate_arbitrage_profit = calculate_arbitrage_profit;

/**
 * Price impact of a swap, expressed in basis points (1 bp = 0.01%).
 *
 * `(amount_in * 10_000) / reserve_in`. Returns 0 when `reserve_in` is 0.
 * @param {bigint} amount_in
 * @param {bigint} reserve_in
 * @returns {bigint}
 */
function calculate_price_impact_bps(amount_in, reserve_in) {
    const ret = wasm.calculate_price_impact_bps(amount_in, reserve_in);
    return BigInt.asUintN(64, ret);
}
exports.calculate_price_impact_bps = calculate_price_impact_bps;

/**
 * Uniswap V2 `getAmountOut`: constant-product swap with the 0.3% LP fee.
 *
 * Returns 0 if `reserve_in` or `reserve_out` is 0 (degenerate / empty pool),
 * matching the guard in the TypeScript implementation.
 *
 * The result is cast back to `u64`. This is safe for realistic pool sizes:
 * the output is always strictly less than `reserve_out` (you can never
 * receive more than the pool holds), and `reserve_out` itself entered as a
 * `u64`, so the result fits in `u64` by construction.
 * @param {bigint} amount_in
 * @param {bigint} reserve_in
 * @param {bigint} reserve_out
 * @returns {bigint}
 */
function get_amount_out(amount_in, reserve_in, reserve_out) {
    const ret = wasm.get_amount_out(amount_in, reserve_in, reserve_out);
    return BigInt.asUintN(64, ret);
}
exports.get_amount_out = get_amount_out;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./amm_math_bg.js": import0,
    };
}

const wasmPath = `${__dirname}/amm_math_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());
let wasm = wasmInstance.exports;
wasm.__wbindgen_start();
