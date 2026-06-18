/**
 * @file src/dashboard/server.ts
 * @description Express-style HTTP + WebSocket dashboard server.
 *
 * Serves the static frontend HTML on GET /
 * Exposes a REST endpoint for the initial state on GET /api/state
 * WebSocket pushes state_update messages to all connected clients every 2 s,
 * and immediately when broadcastUpdate() is called from the pipeline.
 *
 * Why WebSocket instead of polling?
 * Polling every 2 s from multiple browser tabs wastes requests.
 * WebSocket push sends only when data actually changes, giving instant updates
 * when an opportunity or bundle result arrives.
 *
 * The HTML file is read once at startup and cached in memory so every
 * subsequent request is a fast in-process string write, not a disk read.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createModuleLogger } from '../utils/logger.js';
import { dashboardState } from './state.js';

const logger = createModuleLogger('dashboard');

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PORT = 3000;
const UPDATE_INTERVAL_MS = 2000;

// ── Server class ─────────────────────────────────────────────────────────────

export class DashboardServer {
  private httpServer: Server | undefined;
  private wss: WebSocketServer | undefined;
  private updateInterval: NodeJS.Timeout | undefined;

  /** Starts the HTTP server, attaches WebSocket, and begins periodic broadcasts */
  async start(): Promise<void> {
    const htmlPath = join(__dirname, 'public', 'index.html');
    const htmlContent = readFileSync(htmlPath, 'utf8');

    const server = createServer((req: IncomingMessage, res: ServerResponse): void => {
      const url = req.url ?? '/';

      if (url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlContent);
      } else if (url === '/api/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(dashboardState.getState()));
      } else if (url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, timestamp: Date.now() }));
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });

    this.httpServer = server;

    // Attach WebSocket server to the same port as HTTP
    this.wss = new WebSocketServer({ server });

    this.wss.on('connection', (ws: WebSocket): void => {
      logger.info('Dashboard client connected');

      // Send current state immediately so the tab is populated on load
      const initial = JSON.stringify({ type: 'state_update', data: dashboardState.getState() });
      ws.send(initial);

      ws.on('close', (): void => {
        logger.info('Dashboard client disconnected');
      });
    });

    // Periodic push — updates every tab without the tab needing to poll
    this.updateInterval = setInterval((): void => {
      this.broadcastUpdate();
    }, UPDATE_INTERVAL_MS);

    await new Promise<void>((resolve): void => {
      server.listen(DASHBOARD_PORT, (): void => {
        logger.info({ port: DASHBOARD_PORT }, `Dashboard running at http://localhost:${DASHBOARD_PORT}`);
        resolve();
      });
    });
  }

  /**
   * Pushes the current dashboard state to every open WebSocket client.
   * Called automatically every UPDATE_INTERVAL_MS and manually on
   * any significant pipeline event (opportunity detected, bundle result).
   */
  broadcastUpdate(): void {
    if (this.wss === undefined) return;

    const message = JSON.stringify({ type: 'state_update', data: dashboardState.getState() });

    this.wss.clients.forEach((client: WebSocket): void => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  /** Tears down the interval, WebSocket server, and HTTP server cleanly */
  async stop(): Promise<void> {
    if (this.updateInterval !== undefined) {
      clearInterval(this.updateInterval);
      this.updateInterval = undefined;
    }

    await new Promise<void>((resolve): void => {
      if (this.wss === undefined) {
        resolve();
        return;
      }
      this.wss.close((): void => resolve());
    });

    await new Promise<void>((resolve): void => {
      if (this.httpServer === undefined) {
        resolve();
        return;
      }
      this.httpServer.close((): void => resolve());
    });

    logger.info('Dashboard server stopped');
  }
}

/** Factory function — preferred over direct `new DashboardServer()` at call sites */
export function createDashboardServer(): DashboardServer {
  return new DashboardServer();
}
