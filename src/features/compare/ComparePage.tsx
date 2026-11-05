import { useRef, useState } from 'react';
import { Upload, Trash2, Users, ShieldCheck } from 'lucide-react';
import { exec, loadScratchPlays, query } from '../../data/db';
import { parseExport } from '../../data/import';
import { useAsync } from '../../data/useSql';
import { idb } from '../../lib/idb';
import { useApp } from '../../lib/store';
import { fmtHours, fmtInt, fmtPct } from '../../lib/format';
import { routes } from '../../lib/router';
import { centroid, loadIndex } from '../../ml/embeddings';
import { Badge, Button, Card, Empty, ErrorNote, Meter, PageHeader, Section, Spinner } from '../../components/ui';
import { StoryButton } from '../../components/StoryButton';

/** Only aggregates are stored for friends — never their raw history. */
interface Friend {
  id: string;
  name: string;
  totalMinutes: number;
  from: string;
  to: string;
  artists: Array<[string, number]>; // top 800 by minutes
  tracks: Array<[string, string, string, number]>; // uri, track, artist, minutes (top 1500)
  addedAt: number;
}

async function summarizeFriend(name: string, files: File[], onStep: (s: string) => void): Promise<Friend> {
  const { cols } = await parseExport(files, useApp.getState().settings.timeZone, onStep);
  onStep('Calcolo il profilo…');
  await loadScratchPlays(cols, 'friend_raw');
  const base = `SELECT * FROM friend_raw WHERE kind = 'track'`;
  const tot = await query<{ m: number; a: string; b: string }>(
    `SELECT sum(ms_played) / 60000.0 m, min(ts_local)::VARCHAR AS a, max(ts_local)::VARCHAR AS b FROM (${base})`,
  );
  const artists = await query<{ artist: string; m: number }>(
    `SELECT artist, sum(ms_played) / 60000.0 m FROM (${base}) GROUP BY 1 ORDER BY 2 DESC LIMIT 800`,
  );
  const tracks = await query<{ uri: string; track: string; artist: string; m: number }>(
    `SELECT coalesce(track_uri, 'local:' || artist || ' — ' || track) AS uri, any_value(track) AS track, any_value(artist) AS artist,
            sum(ms_played) / 60000.0 m FROM (${base}) GROUP BY 1 ORDER BY 4 DESC LIMIT 1500`,
  );
  await exec('DROP TABLE IF EXISTS friend_raw');
  return {
    id: `${Date.now()}`,
    name,
    totalMinutes: tot[0]?.m ?? 0,
    from: (tot[0]?.a ?? '').slice(0, 10),
    to: (tot[0]?.b ?? '').slice(0, 10),
    artists: artists.map((a) => [a.artist, a.m]),
    tracks: tracks.map((t) => [t.uri, t.track, t.artist, t.m]),
    addedAt: Date.now(),
  };
}

interface Comparison {
  score: number; // 0..100
  artistCosine: number;
  sharedArtists: Array<{ artist: string; me: number; them: number }>;
  theirGems: Array<{ artist: string; minutes: number }>;
  myGems: Array<{ artist: string; minutes: number }>;
  sharedTracks: Array<{ uri: string; track: string; artist: string }>;
  tasteSimilarity: number | null;
}

