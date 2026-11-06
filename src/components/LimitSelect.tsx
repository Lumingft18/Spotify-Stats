// "How many tracks" picker. 0 = all of them: per-track results (catalog, AI estimates, vectors) are cached
// in the local database, so covering everything is paid once, not on every run.
const DEFAULT_OPTIONS = [0, 500, 1000, 2000, 3000, 5000, 10000];

export function LimitSelect({
  value,
  onChange,
  label,
  options = DEFAULT_OPTIONS,
  className,
}: {
  value: number;
  onChange: (n: number) => void;
  label: string;
  options?: number[];
  className?: string;
}) {
  const opts = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      aria-label={label}
      className={className ?? 'h-9 rounded-full border border-border bg-surface-2 px-3 text-sm text-text'}
    >
      {opts.map((o) => (
        <option key={o} value={o}>
          {o === 0 ? 'Tutti' : `Top ${o.toLocaleString('it-IT')}`}
        </option>
      ))}
    </select>
  );
}
