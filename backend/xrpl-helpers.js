// XRPL testnet operations for the XBTC demo: MPT issuance (XLS-33d),
// holder authorization, XLS-70 credentials (create / accept / delete),
// credential-gated DepositPreauth, and MPT payments (mint + burn).

import {
  Client,
  Wallet,
  convertStringToHex,
  unixTimeToRippleTime,
} from "xrpl";
import { XRPL_NETWORK } from "./config.js";

// AccountSet flags
const ASF_DEPOSIT_AUTH = 9;

// MPTokenIssuanceCreate flags
export const MPT_FLAGS = {
  CAN_LOCK: 0x0002,
  REQUIRE_AUTH: 0x0004,
  CAN_ESCROW: 0x0008,
  CAN_TRADE: 0x0010,
  CAN_TRANSFER: 0x0020,
  CAN_CLAWBACK: 0x0040,
};

let _client;

export async function getClient() {
  if (_client && _client.isConnected()) return _client;
  _client = new Client(XRPL_NETWORK);
  await _client.connect();
  return _client;
}

export async function disconnect() {
  if (_client && _client.isConnected()) await _client.disconnect();
  _client = null;
}

export function credentialTypeHex(label) {
  return convertStringToHex(label).toUpperCase();
}

/** Fund a new testnet wallet via the faucet, or reuse/refund a saved seed. */
export async function fundOrLoadWallet(savedSeed) {
  const client = await getClient();
  if (savedSeed) {
    const wallet = Wallet.fromSeed(savedSeed);
    try {
      await client.request({
        command: "account_info",
        account: wallet.address,
        ledger_index: "validated",
      });
      return wallet;
    } catch (err) {
      if (err?.data?.error !== "actNotFound") throw err;
      const { wallet: funded } = await client.fundWallet(wallet);
      return funded;
    }
  }
  const { wallet } = await client.fundWallet();
  return wallet;
}

/** Submit a transaction and assert tesSUCCESS. */
export async function submit(wallet, tx, { description } = {}) {
  const client = await getClient();
  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);
  const code = result.result.meta?.TransactionResult;
  if (code !== "tesSUCCESS") {
    const err = new Error(`${description || tx.TransactionType} failed: ${code}`);
    err.result = result.result;
    throw err;
  }
  return result.result;
}

// ── Account setup ─────────────────────────────────────────────────────
/** Require inbound payments to be preauthorized (asfDepositAuth). Idempotent. */
export async function enableDepositAuth(wallet) {
  return submit(
    wallet,
    { TransactionType: "AccountSet", Account: wallet.address, SetFlag: ASF_DEPOSIT_AUTH },
    { description: "AccountSet asfDepositAuth" },
  );
}

// ── MPT (XLS-33d) ─────────────────────────────────────────────────────
export async function createMptIssuance(issuerWallet, { assetScale, flags, metadata }) {
  const tx = {
    TransactionType: "MPTokenIssuanceCreate",
    Account: issuerWallet.address,
    AssetScale: assetScale,
    Flags: flags,
  };
  if (metadata) tx.MPTokenMetadata = convertStringToHex(JSON.stringify(metadata));
  const result = await submit(issuerWallet, tx, {
    description: "MPTokenIssuanceCreate XBTC",
  });
  return { result, issuanceId: result.meta?.mpt_issuance_id };
}

/** Holder opt-in to hold an MPT (step 1 of authorization). */
export async function mptOptIn(holderWallet, issuanceId) {
  return submit(
    holderWallet,
    {
      TransactionType: "MPTokenAuthorize",
      Account: holderWallet.address,
      MPTokenIssuanceID: issuanceId,
    },
    { description: "MPTokenAuthorize (holder opt-in)" },
  );
}

/** Issuer authorizes a specific holder (step 2 — the KYC gate). */
export async function mptAuthorizeHolder(issuerWallet, issuanceId, holderAddress) {
  return submit(
    issuerWallet,
    {
      TransactionType: "MPTokenAuthorize",
      Account: issuerWallet.address,
      MPTokenIssuanceID: issuanceId,
      Holder: holderAddress,
    },
    { description: "MPTokenAuthorize (issuer approves holder)" },
  );
}

/**
 * Send an MPT amount. Mint = issuer→holder; burn = holder→issuer.
 * `credentialIds` (ledger object IDs) authorize the payment when the
 * destination has DepositAuth + credential-gated DepositPreauth.
 */
