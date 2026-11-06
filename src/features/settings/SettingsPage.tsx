import { useState } from 'react';
import { EyeOff, RotateCcw, ShieldCheck, Trash2, Upload, Globe, KeyRound, Clock, Save, CheckCircle2 } from 'lucide-react';
import { checkOpenRouterKey } from '../../llm/client';
import { catalogStats, clearCatalog } from '../../lib/catalogCache';
import { analyses, leaveAnalysis } from '../../lib/analyses';
import { updateAnalysisFromFiles } from '../../data/updateAnalysis';
import { LimitSelect } from '../../components/LimitSelect';
import { useAsync } from '../../data/useSql';
import { ENV_KEYS, useApp, type ConnectionId } from '../../lib/store';
import { getExcluded, query, loadPlays, dropAll } from '../../data/db';
import { afterDataLoaded, includeAll, includeTrack } from '../../data/lifecycle';
import { emptyColumns, makeLocalizer, PLAY_COLUMNS, type PlayColumns } from '../../data/normalize';
import { resetTried, runAllEnabled, stopAll } from '../../enrichment/jobs';
import { autoMoodAi, MOOD_AI_JOB, stopMoodAi } from '../../enrichment/moodAi';
import { clearIndexCache } from '../../ml/embeddings';
import { autoEmbeddings, EMBED_JOB, stopEmbeddings } from '../../enrichment/embedAi';
import { Button, Card, ErrorNote, PageHeader, Section, Spinner, cx } from '../../components/ui';

const CONNECTIONS: Array<{ id: ConnectionId; title: string; host: string; sends: string }> = [
  { id: 'covers', title: 'Copertine', host: 'open.spotify.com (oEmbed)', sends: 'ID dei brani, uno alla volta' },
  { id: 'audiofeatures', title: 'Audio features (valence, energia, tempo)', host: 'api.reccobeats.com', sends: 'ID Spotify dei brani, a blocchi di 40' },
  { id: 'lyrics', title: 'Testi', host: 'lrclib.net', sends: 'titolo, artista, album e durata dei brani (tutti, dai più ascoltati)' },
  { id: 'lastfm', title: 'Tag e generi', host: 'musicbrainz.org (o Last.fm se inserisci la chiave)', sends: 'nome degli artisti (MusicBrainz) oppure titolo e artista (Last.fm)' },
  { id: 'llm', title: 'Funzioni AI (mappa del gusto, mood, nomi, assistente)', host: 'openrouter.ai', sends: 'titoli, artisti, album, tag, estratti di testo e risultati delle query; mai lo storico completo' },
];

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cx(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors',
        on ? 'bg-[var(--accent)]' : 'bg-surface-3',
      )}
    >
      <span
        aria-hidden
        className={cx('block size-5 rounded-full bg-white shadow transition-transform duration-200', on ? 'translate-x-5' : 'translate-x-0')}
      />
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

function CatalogCard() {
  const [v, setV] = useState(0);
  const st = useAsync(catalogStats, [v]);
  const n = (x: number | undefined) => (x ?? 0).toLocaleString('it-IT');
  const c = st.value;
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3">
      <div className="text-sm text-text-muted">
        <span className="num text-text">{n(c?.tracks)}</span> brani nel catalogo condiviso: <span className="num text-text">{n(c?.covers)}</span> copertine
        {' '}(<span className="num text-text">{n(c?.images)}</span> immagini salvate, {((c?.imageBytes ?? 0) / 1e6).toFixed(1)} MB), <span className="num text-text">{n(c?.lyrics)}</span> testi,{' '}
        <span className="num text-text">{n(c?.audio)}</span> audio features, <span className="num text-text">{n(c?.tags)}</span> tag, <span className="num text-text">{n(c?.embeddings)}</span>{' '}
        embedding, <span className="num text-text">{n(c?.ai)}</span> stime AI per brano (restano etichettate come stime). Sono dati pubblici del catalogo, nel database locale: valgono per tutte le analisi e per chiunque usi questa app, così non vanno mai riscaricati.
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={async () => {
          await clearCatalog();
          setV((x) => x + 1);
        }}
      >
        Svuota cache
      </Button>
    </Card>
  );
}

