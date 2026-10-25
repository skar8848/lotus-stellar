// stellar.expert links. One place so every page builds them the same way.
//   tx / account / asset / contract / offer / liquidity-pool, assets as CODE-ISSUER.

export type ExplorerKind = "tx" | "account" | "contract" | "asset" | "offer" | "liquidity-pool";

export function explorerBase(network = "testnet"): string {
  const n = network === "mainnet" || network === "public" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${n}`;
}

export const explorerTx = (hash: string, network = "testnet") => `${explorerBase(network)}/tx/${hash}`;
export const explorerAccount = (id: string, network = "testnet") => `${explorerBase(network)}/account/${id}`;
export const explorerContract = (id: string, network = "testnet") => `${explorerBase(network)}/contract/${id}`;
export const explorerOffer = (id: string | number, network = "testnet") => `${explorerBase(network)}/offer/${id}`;
export const explorerLiquidityPool = (id: string, network = "testnet") => `${explorerBase(network)}/liquidity-pool/${id}`;

/** `issuer` null/empty => native XLM. */
export const explorerAsset = (code: string, issuer: string | null | undefined, network = "testnet") =>
  issuer ? `${explorerBase(network)}/asset/${code}-${issuer}` : `${explorerBase(network)}/asset/XLM`;

export function explorerUrl(kind: ExplorerKind, id: string, network = "testnet"): string {
  switch (kind) {
    case "tx":
      return explorerTx(id, network);
    case "account":
      return explorerAccount(id, network);
    case "contract":
      return explorerContract(id, network);
    case "offer":
      return explorerOffer(id, network);
    case "liquidity-pool":
      return explorerLiquidityPool(id, network);
    case "asset":
      // id is "CODE-ISSUER" or "XLM"
      return `${explorerBase(network)}/asset/${id}`;
  }
}
