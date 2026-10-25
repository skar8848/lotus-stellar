// Blend testnet faucet: the same endpoint testnet.blend.capital uses. It returns an issuer-signed
// transaction (source = USDC issuer) that opens trustlines on the user's account (op source = user)
// and pays 1,000 USDC + 5,000 BLND + 0.5 wETH + 0.05 wBTC. The user only has to co-sign and submit.

import { Asset, TransactionBuilder } from '@stellar/stellar-sdk';
import { balanceLine, explainHorizonError, horizonErrorCodes, loadAccount, txLink } from './stellar.mjs';

export const BLEND_USDC_ISSUER = 'GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56';
export const FAUCET_URL = 'https://ewqw4hx7oa.execute-api.us-east-1.amazonaws.com/getAssets';
export const FAUCET_ORIGIN = 'https://testnet.blend.capital';

export function isBlendUsdc(asset) {
  return !asset.isNative() && asset.getCode() === 'USDC' && asset.getIssuer() === BLEND_USDC_ISSUER;
}

/** Request the faucet for `kp`, co-sign and submit. Returns { hash, link }. */
export async function blendFaucet(ctx, kp, { retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${FAUCET_URL}?userId=${encodeURIComponent(kp.publicKey())}`, {
      headers: { Origin: FAUCET_ORIGIN },
    });
    const body = (await res.text()).trim();
    if (!res.ok) throw new Error(`faucet HTTP ${res.status}: ${body.slice(0, 200)}`);
    let xdrB64 = body;
    try {
      const j = JSON.parse(body);
      xdrB64 = typeof j === 'string' ? j : j.xdr ?? j.tx ?? j.transaction;
    } catch {
      /* raw XDR */
    }
    if (!xdrB64) throw new Error(`faucet returned no transaction: ${body.slice(0, 200)}`);
    const tx = TransactionBuilder.fromXDR(xdrB64, ctx.passphrase);
    tx.sign(kp);
    try {
      const r = await ctx.horizon.submitTransaction(tx, { skipMemoRequiredCheck: true });
      return { hash: r.hash, link: txLink(r.hash) };
    } catch (e) {
      lastErr = e;
      const codes = horizonErrorCodes(e);
      // the issuer's sequence number is baked into the response: another faucet user may have won the race
      if (codes?.transaction === 'tx_bad_seq' && attempt < retries) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw new Error(`faucet tx failed: ${explainHorizonError(e)}`);
    }
  }
  throw new Error(`faucet failed: ${explainHorizonError(lastErr)}`);
}

/**
 * Make sure `kp` holds at least `minAmount` of `asset`. Only knows how to top up Blend testnet USDC.
 * Returns { line, funded: boolean, hash? }.
 */
export async function ensureUnderlying(ctx, kp, asset, minAmount) {
  const acc = await loadAccount(ctx, kp.publicKey());
  const line = balanceLine(acc, asset);
  if (line && Number(line.balance) >= Number(minAmount)) return { line, funded: false };
  if (!isBlendUsdc(asset)) return { line, funded: false, reason: 'no faucet for this asset' };
  const { hash } = await blendFaucet(ctx, kp);
  const after = balanceLine(await loadAccount(ctx, kp.publicKey()), asset);
  return { line: after, funded: true, hash };
}

export { Asset };
