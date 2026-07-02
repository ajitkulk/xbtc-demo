import express from "express";
import cors from "cors";
import {
  TOKEN,
  ISSUER_NAME,
  ASSET_SCALE,
  CRED,
  REQUEST_EXPIRY_SECONDS,
  MIN_CONFIRMATIONS,
  BTC_NETWORK,
  BTC_MODE,
  MOCK_START_SATS,
} from "./config.js";
import { getState, saveState, resetState, pushLog } from "./state.js";
import {
  fundOrLoadWallet,
  disconnect,
  enableDepositAuth,
  createMptIssuance,
  mptOptIn,
  mptAuthorizeHolder,
  sendMpt,
  createCredential,
  acceptCredential,
  deleteCredential,
  depositPreauthByCredential,
  getAccountInfo,
  getMptHoldings,
  getMptIssuances,
  getCredentials,
  MPT_FLAGS,
} from "./xrpl-helpers.js";
import {
  generateWallet,
  addressFromWif,
  getBalanceSats,
  getConfirmations,
  inspectTx,
  sendWithOpReturn,
  fundAddress,
  resetBtc,
} from "./btc.js";

const PORT = process.env.PORT || 4100;

const app = express();
app.use(cors());
app.use(express.json());

function wrap(handler) {
  return async (req, res) => {
    try {
      const data = await handler(req, res);
      if (!res.headersSent) res.json(data ?? { ok: true });
    } catch (err) {
      console.error("[error]", err);
      const state = await getState();
      pushLog(state, {
        level: "error",
        message: err.message,
        engine_result: err.result?.meta?.TransactionResult,
      });
      await saveState(state);
      res.status(500).json({
        error: err.message,
        engine_result: err.result?.meta?.TransactionResult,
      });
    }
  };
}

function summarizeTx(txResult, kind) {
  return {
    kind,
    hash: txResult.hash,
    ledger_index: txResult.ledger_index,
    engine_result: txResult.meta?.TransactionResult,
  };
}

function ensureWallet(role, state) {
  const seed = state[role]?.wallet?.seed;
  if (!seed) throw new Error(`${role} has no XRPL wallet yet — run /api/setup first`);
  return state[role].wallet;
}

function ensureBtc(role, state) {
  const btc = state[role]?.btc;
  if (!btc?.wif) throw new Error(`${role} has no BTC wallet yet — run /api/setup first`);
  return btc;
}

function issuanceId(state) {
  if (!state.issuance?.issuanceId) throw new Error(`${TOKEN} not issued yet (workflow A1)`);
  return state.issuance.issuanceId;
}

/**
 * Assert the merchant holds an accepted XBTCMerchantAuth from Acme, and return
 * the credential (its `id` is needed as CredentialIDs on burn payments).
 */
async function assertMerchantAuthorized(state) {
  const acme = state.acme.wallet.address;
  const merchant = state.merchant.wallet.address;
  const creds = await getCredentials(merchant);
  const auth = creds.find(
    (c) => c.issuer === acme && c.subject === merchant && c.type === CRED.MERCHANT_AUTH,
  );
  if (!auth) throw new Error("Access denied: merchant does not hold XBTCMerchantAuth");
  if (!auth.accepted) throw new Error("XBTCMerchantAuth not yet accepted by merchant");
  return auth;
}

// ══════════════════════════════════════════════════════════════════════
// State / setup
// ══════════════════════════════════════════════════════════════════════

app.get(
  "/api/state",
  wrap(async () => {
    const state = await getState();
    const balances = {};
    for (const role of ["acme", "merchant"]) {
      const w = state[role]?.wallet;
      if (!w) continue;
      balances[role] = { xrpDrops: null, mpt: [], btcSats: null };
      try {
        const info = await getAccountInfo(w.address);
        balances[role].xrpDrops = info?.Balance ?? null;
        balances[role].mpt = await getMptHoldings(w.address);
      } catch {
        /* tolerate transient rippled errors */
      }
      try {
        if (state[role].btc?.address) {
          balances[role].btcSats = await getBalanceSats(state[role].btc.address);
        }
      } catch {
        /* tolerate transient mempool.space errors */
      }
    }

    // Outstanding XBTC supply from the issuance object.
    let outstanding = null;
    try {
      if (state.issuance?.issuanceId && state.acme.wallet) {
        const issuances = await getMptIssuances(state.acme.wallet.address);
        outstanding =
          issuances.find((i) => i.issuanceId === state.issuance.issuanceId)?.outstanding ??
          null;
      }
    } catch {
      /* tolerate */
    }

    // Live BTC confirmation count for an in-flight mint deposit.
    if (state.mint.active?.btcTxid && !state.mint.active.minted) {
      try {
        state.mint.active.btcConfirmations = await getConfirmations(
          state.mint.active.btcTxid,
        );
        await saveState(state);
      } catch {
        /* tolerate */
      }
    }

    return {
      ...state,
      balances,
      outstanding,
      minConfirmations: MIN_CONFIRMATIONS,
      btcMode: BTC_MODE,
    };
  }),
);

