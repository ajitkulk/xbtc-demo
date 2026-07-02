async function call(path, { method = "POST", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

export const api = {
  state: () => call("/api/state", { method: "GET" }),
  setup: () => call("/api/setup"),
  reset: () => call("/api/reset"),
  btcFund: (role) => call("/api/btc/fund", { body: { role } }),

  // Workflow A — merchant authorization
  createXbtc: () => call("/api/issuer/create-xbtc"),
  merchantOptIn: () => call("/api/merchant/optin"),
  authorizeMerchant: () => call("/api/issuer/authorize-merchant"),
  issueMerchantAuth: () => call("/api/issuer/issue-merchant-auth"),
  acceptAuth: () => call("/api/merchant/accept-auth"),
  depositPreauth: () => call("/api/issuer/deposit-preauth"),

  // Workflow B — mint
  btcDeposit: (body) => call("/api/merchant/btc-deposit", { body }),
  createMintReq: () => call("/api/merchant/create-mint-req"),
  processMint: () => call("/api/issuer/process-mint"),
  deleteMintReq: () => call("/api/merchant/delete-mint-req"),

  // Workflow C — burn
  createBurnReq: (body) => call("/api/merchant/create-burn-req", { body }),
  acceptBurnReq: () => call("/api/issuer/accept-burn-req"),
  burnPayment: () => call("/api/merchant/burn-payment"),
  disburseBtc: () => call("/api/issuer/disburse-btc"),
  deleteBurnReq: () => call("/api/merchant/delete-burn-req"),
};
