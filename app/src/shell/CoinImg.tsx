// A coin's image (pump.fun CDN / IPFS) in a small framed tile; the ticker's first letters when it is missing or fails.
import { memo, useState } from 'react';
import { tick } from '../lib/format.ts';

function safeImg(u: string): string | null {
  if (!u) return null;
  if (u.startsWith('/')) return u;
  try {
    const x = new URL(u);
    return x.protocol === 'https:' ? x.href : null;
  } catch {
    return null;
  }
}

export const CoinImg = memo(function CoinImg({ src, symbol, size = 36, vt, vtName }: { src: string; symbol: string; size?: number; vt?: string; vtName?: string }) {
  const [bad, setBad] = useState(false);
  const url = bad ? null : safeImg(src);
  const letters = tick(symbol).slice(1, 3).toUpperCase();
  return (
    <span className="coin-img" style={{ width: size, height: size, viewTransitionName: vtName }} data-vt={vt} aria-hidden="true">
      {url ? (
        // an SVG <image>, not <img>: Safari (every iPhone browser) blanks an <img> under the dither filter
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <image href={url} width={size} height={size} preserveAspectRatio="xMidYMid slice" filter="url(#ff-dither)" onError={() => setBad(true)} />
        </svg>
      ) : (
        <b style={{ fontSize: Math.round(size * 0.36) }}>{letters}</b>
      )}
    </span>
  );
});