app.post(
  "/api/setup",
  wrap(async () => {
    const state = await getState();
    pushLog(state, { level: "info", message: "Funding XRPL wallets via testnet faucet…" });
    await saveState(state);

    for (const role of ["acme", "merchant"]) {
      const wallet = await fundOrLoadWallet(state[role].wallet?.seed);
      state[role].wallet = {
        address: wallet.address,
        seed: wallet.seed,
        publicKey: wallet.publicKey,
      };
      // Generate a BTC testnet wallet once; keep it stable across re-setups.
      if (!state[role].btc?.wif) {
        state[role].btc = generateWallet();
      } else {
        state[role].btc.address = addressFromWif(state[role].btc.wif);
      }
      // In mock mode, seed starting BTC so no faucet is needed.
      if (BTC_MODE !== "real" && (await getBalanceSats(state[role].btc.address)) === 0) {
        await fundAddress(state[role].btc.address, MOCK_START_SATS);
      }
      pushLog(state, {
        level: "info",
        message: `${role} funded — XRPL ${wallet.address}, BTC ${state[role].btc.address}`,
      });
      await saveState(state);
    }
    return state;
  }),
);

// Top up a wallet's simulated BTC balance (mock mode's stand-in for a faucet).
app.post(
  "/api/btc/fund",
  wrap(async (req) => {
    const state = await getState();
    const role = req.body?.role;
    if (!["acme", "merchant"].includes(role)) throw new Error("role must be acme or merchant");
    const btc = ensureBtc(role, state);
    const sats = Number(req.body?.sats ?? MOCK_START_SATS);
    const balance = await fundAddress(btc.address, sats);
    pushLog(state, {
      level: "info",
      message: `Funded ${role} BTC wallet with ${sats} sats (mock) — balance ${balance}`,
    });
    await saveState(state);
    return state;
  }),
);

app.post(
  "/api/reset",
  wrap(async () => {
    await resetState();
    await resetBtc();
    return { ok: true };
  }),
);

// ══════════════════════════════════════════════════════════════════════
// Workflow A — Merchant authorization
// ══════════════════════════════════════════════════════════════════════

// A1 — Acme creates the XBTC MPT issuance and locks down inbound payments.
app.post(
  "/api/issuer/create-xbtc",
  wrap(async () => {
    const state = await getState();
    const acmeRec = ensureWallet("acme", state);
    const acme = await fundOrLoadWallet(acmeRec.seed);

    if (!state.issuance) {
      const flags =
        MPT_FLAGS.REQUIRE_AUTH |
        MPT_FLAGS.CAN_TRANSFER |
        MPT_FLAGS.CAN_CLAWBACK |
        MPT_FLAGS.CAN_LOCK;
      const { result, issuanceId: id } = await createMptIssuance(acme, {
        assetScale: ASSET_SCALE,
        flags,
        metadata: { t: TOKEN, n: `${TOKEN} (BTC-backed)`, in: ISSUER_NAME, ac: "rwa" },
      });
      state.issuance = {
        issuanceId: id,
        assetScale: ASSET_SCALE,
        flags,
        tx: summarizeTx(result, "MPTokenIssuanceCreate"),
      };
      pushLog(state, {
        level: "tx",
        message: `Acme created ${TOKEN} MPT issuance ${id?.slice(0, 12)}… (RequireAuth on)`,
      });
    }

    // DepositAuth so only credential-preauthorized accounts can pay Acme (burns).
    await enableDepositAuth(acme);
    state.auth.depositAuth = true;
    pushLog(state, { level: "tx", message: "Acme enabled DepositAuth on issuer account" });

    await saveState(state);
    return state;
  }),
);

