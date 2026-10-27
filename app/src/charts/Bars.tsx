// A bar chart in the paper-and-ink style: one series, bars in ink with a 2 px paper gap; a bar can be solid (marked)
// or a 50% dither (unmarked), named in the legend. Hover or focus a bar for its value. A hidden table carries the
// numbers for screen readers.
import { useState } from 'react';

export interface Bar {
  label: string;
  value: number;
  /** solid ink (true) or dither (false) */
  solid?: boolean;
  tip: string;
}

export function Bars({ bars, height = 160, title, legend, every = 1 }: { bars: Bar[]; height?: number; title: string; legend?: [string, string]; every?: number }) {
  const [hot, setHot] = useState<number | null>(null);
  const max = Math.max(...bars.map((b) => b.value), 1e-9);
  return (
    <figure className="chart">
      {legend && (
        <figcaption className="chart-legend">
          <span>
            <i className="lg-solid" />
            {legend[0]}
          </span>
          <span>
            <i className="lg-dither" />
            {legend[1]}
          </span>
        </figcaption>
      )}
      <div className="chart-plot" style={{ height }} onMouseLeave={() => setHot(null)}>
        {/* bars as boxes, so the dither keeps square dots at any width */}
        <div className="chart-bars" aria-hidden="true">
          {bars.map((b, i) => (
            <i key={i} className={'chart-bar' + (b.solid === false ? ' is-dither' : '') + (hot === i ? ' is-hot' : '')} style={{ height: Math.max(1.5, (b.value / max) * 94) + '%' }} />
          ))}
        </div>
        <div className="chart-hits">
          {bars.map((b, i) => (
            <button key={i} type="button" className="chart-hit" aria-label={b.tip} onMouseEnter={() => setHot(i)} onFocus={() => setHot(i)} onBlur={() => setHot(null)} />
          ))}
        </div>
        {hot !== null && (
          <span className="chart-tip mono" style={{ left: `${((hot + 0.5) / bars.length) * 100}%` }}>
            {bars[hot].tip}
          </span>
        )}
      </div>
      <div className="chart-axis mono" aria-hidden="true">
        {bars.map((b, i) => (
          <span key={i}>{i % every === 0 ? b.label : ''}</span>
        ))}
      </div>
      <table className="sr">
        <caption>{title}</caption>
        <tbody>
          {bars.map((b, i) => (
            <tr key={i}>
              <th scope="row">{b.label}</th>
              <td>{b.tip}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