export async function sendMpt(wallet, destination, issuanceId, value, memos, credentialIds) {
  const tx = {
    TransactionType: "Payment",
    Account: wallet.address,
    Destination: destination,
    Amount: { mpt_issuance_id: issuanceId, value: String(value) },
  };
  if (memos?.length) {
    tx.Memos = memos.map((m) => ({
      Memo: { MemoData: convertStringToHex(m).toUpperCase() },
    }));
  }
  if (credentialIds?.length) tx.CredentialIDs = credentialIds;
  return submit(wallet, tx, { description: `Payment ${value} XBTC → ${destination}` });
}

// ── Credentials (XLS-70) ──────────────────────────────────────────────
/**
 * Issue a credential. `data` (an object) is JSON-encoded into the URI field
 * as the on-chain URIData payload. `expirySeconds` sets the native Expiration.
 */
export async function createCredential(
  issuerWallet,
  subjectAddress,
  label,
  { data, expirySeconds } = {},
) {
  const tx = {
    TransactionType: "CredentialCreate",
    Account: issuerWallet.address,
    Subject: subjectAddress,
    CredentialType: credentialTypeHex(label),
  };
  if (data) tx.URI = convertStringToHex(JSON.stringify(data)).toUpperCase();
  if (expirySeconds) {
    tx.Expiration = unixTimeToRippleTime(Date.now() + expirySeconds * 1000);
  }
  return submit(issuerWallet, tx, {
    description: `CredentialCreate ${label} for ${subjectAddress}`,
  });
}

export async function acceptCredential(subjectWallet, issuerAddress, label) {
  return submit(
    subjectWallet,
    {
      TransactionType: "CredentialAccept",
      Account: subjectWallet.address,
      Issuer: issuerAddress,
      CredentialType: credentialTypeHex(label),
    },
    { description: `CredentialAccept ${label} from ${issuerAddress}` },
  );
}

/** Delete a credential. Callable by either the issuer or the subject. */
export async function deleteCredential(wallet, { issuer, subject, label }) {
  const tx = {
    TransactionType: "CredentialDelete",
    Account: wallet.address,
    Subject: subject,
    Issuer: issuer,
    CredentialType: credentialTypeHex(label),
  };
  return submit(wallet, tx, { description: `CredentialDelete ${label}` });
}

/** Credential-gated DepositPreauth: accept payments from holders of a credential. */
export async function depositPreauthByCredential(wallet, { issuer, label }) {
  return submit(
    wallet,
    {
      TransactionType: "DepositPreauth",
      Account: wallet.address,
      AuthorizeCredentials: [
        { Credential: { Issuer: issuer, CredentialType: credentialTypeHex(label) } },
      ],
    },
    { description: `DepositPreauth (credential ${label})` },
  );
}

// ── Queries ───────────────────────────────────────────────────────────
export async function getAccountInfo(address) {
  const client = await getClient();
  try {
    const res = await client.request({
      command: "account_info",
      account: address,
      ledger_index: "validated",
    });
    return res.result.account_data;
  } catch (err) {
    if (err?.data?.error === "actNotFound") return null;
    throw err;
  }
}

async function accountObjects(address, type) {
  const client = await getClient();
  const res = await client.request({
    command: "account_objects",
    account: address,
    type,
    ledger_index: "validated",
  });
  return res.result.account_objects;
}

/** MPT balances held by an address (base units). */
export async function getMptHoldings(address) {
  const objs = await accountObjects(address, "mptoken");
  return objs.map((o) => ({
    issuanceId: o.MPTokenIssuanceID,
    amount: o.MPTAmount ?? "0",
  }));
}

/** MPT issuances created by an address (returns outstanding supply). */
export async function getMptIssuances(address) {
  const objs = await accountObjects(address, "mpt_issuance");
  return objs.map((o) => ({
    issuanceId: o.mpt_issuance_id || o.index,
    outstanding: o.OutstandingAmount ?? "0",
    assetScale: o.AssetScale,
  }));
}

/** Credential ledger objects on an account (issued to or held by it). */
export async function getCredentials(address) {
  const objs = await accountObjects(address, "credential");
  return objs.map((o) => ({
    id: o.index, // ledger object ID (for CredentialIDs on payments)
    issuer: o.Issuer,
    subject: o.Subject,
    type: decodeHex(o.CredentialType),
    accepted: !!(o.Flags & 0x00010000), // lsfAccepted
    expiration: o.Expiration ?? null,
  }));
}

function decodeHex(hex) {
  if (!hex) return hex;
  try {
    return Buffer.from(hex, "hex").toString("utf8").replace(/\0+$/, "");
  } catch {
    return hex;
  }
}
