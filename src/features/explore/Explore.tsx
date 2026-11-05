import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { useRoute, navigate } from '../../lib/router';
import { useSql } from '../../data/useSql';
import { topSql, type TopKind, type TopRow } from '../../data/queries';
import { EntityList } from '../../components/EntityList';
import { PageHeader, Segmented, Skeleton, Button, Empty } from '../../components/ui';
import { StoryButton } from '../../components/StoryButton';
import { periodLabel } from '../../lib/storyCard';
import { useApp } from '../../lib/store';
import { fmtHours, fmtInt } from '../../lib/format';

const PAGE = 50;

export default function Explore({ kind: fixedKind }: { kind?: TopKind } = {}) {
  const { query } = useRoute();
  const kind = fixedKind ?? ((['artists', 'tracks', 'albums'].includes(query.get('kind') ?? '') ? query.get('kind') : 'artists') as TopKind);
  const [metric, setMetric] = useState<'minutes' | 'plays'>('minutes');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const resetKey = `${kind}|${metric}|${debounced}`;
  const [pages, setPages] = useState({ key: resetKey, n: PAGE });
  const limit = pages.key === resetKey ? pages.n : PAGE;
  const setLimit = (f: (l: number) => number) => setPages({ key: resetKey, n: f(limit) });

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim().toLowerCase()), 150);
    return () => clearTimeout(t);
  }, [q]);

  const res = useSql<TopRow>(topSql(kind, metric, limit, 0, !!debounced), debounced ? [`%${debounced}%`] : []);
  const label = { artists: 'Artisti', tracks: 'Brani', albums: 'Album' }[kind];
  const range = useApp((s) => s.range);
  const buildStory = () =>
    res.data?.length
      ? {
          kicker: periodLabel(range),
          title: `Top ${label.toLowerCase()}`,
          subtitle: metric === 'minutes' ? 'per tempo di ascolto' : 'per numero di ascolti',
          sections: [
            {
              title: debounced ? `Ricerca “${debounced}”` : 'Classifica',
              rows: res.data.slice(0, 8).map((r) => ({
                label: r.label,
                sub: kind === 'artists' ? undefined : r.artist,
                value: metric === 'minutes' ? fmtHours(r.minutes) : `${fmtInt(r.plays)}×`,
                image: r.cover,
                round: kind === 'artists',
              })),
            },
          ],
          filename: `top ${label} ${periodLabel(range)}`,
        }
      : null;

  return (
    <div>
      <PageHeader kicker="Esplora" title={label} sub="Tutto quello che hai ascoltato nel periodo selezionato. Clicca per aprire la scheda." right={<StoryButton build={buildStory} />} />
      <div className="sticky top-14 z-10 -mx-4 mb-4 flex flex-wrap items-center gap-3 bg-bg/80 px-4 py-3 backdrop-blur-xl md:-mx-8 md:px-8">
        <Segmented
          value={kind}
          onChange={(v) => navigate(`#/explore?kind=${v}`)}
          options={[
            { value: 'artists', label: 'Artisti' },
            { value: 'tracks', label: 'Brani' },
            { value: 'albums', label: 'Album' },
          ]}
        />
        <Segmented
          value={metric}
          onChange={setMetric}
          options={[
            { value: 'minutes', label: 'Per tempo' },
            { value: 'plays', label: 'Per ascolti' },
          ]}
        />
        <label className="relative ml-auto w-full sm:w-64">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Filtra ${label.toLowerCase()}…`}
            aria-label={`Filtra ${label}`}
            className="h-9 w-full rounded-full border border-border bg-surface-1 pl-9 pr-3 text-sm text-text placeholder:text-text-faint"
          />
        </label>
      </div>
      {res.data ? (
        res.data.length ? (
          <>
            <EntityList kind={kind} rows={res.data} metric={metric} />
            {res.data.length >= limit && (
              <div className="mt-6 flex justify-center">
                <Button onClick={() => setLimit((l) => l + PAGE)}>Mostra altri</Button>
              </div>
            )}
          </>
        ) : (
          <Empty title="Nessun risultato">Prova un altro termine o allarga il periodo.</Empty>
        )
      ) : (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      )}
    </div>
  );
}