function KeysForm() {
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSettings);
  const [draft, setDraft] = useState({
    openrouterKey: settings.openrouterKey,
    lastfmKey: settings.lastfmKey,
    llmModelBulk: settings.llmModelBulk,
    llmModelAgent: settings.llmModelAgent,
  });
  const [state, setState] = useState<{ kind: 'idle' | 'saving' | 'ok' | 'error'; msg?: string }>({ kind: 'idle' });
  const dirty =
    draft.openrouterKey !== settings.openrouterKey ||
    draft.lastfmKey !== settings.lastfmKey ||
    draft.llmModelBulk !== settings.llmModelBulk ||
    draft.llmModelAgent !== settings.llmModelAgent;
  const set = (k: keyof typeof draft) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setDraft((d) => ({ ...d, [k]: e.target.value.trim() }));
    setState({ kind: 'idle' });
  };

  const save = async () => {
    setState({ kind: 'saving' });
    let msg = 'Salvato.';
    if (draft.openrouterKey) {
      try {
        const r = await checkOpenRouterKey(draft.openrouterKey);
        if (!r.ok) {
          setState({ kind: 'error', msg: 'OpenRouter non riconosce questa chiave. Controlla di averla copiata tutta.' });
          return;
        }
        msg = `Chiave OpenRouter valida${r.label ? ` (${r.label})` : ''}${r.limit != null ? ` · limite $${r.limit}` : ' · nessun limite di spesa impostato'}. Funzioni AI attivate.`;
      } catch {
        msg = 'Salvato (non è stato possibile verificare la chiave: sei offline?).';
      }
    }
    update({
      ...draft,
      connections: {
        ...settings.connections,
        llm: draft.openrouterKey ? true : settings.connections.llm,
        lastfm: draft.lastfmKey ? true : settings.connections.lastfm,
      },
    });
    setState({ kind: 'ok', msg });
    setTimeout(runAllEnabled, 50);
  };

  return (
    <Card className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        <span className="flex items-center gap-2 font-medium">
          <KeyRound size={14} /> OpenRouter
          {settings.openrouterKey && settings.connections.llm && (
            <span className="ml-1 inline-flex items-center gap-1 text-xs text-good">
              <CheckCircle2 size={12} /> attiva
            </span>
          )}
        </span>
        <input
          type="password"
          autoComplete="off"
          value={draft.openrouterKey}
          onChange={set('openrouterKey')}
          onKeyDown={(e) => e.key === 'Enter' && dirty && void save()}
          placeholder="sk-or-…"
          className="h-10 rounded-xl border border-border bg-surface-2 px-3 font-mono text-sm"
        />
        <span className="text-xs text-text-faint">
          {ENV_KEYS.openrouterKey
            ? 'Caricata automaticamente da .env.local (vale solo in locale, non finisce mai nella build).'
            : 'Crea una chiave su openrouter.ai/keys e imposta un limite di spesa. In locale puoi metterla in .env.local.'}
        </span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text-muted">Modello per elaborazioni in blocco</span>
          <input value={draft.llmModelBulk} onChange={set('llmModelBulk')} className="h-10 rounded-xl border border-border bg-surface-2 px-3 font-mono text-xs" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text-muted">Modello per l’assistente</span>
          <input value={draft.llmModelAgent} onChange={set('llmModelAgent')} className="h-10 rounded-xl border border-border bg-surface-2 px-3 font-mono text-xs" />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="flex items-center gap-2 font-medium">
          <KeyRound size={14} /> Last.fm <span className="text-xs font-normal text-text-faint">(facoltativa)</span>
        </span>
        <input
          type="password"
          autoComplete="off"
          value={draft.lastfmKey}
          onChange={set('lastfmKey')}
          placeholder="chiave API Last.fm"
          className="h-10 rounded-xl border border-border bg-surface-2 px-3 font-mono text-sm"
        />
        <span className="text-xs text-text-faint">Gratuita su last.fm/api/account/create. Serve per tag e generi.</span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={() => void save()} disabled={!dirty || state.kind === 'saving'}>
          {state.kind === 'saving' ? <Spinner size={14} /> : <Save size={14} />} Salva
        </Button>
        {dirty && state.kind === 'idle' && <span className="text-xs text-text-muted">Modifiche non salvate</span>}
        {state.kind === 'ok' && (
          <span role="status" className="flex items-center gap-1.5 text-sm text-good">
            <CheckCircle2 size={15} /> {state.msg}
          </span>
        )}
      </div>
      {state.kind === 'error' && <ErrorNote>{state.msg}</ErrorNote>}
      <p className="text-xs text-text-faint">
        Le chiavi sono salvate in chiaro nel localStorage di questo browser. Non usare questa app su computer condivisi con chiavi senza limiti di spesa.
      </p>
    </Card>
  );
}

