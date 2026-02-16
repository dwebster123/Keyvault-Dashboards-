#!/usr/bin/env node

/**
 * Fetch Drift vault (PN_KV1) trade/position history and compute P&L by timeframe.
 * Vault address: G3RT2wdEYCphzcvXEHb8u4Yc4ZRscsQ1KRYywdBjgUZp
 */

const { Connection, PublicKey } = require('@solana/web3.js');
const { DriftClient, Wallet, BN, getUserAccountPublicKeySync, initialize } = require('@drift-labs/sdk');
const fs = require('fs');
const path = require('path');

const VAULT_ADDRESS = 'G3RT2wdEYCphzcvXEHb8u4Yc4ZRscsQ1KRYywdBjgUZp';
const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=86b538c8-91f4-4ae5-95ec-4392a2fbecaf';

// Drift program
const DRIFT_PROGRAM = new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH');

// Market index mapping
const PERP_MARKETS = {
  0: 'SOL',
  1: 'BTC', 
  2: 'ETH',
};

async function main() {
  console.log('Fetching Drift vault data...');
  
  const connection = new Connection(RPC_URL, 'confirmed');
  const vaultPubkey = new PublicKey(VAULT_ADDRESS);
  
  // Derive user account PDA (subaccount 0)
  const [userAccountPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user'), vaultPubkey.toBuffer(), Buffer.from([0, 0])], // u16 LE = 0
    DRIFT_PROGRAM
  );
  console.log('User PDA:', userAccountPda.toString());
  
  // Fetch the user account data directly
  const accountInfo = await connection.getAccountInfo(userAccountPda);
  if (!accountInfo) {
    console.log('User account not found');
    return;
  }
  console.log('Account data size:', accountInfo.data.length, 'bytes');
  
  // Use Drift's historical trade data API (S3)
  // Since S3 doesn't have this user, let's try fetching recent transaction signatures
  // and parsing the trade events from them
  
  const signatures = await connection.getSignaturesForAddress(userAccountPda, {
    limit: 100,
  });
  console.log(`Found ${signatures.length} recent transactions`);
  
  // Get transaction details to extract P&L
  const trades = [];
  let processed = 0;
  
  for (const sig of signatures.slice(0, 50)) {
    try {
      const tx = await connection.getParsedTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
      });
      
      if (!tx || !tx.meta || tx.meta.err) continue;
      
      // Look at token balance changes (USDC flows indicate P&L settlements)
      const preBalances = tx.meta.preTokenBalances || [];
      const postBalances = tx.meta.postTokenBalances || [];
      
      // Find USDC balance changes for the vault
      for (const post of postBalances) {
        if (post.owner === VAULT_ADDRESS) {
          const pre = preBalances.find(p => 
            p.owner === VAULT_ADDRESS && 
            p.mint === post.mint &&
            p.accountIndex === post.accountIndex
          );
          if (pre) {
            const preAmount = parseFloat(pre.uiTokenAmount.uiAmountString || '0');
            const postAmount = parseFloat(post.uiTokenAmount.uiAmountString || '0');
            const delta = postAmount - preAmount;
            if (Math.abs(delta) > 0.01) {
              trades.push({
                timestamp: new Date(sig.blockTime * 1000).toISOString(),
                signature: sig.signature,
                mint: post.mint,
                delta: delta,
                preBalance: preAmount,
                postBalance: postAmount,
              });
            }
          }
        }
      }
      
      processed++;
      if (processed % 10 === 0) {
        console.log(`Processed ${processed}/50 transactions...`);
        // Rate limit
        await new Promise(r => setTimeout(r, 200));
      }
    } catch (e) {
      // Skip errors (rate limits etc)
      await new Promise(r => setTimeout(r, 500));
    }
  }
  
  console.log(`\nFound ${trades.length} balance changes`);
  
  // Compute P&L by timeframe
  const now = Date.now();
  const timeframes = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    '90d': 90 * 24 * 60 * 60 * 1000,
    '180d': 180 * 24 * 60 * 60 * 1000,
  };
  
  const results = {};
  for (const [label, ms] of Object.entries(timeframes)) {
    const cutoff = new Date(now - ms);
    const relevant = trades.filter(t => new Date(t.timestamp) >= cutoff);
    const totalDelta = relevant.reduce((sum, t) => sum + t.delta, 0);
    results[label] = {
      trades: relevant.length,
      netDelta: totalDelta.toFixed(2),
    };
  }
  
  console.log('\n=== P&L by Timeframe ===');
  for (const [label, data] of Object.entries(results)) {
    console.log(`${label}: ${data.trades} trades, net delta: $${data.netDelta}`);
  }
  
  // Save raw data
  const outputPath = path.join(__dirname, '..', 'data', 'drift-vault-trades.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({
    vault: VAULT_ADDRESS,
    userPda: userAccountPda.toString(),
    fetchedAt: new Date().toISOString(),
    trades,
    timeframeSummary: results,
  }, null, 2));
  console.log(`\nSaved to ${outputPath}`);
}

main().catch(console.error);
