use anchor_lang::prelude::*;

use crate::{constants::*, errors::FlipfeeError};

/// Global settings, PDA `["config"]`. Field order follows DESIGN §2.1.
#[account]
#[derive(InitSpace, Debug)]
pub struct Config {
    pub admin: Pubkey,
    /// Receives `fee_bps` of every hour sale. System-owned and rent-exempt.
    pub treasury: Pubkey,
    /// flipfee's cut of an hour sale (500 = 5%, at most 1000).
    pub fee_bps: u16,
    /// Stops `register` and `buy`. Syncs and payouts never stop.
    pub paused: bool,
    pub bump: u8,
}

/// One sold stretch of time: every fee allocated to a second in `[start, end)` belongs to `holder`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Window {
    pub holder: Pubkey,
    pub start: i64,
    pub end: i64,
    /// Allocated to this window and not paid yet.
    pub owed: u64,
    /// Allocated to this window in total.
    pub earned: u64,
}

/// One coin on flipfee, PDA `["coin", mint]`. Field order follows DESIGN §2.1.
///
/// Money: the vault `["vault", mint]` holds `rent_min + credited + unallocated`, where `credited =
/// owner_owed + Σ windows.owed` (allocated, not paid yet) and `unallocated` is what arrived from pump since the
/// last sync.
#[account]
#[derive(InitSpace, Debug)]
pub struct Coin {
    pub mint: Pubkey,
    /// The dev: gets the hour sales (minus the fee) and every fee outside sold hours.
    pub owner: Pubkey,
    pub bump: u8,
    pub vault_bump: u8,
    /// Lamports per hour (0.01 ..= 1000 SOL).
    pub price: u64,
    /// Seconds from now to the end of the last sold hour, at most (3600 ..= 172800).
    pub max_ahead: u32,
    /// Stops `buy` of this coin. Syncs and payouts never stop.
    pub paused: bool,
    /// Fees in the vault are allocated up to this time.
    pub last_sync: i64,
    pub owner_owed: u64,
    /// Σ owed not yet paid (`owner_owed + Σ windows.owed`). The vault holds at least `rent_min + credited`.
    pub credited: u64,
    /// Sorted by `start`, never overlapping. Live, queued, and ended windows not yet fully paid.
    #[max_len(32)]
    pub windows: Vec<Window>,
    /// Lamports allocated in total (Σ of every sync, plus the vault balance carried at `register`).
    pub fees_in: u64,
    /// Lamports buyers paid in total (`Σ price × hours`, fee included).
    pub sales: u64,
    pub hours_sold: u32,
    /// Lamports the vault paid out in total (owner + holders).
    pub paid_out: u64,
}

/// What one sync allocated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Synced {
    pub amount: u64,
    pub from: i64,
    pub to: i64,
    pub to_owner: u64,
    pub to_windows: u64,
}

/// Splits `amount` over the time interval `(from, to]` (`from < to`) by overlap seconds: a window `[start, end)`
/// gets `floor(amount × overlap / (to − from))`, the rest (time outside sold hours and rounding remainders) is the
/// owner's. Windows never overlap each other, so the window parts never exceed `amount`. u128 intermediates.
/// Returns `(to_windows, to_owner)`.
pub fn allocate(windows: &mut [Window], amount: u64, from: i64, to: i64) -> Result<(u64, u64)> {
    require!(to > from, FlipfeeError::MathOverflow);
    let span = u128::try_from(to - from).map_err(|_| error!(FlipfeeError::MathOverflow))?;
    let mut to_windows: u64 = 0;
    for w in windows.iter_mut() {
        let lo = w.start.max(from);
        let hi = w.end.min(to);
        if hi <= lo {
            continue;
        }
        let overlap = u128::try_from(hi - lo).map_err(|_| error!(FlipfeeError::MathOverflow))?;
        let share = u128::from(amount)
            .checked_mul(overlap)
            .and_then(|x| x.checked_div(span))
            .ok_or(FlipfeeError::MathOverflow)?;
        let share = u64::try_from(share).map_err(|_| error!(FlipfeeError::MathOverflow))?;
        w.owed = w.owed.checked_add(share).ok_or(FlipfeeError::MathOverflow)?;
        w.earned = w.earned.checked_add(share).ok_or(FlipfeeError::MathOverflow)?;
        to_windows = to_windows.checked_add(share).ok_or(FlipfeeError::MathOverflow)?;
    }
    let to_owner = amount.checked_sub(to_windows).ok_or(FlipfeeError::MathOverflow)?;
    Ok((to_windows, to_owner))
}

