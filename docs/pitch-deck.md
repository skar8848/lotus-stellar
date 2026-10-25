# Lotus: pitch deck

Yield-bearing liquidity for Stellar's native orderbook. HackMeridian 2026, Path Genesis, tracks Stellar Unlocked and Stellar Composed. Ten slides, each with a speaker note of one or two sentences.

---

## Slide 1. Depth is dead capital

- Orderbooks need resting orders. A resting order is capital that earns nothing while it waits.
- The holders who could provide depth, issuers with inventory and treasuries with cash, have the least reason to post it.
- AMMs do not help them: a pool forces round trips and leaves the LP holding whatever the market sells it.
- Tokenized bonds and other RWAs are the assets that most need a book, and they have the thinnest ones.

Speaker note: Open on the paradox. The people with the most inventory and the most cash are the ones least willing to put it in a book, because a resting order is dead capital. Everything else follows from fixing that.

---

## Slide 2. On Stellar, an order does not move funds

- An SDEX offer is recorded as a selling liability on the account. The funds never leave.
- So if the asset behind the order bears yield, the order earns while it waits.
- Stellar already has yield-bearing RWAs on the asset side (Ondo USDY, Etherfuse Stablebonds). The quote side, USDC, is the idle half of every pair.
- A filled offer never trades back. The orderbook is one-way by construction, which is what we had to build by hand as an AMM at ETHGlobal New York.

Speaker note: This is the whole thesis in one line: make the quote asset productive and every resting order becomes productive. The protocol already does the hard part.

---

## Slide 3. Lotus: lUSDC and the lotus_vault contract

- lUSDC is a classic Stellar asset minted 1:1 against USDC. Its SAC admin is a Soroban contract, the sole minter.
- The USDC backing goes into a DeFindex vault that lends on Blend.
- deposit and redeem at par, permissionless.
- distribute: a keeper submits holders; the contract caps every mint at surplus x balance / supply. The keeper can omit, never steal.
- Two books: LBOND/lUSDC (the RWA market) and USDC/lUSDC (the peg at 1:1).

Speaker note: lUSDC is a dollar that earns, in a form the orderbook understands. The contract is small on purpose: three entry points and one invariant, supply never exceeds vault value.

---

## Slide 4. Demo flow (testnet)

- Deposit USDC in the app, receive lUSDC.
- An issuer posts a ladder of five LBOND asks quoted in lUSDC, in one transaction. The LBOND stays in the account as selling liabilities.
- A taker holding only USDC buys LBOND in one path payment: USDC -> lUSDC -> LBOND.
- An unauthorized taker tries the same trade. LBOND is AUTH_REQUIRED, so the transaction fails at the protocol level.
- The keeper distributes. The issuer's lUSDC proceeds grow while its remaining asks stay open, and the peg provider earns on lUSDC committed to an open offer.

Speaker note: Five steps, all verifiable on stellar.expert and Horizon. The last one is the point: the yield lands on balances that are committed to open orders. On testnet the accrual is simulated, because the DeFindex testnet vault keeps deposits idle.

---

## Slide 5. Stellar integration: Unlocked and Composed

- Unlocked: SDEX offers and liabilities, path payments, a classic asset with a Soroban contract as SAC admin, AUTH_REQUIRED / AUTH_REVOCABLE / clawback flags, a Soroban contract.
- Composed: DeFindex vault plus Blend lending provide the yield; Horizon and stellar.expert serve the orderbook and the proofs.
- None of this maps onto an EVM chain: no native orderbook, no liabilities, no asset-level authorization.
- Design was changed by mentors on site: a Stellar core engineer preferred SDEX over a Soroban pool with just-in-time withdrawals.

Speaker note: We did not port an EVM design. We threw away the custom pool because the protocol gives one-way, compliant, fund-preserving orders for free, and composed the yield from two live ecosystem protocols.

---

## Slide 6. Why now

- RWAs are live on Stellar: USDY since September 2025, Etherfuse Stablebonds (CETES) trading on SDEX, sovereign issuance such as USDM1.
- Lending infrastructure is live: Blend, with DeFindex vaults on top.
- Aggregators (Soroswap, LumAgg) already route through SDEX, so a new pair is reachable from day one.
- Protocol 25 (X-Ray) and 26 shipped BN254 and Poseidon host functions, which open the privacy roadmap for maker identity.

Speaker note: Two years ago none of the pieces existed. Today the yield-bearing bond is on the asset side of the book and the lending market is one contract call away; the quote side is the missing piece.

---

## Slide 7. Adoption: who uses it first

- First: RWA issuers distributing on a ladder of asks. Pitch: quote in lUSDC and your proceeds earn from the moment they hit the book.
- Second: treasuries accumulating RWAs with a ladder of bids (treasury platforms moving company cash into tokenized bills, the Bando-on-Etherfuse profile). Their USDC earns while it waits.
- Third: market makers on RWA pairs. Yield on inventory offsets the cost of quoting thin pairs; Aquarius market incentives are the natural complement.
- Takers need nothing. Path payments make lUSDC invisible to them.
- First concrete step: one issuer pilot on testnet with a real ladder and a weekly distribution.

Speaker note: Adoption does not need retail. It needs one issuer and one treasury to quote in lUSDC, and the taker side keeps paying in USDC without noticing.

---

## Slide 8. Validation

- Mentor feedback at HackMeridian: a Stellar core engineer preferred this over a Soroban pool with JIT withdrawals (liquidity walls appearing near the price are a bad signal); the DeFindex mentor endorsed the tokenization approach.
- Measured on testnet: a withdraw from a DeFindex Blend strategy used about 3.5M CPU instructions of the 400M limit and 13 of 200 ledger entries.
- The one-way liquidity thesis won the Uniswap track at ETHGlobal New York 2026. On Stellar it needs no custom pool.
- Working testnet deployment: contract, two books, path-payment demo, keeper, app.

Speaker note: The validation we care about is from people who run the protocol and the vault we depend on. Both pushed us toward this design rather than away from it.

---

## Slide 9. Roadmap

- Trustless distribution: per-holder claims from a snapshot or merkle root, or an exchange-rate token, removing the keeper.
- Aggregator listing: Soroswap and LumAgg already route through SDEX; the work is listing and pricing.
- More underlyings: EURC first, then any quote asset with a lending market.
- Issuer tooling: ladder builders for primary distribution and buybacks.
- Privacy: hidden maker identity through commitments, then ZK with the Protocol 25 host functions.
- Mainnet with a production DeFindex USDC vault, after an audit (OpenZeppelin's Stellar contracts as the reference library).

Speaker note: The order is deliberate: remove the trusted keeper first, then widen distribution, then add privacy. Mainnet waits for the audit and the vault.

---

## Slide 10. The ask

- Introductions: one RWA issuer on Stellar for a pilot, and DeFindex for a mainnet vault path.
- Technical review: core developers on the fee and rent profile of Blend-touching operations (about 100 XLM per transaction on testnet).
- Funding: an SCF build award to reach audit and mainnet.
- Security: audit scoping with OpenZeppelin's Stellar practice.

Speaker note: We are asking for the three things a solo builder cannot source alone: a pilot counterparty, a review of the cost profile, and an audit budget.