async function compare(f: Friend): Promise<Comparison> {
  const mine = await query<{ artist: string; m: number }>(`SELECT artist, sum(minutes) AS m FROM p GROUP BY 1 ORDER BY 2 DESC LIMIT 800`);
  const myTracks = await query<{ uri: string; track: string; artist: string; m: number }>(
    `SELECT uri, any_value(track) AS track, any_value(artist) AS artist, sum(minutes) AS m FROM p GROUP BY uri ORDER BY m DESC LIMIT 1500`,
  );
  const A = new Map(mine.map((r) => [r.artist, r.m]));
  const B = new Map(f.artists);
  const totA = mine.reduce((s, r) => s + r.m, 0) || 1;
  const totB = f.artists.reduce((s, r) => s + r[1], 0) || 1;
  // Cosine on sqrt-shares (dampens superstar dominance).
  let dotp = 0;
  let na = 0;
  let nb = 0;
  for (const [, v] of A) na += v / totA;
  for (const [, v] of B) nb += v / totB;
  for (const [k, v] of A) {
    const w = B.get(k);
    if (w) dotp += Math.sqrt((v / totA) * (w / totB));
  }
  const artistCosine = dotp / Math.sqrt(na * nb || 1);
  const shared = Array.from(A.entries())
    .filter(([k]) => B.has(k))
    .map(([artist, me]) => ({ artist, me, them: B.get(artist)! }))
    .sort((x, y) => Math.min(y.me / totA, y.them / totB) - Math.min(x.me / totA, x.them / totB))
    .slice(0, 10);
  const theirGems = f.artists
    .filter(([a]) => (A.get(a) ?? 0) < 5)
    .slice(0, 8)
    .map(([artist, minutes]) => ({ artist, minutes }));
  const myGems = mine
    .filter((r) => (B.get(r.artist) ?? 0) < 5)
    .slice(0, 8)
    .map((r) => ({ artist: r.artist, minutes: r.m }));
  const theirUris = new Set(f.tracks.map((t) => t[0]));
  const sharedTracks = myTracks.filter((t) => theirUris.has(t.uri)).slice(0, 12);

  // Embedding centroid similarity over tracks present in my semantic index.
  let tasteSimilarity: number | null = null;
  const index = await loadIndex();
  if (index) {
    const wa = new Map(myTracks.map((t) => [t.uri, Math.sqrt(t.m)]));
    const wb = new Map(f.tracks.map((t) => [t[0], Math.sqrt(t[3])]));
    const ca = centroid(index, wa);
    const cb = centroid(index, wb);
    const covered = f.tracks.filter((t) => index.uris.includes(t[0])).length;
    if (ca && cb && covered >= 30) {
      let s = 0;
      for (let i = 0; i < index.dim; i++) s += ca[i] * cb[i];
      tasteSimilarity = s;
    }
  }
  const score = Math.round(100 * Math.min(1, 0.65 * Math.sqrt(artistCosine) + 0.35 * (tasteSimilarity != null ? Math.max(0, (tasteSimilarity - 0.5) / 0.5) : Math.sqrt(artistCosine))));
  return { score, artistCosine, sharedArtists: shared, theirGems, myGems, sharedTracks, tasteSimilarity };
}

