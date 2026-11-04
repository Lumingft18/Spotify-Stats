import { unzip, strFromU8 } from 'fflate';
import { appendRecords, emptyColumns, historyKind, makeLocalizer, type NormalizeStats, type PlayColumns } from './normalize';
import { applyAccountFile, emptyProfile, isAccountFile, uriLookup, type AccountProfile } from './account';

function unzipAsync(buf: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) =>
    unzip(buf, { filter: (f) => historyKind(f.name) !== null || isAccountFile(f.name) }, (err, data) =>
      err ? reject(err) : resolve(data),
    ),
  );
}

export interface ParseResult {
  cols: PlayColumns;
  stats: NormalizeStats;
  /** Which history the files contained: full lifetime ('extended'), last year only ('legacy') or none. */
  historyKind: 'extended' | 'legacy' | 'none';
  profile: AccountProfile | null;
  files: string[];
}

/** Parses Spotify exports — the "Extended streaming history" ZIP and/or the "Account data" ZIP, or loose JSON files. */
export async function parseExport(files: File[], timeZone: string, onStep: (s: string) => void = () => {}): Promise<ParseResult> {
  // 1) Collect every relevant JSON from every input.
  const jsons: Array<{ name: string; data: unknown }> = [];
  const read = (name: string, text: string) => {
    try {
      jsons.push({ name, data: JSON.parse(text) });
    } catch {
      throw new Error(`Il file ${name.split('/').pop()} non è un JSON valido`);
    }
  };
  for (const f of files) {
    if (f.name.toLowerCase().endsWith('.zip')) {
      onStep(`Decompressione di ${f.name}…`);
      const entries = await unzipAsync(new Uint8Array(await f.arrayBuffer()));
      for (const name of Object.keys(entries).sort()) read(name, strFromU8(entries[name]));
    } else if (f.name.toLowerCase().endsWith('.json')) {
      read(f.name, await f.text());
    }
  }

  // 2) Account package (identity, library, playlists…).
  const accountFiles = jsons.filter((j) => isAccountFile(j.name));
  let profile: AccountProfile | null = null;
  if (accountFiles.length) {
    profile = emptyProfile();
    for (const a of accountFiles) applyAccountFile(profile, a.name, a.data);
  }

  // 3) History: prefer the extended (lifetime) files; use legacy last-year files only if no extended ones are present.
  const extended = jsons.filter((j) => historyKind(j.name) === 'extended');
  const legacy = jsons.filter((j) => historyKind(j.name) === 'legacy');
  const chosen = extended.length ? extended : legacy;
  const lookup = !extended.length && legacy.length ? uriLookup(accountFiles) : undefined;
  const cols = emptyColumns();
  const seen = new Set<string>();
  const stats: NormalizeStats = { rows: 0, duplicates: 0, invalid: 0 };
  const localize = makeLocalizer(timeZone);
  for (const [i, j] of chosen.entries()) {
    onStep(`Lettura ${i + 1}/${chosen.length}: ${j.name.split('/').pop()}`);
    appendRecords(j.data, cols, localize, seen, stats, lookup);
    await new Promise((r) => setTimeout(r, 0));
    // Older extended exports carried the username on every row.
    if (profile === null || !profile.username) {
      const first = Array.isArray(j.data) ? (j.data as Array<Record<string, unknown>>)[0] : null;
      const u = typeof first?.username === 'string' && first.username ? first.username : null;
      if (u) {
        profile = profile ?? emptyProfile();
        profile.username = u;
      }
    }
  }

  if (!stats.rows && !profile) {
    throw new Error(
      'Non trovo dati Spotify in questi file. Carica lo ZIP "Cronologia di streaming estesa" (file Streaming_History_Audio_*.json) e/o lo ZIP "Dati dell’account".',
    );
  }
  return {
    cols,
    stats,
    historyKind: extended.length ? 'extended' : legacy.length && stats.rows ? 'legacy' : 'none',
    profile,
    files: jsons.map((j) => j.name),
  };
}
