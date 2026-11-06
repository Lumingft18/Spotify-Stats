import { useRef, useState } from 'react';
import { Upload, ShieldCheck, Mail, FileArchive, Sparkles, Cpu } from 'lucide-react';
import { useApp } from '../../lib/store';
import { importFiles } from '../../data/lifecycle';
import { hasAccountData } from '../../data/import';
import { navigate, routes } from '../../lib/router';
import { Button, ErrorNote, Spinner, cx } from '../../components/ui';
import { SavedAnalyses } from './SavedAnalyses';

export function Onboarding() {
  const status = useApp((s) => s.status);
  const step = useApp((s) => s.importStep);
  const set = useApp((s) => s.set);
  const serverUp = useApp((s) => s.serverUp);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [name, setName] = useState('');
  /** Files dropped before a name was given: kept so the person only has to type the name. */
  const [pending, setPending] = useState<File[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  const handle = async (list: FileList | File[] | null) => {
    const files = Array.from(list ?? []).filter((f) => /\.(zip|json)$/i.test(f.name));
    if (input.current) input.current.value = ''; // the same file can be chosen again
    if (!files.length) {
      setError('Seleziona il file .zip esportato da Spotify (oppure i file .json al suo interno).');
      return;
    }
    setError(null);
    if (!name.trim() && !(await hasAccountData(files).catch(() => false))) {
      setPending(files);
      setError('Dai un nome a questa analisi (es. il nome della persona), poi premi “Continua”. Con lo ZIP “Dati dell’account” il nome lo prendo da lì.');
      nameInput.current?.focus();
      return;
    }
    setPending(null);
    set({ status: 'importing', importStep: 'Preparazione…' });
    try {
      const out = await importFiles(files, (s) => set({ importStep: s }), { mode: 'replace', name, newAnalysis: true });
      // No full history yet → land on the overview, where a banner asks for the missing package.
      navigate(out.historyKind === 'extended' ? routes.story() : routes.overview());
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : String(e));
      set({ status: 'empty' });
    }
  };

  const importing = status === 'importing';

  return (
    <div className="page-glow min-h-screen">
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-5 py-10 md:px-8">
        <header className="flex items-center justify-between">
          <div className="display text-3xl">Ascolti</div>
          <div className="flex items-center gap-2 rounded-full border border-border bg-surface-1 px-3 py-1.5 text-xs text-text-muted">
            <ShieldCheck size={14} className="text-good" /> Database locale · niente cloud
          </div>
        </header>

        <div className="grid flex-1 items-center gap-12 py-12 md:grid-cols-[1.1fr_1fr]">
          <div className="animate-rise">
            <h1 className="display text-6xl leading-[0.95] md:text-7xl">
              La tua musica,
              <br />
              <em className="text-[var(--accent)]">raccontata bene.</em>
            </h1>
            <p className="mt-6 max-w-md text-lg text-text-muted">
              Carica lo storico esteso di Spotify: statistiche, ere musicali, mood, una mappa del tuo gusto e un assistente a cui
              fare domande. Ogni analisi resta salvata sul tuo computer e la ritrovi qui sotto.
            </p>
            <ol className="mt-8 space-y-4 text-sm">
              {[
                {
                  icon: Mail,
                  t: 'Richiedi i dati',
                  d: (
                    <>
                      Su{' '}
                      <a className="text-[var(--accent)] underline-offset-2 hover:underline" href="https://www.spotify.com/account/privacy/" target="_blank" rel="noreferrer">
                        spotify.com → Privacy
                      </a>{' '}
                      richiedi <b className="text-text">“Cronologia di streaming estesa”</b> (tutto lo storico) e, se vuoi,{' '}
                      <b className="text-text">“Dati dell’account”</b> (nome, playlist, libreria, ricerche, Wrapped).
                    </>
                  ),
                },
                { icon: FileArchive, t: 'Aspetta le email', d: 'Arrivano due ZIP separati: i dati dell’account in ~5 giorni, la cronologia estesa fino a 30. Puoi caricarne uno subito e l’altro dopo.' },
                { icon: Upload, t: 'Dai un nome e trascinali qui', d: 'Anche entrambi insieme. Restano nel database locale di questa app: nessun cloud.' },
              ].map((s, i) => (
                <li key={i} className="flex gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-surface-1 text-text-muted">
                    <s.icon size={15} />
                  </span>
                  <div>
                    <div className="font-medium text-text">{s.t}</div>
                    <div className="text-text-muted">{s.d}</div>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="animate-rise [animation-delay:120ms]">
            {!serverUp && (
              <div className="mb-4">
                <ErrorNote>
                  Il database locale non risponde. Avvia l’app con “Avvia Ascolti.command” (o npm run dev): senza server le analisi non si possono salvare.
                </ErrorNote>
              </div>
            )}
            <label className="mb-4 flex flex-col gap-1.5 text-sm text-text-muted">
              Nome dell’analisi
              <input
                ref={nameInput}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && pending && name.trim() && void handle(pending)}
                disabled={importing}
                placeholder="es. Gianvito 2025 (facoltativo con lo ZIP “Dati dell’account”)"
                aria-label="Nome dell’analisi"
                className="h-10 min-w-0 rounded-full border border-border bg-surface-1 px-4 text-sm text-text placeholder:text-text-faint"
              />
            </label>
            <div
              role="button"
              tabIndex={0}
              aria-label="Carica il file ZIP di Spotify"
              onClick={() => !importing && input.current?.click()}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !importing && input.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                if (!importing) void handle(e.dataTransfer.files);
              }}
              className={cx(
                'relative flex aspect-[4/5] cursor-pointer flex-col items-center justify-center gap-4 overflow-hidden rounded-[2rem] border-2 border-dashed p-8 text-center transition-colors',
                drag ? 'border-[var(--accent)] bg-surface-2' : 'border-border-strong bg-surface-1/60 hover:bg-surface-1',
              )}
            >
              <div
                aria-hidden
                className="pointer-events-none absolute -bottom-24 -right-24 size-72 rounded-full opacity-40 blur-3xl"
                style={{ background: 'var(--accent)' }}
              />
              {importing ? (
                <>
                  <Spinner size={28} />
                  <div className="text-lg font-medium">Sto leggendo i tuoi ascolti</div>
                  <div className="num max-w-xs truncate text-sm text-text-muted" aria-live="polite">
                    {step}
                  </div>
                </>
              ) : (
                <>
                  <div className="grid size-16 place-items-center rounded-full bg-[var(--accent)] text-accent-ink">
                    <Upload size={26} />
                  </div>
                  <div className="text-xl font-medium">Trascina qui uno o entrambi gli ZIP</div>
                  <div className="text-sm text-text-muted">Cronologia estesa e/o Dati dell’account · accetta anche i file .json</div>
                  <Button variant="secondary" className="mt-2" tabIndex={-1}>
                    Scegli file
                  </Button>
                </>
              )}
              <input
                ref={input}
                type="file"
                accept=".zip,.json,application/zip,application/json"
                multiple
                hidden
                onChange={(e) => void handle(e.target.files)}
              />
            </div>
            {error && (
              <div className="mt-4">
                <ErrorNote>{error}</ErrorNote>
              </div>
            )}
            {pending && !importing && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-text-muted">
                <span className="min-w-0 flex-1 truncate">In attesa: {pending.map((f) => f.name).join(', ')}</span>
                <Button variant="primary" size="sm" disabled={!name.trim()} onClick={() => void handle(pending)}>
                  Continua
                </Button>
              </div>
            )}
            <div className="mt-6 grid grid-cols-3 gap-3 text-xs text-text-muted">
              <div className="flex items-center gap-2">
                <Cpu size={14} /> Copertine e testi riusati
              </div>
              <div className="flex items-center gap-2">
                <Sparkles size={14} /> AI solo se la attivi tu
              </div>
              <div className="flex items-center gap-2">
                <ShieldCheck size={14} /> Analisi salvate in locale
              </div>
            </div>
          </div>
        </div>
        <SavedAnalyses />
      </div>
    </div>
  );
}