/// `total × bps / 10000`, rounded down (u128 intermediate).
pub fn bps_of(total: u64, bps: u16) -> Result<u64> {
    let v = u128::from(total)
        .checked_mul(u128::from(bps))
        .and_then(|x| x.checked_div(u128::from(BPS)))
        .ok_or(FlipfeeError::MathOverflow)?;
    u64::try_from(v).map_err(|_| error!(FlipfeeError::MathOverflow))
}

pub fn check_price(price: u64) -> Result<()> {
    require!((MIN_PRICE..=MAX_PRICE).contains(&price), FlipfeeError::PriceOutOfRange);
    Ok(())
}

pub fn check_max_ahead(max_ahead: u32) -> Result<()> {
    require!((MIN_MAX_AHEAD..=MAX_MAX_AHEAD).contains(&max_ahead), FlipfeeError::MaxAheadOutOfRange);
    Ok(())
}

impl Coin {
    /// Allocates what arrived in the vault since the last sync: `new = vault − rent_min − credited` over
    /// `(last_sync, now]`, then `last_sync = now`. When no time passed since the last sync (`now ≤ last_sync`, e.g. a
    /// second sync in the same second), `new` is allocated over the one second `(now − 1, now]`, so it goes to whoever
    /// held the second that just passed (never to the owner by default).
    pub fn sync(&mut self, vault_lamports: u64, rent_min: u64, now: i64) -> Result<Option<Synced>> {
        let held = rent_min.checked_add(self.credited).ok_or(FlipfeeError::MathOverflow)?;
        let amount = vault_lamports.saturating_sub(held);
        let (from, to) = if now > self.last_sync {
            (self.last_sync, now)
        } else {
            (now.checked_sub(1).ok_or(FlipfeeError::MathOverflow)?, now)
        };
        self.last_sync = self.last_sync.max(now);
        if amount == 0 {
            return Ok(None);
        }
        let (to_windows, to_owner) = allocate(&mut self.windows, amount, from, to)?;
        self.owner_owed = self.owner_owed.checked_add(to_owner).ok_or(FlipfeeError::MathOverflow)?;
        self.credited = self.credited.checked_add(amount).ok_or(FlipfeeError::MathOverflow)?;
        self.fees_in = self.fees_in.checked_add(amount).ok_or(FlipfeeError::MathOverflow)?;
        Ok(Some(Synced {
            amount,
            from,
            to,
            to_owner,
            to_windows,
        }))
    }

    /// Where the next sold hours start: now, or the end of the last sold window if that is later.
    pub fn next_start(&self, now: i64) -> i64 {
        self.windows.last().map_or(now, |w| w.end.max(now))
    }

    /// Removes the windows that ended strictly before `last_sync` and are fully paid; returns them. Strictly: a sync
    /// in the same second as `last_sync` still allocates over `(last_sync − 1, last_sync]`, which a window ending at
    /// `last_sync` overlaps, so such a window must stay until a later second.
    pub fn prune(&mut self) -> Vec<Window> {
        let last_sync = self.last_sync;
        let mut done = Vec::new();
        self.windows.retain(|w| {
            let finished = w.end < last_sync && w.owed == 0;
            if finished {
                done.push(*w);
            }
            !finished
        });
        done
    }