// A2 — Merchant opts in to hold XBTC.
app.post(
  "/api/merchant/optin",
  wrap(async () => {
    const state = await getState();
    const merchantRec = ensureWallet("merchant", state);
    const merchant = await fundOrLoadWallet(merchantRec.seed);

    const result = await mptOptIn(merchant, issuanceId(state));
    state.auth.merchantOptIn = true;
    state.auth.txs.optIn = summarizeTx(result, "MPTokenAuthorize (opt-in)");
    pushLog(state, { level: "tx", message: `Merchant opted in to hold ${TOKEN}` });
    await saveState(state);
    return state;
  }),
);

// A3 — Acme authorizes the merchant as a holder (KYC gate).
app.post(
  "/api/issuer/authorize-merchant",
  wrap(async () => {
    const state = await getState();
    const acmeRec = ensureWallet("acme", state);
    const merchantRec = ensureWallet("merchant", state);
    const acme = await fundOrLoadWallet(acmeRec.seed);

    const result = await mptAuthorizeHolder(acme, issuanceId(state), merchantRec.address);
    state.auth.merchantAuthorized = true;
    state.auth.txs.authorizeHolder = summarizeTx(result, "MPTokenAuthorize (issuer)");
    pushLog(state, { level: "tx", message: `Acme authorized merchant to hold ${TOKEN}` });
    await saveState(state);
    return state;
  }),
);

// A4 — Acme issues the one-time XBTCMerchantAuth credential.
app.post(
  "/api/issuer/issue-merchant-auth",
  wrap(async () => {
    const state = await getState();
    const acmeRec = ensureWallet("acme", state);
    const merchantRec = ensureWallet("merchant", state);
    const acme = await fundOrLoadWallet(acmeRec.seed);

    try {
      const result = await createCredential(acme, merchantRec.address, CRED.MERCHANT_AUTH, {
        data: {
          merchantId: "MERCHANT-0001",
          agreementRef: "MSA-2026-XBTC",
          issued: new Date().toISOString(),
        },
      });
      state.auth.txs.merchantAuth = summarizeTx(result, "CredentialCreate");
      pushLog(state, {
        level: "tx",
        message: `Acme issued ${CRED.MERCHANT_AUTH} to merchant`,
      });
    } catch (err) {
      if (err.result?.meta?.TransactionResult !== "tecDUPLICATE") throw err;
      pushLog(state, {
        level: "info",
        message: `${CRED.MERCHANT_AUTH} already on-chain — skipped`,
      });
    }
    state.auth.credentialIssued = true;
    await saveState(state);
    return state;
  }),
);

// A5 — Merchant accepts XBTCMerchantAuth.
app.post(
  "/api/merchant/accept-auth",
  wrap(async () => {
    const state = await getState();
    const merchantRec = ensureWallet("merchant", state);
    const acmeRec = ensureWallet("acme", state);
    const merchant = await fundOrLoadWallet(merchantRec.seed);

    try {
      const result = await acceptCredential(merchant, acmeRec.address, CRED.MERCHANT_AUTH);
      state.auth.txs.acceptAuth = summarizeTx(result, "CredentialAccept");
      pushLog(state, {
        level: "tx",
        message: `Merchant accepted ${CRED.MERCHANT_AUTH} — authorization now on-chain`,
      });
    } catch (err) {
      if (err.result?.meta?.TransactionResult !== "tecDUPLICATE") throw err;
      pushLog(state, { level: "info", message: `${CRED.MERCHANT_AUTH} already accepted` });
    }
    state.auth.credentialAccepted = true;
    await saveState(state);
    return state;
  }),
);

// A6 — Acme sets credential-gated DepositPreauth (accepts burns from any auth holder).
app.post(
  "/api/issuer/deposit-preauth",
  wrap(async () => {
    const state = await getState();
    const acmeRec = ensureWallet("acme", state);
    const acme = await fundOrLoadWallet(acmeRec.seed);

    try {
      const result = await depositPreauthByCredential(acme, {
        issuer: acmeRec.address,
        label: CRED.MERCHANT_AUTH,
      });
      state.auth.txs.depositPreauth = summarizeTx(result, "DepositPreauth");
      pushLog(state, {
        level: "tx",
        message: `Acme set credential DepositPreauth for ${CRED.MERCHANT_AUTH} holders`,
      });
    } catch (err) {
      if (err.result?.meta?.TransactionResult !== "tecDUPLICATE") throw err;
      pushLog(state, { level: "info", message: "DepositPreauth already set — skipped" });
    }
    state.auth.depositPreauth = true;
    await saveState(state);
    return state;
  }),
);

// ══════════════════════════════════════════════════════════════════════
// Workflow B — Mint XBTC
// ══════════════════════════════════════════════════════════════════════

