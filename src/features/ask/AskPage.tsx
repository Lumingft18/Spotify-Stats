import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Database, Sparkles, Trash2, Square, KeyRound } from 'lucide-react';
import { runAgent, type AgentMessage, type ChartSpec } from '../../llm/agent';
import { useLlmAvailable } from '../../llm/client';
import { idb } from '../../lib/idb';
import { useRoute, routes } from '../../lib/router';
import { useApp } from '../../lib/store';
import { Button, Card, ErrorNote, PageHeader, Spinner, cx } from '../../components/ui';
import { Cover } from '../../components/Cover';
import { PlotChart, Plot } from '../../components/charts/PlotChart';
import { StoryButton } from '../../components/StoryButton';

const SUGGESTIONS = [
  'Qual è stato il mio artista dell’estate scorsa?',
  'In che mese ho ascoltato più musica nuova?',
  'Quando ho iniziato ad ascoltare musica più triste?',
  'Perché salto così tanti brani? Ci sono orari peggiori?',
  'Trovami brani malinconici che non ascolto da un anno',
  'Confronta i miei ascolti del weekend con quelli in settimana',
];

/** Minimal, safe markdown: **bold**, *italic*, `code`, bullet/numbered lists, paragraphs. */
function Markdown({ text }: { text: string }) {
  const inline = (s: string, key: number): ReactNode => {
    const parts = s.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
    return (
      <span key={key}>
        {parts.map((p, i) =>
          p.startsWith('**') ? (
            <strong key={i} className="font-semibold text-text">
              {p.slice(2, -2)}
            </strong>
          ) : p.startsWith('`') ? (
            <code key={i} className="rounded bg-surface-3 px-1 font-mono text-[0.85em]">
              {p.slice(1, -1)}
            </code>
          ) : p.startsWith('*') && p.length > 2 ? (
            <em key={i}>{p.slice(1, -1)}</em>
          ) : (
            p
          ),
        )}
      </span>
    );
  };
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="flex flex-col gap-3 leading-relaxed text-text-muted">
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
          const ordered = /^\s*\d+\./.test(lines[0]);
          const Tag = ordered ? 'ol' : 'ul';
          return (
            <Tag key={i} className={cx('flex flex-col gap-1 pl-5', ordered ? 'list-decimal' : 'list-disc')}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ''), j)}</li>
              ))}
            </Tag>
          );
        }
        if (/^#{1,3}\s/.test(b)) return <div key={i} className="font-medium text-text">{inline(b.replace(/^#{1,3}\s/, ''), 0)}</div>;
        return <p key={i}>{lines.map((l, j) => [inline(l, j), j < lines.length - 1 ? <br key={`br${j}`} /> : null])}</p>;
      })}
    </div>
  );
}

function AgentChart({ spec }: { spec: ChartSpec }) {
  const make = useCallback(
    (width: number) => {
      const rows = spec.rows.map((r) => {
        const x = r[spec.x];
        const isDate = typeof x === 'string' && /^\d{4}-\d{2}(-\d{2})?$/.test(x);
        return { ...r, __x: isDate ? new Date((x as string).length === 7 ? `${x}-01` : (x as string)) : x, __y: Number(r[spec.y]) };
      });
      const temporal = rows.length > 0 && rows[0].__x instanceof Date;
      const opts = { x: '__x', y: '__y', ...(spec.color ? { stroke: spec.color, fill: spec.color } : {}) };
      const mark =
        spec.type === 'line'
          ? Plot.lineY(rows, { ...opts, fill: undefined, stroke: spec.color ?? 'var(--accent)', strokeWidth: 2, curve: 'monotone-x' })
          : spec.type === 'area'
            ? Plot.areaY(rows, { ...opts, stroke: undefined, fill: spec.color ?? 'var(--accent)', fillOpacity: 0.5 })
            : spec.type === 'dot'
              ? Plot.dot(rows, { ...opts, fill: spec.color ?? 'var(--accent)' })
              : temporal
                ? Plot.rectY(rows, { x: '__x', y: '__y', fill: spec.color ?? 'var(--accent)', interval: 'month' } as never)
                : Plot.barY(rows, { x: '__x', y: '__y', fill: spec.color ?? 'var(--accent)', sort: { x: '-y' }, rx: 2 } as never);
      return {
        height: 240,
        marginBottom: temporal ? 30 : 60,
        x: temporal ? { type: 'utc' as const, label: null, ticks: width < 500 ? 4 : 8 } : { label: null, tickRotate: rows.length > 6 ? -30 : 0 },
        y: { label: spec.y, grid: true },
        color: spec.color ? { legend: true } : undefined,
        marks: [mark, Plot.tip(rows, Plot.pointer({ x: '__x', y: '__y', title: (d: Record<string, unknown>) => `${String(d[spec.x])}\n${spec.y}: ${Number(d.__y).toLocaleString('it-IT')}` }))],
      };
    },
    [spec],
  );
  return (
    <Card className="p-4">
      <div className="mb-2 font-medium">{spec.title}</div>
      <PlotChart make={make} height={240} ariaLabel={spec.title} />
    </Card>
  );
}

const plain = (md: string) =>
  md
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*?([^*]+)\*\*?/g, '$1')
    .replace(/^\s*(?:[-*]|\d+\.)\s+/gm, '• ')
    .replace(/\s+/g, ' ')
    .trim();

