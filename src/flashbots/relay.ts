/**
 * @file src/flashbots/relay.ts
 * @description Flashbots MEV-Share relay client.
 *
 * Submits signed transaction bundles to the Flashbots relay over JSON-RPC.
 * Implements the Flashbots signing spec directly rather than using the
 * @flashbots/ethers-provider-bundle package, which was written for ethers v5
 * and cannot be imported in this ethers v6 project (missing @ethersproject/*
 * peer dependencies that ethers v6 does not provide).
 *
 * Flashbots relay authentication (same spec as the official library):
 *   1. Serialize the full JSON-RPC request body as a UTF-8 string
 *   2. keccak256-hash that string
 *   3. eth_sign the 32-byte hash with a reputation key (NOT the executor key)
 *   4. Send as `X-Flashbots-Signature: <address>:<signature>` header
 *
 * Using a separate "reputation signer" (Wallet.createRandom each session) lets
 * Flashbots track our bundle success rate independently of the execution wallet.
 * A higher reputation = higher bundle priority in competitive blocks.
 *
 * Retry strategy:
 * If a bundle is not included in targetBlock we resubmit for +1, +2
 * (max MAX_BLOCKS_TO_TRY attempts). After that the opportunity is stale.
 *
 * Why native fetch instead of axios?
 * Node.js 18+ ships fetch natively. Using it avoids an extra dependency and
 * removes one async layer that could mask errors in the relay response path.
 */

import { Wallet, BaseWallet, JsonRpcProvider, Transaction, keccak256, toUtf8Bytes, getBytes } from 'ethers';
import { createModuleLogger } from '../utils/logger.js';
import { config } from '../config.js';
import { metrics } from '../utils/metrics.js';
import type { BundleResult } from '../types/index.js';
import type { BuiltBundle, BundleTransaction } from '../executor/bundleBuilder.js';

const logger = createModuleLogger('relay');

const MAX_BLOCKS_TO_TRY = 3;
// How long to wait for a target block to be produced before giving up on that attempt
const BLOCK_WAIT_TIMEOUT_MS = 15_000;
// Polling interval when waiting for a new block
const BLOCK_POLL_INTERVAL_MS = 500;

/**
 * Represents the Flashbots relay connection — holds the auth signer used
 * to sign every request to the relay for reputation tracking.
 */
export interface FlashbotsRelayClient {
  readonly relayUrl: string;
  // BaseWallet is the common supertype of both Wallet and HDNodeWallet (Wallet.createRandom returns HDNodeWallet in ethers v6)
  readonly authSigner: BaseWallet;
}

// ─── internal JSON-RPC shapes ──────────────────────────────────────────────

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params: readonly unknown[];
  readonly id: number;
}

interface JsonRpcSuccess<T> {
  readonly result: T;
}

interface JsonRpcError {
  readonly error: { readonly message: string; readonly code: number };
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcError;

interface SendBundleResult {
  readonly bundleHash: string;
}

interface CallBundleTxResult {
  readonly txHash: string;
  readonly gasUsed: number;
  readonly error?: string;
  readonly revert?: string;
}

interface CallBundleResult {
  readonly bundleHash: string;
  readonly results: CallBundleTxResult[];
  readonly totalGasUsed: number;
}

// ─── signing ───────────────────────────────────────────────────────────────

/**
 * Produces the `X-Flashbots-Signature` header value for a relay request body.
 *
 * Spec (same as @flashbots/ethers-provider-bundle):
 *   keccak256(utf8(body)) → sign the 32 raw bytes → "<address>:<sig>"
 */
async function buildFlashbotsSignatureHeader(
  body: string,
  signer: BaseWallet,
): Promise<string> {
  const hashBytes = getBytes(keccak256(toUtf8Bytes(body)));
  const signature = await signer.signMessage(hashBytes);
  return `${signer.address}:${signature}`;
}

/**
 * Sends one authenticated JSON-RPC call to the Flashbots relay.
 * Returns the parsed response body — callers must discriminate the union.
 */
async function callRelay<T>(
  method: string,
  params: readonly unknown[],
  authSigner: BaseWallet,
  relayUrl: string,
): Promise<JsonRpcResponse<T>> {
  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    method,
    params,
    id: 1,
  };
  const body = JSON.stringify(request);
  const signature = await buildFlashbotsSignatureHeader(body, authSigner);

