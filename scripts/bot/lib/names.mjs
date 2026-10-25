// The receipt token's code ("lUSDC" for Lotus v1, "lUSDCb" for v2) comes from deployments/testnet.contract.json, so it
// must never be hard-coded in log lines. `${RC}` in a template literal prints the live code; Bot (and bot:setup) call
// setReceiptCode() once, right after the config is loaded.

let code = 'lUSDC';

export const RC = {
  toString: () => code,
  valueOf: () => code,
};

export function setReceiptCode(c) {
  code = String(c);
}

export const receiptCode = () => code;
