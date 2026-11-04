import { useMemo, useRef, useState } from 'react';
import { Pencil, Upload, ListMusic, Heart, Search, Tags, Gift } from 'lucide-react';
import { useApp } from '../../lib/store';
import { useAsync } from '../../data/useSql';
import { query } from '../../data/db';
import { importFiles, setProfileName } from '../../data/lifecycle';
import { fmtDate, fmtInt, countryName } from '../../lib/format';
import { routes } from '../../lib/router';
import { Badge, Button, Card, Empty, ErrorNote, PageHeader, Section, Spinner, Stat } from '../../components/ui';

/** Spotify inference labels look like "1P_Custom_Auto_Lovers" or "3P_Music_Pop": make them readable. */
function prettyInference(raw: string) {
  return raw
    .replace(/^\d+P_/, '')
    .replace(/^(Custom|Custom_Audience|Segment)_/i, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pulls human-readable highlights out of Wrapped JSON, whatever its exact shape. */
function wrappedHighlights(summary: Record<string, unknown>): string[] {
  const out: string[] = [];
  const visit = (v: unknown, path: string, depth: number) => {
    if (out.length >= 6 || depth > 3 || v == null) return;
    if (Array.isArray(v)) {
      const names = v
        .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? ((x as Record<string, unknown>).name ?? (x as Record<string, unknown>).trackName ?? (x as Record<string, unknown>).artistName) : null))
        .filter((x): x is string => typeof x === 'string')
        .slice(0, 5);
      if (names.length && /top|artist|track|song|genre/i.test(path)) out.push(`${path.replace(/([A-Z])/g, ' $1').toLowerCase().trim()}: ${names.join(', ')}`);
      return;
    }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) visit(x, k, depth + 1);
  };
  visit(summary, '', 0);
  return out;
}

