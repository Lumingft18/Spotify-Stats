/* eslint-disable react-refresh/only-export-components -- design-system module also exports the tiny `cx` helper */
import { type ReactNode, type ButtonHTMLAttributes, type HTMLAttributes } from 'react';
import { ArrowDownRight, ArrowUpRight, Info, TriangleAlert } from 'lucide-react';
import { fmtPct } from '../lib/format';

export function cx(...c: Array<string | false | null | undefined>) {
  return c.filter(Boolean).join(' ');
}

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx('rounded-[var(--radius-card)] border border-border bg-surface-1/80 p-5 md:p-6', className)}
      {...rest}
    >
      {children}
    </div>
  );
}

/** Insight-first section header: the title states the finding, the kicker names the topic. */
export function Section({
  kicker,
  title,
  action,
  children,
  className,
}: {
  kicker?: string;
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('animate-rise', className)}>
      {(kicker || title || action) && (
        <header className="mb-4 flex items-end justify-between gap-4">
          <div className="min-w-0">
            {kicker && <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-text-faint">{kicker}</div>}
            {title && <h2 className="text-lg font-medium leading-snug text-text md:text-xl">{title}</h2>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ kicker, title, sub, right }: { kicker?: string; title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-col gap-4 md:mb-10 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {kicker && <div className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-text-faint">{kicker}</div>}
        <h1 className="display text-5xl text-text md:text-6xl">{title}</h1>
        {sub && <p className="mt-3 max-w-2xl text-text-muted">{sub}</p>}
      </div>
      {right}
    </header>
  );
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' }) {
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-full font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-sm' : 'h-10 px-4 text-sm',
        variant === 'primary' && 'bg-[var(--accent)] text-accent-ink hover:brightness-110',
        variant === 'secondary' && 'border border-border bg-surface-2 text-text hover:bg-surface-3',
        variant === 'ghost' && 'text-text-muted hover:bg-surface-2 hover:text-text',
        variant === 'danger' && 'border border-bad/40 bg-bad/10 text-bad hover:bg-bad/20',
        className,
      )}
      {...rest}
    />
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={cx('inline-flex rounded-full border border-border bg-surface-1 p-1', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            'h-8 rounded-full px-3 text-sm transition-colors',
            o.value === value ? 'bg-surface-3 text-text' : 'text-text-muted hover:text-text',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'good' | 'bad'; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        tone === 'neutral' && 'bg-surface-3 text-text-muted',
        tone === 'accent' && 'bg-[color-mix(in_oklch,var(--accent)_18%,transparent)] text-[var(--accent)]',
        tone === 'good' && 'bg-good/15 text-good',
        tone === 'bad' && 'bg-bad/15 text-bad',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Delta({ value, suffix = 'vs periodo prima', invert = false }: { value: number | null; suffix?: string; invert?: boolean }) {
  if (value == null || !Number.isFinite(value)) return null;
  const up = value >= 0;
  const good = invert ? !up : up;
  return (
    <span className={cx('inline-flex items-center gap-1 text-xs', good ? 'text-good' : 'text-bad')}>
      {up ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
      <span className="num">{up ? '+' : ''}{fmtPct(value)}</span>
      <span className="text-text-faint">{suffix}</span>
    </span>
  );
}

export function Stat({ label, value, sub, delta, children }: { label: string; value: ReactNode; sub?: ReactNode; delta?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="text-xs text-text-faint">{label}</div>
      <div className="num truncate text-2xl font-medium text-text md:text-3xl">{value}</div>
      {sub && <div className="text-xs text-text-muted">{sub}</div>}
      {delta}
      {children}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} aria-hidden />;
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border border-dashed border-border px-6 py-10 text-center">
      <div className="text-text-faint">{icon ?? <Info size={22} />}</div>
      <div className="font-medium text-text">{title}</div>
      {children && <div className="max-w-md text-sm text-text-muted">{children}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-xl border border-bad/30 bg-bad/10 p-3 text-sm text-bad">
      <TriangleAlert size={16} className="mt-0.5 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

export function Meter({ value, max, color }: { value: number; max: number; color?: string }) {
  const w = max > 0 ? Math.max(1.5, (value / max) * 100) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
      <div className="h-full rounded-full" style={{ width: `${w}%`, background: color ?? 'var(--accent)' }} />
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-muted">{children}</kbd>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      aria-label="caricamento"
      className="inline-block animate-spin rounded-full border-2 border-surface-3 border-t-[var(--accent)]"
      style={{ width: size, height: size }}
    />
  );
}
