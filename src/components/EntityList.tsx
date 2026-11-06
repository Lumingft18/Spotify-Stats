import { EyeOff } from 'lucide-react';
import { Cover } from './Cover';
import { excludeTrack } from '../data/lifecycle';
import { Meter, cx } from './ui';
import { fmtHours, fmtInt, fmtPct } from '../lib/format';
import { routes } from '../lib/router';
import type { TopKind, TopRow } from '../data/queries';

function entityHref(kind: TopKind, r: TopRow) {
  if (kind === 'artists') return routes.artist(r.artist);
  if (kind === 'albums') return routes.album(r.artist, r.label);
  return routes.track(r.uri!);
}

export function EntityList({
  kind,
  rows,
  startRank = 1,
  metric = 'minutes',
  compact = false,
}: {
  kind: TopKind;
  rows: TopRow[];
  startRank?: number;
  metric?: 'minutes' | 'plays';
  compact?: boolean;
}) {
  const max = Math.max(...rows.map((r) => (metric === 'plays' ? r.plays : r.minutes)), 1);
  return (
    <ol className="flex flex-col">
      {rows.map((r, i) => (
        <li key={`${r.label}-${r.artist}-${i}`} className="group/row relative">
          <a
            href={entityHref(kind, r)}
            className="group grid grid-cols-[2rem_auto_1fr_auto] items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-surface-2/70 md:grid-cols-[2.25rem_auto_1fr_10rem_6rem]"
          >
            <span className="num text-right text-sm text-text-faint">{startRank + i}</span>
            <Cover src={r.cover} name={r.label} size={compact ? 36 : 44} round={kind === 'artists'} />
            <div className="min-w-0">
              <div className="truncate font-medium text-text group-hover:text-[var(--accent)]">{r.label}</div>
              <div className="truncate text-xs text-text-faint">
                {kind === 'artists' ? `${fmtInt(r.n_tracks ?? 0)} brani` : r.artist}
                {!compact && r.skip_rate > 0 && <span> · skip {fmtPct(r.skip_rate)}</span>}
              </div>
            </div>
            <div className={cx('hidden md:block')}>
              <Meter value={metric === 'plays' ? r.plays : r.minutes} max={max} />
            </div>
            <div className="text-right">
              <div className="num text-sm text-text">{metric === 'plays' ? fmtInt(r.plays) : fmtHours(r.minutes)}</div>
              <div className="num text-[11px] text-text-faint">{metric === 'plays' ? fmtHours(r.minutes) : `${fmtInt(r.plays)} ascolti`}</div>
            </div>
          </a>
          {kind === 'tracks' && r.uri && (
            <button
              type="button"
              title={`Escludi “${r.label}” da tutto`}
              aria-label={`Escludi ${r.label} da tutte le statistiche`}
              onClick={() => void excludeTrack({ uri: r.uri!, track: r.label, artist: r.artist })}
              className="no-print absolute left-1 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-lg bg-surface-2 text-text-faint opacity-0 transition-opacity hover:text-bad focus-visible:opacity-100 group-hover/row:opacity-100"
            >
              <EyeOff size={14} />
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}
