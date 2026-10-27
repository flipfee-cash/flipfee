// A line chart in the paper-and-ink style: one series, a 2 px ink line over a dithered area, a zero line when the
// values cross it. Hover the plot for a crosshair and the value of the nearest point. A hidden table has the numbers.
import { useRef, useState } from 'react';

export interface Pt {
  label: string;
  value: number;
  tip: string;
}

export function Line({ points, height = 160, title, every = 5 }: { points: Pt[]; height?: number; title: string; every?: number }) {
  const [hot, setHot] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const vals = points.map((p) => p.value);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const x = (i: number) => (i / Math.max(1, points.length - 1)) * 100;
  const y = (v: number) => 96 - ((v - lo) / span) * 90;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)} ${y(p.value)}`).join(' ');
  const area = `${d} L100 ${y(0)} L0 ${y(0)} Z`;
  const onMove = (e: React.PointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setHot(Math.max(0, Math.min(points.length - 1, Math.round(((e.clientX - r.left) / r.width) * (points.length - 1)))));
  };
  return (
    <figure className="chart">
      <div ref={box} className="chart-plot" style={{ height }} onPointerMove={onMove} onPointerLeave={() => setHot(null)} tabIndex={0} aria-label={title}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') setHot((h) => Math.min(points.length - 1, (h ?? -1) + 1));
          if (e.key === 'ArrowLeft') setHot((h) => Math.max(0, (h ?? 1) - 1));
        }}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path d={area} className="chart-area" />
          {lo < 0 && <line x1="0" x2="100" y1={y(0)} y2={y(0)} className="chart-zero" vectorEffect="non-scaling-stroke" />}
          <path d={d} className="chart-line" vectorEffect="non-scaling-stroke" />
          {hot !== null && <line x1={x(hot)} x2={x(hot)} y1="0" y2="100" className="chart-cross" vectorEffect="non-scaling-stroke" />}
        </svg>
        {hot !== null && (
          <>
            <span className="chart-dot" style={{ left: `${x(hot)}%`, top: `${y(points[hot].value)}%` }} />
            <span className="chart-tip mono" style={{ left: `${x(hot)}%` }}>
              {points[hot].tip}
            </span>
          </>
        )}
      </div>
      <div className="chart-axis mono" aria-hidden="true">
        {points.map((p, i) => (
          <span key={i}>{i % every === 0 ? p.label : ''}</span>
        ))}
      </div>
      <table className="sr">
        <caption>{title}</caption>
        <tbody>
          {points.map((p, i) => (
            <tr key={i}>
              <th scope="row">{p.label}</th>
              <td>{p.tip}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
