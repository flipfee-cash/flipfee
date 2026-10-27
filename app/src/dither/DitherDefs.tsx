// One SVG filter for every coin image: grey levels, a 4×4 Bayer screen, a hard
// threshold, then ink on paper. It runs in the compositor on cross-origin images (nothing reads the pixels back).
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const tile =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='4' height='4' shape-rendering='crispEdges'>" +
  BAYER4.map((b, i) => {
    const g = Math.round(((b + 0.5) / 16) * 255);
    return `<rect x='${i % 4}' y='${Math.floor(i / 4)}' width='1' height='1' fill='rgb(${g},${g},${g})'/>`;
  }).join('') +
  '</svg>';

// paper #F7F7F3 for light cells, ink #1F2BFF for dark ones
const P = [0.9686, 0.9686, 0.9529];
const I = [0.1216, 0.1686, 1];
const tone = P.map((p, k) => [p - I[k], I[k]]);

export function DitherDefs() {
  return (
    <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: 'absolute', width: 0, height: 0 }}>
      <filter id="ff-dither" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feColorMatrix in="SourceGraphic" type="matrix" values="0.3 0.59 0.11 0 0 0.3 0.59 0.11 0 0 0.3 0.59 0.11 0 0 0 0 0 1 0" result="g" />
        <feComponentTransfer in="g" result="gc">
          <feFuncR type="linear" slope="1.3" intercept="-0.08" />
          <feFuncG type="linear" slope="1.3" intercept="-0.08" />
          <feFuncB type="linear" slope="1.3" intercept="-0.08" />
        </feComponentTransfer>
        <feImage href={tile} x="0" y="0" width="4" height="4" result="b" />
        <feTile in="b" result="bt" />
        <feComposite in="gc" in2="bt" operator="arithmetic" k1="0" k2="1" k3="-1" k4="0.5" result="d" />
        <feComponentTransfer in="d" result="bw">
          <feFuncR type="discrete" tableValues="0 1" />
          <feFuncG type="discrete" tableValues="0 1" />
          <feFuncB type="discrete" tableValues="0 1" />
        </feComponentTransfer>
        <feColorMatrix in="bw" type="matrix" values={`${tone[0][0]} 0 0 0 ${tone[0][1]} 0 ${tone[1][0]} 0 0 ${tone[1][1]} 0 0 ${tone[2][0]} 0 ${tone[2][1]} 0 0 0 1 0`} />
      </filter>
    </svg>
  );
}
