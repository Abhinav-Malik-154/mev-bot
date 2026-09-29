# Screenshots

This folder contains visual assets referenced in the main README.

- `dashboard-preview.png` — Live dashboard screenshot
  (add yours by running `pnpm dev`, opening http://localhost:3000,
  and saving a screenshot here)

## Dashboard Setup

The dashboard is included in the main bot process. From the repository root,
run:

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Then open [http://localhost:3000](http://localhost:3000). No separate frontend
server is required.

To observe Ethereum mainnet without submitting bundles, run:

```bash
pnpm dev:mainnet-readonly
```
