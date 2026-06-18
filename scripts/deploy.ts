/**
 * @file scripts/deploy.ts
 * @description Deployment script for FlashExecutor.sol to Sepolia testnet.
 *
 * Reads the compiled artifact (ABI + bytecode) from Foundry's output directory.
 * Deploys via ethers v6 ContractFactory using the ALCHEMY_HTTP_URL provider and
 * EXECUTOR_PRIVATE_KEY signer.  Waits for two on-chain confirmations, then verifies
 * the deployment by reading owner() from the live contract.
 *
 * Usage:
 *   pnpm deploy:sepolia
 *
 * Required env vars (set in .env):
 *   ALCHEMY_HTTP_URL      — Sepolia JSON-RPC endpoint
 *   EXECUTOR_PRIVATE_KEY  — Deployer EOA private key (must hold Sepolia ETH)
 *
 * After successful deployment copy the printed address into .env:
 *   EXECUTOR_CONTRACT_ADDRESS=<address>
 */

import { JsonRpcProvider, Wallet, ContractFactory, Contract } from 'ethers'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface FoundryArtifact {
  abi: object[]
  bytecode: {
    object: string
  }
}

async function deploy(): Promise<void> {
  // ── Load compiled artifact ──────────────────────────────────────────────
  const artifactPath = join(
    __dirname,
    '..',
    'contracts',
    'out',
    'FlashExecutor.sol',
    'FlashExecutor.json',
  )

  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as FoundryArtifact
  const abi      = artifact.abi
  const bytecode = artifact.bytecode.object

  if (!bytecode || bytecode === '0x') {
    throw new Error('Empty bytecode — run `pnpm build:contracts` first')
  }

  // ── Set up provider and signer ──────────────────────────────────────────
  const rpcUrl     = process.env['ALCHEMY_HTTP_URL']
  const privateKey = process.env['EXECUTOR_PRIVATE_KEY']

  if (!rpcUrl)     throw new Error('ALCHEMY_HTTP_URL not set in .env')
  if (!privateKey) throw new Error('EXECUTOR_PRIVATE_KEY not set in .env')

  const provider = new JsonRpcProvider(rpcUrl)
  const wallet   = new Wallet(privateKey, provider)

  const { chainId } = await provider.getNetwork()
  console.log(`[deploy] Connected to chain ${chainId}`)
  console.log(`[deploy] Deployer: ${wallet.address}`)

  const balance = await provider.getBalance(wallet.address)
  console.log(`[deploy] Balance: ${balance} wei`)

  // ── Deploy ──────────────────────────────────────────────────────────────
  const factory  = new ContractFactory(abi, bytecode, wallet)
  console.log('[deploy] Sending deployment transaction…')

  const deployTx = await factory.deploy()
  const contract = deployTx as unknown as Contract & { deploymentTransaction(): { hash: string } }

  console.log(`[deploy] Tx hash: ${contract.deploymentTransaction().hash}`)
  console.log('[deploy] Waiting for 2 confirmations…')

  await deployTx.waitForDeployment()
  const deployedAddress = await deployTx.getAddress()

  console.log(`[deploy] Deployed at: ${deployedAddress}`)

  // ── Verify ──────────────────────────────────────────────────────────────
  const deployed  = new Contract(deployedAddress, abi, provider)
  const onChainOwner = await deployed['owner']() as string

  if (onChainOwner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`owner() mismatch: expected ${wallet.address}, got ${onChainOwner}`)
  }

  console.log(`[deploy] Verified owner(): ${onChainOwner}`)
  console.log(`\nUpdate your .env: EXECUTOR_CONTRACT_ADDRESS=${deployedAddress}`)
}

deploy().catch((err: unknown) => {
  console.error('[deploy] Fatal error:', err)
  process.exit(1)
})
