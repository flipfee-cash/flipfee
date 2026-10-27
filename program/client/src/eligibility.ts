import type { Connection, PublicKey } from '@solana/web3.js';

import { type Address, toPublicKey } from './codec.js';
import { FLIPFEE_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_FEES_PROGRAM_ID, PUMP_PROGRAM_ID, WSOL_MINT } from './constants.js';
import { findBondingCurvePda, findCanonicalPoolPda, findCoinPda, findSharingConfigPda, findVaultPda } from './pda.js';
import {
  type BondingCurveAccount,
  type PoolAccount,
  type SharingConfigAccount,
  decodeBondingCurve,
  decodePool,
  decodeSharingConfig,
  isSolPaired,
} from './pump.js';

export type EligibilityKind =
  | 'ready-new'
  | 'ready'
  | 'almost'
  | 'locked'
  | 'flipfee'
  | 'usdc'
  | 'not-admin'
  | 'unsupported'
  | 'not-found';

export interface Eligibility {
  /**
   * - `ready-new`: no sharing config, `wallet` is the curve creator (or `pool.coin_creator` once graduated):
   *   connect = create config + split + register (one transaction).
   * - `ready`: sharing config with the split not final, `wallet` is its admin: connect = split + register.
   * - `almost`: the split already sends 100% to the flipfee vault, no Coin account, `wallet` is the admin: register.
   * - `flipfee`: on flipfee.
   * - `locked`: the final split goes elsewhere (or a pump.fun takeover moved the creator): Want / Share only.
   * - `usdc`: not SOL-paired.
   * - `not-admin`: `wallet` (or no wallet) cannot connect it.
   * - `unsupported`: cashback or holder-rewards coin, or fee sharing paused by pump.fun (`reason`).
   * - `not-found`: no pump bonding curve for this mint.
   */
  kind: EligibilityKind;
  /** Who can act on pump: `sharing_config.admin`, else the curve's (or pool's) creator. */
  admin: PublicKey | null;
  /** The curve sold out; the coin trades on PumpSwap. */
  graduated: boolean;
  /** WSOL_MINT for a SOL-paired coin. */
  quoteMint: PublicKey;
  sharingConfig: PublicKey;
  vault: PublicKey;
  coin: PublicKey;
  /** A flipfee Coin account exists. */
  registered: boolean;
  reason?: string;
  /** Raw pump state (for the connect builder and the UI). */
  curve: BondingCurveAccount | null;
  sharing: SharingConfigAccount | null;
  pool: PoolAccount | null;
}

/** DESIGN §2.4: what `wallet` can do with `mint` on flipfee, read from chain. */
export async function eligibility(
  conn: Connection,
  mint: Address,
  wallet?: Address | null,
  opts: { programId?: Address } = {},
): Promise<Eligibility> {
  const programId = toPublicKey(opts.programId ?? FLIPFEE_PROGRAM_ID);
  const curveAddr = findBondingCurvePda(mint)[0];
  const sharingConfig = findSharingConfigPda(mint)[0];
  const vault = findVaultPda(mint, programId)[0];
  const coin = findCoinPda(mint, programId)[0];
  const poolAddr = findCanonicalPoolPda(mint)[0];
  const [curveInfo, scInfo, coinInfo, poolInfo] = await conn.getMultipleAccountsInfo([curveAddr, sharingConfig, coin, poolAddr], 'confirmed');
  const me = wallet ? toPublicKey(wallet) : null;
  const base = {
    admin: null as PublicKey | null,
    graduated: false,
    quoteMint: WSOL_MINT,
    sharingConfig,
    vault,
    coin,
    registered: !!coinInfo && coinInfo.owner.equals(programId),
    curve: null as BondingCurveAccount | null,
    sharing: null as SharingConfigAccount | null,
    pool: null as PoolAccount | null,
  };
  if (!curveInfo || !curveInfo.owner.equals(PUMP_PROGRAM_ID)) return { ...base, kind: 'not-found' };
  const curve = decodeBondingCurve(curveInfo.data);
  const sharing = scInfo && scInfo.owner.equals(PUMP_FEES_PROGRAM_ID) ? decodeSharingConfig(scInfo.data) : null;
  const pool = poolInfo && poolInfo.owner.equals(PUMP_AMM_PROGRAM_ID) ? decodePool(poolInfo.data) : null;
  const e = {
    ...base,
    curve,
    sharing,
    pool,
    graduated: curve.complete,
    quoteMint: isSolPaired(curve) ? WSOL_MINT : curve.quoteMint,
    admin: sharing ? sharing.admin : curve.complete && pool ? pool.coinCreator : curve.creator,
  };
  const isMe = (k: PublicKey | null) => !!me && !!k && k.equals(me);

  if (e.registered) return { ...e, kind: 'flipfee' };
  if (!isSolPaired(curve)) return { ...e, kind: 'usdc' };
  if (curve.isCashbackCoin) return { ...e, kind: 'unsupported', reason: 'cashback coin: its creator fee goes to traders' };
  if (curve.isHolderReward) return { ...e, kind: 'unsupported', reason: 'holder-rewards coin: its creator fee goes to holders' };

  if (!sharing) return { ...e, kind: isMe(e.admin) ? 'ready-new' : 'not-admin' };
  if (!curve.creator.equals(sharingConfig) || (curve.complete && pool && !pool.coinCreator.equals(sharingConfig))) {
    return { ...e, kind: 'locked', reason: 'the coin creator no longer points at its sharing config (pump.fun takeover)' };
  }
  if (sharing.status !== 'Active') return { ...e, kind: 'unsupported', reason: 'pump.fun paused fee sharing of this coin' };
  const toVault =
    sharing.shareholders.length === 1 && sharing.shareholders[0]!.address.equals(vault) && sharing.shareholders[0]!.shareBps === 10_000;
  if (sharing.adminRevoked) {
    if (!toVault) return { ...e, kind: 'locked' };
    return { ...e, kind: isMe(sharing.admin) ? 'almost' : 'not-admin' };
  }
  return { ...e, kind: isMe(sharing.admin) ? 'ready' : 'not-admin' };
}
