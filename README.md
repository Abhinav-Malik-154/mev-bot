# MEV Searcher Bot

A production-grade MEV (Maximal Extractable Value) searcher bot built with TypeScript. Monitors the Ethereum mempool in real time, detects Uniswap V2 swap opportunities, and submits atomic arbitrage bundles via Flashbots.

```
███╗   ███╗███████╗██╗   ██╗    ██████╗  ██████╗ ████████╗
████╗ ████║██╔════╝██║   ██║    ██╔══██╗██╔═══██╗╚══██╔══╝
██╔████╔██║█████╗  ██║   ██║    ██████╔╝██║   ██║   ██║
██║╚██╔╝██║██╔══╝  ╚██╗ ██╔╝    ██╔══██╗██║   ██║   ██║
██║ ╚═╝ ██║███████╗ ╚████╔╝     ██████╔╝╚██████╔╝   ██║
╚═╝     ╚═╝╚══════╝  ╚═══╝      ╚═════╝  ╚═════╝    ╚═╝
         Flashbots MEV-Share | Uniswap V2/V3 Arbitrage
```

---

## What is MEV?

MEV stands for **Maximal Extractable Value** — profit extracted by reordering, inserting, or censoring transactions within a block. This bot focuses on **sandwich arbitrage**: when a user submits a large Uniswap V2 swap, the bot detects it in the mempool, places a buy order before it and a sell order after it, capturing the price impact as profit.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript 5 (strict mode) |
| Runtime | Node.js 22 |
| Ethereum | ethers.js v6 |
| MEV Relay | Flashbots MEV-Share |
| Database | SQLite via better-sqlite3 |
| Logging | pino (JSON in prod, pretty in dev) |
| Package Manager | pnpm |
| Contracts | Solidity + Foundry |

---

## Project Structure

```
mev-bot/
├── src/
│   ├── index.ts              # Main entry point — wires all phases together
│   ├── config.ts             # Environment config loader and validator
│   ├── types/
│   │   └── index.ts          # Shared TypeScript interfaces (PendingTx, Swap, etc.)
│   ├── mempool/              # Phase 2 — WebSocket mempool monitor
│   │   ├── monitor.ts        # MempoolMonitor class — connects and subscribes
│   │   ├── parser.ts         # Uniswap V2 calldata decoder
│   │   └── index.ts          # Public re-exports
│   ├── detector/             # Phase 3 — Arbitrage opportunity calculator (coming)
│   ├── executor/             # Phase 4 — Bundle builder and submitter (coming)
│   ├── flashbots/            # Phase 5 — Flashbots relay integration (coming)
│   ├── dashboard/            # Phase 6 — Web UI (coming)
│   └── utils/
│       ├── db.ts             # SQLite helpers — save/read opportunities and bundles
│       ├── logger.ts         # Pino structured logger
│       └── metrics.ts        # In-memory performance counters
├── contracts/
│   ├── src/                  # FlashExecutor.sol — atomic on-chain execution (coming)
│   └── test/                 # Foundry tests (coming)
├── .env.example              # Environment variable template — copy to .env
├── tsconfig.json
├── package.json
└── pnpm-lock.yaml
```

---

## Build Phases

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 1 | ✅ Complete | Project scaffold — config, types, logger, SQLite DB, metrics |
| Phase 2 | ✅ Complete | Mempool monitor — WebSocket connection, Uniswap V2 decoder |
| Phase 3 | 🔜 Next | Opportunity detector — pool reserves, profit calculation |
| Phase 4 | 🔜 | Bundle executor — build and sign Flashbots bundles |
| Phase 5 | 🔜 | Flashbots relay — submit, track, and retry bundles |
| Phase 6 | 🔜 | FlashExecutor.sol — atomic on-chain arbitrage contract |
| Phase 7 | 🔜 | Web dashboard — live swap feed, profit chart, metrics |
| Phase 8 | 🔜 | Mainnet hardening — simulation, gas optimization, safety limits |

---

## Prerequisites

