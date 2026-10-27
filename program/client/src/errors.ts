import { FLIPFEE_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_FEES_PROGRAM_ID, PUMP_PROGRAM_ID } from './constants.js';
import { PROGRAM_ERRORS } from './generated.js';

export type FlipfeeErrorName = (typeof PROGRAM_ERRORS)[number]['name'];
export const FLIPFEE_ERRORS = PROGRAM_ERRORS;

export interface DecodedError {
  code: number;
  name: string;
  msg: string;
  /** 'program' = a flipfee error (6000+), 'anchor' = an Anchor account check, 'pump' = pump / Pump Fees / PumpSwap,
   * 'system' = the System program (e.g. not enough SOL). */
  source: 'program' | 'anchor' | 'pump' | 'system';
}

/** The Anchor framework errors a flipfee client can meet (account checks). */
const ANCHOR_ERRORS: Record<number, [string, string]> = {
  2000: ['ConstraintMut', 'A mut constraint was violated'],
  2001: ['ConstraintHasOne', 'A has one constraint was violated'],
  2002: ['ConstraintSigner', 'A signer constraint was violated'],
  2003: ['ConstraintRaw', 'A raw constraint was violated'],
  2006: ['ConstraintSeeds', 'A seeds constraint was violated (wrong PDA for this mint)'],
  2012: ['ConstraintAddress', 'An address constraint was violated'],
  3001: ['AccountDiscriminatorNotFound', 'No discriminator was found on the account'],
  3002: ['AccountDiscriminatorMismatch', 'Account discriminator did not match what was expected'],
  3003: ['AccountDidNotDeserialize', 'Failed to deserialize the account'],
  3007: ['AccountOwnedByWrongProgram', 'The given account is owned by a different program than expected'],
  3010: ['AccountNotSigner', 'The given account did not sign'],
  3012: ['AccountNotInitialized', 'The account does not exist (coin not on flipfee, or config not initialized)'],
};

const PUMP_FEES_ERRORS: Record<number, string> = {
  6000: 'UnauthorizedProgram', 6001: 'InvalidAdmin', 6002: 'NoFeeTiers', 6003: 'TooManyFeeTiers',
  6004: 'OffsetNotContinuous', 6005: 'FeeTiersNotSorted', 6006: 'InvalidFeeTotal', 6007: 'InvalidSharingConfig',
  6008: 'InvalidPool', 6009: 'SharingConfigAdminRevoked', 6010: 'NoShareholders', 6011: 'TooManyShareholders',
  6012: 'DuplicateShareholder', 6013: 'NotEnoughRemainingAccounts', 6014: 'InvalidShareTotal',
  6015: 'ShareCalculationOverflow', 6016: 'NotAuthorized', 6017: 'ZeroShareNotAllowed', 6018: 'SharingConfigNotActive',
  6019: 'AmmAccountsRequiredForGraduatedCoin', 6020: 'ShareholderAccountMismatch', 6021: 'FeatureDeactivated',
  6022: 'UserIdTooLong', 6023: 'DeprecatedInstruction', 6024: 'FeeSharesAlreadyUpdated', 6025: 'MathOverflow',
  6026: 'InvalidBuybackIndex', 6027: 'ClaimRateLimitExceeded', 6028: 'InvalidFeeConfigAccount',
  6029: 'AccountTypeNotSupported', 6030: 'InvalidMint', 6031: 'UnsupportedQuoteMint', 6032: 'InvalidRemainingAccounts',
};

const PUMP_ERRORS: Record<number, string> = {
  6000: 'NotAuthorized', 6002: 'TooMuchSolRequired', 6003: 'TooLittleSolReceived', 6005: 'BondingCurveComplete',
  6020: 'BuyZeroAmount', 6021: 'NotEnoughTokensToBuy', 6022: 'SellZeroAmount', 6023: 'NotEnoughTokensToSell',
  6027: 'NotEnoughRemainingAccounts', 6049: 'CreatorMigratedToSharingConfig',
  6050: 'UnableToDistributeCreatorVaultMigratedToSharingConfig', 6051: 'SharingConfigNotActive',
  6052: 'UnableToDistributeCreatorFeesToExecutableRecipient', 6053: 'BondingCurveAndSharingConfigCreatorMismatch',
  6054: 'ShareholdersAndRemainingAccountsMismatch', 6055: 'InvalidShareBps', 6063: 'UnsupportedQuoteMint',
  6070: 'UnableToDistributeCreatorFeesToUninitializedAccount',
};

