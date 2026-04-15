#!/usr/bin/env node
// Daily share-price stamp for the live Voltr Cross-Platform JLP vault.
// This builds a dedicated history feed for the dashboard chart without
// disturbing the legacy official-nav-history dataset.

const fs = require('fs');
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');
const Decimal = require('decimal.js');

const VAULT_ADDRESS = 'BbhQpnex9btpNqzYgL3REpTPZsAeJ3VGYtV1mmLhQ7oc';
const DATA_PATH = path.join(__dirname, '..', 'data', 'voltr-cross-platform-share-history.json');
const TARGET_TIMEZONE = 'America/Los_Angeles';
const TARGET_DAILY_STAMP_LABEL = '2:00 PM PT';
const TARGET_DAILY_STAMP_HOUR = 14;

function loadJson(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        console.warn(`[voltr-share-stamp] Could not load ${filePath}: ${error.message}`);
        return null;
    }
}

function resolveRpcUrl() {
    if (process.env.HELIUS_RPC_URL) return process.env.HELIUS_RPC_URL;
    if (process.env.HELIUS_API_KEY) {
        return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
    }

    const candidateConfigPaths = [
        path.join(process.env.HOME || '', '.openclaw', 'helius', 'config.json'),
        path.join(process.env.HOME || '', '.helius', 'config.json'),
    ];

    for (const configPath of candidateConfigPaths) {
        const cfg = loadJson(configPath);
        if (cfg?.mainnetRpc) return cfg.mainnetRpc;
    }

    // Temporary fallback until the Helius config location is normalized.
    return 'https://mainnet.helius-rpc.com/?api-key=41552a6e-8694-4969-9880-f75b4a95559e';
}

function loadVoltrSdk() {
    const candidates = [
        '@voltr/vault-sdk',
        path.join(process.env.HOME || '', 'clawd', 'projects', 'solana-agent-hackathon', 'node_modules', '@voltr', 'vault-sdk'),
    ];

    let lastError = null;
    for (const candidate of candidates) {
        try {
            return require(candidate);
        } catch (error) {
            lastError = error;
        }
    }

    throw new Error(
        `Unable to load @voltr/vault-sdk. Install it in this repo or make sure the local SDK path exists. Last error: ${lastError?.message || 'unknown error'}`
    );
}

function toNumberString(value, digits) {
    return new Decimal(value).toFixed(digits);
}

function getPacificDate(date) {
    return date.toLocaleDateString('en-CA', { timeZone: TARGET_TIMEZONE });
}

function formatPacificDateTime(dateLike) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: TARGET_TIMEZONE,
        dateStyle: 'long',
        timeStyle: 'long',
    }).format(new Date(dateLike));
}

function saveHistory(history) {
    const tmpPath = `${DATA_PATH}.tmp`;
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(history, null, 2));
    fs.renameSync(tmpPath, DATA_PATH);
}

async function getMintInfo(connection, mintAddress) {
    const response = await connection.getParsedAccountInfo(mintAddress, 'confirmed');
    const parsed = response?.value?.data?.parsed?.info;
    if (!parsed) {
        throw new Error(`Could not parse mint account ${mintAddress.toBase58()}`);
    }
    return {
        supply: new Decimal(parsed.supply),
        decimals: parsed.decimals,
    };
}

