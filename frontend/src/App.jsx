import React, { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";

const XRPL_EXPLORER = "https://testnet.xrpl.org";

function btcExplorerBase(net) {
  return `https://mempool.space/${net || "testnet4"}`;
}
function btcFaucet(net) {
  return net === "testnet"
    ? "https://coinfaucet.eu/en/btc-testnet/"
    : "https://mempool.space/testnet4/faucet";
}

const sat = (n) => (n == null ? "—" : `${Number(n).toLocaleString()} sats`);
const btc = (n) => (n == null ? "" : `${(Number(n) / 1e8).toFixed(8)} BTC`);
const short = (s) => (s && s.length > 20 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);

// A Bitcoin tx reference. In mock mode the txid isn't on any chain, so show a
// non-clickable "simulated" chip instead of a dead mempool.space link.
function BtcRef({ txid, base, mock, label = "tx" }) {
  if (!txid) return null;
  if (mock) {
    return (
      <span
        className="mock-tx"
        title={`Simulated Bitcoin testnet tx (mock mode) — not on-chain\n${txid}`}
      >
        {label}: {short(txid)}
      </span>
    );
  }
  return (
    <a className="tx-link" href={`${base}/tx/${txid}`} target="_blank" rel="noreferrer">
      {label} ↗
    </a>
  );
}

export default function App() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [mintSats, setMintSats] = useState(10000);
  const [burnSats, setBurnSats] = useState(5000);

  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll while a step runs, and continuously while a BTC deposit is confirming.
  const awaitingConfs =
    state?.mint?.active?.btcTxid && !state?.mint?.active?.minted;
  useEffect(() => {
    if (!busy && !awaitingConfs) return;
    const id = setInterval(refresh, busy ? 1500 : 8000);
    return () => clearInterval(id);
  }, [busy, awaitingConfs, refresh]);

  const run = useCallback(
    async (label, fn) => {
      setBusy(label);
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  if (!state) {
    return (
      <div className="loading">
        <p>Loading state from backend…</p>
        {error && <pre className="error">{error}</pre>}
      </div>
    );
  }

  const btcBase = btcExplorerBase(state.btcNetwork);
  const mockBtc = state.btcMode !== "real";
  const xTx = (h) => `${XRPL_EXPLORER}/transactions/${h}`;

  const allFunded = !!state.acme.wallet && !!state.merchant.wallet;
  const auth = state.auth;
  const authDone = auth.depositPreauth;
  // `active*` gates what's runnable; the view falls back to the most recent
  // completed cycle so checkmarks persist after the request is deleted (B4/C5).
  const activeMint = state.mint.active;
  const activeBurn = state.burn.active;
  const mint = activeMint ?? state.mint.history[0] ?? null;
  const burn = activeBurn ?? state.burn.history[0] ?? null;
  const mintComplete = !activeMint && !!state.mint.history[0];
  const burnComplete = !activeBurn && !!state.burn.history[0];
  const minConf = state.minConfirmations ?? 1;

  const merchantXbtc = findXbtc(state, "merchant");

  // ── Workflow step definitions ───────────────────────────────────────
  const authSteps = [
    {
      actor: "Acme",
      code: "A1",
      label: "Create XBTC MPT issuance + enable DepositAuth",
      done: !!state.issuance && auth.depositAuth,
      disabled: !allFunded,
      link: state.issuance?.tx && xTx(state.issuance.tx.hash),
      run: () => run("A1", api.createXbtc),
    },
    {
      actor: "Merchant",
      code: "A2",
      label: "Opt in to hold XBTC (MPTokenAuthorize)",
      done: auth.merchantOptIn,
      disabled: !state.issuance,
      link: auth.txs.optIn && xTx(auth.txs.optIn.hash),
      run: () => run("A2", api.merchantOptIn),
    },
    {
      actor: "Acme",
      code: "A3",
      label: "Authorize merchant as holder (KYC gate)",
      done: auth.merchantAuthorized,
      disabled: !auth.merchantOptIn,
      link: auth.txs.authorizeHolder && xTx(auth.txs.authorizeHolder.hash),
      run: () => run("A3", api.authorizeMerchant),
    },
    {
      actor: "Acme",
      code: "A4",
      label: "Issue XBTCMerchantAuth credential",
      done: auth.credentialIssued,
      disabled: !auth.merchantAuthorized,
      link: auth.txs.merchantAuth && xTx(auth.txs.merchantAuth.hash),
      run: () => run("A4", api.issueMerchantAuth),
    },
    {
      actor: "Merchant",
      code: "A5",
      label: "Accept XBTCMerchantAuth",
      done: auth.credentialAccepted,
      disabled: !auth.credentialIssued,
      link: auth.txs.acceptAuth && xTx(auth.txs.acceptAuth.hash),
      run: () => run("A5", api.acceptAuth),
    },
    {
      actor: "Acme",
      code: "A6",
      label: "Set credential DepositPreauth (gates burns)",
      done: auth.depositPreauth,
      disabled: !auth.credentialAccepted,
      link: auth.txs.depositPreauth && xTx(auth.txs.depositPreauth.hash),
      run: () => run("A6", api.depositPreauth),
    },
  ];

  const confLabel = activeMint?.btcTxid
    ? `${activeMint.btcConfirmations ?? 0}/${minConf} confirmations`
    : null;

  const mintSteps = [
    {
      actor: "Merchant",
      code: "B1",
      label: "Send BTC deposit to Acme custodian (OP_RETURN = XRPL dest)",
      done: !!mint?.btcTxid,
      disabled: !authDone || !!activeMint,
      hint: !authDone ? "Complete merchant authorization first" : null,
      ref: <BtcRef txid={mint?.btcTxid} base={btcBase} mock={mockBtc} label="BTC" />,
      run: () => run("B1", () => api.btcDeposit({ amountSats: Number(mintSats) })),
    },
    {
      actor: "Merchant",
      code: "B2",
      label: "Create XBTCMintReq credential (72h expiry)",
      done: !!mint?.mintReqTxHash,
      disabled: !mint?.btcTxid,
      link: mint?.mintReqTxHash && xTx(mint.mintReqTxHash),
      run: () => run("B2", api.createMintReq),
    },
    {
      actor: "Acme",
      code: "B3",
      label: "Validate deposit, mint XBTC, accept credential",
      done: !!mint?.accepted,
      disabled: !mint?.mintReqTxHash,
      hint: activeMint?.mintReqTxHash && !activeMint?.minted ? confLabel : null,
      link: mint?.mintPaymentTxHash && xTx(mint.mintPaymentTxHash),
      run: () => run("B3", api.processMint),
    },
    {
      actor: "Merchant",
      code: "B4",
      label: "Delete XBTCMintReq (ledger hygiene)",
      done: !!mint?.deleted,
      disabled: !activeMint?.accepted,
      link: mint?.deleteTxHash && xTx(mint.deleteTxHash),
      run: () => run("B4", api.deleteMintReq),
    },
  ];

  const burnSteps = [
    {
      actor: "Merchant",
      code: "C1",
      label: "Create XBTCBurnReq credential (72h expiry)",
      done: !!burn?.burnReqTxHash,
      disabled: !authDone || !!activeBurn || merchantXbtc === 0,
      hint:
        !authDone
          ? "Complete merchant authorization first"
          : merchantXbtc === 0
            ? "Merchant holds no XBTC — mint some first"
            : null,
      link: burn?.burnReqTxHash && xTx(burn.burnReqTxHash),
      run: () => run("C1", () => api.createBurnReq({ amountSats: Number(burnSats) })),
    },
    {
      actor: "Acme",
      code: "C2",
      label: "Validate auth + accept XBTCBurnReq",
      done: !!burn?.accepted,
      disabled: !burn?.burnReqTxHash,
      link: burn?.acceptTxHash && xTx(burn.acceptTxHash),
      run: () => run("C2", api.acceptBurnReq),
    },
    {
      actor: "Merchant",
      code: "C3",
      label: "Burn XBTC — pay it back to the issuer",
      done: !!burn?.burned,
      disabled: !burn?.accepted,
      link: burn?.burnPaymentTxHash && xTx(burn.burnPaymentTxHash),
      run: () => run("C3", api.burnPayment),
    },
    {
      actor: "Acme",
      code: "C4",
      label: "Disburse BTC to merchant (OP_RETURN = burn hash)",
      done: !!burn?.disbursed,
      disabled: !burn?.burned,
      ref: <BtcRef txid={burn?.btcDisburseTxid} base={btcBase} mock={mockBtc} label="BTC" />,
      run: () => run("C4", api.disburseBtc),
    },
    {
      actor: "Merchant",
      code: "C5",
      label: "Delete XBTCBurnReq (ledger hygiene)",
      done: !!burn?.deleted,
      disabled: !activeBurn?.disbursed,
      link: burn?.deleteTxHash && xTx(burn.deleteTxHash),
      run: () => run("C5", api.deleteBurnReq),
    },
  ];

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>₿ XBTC · Mint &amp; Burn</h1>
          <p className="subtitle">
            XRPL testnet MPT backed 1:1 by Bitcoin {state.btcNetwork}
            <span className={`mode-badge ${state.btcMode}`}>
              {state.btcMode === "real" ? "real BTC" : "mock BTC"}
            </span>
            · XLS-70 credentials gate every step
          </p>
        </div>
        <div className="header-actions">
          <button disabled={busy === "setup"} onClick={() => run("setup", api.setup)}>
            {busy === "setup" ? "Funding…" : allFunded ? "Re-fund / sync" : "1. Fund wallets"}
          </button>
          <button className="ghost" disabled={!!busy} onClick={() => run("reset", api.reset)}>
            Reset state
          </button>
        </div>
      </header>

      {error && (
        <div className="error-banner">
          <strong>Error:</strong> {error}
        </div>
      )}

      <section className="personas">
        <PersonaCard
          title="Acme Co"
          roleKey="acme"
          role="XBTC issuer + BTC custodian"
          accent="#f59e0b"
          wallet={state.acme.wallet}
          btc={state.acme.btc}
          balances={state.balances?.acme}
          btcBase={btcBase}
          btcMode={state.btcMode}
          faucet={btcFaucet(state.btcNetwork)}
          onFund={(rk) => run(`fund:${rk}`, () => api.btcFund(rk))}
          busy={busy}
          extra={
            state.outstanding != null && [
              { label: "XBTC outstanding", value: `${sat(state.outstanding)} (${btc(state.outstanding)})` },
            ]
          }
        />
        <PersonaCard
          title="Merchant"
          roleKey="merchant"
          role="Authorized XBTC holder"
          accent="#3b82f6"
          wallet={state.merchant.wallet}
          btc={state.merchant.btc}
          balances={state.balances?.merchant}
          btcBase={btcBase}
          btcMode={state.btcMode}
          faucet={btcFaucet(state.btcNetwork)}
          onFund={(rk) => run(`fund:${rk}`, () => api.btcFund(rk))}
          busy={busy}
        />
      </section>

      <main className="workflows">
        <Workflow
          tag="A"
          title="Merchant Authorization"
          note="One-time onboarding. XBTCMerchantAuth gates all later activity."
          steps={authSteps}
          busy={busy}
        />
        <Workflow
          tag="B"
          title="Mint XBTC"
          note="BTC deposit → mint request → Acme validates & mints → cleanup."
          steps={mintSteps}
          busy={busy}
          controls={
            <>
              <label className="amt">
                Deposit&nbsp;
                <input
                  type="number"
                  min="546"
                  value={mintSats}
                  disabled={!!activeMint}
                  onChange={(e) => setMintSats(e.target.value)}
                />
                &nbsp;sats
              </label>
              {mintComplete && (
                <button
                  className="new-btn"
                  disabled={!!busy}
                  onClick={() => run("B1", () => api.btcDeposit({ amountSats: Number(mintSats) }))}
                >
                  ＋ New mint
                </button>
              )}
            </>
          }
          history={state.mint.history}
          renderHistory={(m, i) => (
            <li key={i}>
              Minted {sat(m.amountSats)} —{" "}
              <BtcRef txid={m.btcTxid} base={btcBase} mock={mockBtc} label="BTC" /> /{" "}
              <a href={xTx(m.mintPaymentTxHash)} target="_blank" rel="noreferrer">mint tx</a>
            </li>
          )}
        />
        <Workflow
          tag="C"
          title="Burn XBTC"
          note="Burn request → Acme accepts → burn payment → BTC disbursed → cleanup."
          steps={burnSteps}
          busy={busy}
          controls={
            <>
              <label className="amt">
                Burn&nbsp;
                <input
                  type="number"
                  min="546"
                  value={burnSats}
                  disabled={!!activeBurn}
                  onChange={(e) => setBurnSats(e.target.value)}
                />
                &nbsp;sats
              </label>
              {burnComplete && (
                <button
                  className="new-btn"
                  disabled={!!busy || merchantXbtc === 0}
                  onClick={() => run("C1", () => api.createBurnReq({ amountSats: Number(burnSats) }))}
                >
                  ＋ New burn
                </button>
              )}
            </>
          }
          history={state.burn.history}
          renderHistory={(b, i) => (
            <li key={i}>
              Burned {sat(b.amountSats)} —{" "}
              <a href={xTx(b.burnPaymentTxHash)} target="_blank" rel="noreferrer">burn tx</a> /{" "}
              <BtcRef txid={b.btcDisburseTxid} base={btcBase} mock={mockBtc} label="BTC out" />
            </li>
          )}
        />
      </main>

      <section className="log-panel">
        <h2>Activity log</h2>
        <ul className="log">
          {(state.log || []).map((e, i) => (
            <li key={i} className={`log-entry log-${e.level || "info"}`}>
              <span className="log-time">{new Date(e.at).toLocaleTimeString()}</span>
              <span className="log-msg">{e.message}</span>
              {e.engine_result && <span className="log-result">{e.engine_result}</span>}
            </li>
          ))}
          {(!state.log || state.log.length === 0) && (
            <li className="log-empty">No activity yet — click "Fund wallets" to start.</li>
          )}
        </ul>
      </section>
    </div>
  );
}

function findXbtc(state, role) {
  const id = state.issuance?.issuanceId;
  if (!id) return 0;
  const holding = state.balances?.[role]?.mpt?.find((m) => m.issuanceId === id);
  return holding ? Number(holding.amount) : 0;
}

function PersonaCard({
  title,
  roleKey,
  role,
  accent,
  wallet,
  btc: btcW,
  balances,
  btcBase,
  btcMode,
  faucet,
  onFund,
  busy,
  extra,
}) {
  return (
    <div className="persona" style={{ "--accent": accent }}>
      <header>
        <h2>{title}</h2>
        <p className="persona-sub">{role}</p>
      </header>
      {wallet ? (
        <div className="addr-grid">
          <div className="addr-row">
            <span className="chip xrpl">XRPL</span>
            <a href={`${XRPL_EXPLORER}/accounts/${wallet.address}`} target="_blank" rel="noreferrer">
              {short(wallet.address)}
            </a>
            <span className="bal">
              {balances?.xrpDrops ? (Number(balances.xrpDrops) / 1e6).toFixed(2) : "—"} XRP
            </span>
          </div>
          <div className="addr-row">
            <span className="chip btc">BTC</span>
            {btcMode === "real" ? (
              <a href={`${btcBase}/address/${btcW?.address}`} target="_blank" rel="noreferrer">
                {short(btcW?.address)}
              </a>
            ) : (
              <span
                className="mock-tx"
                title={`Simulated BTC wallet (mock mode) — not on-chain\n${btcW?.address}`}
              >
                {short(btcW?.address)}
              </span>
            )}
            <span className="bal">{sat(balances?.btcSats)}</span>
            {btcMode === "real" ? (
              <a className="faucet" href={faucet} target="_blank" rel="noreferrer">faucet ↗</a>
            ) : (
              <button
                className="fund-btn"
                disabled={!!busy}
                onClick={() => onFund(roleKey)}
              >
                ＋ fund
              </button>
            )}
          </div>
          {(extra || []).filter(Boolean).map((e, i) => (
            <div className="addr-row detail" key={i}>
              <span className="chip flat">{e.label}</span>
              <span className="bal wide">{e.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="wallet-empty">No wallet — fund first</div>
      )}
    </div>
  );
}

function Workflow({ tag, title, note, steps, busy, controls, history, renderHistory }) {
  return (
    <section className="workflow">
      <header className="wf-head">
        <span className="wf-tag">{tag}</span>
        <div>
          <h2>{title}</h2>
          <p className="wf-note">{note}</p>
        </div>
        {controls && <div className="wf-controls">{controls}</div>}
      </header>
      <ol className="steps">
        {steps.map((s) => (
          <li key={s.code} className={`step ${s.done ? "done" : ""}`}>
            <span className={`actor ${s.actor.toLowerCase()}`}>{s.actor}</span>
            <span className="code">{s.code}</span>
            <button
              className="step-btn"
              disabled={s.disabled || s.done || !!busy}
              onClick={s.run}
            >
              {s.done ? "✓ " : ""}
              {s.label}
            </button>
            {s.ref
              ? s.ref
              : s.link && (
                  <a className="tx-link" href={s.link} target="_blank" rel="noreferrer">
                    tx ↗
                  </a>
                )}
            {s.hint && <div className="hint">{s.hint}</div>}
          </li>
        ))}
      </ol>
      {history && history.length > 0 && (
        <div className="wf-history">
          <h3>Completed</h3>
          <ul>{history.map(renderHistory)}</ul>
        </div>
      )}
    </section>
  );
}
