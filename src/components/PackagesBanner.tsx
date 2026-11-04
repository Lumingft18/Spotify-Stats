import { useRef, useState } from 'react';
import { FileArchive, Upload, X } from 'lucide-react';
import { useApp } from '../lib/store';
import { importFiles } from '../data/lifecycle';
import { Button, ErrorNote, Spinner } from './ui';

const DISMISS_KEY = 'ss2.packagesBannerDismissed';

/** Asks for the second Spotify package when it is missing (account data or extended history). */
export function PackagesBanner() {
  const profile = useApp((s) => s.profile);
  const dataset = useApp((s) => s.dataset);
  const input = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });

  const hasAccount = !!profile?.files?.length;
  const onlyLastYear = dataset?.historyKind === 'legacy';
  if ((hasAccount && !onlyLastYear) || (dismissed && !onlyLastYear)) {
    return msg ? <div role="status" className="rounded-2xl border border-good/30 bg-good/10 px-4 py-3 text-sm text-good">{msg}</div> : null;
  }

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setErr(null);
    try {
      const out = await importFiles(Array.from(files), setStep, { mode: 'merge' });
      setMsg(
        out.keptExisting
          ? 'Dati dell’account aggiunti. Ho tenuto la cronologia completa già caricata.'
          : out.profileFound
            ? 'Dati dell’account aggiunti: trovi nome, playlist e libreria in Profilo.'
            : `Cronologia aggiornata: ${out.rows.toLocaleString('it-IT')} ascolti.`,
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setStep(null);
      if (input.current) input.current.value = '';
    }
  };

  const title = onlyLastYear ? 'Stai vedendo solo l’ultimo anno di ascolti' : 'Aggiungi il pacchetto “Dati dell’account”';
  const body = onlyLastYear
    ? 'Il pacchetto “Dati dell’account” contiene solo 12 mesi. Carica anche la “Cronologia di streaming estesa” per vedere tutto lo storico, le ere e i modelli.'
    : 'Non era in questo ZIP. Quando arriva (circa 5 giorni dalla richiesta) caricalo qui: aggiunge il tuo nome, playlist, brani salvati, ricerche e Wrapped. La cronologia resta quella completa.';

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface-1/80 p-4 md:flex-row md:items-center">
      <FileArchive size={20} className="shrink-0 text-[var(--accent)]" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        <div className="text-sm text-text-muted">{body}</div>
        {err && <div className="mt-2"><ErrorNote>{err}</ErrorNote></div>}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => input.current?.click()} disabled={!!step}>
          {step ? <Spinner size={14} /> : <Upload size={14} />} {step ? 'Importo…' : onlyLastYear ? 'Carica cronologia estesa' : 'Carica dati account'}
        </Button>
        {!onlyLastYear && (
          <button
            aria-label="Nascondi"
            onClick={() => {
              setDismissed(true);
              try {
                localStorage.setItem(DISMISS_KEY, '1');
              } catch {
                /* ignore */
              }
            }}
            className="grid size-8 place-items-center rounded-full text-text-faint hover:bg-surface-2"
          >
            <X size={15} />
          </button>
        )}
      </div>
      <input ref={input} type="file" accept=".zip,.json" multiple hidden onChange={(e) => void upload(e.target.files)} />
    </div>
  );
}
