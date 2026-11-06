// Shared cache of per-track AI outputs (local database → ai_cache). Key: kind + model + prompt hash + track URI.
// The same song is estimated once, whatever the analysis or the person; a new prompt or model gets a new key.
// Values stay labelled as AI estimates where they are used (mood_source = 'llm'), never as measurements.
import { apiJson } from './api';

export interface AiKey {
  kind: string;
  model: string;
  version: string;
}

/** Short stable hash of everything that shapes the answer (system prompt, schema, sampling). */
export function promptVersion(...parts: unknown[]): string {
  const s = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('\u0000');
  let h1 = 2166136261;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822507);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

export async function aiCacheGet<T>(key: AiKey, uris: string[]): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  try {
    for (let i = 0; i < uris.length; i += 5000) {
      const rows = await apiJson<Array<{ uri: string; value: T }>>('/ai/get', 'POST', { ...key, uris: uris.slice(i, i + 5000) });
      for (const r of rows) out.set(r.uri, r.value);
    }
  } catch (e) {
    console.warn('cache AI non disponibile', e);
  }
  return out;
}

export async function aiCachePut<T>(key: AiKey, items: Array<{ uri: string; value: T }>): Promise<void> {
  if (!items.length) return;
  await apiJson('/ai/put', 'POST', { ...key, items }).catch((e) => console.warn('cache AI', e));
}
