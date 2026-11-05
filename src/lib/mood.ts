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

/**
 * Quadrant centre on the Spotify-style feature scale (catalog norms, not 0.5/0.5):
 * valence is ~symmetric around 0.50, while energy is skewed high in released music
 * (median 0.65–0.72 on 32k–114k-track Spotify datasets). Splitting energy at 0.5 put
 * ~75% of a typical pop/rock library in the high-arousal half and inflated "Teso".
 * Neutral box ≈ ±0.3 SD per axis (sd valence ≈ 0.23, energy ≈ 0.18), as in 5-class
 * valence/arousal setups (Panda et al. 2021; Çano & Morisio, MoodyLyrics).
 */
export const MOOD_CENTER = { valence: 0.5, energy: 0.65 } as const;
export const MOOD_NEUTRAL = { valence: 0.07, energy: 0.055 } as const;

export function getMood(valence: number | null | undefined, energy: number | null | undefined): Mood {
  if (valence == null || !Number.isFinite(valence)) return 'sconosciuto';
  const v = Math.min(1, Math.max(0, valence));
  const dv = v - MOOD_CENTER.valence;
  if (energy == null || !Number.isFinite(energy)) {
    if (Math.abs(dv) <= MOOD_NEUTRAL.valence) return 'neutrale';
    return dv > 0 ? 'sereno' : 'malinconico';
  }
  const de = Math.min(1, Math.max(0, energy)) - MOOD_CENTER.energy;
  if (Math.abs(dv) <= MOOD_NEUTRAL.valence && Math.abs(de) <= MOOD_NEUTRAL.energy) return 'neutrale';
  if (dv > 0) return de > 0 ? 'euforico' : 'sereno';
  return de > 0 ? 'arrabbiato' : 'malinconico';
}

/** SQL equivalent (keep in sync with getMood). */
export const MOOD_SQL = (v = 'valence', e = 'energy') => {
  const { valence: cv, energy: ce } = MOOD_CENTER;
  const { valence: nv, energy: ne } = MOOD_NEUTRAL;
  return `CASE
  WHEN ${v} IS NULL THEN 'sconosciuto'
  WHEN ${e} IS NULL THEN CASE WHEN abs(least(1, greatest(0, ${v})) - ${cv}) <= ${nv} THEN 'neutrale' WHEN least(1, greatest(0, ${v})) > ${cv} THEN 'sereno' ELSE 'malinconico' END
  WHEN abs(least(1, greatest(0, ${v})) - ${cv}) <= ${nv} AND abs(least(1, greatest(0, ${e})) - ${ce}) <= ${ne} THEN 'neutrale'
  WHEN least(1, greatest(0, ${v})) > ${cv} AND least(1, greatest(0, ${e})) > ${ce} THEN 'euforico'
  WHEN least(1, greatest(0, ${v})) > ${cv} THEN 'sereno'
  WHEN least(1, greatest(0, ${e})) > ${ce} THEN 'arrabbiato'
  ELSE 'malinconico' END`;
};

export const moodLabel = (m: Mood) => MOODS.find((x) => x.id === m)?.label ?? 'Sconosciuto';
