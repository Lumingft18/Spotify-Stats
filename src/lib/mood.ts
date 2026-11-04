// Single source of truth for mood categories (valence × energy quadrants).

export type Mood = 'euforico' | 'sereno' | 'arrabbiato' | 'malinconico' | 'neutrale' | 'sconosciuto';

export const MOODS: Array<{ id: Exclude<Mood, 'sconosciuto'>; label: string; desc: string; color: string }> = [
  { id: 'euforico', label: 'Euforico', desc: 'positivo e intenso', color: 'var(--color-mood-euforico)' },
  { id: 'sereno', label: 'Sereno', desc: 'positivo e calmo', color: 'var(--color-mood-sereno)' },
  { id: 'arrabbiato', label: 'Teso', desc: 'negativo e intenso', color: 'var(--color-mood-arrabbiato)' },
  { id: 'malinconico', label: 'Malinconico', desc: 'negativo e calmo', color: 'var(--color-mood-malinconico)' },
  { id: 'neutrale', label: 'Neutro', desc: 'al centro', color: 'var(--color-mood-neutrale)' },
];

/** Raw hex values for canvas/Plot (CSS vars don't resolve there). */
export const MOOD_HEX: Record<Mood, string> = {
  euforico: '#e8b94a',
  sereno: '#5cc6c0',
  arrabbiato: '#e0604f',
  malinconico: '#7f7bd6',
  neutrale: '#9aa0ab',
  sconosciuto: '#4b5160',
};

export function getMood(valence: number | null | undefined, energy: number | null | undefined, neutral = 0.05): Mood {
  if (valence == null || !Number.isFinite(valence)) return 'sconosciuto';
  const v = Math.min(1, Math.max(0, valence));
  if (energy == null || !Number.isFinite(energy)) {
    if (v >= 0.5 + neutral) return 'sereno';
    if (v <= 0.5 - neutral) return 'malinconico';
    return 'neutrale';
  }
  const e = Math.min(1, Math.max(0, energy));
  if (Math.abs(v - 0.5) <= neutral && Math.abs(e - 0.5) <= neutral) return 'neutrale';
  if (v > 0.5) return e > 0.5 ? 'euforico' : 'sereno';
  return e > 0.5 ? 'arrabbiato' : 'malinconico';
}

/** SQL equivalent (keep in sync with getMood). */
export const MOOD_SQL = (v = 'valence', e = 'energy') => `CASE
  WHEN ${v} IS NULL THEN 'sconosciuto'
  WHEN abs(${v} - 0.5) <= 0.05 AND abs(coalesce(${e}, 0.5) - 0.5) <= 0.05 THEN 'neutrale'
  WHEN ${e} IS NULL THEN CASE WHEN ${v} > 0.5 THEN 'sereno' ELSE 'malinconico' END
  WHEN ${v} > 0.5 AND ${e} > 0.5 THEN 'euforico'
  WHEN ${v} > 0.5 THEN 'sereno'
  WHEN ${e} > 0.5 THEN 'arrabbiato'
  ELSE 'malinconico' END`;

export const moodLabel = (m: Mood) => MOODS.find((x) => x.id === m)?.label ?? 'Sconosciuto';
