import { useEffect, useRef, useState } from 'react';
import { AlertCircle, FileArchive, Plus, SkipForward, Wand2, X } from 'lucide-react';
import { useApp } from '../lib/store';
import { advanceQueue, chainInProgress, checkQueueFiles, dequeue, enqueue, incompleteAnalyses, resumeChain, setQueueActive } from '../lib/importQueue';
import { isAutoRunActive } from '../enrichment/jobs';
import type { Analysis } from '../lib/analyses';
import { currentAnalysisId } from '../lib/analyses';
import { Button, ErrorNote } from './ui';

const fmtMb = (b: number) => `${(b / 1_048_576).toLocaleString('it-IT', { maximumFractionDigits: b < 10_485_760 ? 1 : 0 })} MB`;

/** People waiting to be imported, in order. */
export function QueueList() {
  const queue = useApp((s) => s.queue);
  if (!queue.length) return null;
  return (
    <ol className="space-y-2">
      {queue.map((q, i) => (
        <li key={q.id} className="flex items-start gap-3 rounded-2xl border border-border bg-surface-2/60 px-3 py-2.5 text-sm">
          <span className="num mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-border text-xs text-text-muted">{i + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-text">{q.name || 'Nome dallo ZIP “Dati dell’account”'}</div>
            <div className="truncate text-xs text-text-faint">
              <FileArchive size={11} className="mr-1 inline" />
              {q.fileNames.join(', ')} · {fmtMb(q.bytes)}
            </div>
            {q.importing && <div className="mt-1 text-xs text-[var(--accent)]">Importazione in corso…</div>}
            {q.error && (
              <div className="mt-1 flex items-start gap-1 text-xs text-bad">
                <AlertCircle size={12} className="mt-0.5 shrink-0" /> Non importata: {q.error}
              </div>
            )}
          </div>
          <button disabled={q.importing} onClick={() => void dequeue(q.id)} aria-label={`Togli ${q.name || 'questa voce'} dalla coda`} className="text-text-faint hover:text-text">
            <X size={16} />
          </button>
        </li>
      ))}
    </ol>
  );
}

/** Saved analyses still to enrich (excluding the open one); re-read when the queue changes. */
function useIncomplete(): Analysis[] {
  const queue = useApp((s) => s.queue);
  const [list, setList] = useState<Analysis[]>([]);
  useEffect(() => {
    let live = true;
    void incompleteAnalyses(currentAnalysisId()).then((l) => live && setList(l));
    return () => {
      live = false;
    };
  }, [queue]);
  return list;
}

/** Seconds on the start screen before the chain carries on by itself (time to add more ZIPs first). */
const AUTO_RESUME_S = 15;

/**
 * Start screen: the chain has work left (someone halfway through enrichment, people in the queue, analyses
 * left incomplete) → it carries on by itself after a short countdown. The countdown waits while you type a
 * name or pick files, and “Non ora” stops it for this visit.
 */
export function IncompleteBanner() {
  const queue = useApp((s) => s.queue);
  const status = useApp((s) => s.status);
  const [plan, setPlan] = useState<{ title: string; names: string[] } | null>(null);
  const [left, setLeft] = useState(AUTO_RESUME_S);
  const [stopped, setStopped] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const active = await chainInProgress();
      const waiting = queue.filter((q) => !q.error && !q.importing).map((q) => q.name || 'nome dallo ZIP');
      const rest = (await incompleteAnalyses(active?.id ?? null)).map((a) => a.name);
      const names = [...(active ? [active.name] : []), ...waiting, ...rest];
      const title = active
        ? `Riprendo ${active.name}`
        : waiting.length
          ? `Importo ${waiting[0]}`
          : rest.length === 1
            ? '1 analisi da completare'
            : `${rest.length} analisi da completare`;
      if (live) setPlan(names.length ? { title, names } : null);
    })();
    return () => {
      live = false;
    };
  }, [queue]);

  const go = () => {
    setBusy(true);
    void resumeChain().finally(() => setBusy(false));
  };

  const armed = !!plan && !stopped && !busy && status === 'empty';
  useEffect(() => {
    if (!armed) return;
    let n = AUTO_RESUME_S;
    const t = setInterval(() => {
      // Typing a name or choosing files: wait for it.
      const el = document.activeElement;
      n = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? AUTO_RESUME_S : n - 1;
      setLeft(n);
      if (n > 0) return;
      clearInterval(t);
      go();
    }, 1000);
    return () => clearInterval(t);
  }, [armed]);

  if (!plan) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface-2/60 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-text">
          {plan.title}
          {armed && <span className="num font-normal text-text-muted"> tra {Math.max(left, 0)} s</span>}
        </div>
        <div className="truncate text-xs text-text-muted">{plan.names.join(', ')} · una alla volta, passo alla successiva da sola</div>
      </div>
      {armed && (
        <Button size="sm" variant="ghost" onClick={() => setStopped(true)}>
          Non ora
        </Button>
      )}
      <Button size="sm" variant="primary" disabled={busy} onClick={go}>
        <Wand2 size={14} /> {stopped ? 'Completa in automatico' : 'Vai ora'}
      </Button>
    </div>
  );
}

