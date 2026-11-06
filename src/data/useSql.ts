import { useEffect, useState } from 'react';
import { query } from './db';
import { useApp } from '../lib/store';

export interface SqlState<T> {
  data: T[] | null;
  error: string | null;
  loading: boolean;
}

interface Slot<V> {
  key: string;
  value: V | null;
  error: string | null;
}

/** Runs a query and re-runs it whenever the global epoch (filter/meta changes) or params change.
 *  Previous data stays visible while the next result loads (no flashing skeletons).
 *  `opts.key` replaces the epoch as the refresh trigger (for heavy views that must not redraw on every enrichment tick). */
export function useSql<T = Record<string, unknown>>(sql: string | null, params: unknown[] = [], opts: { key?: string | null } = {}): SqlState<T> {
  const globalEpoch = useApp((s) => s.epoch);
  const epoch = opts.key ?? globalEpoch;
  const ready = useApp((s) => s.status === 'ready');
  const paramKey = JSON.stringify(params);
  const reqKey = `${epoch}|${sql}|${paramKey}`;
  const [slot, setSlot] = useState<Slot<T[]>>({ key: '', value: null, error: null });

  useEffect(() => {
    if (!sql || !ready) return;
    let alive = true;
    query<T>(sql, JSON.parse(paramKey))
      .then((value) => alive && setSlot({ key: reqKey, value, error: null }))
      .catch((e: unknown) => {
        console.error(e, sql);
        if (alive) setSlot({ key: reqKey, value: null, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      alive = false;
    };
  }, [sql, paramKey, reqKey, ready]);

  const sameQuery = slot.key.slice(slot.key.indexOf('|')) === reqKey.slice(reqKey.indexOf('|'));
  return {
    // keep stale data only for the same query (e.g. filter change); otherwise show loading state
    data: sameQuery || slot.key === reqKey ? slot.value : null,
    error: slot.key === reqKey ? slot.error : null,
    loading: !!sql && slot.key !== reqKey,
  };
}

/** Convenience: first row. */
export function useSqlOne<T = Record<string, unknown>>(sql: string | null, params: unknown[] = []) {
  const s = useSql<T>(sql, params);
  return { ...s, row: s.data?.[0] ?? null };
}

/** Runs an async computation tied to the data epoch (re-runs on filter/meta changes or when deps change). */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = [], opts: { key?: string | null } = {}): SqlState<T> & { value: T | null } {
  const globalEpoch = useApp((s) => s.epoch);
  const epoch = opts.key ?? globalEpoch;
  const ready = useApp((s) => s.status === 'ready');
  const reqKey = `${epoch}|${JSON.stringify(deps)}`;
  const [slot, setSlot] = useState<Slot<T>>({ key: '', value: null, error: null });

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    fn()
      .then((value) => alive && setSlot({ key: reqKey, value, error: null }))
      .catch((e: unknown) => {
        console.error(e);
        if (alive) setSlot({ key: reqKey, value: null, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      alive = false;
    };
    // fn is intentionally excluded: callers pass inline closures; deps + epoch drive re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey, ready]);

  const sameDeps = slot.key.slice(slot.key.indexOf('|')) === reqKey.slice(reqKey.indexOf('|'));
  return {
    value: sameDeps ? slot.value : null,
    data: null,
    error: slot.key === reqKey ? slot.error : null,
    loading: slot.key !== reqKey,
  };
}
