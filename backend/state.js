import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { XRPL_NETWORK, BTC_NETWORK } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = `${__dirname}/data/state.json`;

const DEFAULT_STATE = {
  xrplNetwork: XRPL_NETWORK,
  btcNetwork: BTC_NETWORK,

  // Acme Co — XBTC issuer + BTC custodian. Merchant — holder + BTC counterparty.
  acme: { wallet: null, btc: null },
  merchant: { wallet: null, btc: null },

  // The XBTC MPT issuance (workflow A1).
  issuance: null,

  // Workflow A — merchant authorization progress.
  auth: {
    depositAuth: false,
    merchantOptIn: false,
    merchantAuthorized: false,
    credentialIssued: false,
    credentialAccepted: false,
    depositPreauth: false,
    txs: {},
  },

  // Workflow B — one active mint at a time, plus completed history.
  mint: { active: null, history: [] },
  // Workflow C — one active burn at a time, plus completed history.
  burn: { active: null, history: [] },

  // Anti-double-spend records (WBTC design defences).
  dedup: {}, // btcTxid -> mintPaymentTxHash
  disbursed: {}, // burnPaymentTxHash -> btc disbursement txid

  log: [],
};

let cache = null;

export async function getState() {
  if (cache) return cache;
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    cache = { ...structuredClone(DEFAULT_STATE), ...JSON.parse(raw) };
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    cache = structuredClone(DEFAULT_STATE);
  }
  return cache;
}

export async function saveState(next) {
  cache = next;
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(next, null, 2));
}

export async function updateState(mutator) {
  const s = await getState();
  await mutator(s);
  await saveState(s);
  return s;
}

export async function resetState() {
  cache = structuredClone(DEFAULT_STATE);
  await saveState(cache);
  return cache;
}

export function pushLog(state, entry) {
  state.log.unshift({ at: new Date().toISOString(), ...entry });
  if (state.log.length > 200) state.log.length = 200;
}