  const response = await fetch(relayUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Flashbots-Signature': signature,
    },
    body,
  });

  const json = await response.json() as JsonRpcResponse<T>;
  return json;
}

// ─── transaction signing ───────────────────────────────────────────────────

/**
 * Signs every transaction in the bundle with the executor wallet.
 * Returns an array of raw signed transaction hex strings and their hashes,
 * in the same order as bundle.transactions.
 */
async function signBundleTransactions(
  bundle: BuiltBundle,
  wallet: Wallet,
): Promise<{ signedTxs: string[]; txHashes: string[] }> {
  const signedTxs: string[] = [];
  const txHashes: string[] = [];

  for (const tx of bundle.transactions) {
    const txRequest = buildEip1559Request(tx);
    const signed = await wallet.signTransaction(txRequest);
    signedTxs.push(signed);

    // Transaction.from() parses the raw signed tx and exposes the computed hash
    const parsed = Transaction.from(signed);
    const hash = parsed.hash;
    if (hash === null) {
      throw new Error('Signed transaction produced a null hash — wallet or tx malformed');
    }
    txHashes.push(hash);
  }

  return { signedTxs, txHashes };
}

/**
 * Converts our internal BundleTransaction to an ethers TransactionRequest.
 * Explicitly typed to avoid any implicit field coercions.
 */
function buildEip1559Request(tx: BundleTransaction): {
  to: string;
  data: string;
  value: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonce: number;
  chainId: number;
  type: number;
} {
  return {
    to: tx.to,
    data: tx.data,
    value: tx.value,
    gasLimit: tx.gasLimit,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    nonce: tx.nonce,
    chainId: tx.chainId,
    type: 2, // EIP-1559
  };
}

// ─── block polling ─────────────────────────────────────────────────────────

/**
 * Polls the provider until the chain head reaches targetBlockNumber,
 * or until the timeout elapses.
 * Returns true if the block was produced, false on timeout.
 */
async function waitForBlock(
  provider: JsonRpcProvider,
  targetBlockNumber: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await provider.getBlockNumber();
    if (current >= targetBlockNumber) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, BLOCK_POLL_INTERVAL_MS));
  }
  return false;
}

// ─── public API ────────────────────────────────────────────────────────────

/**
 * Creates a Flashbots relay client with a fresh random reputation signer.
 *
 * The auth signer is NOT the executor wallet — it is a throwaway key used
 * solely to identify this session to the relay for reputation tracking.
 * A long-running bot would persist this key across restarts to build reputation.
 */
export async function createFlashbotsProvider(
  _provider: JsonRpcProvider,
): Promise<FlashbotsRelayClient> {
  const authSigner = Wallet.createRandom();
  logger.info(
    { relayUrl: config.flashbotsRelayUrl, authAddress: authSigner.address },
    'Flashbots relay client created',
  );
  return { relayUrl: config.flashbotsRelayUrl, authSigner };
}

/**
 * Submits a bundle to the Flashbots relay and waits for inclusion.
 *
 * Retries across MAX_BLOCKS_TO_TRY consecutive blocks.
 * Inclusion is confirmed by checking whether the first transaction's hash
 * appears in a block receipt — the most reliable on-chain proof.
 *
 * Returns a BundleResult describing success or the reason for failure.
 */
