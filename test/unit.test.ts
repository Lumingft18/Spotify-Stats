import { describe, expect, it } from 'vitest';
import { appendRecords, emptyColumns, makeLocalizer, normalizePlatform, isHistoryFile } from '../src/data/normalize';
import { getMood } from '../src/lib/mood';
import { safeSql } from '../src/llm/agent';
import { auc } from '../src/ml/models';

describe('normalize', () => {
  it('maps platforms', () => {
    expect(normalizePlatform('iOS 16.1 (iPhone12,1)')).toBe('iOS');
    expect(normalizePlatform('Android OS 9 API 28 (Xiaomi)')).toBe('Android');
    expect(normalizePlatform('OS X 10.15.7 [x86 8]')).toBe('Desktop');
    expect(normalizePlatform('web_player windows 10;chrome')).toBe('Web');
    expect(normalizePlatform('')).toBe('Sconosciuto');
  });

  it('recognizes history files', () => {
    expect(isHistoryFile('Spotify Extended Streaming History/Streaming_History_Audio_2024_2.json')).toBe(true);
    expect(isHistoryFile('MyData/StreamingHistory_music_0.json')).toBe(true);
    expect(isHistoryFile('Streaming_History_Video_2022-2025.json')).toBe(false);
    expect(isHistoryFile('__MACOSX/._Streaming_History_Audio_2024_2.json')).toBe(false);
  });

  it('normalizes extended + legacy records, dedupes, infers skips, uses start time', () => {
    const cols = emptyColumns();
    const seen = new Set<string>();
    const stats = { rows: 0, duplicates: 0, invalid: 0 };
    const loc = makeLocalizer('Europe/Rome');
    const rec = {
      ts: '2023-07-03T19:09:18Z',
      platform: 'ios',
      ms_played: 180000,
      conn_country: 'IT',
      master_metadata_track_name: 'Money, Money, Money',
      master_metadata_album_artist_name: 'ABBA',
      master_metadata_album_album_name: 'Arrival',
      spotify_track_uri: 'spotify:track:3lKN03PDeBnXZS7sDukRBt',
      reason_start: 'trackdone',
      reason_end: 'fwdbtn',
      shuffle: false,
      skipped: false,
      offline: false,
      offline_timestamp: 1688411177,
      incognito_mode: false,
    };
    appendRecords([rec, rec, { ts: 'bad' }], cols, loc, seen, stats);
    appendRecords([{ endTime: '2023-01-01 12:34', artistName: 'X', trackName: 'Y', msPlayed: 5000 }], cols, loc, seen, stats);
    expect(stats).toEqual({ rows: 2, duplicates: 1, invalid: 1 });
    expect(cols.skipped[0]).toBe(true); // fwdbtn overrides explicit false
    expect(cols.ts_start[0]).toBe('2023-07-03 19:06:17'); // offline_timestamp = start
    expect(cols.ts_local[0]).toBe('2023-07-03 21:06:17'); // CEST
    expect(cols.reason_end[0]).toBe('avanti');
    expect(cols.kind[1]).toBe('track');
    expect(cols.ts_start[1]).toBe('2023-01-01 12:33:55'); // legacy: end - ms_played
  });
});

describe('mood', () => {
  it('classifies quadrants', () => {
    expect(getMood(0.8, 0.8)).toBe('euforico');
    expect(getMood(0.8, 0.2)).toBe('sereno');
    expect(getMood(0.2, 0.8)).toBe('arrabbiato');
    expect(getMood(0.2, 0.2)).toBe('malinconico');
    expect(getMood(0.5, 0.52)).toBe('neutrale');
    expect(getMood(null, 0.5)).toBe('sconosciuto');
  });
});

describe('agent SQL guard', () => {
  it('allows reads and wraps with LIMIT', () => {
    expect(safeSql('SELECT 1')).toBe('SELECT * FROM (SELECT 1) AS q LIMIT 200');
    expect(safeSql('with a as (select 1) select * from a;')).toContain('LIMIT 200');
    expect(() => safeSql("SELECT 'drop table' AS x")).not.toThrow();
  });
  it('blocks writes, multi-statements and file access', () => {
    expect(() => safeSql('DROP TABLE plays')).toThrow();
    expect(() => safeSql('SELECT 1; DELETE FROM plays')).toThrow();
    expect(() => safeSql('WITH x AS (DELETE FROM plays RETURNING *) SELECT * FROM x')).toThrow();
    expect(() => safeSql("SELECT * FROM read_csv('/etc/passwd')")).toThrow();
    expect(() => safeSql('ATTACH \'x.db\'')).toThrow();
  });
});

describe('auc', () => {
  it('computes AUC', () => {
    expect(auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1])).toBeCloseTo(0.75);
    expect(auc([1, 2, 3], [0, 0, 0])).toBe(0.5);
  });
});
