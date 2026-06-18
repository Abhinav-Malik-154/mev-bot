/**
 * @file src/executor/simulator.ts
 * @description Anvil fork-based transaction simulator.
 *
 * Anvil (part of Foundry) can fork any EVM network at any block.
 * We spawn a local Anvil process, fork the current Sepolia state,
 * then replay our transaction bundle against that fork.
 *
 * Why Anvil over eth_call?
 * - eth_call simulates single transactions, not bundles
 * - Anvil gives us a full stateful environment across multiple txs
 * - We can check token balances before and after the full bundle
 * - We get exact gas measurements per transaction
 * - We see the exact revert reason if something fails
 *
 * Process lifecycle:
 * 1. spawn anvil --fork-url <rpcUrl> --fork-block-number <block>
 * 2. poll port 8545 until Anvil responds to eth_blockNumber
 * 3. anvil_impersonateAccount + anvil_setBalance for the executor wallet
 * 4. send each transaction in order via eth_sendTransaction (no signing needed)
 * 5. read token balance before and after to compute realised profit
 * 6. kill the Anvil process (always — via finally block)
 * 7. return SimulationResult
 *
 * The finally block guarantees Anvil is killed even if an exception
 * occurs mid-simulation, preventing orphaned processes.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { JsonRpcProvider, Contract } from 'ethers';
import { createModuleLogger } from '../utils/logger.js';
import type { SimulationResult } from '../types/index.js';
import type { BuiltBundle, BundleTransaction } from './bundleBuilder.js';

const logger = createModuleLogger('simulator');

const ANVIL_PORT = 8545;
const ANVIL_HOST = '127.0.0.1';
const ANVIL_RPC_URL = `http://${ANVIL_HOST}:${ANVIL_PORT}`;
const ANVIL_READY_TIMEOUT_MS = 15_000;
const ANVIL_POLL_INTERVAL_MS = 200;

// 100 ETH — enough to cover gas for any realistic bundle during simulation
const SIMULATION_ETH_BALANCE = 10n ** 20n;

const ERC20_ABI = [
  'function balanceOf(address account) external view returns (uint256)',
];

interface ERC20BalanceReader {
  balanceOf(account: string): Promise<bigint>;
}

/**
 * Converts a bigint to a 0x-prefixed hex string.
 * Required for JSON-RPC parameters that expect hex-encoded integers.
 */
function toHex(value: bigint): string {
  return '0x' + value.toString(16);
}

/**
 * Spawns an Anvil process forked at the given block number.
 * Returns the child process handle — caller is responsible for killing it.
 */
function spawnAnvil(forkUrl: string, forkBlockNumber: number): ChildProcess {
  const proc = spawn(
    'anvil',
    [
      '--fork-url', forkUrl,
      '--fork-block-number', forkBlockNumber.toString(),
      '--port', ANVIL_PORT.toString(),
      '--silent',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  proc.stderr?.on('data', (chunk: Buffer) => {
    logger.debug({ msg: chunk.toString().trim() }, 'anvil stderr');
  });

  proc.on('error', (err: Error) => {
    logger.error(
      { err },
      'Anvil process error — ensure Foundry is installed: https://getfoundry.sh',
    );
  });

  return proc;
}

/**
 * Polls Anvil RPC until it responds to eth_blockNumber.
 * Uses setInterval + setTimeout so polling and timeout race each other.
 * Throws if Anvil is not ready within ANVIL_READY_TIMEOUT_MS.
 */
async function waitForAnvilReady(): Promise<void> {
  const provider = new JsonRpcProvider(ANVIL_RPC_URL);

  return new Promise<void>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      clearInterval(pollHandle);
      reject(new Error(`Anvil did not become ready within ${ANVIL_READY_TIMEOUT_MS}ms`));
    }, ANVIL_READY_TIMEOUT_MS);

    const pollHandle = setInterval(() => {
      provider
        .getBlockNumber()
        .then(() => {
          clearInterval(pollHandle);
          clearTimeout(timeoutHandle);
          resolve();
        })
        .catch(() => {
          // Not ready yet — continue polling
        });
    }, ANVIL_POLL_INTERVAL_MS);
  });
}

/**
 * Attempts to retrieve a human-readable revert reason by replaying
 * the failing transaction as an eth_call, which propagates the revert string.
 */