    /// `credited == owner_owed + Σ windows.owed` (checked by the tests after every instruction).
    pub fn owed_total(&self) -> Option<u64> {
        self.windows.iter().try_fold(self.owner_owed, |s, w| s.checked_add(w.owed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(holder: u8, start: i64, end: i64) -> Window {
        Window {
            holder: Pubkey::new_from_array([holder; 32]),
            start,
            end,
            owed: 0,
            earned: 0,
        }
    }

    fn coin(last_sync: i64, windows: Vec<Window>) -> Coin {
        Coin {
            mint: Pubkey::new_from_array([1; 32]),
            owner: Pubkey::new_from_array([2; 32]),
            bump: 255,
            vault_bump: 254,
            price: MIN_PRICE,
            max_ahead: 86_400,
            paused: false,
            last_sync,
            owner_owed: 0,
            credited: 0,
            windows,
            fees_in: 0,
            sales: 0,
            hours_sold: 0,
            paid_out: 0,
        }
    }

    #[test]
    fn allocate_by_overlap_seconds() {
        // interval (1000, 1100]; window A [1050, 1080) overlaps 30 s, window B [1080, 4680) overlaps 20 s.
        let mut ws = vec![w(1, 1050, 1080), w(2, 1080, 4680)];
        let (to_w, to_o) = allocate(&mut ws, 1_000_000, 1000, 1100).unwrap();
        assert_eq!(ws[0].owed, 300_000);
        assert_eq!(ws[1].owed, 200_000);
        assert_eq!(to_w, 500_000);
        assert_eq!(to_o, 500_000);
        assert_eq!(ws[0].earned, ws[0].owed);
    }

    #[test]
    fn allocate_rounds_down_and_owner_gets_the_rest() {
        let mut ws = vec![w(1, 0, 1), w(2, 1, 2), w(3, 2, 3)];
        let (to_w, to_o) = allocate(&mut ws, 100, 0, 3).unwrap();
        assert_eq!([ws[0].owed, ws[1].owed, ws[2].owed], [33, 33, 33]);
        assert_eq!((to_w, to_o), (99, 1));
        // u128 intermediates: u64::MAX lamports over a long interval do not overflow
        let mut ws = vec![w(1, 0, 172_800)];
        let (to_w, to_o) = allocate(&mut ws, u64::MAX, -172_800, 172_800).unwrap();
        assert_eq!(to_w, u64::MAX / 2);
        assert_eq!(to_w + to_o, u64::MAX);
    }

    #[test]
    fn allocate_ignores_windows_outside() {
        let mut ws = vec![w(1, 0, 100), w(2, 200, 300)];
        let (to_w, to_o) = allocate(&mut ws, 77, 100, 200).unwrap();
        assert_eq!((to_w, to_o), (0, 77));
        assert!(allocate(&mut ws, 1, 5, 5).is_err(), "empty interval is an error, not a division by zero");
    }

    #[test]
    fn sync_allocates_new_lamports_once() {
        let mut c = coin(1000, vec![w(9, 1000, 4600)]);
        let rent = 650_240;
        // nothing arrived
        assert_eq!(c.sync(rent, rent, 1010).unwrap(), None);
        assert_eq!(c.last_sync, 1010);
        // 600 arrived, all inside the window
        let s = c.sync(rent + 600, rent, 1070).unwrap().unwrap();
        assert_eq!(s, Synced { amount: 600, from: 1010, to: 1070, to_owner: 0, to_windows: 600 });
        assert_eq!(c.credited, 600);
        // the same balance again: idempotent
        assert_eq!(c.sync(rent + 600, rent, 1080).unwrap(), None);
        assert_eq!(c.credited, 600);
        assert_eq!(c.owed_total(), Some(600));
        assert_eq!(c.fees_in, 600);
    }

    #[test]
    fn sync_in_the_same_second_uses_the_second_that_passed() {
        let mut c = coin(5000, vec![w(9, 4000, 5000), w(8, 5000, 8600)]);
        let rent = 1;
        // now == last_sync: (4999, 5000] belongs to window 9 (its last second)
        let s = c.sync(rent + 50, rent, 5000).unwrap().unwrap();
        assert_eq!((s.from, s.to), (4999, 5000));
        assert_eq!(c.windows[0].owed, 50);
        assert_eq!(c.windows[1].owed, 0);
        assert_eq!(c.owner_owed, 0);
        // a clock that went back never moves last_sync back
        let _ = c.sync(rent + 50, rent, 4990).unwrap();
        assert_eq!(c.last_sync, 5000);
    }

    #[test]
    fn next_start_and_prune() {
        let mut c = coin(100, vec![]);
        assert_eq!(c.next_start(100), 100);
        c.windows = vec![w(1, 0, 50), w(2, 50, 150)];
        assert_eq!(c.next_start(100), 150);
        assert_eq!(c.next_start(200), 200);
        c.windows[0].owed = 1;
        assert!(c.prune().is_empty(), "owed windows stay");
        c.windows[0].owed = 0;
        let done = c.prune();
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].holder, Pubkey::new_from_array([1; 32]));
        assert_eq!(c.windows.len(), 1, "window 2 has not ended at last_sync");
        c.last_sync = 150;
        assert!(c.prune().is_empty(), "a window ending at last_sync stays one more second");
        c.last_sync = 151;
        assert_eq!(c.prune().len(), 1);
    }

    #[test]
    fn bounds_and_bps() {
        assert!(check_price(MIN_PRICE).is_ok());
        assert!(check_price(MAX_PRICE).is_ok());
        assert!(check_price(MIN_PRICE - 1).is_err());
        assert!(check_price(MAX_PRICE + 1).is_err());
        assert!(check_max_ahead(3_600).is_ok());
        assert!(check_max_ahead(172_800).is_ok());
        assert!(check_max_ahead(3_599).is_err());
        assert!(check_max_ahead(172_801).is_err());
        assert_eq!(bps_of(300_000_000, 500).unwrap(), 15_000_000);
        assert_eq!(bps_of(10_000_001, 500).unwrap(), 500_000);
        assert_eq!(bps_of(u64::MAX, 1_000).unwrap(), u64::MAX / 10);
    }
}
