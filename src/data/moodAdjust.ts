// Corrections applied on top of measured audio features. The measured values are kept in
// valence_audio / energy_audio, so `valence` / `energy` can always be recomputed (idempotent).
//
// 1. Live recordings: crowd noise and live mixes depress measured valence (on a real library:
//    live 0.34 vs studio 0.47 on the same songs). When the studio version of the same song by the same
//    artist is in the library, its audio values are used; otherwise the track keeps its own values
//    with lower confidence.
// 2. Lyrics fusion: audio valence misses sad lyrics on upbeat music. Combining lyric and audio
//    valence improves valence prediction while arousal is best from audio alone
//    (Delbouys et al., ISMIR 2018, arXiv:1809.07276). valence = 0.65·audio + 0.35·lyrics; energy = audio.
import { exec } from './db';

export const LYRICS_WEIGHT = 0.35;

/** Live marker only in the version suffix (" - Live Aid", "(Live at …)"), never in the title itself
 *  ("Live Forever", "Who Wants To Live Forever", "Live and Let Die"). */
export const LIVE_RE = String.raw`(\s-\s.*\b(live|ao vivo|en vivo|dal vivo)\b|[(\[][^)\]]*\b(live|ao vivo|en vivo|dal vivo)\b)`;
/** Song title without version suffix: "Wonderwall - Remastered" → "wonderwall". */
export const BASE_TITLE_SQL = (col: string) => String.raw`lower(trim(regexp_replace(${col}, '(\s-\s|\s*[(\[]).*$', '')))`;

export async function applyMoodAdjustments(): Promise<void> {
  await exec(`UPDATE meta SET valence_audio = valence, energy_audio = energy
    WHERE mood_source = 'reccobeats' AND valence_audio IS NULL AND valence IS NOT NULL`);
  await exec(`
    UPDATE meta SET
      valence = CASE WHEN c.vl IS NULL THEN c.v0 ELSE ${1 - LYRICS_WEIGHT} * c.v0 + ${LYRICS_WEIGHT} * c.vl END,
      energy = c.e0,
      mood_conf = CASE WHEN c.is_live AND NOT c.has_studio THEN 0.6 ELSE 1 END,
      mood_adj = nullif(concat_ws('+',
        CASE WHEN c.is_live THEN CASE WHEN c.has_studio THEN 'live:studio' ELSE 'live' END END,
        CASE WHEN c.vl IS NOT NULL THEN 'testo' END), '')
    FROM (
      WITH t AS (
        SELECT m.uri, tr.track, tr.artist, m.valence_audio AS va, m.energy_audio AS ea, m.valence_lyrics AS vl,
               regexp_matches(tr.track, '${LIVE_RE}', 'i') AS is_live, ${BASE_TITLE_SQL('tr.track')} AS base
        FROM meta m JOIN tracks tr USING (uri) WHERE m.valence_audio IS NOT NULL),
      studio AS (SELECT artist, base, avg(va) AS sva, avg(ea) AS sea FROM t WHERE NOT is_live GROUP BY ALL)
      SELECT t.uri, t.vl, t.is_live, s.sva IS NOT NULL AS has_studio,
             CASE WHEN t.is_live AND s.sva IS NOT NULL THEN s.sva ELSE t.va END AS v0,
             CASE WHEN t.is_live AND s.sea IS NOT NULL THEN s.sea ELSE coalesce(t.ea, s.sea) END AS e0
      FROM t LEFT JOIN studio s ON s.artist = t.artist AND s.base = t.base
    ) c
    WHERE meta.uri = c.uri`);
}
