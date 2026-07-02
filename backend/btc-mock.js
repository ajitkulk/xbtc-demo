// Mock Bitcoin testnet implementation. Mirrors the public interface of
// btc-helpers.js so it can be swapped in via btc.js (BTC_MODE=mock) — the
// demo then runs end-to-end without a faucet. Wallet generation stays real
// (genuine testnet-format keys/addresses); only the chain layer is simulated.
//
// The simulated ledger persists to data/btc-mock.json so it survives the
// `node --watch` restarts you get during development.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateWallet, addressFromWif } from "./btc-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = `${__dirname}/data/btc-mock.json`;
const MOCK_FEE_SATS = 200;

let ledger = null;

async function load() {
  if (ledger) return ledger;
  try {
    ledger = JSON.parse(await readFile(LEDGER_PATH, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    ledger = { balances: {}, txs: {} };
  }
  return ledger;
}

async function save() {
  await mkdir(dirname(LEDGER_PATH), { recursive: true });
  await writeFile(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

// Wallet helpers reuse the real (crypto) implementation.
export { generateWallet, addressFromWif };

export async function getBalanceSats(address) {
  const l = await load();
  return l.balances[address] || 0;
}

export async function getTipHeight() {
  // A plausible, monotonically-increasing stand-in.
  return 3_000_000 + Math.floor(Date.now() / 600_000);
}

export async function getConfirmations(txid) {
  const l = await load();
  const tx = l.txs[txid];
  if (!tx) return 0;
  // Confirmed immediately (1), then a slow ramp so a higher MIN_CONFIRMATIONS
  // still exercises the "n/N confirmations" UI without a real wait.
  return Math.min(6, 1 + Math.floor((Date.now() - tx.at) / 2000));
}

export async function inspectTx(txid) {
  const l = await load();
  const tx = l.txs[txid];
  if (!tx) return { confirmations: 0, opReturnUtf8: null, paidTo: {}, confirmed: false };
  const confirmations = await getConfirmations(txid);
  return {
    confirmations,
    opReturnUtf8: tx.opReturn ?? null,
    paidTo: tx.paidTo || {},
    confirmed: confirmations > 0,
  };
}

/** Credit a demo wallet (stands in for the faucet). */
export async function fundAddress(address, sats) {
  const l = await load();
  l.balances[address] = (l.balances[address] || 0) + sats;
  await save();
  return l.balances[address];
}

export async function sendWithOpReturn({ wif, toAddress, amountSats, opReturnText }) {
  const l = await load();
  const fromAddress = addressFromWif(wif);
  const have = l.balances[fromAddress] || 0;
  if (have < amountSats + MOCK_FEE_SATS) {
    throw new Error(
      `Insufficient (mock) BTC: have ${have} sats, need ${amountSats}+${MOCK_FEE_SATS} at ${fromAddress}`,
    );
  }
  if (Buffer.from(opReturnText, "utf8").length > 80) {
    throw new Error("OP_RETURN payload too long (> 80 bytes)");
  }

  const txid = randomBytes(32).toString("hex");
  l.balances[fromAddress] = have - amountSats - MOCK_FEE_SATS;
  l.balances[toAddress] = (l.balances[toAddress] || 0) + amountSats;
  l.txs[txid] = {
    paidTo: { [toAddress]: amountSats },
    opReturn: opReturnText,
    at: Date.now(),
  };
  await save();
  return { txid, feeSats: MOCK_FEE_SATS, network: "mock" };
}

/** Wipe the simulated ledger (called from /api/reset). */
export async function reset() {
  ledger = { balances: {}, txs: {} };
  await save();
}
