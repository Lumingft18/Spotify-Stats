import { Pause, Play, X, CheckCircle2, AlertCircle } from 'lucide-react';
import { useApp } from '../lib/store';
import { runStep, stopStep, STEPS, type StepId } from '../enrichment/jobs';
import { Button, cx, Meter } from './ui';
import { fmtInt } from '../lib/format';

const PER_ITEM_SECONDS: Partial<Record<StepId, number>> = { lyrics: 0.45, tags: 1.3, covers: 0.35 };
function eta(id: StepId, remaining: number): string | null {
  const s = PER_ITEM_SECONDS[id];
  if (!s || remaining <= 0) return null;
  const min = Math.ceil((remaining * s) / 60);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

export function ActivityDrawer() {
  const open = useApp((s) => s.activityOpen);
  const jobs = useApp((s) => s.jobs);
  const settings = useApp((s) => s.settings);
  const set = useApp((s) => s.set);
  if (!open) return null;
  const steps = Object.keys(STEPS) as StepId[];
  const extra = Object.values(jobs).filter((j) => !(j.id in STEPS));

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm" onClick={() => set({ activityOpen: false })}>
      <aside
        role="dialog"
        aria-label="Attività in background"
        className="flex h-full w-full max-w-md flex-col gap-4 overflow-y-auto border-l border-border bg-surface-1 p-6 animate-fade"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="display text-3xl">Attività</h2>
            <p className="text-sm text-text-muted">Arricchimento dei brani in background. Puoi chiudere: continua da solo.</p>
          </div>
          <button onClick={() => set({ activityOpen: false })} aria-label="Chiudi" className="text-text-faint hover:text-text">
            <X size={20} />
          </button>
        </div>
        {steps.map((id) => {
          const d = STEPS[id];
          const j = jobs[id];
          const enabled = settings.connections[d.connection];
          const running = j?.status === 'running';
          return (
            <div key={id} className={cx('rounded-2xl border border-border bg-surface-2/60 p-4', !enabled && 'opacity-60')}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-medium">
                  {j?.status === 'done' && <CheckCircle2 size={16} className="text-good" />}
                  {j?.status === 'error' && <AlertCircle size={16} className="text-bad" />}
                  {d.label}
                </div>
                {enabled ? (
                  <Button size="sm" variant="ghost" onClick={() => (running ? stopStep(id) : void runStep(id))}>
                    {running ? <Pause size={14} /> : <Play size={14} />}
                    {running ? 'Pausa' : j?.status === 'done' ? 'Ricontrolla' : 'Avvia'}
                  </Button>
                ) : (
                  <a href="#/settings" onClick={() => set({ activityOpen: false })} className="text-xs text-[var(--accent)]">
                    Attiva in Impostazioni
                  </a>
                )}
              </div>
              {j && j.total > 0 && (
                <>
                  <Meter value={j.done} max={j.total} />
                  <div className="mt-1.5 flex justify-between text-xs text-text-faint">
                    <span className="num">
                      {fmtInt(j.done)} / {fmtInt(j.total)}
                    </span>
                    <span>
                      {j.status === 'running'
                        ? `in corso${eta(id, j.total - j.done) ? ` · ~${eta(id, j.total - j.done)}` : ''}`
                        : j.status === 'paused'
                          ? 'in pausa'
                          : j.status === 'done'
                            ? 'completato'
                            : ''}
                    </span>
                  </div>
                </>
              )}
              {j?.status === 'done' && j.total === 0 && <div className="text-xs text-text-faint">Tutto aggiornato.</div>}
              {j?.detail && <div className="mt-1 text-xs text-bad">{j.detail}</div>}
            </div>
          );
        })}
        {extra.map((j) => (
          <div key={j.id} className="rounded-2xl border border-border bg-surface-2/60 p-4">
            <div className="mb-2 font-medium">{j.label}</div>
            {j.total > 0 && <Meter value={j.done} max={j.total} />}
            <div className="mt-1.5 text-xs text-text-faint">{j.detail ?? j.status}</div>
          </div>
        ))}
      </aside>
    </div>
  );
}