// B1 — Merchant sends real BTC to Acme's custodian, OP_RETURN = XRPL dest.
app.post(
  "/api/merchant/btc-deposit",
  wrap(async (req) => {
    const state = await getState();
    const merchantRec = ensureWallet("merchant", state);
    const merchantBtc = ensureBtc("merchant", state);
    const acmeBtc = ensureBtc("acme", state);
    if (state.mint.active && !state.mint.active.deleted) {
      throw new Error("A mint is already in progress — finish or delete it first");
    }

    const amountSats = Number(req.body?.amountSats ?? 10000);
    const xrplDestAddress = merchantRec.address; // where XBTC will be minted

    pushLog(state, {
      level: "info",
      message: `Merchant broadcasting ${amountSats} sat BTC deposit to Acme custodian…`,
    });
    await saveState(state);

    const { txid, feeSats } = await sendWithOpReturn({
      wif: merchantBtc.wif,
      toAddress: acmeBtc.address,
      amountSats,
      opReturnText: xrplDestAddress,
    });

    state.mint.active = {
      amountSats,
      xrplDestAddress,
      btcTxid: txid,
      btcFeeSats: feeSats,
      btcConfirmations: 0,
      startedAt: new Date().toISOString(),
      minted: false,
      accepted: false,
      deleted: false,
    };
    pushLog(state, {
      level: "tx",
      message: `BTC deposit broadcast: ${txid} (OP_RETURN → ${xrplDestAddress})`,
    });
    await saveState(state);
    return state;
  }),
);

// B2 — Merchant issues XBTCMintReq to Acme.
app.post(
  "/api/merchant/create-mint-req",
  wrap(async () => {
    const state = await getState();
    const merchantRec = ensureWallet("merchant", state);
    const acmeRec = ensureWallet("acme", state);
    const merchant = await fundOrLoadWallet(merchantRec.seed);
    const active = state.mint.active;
    if (!active?.btcTxid) throw new Error("Broadcast the BTC deposit first (B1)");

    const result = await createCredential(merchant, acmeRec.address, CRED.MINT_REQ, {
      // Compact keys: the credential URI is capped at 256 hex chars (128 bytes)
      // and the 64-char btcTxid dominates the budget. tx=btcTxid, a=amountSats,
      // d=xrplDestAddress.
      data: { tx: active.btcTxid, a: active.amountSats, d: active.xrplDestAddress },
      expirySeconds: REQUEST_EXPIRY_SECONDS,
    });
    active.mintReqTxHash = result.hash;
    active.mintReqExpiresAt = new Date(
      Date.now() + REQUEST_EXPIRY_SECONDS * 1000,
    ).toISOString();
    pushLog(state, {
      level: "tx",
      message: `Merchant created ${CRED.MINT_REQ} (72h expiry) → Acme`,
    });
    await saveState(state);
    return state;
  }),
);

// B4+B6 — Acme validates the deposit, mints XBTC, then accepts the credential.
app.post(
  "/api/issuer/process-mint",
  wrap(async () => {
    const state = await getState();
    const acmeRec = ensureWallet("acme", state);
    const merchantRec = ensureWallet("merchant", state);
    const acmeBtc = ensureBtc("acme", state);
    const acme = await fundOrLoadWallet(acmeRec.seed);
    const active = state.mint.active;
    if (!active?.mintReqTxHash) throw new Error("No XBTCMintReq to process (B2)");
    if (active.minted) throw new Error("This mint request was already processed");

    // Acme's validation gauntlet (WBTC design checks a–f).
    await assertMerchantAuthorized(state); // (a)
    if (state.dedup[active.btcTxid]) {
      throw new Error(`(d) btcTxid ${active.btcTxid} already minted — rejected`); // (d)
    }
    if (active.mintReqExpiresAt && Date.now() > Date.parse(active.mintReqExpiresAt)) {
      throw new Error("(e) XBTCMintReq expired — merchant must delete and recreate"); // (e)
    }
    const info = await inspectTx(active.btcTxid);
    if (info.confirmations < MIN_CONFIRMATIONS) {
      throw new Error(
        `(b) BTC deposit has ${info.confirmations} confirmations, need ${MIN_CONFIRMATIONS}`,
      ); // (b)
    }
    const paid = info.paidTo[acmeBtc.address] || 0;
    if (paid !== active.amountSats) {
      throw new Error(`(c) BTC amount mismatch: paid ${paid}, expected ${active.amountSats}`); // (c)
    }
    if (info.opReturnUtf8 !== active.xrplDestAddress) {
      throw new Error(
        `(f) OP_RETURN mismatch: ${info.opReturnUtf8} ≠ ${active.xrplDestAddress}`,
      ); // (f)
    }
    pushLog(state, {
      level: "info",
      message: `Acme validated deposit: ${info.confirmations} confs, ${paid} sats, OP_RETURN ok`,
    });

    // Mint XBTC to the merchant, memo linking to the mint request.
    const mint = await sendMpt(
      acme,
      merchantRec.address,
      issuanceId(state),
      active.amountSats,
      [JSON.stringify({ mintReqTxHash: active.mintReqTxHash })],
    );
    active.minted = true;
    active.mintPaymentTxHash = mint.hash;
    state.dedup[active.btcTxid] = mint.hash;
    pushLog(state, {
      level: "tx",
      message: `Acme minted ${active.amountSats} ${TOKEN} to merchant (${mint.hash.slice(0, 12)}…)`,
    });
    await saveState(state);

    // Accept the mint request — permanent on-chain settlement record.
    const accept = await acceptCredential(acme, merchantRec.address, CRED.MINT_REQ);
    active.accepted = true;
    active.acceptTxHash = accept.hash;
    pushLog(state, {
      level: "tx",
      message: `Acme accepted ${CRED.MINT_REQ} — mint settled on-chain`,
    });
    await saveState(state);
    return state;
  }),
);

