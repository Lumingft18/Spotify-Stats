import { query } from '../../data/db';
import { DOW_LONG, fmtDate, fmtHours, fmtPct, fmtInt } from '../../lib/format';
import { routes } from '../../lib/router';

export interface Insight {
  text: string;
  href?: string;
  tone?: 'neutral' | 'accent';
}

/** Quick, deterministic insights (pure SQL). Each sentence states a fact backed by numbers. */
export async function computeInsights(): Promise<Insight[]> {
  const out: Insight[] = [];

  const peak = await query<{ dow: number; hour: number; m: number }>(`
    SELECT dow, hour, sum(minutes) AS m FROM p GROUP BY ALL ORDER BY m DESC LIMIT 1`);
  const dowAvg = await query<{ dow: number; per_day: number }>(`
    WITH d AS (SELECT day, any_value(dow) AS dow, sum(minutes) AS m FROM p GROUP BY day)
    SELECT dow, avg(m) AS per_day FROM d GROUP BY dow ORDER BY per_day DESC`);
  if (peak[0] && dowAvg.length >= 2) {
    const top = dowAvg[0];
    const low = dowAvg[dowAvg.length - 1];
    const ratio = top.per_day / Math.max(1, low.per_day) - 1;
    out.push({
      text: `Il tuo giorno più musicale è il ${DOW_LONG[top.dow - 1]}: ${fmtHours(top.per_day)} in media, ${fmtPct(ratio)} in più del ${DOW_LONG[low.dow - 1]}. Picco alle ${peak[0].hour}:00.`,
      href: routes.time(),
    });
  }

  const skip = await query<{ shuffle_skip: number; manual_skip: number; n_sh: number; n_ma: number }>(`
    SELECT avg(skipped::INT) FILTER (WHERE shuffle) AS shuffle_skip, avg(skipped::INT) FILTER (WHERE NOT shuffle) AS manual_skip,
           count(*) FILTER (WHERE shuffle) AS n_sh, count(*) FILTER (WHERE NOT shuffle) AS n_ma FROM p`);
  const s = skip[0];
  if (s && s.n_sh > 200 && s.n_ma > 200 && Math.abs(s.shuffle_skip - s.manual_skip) > 0.05) {
    const more = s.shuffle_skip > s.manual_skip;
    out.push({
      text: more
        ? `In shuffle salti il ${fmtPct(s.shuffle_skip)} dei brani, contro il ${fmtPct(s.manual_skip)} quando scegli tu l'ordine.`
        : `Curioso: in shuffle salti meno (${fmtPct(s.shuffle_skip)}) che quando scegli tu (${fmtPct(s.manual_skip)}).`,
      href: routes.insights(),
    });
  }

  const obsession = await query<{ track: string; artist: string; uri: string; day: string; n: number }>(`
    SELECT any_value(track) AS track, any_value(artist) AS artist, uri, day::VARCHAR AS day, count(*) FILTER (WHERE counted) AS n
    FROM p GROUP BY uri, day ORDER BY n DESC LIMIT 1`);
  if (obsession[0] && obsession[0].n >= 5) {
    const o = obsession[0];
    out.push({
      text: `Il ${fmtDate(o.day)} hai ascoltato “${o.track}” di ${o.artist} ${fmtInt(o.n)} volte. Giornata intensa?`,
      href: routes.track(o.uri),
    });
  }

  const night = await query<{ share: number }>(`SELECT sum(minutes) FILTER (WHERE hour < 5) / greatest(1, sum(minutes)) AS share FROM p`);
  if (night[0]?.share > 0.08) {
    out.push({ text: `Il ${fmtPct(night[0].share)} del tuo ascolto avviene tra mezzanotte e le 5: anima notturna.`, href: routes.time() });
  }

  const mood = await query<{ we: number; wd: number; n: number }>(`
    SELECT avg(valence) FILTER (WHERE dow >= 6) AS we, avg(valence) FILTER (WHERE dow < 6) AS wd, count(valence) AS n FROM p`);
  if (mood[0] && mood[0].n > 300 && Math.abs(mood[0].we - mood[0].wd) > 0.02) {
    out.push({
      text:
        mood[0].we > mood[0].wd
          ? `Nel weekend la tua musica è più solare (valence ${mood[0].we.toFixed(2)} contro ${mood[0].wd.toFixed(2)} in settimana).`
          : `Nel weekend scegli musica più cupa (valence ${mood[0].we.toFixed(2)} contro ${mood[0].wd.toFixed(2)} in settimana).`,
      href: routes.mood(),
    });
  }

  const loyal = await query<{ artist: string; years: number }>(`
    SELECT artist, count(DISTINCT year(day)) AS years FROM p WHERE counted GROUP BY artist
    HAVING count(*) > 20 ORDER BY years DESC, sum(minutes) DESC LIMIT 1`);
  const span = await query<{ y: number }>(`SELECT count(DISTINCT year(day)) AS y FROM p`);
  if (loyal[0] && span[0]?.y >= 3 && loyal[0].years === span[0].y) {
    out.push({ text: `${loyal[0].artist} è con te in ogni singolo anno dello storico. Fedeltà vera.`, href: routes.artist(loyal[0].artist) });
  }

  return out.slice(0, 5);
}
