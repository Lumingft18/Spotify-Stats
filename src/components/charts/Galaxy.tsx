import { useEffect, useMemo, useRef, useState } from 'react';

export interface GalaxyPoint {
  id: string;
  x: number;
  y: number;
  r: number; // radius in px at zoom 1
  color: string;
  label: string;
  sub?: string;
  dim?: boolean;
}

interface View {
  k: number;
  tx: number;
  ty: number;
}

function inPolygon(x: number, y: number, poly: Array<[number, number]>) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** WebGL-free, canvas-2D scatter with pan/zoom, hover, click and lasso (Shift+drag). Fast enough for ~20k points. */
export function Galaxy({
  points,
  height = 520,
  onPick,
  onLasso,
  labels,
  axes,
}: {
  /** Measured directions, shown at the edges (low = left/top, high = right/bottom on screen). */
  axes?: { x?: { low: string; high: string; r: number } | null; y?: { low: string; high: string; r: number } | null };
  points: GalaxyPoint[];
  height?: number;
  onPick?: (id: string) => void;
  onLasso?: (ids: string[]) => void;
  labels?: Array<{ x: number; y: number; text: string }>;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: height });
  const [view, setView] = useState<View>({ k: 1, tx: 0, ty: 0 });
  const [hover, setHover] = useState<GalaxyPoint | null>(null);
  const [lasso, setLasso] = useState<Array<[number, number]> | null>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean; lasso: boolean } | null>(null);
  const [zoomHint, setZoomHint] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Zoom by factor around a point in canvas coordinates (default: center). */
  const zoomAt = (factor: number, mx = size.w / 2, my = size.h / 2) =>
    setView((v) => {
      const k = Math.min(40, Math.max(0.5, v.k * factor));
      const f = k / v.k;
      return { k, tx: mx - (mx - v.tx) * f, ty: my - (my - v.ty) * f };
    });

  // Wheel: a plain wheel scrolls the PAGE (no fight with page scroll); ⌘/Ctrl + wheel and trackpad pinch
  // (reported as ctrl+wheel) zoom the map. Native non-passive listener: React's onWheel can't preventDefault.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) {
        setZoomHint(true);
        if (hintTimer.current) clearTimeout(hintTimer.current);
        hintTimer.current = setTimeout(() => setZoomHint(false), 1200);
        return;
      }
      e.preventDefault();
      const r = el.getBoundingClientRect();
      // Smooth, proportional to the gesture (pinch sends many small deltas, a mouse wheel few large ones).
      const factor = Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.01);
      zoomAt(factor, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // zoomAt only reads size via closure; re-bind when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h]);

  // Normalize data coordinates into [pad, size-pad].
  const norm = useMemo(() => {
    if (!points.length) return { sx: (v: number) => v, sy: (v: number) => v };
    // Frame the 1st–99th percentile: a few isolated tracks must not squeeze everything else into the middle
    // (they stay drawn, just near or past the edge; zoom out to see them).
    const q = (vals: number[], p: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))];
    const xs = points.map((p) => p.x).sort((a, b) => a - b);
    const ys = points.map((p) => p.y).sort((a, b) => a - b);
    const lo = points.length > 200 ? 0.01 : 0;
    const x0 = q(xs, lo),
      x1 = q(xs, 1 - lo),
      y0 = q(ys, lo),
      y1 = q(ys, 1 - lo);
    const pad = 28;
    const w = Math.max(1, size.w - pad * 2);
    const h = Math.max(1, size.h - pad * 2);
    const s = Math.min(w / (x1 - x0 || 1), h / (y1 - y0 || 1));
    const ox = pad + (w - (x1 - x0) * s) / 2;
    const oy = pad + (h - (y1 - y0) * s) / 2;
    return { sx: (v: number) => ox + (v - x0) * s, sy: (v: number) => oy + (v - y0) * s };
  }, [points, size]);

  const screen = (p: { x: number; y: number }) => [norm.sx(p.x) * view.k + view.tx, norm.sy(p.y) * view.k + view.ty] as const;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [height]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !size.w) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size.w * dpr;
    c.height = size.h * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const rScale = Math.sqrt(view.k);
    // Dimmed first, then highlighted, so highlights draw on top.
    for (const pass of [true, false]) {
      for (const p of points) {
        if (!!p.dim !== pass) continue;
        const [x, y] = screen(p);
        if (x < -20 || y < -20 || x > size.w + 20 || y > size.h + 20) continue;
        ctx.globalAlpha = p.dim ? 0.12 : 0.85;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1.2, p.r * rScale), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    if (labels) {
      ctx.font = '500 12px "Geist Variable", system-ui';
      ctx.textAlign = 'center';
      for (const l of labels) {
        const [x, y] = screen(l);
        ctx.fillStyle = 'rgba(10,12,16,0.65)';
        const w = ctx.measureText(l.text).width + 12;
        ctx.beginPath();
        ctx.roundRect(x - w / 2, y - 11, w, 20, 10);
        ctx.fill();
        ctx.fillStyle = 'rgba(245,246,250,0.92)';
        ctx.fillText(l.text, x, y + 3);
      }
    }
    if (hover) {
      const [x, y] = screen(hover);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(4, hover.r * rScale + 3), 0, Math.PI * 2);
      ctx.stroke();
    }
    if (lasso && lasso.length > 1) {
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.setLineDash([4, 4]);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      lasso.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, size, view, hover, lasso, labels, norm]);

  const nearest = (mx: number, my: number): GalaxyPoint | null => {
    let best: GalaxyPoint | null = null;
    let bd = 14 * 14;
    for (const p of points) {
      if (p.dim) continue;
      const [x, y] = screen(p);
      const d = (x - mx) ** 2 + (y - my) ** 2;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  };

  const local = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  return (
    <div ref={wrap} className="relative w-full select-none" style={{ height }}>
      <canvas
        ref={canvas}
        style={{ width: size.w, height: size.h, touchAction: 'none', cursor: hover ? 'pointer' : 'grab' }}
        aria-label="Mappa dei brani: punti vicini suonano simili"
        role="img"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          const [mx, my] = local(e);
          drag.current = { x: mx, y: my, tx: view.tx, ty: view.ty, moved: false, lasso: e.shiftKey && !!onLasso };
          if (e.shiftKey && onLasso) setLasso([[mx, my]]);
        }}
        onPointerMove={(e) => {
          const [mx, my] = local(e);
          const d = drag.current;
          if (d) {
            if (Math.abs(mx - d.x) + Math.abs(my - d.y) > 3) d.moved = true;
            if (d.lasso) setLasso((l) => (l ? [...l, [mx, my]] : l));
            else setView((v) => ({ ...v, tx: d.tx + mx - d.x, ty: d.ty + my - d.y }));
          } else setHover(nearest(mx, my));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d?.lasso && lasso && lasso.length > 3) {
            const ids = points.filter((p) => !p.dim && inPolygon(...screen(p), lasso)).map((p) => p.id);
            onLasso?.(ids);
            setLasso(null);
            return;
          }
          setLasso(null);
          if (d && !d.moved) {
            const [mx, my] = local(e);
            const p = nearest(mx, my);
            if (p) onPick?.(p.id);
          }
        }}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={() => setView({ k: 1, tx: 0, ty: 0 })}
      />
      {hover && (
        <div
          className="pointer-events-none absolute z-10 max-w-64 rounded-lg border border-border bg-surface-2/95 px-3 py-2 text-xs shadow-xl backdrop-blur"
          style={{ left: Math.min(size.w - 200, screen(hover)[0] + 12), top: screen(hover)[1] + 12 }}
        >
          <div className="truncate font-medium text-text">{hover.label}</div>
          {hover.sub && <div className="truncate text-text-muted">{hover.sub}</div>}
        </div>
      )}
      <div className="absolute right-3 top-3 flex flex-col overflow-hidden rounded-xl border border-border bg-surface-2/90 backdrop-blur">
        <button type="button" aria-label="Ingrandisci" className="grid size-8 place-items-center text-text-muted hover:bg-surface-3 hover:text-text" onClick={() => zoomAt(1.4)}>
          +
        </button>
        <button type="button" aria-label="Riduci" className="grid size-8 place-items-center border-t border-border text-text-muted hover:bg-surface-3 hover:text-text" onClick={() => zoomAt(1 / 1.4)}>
          −
        </button>
        <button type="button" aria-label="Vista iniziale" className="grid size-8 place-items-center border-t border-border text-[10px] text-text-muted hover:bg-surface-3 hover:text-text" onClick={() => setView({ k: 1, tx: 0, ty: 0 })}>
          ⟲
        </button>
      </div>
      {axes?.x && (
        <>
          <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 rounded-md bg-bg/70 px-1.5 py-0.5 text-[11px] text-text-muted">← {axes.x.low}{Math.abs(axes.x.r) < 0.4 ? ' (tendenza)' : ''}</div>
          <div className="pointer-events-none absolute right-14 top-1/2 -translate-y-1/2 rounded-md bg-bg/70 px-1.5 py-0.5 text-[11px] text-text-muted">{axes.x.high}{Math.abs(axes.x.r) < 0.4 ? ' (tendenza)' : ''} →</div>
        </>
      )}
      {axes?.y && (
        <>
          <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-md bg-bg/70 px-1.5 py-0.5 text-[11px] text-text-muted">↑ {axes.y.low}{Math.abs(axes.y.r) < 0.4 ? ' (tendenza)' : ''}</div>
          <div className="pointer-events-none absolute bottom-7 left-1/2 -translate-x-1/2 rounded-md bg-bg/70 px-1.5 py-0.5 text-[11px] text-text-muted">↓ {axes.y.high}{Math.abs(axes.y.r) < 0.4 ? ' (tendenza)' : ''}</div>
        </>
      )}
      {axes && !axes.x && !axes.y && (
        <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-bg/70 px-1.5 py-0.5 text-[11px] text-text-faint">assi senza significato fisso · conta chi è vicino a chi</div>
      )}
      {zoomHint && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/35 text-sm font-medium text-white transition-opacity">
          Tieni premuto ⌘ (o pizzica sul trackpad) per lo zoom
        </div>
      )}
      <div className="pointer-events-none absolute bottom-2 right-3 text-[11px] text-text-faint">
        ⌘ + rotella o pizzico = zoom · trascina = sposta · {onLasso ? 'Shift+trascina = seleziona · ' : ''}doppio click = reset
      </div>
    </div>
  );
}
