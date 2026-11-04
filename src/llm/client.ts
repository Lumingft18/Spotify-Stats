import OpenAI from 'openai';
import { getApp, useApp } from '../lib/store';

/** BYOK OpenRouter client (OpenAI-compatible). The key never leaves the browser except towards openrouter.ai. */
export function llm(): OpenAI {
  const { openrouterKey, connections } = getApp().settings;
  if (!connections.llm) throw new Error('Le funzioni AI sono disattivate. Attivale in Impostazioni → Connessioni.');
  if (!openrouterKey) throw new Error('Inserisci la tua chiave OpenRouter in Impostazioni.');
  getApp().logNet('openrouter.ai', 'modello linguistico');
  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: openrouterKey,
    dangerouslyAllowBrowser: true,
    defaultHeaders: { 'X-Title': 'Ascolti - Spotify Stats' },
  });
}

/** Reactive version: re-renders when the key or the AI toggle changes. */
export function useLlmAvailable(): boolean {
  return useApp((s) => s.settings.connections.llm && !!s.settings.openrouterKey);
}

/** Validates an OpenRouter key (no tokens spent). */
export async function checkOpenRouterKey(key: string): Promise<{ ok: boolean; label?: string; limit?: number | null; usage?: number }> {
  const res = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) return { ok: false };
  const j = (await res.json()) as { data?: { label?: string; limit?: number | null; usage?: number } };
  return { ok: true, label: j.data?.label, limit: j.data?.limit ?? null, usage: j.data?.usage };
}

export function llmAvailable(): boolean {
  const { openrouterKey, connections } = getApp().settings;
  return connections.llm && !!openrouterKey;
}

/** Calls the model with a strict JSON schema and parses the result. */
export async function structured<T>(opts: {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  temperature?: number;
  signal?: AbortSignal;
}): Promise<T> {
  const res = await llm().chat.completions.create(
    {
      model: opts.model,
      temperature: opts.temperature ?? 0.2,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: opts.schemaName, strict: true, schema: opts.schema },
      },
    },
    { signal: opts.signal },
  );
  const text = res.choices[0]?.message?.content ?? '';
  try {
    return JSON.parse(text) as T;
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]) as T;
    throw new Error('Risposta del modello non in JSON');
  }
}

/** Rough cost estimate shown before bulk runs (tokens only; prices vary by model). */
export function estimateTokens(chars: number) {
  return Math.round(chars / 3.6);
}
