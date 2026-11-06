import { useEffect, useState } from 'react';
import { FolderOpen, Pencil, Trash2, Check, X, History } from 'lucide-react';
import { analyses, openAnalysis, type Analysis } from '../../lib/analyses';
import { fmtDate } from '../../lib/format';
import { Button, ErrorNote, Spinner } from '../../components/ui';

const fmtWhen = (ms: number) =>
  new Date(ms).toLocaleString('it-IT', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtMb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(0.1, b / 1e6).toFixed(1)} MB`);

/** History of saved analyses (local database): open, rename, delete. */
export function SavedAnalyses() {
  const [list, setList] = useState<Analysis[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = () =>
    analyses
      .list()
      .then(setList)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    void load();
  }, []);

  if (err) return <ErrorNote>{err}</ErrorNote>;
  if (!list)
    return (
      <div className="flex items-center gap-2 text-sm text-text-muted">
        <Spinner /> Carico le analisi salvate…
      </div>
    );
  if (!list.length) return null;

  const rename = async (id: string) => {
    try {
      await analyses.update(id, { name: draft });
      setEditing(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section aria-labelledby="saved-title" className="animate-rise pb-6">
      <h2 id="saved-title" className="mb-3 flex items-center gap-2 text-sm font-medium text-text-muted">
        <History size={15} /> Analisi salvate · {list.length}
      </h2>
      <ul className="grid gap-2 md:grid-cols-2">
        {list.map((a) => {
          const empty = !a.rows;
          return (
            <li key={a.id} className="rounded-2xl border border-border bg-surface-1/70 p-4">
              {editing === a.id ? (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void rename(a.id);
                  }}
                >
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    aria-label="Nuovo nome dell’analisi"
                    className="h-9 min-w-0 flex-1 rounded-full border border-border bg-surface-2 px-4 text-sm text-text"
                  />
                  <Button size="sm" variant="primary" type="submit" aria-label="Salva nome">
                    <Check size={14} />
                  </Button>
                  <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(null)} aria-label="Annulla">
                    <X size={14} />
                  </Button>
                </form>
              ) : (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-text">{a.name}</div>
                    <div className="mt-0.5 text-xs text-text-muted">
                      {empty ? (
                        'Import non completato'
                      ) : (
                        <>
                          {fmtDate(a.first_day)} – {fmtDate(a.last_day)} · <span className="num">{(a.rows ?? 0).toLocaleString('it-IT')}</span> righe
                          {a.history_kind === 'legacy' && ' · solo ultimo anno'}
                        </>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] text-text-faint">
                      Aperta {fmtWhen(a.opened_at)} · {fmtMb(a.bytes)}
                      {a.display_name && a.display_name !== a.name && ` · ${a.display_name}`}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {!empty && (
                      <Button size="sm" variant="primary" onClick={() => openAnalysis(a.id)}>
                        <FolderOpen size={14} /> Apri
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Rinomina ${a.name}`}
                      onClick={() => {
                        setDraft(a.name);
                        setEditing(a.id);
                      }}
                    >
                      <Pencil size={14} />
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={`Elimina ${a.name}`} onClick={() => setConfirm(a.id)}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
              )}
              {confirm === a.id && (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-bad/40 bg-bad/10 p-3 text-sm">
                  <span className="flex-1 text-text-muted">Eliminare “{a.name}”? Storico, mood, mappa e chat di questa analisi spariscono. La cache condivisa resta.</span>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={async () => {
                      await analyses.remove(a.id).catch((e) => setErr(String(e)));
                      setConfirm(null);
                      await load();
                    }}
                  >
                    Elimina
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                    Annulla
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