/** Activity drawer section: queue + add another person while the current one is being enriched. */
export function QueueSection() {
  const queue = useApp((s) => s.queue);
  const running = useApp((s) => Object.values(s.jobs).some((j) => j.status === 'running'));
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<File[] | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const waiting = queue.filter((q) => !q.error && !q.importing).length;
  const incomplete = useIncomplete();

  const add = async (list: FileList | File[] | null) => {
    const picked = Array.from(list ?? []); // copy first: clearing the input empties its live FileList
    if (input.current) input.current.value = '';
    setBusy(true);
    try {
      const r = await checkQueueFiles(picked, name);
      if ('error' in r) {
        setError(r.error);
        setPending(r.files ?? null);
        return;
      }
      await enqueue(name, r.files);
      // Enrichment still going: the open analysis hands over to the queue when it ends.
      // Nothing left running here: the new person starts right away.
      if (isAutoRunActive()) setQueueActive(currentAnalysisId());
      else await advanceQueue();
      setName('');
      setPending(null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-surface-2/60 p-4">
      <div className="mb-1 font-medium">Coda analisi</div>
      <p className="mb-3 text-xs text-text-muted">
        Carica gli ZIP di altre persone: vengono importate una alla volta. Quando questa analisi ha finito l’arricchimento passo da sola alla
        prossima (prima le nuove in coda, poi quelle rimaste a metà). L’app si ricarica a ogni passaggio.
      </p>
      <QueueList />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && pending && name.trim() && void add(pending)}
          placeholder="Nome della persona"
          aria-label="Nome della persona da mettere in coda"
          className="h-9 min-w-0 flex-1 rounded-full border border-border bg-surface-1 px-3 text-sm text-text placeholder:text-text-faint"
        />
        {pending ? (
          <Button size="sm" variant="primary" disabled={!name.trim() || busy} onClick={() => void add(pending)}>
            Continua
          </Button>
        ) : (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
            <Plus size={14} /> Aggiungi ZIP
          </Button>
        )}
        <input ref={input} type="file" accept=".zip,.json,application/zip,application/json" multiple hidden onChange={(e) => void add(e.target.files)} />
      </div>
      {error && (
        <div className="mt-2">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {incomplete.length > 0 && (
        <p className="mt-3 text-xs text-text-muted">
          Poi completo anche: <span className="text-text">{incomplete.map((a) => a.name).join(', ')}</span>
        </p>
      )}
      {waiting + incomplete.length > 0 && (
        <div className="mt-3 flex items-center justify-between gap-2 text-xs text-text-faint">
          <span>{running ? 'Parte da sola al termine dell’arricchimento in corso.' : 'Parte da sola a breve.'}</span>
          <Button size="sm" variant="ghost" onClick={() => void advanceQueue()}>
            <SkipForward size={14} /> Passa ora
          </Button>
        </div>
      )}
    </div>
  );
}
