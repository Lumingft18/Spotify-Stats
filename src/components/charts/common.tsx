import { useCallback } from 'react';
import { PlotChart, Plot } from './PlotChart';
import { DOW, fmt1, fmtHours, fmtMonth } from '../../lib/format';

/** Monthly listening bars. rows: { ym: 'YYYY-MM', minutes } */
export function MonthlyBars({ rows, height = 180, label = 'Ascolto per mese' }: { rows: Array<{ ym: string; minutes: number }>; height?: number; label?: string }) {
  const make = useCallback(
    (width: number) => ({
      height,
      marginLeft: 36,
      x: { type: 'utc' as const, label: null, ticks: width < 600 ? 4 : 8 },
      y: { label: 'ore', grid: true },
      marks: [
        Plot.rectY(rows, {
          x1: (d: { ym: string }) => new Date(d.ym + '-01'),
          x2: (d: { ym: string }) => {
            const t = new Date(d.ym + '-01');
            t.setUTCMonth(t.getUTCMonth() + 1);
            return t;
          },
          y: (d: { minutes: number }) => d.minutes / 60,
          fill: 'var(--accent)',
          fillOpacity: 0.85,
          inset: 1,
          rx: 2,
        }),
        Plot.tip(
          rows,
          Plot.pointerX({
            x: (d: { ym: string }) => new Date(d.ym + '-15'),
            y: (d: { minutes: number }) => d.minutes / 60,
            title: (d: { ym: string; minutes: number }) => `${fmtMonth(d.ym)}\n${fmtHours(d.minutes)}`,
          }),
        ),
      ],
    }),
    [rows, height],
  );
  return <PlotChart make={make} height={height} ariaLabel={label} />;
}

/** Hour × weekday heatmap. rows: { dow 1..7, hour 0..23, value } */
export function HourDowHeatmap({
  rows,
  height = 230,
  valueLabel = 'minuti medi',
  scheme = 'magma',
}: {
  rows: Array<{ dow: number; hour: number; value: number }>;
  height?: number;
  valueLabel?: string;
  scheme?: string;
}) {
  const make = useCallback(
    () => ({
      height,
      marginLeft: 36,
      padding: 0.06,
      x: { label: null, tickFormat: (h: number) => (h % 3 === 0 ? `${h}` : '') },
      y: { label: null, tickFormat: (d: number) => DOW[d - 1], domain: [1, 2, 3, 4, 5, 6, 7] },
      color: { scheme: scheme as 'magma', legend: false },
      marks: [
        Plot.cell(rows, { x: 'hour', y: 'dow', fill: 'value', rx: 3 }),
        Plot.tip(rows, Plot.pointer({ x: 'hour', y: 'dow', title: (d: { dow: number; hour: number; value: number }) => `${DOW[d.dow - 1]} ore ${d.hour}:00\n${valueLabel}: ${fmt1(d.value)}` })),
      ],
    }),
    [rows, height, valueLabel, scheme],
  );
  return <PlotChart make={make} height={height} ariaLabel="Mappa di calore per ora e giorno della settimana" />;
}

export function MoodPlane({
  points,
  height = 320,
}: {
  points: Array<{ valence: number; energy: number; label: string; color: string; r?: number }>;
  height?: number;
}) {
  const make = useCallback(
    () => ({
      height,
      marginLeft: 40,
      marginBottom: 36,
      x: { domain: [0, 1], label: 'positività (valence) →', grid: false },
      y: { domain: [0, 1], label: '↑ energia', grid: false },
      r: { range: [2, 9] },
      marks: [
        Plot.ruleX([0.5], { stroke: 'var(--color-border-strong)', strokeDasharray: '3,3' }),
        Plot.ruleY([0.5], { stroke: 'var(--color-border-strong)', strokeDasharray: '3,3' }),
        Plot.text(
          [
            { x: 0.97, y: 0.97, t: 'Euforico', a: 'end' },
            { x: 0.03, y: 0.97, t: 'Teso', a: 'start' },
            { x: 0.03, y: 0.03, t: 'Malinconico', a: 'start' },
            { x: 0.97, y: 0.03, t: 'Sereno', a: 'end' },
          ],
          { x: 'x', y: 'y', text: 't', textAnchor: (d: { a: string }) => d.a, fill: 'var(--color-text-faint)', fontSize: 11 } as never,
        ),
        Plot.dot(points, { x: 'valence', y: 'energy', fill: 'color', r: (d: { r?: number }) => d.r ?? 3, fillOpacity: 0.75 }),
        Plot.tip(points, Plot.pointer({ x: 'valence', y: 'energy', title: 'label' })),
      ],
    }),
    [points, height],
  );
  return <PlotChart make={make} height={height} ariaLabel="Piano emotivo: positività e energia" />;
}
