// PDF of a comparison (#/report-compare/<other analysis id>): its own A4 document, separate from the personal
// report. Built from the SAVED comparison, so it prints exactly what Confronta shows.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, FileDown, Printer } from 'lucide-react';
import { analyses, type Analysis } from '../../lib/analyses';
import { coverSrc } from '../../lib/api';
import { nameGradient } from '../../lib/color';
import { fmtDate, fmtHours, fmtInt, fmtMonth, fmtPct } from '../../lib/format';
import { kv } from '../../lib/kv';
import { MOOD_HEX, moodLabel } from '../../lib/mood';
import { useRoute } from '../../lib/router';
import { useApp } from '../../lib/store';
import { Button, Spinner } from '../../components/ui';
import { COMPARE_VERSION, type Comparison, type Side, type TopItem } from './compareData';
import { narrateComparison } from './compareStory';

const ME = 'var(--accent-doc)';
const THEM = '#c7a3ff';

function Thumb({ src, name, size = 22, round = false }: { src?: string | null; name: string; size?: number; round?: boolean }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, borderRadius: round ? '50%' : Math.max(3, size / 7) };
  if (!src || failed) return <span className="doc-thumb" style={{ ...style, background: nameGradient(name) }} aria-hidden />;
  return <img className="doc-thumb" style={style} src={coverSrc(src) ?? undefined} alt="" crossOrigin="anonymous" decoding="async" onError={() => setFailed(true)} />;
}

function Page({ kicker, title, children }: { kicker: string; title: ReactNode; children: ReactNode }) {
  return (
    <section className="doc-page">
      <header className="doc-head">
        <div className="doc-kicker">{kicker}</div>
        <h2 className="doc-h2">{title}</h2>
      </header>
      {children}
    </section>
  );
}
const H3 = ({ children }: { children: ReactNode }) => <h3 className="doc-h3">{children}</h3>;

