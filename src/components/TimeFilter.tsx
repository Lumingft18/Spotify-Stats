import { useState } from 'react';
import { CalendarRange, X } from 'lucide-react';
import { useApp } from '../lib/store';
import { applyRange } from '../data/lifecycle';
import { addDays, fmtDate } from '../lib/format';
import { cx, Button } from './ui';

/** Global period filter: presets + custom range. Applies to every screen (DuckDB view `p`). */
export function TimeFilter() {
  const bounds = useApp((s) => s.bounds);
  const range = useApp((s) => s.range);
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(range.from ?? bounds?.min ?? '');
  const [to, setTo] = useState(range.to ?? bounds?.max ?? '');
  if (!bounds) return null;

  const y0 = Number(bounds.min.slice(0, 4));
  const y1 = Number(bounds.max.slice(0, 4));
  const years = Array.from({ length: y1 - y0 + 1 }, (_, i) => y1 - i);
  const last12 = { from: addDays(bounds.max, -364), to: bounds.max };

  const presets = [
    { label: 'Tutto', from: null, to: null },
    { label: 'Ultimi 12 mesi', ...last12 },
    ...years.map((y) => ({ label: String(y), from: `${y}-01-01`, to: `${y}-12-31` })),
  ];
  const isActive = (p: { from: string | null; to: string | null }) => p.from === range.from && p.to === range.to;
  const custom = (range.from || range.to) && !presets.some(isActive);

  return (
    <div className="relative flex min-w-0 items-center gap-2">
      <div className="scrollbar-thin flex min-w-0 items-center gap-1 overflow-x-auto">
        {presets.map((p) => (
          <button
            key={p.label}
            onClick={() => void applyRange(p.from, p.to)}
            className={cx(
              'h-8 shrink-0 rounded-full px-3 text-sm transition-colors',
              isActive(p) ? 'bg-surface-3 text-text' : 'text-text-muted hover:bg-surface-2 hover:text-text',
            )}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={cx(
            'flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm',
            custom ? 'bg-surface-3 text-text' : 'text-text-muted hover:bg-surface-2 hover:text-text',
          )}
        >
          <CalendarRange size={15} />
          {custom ? `${fmtDate(range.from ?? bounds.min)} – ${fmtDate(range.to ?? bounds.max)}` : 'Periodo'}
        </button>
      </div>
      {open && (
        <div className="absolute left-0 top-11 z-40 w-[min(22rem,90vw)] rounded-2xl border border-border bg-surface-1 p-4 shadow-2xl animate-rise">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-medium">Periodo personalizzato</div>
            <button onClick={() => setOpen(false)} aria-label="Chiudi" className="text-text-faint hover:text-text">
              <X size={16} />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-text-faint">
              Dal
              <input
                type="date"
                min={bounds.min}
                max={bounds.max}
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="mt-1 h-9 w-full rounded-lg border border-border bg-surface-2 px-2 text-sm text-text"
              />
            </label>
            <label className="text-xs text-text-faint">
              Al
              <input
                type="date"
                min={bounds.min}
                max={bounds.max}
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="mt-1 h-9 w-full rounded-lg border border-border bg-surface-2 px-2 text-sm text-text"
              />
            </label>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Annulla
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!from || !to || from > to}
              onClick={() => {
                void applyRange(from, to);
                setOpen(false);
              }}
            >
              Applica
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
