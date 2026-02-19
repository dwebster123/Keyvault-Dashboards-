import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { VaultClient } from '@drift-labs/vaults-sdk';
import { DriftClient, Wallet } from '@drift-labs/sdk';

const RPC = 'https://mainnet.helius-rpc.com/?api-key=86b538c8-91f4-4ae5-95ec-4392a2fbecaf';
const VAULT_ADDRESS = '2dNSa3fBPMoxcs46NhtdLeTJuLasDt6VYNG4vopa7mWw';

const connection = new Connection(RPC, 'confirmed');
const kp = Keypair.generate();
const wallet = new Wallet(kp);

const driftClient = new DriftClient({ connection, wallet, env: 'mainnet-beta' });
await driftClient.subscribe();

try {
  const vaultClient = new VaultClient({ driftClient });
  const vault = await vaultClient.getVault(new PublicKey(VAULT_ADDRESS));
  console.log('Vault name:', Buffer.from(vault.name).toString('utf8').replace(/\0/g,''));
  console.log('Total shares:', vault.totalShares.toString());
  console.log('Total deposits:', vault.totalDeposits.toString());

  const equity = await vaultClient.calculateVaultEquityInDepositAsset({ vault });
  const sharePriceFull = equity.toNumber() / 1e6 / (vault.totalShares.toNumber() / 1e9);
  console.log('Equity USD:', (equity.toNumber() / 1e6).toFixed(2));
  console.log('Share price:', sharePriceFull.toFixed(6));
} catch (e) {
  console.error('Error:', e.message);
}
