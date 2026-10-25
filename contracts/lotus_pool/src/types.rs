//! Public types, storage records, constants and errors of the Lotus pool.

use soroban_sdk::{contracterror, contracttype, Address, Vec};

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/// Lowest / highest bin index of the price grid (401 bins).
pub const MIN_BIN: i32 = -200;
pub const MAX_BIN: i32 = 200;

/// Prices are QUOTE per BASE with 7 decimals: 1.0000000 = 10_000_000.
pub const PRICE_SCALE: i128 = 10_000_000;
/// Per-share accumulators (proceeds, fees, filled) are scaled by 1e18.
pub const ACC_SCALE: i128 = 1_000_000_000_000_000_000;
pub const BPS: i128 = 10_000;

/// Largest `bin_step_bps` accepted by the constructor (1 percent). Keeps the
/// 1e18 fixed-point power inside i128 for every bin of the grid.
pub const MAX_BIN_STEP_BPS: u32 = 100;
/// Largest `fee_bps` accepted by the constructor (10 percent).
pub const MAX_FEE_BPS: u32 = 1_000;

/// A position spans at most this many bins (bounds storage and CPU of
/// `add_position` / `remove_position` / `claim`).
pub const MAX_POSITION_BINS: u32 = 64;
/// Hard ceiling for `max_bins_per_swap` (size of the in-memory fill buffer).
pub const HARD_MAX_BINS_PER_SWAP: u32 = 100;
/// Value of `max_bins_per_swap` at deployment; the admin can change it.
pub const DEFAULT_MAX_BINS_PER_SWAP: u32 = 100;
/// `depth()` returns at most this many bins.
pub const MAX_DEPTH_BINS: u32 = 100;
/// Positions per owner kept in the `positions_of` index.
pub const MAX_OWNER_POSITIONS: u32 = 100;

/// Largest amount accepted by `add_position` / `swap` (1e18 stroops).
pub const MAX_AMOUNT: i128 = 1_000_000_000_000_000_000;
/// Smallest non-zero amount that may be put in one bin (0.001 unit).
pub const MIN_BIN_DEPOSIT: i128 = 10_000;
/// A bin whose live inventory is below `total_shares / DILUTION_LIMIT` refuses
/// new deposits (share-dilution guard), see `Error::BinDust`.
pub const DILUTION_LIMIT: i128 = 1_000_000;

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    /// amount <= 0 or above `MAX_AMOUNT`
    InvalidAmount = 2,
    /// lo > hi, bins outside [-200, 200], or more than `MAX_POSITION_BINS` bins
    InvalidRange = 3,
    /// weights length != number of bins, or all weights zero
    InvalidWeights = 4,
    /// constructor / admin parameter out of range
    InvalidConfig = 5,
    NoSuchPosition = 6,
    NotOwner = 7,
    /// the swap would move nothing (no liquidity, or the input buys zero output)
    NoLiquidity = 8,
    /// amount_out < min_out
    SlippageExceeded = 9,
    /// `Mode::TwoWay` on a pool that has a DeFindex vault
    NotImplemented = 10,
    Overflow = 11,
    /// a bin would receive less than `MIN_BIN_DEPOSIT`, or too little to mint a share
    AmountTooSmall = 12,
    /// the bin is almost filled (remaining inventory < total_shares / 1e6): pick another bin
    BinDust = 13,
    /// the DeFindex vault paid less than the pool needs, or its share price is zero
    VaultShortfall = 14,
    /// the owner already has `MAX_OWNER_POSITIONS` open positions
    TooManyPositions = 15,
}

// ---------------------------------------------------------------------------
// ABI types (see docs/pool-abi.md)
// ---------------------------------------------------------------------------

/// Ask: sells BASE as the price rises. Bid: buys BASE as the price falls.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Side {
    Ask,
    Bid,
}

/// Directional: one-way by construction. TwoWay: the liquidity rests on both
/// sides of its price (see `TwBin`), so the price coming back refills it;
/// only available on pools without a vault.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    Directional,
    TwoWay,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub base: Address,
    pub quote: Address,
    pub vault: Option<Address>,
    pub bin_step_bps: u32,
    pub fee_bps: u32,
    pub max_bins_per_swap: u32,
    pub supports_two_way: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BinView {
    pub side: Side,
    pub bin: i32,
    pub price: i128,
    /// BASE for Ask bins, QUOTE value (assets) for Bid bins
    pub inventory: i128,
    pub total_shares: i128,
    /// cumulative, only ever increases (same unit as `inventory`)
    pub filled: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Position {
    pub id: u64,
    pub owner: Address,
    pub side: Side,
    pub mode: Mode,
    pub lo_bin: i32,
    pub hi_bin: i32,
    pub deposited: i128,
    pub inventory: i128,
    pub filled: i128,
    pub pending_proceeds: i128,
    pub pending_fees: i128,
    pub vaulted: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PositionPayout {
    pub base: i128,
    pub quote: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapQuote {
    pub amount_out: i128,
    pub fee: i128,
    pub avg_price: i128,
    pub bins_crossed: u32,
    pub partial: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Tvl {
    pub base: i128,
    pub quote_value: i128,
    pub vault_shares: i128,
}

// ---------------------------------------------------------------------------
// storage records (internal)
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// instance
    Config,
    NextId,
    /// QUOTE units (DeFindex shares) the pool holds on behalf of accounts
    QuoteShares,
    Active(Side),
    /// two-way bins with BASE (`Ask`) or QUOTE (`Bid`) reserves
    ActiveTw(Side),
    /// persistent
    Bin(Side, i32),
    TwBin(i32),
    Sealed(Side, i32, u32),
    Position(u64),
    Owner(Address),
}

/// One bin on one side.
///
/// Units: `inventory` is BASE for Ask bins and "QUOTE units" for Bid bins
/// (QUOTE stroops when the pool has no vault, DeFindex vault shares when it
/// has one). `filled` and `acc_x` are in value terms (BASE for Ask, QUOTE
/// assets for Bid). `acc_p` / `acc_f` are per LP share, scaled by `ACC_SCALE`:
/// `acc_p` accumulates proceeds (QUOTE units for Ask, BASE for Bid), `acc_f`
/// accumulates fees (QUOTE units).
#[contracttype]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct BinRec {
    /// generation: bumped when a fully filled bin is reused (see `Sealed`)
    pub gen: u32,
    pub price: i128,
    pub inventory: i128,
    pub total_shares: i128,
    pub filled: i128,
    pub acc_x: i128,
    pub acc_p: i128,
    pub acc_f: i128,
}

/// A two-way bin (`Mode::TwoWay`): both assets rest at one price, so the bin
/// sells `x` BASE to buyers and buys BASE with `y` QUOTE from sellers. A fill
/// moves value from one reserve to the other (a buyer's QUOTE lands in `y`, a
/// seller's BASE lands in `x`), which is what lets the price come back through
/// the bin and refill it. LP shares are denominated in BASE value at the bin
/// price. Fees (QUOTE) accrue to the LPs through `acc_f`; there is no proceeds
/// accumulator because the proceeds stay in the reserves.
#[contracttype]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TwBin {
    pub price: i128,
    /// BASE reserve
    pub x: i128,
    /// QUOTE reserve
    pub y: i128,
    pub total_shares: i128,
    /// cumulative BASE traded through the bin in either direction
    pub filled: i128,
    pub acc_x: i128,
    pub acc_f: i128,
}

/// Final accumulators of a generation that was fully filled and then reused.
#[contracttype]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Sealed {
    pub acc_x: i128,
    pub acc_p: i128,
    pub acc_f: i128,
}