function DuoBar({ label, me, them, fmt, max }: { label: string; me: number; them: number; fmt: (v: number) => string; max: number }) {
  return (
    <div className="doc-hbar" style={{ gridTemplateColumns: '44mm 1fr 30mm', alignItems: 'start' }}>
      <div className="doc-trunc">{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1mm', paddingTop: '1.2mm' }}>
        {[me, them].map((v, i) => (
          <div key={i} className="doc-hbar-b">
            <span style={{ width: `${Math.min(100, (v / (max || 1)) * 100)}%`, background: i ? THEM : ME }} />
          </div>
        ))}
      </div>
      <div className="doc-hbar-v doc-num">
        <span style={{ color: ME }}>{fmt(me)}</span> · <span style={{ color: THEM }}>{fmt(them)}</span>
      </div>
    </div>
  );
}

function TopList({ title, items, color, round }: { title: string; items: TopItem[]; color: string; round?: boolean }) {
  const max = Math.max(...items.map((i) => i.hours), 1);
  return (
    <div>
      <H3>
        <span className="doc-dot" style={{ background: color, marginRight: '1.5mm' }} />
        {title}
      </H3>
      <table className="doc-rank">
        <tbody>
          {items.map((t, i) => (
            <tr key={`${t.label}-${i}`}>
              <td className="doc-rank-n">{i + 1}</td>
              <td className="doc-rank-c">
                <Thumb src={t.cover} name={t.label} round={round} />
              </td>
              <td className="doc-rank-t">
                <div className="doc-trunc doc-strong">{t.label}</div>
                {t.sub && <div className="doc-trunc doc-sub">{t.sub}</div>}
                <div className="doc-meter">
                  <span style={{ width: `${(t.hours / max) * 100}%`, background: color }} />
                </div>
              </td>
              <td className="doc-rank-v doc-num">{fmtHours(t.hours * 60)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Lines({ series, height = 180, yFmt, xLabels }: { series: Array<{ values: Array<number | null>; color: string }>; height?: number; yFmt: (v: number) => string; xLabels: string[] }) {
  const W = 1000;
  const pad = { l: 40, r: 8, t: 10, b: 22 };
  const n = Math.max(...series.map((s) => s.values.length), 2);
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const max = Math.max(...all, 0.0001);
  const min = Math.min(...all, 0);
  const sx = (i: number) => pad.l + (i * (W - pad.l - pad.r)) / (n - 1);
  const sy = (v: number) => pad.t + (1 - (v - min) / (max - min || 1)) * (height - pad.t - pad.b);
  return (
    <svg className="doc-svg" viewBox={`0 0 ${W} ${height}`} role="img">
      {[min, (min + max) / 2, max].map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} style={{ stroke: 'var(--rule)' }} />
          <text x={pad.l - 6} y={sy(v) + 4} textAnchor="end" fontSize={10} style={{ fill: 'var(--faint)' }}>
            {yFmt(v)}
          </text>
        </g>
      ))}
      {series.map((s, k) => {
        let d = '';
        s.values.forEach((v, i) => {
          if (v == null) return;
          d += `${d && s.values[i - 1] != null ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`;
        });
        return <path key={k} d={d} fill="none" stroke={s.color} strokeWidth={2.2} />;
      })}
      {xLabels.map((l, i) =>
        l ? (
          <text key={i} x={sx(i)} y={height - 6} textAnchor="middle" fontSize={10} style={{ fill: 'var(--faint)' }}>
            {l}
          </text>
        ) : null,
      )}
    </svg>
  );
}

const SIDE: Array<{ k: keyof Side; label: string; fmt: (v: number) => string }> = [
  { k: 'hours', label: 'Ore totali', fmt: (v) => fmtInt(v) },
  { k: 'hoursPerActiveDay', label: 'Ore nei giorni con musica', fmt: (v) => v.toFixed(1).replace('.', ',') },
  { k: 'artists', label: 'Artisti diversi', fmt: (v) => fmtInt(v) },
  { k: 'top10Share', label: 'Quota dei 10 preferiti', fmt: fmtPct },
  { k: 'novelty', label: 'Ascolto su brani nuovi', fmt: fmtPct },
  { k: 'weekend', label: 'Nel weekend', fmt: fmtPct },
  { k: 'night', label: 'Dopo mezzanotte', fmt: fmtPct },
  { k: 'skip', label: 'Brani saltati', fmt: fmtPct },
  { k: 'shuffle', label: 'Riproduzione casuale', fmt: fmtPct },
  { k: 'sessionMin', label: 'Sessione media (min)', fmt: (v) => fmtInt(v) },
  { k: 'valence', label: 'Positività media', fmt: (v) => fmtInt(v * 100) },
  { k: 'energy', label: 'Energia media', fmt: (v) => fmtInt(v * 100) },
];

function Doc({ c, me, them, today }: { c: Comparison; me: string; them: string; today: string }) {
  const story = narrateComparison(c, them);
  const shared = c.sharedTracks[0];
  const aff = new Map(c.byYear.map((y) => [y.year, y.affinity]));
  const months = c.moodMonthly;
  return (
    <>
      <section className="doc-page doc-cover">
        <div className="doc-kicker">Ascolti · confronto</div>
        <h1 className="doc-h1">
          {me} e {them}
        </h1>
        <p className="doc-lead">
          {me}: {fmtDate(c.me.from)} — {fmtDate(c.me.to)} · {them}: {fmtDate(c.them.from)} — {fmtDate(c.them.to)}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '50mm 1fr', gap: '10mm', marginTop: '12mm', alignItems: 'center' }}>
          <div>
            <div className="doc-num" style={{ fontSize: '58pt', lineHeight: 1, color: 'var(--accent-doc)' }}>
              {c.score}
            </div>
            <div className="doc-sub" style={{ fontSize: '10pt' }}>
              affinità su 100
            </div>
          </div>
          <div className="doc-hbars">
            {c.parts.map((p) => (
              <div key={p.key} className="doc-hbar" style={{ gridTemplateColumns: '26mm 1fr 12mm' }}>
                <div className="doc-strong">{p.label}</div>
                <div className="doc-hbar-b">
                  <span style={{ width: `${p.value * 100}%` }} />
                </div>
                <div className="doc-hbar-v doc-num">{Math.round(p.value * 100)}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="doc-podium">
          {c.topArtists.me[0] && (
            <div className="doc-pod">
              <Thumb src={c.topArtists.me[0].cover} name={c.topArtists.me[0].label} size={60} round />
              <div className="min-w-0">
                <div className="doc-kicker">Il preferito di {me}</div>
                <div className="doc-strong doc-trunc">{c.topArtists.me[0].label}</div>
                <div className="doc-sub doc-num">{fmtHours(c.topArtists.me[0].hours * 60)}</div>
              </div>
            </div>
          )}
          {c.topArtists.them[0] && (
            <div className="doc-pod">
              <Thumb src={c.topArtists.them[0].cover} name={c.topArtists.them[0].label} size={60} round />
              <div className="min-w-0">
                <div className="doc-kicker">Il preferito di {them}</div>
                <div className="doc-strong doc-trunc">{c.topArtists.them[0].label}</div>
                <div className="doc-sub doc-num">{fmtHours(c.topArtists.them[0].hours * 60)}</div>
              </div>
            </div>
          )}
          {shared && (
            <div className="doc-pod">
              <Thumb src={shared.cover} name={shared.track} size={60} />
              <div className="min-w-0">
                <div className="doc-kicker">La vostra canzone</div>
                <div className="doc-strong doc-trunc">{shared.track}</div>
                <div className="doc-sub doc-trunc">{shared.artist}</div>
              </div>
            </div>
          )}
        </div>
        <p className="doc-foot">
          Generato il {fmtDate(today)} dal confronto salvato in Ascolti. Affinità = media pesata di artisti (30%), generi (25%), brani, mood e abitudini (15% ciascuno):
          indice descrittivo calcolato sui due storici completi.
        </p>
      </section>

      <Page kicker="02 · Il racconto" title={`${me} e ${them}, in parole`}>
        <div className="doc-story">
          {story.map((p) => (
            <div key={p.title} className="doc-para">
              <h3 className="doc-h3">{p.title}</h3>
              <p>{p.text}</p>
            </div>
          ))}
        </div>
      </Page>

      <Page kicker="03 · Classifiche" title="I preferiti di ciascuno">
        <div className="doc-cols">
          <TopList title={`Artisti di ${me}`} items={c.topArtists.me} color={ME} round />
          <TopList title={`Artisti di ${them}`} items={c.topArtists.them} color={THEM} round />
        </div>
        <div className="doc-cols">
          <TopList title={`Brani di ${me}`} items={c.topTracks.me} color={ME} />
          <TopList title={`Brani di ${them}`} items={c.topTracks.them} color={THEM} />
        </div>
      </Page>

      <Page kicker="04 · Uno accanto all’altro" title="Come ascoltate">
        <div className="doc-legend" style={{ marginBottom: '4mm' }}>
          <span>
            <i className="doc-dot" style={{ background: ME }} /> {me}
          </span>
          <span>
            <i className="doc-dot" style={{ background: THEM }} /> {them}
          </span>
        </div>
        <div className="doc-hbars" style={{ gap: '3mm' }}>
          {SIDE.filter((r) => c.me[r.k] != null && c.them[r.k] != null).map((r) => {
            const a = Number(c.me[r.k]);
            const b = Number(c.them[r.k]);
            const pct = ['top10Share', 'novelty', 'weekend', 'night', 'skip', 'shuffle', 'valence', 'energy'].includes(r.k);
            return <DuoBar key={r.k} label={r.label} me={a} them={b} fmt={r.fmt} max={pct ? 1 : Math.max(a, b)} />;
          })}
        </div>
        <H3>La vostra giornata (quota del tempo per ora)</H3>
        <Lines series={[{ values: c.hours24.map((h) => h.me), color: ME }, { values: c.hours24.map((h) => h.them), color: THEM }]} yFmt={(v) => `${Math.round(v * 100)}%`} xLabels={c.hours24.map((h) => (h.hour % 3 === 0 ? String(h.hour) : ''))} />
        <p className="doc-note">
          Picco: {me} alle {c.me.peakHour}:00 ({c.me.topDevice}), {them} alle {c.them.peakHour}:00 ({c.them.topDevice}).
        </p>
      </Page>

      <Page kicker="05 · Nel tempo" title="I vostri periodi">
        <table className="doc-table" style={{ marginTop: 0 }}>
          <thead>
            <tr>
              <th>Anno</th>
              <th style={{ width: '62mm' }}>Artista di {me}</th>
              <th style={{ width: '62mm' }}>Artista di {them}</th>
              <th className="r">Ore</th>
              <th className="r">Affinità</th>
            </tr>
          </thead>
          <tbody>
            {c.yearsDetail.map((y) => (
              <tr key={y.year}>
                <td className="doc-num doc-strong">{y.year}</td>
                <td className="doc-trunc" style={{ color: y.shared ? 'var(--accent-doc)' : undefined }}>{y.me ?? '—'}</td>
                <td className="doc-trunc" style={{ color: y.shared ? 'var(--accent-doc)' : undefined }}>{y.them ?? '—'}</td>
                <td className="r doc-num">
                  {fmtInt(y.meH)} / {fmtInt(y.themH)}
                </td>
                <td className="r doc-num">{aff.has(y.year) ? Math.round(aff.get(y.year)! * 100) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <H3>Chi l’ha scoperto prima</H3>
        <p className="doc-lead" style={{ fontSize: '10pt', marginTop: 0 }}>
          {me} prima: <b className="doc-num">{fmtInt(c.firstFound.meFirst)}</b> · insieme: {fmtInt(c.firstFound.same)} · {them} prima:{' '}
          <b className="doc-num">{fmtInt(c.firstFound.themFirst)}</b>
        </p>
        <div className="doc-hbars">
          {c.firstFound.examples.slice(0, 6).map((e) => (
            <div key={e.artist} className="doc-hbar" style={{ gridTemplateColumns: '1fr 60mm' }}>
              <div className="doc-strong doc-trunc">{e.artist}</div>
              <div className="doc-hbar-v doc-num" style={{ color: e.leadDays > 0 ? ME : THEM }}>
                {e.leadDays > 0 ? me : them} {Math.abs(e.leadDays) >= 365 ? `${(Math.abs(e.leadDays) / 365).toFixed(1).replace('.', ',')} anni` : `${fmtInt(Math.abs(e.leadDays))} giorni`} prima
              </div>
            </div>
          ))}
        </div>
      </Page>

      <Page kicker="06 · Gusti e mood" title="Artisti, generi e suono">
        <div className="doc-cols">
          <div>
            <H3>Artisti che vi uniscono (ore)</H3>
            <div className="doc-hbars" style={{ gap: '2.2mm' }}>
              {c.sharedArtists.slice(0, 10).map((s) => (
                <DuoBar key={s.artist} label={s.artist} me={s.me} them={s.them} fmt={fmtHours} max={Math.max(...c.sharedArtists.map((x) => Math.max(x.me, x.them)))} />
              ))}
            </div>
          </div>
          <div>
            <H3>Generi in comune</H3>
            <p style={{ fontSize: '9pt', color: 'var(--muted)' }}>{c.tags.shared.join(' · ') || '—'}</p>
            <H3>Mix di mood</H3>
            <div className="doc-hbars" style={{ gap: '2.2mm' }}>
              {c.moodMix.map((m) => (
                <DuoBar key={m.mood} label={moodLabel(m.mood)} me={m.me} them={m.them} fmt={fmtPct} max={Math.max(...c.moodMix.map((x) => Math.max(x.me, x.them)))} />
              ))}
            </div>
            <div className="doc-legend">
              {c.moodMix.map((m) => (
                <span key={m.mood}>
                  <i className="doc-dot" style={{ background: MOOD_HEX[m.mood] }} /> {moodLabel(m.mood)}
                </span>
              ))}
            </div>
          </div>
        </div>
        {months.length > 6 && (
          <>
            <H3>Positività mese per mese (periodo in comune)</H3>
            <Lines
              series={[
                { values: months.map((m) => m.me), color: ME },
                { values: months.map((m) => m.them), color: THEM },
              ]}
              yFmt={(v) => `${Math.round(v * 100)}`}
              xLabels={months.map((m) => (m.ym.endsWith('-01') ? m.ym.slice(0, 4) : ''))}
            />
          </>
        )}
        <p className="doc-note">
          Mood noto per il {fmtPct(c.me.moodKnown)} del tempo di {me} e il {fmtPct(c.them.moodKnown)} di quello di {them}.
        </p>
      </Page>

      <Page kicker="07 · Record, sincronia e scambi" title="Primati, giorni in comune, canzoni da passarsi">
        <div className="doc-cols">
          {[
            { who: me, r: c.records.me, color: ME },
            { who: them, r: c.records.them, color: THEM },
          ].map(({ who, r, color }) => (
            <div key={who}>
              <H3>
                <span className="doc-dot" style={{ background: color, marginRight: '1.5mm' }} />
                Record di {who}
              </H3>
              <div className="doc-hbars">
                {r.topTrack && (
                  <div className="doc-hbar" style={{ gridTemplateColumns: '30mm 1fr' }}>
                    <span className="doc-sub">Brano di sempre</span>
                    <span className="doc-trunc doc-strong">
                      {r.topTrack.track} <span className="doc-sub">· {r.topTrack.artist}</span>
                    </span>
                  </div>
                )}
                {r.streak && (
                  <div className="doc-hbar" style={{ gridTemplateColumns: '30mm 1fr' }}>
                    <span className="doc-sub">Giorni di fila</span>
                    <span className="doc-num">
                      {fmtInt(r.streak.days)} <span className="doc-sub">({fmtDate(r.streak.from)} — {fmtDate(r.streak.to)})</span>
                    </span>
                  </div>
                )}
                {r.topDay && (
                  <div className="doc-hbar" style={{ gridTemplateColumns: '30mm 1fr' }}>
                    <span className="doc-sub">Giorno record</span>
                    <span className="doc-num">
                      {fmtHours(r.topDay.hours * 60)} <span className="doc-sub">{fmtDate(r.topDay.day)}</span>
                    </span>
                  </div>
                )}
                {r.topMonth && (
                  <div className="doc-hbar" style={{ gridTemplateColumns: '30mm 1fr' }}>
                    <span className="doc-sub">Mese più intenso</span>
                    <span>{fmtMonth(r.topMonth.ym)}</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
        <H3>In sincronia — {fmtInt(c.sync.days)} giorni con lo stesso brano, {fmtInt(c.sync.sameArtistDays)} con lo stesso artista</H3>
        <div className="doc-hbars">
          {c.sync.examples.slice(0, 6).map((e) => (
            <div key={`${e.day}-${e.track}`} className="doc-hbar" style={{ gridTemplateColumns: '1fr 30mm' }}>
              <span className="doc-trunc">
                <span className="doc-strong">{e.track}</span> <span className="doc-sub">· {e.artist}</span>
              </span>
              <span className="doc-hbar-v doc-num">{fmtDate(e.day)}</span>
            </div>
          ))}
        </div>
        <div className="doc-cols" style={{ marginTop: '2mm' }}>
          <div>
            <H3>Le vostre canzoni</H3>
            <div className="doc-hbars">
              {c.sharedTracks.slice(0, 8).map((t) => (
                <div key={t.uri} className="doc-hbar" style={{ gridTemplateColumns: '1fr' }}>
                  <span className="doc-trunc">
                    <span className="doc-strong">{t.track}</span> <span className="doc-sub">· {t.artist}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <H3>{me} → {them}</H3>
            <p style={{ fontSize: '9pt', color: 'var(--muted)' }}>{c.myGems.slice(0, 8).map((g) => g.artist).join(' · ')}</p>
            <H3>{them} → {me}</H3>
            <p style={{ fontSize: '9pt', color: 'var(--muted)' }}>{c.theirGems.slice(0, 8).map((g) => g.artist).join(' · ')}</p>
          </div>
        </div>
      </Page>
    </>
  );
}

export default function CompareReport() {
  const id = useRoute().path[1] ?? '';
  const meName = useApp((s) => s.analysis?.name ?? 'Tu');
  const [state, setState] = useState<{ c: Comparison; other: Analysis } | null | 'missing'>(null);
  const root = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const printed = useRef(false);
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    void (async () => {
      const [saved, other] = await Promise.all([kv.get<{ c: Comparison }>(`compare:${id}`), analyses.get(id).catch(() => null)]);
      setState(saved?.c?.v === COMPARE_VERSION && other ? { c: saved.c, other } : 'missing');
    })();
  }, [id]);

  useEffect(() => {
    if (!state || state === 'missing') return;
    document.documentElement.classList.add('report-mode');
    const prev = document.title;
    document.title = `Ascolti – ${meName} e ${state.other.name} – ${today}`;
    // Wait for covers (max 20 s), then open the print dialog once.
    const t0 = Date.now();
    const tick = setInterval(() => {
      const imgs = Array.from(root.current?.querySelectorAll('img') ?? []);
      if (imgs.every((i) => i.complete) || Date.now() - t0 > 20_000) {
        clearInterval(tick);
        setReady(true);
      }
    }, 300);
    return () => {
      clearInterval(tick);
      document.documentElement.classList.remove('report-mode');
      document.title = prev;
    };
  }, [state, meName, today]);

  useEffect(() => {
    if (!ready || printed.current || location.hash.includes('noprint=1')) return;
    printed.current = true;
    setTimeout(() => window.print(), 300);
  }, [ready]);

  return (
    <div className="report-root">
      <div className="report-toolbar no-print">
        <a href={`#/compare/${id}`} className="inline-flex items-center gap-2 text-sm text-text-muted hover:text-text">
          <ArrowLeft size={16} /> Torna al confronto
        </a>
        <div className="flex items-center gap-3 text-sm text-text-muted">
          {!ready ? (
            <>
              <Spinner /> Preparo il PDF…
            </>
          ) : (
            <>
              <FileDown size={16} className="text-[var(--accent)]" /> Pronto. Nella finestra di stampa scegli “Salva come PDF”, formato A4.
            </>
          )}
          <Button size="sm" variant="primary" disabled={!ready} onClick={() => window.print()}>
            <Printer size={14} /> Salva PDF
          </Button>
        </div>
      </div>
      {state === null && (
        <div className="flex items-center justify-center gap-3 py-24 text-text-muted">
          <Spinner /> Carico il confronto…
        </div>
      )}
      {state === 'missing' && <div className="py-24 text-center text-text-muted">Nessun confronto salvato con questa persona: aprilo prima in Confronta.</div>}
      {state && state !== 'missing' && (
        <div ref={root} className="doc">
          <Doc c={state.c} me={meName} them={state.other.name} today={today} />
        </div>
      )}
    </div>
  );
}
