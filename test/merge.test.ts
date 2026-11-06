import { describe, expect, it } from 'vitest'
import { createNodeEngine } from './nodeEngine'
import { mergePlaysSql } from '../src/data/schema'

const row = (ts: string, uri: string | null, ms: number, track = 't', artist = 'a') =>
  `('${ts}', '${ts}', ${ms}, ${uri ? `'${uri}'` : 'NULL'}, '${track}', '${artist}')`

describe('updating an analysis with a newer export', () => {
  it('extended: union, exact duplicates removed (longest kept), late-synced old plays recovered', async () => {
    const e = await createNodeEngine()
    await e.exec(`CREATE TABLE o (ts_start VARCHAR, ts_local VARCHAR, ms_played DOUBLE, track_uri VARCHAR, track VARCHAR, artist VARCHAR)`)
    await e.exec(`CREATE TABLE n AS SELECT * FROM o WHERE false`)
    await e.exec(`INSERT INTO o VALUES ${row('2025-01-01 10:00:00', 'u1', 1000)}, ${row('2025-06-01 10:00:00', 'u2', 2000)}`)
    await e.exec(
      `INSERT INTO n VALUES ${row('2025-01-01 10:00:00', 'u1', 5000)}, ${row('2025-06-01 10:00:00', 'u2', 2000)}, ${row('2025-03-01 09:00:00', 'u3', 100)}, ${row('2026-02-01 08:00:00', 'u4', 3000)}, ${row('2026-02-01 08:00:00', null, 3000, 'x', 'y')}`,
    )
    await e.exec(mergePlaysSql('o', 'n', 'm', false))
    const rows = await e.query<{ ts_start: string; track_uri: string | null; ms_played: number }>(`SELECT ts_start, track_uri, ms_played FROM m ORDER BY ts_start, track_uri`)
    expect(rows).toHaveLength(5)
    expect(rows.find((r) => r.track_uri === 'u1')!.ms_played).toBe(5000)
    expect(rows.some((r) => r.track_uri === 'u3')).toBe(true) // old period, missing before
    expect(rows.some((r) => r.track_uri === null)).toBe(true) // local file kept
  })

  it('last-year export: only plays after the last saved one (no near-duplicates)', async () => {
    const e = await createNodeEngine()
    await e.exec(`CREATE TABLE o (ts_start VARCHAR, ts_local VARCHAR, ms_played DOUBLE, track_uri VARCHAR, track VARCHAR, artist VARCHAR)`)
    await e.exec(`CREATE TABLE n AS SELECT * FROM o WHERE false`)
    await e.exec(`INSERT INTO o VALUES ${row('2025-11-10 10:00:13', 'u1', 1000)}`)
    // Same play with minute precision (would be a duplicate) + a newer one.
    await e.exec(`INSERT INTO n VALUES ${row('2025-11-10 10:00:00', 'u1', 1000)}, ${row('2026-01-05 18:00:00', 'u2', 2000)}`)
    await e.exec(mergePlaysSql('o', 'n', 'm', true))
    const rows = await e.query<{ track_uri: string }>(`SELECT track_uri FROM m ORDER BY ts_start`)
    expect(rows.map((r) => r.track_uri)).toEqual(['u1', 'u2'])
  })
})
