// Extra PDF pages: everything the app shows beyond the basics — calendar, mood over time, taste map, eras,
// artists over time (lifecycle, loyal, flames, rediscovery), the skip model and session types.
// Same data and same functions as the app pages, rendered as vector SVG for A4.
import type { ReactNode } from 'react';
import type { Survival } from '../../ml/models';
import type { AxisReading } from '../../ml/mapAxes';
import type { ExtraData } from './reportExtraData';
import { CLUSTER_COLORS } from '../../lib/color';
import { fmtDate, fmtHours, fmtInt, fmtMonth, fmtPct } from '../../lib/format';
import { MOOD_HEX } from '../../lib/mood';

const ACCENT = 'var(--accent-doc)';

// ---------- small building blocks (same look as ReportPage) ----------

function Page({ id, kicker, title, children }: { id: string; kicker: string; title: ReactNode; children: ReactNode }) {
  return (
    <section className="doc-page" id={`r-${id}`}>
      <header className="doc-head">
        <div className="doc-kicker">{kicker}</div>
        <h2 className="doc-h2">{title}</h2>
      </header>
      {children}
    </section>
  );
}
const H3 = ({ children }: { children: ReactNode }) => <h3 className="doc-h3">{children}</h3>;

// ---------- calendar ----------

function YearCalendar({ year, days, max, active, minutes }: { year: number; days: Map<string, number>; max: number; active: number; minutes: number }) {
  const cell = 11;
  const gap = 2;
  const L = 78; // label column
  const start = new Date(Date.UTC(year, 0, 1));
  const offset = (start.getUTCDay() + 6) % 7; // Monday = 0
  const cells: ReactNode[] = [];
  for (let d = new Date(start); d.getUTCFullYear() === year; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const idx = Math.round((d.getTime() - start.getTime()) / 86_400_000) + offset;
    const col = Math.floor(idx / 7);
    const row = idx % 7;
    const v = days.get(iso) ?? 0;
    const t = v ? Math.min(1, Math.sqrt(v / max)) : 0;
    cells.push(
      <rect key={iso} x={L + col * (cell + gap)} y={row * (cell + gap)} width={cell} height={cell} rx={2} style={{ fill: v ? ACCENT : 'var(--track)', fillOpacity: v ? 0.15 + 0.85 * t : 1 }} />,
    );
  }
  const W = L + 54 * (cell + gap);
  const H = 7 * (cell + gap);
  return (
    <svg className="doc-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Calendario ${year}`}>
      <text x={0} y={H / 2 - 8} fontSize={14} fontWeight={600} style={{ fill: 'var(--ink)' }} fontFamily="var(--font-mono)">
        {year}
      </text>
      <text x={0} y={H / 2 + 8} fontSize={10} style={{ fill: 'var(--faint)' }}>
        {fmtInt(active)} giorni
      </text>
      <text x={0} y={H / 2 + 21} fontSize={10} style={{ fill: 'var(--faint)' }}>
        {fmtInt(minutes / 60)} h
      </text>
      {cells}
    </svg>
  );
}

export function CalendarPage({ x, kicker }: { x: ExtraData; kicker: string }) {
  if (x.daily.length < 14) return null;
  const days = new Map(x.daily.map((d) => [d.day, d.minutes]));
  const sorted = x.daily.map((d) => d.minutes).sort((a, b) => a - b);
  const max = sorted[Math.floor(sorted.length * 0.98)] || 1; // 98th percentile: a few marathons don't wash out the rest
  const years = [...new Set(x.daily.map((d) => Number(d.day.slice(0, 4))))].sort((a, b) => a - b);
  const byYear = years.map((y) => {
    const ds = x.daily.filter((d) => d.day.startsWith(String(y)));
    return { y, active: ds.length, minutes: ds.reduce((s, d) => s + d.minutes, 0) };
  });
  return (
    <Page id="calendar" kicker={kicker} title="Ogni giorno, un quadretto">
      <div className="flex flex-col" style={{ gap: '2.5mm' }}>
        {byYear.map((r) => (
          <YearCalendar key={r.y} year={r.y} days={days} max={max} active={r.active} minutes={r.minutes} />
        ))}
      </div>
      <p className="doc-note">Più chiaro = più minuti quel giorno (scala fino al 98° percentile dei giorni attivi). Settimane da lunedì.</p>
    </Page>
  );
}

