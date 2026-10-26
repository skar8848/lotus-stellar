// Secret-key signer for TESTNET scripts and autonomous testnet agents. It refuses any other network.
// The secret stays inside the closure: it is never returned, logged or put in an error message.

import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import type { Signer } from "./tx.ts";

export function fromSecret(secret: string, opts: { allowNetwork?: string } = {}): Signer {
  let kp: Keypair;
  try {
    kp = Keypair.fromSecret(secret.trim());
  } catch {
    throw new Error("invalid Stellar secret key (expected S...)");
  }
  const allowed = opts.allowNetwork ?? Networks.TESTNET;
  if (allowed !== Networks.TESTNET) throw new Error("fromSecret is for Stellar testnet only");
  return {
    publicKey: kp.publicKey(),
    async sign(txXdr: string, networkPassphrase: string): Promise<string> {
      if (networkPassphrase !== Networks.TESTNET) throw new Error("refusing to sign: this signer only signs Stellar testnet transactions");
      const tx = TransactionBuilder.fromXDR(txXdr, networkPassphrase);
      tx.sign(kp);
      return tx.toXDR();
    },
  };
}