export default function ProfilePage() {
  const profile = useApp((s) => s.profile);
  const dataset = useApp((s) => s.dataset);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile?.displayName ?? '');
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const liked = useAsync(async () => {
    if (!profile?.likedTracks?.length) return null;
    const rows = await query<{ uri: string; plays: number; last_day: string; days_ago: number }>(
      `SELECT uri, plays, last_day::VARCHAR AS last_day, date_diff('day', last_day, (SELECT max(day) FROM plays)) AS days_ago FROM tracks`,
    );
    const m = new Map(rows.map((r) => [r.uri, r]));
    const never = profile.likedTracks.filter((t) => !m.get(t.uri)?.plays);
    const forgotten = profile.likedTracks
      .map((t) => ({ ...t, info: m.get(t.uri) }))
      .filter((t) => t.info && t.info.plays >= 3 && t.info.days_ago > 180)
      .sort((a, b) => (b.info!.plays ?? 0) - (a.info!.plays ?? 0));
    return { total: profile.likedTracks.length, never, forgotten };
  }, [profile?.importedAt]);

  const topSearches = useMemo(() => {
    const c = new Map<string, number>();
    for (const s of profile?.searches ?? []) {
      const k = s.query.toLowerCase();
      c.set(k, (c.get(k) ?? 0) + 1);
    }
    return Array.from(c.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);
  }, [profile?.searches]);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setErr(null);
    try {
      await importFiles(Array.from(files), setStep, { mode: 'merge' });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setStep(null);
    }
  };

  const hasAccount = !!profile?.files?.length;
  const title = profile?.displayName ?? profile?.username ?? 'Il tuo profilo';

  return (
    <div className="flex flex-col gap-12">
      <PageHeader
        kicker="Profilo"
        title={
          editing ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await setProfileName(name);
                setEditing(false);
              }}
              className="flex items-center gap-2"
            >
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Nome" className="display w-full max-w-lg rounded-xl border border-border bg-surface-1 px-3 text-5xl" />
              <Button variant="primary" type="submit">
                Salva
              </Button>
            </form>
          ) : (
            <span className="inline-flex items-center gap-3">
              {title}
              <button onClick={() => setEditing(true)} aria-label="Modifica nome" className="grid size-9 place-items-center rounded-full text-text-faint hover:bg-surface-2 hover:text-text">
                <Pencil size={18} />
              </button>
            </span>
          )
        }
        sub={
          hasAccount
            ? [profile?.username && `@${profile.username}`, profile?.country && countryName(profile.country), profile?.createdAt && `su Spotify dal ${fmtDate(profile.createdAt)}`]
                .filter(Boolean)
                .join(' · ')
            : 'Carica il pacchetto “Dati dell’account” di Spotify per vedere playlist, brani salvati, ricerche e come Spotify ti classifica.'
        }
        right={
          <div className="flex flex-col items-start gap-2 md:items-end">
            <Button onClick={() => input.current?.click()} disabled={!!step}>
              {step ? <Spinner size={14} /> : <Upload size={14} />} {hasAccount ? 'Aggiorna dati account' : 'Carica dati account'}
            </Button>
            <span className="text-xs text-text-faint">Cronologia: {dataset?.historyKind === 'legacy' ? 'solo ultimo anno' : 'completa'}</span>
            <input ref={input} type="file" accept=".zip,.json" multiple hidden onChange={(e) => void upload(e.target.files)} />
          </div>
        }
      />
      {err && <ErrorNote>{err}</ErrorNote>}

      {!hasAccount ? (
        <Empty title="Dati dell’account non ancora caricati" icon={<Upload size={22} />}>
          Su spotify.com → Privacy richiedi “Dati dell’account”. Arriva in circa 5 giorni, in uno ZIP separato dalla cronologia estesa: caricalo qui e resterà tutto quello che hai già.
        </Empty>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-6 border-y border-border py-6 md:grid-cols-5">
            <Stat label="Brani salvati" value={fmtInt(profile!.library.tracks)} />
            <Stat label="Album salvati" value={fmtInt(profile!.library.albums)} />
            <Stat label="Artisti seguiti" value={fmtInt(profile!.library.artists)} />
            <Stat label="Playlist" value={fmtInt(profile!.playlists.length)} />
            <Stat label="Ricerche" value={fmtInt(profile!.searches.length)} />
          </section>

          {liked.value && (
            <Section kicker="Libreria" title={`Dei tuoi ${fmtInt(liked.value.total)} brani salvati, ${fmtInt(liked.value.never.length)} non li hai mai ascoltati`}>
              <div className="grid gap-6 lg:grid-cols-2">
                <Card>
                  <div className="mb-3 flex items-center gap-2 font-medium">
                    <Heart size={16} className="text-[var(--accent)]" /> Salvati e dimenticati
                  </div>
                  <div className="flex flex-col gap-1">
                    {liked.value.forgotten.slice(0, 10).map((t) => (
                      <a key={t.uri} href={routes.track(t.uri)} className="flex justify-between gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2">
                        <span className="truncate">
                          {t.track} <span className="text-text-faint">— {t.artist}</span>
                        </span>
                        <span className="num shrink-0 text-xs text-text-faint">{fmtInt(t.info!.plays)} ascolti · {fmtDate(t.info!.last_day)}</span>
                      </a>
                    ))}
                    {!liked.value.forgotten.length && <div className="text-sm text-text-faint">Nessuno: ascolti davvero quello che salvi.</div>}
                  </div>
                </Card>
                <Card>
                  <div className="mb-3 flex items-center gap-2 font-medium">
                    <Heart size={16} /> Salvati ma mai ascoltati
                  </div>
                  <div className="flex flex-col gap-1">
                    {liked.value.never.slice(0, 10).map((t) => (
                      <div key={t.uri} className="truncate px-2 py-1.5 text-sm">
                        {t.track} <span className="text-text-faint">— {t.artist}</span>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>
            </Section>
          )}

          {profile!.playlists.length > 0 && (
            <Section kicker="Playlist" title="Le tue playlist">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {[...profile!.playlists]
                  .sort((a, b) => (b.lastModified ?? '').localeCompare(a.lastModified ?? ''))
                  .slice(0, 18)
                  .map((pl, i) => (
                    <Card key={i} className="p-4">
                      <div className="flex items-start gap-2">
                        <ListMusic size={16} className="mt-0.5 shrink-0 text-text-faint" />
                        <div className="min-w-0">
                          <div className="truncate font-medium">{pl.name}</div>
                          <div className="text-xs text-text-faint">
                            {fmtInt(pl.tracks)} brani{pl.lastModified ? ` · modificata ${fmtDate(pl.lastModified)}` : ''}
                            {pl.followers ? ` · ${fmtInt(pl.followers)} follower` : ''}
                          </div>
                          {pl.sample.length > 0 && <div className="mt-2 line-clamp-2 text-xs text-text-muted">{pl.sample.join(' · ')}</div>}
                        </div>
                      </div>
                    </Card>
                  ))}
              </div>
            </Section>
          )}

          <div className="grid gap-10 lg:grid-cols-2">
            {topSearches.length > 0 && (
              <Section kicker="Ricerche" title="Cosa cerchi di più">
                <Card className="flex flex-wrap gap-2">
                  {topSearches.map(([q, n]) => (
                    <Badge key={q}>
                      <Search size={11} /> {q} <span className="num text-text-faint">{n}</span>
                    </Badge>
                  ))}
                </Card>
              </Section>
            )}
            {profile!.inferences.length > 0 && (
              <Section kicker="Come ti vede Spotify" title={`${fmtInt(profile!.inferences.length)} etichette che Spotify usa per la pubblicità`}>
                <Card className="flex max-h-72 flex-wrap gap-2 overflow-y-auto scrollbar-thin">
                  {profile!.inferences.slice(0, 120).map((x) => (
                    <Badge key={x}>
                      <Tags size={11} /> {prettyInference(x)}
                    </Badge>
                  ))}
                </Card>
              </Section>
            )}
          </div>

          {profile!.wrapped.length > 0 && (
            <Section kicker="Wrapped" title="I tuoi Wrapped ufficiali">
              <div className="grid gap-3 md:grid-cols-2">
                {profile!.wrapped
                  .sort((a, b) => b.year - a.year)
                  .map((w) => (
                    <Card key={w.year}>
                      <div className="mb-2 flex items-center gap-2 font-medium">
                        <Gift size={16} className="text-[var(--accent)]" /> Wrapped {w.year}
                        <a href={routes.story(w.year)} className="ml-auto text-xs text-[var(--accent)]">
                          Confronta con il racconto
                        </a>
                      </div>
                      <ul className="flex flex-col gap-1 text-sm text-text-muted">
                        {wrappedHighlights(w.summary).map((h) => (
                          <li key={h} className="capitalize-first">{h}</li>
                        ))}
                      </ul>
                    </Card>
                  ))}
              </div>
            </Section>
          )}
          <p className="text-xs text-text-faint">File letti: {profile!.files.join(', ')}. Restano solo in questo browser.</p>
        </>
      )}
    </div>
  );
}
