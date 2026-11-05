import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createNodeEngine, type NodeEngine } from './nodeEngine';
import { META_SQL } from '../src/data/schema';

let engine: NodeEngine;
vi.mock('../src/data/db', () => ({
  query: (sql: string, params?: unknown[]) => engine.query(sql, params),
  exec: (sql: string) => engine.exec(sql),
}));

const row = (uri: string, track: string, artist: string) => `('${uri}', '${track.replace(/'/g, "''")}', '${artist}')`;

describe('mood adjustments', () => {
  beforeAll(async () => {
    engine = await createNodeEngine();
    await engine.exec(`CREATE TABLE tracks (uri VARCHAR, track VARCHAR, artist VARCHAR)`);
    await engine.exec(`INSERT INTO tracks VALUES
      ${row('s1', 'We Are The Champions - Remastered 2011', 'Queen')},
      ${row('l1', 'We Are The Champions - Live Aid', 'Queen')},
      ${row('l2', 'Hotel California - Live On MTV, 1994', 'Eagles')},
      ${row('n1', 'Who Wants To Live Forever', 'Queen')},
      ${row('n2', 'Live Forever', 'Oasis')},
      ${row('x1', 'Careless Whisper', 'George Michael')}`);
    await engine.exec(META_SQL);
    await engine.exec(`INSERT INTO meta (uri, valence, energy, mood_source, valence_lyrics) VALUES
      ('s1', 0.40, 0.60, 'reccobeats', NULL),
      ('l1', 0.19, 0.86, 'reccobeats', NULL),
      ('l2', 0.61, 0.49, 'reccobeats', NULL),
      ('n1', 0.04, 0.37, 'reccobeats', NULL),
      ('n2', 0.30, 0.90, 'reccobeats', NULL),
      ('x1', 0.79, 0.64, 'reccobeats', 0.10)`);
    const { applyMoodAdjustments } = await import('../src/data/moodAdjust');
    await applyMoodAdjustments();
    await applyMoodAdjustments(); // idempotent
  });

  const get = async (uri: string) =>
    (await engine.query<{ valence: number; energy: number; valence_audio: number; mood_adj: string | null; mood_conf: number }>(
      `SELECT valence, energy, valence_audio, mood_adj, mood_conf FROM meta WHERE uri = ?`,
      [uri],
    ))[0];

  it('uses the studio version for a live recording', async () => {
    const r = await get('l1');
    expect(r.valence).toBeCloseTo(0.4);
    expect(r.energy).toBeCloseTo(0.6);
    expect(r.valence_audio).toBeCloseTo(0.19);
    expect(r.mood_adj).toBe('live:studio');
  });

  it('keeps a live recording without studio sibling, with lower confidence', async () => {
    const r = await get('l2');
    expect(r.valence).toBeCloseTo(0.61);
    expect(r.mood_adj).toBe('live');
    expect(r.mood_conf).toBeCloseTo(0.6);
  });

  it('does not treat "Live" inside the title as a live version', async () => {
    expect((await get('n1')).mood_adj).toBeNull();
    expect((await get('n2')).mood_adj).toBeNull();
  });

  it('fuses lyric valence into audio valence, idempotently', async () => {
    const r = await get('x1');
    expect(r.valence).toBeCloseTo(0.65 * 0.79 + 0.35 * 0.1);
    expect(r.energy).toBeCloseTo(0.64);
    expect(r.mood_adj).toBe('testo');
  });
});