function FriendCard({ f, onRemove }: { f: Friend; onRemove: () => void }) {
  const c = useAsync(() => compare(f), [f.id]);
  return (
    <Card className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs text-text-faint">Tu e</div>
          <div className="display text-4xl">{f.name}</div>
          <div className="text-xs text-text-faint">
            {fmtHours(f.totalMinutes)} di ascolto · {f.from} → {f.to}
          </div>
        </div>
        <div className="flex items-center gap-4">
          {c.value && (
            <div className="text-right">
              <div className="num text-5xl text-[var(--accent)]">{c.value.score}</div>
              <div className="text-xs text-text-faint">compatibilità su 100</div>
            </div>
          )}
          {c.value && (
            <StoryButton
              build={() => ({
                kicker: 'Compatibilità musicale',
                title: `Io e ${f.name}`,
                hero: { value: `${c.value!.score}`, unit: 'su 100' },
                sections: [
                  { title: 'Artisti in comune', rows: c.value!.sharedArtists.slice(0, 5).map((s) => ({ label: s.artist })) },
                  { title: 'Brani che amiamo entrambi', rows: c.value!.sharedTracks.slice(0, 4).map((t) => ({ label: t.track, sub: t.artist })) },
                ],
                filename: `compatibilita ${f.name}`,
              })}
            />
          )}
          <Button size="sm" variant="ghost" aria-label={`Rimuovi ${f.name}`} onClick={onRemove}>
            <Trash2 size={14} />
          </Button>
        </div>
      </div>
      {c.loading && <Spinner />}
      {c.value && (
        <div className="grid gap-6 md:grid-cols-3">
          <div>
            <div className="mb-2 text-sm font-medium">In comune</div>
            <div className="flex flex-col gap-2">
              {c.value.sharedArtists.map((s) => (
                <a key={s.artist} href={routes.artist(s.artist)} className="text-sm hover:text-[var(--accent)]">
                  <div className="flex justify-between gap-2">
                    <span className="truncate">{s.artist}</span>
                    <span className="num shrink-0 text-xs text-text-faint">
                      {fmtHours(s.me)} / {fmtHours(s.them)}
                    </span>
                  </div>
                  <Meter value={Math.min(s.me, s.them)} max={Math.max(...c.value!.sharedArtists.map((x) => Math.min(x.me, x.them)))} />
                </a>
              ))}
              {!c.value.sharedArtists.length && <div className="text-sm text-text-faint">Nessun artista in comune.</div>}
            </div>
          </div>
          <div>
            <div className="mb-2 text-sm font-medium">Da {f.name} potresti scoprire</div>
            <div className="flex flex-wrap gap-2">
              {c.value.theirGems.map((g) => (
                <Badge key={g.artist}>{g.artist}</Badge>
              ))}
            </div>
            <div className="mb-2 mt-5 text-sm font-medium">Tu potresti fargli sentire</div>
            <div className="flex flex-wrap gap-2">
              {c.value.myGems.map((g) => (
                <Badge key={g.artist} tone="accent">
                  {g.artist}
                </Badge>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-2 text-sm font-medium">Brani che amate entrambi</div>
            <div className="flex flex-col gap-1">
              {c.value.sharedTracks.map((t) => (
                <a key={t.uri} href={routes.track(t.uri)} className="truncate text-sm hover:text-[var(--accent)]">
                  {t.track} <span className="text-text-faint">— {t.artist}</span>
                </a>
              ))}
              {!c.value.sharedTracks.length && <div className="text-sm text-text-faint">Nessuno tra i più ascoltati.</div>}
            </div>
            <div className="mt-4 text-xs text-text-faint">
              Somiglianza artisti {fmtPct(c.value.artistCosine)}
              {c.value.tasteSimilarity != null && <> · somiglianza semantica {fmtPct(c.value.tasteSimilarity)}</>}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

export default function ComparePage() {
  const [v, setV] = useState(0);
  const friends = useAsync(async () => (await idb.get<Friend[]>('friends')) ?? [], [v]);
  const [name, setName] = useState('');
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setErr(null);
    try {
      const f = await summarizeFriend(name.trim() || 'Amico', Array.from(files), setStep);
      await idb.set('friends', [...(friends.value ?? []), f]);
      setName('');
      setV((x) => x + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setStep(null);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-10">
      <PageHeader kicker="Confronta" title="Tu e i tuoi amici" sub="Carica l’export di un amico (con il suo consenso). Salviamo solo un riassunto anonimo dei suoi artisti e brani principali, mai lo storico completo." />
      <Card className="flex flex-col gap-4">
        <div className="flex items-center gap-2 font-medium">
          <Users size={18} className="text-[var(--accent)]" /> Aggiungi un confronto
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome (es. Giulia)" aria-label="Nome dell’amico" className="h-10 w-56 rounded-full border border-border bg-surface-2 px-4 text-sm" />
          <Button variant="primary" onClick={() => input.current?.click()} disabled={!!step}>
            {step ? <Spinner size={14} /> : <Upload size={16} />} {step ?? 'Carica ZIP'}
          </Button>
          <input ref={input} type="file" accept=".zip,.json" multiple hidden onChange={(e) => void add(e.target.files)} />
        </div>
        <div className="flex items-center gap-2 text-xs text-text-faint">
          <ShieldCheck size={13} className="text-good" /> Elaborato nel browser; il file non viene salvato.
        </div>
        {err && <ErrorNote>{err}</ErrorNote>}
      </Card>
      <Section kicker="Confronti" title={friends.value?.length ? `${fmtInt(friends.value.length)} ${friends.value.length === 1 ? 'confronto' : 'confronti'}` : 'Nessun confronto ancora'}>
        <div className="flex flex-col gap-6">
          {(friends.value ?? []).map((f) => (
            <FriendCard
              key={f.id}
              f={f}
              onRemove={async () => {
                await idb.set('friends', (friends.value ?? []).filter((x) => x.id !== f.id));
                setV((x) => x + 1);
              }}
            />
          ))}
          {!friends.value?.length && <Empty title="Aggiungi il primo amico">La compatibilità usa artisti in comune e, se hai creato la galassia, la somiglianza semantica dei brani.</Empty>}
        </div>
      </Section>
    </div>
  );
}
