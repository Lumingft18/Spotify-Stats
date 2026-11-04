// "Chiedi ai tuoi dati": tool-calling agent over DuckDB + semantic index.
import type OpenAI from 'openai';
import { query } from '../data/db';
import { SCHEMA_FOR_LLM } from '../data/schema';
import { getApp } from '../lib/store';
import { semanticSearch, loadIndex } from '../ml/embeddings';
import { llm } from './client';

export interface ChartSpec {
  title: string;
  type: 'bar' | 'line' | 'area' | 'dot';
  x: string;
  y: string;
  color?: string;
  rows: Array<Record<string, unknown>>;
}

export interface ToolTrace {
  tool: string;
  input: string;
  ok: boolean;
  rows?: number;
  error?: string;
}

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
  charts?: ChartSpec[];
  traces?: ToolTrace[];
  tracks?: Array<{ uri: string; track: string; artist: string; cover: string | null }>;
}

const FORBIDDEN = /\b(insert|update|delete|create|drop|alter|attach|detach|copy|pragma|install|load|export|import|call|set|checkpoint|vacuum|truncate|replace|grant|revoke)\b/i;

/** Validates and wraps a read-only query; throws on anything that isn't a single SELECT/WITH/FROM statement. */
export function safeSql(sql: string, limit = 200): string {
  const s = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/;+\s*$/, '');
  if (s.includes(';')) throw new Error('È consentita una sola istruzione SQL.');
  if (!/^(select|with|from)\b/i.test(s)) throw new Error('Sono consentite solo query di lettura (SELECT/WITH).');
  if (FORBIDDEN.test(s.replace(/'[^']*'/g, "''"))) throw new Error('La query contiene parole chiave non consentite.');
  if (/read_(csv|json|parquet|text|blob)|glob\(|http/i.test(s)) throw new Error('Accesso a file esterni non consentito.');
  return `SELECT * FROM (${s}) AS q LIMIT ${limit}`;
}

function compact(rows: Array<Record<string, unknown>>, max = 60) {
  return rows.slice(0, max).map((r) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'number') o[k] = Math.round(v * 1000) / 1000;
      else if (typeof v === 'string') o[k] = v.length > 120 ? v.slice(0, 120) + '…' : v;
      else o[k] = v;
    }
    return o;
  });
}

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'run_sql',
      description: 'Esegue una query SQL DuckDB di sola lettura sullo storico di ascolto. Restituisce al massimo 200 righe.',
      parameters: {
        type: 'object',
        properties: { sql: { type: 'string', description: 'Una singola query SELECT/WITH' } },
        required: ['sql'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'semantic_search',
      description:
        'Cerca brani per significato/atmosfera/genere/tema del testo (es. "canzoni malinconiche sulla pioggia"). Restituisce uri, titolo, artista e somiglianza. Combinabile con run_sql filtrando per uri.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          k: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'make_chart',
      description:
        "Mostra un grafico all'utente a partire da una query SQL. Usalo quando un andamento o un confronto si capisce meglio visivamente.",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: "Titolo che enuncia l'insight, es. 'Ascolti di più la domenica'" },
          type: { type: 'string', enum: ['bar', 'line', 'area', 'dot'] },
          sql: { type: 'string' },
          x: { type: 'string', description: 'colonna asse x' },
          y: { type: 'string', description: 'colonna asse y (numerica)' },
          color: { type: 'string', description: 'colonna opzionale per serie/colore' },
        },
        required: ['title', 'type', 'sql', 'x', 'y'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_tracks',
      description: "Mostra all'utente una lista di brani (con copertina) dati i loro uri.",
      parameters: {
        type: 'object',
        properties: { uris: { type: 'array', items: { type: 'string' }, maxItems: 20 } },
        required: ['uris'],
        additionalProperties: false,
      },
    },
  },
];

