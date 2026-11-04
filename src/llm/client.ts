import OpenAI from 'openai';
import { getApp } from '../lib/store';

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
