// Central configuration for the XBTC demo. Everything overridable via env
// so the same code can point at testnet/devnet and testnet3/testnet4.

// ── XRPL ──────────────────────────────────────────────────────────────
export const XRPL_NETWORK =
  process.env.XRPL_NETWORK || "wss://s.altnet.rippletest.net:51233";
export const XRPL_EXPLORER =
  process.env.XRPL_EXPLORER || "https://testnet.xrpl.org";

// ── Bitcoin ───────────────────────────────────────────────────────────
// "mock" (default) simulates BTC testnet locally so the demo runs without a
// faucet; "real" broadcasts genuine testnet transactions via mempool.space.
// The two implementations share one interface (see btc.js) — the rest of the
// app is identical either way.
export const BTC_MODE = process.env.BTC_MODE || "mock";
// Starting balance handed to each wallet in mock mode (0.02 BTC).
export const MOCK_START_SATS = Number(process.env.MOCK_START_SATS ?? 2_000_000);

// "testnet4" (default, healthier faucets) or "testnet" (testnet3).
export const BTC_NETWORK = process.env.BTC_NETWORK || "testnet4";
// mempool.space REST base for the chosen network.
export const BTC_API =
  process.env.BTC_API || `https://mempool.space/${BTC_NETWORK}/api`;
export const BTC_EXPLORER =
  process.env.BTC_EXPLORER || `https://mempool.space/${BTC_NETWORK}`;
// A faucet the user can open to top up the demo's testnet BTC wallets.
export const BTC_FAUCET =
  process.env.BTC_FAUCET ||
  (BTC_NETWORK === "testnet4"
    ? "https://mempool.space/testnet4/faucet"
    : "https://coinfaucet.eu/en/btc-testnet/");

// Confirmations Acme requires on a BTC deposit before minting. The WBTC
// design specifies 3; kept low by default so the demo doesn't stall waiting
// on erratic testnet block times. Bump via MIN_CONFIRMATIONS for fidelity.
export const MIN_CONFIRMATIONS = Number(process.env.MIN_CONFIRMATIONS ?? 1);

// ── Token ─────────────────────────────────────────────────────────────
export const TOKEN = "XBTC";
export const ISSUER_NAME = "Acme Co";
// XBTC tracks BTC 1:1, so base units == satoshis (8 decimal places).
export const ASSET_SCALE = 8;

// Credential type labels (XLS-70). Stored on-chain as hex.
export const CRED = {
  MERCHANT_AUTH: "XBTCMerchantAuth",
  MINT_REQ: "XBTCMintReq",
  BURN_REQ: "XBTCBurnReq",
};

// Request credentials expire 72h after creation (XRPL-native Expiration).
export const REQUEST_EXPIRY_SECONDS = 72 * 60 * 60;