async function fetchSnapshot() {
    const rpcUrl = resolveRpcUrl();
    const { VoltrClient, convertDecimalBitsToDecimal } = loadVoltrSdk();
    const connection = new Connection(rpcUrl, 'confirmed');
    const client = new VoltrClient(connection);
    const vaultPubkey = new PublicKey(VAULT_ADDRESS);
    const vaultLpMint = client.findVaultLpMint(vaultPubkey);
    const now = new Date();

    const [slot, vaultAccount, lpMintInfo] = await Promise.all([
        connection.getSlot('confirmed'),
        client.fetchVaultAccount(vaultPubkey),
        getMintInfo(connection, vaultLpMint),
    ]);

    const assetMint = vaultAccount.asset.mint;
    const assetMintInfo = await getMintInfo(connection, assetMint);
    const totalValueRaw = new Decimal(vaultAccount.asset.totalValue.toString());
    const unharvestedLpRaw = new Decimal(
        vaultAccount.feeState.accumulatedLpAdminFees
            .add(vaultAccount.feeState.accumulatedLpManagerFees)
            .add(vaultAccount.feeState.accumulatedLpProtocolFees)
            .toString()
    );
    const dilutedLpRaw = lpMintInfo.supply.plus(unharvestedLpRaw);
    const scale = new Decimal(10).pow(lpMintInfo.decimals - assetMintInfo.decimals);
    const sharePrice = totalValueRaw.div(dilutedLpRaw).mul(scale);
    const circulatingSharePrice = totalValueRaw.div(lpMintInfo.supply).mul(scale);
    const highWaterMark = convertDecimalBitsToDecimal(
        vaultAccount.highWaterMark.highestAssetPerLpDecimalBits
    ).mul(scale);
    const discountToHighWaterBps = highWaterMark.gt(0)
        ? highWaterMark.minus(sharePrice).div(highWaterMark).mul(10000)
        : new Decimal(0);

    return {
        date: getPacificDate(now),
        timestamp: now.toISOString(),
        capturedAtPacific: formatPacificDateTime(now),
        slot,
        sharePrice: Number(toNumberString(sharePrice, 12)),
        circulatingSharePrice: Number(toNumberString(circulatingSharePrice, 12)),
        totalValueUsdc: Number(toNumberString(totalValueRaw.div(new Decimal(10).pow(assetMintInfo.decimals)), 6)),
        lpSupply: Number(toNumberString(lpMintInfo.supply.div(new Decimal(10).pow(lpMintInfo.decimals)), 9)),
        dilutedLpSupply: Number(toNumberString(dilutedLpRaw.div(new Decimal(10).pow(lpMintInfo.decimals)), 9)),
        unharvestedFeeLp: Number(toNumberString(unharvestedLpRaw.div(new Decimal(10).pow(lpMintInfo.decimals)), 9)),
        highWaterMark: Number(toNumberString(highWaterMark, 12)),
        discountToHighWaterBps: Number(toNumberString(discountToHighWaterBps, 6)),
        lockedProfitUsdc: Number(
            toNumberString(
                new Decimal(vaultAccount.lockedProfitState.lastUpdatedLockedProfit.toString()).div(
                    new Decimal(10).pow(assetMintInfo.decimals)
                ),
                6
            )
        ),
        assetMint: assetMint.toBase58(),
        lpMint: vaultLpMint.toBase58(),
        vaultLastUpdatedTs: new Date(Number(vaultAccount.lastUpdatedTs.toString()) * 1000).toISOString(),
        vaultLastUpdatedPacific: formatPacificDateTime(Number(vaultAccount.lastUpdatedTs.toString()) * 1000),
        highWaterMarkLastUpdatedTs: new Date(Number(vaultAccount.highWaterMark.lastUpdatedTs.toString()) * 1000).toISOString(),
        highWaterMarkLastUpdatedPacific: formatPacificDateTime(Number(vaultAccount.highWaterMark.lastUpdatedTs.toString()) * 1000),
    };
}

function upsertSnapshot(history, snapshot) {
    const snapshots = Array.isArray(history?.snapshots) ? history.snapshots : [];
    const existingIndex = snapshots.findIndex(entry => entry.date === snapshot.date);

    if (existingIndex >= 0) {
        snapshots[existingIndex] = snapshot;
    } else {
        snapshots.push(snapshot);
    }

    snapshots.sort((a, b) => a.date.localeCompare(b.date));
    return snapshots;
}

async function main() {
    console.log(`[voltr-share-stamp] Fetching live share price for ${VAULT_ADDRESS}`);
    const snapshot = await fetchSnapshot();
    const existing = loadJson(DATA_PATH);
    const history = {
        vault: VAULT_ADDRESS,
        vaultName: 'JLP Hedge Vault Pro V1',
        timezone: TARGET_TIMEZONE,
        targetDailyStampHourLocal: TARGET_DAILY_STAMP_HOUR,
        targetDailyStampLabel: TARGET_DAILY_STAMP_LABEL,
        lastUpdated: snapshot.timestamp,
        snapshots: upsertSnapshot(existing, snapshot),
    };

    saveHistory(history);

    console.log(`[voltr-share-stamp] Saved ${history.snapshots.length} snapshot(s) -> ${DATA_PATH}`);
    console.log(`[voltr-share-stamp] Share price: ${snapshot.sharePrice.toFixed(12)} USDC/share`);
    console.log(`[voltr-share-stamp] Diluted LP supply: ${snapshot.dilutedLpSupply.toFixed(9)}`);
    console.log(`[voltr-share-stamp] Captured at: ${snapshot.capturedAtPacific}`);
}

main().catch(error => {
    console.error(`[voltr-share-stamp] ${error.message}`);
    process.exit(1);
});
