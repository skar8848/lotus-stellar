# Lotus: pitch deck

Directional liquidity and yield-bearing orders for Stellar. HackMeridian 2026, Path Genesis, tracks Stellar Unlocked and Stellar Composed. Ten slides, each with a speaker note of one or two sentences. Everything runs on testnet.

---

## Slide 1. Depth is dead capital

- A resting order earns nothing while it waits.
- The holders who could provide depth, issuers with inventory and treasuries with cash, have the least reason to post it.
- AMMs force them into round trips: you sell low, get sold back the asset higher, and hold what the market leaves you.
- Tokenized bonds and other RWAs need a book the most and have the thinnest ones.

Speaker note: The people with the most inventory and cash are the least willing to put it in a book, because a resting order is dead capital. Lotus fixes that on Stellar in two ways.

---

## Slide 2. Two products, one stack

- **Lotus pool** (Soroban): a range pool on price bins where an LP picks a direction. A directional position only sells its inventory and only receives proceeds. Optional two-way mode with crossback. Optional DeFindex vault under the USDC leg, so waiting liquidity earns Blend interest and is recalled just in time by the taker's swap.
- **Receipt token** (`lUSDCb`): a classic Stellar asset, 1:1 against USDC, backed by a DeFindex vault lending on Blend. It trades on the SDEX, and an SDEX offer does not move funds, so an order quoted in it keeps earning.

Speaker note: The pool is the new venue, the receipt token is the bridge to the venue Stellar already has. Same assets, same vault, two ways to be a liquidity provider.

---

## Slide 3. The pool: directionality by design

- Bins at 10 bps steps, up to 64 per position. Ask side deposits LBOND, Bid side deposits USDC.
- Inventory only goes down, proceeds only go up. No impermanent loss on the way out, no round trip.
- Same pool, a choice per position: directional (default) or two-way with crossback.
- The yield strategy is a pool instance: idle, or DeFindex on Blend. Three live testnet instances.
- 58 unit tests, randomized solvency fuzz, an adversarial review, limits written down.

Speaker note: The ranges are classic; Aquarius already ships a CLMM on Soroban. What is new is making direction the product: a position is one-way unless you choose otherwise.

---

## Slide 4. The receipt token and the SDEX

- `lotus_vault` is the admin of the `lUSDCb` asset contract: `deposit`, `redeem` at par, and a keeper-driven `distribute` capped on-chain at `surplus x balance / supply`.
- Two books: `LBOND/lUSDCb` (the RWA) and `USDC/lUSDCb` (peg 1:1, kept honest by par redemption).
- A taker with only USDC buys LBOND in one path payment USDC -> lUSDCb -> LBOND. The receipt is invisible to them.
- LBOND is AUTH_REQUIRED with clawback: an unauthorized taker fails with `op_not_authorized`, enforced by the protocol.

Speaker note: The mentors told us to use the SDEX and not to rely on liquidity walls. This is the answer: the order stays on the SDEX, the capital behind it earns.

---

## Slide 5. Real yield on testnet

- Our own DeFindex vault, seeded into the Blend testnet pool: about 6.9 percent APR observed over 34 minutes. It follows testnet utilization; it is an observation, not a forecast.
- Why earlier vaults showed none: DeFindex only invests in proportion to an existing allocation, and only the vault's rebalance manager can seed it.
- The keeper's dry run counts receipts locked in open SDEX offers, which is the point.

Speaker note: We did not fake yield with a donation. We built the vault, seeded it, and measured Blend. The amounts look small because the demo runs for minutes.

---

## Slide 6. Architecture and Stellar integration

- Classic layer: SDEX offers and path payments, assets with authorization flags and clawback.
- Soroban layer: `lotus_pool`, `lotus_vault`, DeFindex, Blend. The SAC bridges the two: a contract is the admin of a classic asset.
- Off-chain: a local bot (two market makers and an arbitrageur) links the pool, the SDEX and the par redemption.
- Unlocked: liabilities, path payments, classic asset plus contract admin, flags. Composed: DeFindex plus Blend.

Speaker note: The interesting part is the seam between classic and Soroban: an order lives in one world, the yield and the pool in the other.

---

## Slide 7. Traction we can show: market-maker volume

- Real on-chain trades with assets we issue (LBOND) or mint through the vault (the receipt). This is market-maker volume from three accounts, not users. We say so.
- Depeg of the receipt to 0.985 restored in 10 to 12 seconds by the arbitrageur on both vault deployments. Cross-venue dislocation between pool and SDEX closed in 26 seconds.
- 167-second demo run, 25 flow trades, ends with real interest minted to 6 holders. Two 10-minute runs: 0 failed transactions.
- App with Trade, Pools and Portfolio, explorer links everywhere.

Speaker note: On testnet no user is coming, so we show the mechanism under load. A judge who opens Horizon will see three addresses; we would rather say it first.

---

## Slide 8. Adoption: who uses it first

- First: RWA issuers distributing on a ladder of asks, or a directional pool position, with proceeds earning from the moment they land.
- Second: treasuries accumulating RWAs with bids whose USDC earns while it waits.
- Third: market makers on RWA pairs; yield on inventory offsets the cost of quoting thin pairs.
- Takers pay in USDC through path payments; aggregators that route the SDEX reach the pair on day one.
- First concrete step: one issuer pilot with a real ladder and a weekly distribution.

Speaker note: Adoption does not need retail. It needs one issuer and one treasury.

---

## Slide 9. Honest limits and roadmap

- Known: JIT yield capture in `distribute` (fix: exchange-rate token); LBOND issuer can revoke the pool's trustline, which can trap a Bid LP's USDC (fix: quote-only exit); footprint race on the vault pool (client retries); no pause, upgrade path or audit.
- Next: exchange-rate token, quote-only exit, audit with OpenZeppelin's Stellar library, aggregator listing, EURC, a second yield strategy, then privacy (commitments, ZK on Protocol 25).
- Mainnet only with a production DeFindex vault and an audit.

Speaker note: We wrote the limits in the README before a judge could find them. The order of the roadmap is trust first, reach second, privacy third.

---

## Slide 10. The ask

- Introductions: an RWA issuer on Stellar for a pilot, and DeFindex for a mainnet vault path.
- Technical review: core developers and DeFindex on fee and rent profile on mainnet (testnet Blend-touching calls cost 0.0015 to 0.14 XLM; mainnet is unmeasured).
- Funding: an SCF build award to reach audit and mainnet.

Speaker note: Three things a solo builder cannot source alone: a pilot counterparty, a review of the cost profile, and an audit budget.
