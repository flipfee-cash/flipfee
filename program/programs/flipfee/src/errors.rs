use anchor_lang::prelude::*;

/// Custom errors. Anchor numbers them from 6000 in this order; the order is part of the client contract
/// (append new variants at the end).
#[error_code]
pub enum FlipfeeError {
    #[msg("Signer is not the program's upgrade authority")]
    NotUpgradeAuthority, // 6000
    #[msg("Signer is not the admin")]
    NotAdmin, // 6001
    #[msg("Signer is not the coin owner")]
    NotOwner, // 6002
    #[msg("fee_bps is above 1000 (10%)")]
    BadFeeBps, // 6003
    #[msg("Treasury must be a system-owned, rent-exempt account")]
    BadTreasury, // 6004
    #[msg("Account is not the config treasury")]
    WrongTreasury, // 6005
    #[msg("Account is not the coin owner")]
    WrongOwner, // 6006
    #[msg("flipfee is paused")]
    Paused, // 6007
    #[msg("Sales of this coin are paused")]
    CoinPaused, // 6008
    #[msg("Price per hour must be 0.01 to 1000 SOL")]
    PriceOutOfRange, // 6009
    #[msg("Hours ahead must be 1 to 48 (3600 to 172800 seconds)")]
    MaxAheadOutOfRange, // 6010
    #[msg("Buy 1 to 12 hours")]
    BadHours, // 6011
    #[msg("Price per hour is above max_price")]
    PriceAboveMax, // 6012
    #[msg("These hours end later than the coin sells ahead")]
    TooFarAhead, // 6013
    #[msg("The hour queue of this coin is full")]
    QueueFull, // 6014
    #[msg("Account is not this mint's pump.fun sharing config")]
    NotSharingConfig, // 6015
    #[msg("pump.fun fee sharing of this coin is not active")]
    SharingNotActive, // 6016
    #[msg("pump.fun fee split is not final yet (admin not revoked)")]
    SplitNotFinal, // 6017
    #[msg("pump.fun fee split does not send 100% to the flipfee vault")]
    SplitNotToVault, // 6018
    #[msg("Signer is not the pump.fun fee sharing admin of this coin")]
    NotFeeAdmin, // 6019
    #[msg("Account is not this mint's pump.fun bonding curve")]
    NotBondingCurve, // 6020
    #[msg("Bonding curve creator is not the sharing config: fees do not route to flipfee")]
    CurveNotRouted, // 6021
    #[msg("Only SOL-paired coins are supported")]
    NotSolPaired, // 6022
    #[msg("Cashback coins pay no creator fee")]
    CashbackCoin, // 6023
    #[msg("Mint is not owned by a token program")]
    BadMint, // 6024
    #[msg("Vault must be a system account with no data")]
    BadVault, // 6025
    #[msg("New owner must be a non-executable account other than the vault")]
    BadNewOwner, // 6026
    #[msg("Recipient account must be writable")]
    RecipientNotWritable, // 6027
    #[msg("The owner cannot receive what is owed (account would stay below rent-exempt)")]
    OwnerCannotReceive, // 6028
    #[msg("Vault holds less than rent plus what is owed")]
    VaultShort, // 6029
    #[msg("Math overflow")]
    MathOverflow, // 6030
    #[msg("Graduated coin: its PumpSwap pool does not pay the sharing config")]
    PoolNotRouted, // 6031
    #[msg("pump.fun still holds fees of this coin: distribute them (and sweep PumpSwap's) before buying, in the same transaction")]
    FeesNotCollected, // 6032
    #[msg("Holder-rewards coins pay their creator fee to holders")]
    HolderRewardCoin, // 6033
    #[msg("These hours would start later than max_start")]
    StartsTooLate, // 6034
    #[msg("Account is not this coin's pump.fun creator vault")]
    WrongPumpVault, // 6035
}
