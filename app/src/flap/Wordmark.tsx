// The flipfee wordmark: the dithered coin, which flips on load and on hover, and
// "flipfee" in dot-matrix letters; ".cash" in ink beside it: flip fee → cash.
import { DitherCoin } from '../dither/DitherCoin.tsx';

export function Wordmark({ size = 'md', cash = true }: { size?: 'md' | 'sm'; cash?: boolean }) {
  const px = size === 'md' ? 28 : 22;
  return (
    <span className={'wordmark wordmark-' + size}>
      <DitherCoin n={px} size={px} mode="flip" className="wm-coin" />
      <span className="wm-word">flipfee</span>
      {cash && (
        <span className="wm-cash" aria-hidden="true">
          .cash
        </span>
      )}
    </span>
  );
}
