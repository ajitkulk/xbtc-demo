// Bitcoin testnet operations for the XBTC demo: wallet generation, balance /
// UTXO / confirmation lookups against mempool.space, and building + signing +
// broadcasting real testnet transactions that carry an OP_RETURN payload.
//
// The mint deposit (merchant → Acme custodian) and burn disbursement
// (Acme → merchant) are genuine on-chain testnet transactions.

import * as bitcoin from "bitcoinjs-lib";
import { ECPairFactory } from "ecpair";
import * as ecc from "tiny-secp256k1";
import { BTC_API, BTC_NETWORK } from "./config.js";

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

// testnet3 and testnet4 share the same address parameters (bech32 "tb", …),
// so bitcoinjs-lib's `testnet` network works for both.
const NETWORK = bitcoin.networks.testnet;

// ── HTTP helpers against the mempool.space REST API ───────────────────
async function apiGet(path, { json = true } = {}) {
  const res = await fetch(`${BTC_API}${path}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`BTC API ${path} → ${res.status} ${res.statusText} ${body}`);
  }
  return json ? res.json() : res.text();
}

async function apiPost(path, body) {
  const res = await fetch(`${BTC_API}${path}`, { method: "POST", body });
  const text = await res.text();
  if (!res.ok) throw new Error(`BTC API POST ${path} → ${res.status}: ${text}`);
  return text;
}

// ── Wallet ────────────────────────────────────────────────────────────
/** Generate a fresh testnet P2WPKH (native segwit) wallet. */
export function generateWallet() {
  const keyPair = ECPair.makeRandom({ network: NETWORK });
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: keyPair.publicKey,
    network: NETWORK,
  });
  return { wif: keyPair.toWIF(), address };
}

function loadKeyPair(wif) {
  return ECPair.fromWIF(wif, NETWORK);
}

export function addressFromWif(wif) {
  const keyPair = loadKeyPair(wif);
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: keyPair.publicKey,
    network: NETWORK,
  });
  return address;
}

// ── Chain queries ─────────────────────────────────────────────────────
/** Confirmed spendable balance in sats for an address. */
export async function getBalanceSats(address) {
  const info = await apiGet(`/address/${address}`);
  const c = info.chain_stats;
  return c.funded_txo_sum - c.spent_txo_sum;
}

export async function getTipHeight() {
  return Number(await apiGet(`/blocks/tip/height`, { json: false }));
}

/** Confirmation count for a txid (0 if unconfirmed / unknown). */
export async function getConfirmations(txid) {
  try {
    const status = await apiGet(`/tx/${txid}/status`);
    if (!status.confirmed) return 0;
    const tip = await getTipHeight();
    return tip - status.block_height + 1;
  } catch {
    return 0;
  }
}

/**
 * Inspect a broadcast tx: confirmations, and the outputs that paid `toAddress`
 * plus any OP_RETURN payload. Used by Acme to independently verify a deposit.
 */
export async function inspectTx(txid) {
  const tx = await apiGet(`/tx/${txid}`);
  const tip = tx.status?.confirmed ? await getTipHeight() : null;
  const confirmations = tx.status?.confirmed
    ? tip - tx.status.block_height + 1
    : 0;

  let opReturnUtf8 = null;
  const paidTo = {};
  for (const vout of tx.vout) {
    if (vout.scriptpubkey_type === "op_return") {
      // Strip the OP_RETURN + pushdata opcodes, decode the payload as utf8.
      const asm = vout.scriptpubkey_asm || "";
      const parts = asm.split(" ");
      const dataHex = parts[parts.length - 1];
      if (dataHex && /^[0-9a-f]+$/i.test(dataHex)) {
        opReturnUtf8 = Buffer.from(dataHex, "hex").toString("utf8");
      }
    } else if (vout.scriptpubkey_address) {
      paidTo[vout.scriptpubkey_address] =
        (paidTo[vout.scriptpubkey_address] || 0) + vout.value;
    }
  }
  return { confirmations, opReturnUtf8, paidTo, confirmed: !!tx.status?.confirmed };
}

async function getFeeRate() {
  try {
    const fees = await apiGet(`/v1/fees/recommended`);
    return Math.max(1, Number(fees.halfHourFee || fees.hourFee || 1));
  } catch {
    return 2; // safe testnet fallback (sat/vB)
  }
}

// ── Send ──────────────────────────────────────────────────────────────
/**
 * Build, sign and broadcast a testnet P2WPKH payment carrying an OP_RETURN.
 * Selects confirmed UTXOs, sends `amountSats` to `toAddress`, embeds
 * `opReturnText` (≤80 bytes), and returns change to the sender.
 */
export async function sendWithOpReturn({ wif, toAddress, amountSats, opReturnText }) {
  const keyPair = loadKeyPair(wif);
  const fromAddress = addressFromWif(wif);
  const p2wpkh = bitcoin.payments.p2wpkh({
    pubkey: keyPair.publicKey,
    network: NETWORK,
  });

  const opReturnBuf = Buffer.from(opReturnText, "utf8");
  if (opReturnBuf.length > 80) {
    throw new Error(`OP_RETURN payload too long (${opReturnBuf.length} > 80 bytes)`);
  }

  const utxos = await apiGet(`/address/${fromAddress}/utxo`);
  const confirmed = utxos
    .filter((u) => u.status?.confirmed)
    .sort((a, b) => b.value - a.value);
  if (confirmed.length === 0) {
    throw new Error(
      `No confirmed UTXOs at ${fromAddress}. Fund it from the testnet faucet first.`,
    );
  }

  const feeRate = await getFeeRate();
  const psbt = new bitcoin.Psbt({ network: NETWORK });

  let inputTotal = 0;
  const selected = [];
  for (const u of confirmed) {
    selected.push(u);
    inputTotal += u.value;
    // Rough vsize estimate: 10 base + 68/input + ~31 per output (3 outputs).
    const estVsize = 10 + selected.length * 68 + 3 * 31;
    const estFee = Math.ceil(estVsize * feeRate);
    if (inputTotal >= amountSats + estFee + 294) break; // 294 = dust headroom
  }

  const estVsize = 10 + selected.length * 68 + 3 * 31;
  const fee = Math.ceil(estVsize * feeRate);
  if (inputTotal < amountSats + fee) {
    throw new Error(
      `Insufficient BTC: have ${inputTotal} sats, need ${amountSats}+${fee} fee at ${fromAddress}`,
    );
  }

  for (const u of selected) {
    psbt.addInput({
      hash: u.txid,
      index: u.vout,
      witnessUtxo: { script: p2wpkh.output, value: u.value },
    });
  }

  psbt.addOutput({ address: toAddress, value: amountSats });

  const embed = bitcoin.payments.embed({ data: [opReturnBuf] });
  psbt.addOutput({ script: embed.output, value: 0 });

  const change = inputTotal - amountSats - fee;
  if (change >= 294) psbt.addOutput({ address: fromAddress, value: change });

  const signer = {
    publicKey: keyPair.publicKey,
    sign: (hash) => Buffer.from(keyPair.sign(hash)),
  };
  selected.forEach((_, i) => psbt.signInput(i, signer));
  psbt.finalizeAllInputs();

  const txHex = psbt.extractTransaction().toHex();
  const txid = await apiPost(`/tx`, txHex);
  return { txid, feeSats: fee, network: BTC_NETWORK };
}