/** Looks up a custom error code of flipfee (or an Anchor account check). */
export function flipfeeErrorFromCode(code: number): DecodedError | null {
  const p = PROGRAM_ERRORS.find((e) => e.code === code);
  if (p) return { code, name: p.name, msg: p.msg, source: 'program' };
  const a = ANCHOR_ERRORS[code];
  if (a) return { code, name: a[0], msg: a[1], source: 'anchor' };
  return null;
}

function fromProgram(program: string | null, code: number, flipfee: string): DecodedError | null {
  if (program === null || program === flipfee) return flipfeeErrorFromCode(code);
  if (program === PUMP_FEES_PROGRAM_ID.toBase58()) {
    const n = PUMP_FEES_ERRORS[code];
    return { code, name: n ?? `PumpFeesError${code}`, msg: `pump.fun fee sharing: ${n ?? code}`, source: 'pump' };
  }
  if (program === PUMP_PROGRAM_ID.toBase58() || program === PUMP_AMM_PROGRAM_ID.toBase58()) {
    const n = program === PUMP_PROGRAM_ID.toBase58() ? PUMP_ERRORS[code] : undefined;
    const a = ANCHOR_ERRORS[code];
    return { code, name: n ?? a?.[0] ?? `PumpError${code}`, msg: `pump.fun: ${n ?? a?.[1] ?? code}`, source: 'pump' };
  }
  return flipfeeErrorFromCode(code);
}

/**
 * Best-effort decoding of a failed send/simulation: accepts a web3.js `SendTransactionError` (or anything with
 * `logs` / `transactionLogs`), a `{ InstructionError: [i, { Custom: n }] }` value, or an error whose message contains
 * "custom program error: 0x…". With logs, the failing program decides the table (flipfee, pump, Pump Fees).
 */
export function parseFlipfeeError(err: unknown, programId = FLIPFEE_PROGRAM_ID.toBase58()): DecodedError | null {
  if (err == null) return null;
  const e = err as { logs?: string[]; transactionLogs?: string[]; message?: string; InstructionError?: [number, unknown]; err?: unknown };
  const logs: string[] = [...(e.logs ?? []), ...(e.transactionLogs ?? [])];
  for (const l of logs) {
    const m = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed: custom program error: (0x[0-9a-fA-F]+)/.exec(l);
    if (m) return fromProgram(m[1]!, parseInt(m[2]!, 16), programId);
  }
  if (logs.some((l) => /insufficient lamports|Transfer: insufficient/.test(l))) {
    return { code: 1, name: 'InsufficientFunds', msg: 'Not enough SOL in the wallet', source: 'system' };
  }
  if (logs.some((l) => /already in use/.test(l))) {
    return { code: 0, name: 'AlreadyRegistered', msg: 'This coin is already on flipfee', source: 'system' };
  }
  for (const l of logs) {
    const n = /Error Number: (\d+)\./.exec(l);
    if (n) return flipfeeErrorFromCode(Number(n[1]));
  }
  const ie = e.InstructionError ?? (e.err as { InstructionError?: [number, unknown] } | undefined)?.InstructionError;
  if (ie) {
    const custom = (ie[1] as { Custom?: number } | undefined)?.Custom;
    if (typeof custom === 'number') return flipfeeErrorFromCode(custom);
  }
  if (typeof e.message === 'string') {
    const m = /custom program error: (0x[0-9a-fA-F]+)/.exec(e.message);
    if (m) return flipfeeErrorFromCode(parseInt(m[1]!, 16));
  }
  return null;
}
