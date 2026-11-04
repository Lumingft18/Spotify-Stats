import { useEffect, useRef, useState } from 'react';
import * as Plot from '@observablehq/plot';

/** Responsive Observable Plot wrapper. `make` receives the available width. */
export function PlotChart({
  make,
  height = 260,
  ariaLabel,
  className,
}: {
  make: (width: number) => Plot.PlotOptions;
  height?: number;
  ariaLabel: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || width < 50) return;
    let chart: (SVGSVGElement | HTMLElement) | null = null;
    try {
      const opts = make(width);
      chart = Plot.plot({
        width,
        height,
        style: { background: 'transparent', color: 'var(--color-text-muted)', fontSize: '11px', overflow: 'visible' },
        marginLeft: 44,
        ...opts,
        ariaLabel,
      });
      el.replaceChildren(chart);
    } catch (e) {
      console.error(e);
      el.textContent = 'Errore nel grafico';
    }
    return () => chart?.remove();
  }, [make, width, height, ariaLabel]);

  return <div ref={ref} className={`plot w-full ${className ?? ''}`} style={{ minHeight: height }} role="img" aria-label={ariaLabel} />;
}

export { Plot };
