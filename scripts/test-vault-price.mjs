/**
 * Test: Get real vault share price using VaultClient + DriftClient
 * This properly accounts for unrealized P&L from open positions.
 */
import { createRequire } from 'module';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';

const require = createRequire(import.meta.url);
const { DriftClient, QUOTE_PRECISION } = require('@drift-labs/sdk/lib/node/index.js');
const { VaultClient, getDriftVaultProgram } = require('@drift-labs/vaults-sdk/lib/index.js');

// Helius - websocket subscription avoids the batch request restriction
const RPC = 'https://mainnet.helius-rpc.com/?api-key=86b538c8-91f4-4ae5-95ec-4392a2fbecaf';
const VAULT_ADDRESS = '2dNSa3fBPMoxcs46NhtdLeTJuLasDt6VYNG4vopa7mWw';

console.log('[VaultPrice] Connecting...');

const connection = new Connection(RPC, 'confirmed');
const keypair = Keypair.generate();
const wallet = new Wallet(keypair);

const driftClient = new DriftClient({
  connection,
  wallet,
  env: 'mainnet-beta',
  accountSubscription: {
    type: 'websocket',
  },
});

console.log('[VaultPrice] Subscribing DriftClient...');
await driftClient.subscribe();

const program = getDriftVaultProgram(connection, wallet);
const vaultClient = new VaultClient({
  driftClient,
  program,
});

console.log('[VaultPrice] Fetching vault equity...');
const vaultAddress = new PublicKey(VAULT_ADDRESS);

// Get raw vault data for totalShares
const vaultAccount = await program.account.vault.fetch(vaultAddress);
const totalSharesBN = vaultAccount.totalShares;

// Get full equity in deposit asset (USDC, 6 decimals)
const equityBN = await vaultClient.calculateVaultEquityInDepositAsset({ address: vaultAddress });
console.log('[VaultPrice] Raw equity BN:', equityBN.toString());

// equity in USDC = equityBN / 10^6
const USDC_PRECISION = 1_000_000;
const equityUSDC = equityBN.toNumber() / USDC_PRECISION;

// totalShares: Drift vault shares use USDC precision (10^6), not 10^9
const SHARE_PRECISION = 1_000_000;
const totalShares = totalSharesBN.toNumber() / SHARE_PRECISION;

// share price = equity / shares
const sharePrice = equityUSDC / totalShares;

console.log(`\n=== RESULT ===`);
console.log(`Equity (USDC):   $${equityUSDC.toFixed(2)}`);
console.log(`Total Shares:    ${totalShares.toFixed(4)}`);
console.log(`Share Price:     $${sharePrice.toFixed(6)}`);
console.log(`Net Deposits:    $${(vaultAccount.netDeposits.toNumber() / USDC_PRECISION).toFixed(2)}`);
console.log(`Baseline Price:  $${(vaultAccount.netDeposits.toNumber() / USDC_PRECISION / totalShares).toFixed(6)}`);

await driftClient.unsubscribe();
console.log('[VaultPrice] Done.');
