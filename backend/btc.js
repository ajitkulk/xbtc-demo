// Bitcoin backend selector. Picks the mock or real testnet implementation
// based on BTC_MODE, exposing one interface to the rest of the app.
// Wallet generation is always real (genuine testnet-format keys/addresses).

import { BTC_MODE } from "./config.js";
import * as real from "./btc-helpers.js";
import * as mock from "./btc-mock.js";

const impl = BTC_MODE === "real" ? real : mock;

export const generateWallet = real.generateWallet;
export const addressFromWif = real.addressFromWif;

export const getBalanceSats = impl.getBalanceSats;
export const getConfirmations = impl.getConfirmations;
export const inspectTx = impl.inspectTx;
export const sendWithOpReturn = impl.sendWithOpReturn;

// Mock-only helpers; no-ops / guards in real mode.
export const fundAddress =
  impl.fundAddress ||
  (async () => {
    throw new Error("Mock funding is unavailable in real mode — use a testnet faucet");
  });
export const resetBtc = impl.reset || (async () => {});