async function systemPrompt(): Promise<string> {
  const { range } = getApp();
  const bounds = await query<{ a: string; b: string; n: number }>(
    `SELECT min(day)::VARCHAR AS a, max(day)::VARCHAR AS b, count(*) AS n FROM p`,
  );
  const hasIndex = !!(await loadIndex());
  const who = getApp().profile?.displayName ?? null;
  return `Sei l'assistente di "Ascolti", un'app che analizza lo storico Spotify dell'utente in locale.
Rispondi in italiano, in modo diretto e caldo, con frasi brevi.${who ? ` L'utente si chiama ${who}: puoi chiamarlo per nome, con misura.` : ''} Prima i fatti, poi (se utile) una curiosità.

REGOLE IMPORTANTI
- Ogni numero che citi DEVE provenire da un risultato di un tool in questa conversazione. Non inventare mai numeri.
- Se una domanda non è risolvibile con i dati, dillo chiaramente.
- Usa make_chart quando la risposta è un andamento nel tempo o un confronto tra più di 4 elementi.
- Formatta minuti in ore quando > 120. Date in italiano (es. "marzo 2024").
- Per gusti/atmosfere/temi usa semantic_search${hasIndex ? '' : ' (ATTENZIONE: indice semantico non ancora creato, spiega all’utente come crearlo in "Mood & Galassia")'}.

DATI
${SCHEMA_FOR_LLM}
Periodo selezionato (vista p): ${range.from ?? bounds[0]?.a} → ${range.to ?? bounds[0]?.b}, ${bounds[0]?.n ?? 0} ascolti.
Oggi: ${new Date().toISOString().slice(0, 10)}.

ESEMPI SQL
-- artista più ascoltato per ore
SELECT artist, round(sum(minutes)/60,1) AS ore FROM p GROUP BY artist ORDER BY ore DESC LIMIT 5
-- minuti per mese
SELECT strftime(day,'%Y-%m') AS mese, round(sum(minutes)) AS minuti FROM p GROUP BY 1 ORDER BY 1
-- giorno della settimana più attivo
SELECT dow, round(sum(minutes)/count(DISTINCT day)) AS minuti_medi FROM p GROUP BY dow ORDER BY dow
-- brano più ascoltato in estate 2024
SELECT track, artist, count(*) FILTER (WHERE counted) AS ascolti FROM p WHERE day BETWEEN DATE '2024-06-21' AND DATE '2024-09-22' GROUP BY ALL ORDER BY ascolti DESC LIMIT 1`;
}

export async function runAgent(
  history: AgentMessage[],
  onStep: (s: string) => void,
  signal: AbortSignal,
): Promise<AgentMessage> {
  const client = llm();
  const model = getApp().settings.llmModelAgent;
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: await systemPrompt() },
    ...history.slice(-10).map((m) => ({ role: m.role, content: m.content }) as OpenAI.Chat.Completions.ChatCompletionMessageParam),
  ];
  const out: AgentMessage = { role: 'assistant', content: '', charts: [], traces: [], tracks: [] };

  for (let step = 0; step < 8; step++) {
    onStep(step === 0 ? 'Penso…' : 'Analizzo i risultati…');
    const res = await client.chat.completions.create(
      { model, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.2 },
      { signal },
    );
    const msg = res.choices[0]?.message;
    if (!msg) throw new Error('Risposta vuota dal modello');
    messages.push(msg as OpenAI.Chat.Completions.ChatCompletionMessageParam);
    const calls = msg.tool_calls ?? [];
    if (!calls.length) {
      out.content = msg.content ?? '';
      return out;
    }
    for (const call of calls) {
      if (call.type !== 'function') continue;
      let result: unknown;
      const name = call.function.name;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        /* keep empty */
      }
      try {
        if (name === 'run_sql') {
          onStep('Interrogo il database…');
          const rows = await query(safeSql(String(args.sql ?? '')));
          out.traces!.push({ tool: 'SQL', input: String(args.sql), ok: true, rows: rows.length });
          result = { rows: compact(rows), total_rows: rows.length };
        } else if (name === 'semantic_search') {
          onStep('Cerco per significato…');
          const hits = await semanticSearch(String(args.query ?? ''), Math.min(50, Number(args.k ?? 15)));
          const info = hits.length
            ? await query<{ uri: string; track: string; artist: string; plays: number }>(
                `SELECT uri, track, artist, plays FROM tracks WHERE uri IN (${hits.map(() => '?').join(',')})`,
                hits.map((h) => h.uri),
              )
            : [];
          const im = new Map(info.map((i) => [i.uri, i]));
          out.traces!.push({ tool: 'Ricerca semantica', input: String(args.query), ok: true, rows: hits.length });
          result = hits.map((h) => ({ ...im.get(h.uri), similarity: Math.round(h.score * 100) / 100 }));
        } else if (name === 'make_chart') {
          onStep('Preparo il grafico…');
          const rows = await query(safeSql(String(args.sql ?? ''), 500));
          const spec: ChartSpec = {
            title: String(args.title ?? ''),
            type: (['bar', 'line', 'area', 'dot'].includes(String(args.type)) ? args.type : 'bar') as ChartSpec['type'],
            x: String(args.x),
            y: String(args.y),
            color: args.color ? String(args.color) : undefined,
            rows,
          };
          out.charts!.push(spec);
          out.traces!.push({ tool: 'Grafico', input: String(args.sql), ok: true, rows: rows.length });
          result = { shown: true, rows: compact(rows, 30) };
        } else if (name === 'show_tracks') {
          const uris = (args.uris as string[] | undefined)?.slice(0, 20) ?? [];
          const rows = uris.length
            ? await query<{ uri: string; track: string; artist: string; cover: string | null }>(
                `SELECT t.uri, t.track, t.artist, m.cover FROM tracks t LEFT JOIN meta m USING (uri) WHERE t.uri IN (${uris.map(() => '?').join(',')})`,
                uris,
              )
            : [];
          out.tracks!.push(...rows);
          result = { shown: rows.length };
        } else result = { error: 'tool sconosciuto' };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        out.traces!.push({ tool: name, input: JSON.stringify(args).slice(0, 300), ok: false, error: message });
        result = { error: message };
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 12_000) });
    }
  }
  out.content = out.content || 'Ho raggiunto il limite di passaggi: prova a riformulare la domanda in modo più specifico.';
  return out;
}
