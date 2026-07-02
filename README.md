# xbtc-demo

A React + Express demo of a **mint / burn workflow for XBTC** — a token backed
1:1 by BTC on Bitcoin testnet, issued on XRPL testnet as a Multi-Purpose Token
(XLS-33d) and gated end-to-end by XLS-70 Credentials.

Two platforms from the design are simulated as XRPL accounts (each also holding
a Bitcoin testnet wallet):

| Persona | Role |
| --- | --- |
| **Acme Co** | XBTC issuer (MPT issuer) + BTC custodian |
| **Merchant** | Authorized XBTC holder + BTC deposit/withdrawal counterparty |

XRPL transactions run against `wss://s.altnet.rippletest.net:51233`. The
Bitcoin deposit (mint) and disbursement (burn) carry an `OP_RETURN` cross-chain
reference.

**Bitcoin runs in `mock` mode by default** — a local simulated testnet ledger
(pre-funded, no faucet needed) so the demo works out of the box. Set
`BTC_MODE=real` to broadcast genuine Bitcoin testnet transactions via
mempool.space instead. Both paths share one interface (`backend/btc.js`); the
rest of the app is identical either way.

## The three workflows

**A · Merchant Authorization** (one-time onboarding)
1. Acme creates the XBTC MPT issuance (`RequireAuth`) and enables `DepositAuth`.
2. Merchant opts in to hold XBTC (`MPTokenAuthorize`).
3. Acme authorizes the merchant as a holder (KYC gate).
4. Acme issues the `XBTCMerchantAuth` credential (`CredentialCreate`).
5. Merchant accepts it (`CredentialAccept`).
6. Acme sets credential-gated `DepositPreauth` so burns from any auth holder are accepted.

**B · Mint XBTC**
1. Merchant broadcasts a **BTC testnet** deposit to Acme's custodian address with `OP_RETURN <xrplDestAddress>`.
2. Merchant creates `XBTCMintReq` (Subject = Acme, 72h expiry, `{btcTxid, amountSats, xrplDestAddress}`).
3. Acme validates (auth held · confirmations · amount · dedup · not expired · OP_RETURN), mints XBTC via `Payment`, then accepts the credential.
4. Merchant deletes `XBTCMintReq` for ledger hygiene.

**C · Burn XBTC**
1. Merchant creates `XBTCBurnReq` (Subject = Acme, `{amountSats, btcWithdrawalAddress}`).
2. Acme validates authorization and accepts it.
3. Merchant burns XBTC by paying it back to the issuer (memo links to the burn request).
4. Acme disburses **BTC testnet** to the merchant with `OP_RETURN <burnPaymentTxHash>`.
5. Merchant deletes `XBTCBurnReq`.

The WBTC design's three defences are implemented: only `XBTCMerchantAuth`
holders are processed (and `DepositAuth` blocks others at the ledger), a
`btcTxid → mintPaymentTxHash` dedup table prevents double-mint, and each burn
disbursement is recorded once. Request credentials carry a native 72h
`Expiration`.

## Prerequisites

- **Node.js 20+** and npm
- In the default `mock` BTC mode, nothing else — both wallets are pre-funded
  automatically and a **＋ fund** button tops them up.
- In `BTC_MODE=real`, both wallets need testnet BTC: open each BTC address's
  **faucet ↗** link in the UI (the merchant needs it to deposit for mints;
  Acme needs it to disburse on burns).

## Installation

Clone the repo and install both halves (backend and frontend have separate
dependencies):

```sh
git clone https://github.com/ajitkulk/xbtc-demo.git
cd xbtc-demo

# backend — Express + xrpl.js + bitcoinjs-lib
cd backend && npm install && cd ..

# frontend — Vite + React
cd frontend && npm install && cd ..
```

## Run

Start the two servers in separate terminals:

```sh
# terminal 1 — backend on http://localhost:4100
cd backend && npm run dev

# terminal 2 — frontend on http://localhost:5273
cd frontend && npm run dev
```

Open <http://localhost:5273>. Click **Fund wallets**, then walk the steps
A → B → C in order. (In `mock` mode the BTC wallets are funded for you; in
`real` mode, top up each BTC address from its faucet link first.)

## Configuration (env vars, all optional)

| Var | Default | Notes |
| --- | --- | --- |
| `XRPL_NETWORK` | `wss://s.altnet.rippletest.net:51233` | XRPL endpoint |
| `BTC_MODE` | `mock` | `mock` = local simulated ledger (no faucet); `real` = broadcast to Bitcoin testnet |
| `MOCK_START_SATS` | `2000000` | Starting balance per wallet in mock mode |
| `BTC_NETWORK` | `testnet4` | or `testnet` (testnet3); used in `real` mode |
| `BTC_API` | `https://mempool.space/<net>/api` | UTXO / broadcast / status (real mode) |
| `MIN_CONFIRMATIONS` | `1` | Confs Acme requires before minting. The WBTC design specifies **3**; kept at 1 so the demo doesn't stall on erratic testnet block times. |

## Layout

```
xbtc-demo/
├── backend/            Express + xrpl.js + bitcoinjs-lib, persists data/state.json
│   ├── server.js       REST endpoints for every workflow step
│   ├── xrpl-helpers.js MPT, credentials, deposit-preauth, payments
│   ├── btc-helpers.js  testnet wallet, UTXO/confirmation lookups, OP_RETURN send
│   ├── state.js        JSON persistence
│   └── config.js       network + token config (env-overridable)
└── frontend/           Vite + React, two-persona + three-workflow UI
    └── src/{App.jsx, api.js, styles.css, main.jsx}
```

## Notes

- Devnet/testnet seeds and BTC WIFs live in `backend/data/state.json` (git-ignored). Don't commit it.
- Bitcoin confirmations can be slow on testnet; the UI shows a live `n/N confirmations` count on the mint step and polls until the deposit is ready.
- This is a demo: no auth, no rate limiting, no validation beyond what the ledgers enforce.
