import { useRef, useState } from 'react';
import { ShieldCheck, Trash2, Upload, Globe, KeyRound, Clock } from 'lucide-react';
import { useApp, type ConnectionId } from '../../lib/store';
import { query, loadPlays, wipeAll } from '../../data/db';
import { afterDataLoaded, importFiles } from '../../data/lifecycle';
import { emptyColumns, makeLocalizer, PLAY_COLUMNS, type PlayColumns } from '../../data/normalize';
import { resetTried, runAllEnabled, stopAll } from '../../enrichment/jobs';
import { clearIndexCache } from '../../ml/embeddings';
import { Button, Card, ErrorNote, PageHeader, Section, Spinner, cx } from '../../components/ui';

const CONNECTIONS: Array<{ id: ConnectionId; title: string; host: string; sends: string }> = [
  { id: 'covers', title: 'Copertine', host: 'open.spotify.com (oEmbed)', sends: 'ID dei brani, uno alla volta' },
  { id: 'audiofeatures', title: 'Audio features (valence, energia, tempo)', host: 'api.reccobeats.com', sends: 'ID Spotify dei brani, a blocchi di 40' },
  { id: 'lyrics', title: 'Testi', host: 'lrclib.net', sends: 'titolo, artista, album e durata dei brani più ascoltati' },
  { id: 'lastfm', title: 'Tag e generi', host: 'ws.audioscrobbler.com (Last.fm)', sends: 'titolo e artista; richiede la tua chiave API' },
  { id: 'embedModel', title: 'Modello di embedding', host: 'huggingface.co', sends: 'nulla: scarica solo il modello (una volta)' },
  { id: 'llm', title: 'Funzioni AI (mood, nomi, assistente)', host: 'openrouter.ai', sends: 'titoli, artisti, tag, estratti di testo e risultati delle query; mai lo storico completo' },
];

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cx('relative h-6 w-11 shrink-0 rounded-full transition-colors', on ? 'bg-[var(--accent)]' : 'bg-surface-3')}
    >
      <span className={cx('absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform', on ? 'translate-x-5' : 'translate-x-0.5')} />
    </button>
  );
}

const TIMEZONES = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['Europe/Rome', 'Europe/London', 'America/New_York', 'UTC'];
  }
})();

async function reapplyTimezone(tz: string) {
  const rows = await query<Record<keyof PlayColumns, never>>(`SELECT * FROM plays_raw`);
  const cols = emptyColumns();
  const loc = makeLocalizer(tz);
  for (const r of rows) {
    for (const k of PLAY_COLUMNS) (cols[k] as unknown[]).push(r[k]);
  }
  cols.ts_local = cols.ts_start.map((s) => loc(Date.parse(s.replace(' ', 'T') + 'Z')));
  await loadPlays(cols);
  await afterDataLoaded();
}