async function getRevertReason(
  provider: JsonRpcProvider,
  tx: BundleTransaction,
  from: string,
): Promise<string> {
  try {
    await provider.call({ from, to: tx.to, data: tx.data, value: tx.value });
    return 'Transaction reverted with no on-chain reason';
  } catch (err: unknown) {
    if (err instanceof Error) return err.message;
    return 'Unknown revert reason';
  }
}

/**
 * Simulates a transaction bundle on a local Anvil fork.
 *
 * Returns a SimulationResult describing:
 * - success: true only if every transaction executed without reverting
 * - profitWei: actual profit measured from the change in profitTokenAddress balance
 * - gasUsed: total gas consumed across all transactions
 * - revertReason: human-readable reason string when success is false
 *
 * The Anvil process is always killed in the finally block — success or error.
 */
export async function simulateBundle(
  bundle: BuiltBundle,
  forkUrl: string,
  executorAddress: string,
  profitTokenAddress: string,
): Promise<SimulationResult> {
  // Fork at the parent block of the target block to simulate current state
  const forkBlockNumber = bundle.targetBlockNumber - 1;
  let anvilProcess: ChildProcess | null = null;

  try {
    anvilProcess = spawnAnvil(forkUrl, forkBlockNumber);
    await waitForAnvilReady();

    logger.debug({ forkBlockNumber, executorAddress }, 'Anvil fork ready');

    const anvilProvider = new JsonRpcProvider(ANVIL_RPC_URL);

    // Impersonate the executor wallet — Anvil will accept eth_sendTransaction
    // from this address without requiring a signature
    await anvilProvider.send('anvil_impersonateAccount', [executorAddress]);

    // Fund the impersonated account with ETH so gas deductions don't block execution
    await anvilProvider.send('anvil_setBalance', [
      executorAddress,
      toHex(SIMULATION_ETH_BALANCE),
    ]);

    const erc20 = new Contract(
      profitTokenAddress,
      ERC20_ABI,
      anvilProvider,
    ) as unknown as ERC20BalanceReader;

    const initialBalance = await erc20.balanceOf(executorAddress);

    let totalGasUsed = 0n;

    for (const tx of bundle.transactions) {
      const txHash = await anvilProvider.send('eth_sendTransaction', [
        {
          from: executorAddress,
          to: tx.to,
          data: tx.data,
          value: toHex(tx.value),
          gas: toHex(tx.gasLimit),
          maxFeePerGas: toHex(tx.maxFeePerGas),
          maxPriorityFeePerGas: toHex(tx.maxPriorityFeePerGas),
        },
      ]) as string;

      const receipt = await anvilProvider.getTransactionReceipt(txHash);

      if (receipt === null) {
        return {
          success: false,
          profitWei: 0n,
          gasUsed: totalGasUsed,
          revertReason: 'Transaction receipt not found after mining',
        };
      }

      // gasUsed on ethers v6 TransactionReceipt is already a bigint
      totalGasUsed += receipt.gasUsed;

      // status === 1 means success; 0 or null means revert
      if (receipt.status !== 1) {
        const revertReason = await getRevertReason(anvilProvider, tx, executorAddress);
        logger.debug({ txHash, revertReason }, 'Transaction reverted in simulation');
        return {
          success: false,
          profitWei: 0n,
          gasUsed: totalGasUsed,
          revertReason,
        };
      }
    }

    const finalBalance = await erc20.balanceOf(executorAddress);
    const profitWei = finalBalance > initialBalance ? finalBalance - initialBalance : 0n;

    logger.debug(
      {
        initialBalance: initialBalance.toString(),
        finalBalance: finalBalance.toString(),
        profitWei: profitWei.toString(),
        totalGasUsed: totalGasUsed.toString(),
      },
      'Simulation complete',
    );

    return {
      success: true,
      profitWei,
      gasUsed: totalGasUsed,
      revertReason: undefined,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown simulation error';
    logger.error({ err }, 'Bundle simulation threw an unexpected error');
    return {
      success: false,
      profitWei: 0n,
      gasUsed: 0n,
      revertReason: message,
    };
  } finally {
    if (anvilProcess !== null) {
      try {
        anvilProcess.kill('SIGTERM');
      } catch {
        // Process may have already exited on its own
      }
      logger.debug('Anvil process terminated');
    }
  }
}