function AssistantMessage({ m, question }: { m: AgentMessage; question?: string }) {
  return (
    <div className="flex flex-col gap-4">
      <Markdown text={m.content} />
      {m.charts?.map((c, i) => <AgentChart key={i} spec={c} />)}
      {m.tracks && m.tracks.length > 0 && (
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {m.tracks.map((t) => (
            <a key={t.uri} href={routes.track(t.uri)} className="flex items-center gap-3 rounded-xl p-2 hover:bg-surface-2">
              <Cover src={t.cover} name={t.track} size={40} />
              <div className="min-w-0">
                <div className="truncate text-sm">{t.track}</div>
                <div className="truncate text-xs text-text-faint">{t.artist}</div>
              </div>
            </a>
          ))}
        </div>
      )}
      <div>
        <StoryButton
          variant="ghost"
          build={() => ({
            kicker: 'Ho chiesto ai miei dati',
            title: question,
            note: plain(m.content),
            sections: m.tracks?.length ? [{ title: 'Brani', rows: m.tracks.slice(0, 5).map((t) => ({ label: t.track, sub: t.artist, image: t.cover })) }] : undefined,
            filename: question ?? 'risposta',
          })}
        />
      </div>
      {m.traces && m.traces.length > 0 && (
        <details className="text-xs text-text-faint">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 hover:text-text-muted">
            <Database size={12} /> {m.traces.length} operazioni sui tuoi dati
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            {m.traces.map((t, i) => (
              <div key={i} className="rounded-lg border border-border bg-surface-1 p-2">
                <div className={t.ok ? 'text-text-muted' : 'text-bad'}>
                  {t.tool} {t.ok ? `· ${t.rows} righe` : `· errore: ${t.error}`}
                </div>
                <pre className="scrollbar-thin mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-[11px]">{t.input}</pre>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export default function AskPage() {
  const { query } = useRoute();
  const [history, setHistory] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const autoSent = useRef<string | null>(null);
  const settings = useApp((s) => s.settings);
  const available = useLlmAvailable();

  useEffect(() => {
    void idb.get<AgentMessage[]>('ask_history').then((h) => h && setHistory(h));
  }, []);

  const send = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || step) return;
      setErr(null);
      setInput('');
      const next = [...history, { role: 'user' as const, content: q }];
      setHistory(next);
      ctrl.current = new AbortController();
      try {
        const reply = await runAgent(next, setStep, ctrl.current.signal);
        const all = [...next, reply];
        setHistory(all);
        await idb.set('ask_history', all.slice(-30));
      } catch (e) {
        if (!ctrl.current.signal.aborted) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setStep(null);
      }
    },
    [history, step],
  );

  useEffect(() => {
    const q = query.get('q');
    if (q && available && autoSent.current !== q) {
      autoSent.current = q;
      void send(q);
    }
  }, [query, available, send]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [history, step]);

  return (
    <div className="mx-auto flex max-w-4xl flex-col 2xl:max-w-5xl">
      <PageHeader kicker="Chiedi" title="Chiedi ai tuoi dati" sub="Un assistente che interroga il tuo storico con SQL e ricerca semantica. Ogni numero viene da una query che puoi ispezionare." />

      {!available && (
        <Card className="mb-8 flex flex-col items-start gap-3">
          <div className="flex items-center gap-2 font-medium">
            <KeyRound size={16} /> Serve una chiave OpenRouter
          </div>
          <p className="text-sm text-text-muted">
            L’assistente usa un modello linguistico ({settings.llmModelAgent}) con la tua chiave. Le domande e i risultati delle query vengono inviati
            a OpenRouter; lo storico completo resta sul dispositivo.
          </p>
          <a href={routes.settings()}>
            <Button variant="primary" size="sm">
              Configura in Impostazioni
            </Button>
          </a>
        </Card>
      )}

      <div className="flex flex-col gap-8">
        {history.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-surface-2 px-4 py-2.5 text-text">
              {m.content}
            </div>
          ) : (
            <div key={i} className="flex gap-3">
              <div className="mt-1 grid size-7 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-accent-ink">
                <Sparkles size={14} />
              </div>
              <div className="min-w-0 flex-1">
                <AssistantMessage m={m} question={history[i - 1]?.role === 'user' ? history[i - 1].content : undefined} />
              </div>
            </div>
          ),
        )}
        {step && (
          <div className="flex items-center gap-3 text-sm text-text-muted" aria-live="polite">
            <Spinner /> {step}
          </div>
        )}
        {err && <ErrorNote>{err}</ErrorNote>}
        <div ref={endRef} />
      </div>

      {!history.length && available && (
        <div className="mb-6 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => void send(s)} className="rounded-full border border-border bg-surface-1 px-3 py-1.5 text-left text-sm text-text-muted hover:bg-surface-2 hover:text-text">
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        className="no-print sticky bottom-20 mt-8 lg:bottom-6"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <div className="flex items-end gap-2 rounded-3xl border border-border-strong bg-surface-1/95 p-2 shadow-2xl backdrop-blur-xl">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            rows={1}
            disabled={!available}
            placeholder={available ? 'Fai una domanda sui tuoi ascolti…' : 'Configura una chiave per iniziare'}
            aria-label="Domanda"
            className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-3 py-2 text-text outline-none placeholder:text-text-faint"
          />
          {history.length > 0 && !step && (
            <button
              type="button"
              aria-label="Nuova conversazione"
              onClick={() => {
                setHistory([]);
                void idb.del('ask_history');
              }}
              className="grid size-10 place-items-center rounded-full text-text-faint hover:bg-surface-2"
            >
              <Trash2 size={16} />
            </button>
          )}
          {step ? (
            <button type="button" aria-label="Interrompi" onClick={() => ctrl.current?.abort()} className="grid size-10 place-items-center rounded-full bg-surface-3">
              <Square size={14} />
            </button>
          ) : (
            <button type="submit" aria-label="Invia" disabled={!input.trim() || !available} className="grid size-10 place-items-center rounded-full bg-[var(--accent)] text-accent-ink disabled:opacity-40">
              <ArrowUp size={18} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
