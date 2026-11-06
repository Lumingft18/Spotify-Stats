// Key/value storage of the OPEN analysis, persisted in the local database (server/store.ts → analysis_kv).
// Values keep their shape across the wire (typed arrays included) via pack/unpack.
import { apiBytes, apiJson } from './api';
import { currentAnalysisId } from './analyses';
import { pack, unpack } from './pack';

export type StoreName = 'kv' | 'meta';

const base = (): string | null => {
  const id = currentAnalysisId();
  return id ? `/analyses/${encodeURIComponent(id)}` : null;
};
const need = (): string => {
  const b = base();
  if (!b) throw new Error('Nessuna analisi aperta');
  return b;
};
const enc = encodeURIComponent;

export const kv = {
  async get<T>(key: string, store: StoreName = 'kv'): Promise<T | undefined> {
    const b = base();
    if (!b) return undefined;
    const bytes = await apiBytes(`${b}/kv/${store}/${enc(key)}`);
    return bytes ? unpack<T>(bytes) : undefined;
  },
  async set(key: string, value: unknown, store: StoreName = 'kv'): Promise<void> {
    await apiBytes(`${need()}/kv/${store}/${enc(key)}`, 'PUT', pack(value));
  },
  async del(key: string, store: StoreName = 'kv'): Promise<void> {
    const b = base();
    if (b) await apiBytes(`${b}/kv/${store}/${enc(key)}`, 'DELETE');
  },
  /** Atomic on the server (one transaction). */
  async setMany(entries: Array<[string, unknown]>, store: StoreName = 'kv'): Promise<void> {
    await apiBytes(`${need()}/kv-batch`, 'POST', pack({ entries: entries.map(([k, v]) => [store, k, pack(v)]) }));
  },
  async delMany(keys: string[], store: StoreName = 'kv'): Promise<void> {
    const b = base();
    if (b && keys.length) await apiBytes(`${b}/kv-batch`, 'POST', pack({ entries: keys.map((k) => [store, k, null]) }));
  },
  /** Keys with their stored size (values are not downloaded). */
  async list(store?: StoreName): Promise<Array<{ store: string; key: string; bytes: number; updated_at: number }>> {
    const b = base();
    if (!b) return [];
    return apiJson(`${b}/kv${store ? `?store=${store}` : ''}`);
  },
  async clear(store: StoreName): Promise<void> {
    const b = base();
    if (b) await apiBytes(`${b}/kv/${store}`, 'DELETE');
  },
};