// B7 — Merchant deletes the settled XBTCMintReq for ledger hygiene.
app.post(
  "/api/merchant/delete-mint-req",
  wrap(async () => {
    const state = await getState();
    const merchantRec = ensureWallet("merchant", state);
    const acmeRec = ensureWallet("acme", state);
    const merchant = await fundOrLoadWallet(merchantRec.seed);
    const active = state.mint.active;
    if (!active?.accepted) throw new Error("Acme must accept the mint request first");

    const result = await deleteCredential(merchant, {
      issuer: merchantRec.address,
      subject: acmeRec.address,
      label: CRED.MINT_REQ,
    });
    active.deleted = true;
    active.deleteTxHash = result.hash;
    pushLog(state, { level: "tx", message: `Merchant deleted ${CRED.MINT_REQ} — ledger clean` });

    state.mint.history.unshift(active);
    state.mint.active = null;
    await saveState(state);
    return state;
  }),
);

// ══════════════════════════════════════════════════════════════════════
// Workflow C — Burn XBTC
// ══════════════════════════════════════════════════════════════════════

// C1 — Merchant issues XBTCBurnReq to Acme.
app.post(
  "/api/merchant/create-burn-req",
  wrap(async (req) => {
    const state = await getState();
    const merchantRec = ensureWallet("merchant", state);
    const acmeRec = ensureWallet("acme", state);
    const merchantBtc = ensureBtc("merchant", state);
    const merchant = await fundOrLoadWallet(merchantRec.seed);
    if (state.burn.active && !state.burn.active.deleted) {
      throw new Error("A burn is already in progress — finish or delete it first");
    }

    const amountSats = Number(req.body?.amountSats ?? 5000);
    const btcWithdrawalAddress = req.body?.btcWithdrawalAddress || merchantBtc.address;

    const result = await createCredential(merchant, acmeRec.address, CRED.BURN_REQ, {
      // Compact keys to stay within the 256-hex-char URI cap. a=amountSats,
      // d=btcWithdrawalAddress.
      data: { a: amountSats, d: btcWithdrawalAddress },
      expirySeconds: REQUEST_EXPIRY_SECONDS,
    });
    state.burn.active = {
      amountSats,
      btcWithdrawalAddress,
      burnReqTxHash: result.hash,
      burnReqExpiresAt: new Date(Date.now() + REQUEST_EXPIRY_SECONDS * 1000).toISOString(),
      startedAt: new Date().toISOString(),
      accepted: false,
      burned: false,
      disbursed: false,
      deleted: false,
    };
    pushLog(state, {
      level: "tx",
      message: `Merchant created ${CRED.BURN_REQ} (${amountSats} sats → ${btcWithdrawalAddress})`,
    });
    await saveState(state);
    return state;
  }),
);

