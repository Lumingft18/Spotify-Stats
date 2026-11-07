import { useRef, useState } from 'react';
import { AlertCircle, FileArchive, Plus, SkipForward, X } from 'lucide-react';
import { useApp } from '../lib/store';
import { advanceQueue, checkQueueFiles, dequeue, enqueue, queueActiveId, setQueueActive } from '../lib/importQueue';
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
      // The open analysis hands over to the queue when its enrichment ends.
      if (!queueActiveId()) setQueueActive(currentAnalysisId());
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
        Carica gli ZIP di altre persone: vengono importate una alla volta. Quando questa analisi ha finito l’arricchimento passo alla prossima
        da sola (l’app si ricarica).
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
      {waiting > 0 && (
        <div className="mt-3 flex items-center justify-between gap-2 text-xs text-text-faint">
          <span>{running ? 'Parte al termine dell’arricchimento in corso.' : 'Nessun arricchimento in corso: premi “Passa ora”.'}</span>
          <Button size="sm" variant="ghost" onClick={() => void advanceQueue()}>
            <SkipForward size={14} /> Passa ora
          </Button>
        </div>
      )}
    </div>
  );
}
