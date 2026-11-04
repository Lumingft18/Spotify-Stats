import { unzip, strFromU8 } from 'fflate';
import { appendRecords, emptyColumns, isHistoryFile, makeLocalizer, type NormalizeStats, type PlayColumns } from './normalize';

function unzipAsync(buf: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) =>
    unzip(buf, { filter: (f) => isHistoryFile(f.name) }, (err, data) => (err ? reject(err) : resolve(data))),
  );
}

export interface ParseResult {
  cols: PlayColumns;
  stats: NormalizeStats;
  files: string[];
}

/** Parses a Spotify export (.zip) or one/more JSON history files into normalized columns. */
export async function parseExport(
  files: File[],
  timeZone: string,
  onStep: (s: string) => void = () => {},
): Promise<ParseResult> {
  const cols = emptyColumns();
  const seen = new Set<string>();
  const stats: NormalizeStats = { rows: 0, duplicates: 0, invalid: 0 };
  const localize = makeLocalizer(timeZone);
  const used: string[] = [];

  const handleJson = (name: string, text: string) => {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Il file ${name} non è un JSON valido`);
    }
    appendRecords(data, cols, localize, seen, stats);
    used.push(name);
  };

  for (const f of files) {
    if (f.name.toLowerCase().endsWith('.zip')) {
      onStep(`Decompressione di ${f.name}…`);
      const entries = await unzipAsync(new Uint8Array(await f.arrayBuffer()));
      const names = Object.keys(entries).sort();
      for (const [i, name] of names.entries()) {
        onStep(`Lettura ${i + 1}/${names.length}: ${name.split('/').pop()}`);
        handleJson(name, strFromU8(entries[name]));
        await new Promise((r) => setTimeout(r, 0)); // keep UI responsive
      }
    } else if (f.name.toLowerCase().endsWith('.json')) {
      onStep(`Lettura ${f.name}…`);
      handleJson(f.name, await f.text());
    }
  }
  if (!stats.rows) {
    throw new Error(
      'Nessun ascolto trovato. Carica lo ZIP "Extended streaming history" (contiene file Streaming_History_Audio_*.json).',
    );
  }
  return { cols, stats, files: used };
}