// C2 — Acme validates authorization and accepts the burn request.
app.post(
  "/api/issuer/accept-burn-req",
  wrap(async () => {
    const state = await getState();
    const acmeRec = ensureWallet("acme", state);
    const merchantRec = ensureWallet("merchant", state);
    const acme = await fundOrLoadWallet(acmeRec.seed);
    const active = state.burn.active;
    if (!active?.burnReqTxHash) throw new Error("No XBTCBurnReq to accept (C1)");

    await assertMerchantAuthorized(state);
    const result = await acceptCredential(acme, merchantRec.address, CRED.BURN_REQ);
    active.accepted = true;
    active.acceptTxHash = result.hash;
    pushLog(state, {
      level: "tx",
      message: `Acme accepted ${CRED.BURN_REQ} — burn acknowledged`,
    });
    await saveState(state);
    return state;
  }),
);

// C3 — Merchant burns XBTC by paying it back to the issuer.
app.post(
  "/api/merchant/burn-payment",
  wrap(async () => {
    const state = await getState();
    const merchantRec = ensureWallet("merchant", state);
    const acmeRec = ensureWallet("acme", state);
    const merchant = await fundOrLoadWallet(merchantRec.seed);
    const active = state.burn.active;
    if (!active?.accepted) throw new Error("Acme must accept the burn request first (C2)");

    // Acme's issuer account has DepositAuth + credential DepositPreauth, so the
    // burn payment must present the merchant's XBTCMerchantAuth credential.
    const auth = await assertMerchantAuthorized(state);

    const result = await sendMpt(
      merchant,
      acmeRec.address,
      issuanceId(state),
      active.amountSats,
      [
        JSON.stringify({
          burnReqTxHash: active.burnReqTxHash,
          btcWithdrawalAddress: active.btcWithdrawalAddress,
        }),
      ],
      auth.id ? [auth.id] : undefined,
    );
    active.burned = true;
    active.burnPaymentTxHash = result.hash;
    pushLog(state, {
      level: "tx",
      message: `Merchant burned ${active.amountSats} ${TOKEN} → issuer (${result.hash.slice(0, 12)}…)`,
    });
    await saveState(state);
    return state;
  }),
);

// C4 — Acme disburses real BTC to the merchant, OP_RETURN = burn payment hash.
app.post(
  "/api/issuer/disburse-btc",
  wrap(async () => {
    const state = await getState();
    ensureWallet("acme", state);
    const acmeBtc = ensureBtc("acme", state);
    const active = state.burn.active;
    if (!active?.burned) throw new Error("No confirmed burn Payment to disburse (C3)");
    if (state.disbursed[active.burnPaymentTxHash]) {
      throw new Error("This burn was already disbursed — rejected (double-spend guard)");
    }

    pushLog(state, {
      level: "info",
      message: `Acme disbursing ${active.amountSats} sats BTC to ${active.btcWithdrawalAddress}…`,
    });
    await saveState(state);

    const { txid, feeSats } = await sendWithOpReturn({
      wif: acmeBtc.wif,
      toAddress: active.btcWithdrawalAddress,
      amountSats: active.amountSats,
      opReturnText: active.burnPaymentTxHash,
    });
    active.disbursed = true;
    active.btcDisburseTxid = txid;
    active.btcDisburseFeeSats = feeSats;
    state.disbursed[active.burnPaymentTxHash] = txid;
    pushLog(state, {
      level: "tx",
      message: `Acme disbursed BTC: ${txid} (OP_RETURN → burn ${active.burnPaymentTxHash.slice(0, 12)}…)`,
    });
    await saveState(state);
    return state;
  }),
);

// C5 — Merchant deletes the settled XBTCBurnReq.
app.post(
  "/api/merchant/delete-burn-req",
  wrap(async () => {
    const state = await getState();
    const merchantRec = ensureWallet("merchant", state);
    const acmeRec = ensureWallet("acme", state);
    const merchant = await fundOrLoadWallet(merchantRec.seed);
    const active = state.burn.active;
    if (!active?.disbursed) throw new Error("BTC must be disbursed before cleanup (C4)");

    const result = await deleteCredential(merchant, {
      issuer: merchantRec.address,
      subject: acmeRec.address,
      label: CRED.BURN_REQ,
    });
    active.deleted = true;
    active.deleteTxHash = result.hash;
    pushLog(state, { level: "tx", message: `Merchant deleted ${CRED.BURN_REQ} — ledger clean` });

    state.burn.history.unshift(active);
    state.burn.active = null;
    await saveState(state);
    return state;
  }),
);

// ══════════════════════════════════════════════════════════════════════
process.on("SIGINT", async () => {
  await disconnect();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(
    `[xbtc-demo] backend on http://localhost:${PORT} — BTC ${BTC_NETWORK} (${BTC_MODE} mode)`,
  );
});