- [Node.js](https://nodejs.org/) v20 or higher
- [pnpm](https://pnpm.io/) — `npm install -g pnpm`
- [Alchemy](https://dashboard.alchemy.com/) account (free tier works)
- A dedicated Sepolia testnet wallet (never use your main wallet)

---

## Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd mev-bot

# Install dependencies
pnpm install

# Copy environment template
cp .env.example .env
```

---

## Configuration

Open `.env` and fill in your values:

```env
# Get a free key at dashboard.alchemy.com → create app → Sepolia
ALCHEMY_WS_URL=wss://eth-sepolia.g.alchemy.com/v2/YOUR_KEY_HERE
ALCHEMY_HTTP_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY_HERE

# Flashbots relay — Sepolia is free and safe for testing
FLASHBOTS_RELAY_URL=https://relay-sepolia.flashbots.net

# A throwaway Sepolia wallet — NEVER use your main wallet
EXECUTOR_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE

# Deployed FlashExecutor.sol address — filled in Phase 6
EXECUTOR_CONTRACT_ADDRESS=0xYOUR_CONTRACT_ADDRESS_HERE

# Network — 11155111 = Sepolia (safe), 1 = Mainnet (real money, Phase 8 only)
CHAIN_ID=11155111
```

> **Security:** `.env` is gitignored and will never be committed. Only `.env.example` (with placeholder values) is in the repository.

---

## Running

```bash
# Development — hot reload, colored logs
pnpm dev

# Production — build first, then run
pnpm build
pnpm start

# Verbose debug output
LOG_LEVEL=debug pnpm dev
```

---

## What You See When It Runs

```
✓ Chain ID: 11155111
✓ Relay URL: https://relay-sepolia.flashbots.net
✓ Min profit: 1 finney
✓ Max gas: 50 gwei
✓ Private key: ...****abcd

INFO [main]    Bot started { chainId: 11155111 }
INFO [mempool] Connected to Ethereum node
INFO [mempool] Mempool monitor started
INFO [main]    Phase 2 active ✓ — monitoring mempool for Uniswap V2 swaps

# When a Uniswap V2 swap is detected:
INFO [main]    Uniswap V2 swap detected {
  txHash: "0xabc123...",
  tokenIn: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  tokenOut: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
  amountIn: "500000000000000000"
}

# Metrics summary every 60 seconds:
INFO [metrics] Bot metrics {
  uptimeSeconds: 60,
  txScanned: 142,
  opportunitiesFound: 5,
  totalProfitEth: "0.000000"
}
```

---

## Available Scripts

```bash
pnpm dev              # Run with hot reload (tsx watch)
pnpm build            # Compile TypeScript → dist/
pnpm start            # Run compiled output
pnpm lint             # ESLint (zero warnings, zero errors)
pnpm format           # Prettier auto-format
pnpm test:contracts   # Foundry tests for Solidity contracts
```

---

## Inspecting the Database

After the bot runs, opportunities and bundles are stored in SQLite:

```bash
# Open the database
sqlite3 data/mev-bot.db

# View detected opportunities
SELECT id, timestamp, token_a, token_b, net_profit_wei, is_profitable
FROM opportunities
ORDER BY timestamp DESC
LIMIT 20;

# View submitted bundles
SELECT id, success, bundle_hash, block_number, profit_wei
FROM bundles
ORDER BY rowid DESC
LIMIT 10;
```

---

## How the Arbitrage Works

```
Mempool
  │
  ▼
[Victim Tx]  User swaps 1 ETH → TOKEN on Uniswap V2
  │
  ▼
[Phase 2]  MempoolMonitor detects it via WebSocket pending subscription
  │
  ▼
[Phase 3]  Detector reads pool reserves, calculates price impact and profit
  │
  ▼
[Phase 4]  Executor builds a 3-tx bundle:
           1. Bot buys TOKEN before victim (drives price up)
           2. Victim's swap executes (victim pays higher price)
           3. Bot sells TOKEN after victim (captures profit)
  │
  ▼
[Phase 5]  Bundle submitted to Flashbots relay — atomic, reverts if unprofitable
  │
  ▼
[Phase 6]  FlashExecutor.sol runs all 3 txs atomically in one on-chain call
```

---

## Supported Swap Functions

The parser decodes these Uniswap V2 Router functions:

| Function | Description |
|----------|-------------|
| `swapExactTokensForTokens` | Exact token in → minimum token out |
| `swapTokensForExactTokens` | Maximum token in → exact token out |
| `swapExactETHForTokens` | Exact ETH in → minimum token out |
| `swapExactTokensForETH` | Exact token in → minimum ETH out |

---

## Safety

- Runs on **Sepolia testnet** by default — no real money at risk
- `CHAIN_ID=1` (mainnet) is blocked until Phase 8 hardening is complete
- Private key never appears in logs — only last 4 characters are shown
- All bundles go through Flashbots — they either execute atomically or revert completely, no partial losses
- `MIN_PROFIT_WEI` threshold prevents submitting unprofitable bundles

---

## License

MIT
