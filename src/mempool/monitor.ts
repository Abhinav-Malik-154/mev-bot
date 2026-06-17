/**
 * @file src/mempool/monitor.ts
 * @description WebSocket mempool monitor.
 *
 * Connects to Ethereum node via WebSocket and subscribes to
 * eth_subscribe("pendingTransactions") to receive all pending
 * transactions before they are confirmed in a block.
 *
 * Why WebSocket and not HTTP polling?
 * WebSocket gives us push-based updates with ~50ms latency.
 * HTTP polling would be ~500ms minimum — too slow for MEV.
 *
 * Emits each pending transaction to the parser for decoding.
 * Handles reconnection automatically on disconnect.
 */

import { WebSocketProvider, JsonRpcProvider } from 'ethers';
import { createModuleLogger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';
import { config } from '../config.js';
import type { PendingTransaction } from '../types/index.js';

const logger = createModuleLogger('mempool');

type TransactionCallback = (tx: PendingTransaction) => Promise<void>;

export class MempoolMonitor {
  private wsProvider: WebSocketProvider | undefined = undefined;
  private httpProvider: JsonRpcProvider | undefined = undefined;
  private isRunning = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly reconnectDelayMs = 2000;
  private txCallback: TransactionCallback | undefined = undefined;

  async start(onTransaction: TransactionCallback): Promise<void> {
    this.txCallback = onTransaction;
    this.isRunning = true;
    await this.connect();
    logger.info('Mempool monitor started');
  }

  private async connect(): Promise<void> {
    // Destroy stale providers from a previous connection attempt
    if (this.wsProvider !== undefined) {
      await this.wsProvider.destroy();
      this.wsProvider = undefined;
    }

    this.wsProvider = new WebSocketProvider(config.wsUrl);
    this.httpProvider = new JsonRpcProvider(config.httpUrl);

    await this.subscribeToMempool();

    void this.wsProvider.on('error', (): void => {
      void this.handleDisconnect();
    });

    // The ethers WebSocketProvider leaves onclose unimplemented (it's a TODO in v6).
    // We wire it ourselves so network drops trigger reconnection.
    // Cast needed: WebSocketLike interface omits onclose, but the underlying ws.WebSocket has it.
    (this.wsProvider.websocket as unknown as { onclose: (() => void) | null }).onclose = (): void => {
      void this.handleDisconnect();
    };

    this.reconnectAttempts = 0;
    logger.info({ wsUrl: config.wsUrl }, 'Connected to Ethereum node');
  }

  private async subscribeToMempool(): Promise<void> {
    if (this.wsProvider === undefined) {
      throw new Error('Provider not initialized');
    }

    const provider = this.wsProvider;

    // ethers Listener type is (...args: any[]) => void; we wrap in a sync function
    // and use void to explicitly fire-and-forget the async inner work.
    await provider.on('pending', (txHash: string): void => {
      void (async (): Promise<void> => {
        const tx = await provider.getTransaction(txHash);

        if (tx === null || tx.to === null) return;

        const pendingTx: PendingTransaction = {
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          value: tx.value,
          gasPrice: tx.gasPrice,
          maxFeePerGas: tx.maxFeePerGas,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
          data: tx.data,
          nonce: tx.nonce,
          chainId: Number(tx.chainId),
        };

        metrics.incrementTxScanned();

        try {
          await this.txCallback?.(pendingTx);
        } catch (error: unknown) {
          logger.debug({ err: error, txHash }, 'Error processing transaction');
        }
      })();
    });
  }

  private async handleDisconnect(): Promise<void> {
    if (!this.isRunning) return;

    logger.warn('WebSocket disconnected, attempting reconnect...');

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.fatal({ attempts: this.reconnectAttempts }, 'Max reconnect attempts reached — exiting');
      process.exit(1);
    }

    this.reconnectAttempts++;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, this.reconnectDelayMs * this.reconnectAttempts);
    });

    await this.connect();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.wsProvider !== undefined) {
      await this.wsProvider.destroy();
    }
    logger.info('Mempool monitor stopped');
  }
}

export function createMempoolMonitor(): MempoolMonitor {
  return new MempoolMonitor();
}
