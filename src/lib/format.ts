const nf = new Intl.NumberFormat('it-IT');
const nf1 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });

export const fmtInt = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : nf.format(Math.round(n)));
export const fmt1 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : nf1.format(n));
export const fmtPct = (r: number | null | undefined, digits = 0) =>
  r == null || !Number.isFinite(r) ? '—' : `${(r * 100).toFixed(digits).replace('.', ',')}%`;

export function fmtHours(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return '—';
  const h = minutes / 60;
  if (h >= 100) return `${fmtInt(h)} h`;
  if (h >= 1) return `${fmt1(h)} h`;
  return `${Math.round(minutes)} min`;
}

export function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m} min`;
}

const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const MONTHS_LONG = [
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre',
];
export const DOW = ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'];
export const DOW_LONG = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'];

/** 'YYYY-MM-DD' → '12 mar 2024' */
export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return `${day} ${MONTHS[m - 1]} ${y}`;
}
/** 'YYYY-MM' → 'marzo 2024' */
export function fmtMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS_LONG[m - 1]} ${y}`;
}
export const monthShort = (m: number) => MONTHS[m - 1];

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1;
}

export function addDays(d: string, n: number): string {
  const t = new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000);
  return t.toISOString().slice(0, 10);
}

export const countryName = (() => {
  let dn: Intl.DisplayNames | null = null;
  try {
    dn = new Intl.DisplayNames(['it'], { type: 'region' });
  } catch {
    dn = null;
  }
  return (code: string) => {
    if (!code || code === 'ZZ') return 'Sconosciuto';
    try {
      return dn?.of(code) ?? code;
    } catch {
      return code;
    }
  };
})();

export function plural(n: number, one: string, many: string) {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}
