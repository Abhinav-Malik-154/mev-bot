/**
 * @file src/dashboard/index.ts
 * @description Public API for the dashboard module.
 *
 * Re-exports the DashboardServer class, its factory function, and the
 * dashboardState singleton so callers can import everything from one path.
 */

export { DashboardServer, createDashboardServer } from './server.js';
export { dashboardState } from './state.js';
export type { DashboardState, RecentOpportunity, RecentBundle } from './state.js';