// ---------- mood over time ----------

export function MoodOverTime({ x }: { x: ExtraData }) {
  const rows = x.moodMonthly.filter((m) => m.valence != null && m.known >= 0.3);
  if (rows.length < 6) return null;
  const W = 1000;
  const H = 190;
  const pad = { l: 34, r: 8, t: 10, b: 22 };
  const sx = (i: number) => pad.l + (i * (W - pad.l - pad.r)) / Math.max(1, rows.length - 1);
  const sy = (v: number) => pad.t + (1 - v) * (H - pad.t - pad.b);
  const line = (k: 'valence' | 'energy') => rows.map((r, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(r[k] ?? 0.5).toFixed(1)}`).join(' ');
  return (
    <>
      <H3>Mood nel tempo (media mensile)</H3>
      <svg className="doc-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Positività ed energia per mese">
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} style={{ stroke: 'var(--rule)' }} />
            <text x={pad.l - 6} y={sy(v) + 4} textAnchor="end" fontSize={10} style={{ fill: 'var(--faint)' }}>
              {Math.round(v * 100)}
            </text>
          </g>
        ))}
        <path d={line('energy')} fill="none" stroke={MOOD_HEX.arrabbiato} strokeWidth={2} />
        <path d={line('valence')} fill="none" stroke={MOOD_HEX.euforico} strokeWidth={2} />
        {rows.map((r, i) =>
          r.ym.endsWith('-01') ? (
            <text key={r.ym} x={sx(i)} y={H - 6} textAnchor="middle" fontSize={10} style={{ fill: 'var(--faint)' }}>
              {r.ym.slice(0, 4)}
            </text>
          ) : null,
        )}
      </svg>
      <div className="doc-legend">
        <span>
          <i className="doc-dot" style={{ background: MOOD_HEX.euforico }} /> positività (valence)
        </span>
        <span>
          <i className="doc-dot" style={{ background: MOOD_HEX.arrabbiato }} /> energia
        </span>
        <span className="doc-sub">mesi con mood noto per almeno il 30% del tempo</span>
      </div>
    </>
  );
}

// ---------- taste map ----------

export function MapPage({ x, kicker }: { x: ExtraData; kicker: string }) {
  const m = x.map;
  if (!m || m.points.length < 30) return null;
  const W = 1000;
  const H = 640;
  const q = (vals: number[], p: number) => vals[Math.round(p * (vals.length - 1))];
  const xs = m.points.map((p) => p.x).sort((a, b) => a - b);
  const ys = m.points.map((p) => p.y).sort((a, b) => a - b);
  const [x0, x1, y0, y1] = [q(xs, 0.01), q(xs, 0.99), q(ys, 0.01), q(ys, 0.99)];
  const pad = 24;
  const s = Math.min((W - 2 * pad) / (x1 - x0 || 1), (H - 2 * pad) / (y1 - y0 || 1));
  const ox = pad + (W - 2 * pad - (x1 - x0) * s) / 2;
  const oy = pad + (H - 2 * pad - (y1 - y0) * s) / 2;
  const sx = (v: number) => ox + (v - x0) * s;
  const sy = (v: number) => oy + (v - y0) * s;
  const inside = (p: { x: number; y: number }) => sx(p.x) > 2 && sx(p.x) < W - 2 && sy(p.y) > 2 && sy(p.y) < H - 2;
  const pts = [...m.points].sort((a, b) => a.minutes - b.minutes).filter(inside);
  const total = m.clusters.reduce((acc, c) => acc + c.minutes, 0) || 1;
  const ax = m.axes;
  const tend = (a: AxisReading) => (Math.abs(a.r) < 0.4 ? ' (tendenza)' : '');
  return (
    <Page id="map" kicker={kicker} title={`${fmtInt(m.points.length)} brani, vicini se si somigliano`}>
      <svg className="doc-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Mappa del gusto" style={{ background: 'var(--card)', borderRadius: '3mm' }}>
        {pts.map((p, i) => (
          <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={1.4 + Math.sqrt(p.minutes) * 0.22} fill={CLUSTER_COLORS[p.cluster % CLUSTER_COLORS.length]} fillOpacity={0.75} />
        ))}
        {m.landmarks.filter(inside).map((l) => (
          <g key={l.text}>
            <rect x={sx(l.x) - l.text.length * 3.6 - 6} y={sy(l.y) - 11} width={l.text.length * 7.2 + 12} height={20} rx={10} style={{ fill: 'var(--color-bg)' }} fillOpacity={0.85} />
            <text x={sx(l.x)} y={sy(l.y) + 4} textAnchor="middle" fontSize={12} style={{ fill: 'var(--ink)' }}>
              {l.text}
            </text>
          </g>
        ))}
        {ax.x && (
          <>
            <text x={10} y={H / 2} fontSize={11} style={{ fill: 'var(--muted)' }}>← {ax.x.low}{tend(ax.x)}</text>
            <text x={W - 10} y={H / 2} textAnchor="end" fontSize={11} style={{ fill: 'var(--muted)' }}>{ax.x.high}{tend(ax.x)} →</text>
          </>
        )}
        {ax.y && (
          <>
            <text x={W / 2} y={16} textAnchor="middle" fontSize={11} style={{ fill: 'var(--muted)' }}>↑ {ax.y.low}{tend(ax.y)}</text>
            <text x={W / 2} y={H - 8} textAnchor="middle" fontSize={11} style={{ fill: 'var(--muted)' }}>↓ {ax.y.high}{tend(ax.y)}</text>
          </>
        )}
      </svg>
      {m.clusters.length > 0 && (
        <>
          <H3>I gruppi</H3>
          <div className="doc-hbars">
            {m.clusters.map((c) => (
              <div key={c.id} className="doc-hbar" style={{ gridTemplateColumns: '48mm 1fr 34mm' }}>
                <div className="doc-trunc">
                  <i className="doc-dot" style={{ background: CLUSTER_COLORS[c.id % CLUSTER_COLORS.length], marginRight: '1.5mm' }} />
                  <span className="doc-strong">{c.label}</span>
                </div>
                <div className="doc-trunc doc-sub" style={{ fontSize: '8pt' }}>{c.artists}</div>
                <div className="doc-hbar-v doc-num">
                  {fmtPct(c.minutes / total)} · {fmtInt(c.tracks)} brani
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      <p className="doc-note">
        Ogni punto è un brano (grandezza = tempo di ascolto), colorato per gruppo. Vicini = simili in titolo, artista, generi, testo e in parte suono
        (embedding + UMAP). Contano le vicinanze, non le distanze lunghe; gli assi non hanno un significato fisso: una direzione è scritta solo se
        una caratteristica misurata cambia lungo quell’asse (|r| ≥ 0,25). I nomi dei generi compaiono solo dove quei brani sono raccolti.
      </p>
    </Page>
  );
}

// ---------- eras ----------

export function ErasPage({ x, kicker }: { x: ExtraData; kicker: string }) {
  if (x.eras.length < 2) return null;
  const max = Math.max(...x.eras.map((e) => e.minutes), 1);
  return (
    <Page id="eras" kicker={kicker} title={`${x.eras.length} capitoli della tua vita musicale`}>
      <ol className="doc-eras">
        {x.eras.map((e) => (
          <li key={e.from} className="doc-era">
            <div className="doc-sub doc-num">
              {fmtMonth(e.from)} → {fmtMonth(e.to)} · {e.months} mesi · {fmtHours(e.minutes)}
            </div>
            <div className="doc-era-t">{e.name}</div>
            <div className="doc-meter" style={{ height: 3, marginTop: '1.5mm' }}>
              <span style={{ width: `${(e.minutes / max) * 100}%` }} />
            </div>
            <div className="doc-era-a">{e.topArtists.join(' · ')}</div>
          </li>
        ))}
      </ol>
      <p className="doc-note">
        Per ogni mese c’è un “vettore del gusto” (quota dei tuoi 60 artisti principali); una segmentazione binaria taglia dove il gusto cambia di più
        e si ferma quando un altro taglio non spiega abbastanza. Il titolo nomina gli artisti di quel periodo.
      </p>
    </Page>
  );
}

// ---------- artists over time ----------

function SurvivalCurve({ s }: { s: Survival }) {
  const W = 1000;
  const H = 220;
  const pad = { l: 40, r: 10, t: 10, b: 24 };
  const maxD = Math.max(...s.curve.map((c) => c.days), 1);
  const sx = (d: number) => pad.l + (d / maxD) * (W - pad.l - pad.r);
  const sy = (v: number) => pad.t + (1 - v) * (H - pad.t - pad.b);
  let d = '';
  s.curve.forEach((c, i) => {
    d += i ? `H${sx(c.days).toFixed(1)}V${sy(c.survival).toFixed(1)}` : `M${sx(c.days).toFixed(1)},${sy(c.survival).toFixed(1)}`;
  });
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round((maxD * f) / 30) * 30);
  return (
    <svg className="doc-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Quanti artisti restano nel tempo">
      {[0, 0.5, 1].map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} style={{ stroke: 'var(--rule)' }} strokeDasharray={v === 0.5 ? '4,4' : undefined} />
          <text x={pad.l - 6} y={sy(v) + 4} textAnchor="end" fontSize={10} style={{ fill: 'var(--faint)' }}>
            {Math.round(v * 100)}%
          </text>
        </g>
      ))}
      <path d={d} fill="none" stroke={ACCENT} strokeWidth={2.5} />
      {ticks.map((t) => (
        <text key={t} x={sx(t)} y={H - 6} textAnchor="middle" fontSize={10} style={{ fill: 'var(--faint)' }}>
          {fmtInt(t)} gg
        </text>
      ))}
    </svg>
  );
}

export function ArtistsPage({ x, kicker }: { x: ExtraData; kicker: string }) {
  const s = x.survival;
  if (!s || s.curve.length < 3) return null;
  return (
    <Page id="artists" kicker={kicker} title={s.medianDays ? `Metà degli artisti che scopri li lasci entro ${fmtInt(s.medianDays)} giorni` : 'Gli artisti che scopri restano con te'}>
      <H3>Quanti artisti ascolti ancora, dopo la scoperta</H3>
      <SurvivalCurve s={s} />
      <div className="doc-cols" style={{ marginTop: '4mm' }}>
        <div>
          <H3>Fedelissimi — tornano sempre</H3>
          <div className="doc-hbars">
            {s.loyal.slice(0, 10).map((l) => (
              <div key={l.artist} className="doc-hbar" style={{ gridTemplateColumns: '1fr 34mm' }}>
                <div className="doc-trunc doc-strong">{l.artist}</div>
                <div className="doc-hbar-v doc-num">
                  {fmtInt(l.returns)}× ritorni · {fmtInt(l.spanDays / 365)} anni
                </div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <H3>Fiammate — un mese e via</H3>
          {s.flames.length ? (
            <div className="doc-hbars">
              {s.flames.slice(0, 10).map((f) => (
                <div key={f.artist} className="doc-hbar" style={{ gridTemplateColumns: '1fr 40mm' }}>
                  <div className="doc-trunc doc-strong">{f.artist}</div>
                  <div className="doc-hbar-v doc-num">
                    picco {fmtMonth(f.peakMonth)} · {fmtHours(f.minutes)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="doc-sub">Nessuna fiammata: sei costante.</p>
          )}
        </div>
      </div>
      {x.rediscovery.length > 0 && (
        <>
          <H3>Da riscoprire — brani che amavi e non ascolti da tempo</H3>
          <div className="doc-hbars">
            {x.rediscovery.slice(0, 10).map((c) => (
              <div key={c.uri} className="doc-hbar" style={{ gridTemplateColumns: '1fr 52mm' }}>
                <div className="doc-trunc">
                  <span className="doc-strong">{c.track}</span> <span className="doc-sub">· {c.artist}</span>
                </div>
                <div className="doc-hbar-v doc-num">
                  {fmtInt(c.plays)} ascolti · ultimo {fmtDate(c.last_day)}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      <p className="doc-note">
        Curva di Kaplan–Meier su {fmtInt(s.n)} artisti con almeno 3 giorni di ascolto: un artista “esce” dopo {s.churnGapDays} giorni senza
        ascoltarlo; gli artisti ancora attivi non penalizzano la curva. {fmtInt(s.leftTruncated)} artisti esclusi perché già ascoltati all’inizio
        dei dati. Da riscoprire: brani molto ascoltati e fermi da almeno 6 mesi.
      </p>
    </Page>
  );
}

// ---------- skip model ----------

export function SkipPage({ x, kicker }: { x: ExtraData; kicker: string }) {
  const m = x.skip;
  if (!m) return null;
  const strong = m.effects.filter((e) => e.importance > 0.003 && e.importance > 2 * e.importanceSd).slice(0, 6);
  const maxRate = Math.max(...m.byHour.map((h) => h.rate), 0.01);
  return (
    <Page id="skip" kicker={kicker} title={`Il modello prevede i tuoi salti con AUC ${m.auc.toFixed(2)}`}>
      <div className="doc-kpis" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="doc-kpi">
          <div className="doc-kpi-v">{fmtPct(m.baseRate)}</div>
          <div className="doc-kpi-l">brani saltati</div>
        </div>
        <div className="doc-kpi">
          <div className="doc-kpi-v">{m.baselines.momentum.toFixed(2)}</div>
          <div className="doc-kpi-l">solo “slancio”</div>
          <div className="doc-kpi-s">salto precedente</div>
        </div>
        <div className="doc-kpi">
          <div className="doc-kpi-v">{m.baselines.preference.toFixed(2)}</div>
          <div className="doc-kpi-l">solo il brano</div>
          <div className="doc-kpi-s">familiarità, mood</div>
        </div>
        <div className="doc-kpi">
          <div className="doc-kpi-v">{m.auc.toFixed(2)}</div>
          <div className="doc-kpi-l">modello completo</div>
          <div className="doc-kpi-s">
            IC 95% {m.aucCI[0].toFixed(2)}–{m.aucCI[1].toFixed(2)}
          </div>
        </div>
      </div>
      {strong.length > 0 && (
        <>
          <H3>Cosa conta davvero</H3>
          <ul className="doc-daylist" style={{ fontSize: '9.5pt', gap: '2mm' }}>
            {strong.map((e) => (
              <li key={e.name} style={{ display: 'block' }}>
                <span className="doc-strong">{e.name}</span> <span className="doc-sub">— {e.sentence}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <H3>Salti per ora del giorno</H3>
      <svg className="doc-svg" viewBox="0 0 1000 150" role="img" aria-label="Salti per ora">
        {m.byHour.map((h) => {
          const bw = 1000 / 24;
          const hh = (h.rate / maxRate) * 120;
          return (
            <g key={h.hour}>
              <rect x={h.hour * bw + bw * 0.12} y={128 - hh} width={bw * 0.76} height={hh} rx={3} style={{ fill: ACCENT }} fillOpacity={0.8} />
              {h.hour % 3 === 0 && (
                <text x={h.hour * bw + bw / 2} y={145} textAnchor="middle" fontSize={11} style={{ fill: 'var(--faint)' }}>
                  {h.hour}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <p className="doc-note">
        Regressione logistica addestrata sull’80% più vecchio degli ascolti ({fmtInt(m.nTrain)}) e verificata sugli ultimi {fmtInt(m.nTest)}. AUC 0,5
        = a caso, 1 = perfetto. “Cosa conta” = fattori che, mescolati, peggiorano il modello più del rumore. Salto = brano chiuso con “avanti”.
      </p>
    </Page>
  );
}

// ---------- sessions (habits page) ----------

export function SessionKinds({ x }: { x: ExtraData }) {
  const s = x.sessions;
  if (!s?.kinds.length) return null;
  const tot = s.kinds.reduce((a, k) => a + k.n, 0) || 1;
  return (
    <>
      <H3>Che tipo di sessioni fai</H3>
      <div className="doc-hbars">
        {s.kinds.map((k) => (
          <div key={k.kind} className="doc-hbar" style={{ gridTemplateColumns: '24mm 1fr 14mm' }}>
            <div className="doc-strong">{k.kind}</div>
            <div className="doc-trunc doc-sub" style={{ fontSize: '8pt' }}>{k.desc}</div>
            <div className="doc-hbar-v doc-num">{fmtPct(k.n / tot)}</div>
          </div>
        ))}
      </div>
    </>
  );
}