function MoodAiSettings() {
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSettings);
  const job = useApp((s) => s.jobs[MOOD_AI_JOB]);
  const hasKey = settings.connections.llm && !!settings.openrouterKey;
  const running = job?.status === 'running';
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-medium">Avvia da solo quando c’è una chiave OpenRouter</div>
          <div className="text-xs text-text-faint">
            Dopo copertine, audio features, testi e tag, stima valence ed energia dei brani che ne sono privi (dai più ascoltati), usando testo e generi.
            Prima verifica lo stimatore su brani misurati (benchmark): se non batte la media non scrive nulla. Invia titolo, artista, tag e un estratto del testo. {hasKey ? '' : 'Ora non c’è una chiave: non parte.'}
          </div>
        </div>
        <Toggle
          label="Avvio automatico mood AI"
          on={settings.autoMoodAi}
          onChange={(v) => {
            update({ autoMoodAi: v });
            if (v) setTimeout(() => void autoMoodAi(), 50);
            else stopMoodAi();
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-text-muted">
          Brani per avvio
          <LimitSelect value={settings.autoMoodAiLimit} onChange={(v) => update({ autoMoodAiLimit: v })} label="Brani per avvio" />
        </label>
        {running ? (
          <Button size="sm" variant="danger" onClick={stopMoodAi}>
            Ferma ({job.done}/{job.total})
          </Button>
        ) : (
          job && <span className="text-xs text-text-faint">Ultimo avvio: {{ done: 'completato', paused: 'fermato', error: `errore${job.detail ? ` — ${job.detail}` : ''}`, running: '' }[job.status]}</span>
        )}
      </div>
    </Card>
  );
}

function EmbeddingSettings() {
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSettings);
  const job = useApp((s) => s.jobs[EMBED_JOB]);
  const hasKey = settings.connections.llm && !!settings.openrouterKey;
  const running = job?.status === 'running';
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-medium">Crea la mappa del gusto da sola quando c’è una chiave OpenRouter</div>
          <div className="text-xs text-text-faint">
            Dopo testi e tag calcola gli embedding di tutti i brani ascoltati (o dei più ascoltati, se scegli un limite), poi mappa UMAP e gruppi (cluster) nel browser. Serve a galassia, ricerca
            semantica, brani simili e somiglianza tra brani consecutivi nel modello degli skip. Invia a OpenRouter titolo, artista, album, tag e un
            estratto del testo. Costo indicativo ~$0,05 ogni 1.000 brani. {hasKey ? '' : 'Ora non c’è una chiave: non parte.'}
          </div>
        </div>
        <Toggle
          label="Avvio automatico mappa del gusto"
          on={settings.autoEmbeddings}
          onChange={(v) => {
            update({ autoEmbeddings: v });
            if (v) setTimeout(() => void autoEmbeddings(), 50);
            else stopEmbeddings();
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-text-muted">
          Brani nella mappa
          <LimitSelect value={settings.autoEmbeddingsLimit} onChange={(v) => update({ autoEmbeddingsLimit: v })} label="Brani nella mappa" />
        </label>
        {running ? (
          <Button size="sm" variant="danger" onClick={stopEmbeddings}>
            Ferma ({job.done}/{job.total})
          </Button>
        ) : (
          job && <span className="text-xs text-text-faint">Ultimo avvio: {{ done: 'completato', paused: 'fermato', error: `errore${job.detail ? ` — ${job.detail}` : ''}`, running: '' }[job.status]}</span>
        )}
      </div>
    </Card>
  );
}