export async function submitBundle(
  bundle: BuiltBundle,
  relayClient: FlashbotsRelayClient,
  wallet: Wallet,
  provider: JsonRpcProvider,
): Promise<BundleResult> {
  let signedTxs: string[];
  let txHashes: string[];

  try {
    ({ signedTxs, txHashes } = await signBundleTransactions(bundle, wallet));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to sign bundle transactions';
    logger.error({ err }, 'Bundle signing failed');
    return {
      success: false,
      bundleHash: null,
      blockNumber: bundle.targetBlockNumber,
      profitWei: 0n,
      gasUsed: 0n,
      error: message,
    };
  }

  const firstTxHash = txHashes[0];
  if (firstTxHash === undefined) {
    return {
      success: false,
      bundleHash: null,
      blockNumber: bundle.targetBlockNumber,
      profitWei: 0n,
      gasUsed: 0n,
      error: 'Bundle has no transactions',
    };
  }

  let lastBundleHash: string | null = null;
  let lastBlockTried = bundle.targetBlockNumber;

  for (let attempt = 0; attempt < MAX_BLOCKS_TO_TRY; attempt++) {
    const targetBlock = bundle.targetBlockNumber + attempt;
    lastBlockTried = targetBlock;

    // eth_sendBundle params per Flashbots JSON-RPC spec
    const sendParams = {
      txs: signedTxs,
      blockNumber: '0x' + targetBlock.toString(16),
    };

    const sendResponse = await callRelay<SendBundleResult>(
      'eth_sendBundle',
      [sendParams],
      relayClient.authSigner,
      relayClient.relayUrl,
    );

    if ('error' in sendResponse) {
      logger.warn(
        { attempt, targetBlock, error: sendResponse.error.message },
        'Relay rejected bundle — skipping this block',
      );
      continue;
    }

    const bundleHash = sendResponse.result.bundleHash;
    lastBundleHash = bundleHash;

    logger.info(
      { bundleHash, targetBlock, attempt },
      'Bundle submitted to Flashbots relay',
    );

    // Wait for the target block to be produced
    const blockArrived = await waitForBlock(provider, targetBlock, BLOCK_WAIT_TIMEOUT_MS);
    if (!blockArrived) {
      logger.debug({ targetBlock }, 'Timed out waiting for block — retrying next block');
      continue;
    }

    // Check on-chain: was our first tx included in this block?
    const receipt = await provider.getTransactionReceipt(firstTxHash);
    if (receipt !== null) {
      metrics.incrementBundleSubmitted();
      logger.info(
        { bundleHash, blockNumber: receipt.blockNumber, txHash: firstTxHash },
        'Bundle included in block ✓',
      );
      return {
        success: true,
        bundleHash,
        blockNumber: receipt.blockNumber,
        profitWei: bundle.expectedProfitWei,
        gasUsed: bundle.estimatedGasUsed,
        error: undefined,
      };
    }

    logger.debug(
      { targetBlock, attempt, bundleHash },
      'Block passed without bundle inclusion — retrying',
    );
  }

  return {
    success: false,
    bundleHash: lastBundleHash,
    blockNumber: lastBlockTried,
    profitWei: 0n,
    gasUsed: 0n,
    error: `Bundle not included after ${MAX_BLOCKS_TO_TRY} attempts`,
  };
}

/**
 * Simulates a bundle via eth_callBundle on the Flashbots relay.
 *
 * This is a relay-side dry run — cheaper than Anvil for a quick sanity check
 * that the relay can decode our transactions before we pay for Anvil simulation.
 * The relay runs the bundle against its own fork of the current chain state.
 */
export async function callBundle(
  bundle: BuiltBundle,
  relayClient: FlashbotsRelayClient,
  wallet: Wallet,
  blockNumber: number,
): Promise<{ success: boolean; error: string | undefined }> {
  let signedTxs: string[];
  try {
    ({ signedTxs } = await signBundleTransactions(bundle, wallet));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Signing failed';
    return { success: false, error: message };
  }

  const callParams = {
    txs: signedTxs,
    blockNumber: '0x' + blockNumber.toString(16),
    stateBlockNumber: 'latest',
  };

  const response = await callRelay<CallBundleResult>(
    'eth_callBundle',
    [callParams],
    relayClient.authSigner,
    relayClient.relayUrl,
  );

  if ('error' in response) {
    return { success: false, error: response.error.message };
  }

  // Check if any transaction in the simulation reverted
  const firstRevert = response.result.results.find(
    (r) => r.error !== undefined || r.revert !== undefined,
  );

  if (firstRevert !== undefined) {
    const reason = firstRevert.error ?? firstRevert.revert ?? 'Unknown revert';
    logger.debug({ txHash: firstRevert.txHash, reason }, 'Relay simulation revert');
    return { success: false, error: reason };
  }

  logger.debug(
    { bundleHash: response.result.bundleHash, totalGasUsed: response.result.totalGasUsed },
    'Relay simulation succeeded',
  );
  return { success: true, error: undefined };
}