export default function SettingsPage() {
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSettings);
  const net = useApp((s) => s.net);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const hosts = Array.from(
    net.reduce((m, e) => m.set(e.host, { ...e, n: (m.get(e.host)?.n ?? 0) + 1 }), new Map<string, { host: string; purpose: string; at: number; n: number }>()).values(),
  ).sort((a, b) => b.at - a.at);

  return (
    <div className="flex max-w-3xl flex-col gap-12">
      <PageHeader kicker="Impostazioni" title="Privacy e preferenze" sub="Tutto è calcolato sul tuo dispositivo. Qui decidi tu cosa può uscire, e verso chi." />

      <Section kicker="Connessioni" title="Servizi esterni (tutti facoltativi)">
        <Card className="flex flex-col divide-y divide-border p-0">
          {CONNECTIONS.map((c) => (
            <div key={c.id} className="flex items-start justify-between gap-4 p-4">
              <div className="min-w-0">
                <div className="font-medium">{c.title}</div>
                <div className="text-xs text-text-faint">
                  <Globe size={11} className="mr-1 inline" />
                  {c.host} · invia: {c.sends}
                </div>
              </div>
              <Toggle
                label={c.title}
                on={settings.connections[c.id]}
                onChange={(v) => {
                  update({ connections: { ...settings.connections, [c.id]: v } });
                  if (!v) stopAll();
                  else setTimeout(runAllEnabled, 50);
                }}
              />
            </div>
          ))}
        </Card>
      </Section>

      <Section kicker="Chiavi" title="Le tue chiavi API (restano in questo browser)">
        <Card className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="flex items-center gap-2 font-medium">
              <KeyRound size={14} /> OpenRouter
            </span>
            <input
              type="password"
              autoComplete="off"
              value={settings.openrouterKey}
              onChange={(e) => update({ openrouterKey: e.target.value.trim() })}
              placeholder="sk-or-…"
              className="h-10 rounded-xl border border-border bg-surface-2 px-3 font-mono text-sm"
            />
            <span className="text-xs text-text-faint">
              Crea una chiave su openrouter.ai/keys. Ti consigliamo un limite di spesa sulla chiave.
            </span>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-muted">Modello per elaborazioni in blocco</span>
              <input value={settings.llmModelBulk} onChange={(e) => update({ llmModelBulk: e.target.value.trim() })} className="h-10 rounded-xl border border-border bg-surface-2 px-3 font-mono text-xs" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-muted">Modello per l’assistente</span>
              <input value={settings.llmModelAgent} onChange={(e) => update({ llmModelAgent: e.target.value.trim() })} className="h-10 rounded-xl border border-border bg-surface-2 px-3 font-mono text-xs" />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="flex items-center gap-2 font-medium">
              <KeyRound size={14} /> Last.fm
            </span>
            <input
              type="password"
              autoComplete="off"
              value={settings.lastfmKey}
              onChange={(e) => update({ lastfmKey: e.target.value.trim() })}
              placeholder="chiave API Last.fm"
              className="h-10 rounded-xl border border-border bg-surface-2 px-3 font-mono text-sm"
            />
            <span className="text-xs text-text-faint">Gratuita su last.fm/api/account/create. Serve per tag e generi.</span>
          </label>
          <p className="text-xs text-text-faint">
            Attenzione: le chiavi sono salvate in chiaro nel localStorage di questo browser. Non usare questa app su computer condivisi con chiavi senza limiti di spesa.
          </p>
        </Card>
      </Section>

      <Section kicker="Fuso orario" title="Per ore e giorni locali">
        <Card className="flex flex-wrap items-center gap-3">
          <Clock size={16} className="text-text-faint" />
          <select value={settings.timeZone} onChange={(e) => update({ timeZone: e.target.value })} className="h-10 rounded-full border border-border bg-surface-2 px-3 text-sm">
            {TIMEZONES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <Button
            size="sm"
            disabled={!!busy}
            onClick={async () => {
              setBusy('tz');
              setErr(null);
              try {
                await reapplyTimezone(settings.timeZone);
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === 'tz' ? <Spinner size={14} /> : null} Ricalcola con questo fuso
          </Button>
        </Card>
      </Section>

      <Section kicker="Dati" title="I tuoi dati">
        <Card className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => file.current?.click()} disabled={!!busy}>
              {busy === 'import' ? <Spinner size={14} /> : <Upload size={14} />} Sostituisci con un nuovo export
            </Button>
            <input
              ref={file}
              type="file"
              accept=".zip,.json"
              multiple
              hidden
              onChange={async (e) => {
                if (!e.target.files?.length) return;
                setBusy('import');
                setErr(null);
                try {
                  stopAll();
                  await importFiles(Array.from(e.target.files), () => undefined);
                } catch (x) {
                  setErr(x instanceof Error ? x.message : String(x));
                } finally {
                  setBusy(null);
                }
              }}
            />
            <Button
              variant="ghost"
              onClick={async () => {
                await resetTried();
                runAllEnabled();
              }}
            >
              Riprova arricchimento dei brani falliti
            </Button>
          </div>
          {!confirmWipe ? (
            <Button variant="danger" className="self-start" onClick={() => setConfirmWipe(true)}>
              <Trash2 size={14} /> Cancella tutti i dati locali
            </Button>
          ) : (
            <div className="rounded-xl border border-bad/40 bg-bad/10 p-4 text-sm">
              <div className="font-medium text-bad">Cancellare tutto?</div>
              <p className="mt-1 text-text-muted">
                Storico, copertine, mood, mappa, conversazioni e confronti verranno eliminati da questo browser. Non si può annullare. Le impostazioni e le chiavi restano.
              </p>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="danger"
                  onClick={async () => {
                    stopAll();
                    await wipeAll();
                    clearIndexCache();
                    location.hash = '#/';
                    location.reload();
                  }}
                >
                  Sì, cancella
                </Button>
                <Button variant="ghost" onClick={() => setConfirmWipe(false)}>
                  Annulla
                </Button>
              </div>
            </div>
          )}
          {err && <ErrorNote>{err}</ErrorNote>}
        </Card>
      </Section>

      <Section kicker="Trasparenza" title="Connessioni effettuate in questa sessione">
        <Card>
          {hosts.length ? (
            <ul className="flex flex-col gap-2 text-sm">
              {hosts.map((h) => (
                <li key={h.host} className="flex justify-between gap-3">
                  <span className="font-mono text-xs">{h.host}</span>
                  <span className="text-xs text-text-faint">
                    {h.purpose} · {new Date(h.at).toLocaleTimeString('it-IT')}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <ShieldCheck size={15} className="text-good" /> Nessuna connessione esterna finora.
            </div>
          )}
        </Card>
      </Section>
    </div>
  );
}