/// A position's stake in one bin (with the accumulator checkpoints taken when
/// the stake was created or last claimed).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PosEntry {
    pub bin: i32,
    pub gen: u32,
    pub shares: i128,
    pub ckpt_x: i128,
    pub ckpt_p: i128,
    pub ckpt_f: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PosRec {
    pub id: u64,
    pub owner: Address,
    pub side: Side,
    pub mode: Mode,
    pub lo_bin: i32,
    pub hi_bin: i32,
    /// assets deposited at creation (BASE for Ask, QUOTE for Bid)
    pub deposited: i128,
    pub entries: Vec<PosEntry>,
}

/// Bitmap of the bins with live inventory on one side: bit k is bin
/// `MIN_BIN + k` (k in 0..=400). Soroban storage cannot be iterated, so a swap
/// walks the book through this set instead.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ActiveSet {
    pub w0: u128,
    pub w1: u128,
    pub w2: u128,
    pub w3: u128,
}

impl ActiveSet {
    pub const fn empty() -> Self {
        ActiveSet {
            w0: 0,
            w1: 0,
            w2: 0,
            w3: 0,
        }
    }

    fn word(&self, i: u32) -> u128 {
        match i {
            0 => self.w0,
            1 => self.w1,
            2 => self.w2,
            _ => self.w3,
        }
    }

    fn set_word(&mut self, i: u32, v: u128) {
        match i {
            0 => self.w0 = v,
            1 => self.w1 = v,
            2 => self.w2 = v,
            _ => self.w3 = v,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.w0 == 0 && self.w1 == 0 && self.w2 == 0 && self.w3 == 0
    }

    pub fn contains(&self, bin: i32) -> bool {
        let k = (bin - MIN_BIN) as u32;
        (self.word(k / 128) >> (k % 128)) & 1 == 1
    }

    pub fn insert(&mut self, bin: i32) {
        let k = (bin - MIN_BIN) as u32;
        let w = self.word(k / 128) | (1u128 << (k % 128));
        self.set_word(k / 128, w);
    }

    pub fn remove(&mut self, bin: i32) {
        let k = (bin - MIN_BIN) as u32;
        let w = self.word(k / 128) & !(1u128 << (k % 128));
        self.set_word(k / 128, w);
    }

    /// Lowest set bin that is `>= from`.
    pub fn next_up(&self, from: i32) -> Option<i32> {
        if from > MAX_BIN {
            return None;
        }
        let k = (from.max(MIN_BIN) - MIN_BIN) as u32;
        let (wi, bit) = (k / 128, k % 128);
        let first = self.word(wi) & (u128::MAX << bit);
        if first != 0 {
            return Some((wi * 128 + first.trailing_zeros()) as i32 + MIN_BIN);
        }
        let mut j = wi + 1;
        while j < 4 {
            let w = self.word(j);
            if w != 0 {
                return Some((j * 128 + w.trailing_zeros()) as i32 + MIN_BIN);
            }
            j += 1;
        }
        None
    }

    /// Highest set bin that is `<= from`.
    pub fn next_down(&self, from: i32) -> Option<i32> {
        if from < MIN_BIN {
            return None;
        }
        let k = (from.min(MAX_BIN) - MIN_BIN) as u32;
        let (wi, bit) = (k / 128, k % 128);
        let mask = if bit == 127 {
            u128::MAX
        } else {
            (1u128 << (bit + 1)) - 1
        };
        let first = self.word(wi) & mask;
        if first != 0 {
            return Some((wi * 128 + 127 - first.leading_zeros()) as i32 + MIN_BIN);
        }
        let mut j = wi;
        while j > 0 {
            j -= 1;
            let w = self.word(j);
            if w != 0 {
                return Some((j * 128 + 127 - w.leading_zeros()) as i32 + MIN_BIN);
            }
        }
        None
    }
}
