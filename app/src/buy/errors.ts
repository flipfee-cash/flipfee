// One plain sentence per transaction failure (copy.err).
import { copy, fill } from '../copy.ts';
import type { TxCode } from '../chain/tx.ts';
import { solPlain } from '../lib/format.ts';

export function errCopy(code: TxCode, needSol = 0): string {
  switch (code) {
    case 'rejected':
      return copy.err.rejected;
    case 'funds':
      return fill(copy.err.funds, { sol: solPlain(needSol + 0.002) });
    case 'price':
      return copy.err.price;
    case 'sold':
      return copy.err.sold;
    case 'paused':
      return copy.err.paused;
    case 'ahead':
      return copy.err.ahead;
    case 'elig':
      return fill(copy.err.elig);
    case 'network':
      return copy.err.network;
    case 'setup':
      return copy.err.setup;
    case 'timeout':
      return copy.err.timeout;
    case 'chain':
      return copy.err.chain;
    default:
      return copy.err.generic;
  }
}
