// Small LLM helpers: naming clusters/eras and writing story captions. Numbers are passed in, never generated.
import { query, setClusters } from '../data/db';
import { kv } from '../lib/kv';
import { getApp } from '../lib/store';
import type { Era } from '../ml/models';
import { structured } from './client';

export async function nameClustersWithLLM(): Promise<void> {
  const rows = await query<{ cluster: number; artists: string; tags: string | null; tracks: string }>(`
    WITH r AS (
      SELECT m.cluster, t.artist, t.track, m.tags, t.minutes,
        row_number() OVER (PARTITION BY m.cluster ORDER BY t.minutes DESC) AS rn
      FROM tracks t JOIN meta m USING (uri) WHERE m.cluster IS NOT NULL)
    SELECT cluster,
      string_agg(DISTINCT artist, ', ') FILTER (WHERE rn <= 25) AS artists,
      string_agg(tags, ', ') FILTER (WHERE rn <= 25 AND tags <> '') AS tags,
      string_agg(track || ' — ' || artist, '; ') FILTER (WHERE rn <= 8) AS tracks
    FROM r GROUP BY cluster ORDER BY cluster`);
  if (!rows.length) return;
  const res = await structured<{ clusters: Array<{ id: number; label: string }> }>({
    model: getApp().settings.llmModelBulk,
    system:
      'Dai un nome breve (2-4 parole, italiano, evocativo ma preciso, niente emoji) a ciascun gruppo musicale descritto. Nomi diversi tra loro.',
    user: rows
      .map((r) => `Gruppo ${r.cluster}\nArtisti: ${r.artists}\nTag: ${(r.tags ?? '').slice(0, 300)}\nEsempi: ${r.tracks}`)
      .join('\n\n'),
    schemaName: 'cluster_names',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['clusters'],
      properties: {
        clusters: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'label'],
            properties: { id: { type: 'integer' }, label: { type: 'string' } },
          },
        },
      },
    },
  });
  const valid = new Set(rows.map((r) => r.cluster));
  const list = res.clusters.filter((c) => valid.has(c.id)).map((c) => ({ id: c.id, label: c.label.slice(0, 40), custom: true }));
  await setClusters(list);
  getApp().bump();
}

export async function nameErasWithLLM(eras: Era[]): Promise<Record<string, string>> {
  const res = await structured<{ eras: Array<{ key: string; name: string }> }>({
    model: getApp().settings.llmModelBulk,
    system:
      'Sei un critico musicale. Dai a ogni periodo della vita musicale di una persona un titolo breve (2-5 parole, italiano, stile capitolo di romanzo, niente emoji). Usa artisti/generi forniti.',
    user: eras.map((e) => `${e.from}_${e.to}: artisti principali ${e.topArtists.join(', ')}; durata ${e.months} mesi`).join('\n'),
    schemaName: 'era_names',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['eras'],
      properties: {
        eras: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'name'],
            properties: { key: { type: 'string' }, name: { type: 'string' } },
          },
        },
      },
    },
  });
  const names: Record<string, string> = {};
  for (const e of res.eras) names[e.key] = e.name.slice(0, 48);
  await kv.set('era_names', names);
  return names;
}

export async function storyCaptions(facts: Record<string, string | number>): Promise<Record<string, string>> {
  const keys = ['intro', 'time', 'artist', 'track', 'mood', 'days', 'records', 'habits', 'outro'];
  const res = await structured<Record<string, string>>({
    model: getApp().settings.llmModelAgent,
    system: `Scrivi didascalie brevi (max 22 parole ciascuna), in italiano, seconda persona, tono caldo e ironico ma mai banale, per un racconto annuale degli ascolti musicali.
Chiavi: intro (ore totali), time (ritmo/mese top), artist, track, mood (suono prevalente e mix), days (giorno più felice vs più triste: cita i brani), records (serie di giorni, maratona, ossessione, ritorno di fiamma), habits (momento, notte, weekend), outro (chiusura, può citare primo e ultimo brano).
Usa SOLO i fatti forniti; non inventare numeri, artisti o brani. Puoi omettere numeri. Niente emoji.`,
    user: JSON.stringify(facts),
    schemaName: 'story',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: keys,
      properties: Object.fromEntries(keys.map((k) => [k, { type: 'string' }])),
    },
    temperature: 0.8,
  });
  return res;
}
