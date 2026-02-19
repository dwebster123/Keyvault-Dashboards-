/**
 * Fetch Drift public vault share price using getDriftVaultProgram (no WebSocket).
 * Reads vault account on-chain to get total shares and net deposits.
 */
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getDriftVaultProgram, VAULT_PROGRAM_ID } = require('@drift-labs/vaults-sdk');

const RPC = 'https://mainnet.helius-rpc.com/?api-key=86b538c8-91f4-4ae5-95ec-4392a2fbecaf';
const VAULT_ADDRESS = '2dNSa3fBPMoxcs46NhtdLeTJuLasDt6VYNG4vopa7mWw';

const connection = new Connection(RPC, 'confirmed');
const kp = Keypair.generate();
const wallet = new Wallet(kp);

const program = getDriftVaultProgram(connection, wallet);
console.log('Vault program:', VAULT_PROGRAM_ID?.toString());

const vault = await program.account.vault.fetch(new PublicKey(VAULT_ADDRESS));

const name = Buffer.from(vault.name).toString('utf8').replace(/\0/g, '');
const USDC_PRECISION = 1_000_000;      // 10^6
const SHARE_PRECISION = 1_000_000_000; // 10^9

const totalDeposits = vault.totalDeposits.toNumber() / USDC_PRECISION;
const totalWithdraws = vault.totalWithdraws.toNumber() / USDC_PRECISION;
const netDeposits = vault.netDeposits.toNumber() / USDC_PRECISION;
const totalShares = vault.totalShares.toNumber() / SHARE_PRECISION;

// Net deposits / total shares = approximate share price
// (doesn't include unrealized P&L, but useful as baseline)
const approxSharePrice = netDeposits / totalShares;

console.log(JSON.stringify({
  name,
  totalDeposits: totalDeposits.toFixed(2),
  totalWithdraws: totalWithdraws.toFixed(2),
  netDeposits: netDeposits.toFixed(2),
  totalShares: totalShares.toFixed(4),
  approxSharePrice: approxSharePrice.toFixed(6),
}, null, 2));