export default function SettingsPage() {
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSettings);
  const net = useApp((s) => s.net);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const analysisName = useApp((s) => s.analysis?.name ?? 'questa analisi');

  const hosts = Array.from(
    net.reduce((m, e) => m.set(e.host, { ...e, n: (m.get(e.host)?.n ?? 0) + 1 }), new Map<string, { host: string; purpose: string; at: number; n: number }>()).values(),
  ).sort((a, b) => b.at - a.at);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-12">
      <PageHeader kicker="Impostazioni" title="Privacy e preferenze" sub="Tutto è calcolato e salvato sul tuo computer (database locale). Qui decidi tu cosa può uscire, e verso chi." />

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
        <KeysForm />
      </Section>

      <Section kicker="Mood AI" title="Stima automatica del mood con l’AI">
        <MoodAiSettings />
      </Section>

      <Section kicker="Mappa del gusto" title="Embedding e gruppi automatici">
        <EmbeddingSettings />
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

      <Section kicker="Dati" title={`Analisi “${analysisName}”`}>
        <Card className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                stopAll();
                leaveAnalysis();
              }}
              disabled={!!busy}
            >
              <Upload size={14} /> Nuova analisi / apri un’altra
            </Button>
            <UpdateCurrentButton />
            <Button
              variant="ghost"
              title="Mood, testi, tag e gruppi per brano, in JSON: serve a `npm run analysis` (ANALYSIS_META) per rigenerare i numeri fuori dal browser."
              onClick={async () => {
                const rows = await query(`SELECT * EXCLUDE (cover) FROM meta ORDER BY uri`);
                const url = URL.createObjectURL(new Blob([JSON.stringify(rows)], { type: 'application/json' }));
                const a = document.createElement('a');
                a.href = url;
                a.download = 'ascolti-arricchimento.json';
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 5000);
              }}
            >
              <Save size={14} /> Esporta arricchimento per l’analisi
            </Button>
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
              <Trash2 size={14} /> Elimina questa analisi
            </Button>
          ) : (
            <div className="rounded-xl border border-bad/40 bg-bad/10 p-4 text-sm">
              <div className="font-medium text-bad">Eliminare “{analysisName}”?</div>
              <p className="mt-1 text-text-muted">
                Storico, mood, mappa, conversazioni e confronti di questa analisi verranno eliminati dal database. Non si può annullare. Le altre analisi, la cache condivisa
                (copertine, testi…), le impostazioni e le chiavi restano.
              </p>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="danger"
                  onClick={async () => {
                    stopAll();
                    const id = useApp.getState().analysis?.id;
                    if (id) await analyses.remove(id);
                    await dropAll();
                    clearIndexCache();
                    leaveAnalysis();
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

      <Section kicker="Esclusi" title="Brani tolti da tutte le statistiche">
        <ExcludedList />
      </Section>

      <Section kicker="Cache condivisa" title="Copertine, testi e audio features nel database">
        <CatalogCard />
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

function ExcludedList() {
  const list = useAsync(() => getExcluded(), []);
  const [busy, setBusy] = useState(false);
  const rows = list.value ?? [];
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="flex flex-col gap-3">
      <p className="text-sm text-text-muted">
        Un brano escluso sparisce da classifiche, grafici, mood, racconto, modelli e PDF, come se non l’avessi mai ascoltato. Escludi dalla pagina del brano o passando sopra una riga
        nelle classifiche (<EyeOff size={12} className="inline" />).
      </p>
      {rows.length === 0 ? (
        <div className="text-sm text-text-faint">Nessun brano escluso.</div>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border">
            {rows.map((e) => (
              <li key={e.uri} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{e.track}</div>
                  <div className="truncate text-xs text-text-faint">{e.artist}</div>
                </div>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => includeTrack(e.uri))}>
                  <RotateCcw size={14} /> Ripristina
                </Button>
              </li>
            ))}
          </ul>
          {rows.length > 1 && (
            <Button size="sm" className="self-start" disabled={busy} onClick={() => run(includeAll)}>
              Ripristina tutti ({rows.length})
            </Button>
          )}
        </>
      )}
    </Card>
  );
}

/** Adds a newer export to the open analysis: new plays only; enrichment, map and chats are kept. */
function UpdateCurrentButton() {
  const id = useApp((s) => s.analysis?.id);
  const [step, setStep] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <>
      <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-border bg-surface-2 px-4 text-sm font-medium text-text hover:bg-surface-3">
        {step ? <Spinner size={14} /> : <RotateCcw size={14} />} {step ?? 'Carica ZIP aggiornato'}
        <input
          type="file"
          accept=".zip,.json"
          multiple
          hidden
          disabled={!!step || !id}
          onChange={async (e) => {
            if (!id || !e.target.files?.length) return;
            stopAll();
            setMsg(null);
            try {
              const r = await updateAnalysisFromFiles(id, Array.from(e.target.files), setStep);
              setMsg(r.added > 0 ? `+${r.added.toLocaleString('it-IT')} ascolti nuovi: ricarico…` : 'Nessun ascolto nuovo in questo export.');
              if (r.added > 0 || r.profileUpdated) setTimeout(() => location.reload(), 900);
            } catch (x) {
              setMsg(x instanceof Error ? x.message : String(x));
            } finally {
              setStep(null);
            }
          }}
        />
      </label>
      {msg && <span className="self-center text-sm text-text-muted">{msg}</span>}
    </>
  );
}
