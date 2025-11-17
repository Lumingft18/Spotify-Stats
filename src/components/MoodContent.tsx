import React, { useState, useEffect, useCallback } from 'react';
import type { DataFrameData, MoodAnalysisResult } from '../types';
import type { PeriodType } from './PeriodFilter';
import { DataTable } from './DataTable';
import { MultiLinePlot } from './MultiLinePlot';
import { getPyodide, startAIMoodAnalysis, applyLocalMoodResultsToDataFrame } from '../utils/pyodide';
import { cancelMoodAnalysis, isCancelled } from '../utils/openrouter';
import { loadMoodResultsFromIndexedDB } from '../utils/storage';
import { get_mood } from '../utils/moodClassifier';

/**
 * Riclassifica un singolo risultato mood usando la logica v2 se necessario
 */
function reclassifyMoodResult(result: MoodAnalysisResult): MoodAnalysisResult {
  // Se il risultato ha già un mood_category valido, non fare nulla
  const validMoods = ['euforico', 'sereno', 'arrabbiato', 'malinconico', 'neutrale', 'sconosciuto'];
  if (result.mood_category && validMoods.includes(result.mood_category)) {
    return result;
  }

  // Altrimenti, calcolalo con v2
  const newMoodCategory = get_mood(result.valence, result.energy);
  return {
    ...result,
    mood_category: newMoodCategory
  };
}

interface MoodContentProps {
  dataCache: { [key: string]: DataFrameData | any };
  currentPeriod: PeriodType;
}

function getSavedMoodResultsCount(): number {
  try {
    const savedResultsStr = localStorage.getItem('audio_features_results');
    if (savedResultsStr) {
      const savedResults = JSON.parse(savedResultsStr);
      if (Array.isArray(savedResults)) {
        return savedResults.length;
      }
    }
  } catch (error) {
    console.warn('[MoodContent] Errore nel leggere i risultati salvati:', error);
  }

  try {
    const metaStr = localStorage.getItem('audio_features_results_meta');
    if (metaStr) {
      const meta = JSON.parse(metaStr);
      if (meta && typeof meta.count === 'number') {
        return meta.count;
      }
    }
  } catch (error) {
    console.warn('[MoodContent] Errore nel leggere i metadati dei risultati:', error);
  }

  return 0;
}

// Funzione per caricare tutti i risultati del mood
async function loadAllMoodResults(): Promise<MoodAnalysisResult[]> {
  const results: MoodAnalysisResult[] = [];
  
  try {
    // Carica da localStorage
    const savedResultsStr = localStorage.getItem('audio_features_results');
    if (savedResultsStr) {
      const saved = JSON.parse(savedResultsStr) as Array<{ key: string; result: MoodAnalysisResult }>;
      saved.forEach(({ result }) => {
        if (result && result.track && result.artist) {
          results.push(result);
        }
      });
    }
  } catch (error) {
    console.warn('[MoodContent] Errore nel leggere i risultati dal localStorage:', error);
  }

  try {
    // Carica da IndexedDB
    const indexedResults = await loadMoodResultsFromIndexedDB();
    indexedResults.forEach(({ result }) => {
      if (result && result.track && result.artist) {
        // Riclassifica il mood usando la logica v2 se necessario
        const reclassifiedResult = reclassifyMoodResult(result);

        // Evita duplicati
        const exists = results.some(r =>
          r.track === reclassifiedResult.track && r.artist === reclassifiedResult.artist
        );
        if (!exists) {
          results.push(reclassifiedResult);
        }
      }
    });
  } catch (error) {
    console.warn('[MoodContent] Errore nel leggere i risultati da IndexedDB:', error);
  }

  return results;
}

const MOOD_DISPLAY_META: Record<string, { gradient: string; emoji: string; color: string }> = {
  euforico: { gradient: 'from-yellow-400 to-orange-500', emoji: '🎉', color: '#f97316' },
  sereno: { gradient: 'from-green-400 to-teal-500', emoji: '😌', color: '#14b8a6' },
  arrabbiato: { gradient: 'from-red-500 to-rose-600', emoji: '😠', color: '#ef4444' },
  malinconico: { gradient: 'from-blue-500 to-indigo-600', emoji: '😔', color: '#3b82f6' },
  neutrale: { gradient: 'from-gray-400 to-gray-500', emoji: '😐', color: '#9ca3af' },
  sconosciuto: { gradient: 'from-gray-500 to-gray-600', emoji: '❓', color: '#6b7280' },
};

const MOOD_PERCENT_COLORS = Object.entries(MOOD_DISPLAY_META).reduce((acc, [mood, meta]) => {
  acc[`${mood}_percent`] = meta.color;
  return acc;
}, {} as Record<string, string>);

const MOOD_PERCENT_COLUMN_ORDER = Object.keys(MOOD_PERCENT_COLORS);

function prepareMoodTimeSeriesData(data?: DataFrameData | null): DataFrameData | null {
  if (!data || !Array.isArray(data.columns) || !Array.isArray(data.data)) {
    return null;
  }

  const xColumn = data.columns[0];
  const columns = [xColumn, ...MOOD_PERCENT_COLUMN_ORDER];

  const preparedData = (data.data || []).map(row => {
    const rowMap: Record<string, any> = {};
    data.columns.forEach((col, idx) => {
      rowMap[col] = row[idx];
    });

    const newRow: any[] = [rowMap[xColumn]];
    MOOD_PERCENT_COLUMN_ORDER.forEach(col => {
      newRow.push(rowMap[col] ?? 0);
    });
    return newRow;
  });

  return {
    columns,
    data: preparedData
  };
}

function normalizeTrackArtistKey(track?: string | null, artist?: string | null): string | null {
  if (!track && !artist) {
    return null;
  }

  let trackName = typeof track === 'string' ? track : '';
  let artistName = typeof artist === 'string' ? artist : '';

  if (trackName.includes('~~sep~~')) {
    const parts = trackName.split('~~sep~~');
    trackName = parts[0] || '';
    if (parts.length > 1 && !artistName) {
      artistName = parts[1] || '';
    }
  }

  const normalizedTrack = trackName.trim().toLowerCase();
  const normalizedArtist = artistName.trim().toLowerCase();

  if (!normalizedTrack) {
    return null;
  }

  return `${normalizedTrack}|||${normalizedArtist}`;
}

// Funzione per ottenere le canzoni del periodo corrente dal dataCache
function getTracksInPeriod(dataCache: { [key: string]: DataFrameData | any }, currentPeriod?: string): Set<string> {
  const tracksSet = new Set<string>();

  try {
    console.log(`[getTracksInPeriod] Iniziando ricerca per periodo: ${currentPeriod}`);
    console.log(`[getTracksInPeriod] Chiavi dataCache disponibili:`, Object.keys(dataCache));

    const filteredTrackKeys = dataCache?.filtered_track_keys;
    if (Array.isArray(filteredTrackKeys) && filteredTrackKeys.length > 0) {
      filteredTrackKeys.forEach(entry => {
        if (typeof entry === 'string') {
          const normalized = entry.trim().toLowerCase();
          if (normalized) {
            tracksSet.add(normalized);
          }
        } else if (entry && typeof entry === 'object') {
          const key = normalizeTrackArtistKey(
            'track' in entry ? entry.track : ('track_clean' in entry ? entry.track_clean : undefined),
            'artist' in entry ? entry.artist : ('artist_clean' in entry ? entry.artist_clean : undefined)
          );
          if (key) {
            tracksSet.add(key);
          }
        }
      });

      console.log(`[getTracksInPeriod] Recuperate ${tracksSet.size} canzoni dal dataset filtered_track_keys`);
      return tracksSet;
    }

    // Prima cerca dataset che potrebbero contenere dati di traccia per il periodo corrente come fallback
    const candidateDatasets: Array<{ key: string; data: any; priority: number }> = [];

    for (const key in dataCache) {
      const data = dataCache[key];
      if (data && 'columns' in data && 'data' in data && Array.isArray(data.data)) {
        const columns = data.columns;

        // Cerca colonne track e artist
        const trackColIndex = columns.indexOf('track');
        const trackCleanColIndex = columns.indexOf('track_clean');
        const artistColIndex = columns.indexOf('artist');
        const artistCleanColIndex = columns.indexOf('artist_clean');

        // Se ha colonne track/artist, aggiungilo alla lista dei candidati
        if ((trackColIndex >= 0 || trackCleanColIndex >= 0) &&
            (artistColIndex >= 0 || artistCleanColIndex >= 0)) {

          // Assegna priorità: dataset più grandi hanno priorità più alta
          let priority = data.data.length;

          // Bonus per dataset che sembrano contenere dati completi di traccia
          if (key.includes('tracks') && !key.includes('top_') && !key.includes('stats')) {
            priority = priority * 2; // Doppio priorità per dataset "tracks"
          }

          // Penalizza dataset che sembrano essere aggregazioni/statistiche
          if (key.includes('distribution') || key.includes('stats') || key.includes('top_')) {
            priority = priority * 0.1; // Molto bassa priorità
          } else if (key.includes('per_week') || key.includes('per_month') || key.includes('per_day')) {
            priority = priority * 0.5; // Priorità media
          }

          candidateDatasets.push({ key, data, priority });
        }
      }
    }

    // Ordina per priorità (descendente) e dimensione (descendente)
    candidateDatasets.sort((a, b) => b.priority - a.priority);

    console.log(`[getTracksInPeriod] Dataset candidati trovati:`, candidateDatasets.map(d => `${d.key} (${d.data.data.length} righe, priorità: ${d.priority})`));
    
    for (const candidate of candidateDatasets) {
      const candidateData = candidate.data as DataFrameData;
      if (
        !candidateData ||
        !Array.isArray(candidateData.columns) ||
        !Array.isArray(candidateData.data) ||
        candidateData.columns.length === 0
      ) {
        continue;
      }

      const columns = candidateData.columns;
      const trackIndex = columns.indexOf('track_clean') >= 0 ? columns.indexOf('track_clean') : columns.indexOf('track');
      const artistIndex = columns.indexOf('artist_clean') >= 0 ? columns.indexOf('artist_clean') : columns.indexOf('artist');

      if (trackIndex < 0) {
        continue;
      }

      candidateData.data.forEach(row => {
        if (!Array.isArray(row)) {
          return;
        }
        const trackValue = row[trackIndex];
        const artistValue = artistIndex >= 0 ? row[artistIndex] : undefined;
        const key = normalizeTrackArtistKey(
          typeof trackValue === 'string' ? trackValue : trackValue != null ? String(trackValue) : undefined,
          typeof artistValue === 'string' ? artistValue : artistValue != null ? String(artistValue) : undefined
        );
        if (key) {
          tracksSet.add(key);
        }
      });
    }
  } catch (error) {
    console.warn('[MoodContent] Errore nell\'estrarre le canzoni dal dataCache:', error);
  }

  console.log(`[getTracksInPeriod] Totale canzoni trovate: ${tracksSet.size}`);
  if (tracksSet.size > 0) {
    console.log(`[getTracksInPeriod] Esempi di canzoni:`, Array.from(tracksSet).slice(0, 3));
  }
  return tracksSet;
}

// Funzione per filtrare i risultati del mood in base al periodo
function filterMoodResultsByPeriod(
  results: MoodAnalysisResult[],
  dataCache: { [key: string]: DataFrameData | any },
  currentPeriod: PeriodType
): MoodAnalysisResult[] {
  // Se il periodo è "total", restituisci tutti i risultati senza filtrare
  if (currentPeriod === 'total') {
    console.log('[MoodContent] Periodo "total", restituisco tutti i risultati:', results.length);
    return results;
  }

  // Se non ci sono dati nel dataCache, restituisci tutti i risultati
  if (!dataCache || Object.keys(dataCache).length === 0) {
    console.log('[MoodContent] Nessun dataCache disponibile, restituisco tutti i risultati');
    return results;
  }

  // Ottieni le canzoni del periodo corrente
  const tracksInPeriod = getTracksInPeriod(dataCache, currentPeriod);
  console.log('[MoodContent] Canzoni nel periodo:', {
    period: currentPeriod,
    tracksCount: tracksInPeriod.size,
    sampleTracks: Array.from(tracksInPeriod).slice(0, 5)
  });

  // Se non ci sono canzoni nel periodo, potrebbe essere che il filtro non sia ancora applicato
  // o che il dataCache non sia ancora aggiornato. In questo caso, restituisci tutti i risultati
  // ma logga un warning
  if (tracksInPeriod.size === 0) {
    console.warn('[MoodContent] Nessuna canzone trovata nel periodo corrente, potrebbe essere che il dataCache non sia ancora aggiornato. Restituisco tutti i risultati per ora.');
    console.log('[MoodContent] Chiavi dataCache disponibili:', Object.keys(dataCache));
    return results;
  }

  // Se abbiamo molto poche canzoni (meno di 100), potrebbe essere un errore
  // Logga un warning ma procedi comunque
  if (tracksInPeriod.size < 100) {
    console.warn(`[MoodContent] Solo ${tracksInPeriod.size} canzoni trovate nel periodo ${currentPeriod}, potrebbe essere un errore di filtraggio`);
  }

  // Filtra i risultati per includere solo le canzoni del periodo
  const filtered = results.filter(result => {
    if (!result.track || !result.artist) {
      return false;
    }

    const key = normalizeTrackArtistKey(result.track, result.artist);
    if (!key) {
      return false;
    }
    return tracksInPeriod.has(key);
  });

  console.log('[MoodContent] Filtro completato:', {
    totalResults: results.length,
    filteredResults: filtered.length,
    matched: filtered.length > 0,
    period: currentPeriod,
    tracksInPeriod: tracksInPeriod.size
  });

  // Se non abbiamo trovato corrispondenze ma abbiamo canzoni nel periodo,
  // potrebbe essere un problema di normalizzazione dei nomi
  if (filtered.length === 0 && tracksInPeriod.size > 0) {
    console.warn('[MoodContent] Nessuna corrispondenza trovata tra risultati mood e canzoni del periodo. Potrebbe essere un problema di normalizzazione dei nomi.');
    console.log('[MoodContent] Esempi risultati mood:', results.slice(0, 3).map(r => `${r.track} - ${r.artist}`));
    console.log('[MoodContent] Esempi canzoni periodo:', Array.from(tracksInPeriod).slice(0, 3));
  }

  return filtered;
}

// Interfaccia per le statistiche avanzate
interface AdvancedMoodStats {
  topHappiest: MoodAnalysisResult[];
  topSaddest: MoodAnalysisResult[];
  topEnergetic: MoodAnalysisResult[];
  topDanceable: MoodAnalysisResult[];
  artistStats: Array<{
    artist: string;
    avgValence: number;
    avgEnergy: number;
    avgDanceability: number;
    trackCount: number;
    moodDistribution: {
      felice: number;
      neutrale: number;
      triste: number;
      // Nuovi mood v2
      euforico: number;
      sereno: number;
      arrabbiato: number;
      malinconico: number;
    };
  }>;
  featureDistribution: {
    valence: number[];
    energy: number[];
    danceability: number[];
  };
  extremeMoods: {
    happiest: MoodAnalysisResult;
    saddest: MoodAnalysisResult;
    mostEnergetic: MoodAnalysisResult;
    mostDanceable: MoodAnalysisResult;
  };
  overallStats: {
    avgValence: number;
    avgEnergy: number;
    avgDanceability: number;
    totalTracks: number;
    moodCounts: {
      felice: number;
      neutrale: number;
      triste: number;
      // Nuovi mood v2
      euforico: number;
      sereno: number;
      arrabbiato: number;
      malinconico: number;
      sconosciuto: number;
    };
  };
}

// Funzione per calcolare statistiche avanzate
function calculateAdvancedStats(results: MoodAnalysisResult[]): AdvancedMoodStats {
  console.log('[calculateAdvancedStats] Input results:', results.length);

  if (results.length === 0) {
    return {
      topHappiest: [],
      topSaddest: [],
      topEnergetic: [],
      topDanceable: [],
      artistStats: [],
      featureDistribution: { valence: [], energy: [], danceability: [] },
      extremeMoods: {
        happiest: results[0] || {} as MoodAnalysisResult,
        saddest: results[0] || {} as MoodAnalysisResult,
        mostEnergetic: results[0] || {} as MoodAnalysisResult,
        mostDanceable: results[0] || {} as MoodAnalysisResult,
      },
    overallStats: {
      avgValence: 0,
      avgEnergy: 0,
      avgDanceability: 0,
      totalTracks: 0,
      moodCounts: {
        felice: 0,
        neutrale: 0,
        triste: 0,
        // Nuovi mood v2
        euforico: 0,
        sereno: 0,
        arrabbiato: 0,
        malinconico: 0,
        sconosciuto: 0
      },
    },
    };
  }

  // Filtra risultati validi
  const validResults = results.filter(r => 
    r.valence !== null && r.valence !== undefined && 
    r.track && r.artist
  );

  // Top 10 più felici (valence più alta)
  const topHappiest = [...validResults]
    .sort((a, b) => (b.valence || 0) - (a.valence || 0))
    .slice(0, 10);

  // Top 10 più tristi (valence più bassa)
  const topSaddest = [...validResults]
    .sort((a, b) => (a.valence || 0) - (b.valence || 0))
    .slice(0, 10);

  // Top 10 più energetiche
  const topEnergetic = [...validResults]
    .filter(r => r.energy !== null && r.energy !== undefined)
    .sort((a, b) => (b.energy || 0) - (a.energy || 0))
    .slice(0, 10);

  // Top 10 più ballabili
  const topDanceable = [...validResults]
    .filter(r => r.danceability !== null && r.danceability !== undefined)
    .sort((a, b) => (b.danceability || 0) - (a.danceability || 0))
    .slice(0, 10);

  // Mood estremi
  const extremeMoods = {
    happiest: topHappiest[0] || validResults[0],
    saddest: topSaddest[0] || validResults[0],
    mostEnergetic: topEnergetic[0] || validResults[0],
    mostDanceable: topDanceable[0] || validResults[0],
  };

  // Statistiche per artista
  const artistMap = new Map<string, MoodAnalysisResult[]>();
  validResults.forEach(result => {
    const artist = result.artist;
    if (!artistMap.has(artist)) {
      artistMap.set(artist, []);
    }
    artistMap.get(artist)!.push(result);
  });

  const artistStats = Array.from(artistMap.entries())
    .map(([artist, tracks]) => {
      // Calcola statistiche in un singolo passaggio per ottimizzare prestazioni
      let valenceSum = 0, energySum = 0, danceabilitySum = 0;
      let valenceCount = 0, energyCount = 0, danceabilityCount = 0;

      const moodDistribution = {
        felice: 0,
        neutrale: 0,
        triste: 0,
        euforico: 0,
        sereno: 0,
        arrabbiato: 0,
        malinconico: 0,
      };

      // Calcola tutto in un singolo loop per ottimizzare
      tracks.forEach(track => {
        // Mood distribution
        if (track.mood_category && moodDistribution.hasOwnProperty(track.mood_category)) {
          moodDistribution[track.mood_category as keyof typeof moodDistribution]++;
        }

        // Valence
        if (track.valence !== null && track.valence !== undefined) {
          valenceSum += track.valence;
          valenceCount++;
        }

        // Energy
        if (track.energy !== null && track.energy !== undefined) {
          energySum += track.energy;
          energyCount++;
        }

        // Danceability
        if (track.danceability !== null && track.danceability !== undefined) {
          danceabilitySum += track.danceability;
          danceabilityCount++;
        }
      });

      const avgValence = valenceCount > 0 ? valenceSum / valenceCount : 0;
      const avgEnergy = energyCount > 0 ? energySum / energyCount : 0;
      const avgDanceability = danceabilityCount > 0 ? danceabilitySum / danceabilityCount : 0;

      return {
        artist,
        avgValence,
        avgEnergy,
        avgDanceability,
        trackCount: tracks.length,
        moodDistribution,
      };
    })
    .filter(stat => stat.trackCount >= 3) // Solo artisti con almeno 3 canzoni
    .sort((a, b) => b.trackCount - a.trackCount)
    .slice(0, 20); // Top 20 artisti

  // Distribuzione delle features
  const featureDistribution = {
    valence: validResults.map(r => r.valence || 0),
    energy: validResults.filter(r => r.energy !== null && r.energy !== undefined).map(r => r.energy || 0),
    danceability: validResults.filter(r => r.danceability !== null && r.danceability !== undefined).map(r => r.danceability || 0),
  };

  // Statistiche generali
  const avgValence = featureDistribution.valence.length > 0
    ? featureDistribution.valence.reduce((sum, v) => sum + v, 0) / featureDistribution.valence.length
    : 0;
  const avgEnergy = featureDistribution.energy.length > 0
    ? featureDistribution.energy.reduce((sum, e) => sum + e, 0) / featureDistribution.energy.length
    : 0;
  const avgDanceability = featureDistribution.danceability.length > 0
    ? featureDistribution.danceability.reduce((sum, d) => sum + d, 0) / featureDistribution.danceability.length
    : 0;

  // Conta i mood in un singolo passaggio per ottimizzare prestazioni
  const moodCounts = {
    felice: 0,
    neutrale: 0,
    triste: 0,
    euforico: 0,
    sereno: 0,
    arrabbiato: 0,
    malinconico: 0,
    sconosciuto: 0,
  };

  validResults.forEach(result => {
    const mood = result.mood_category;
    if (mood && moodCounts.hasOwnProperty(mood)) {
      moodCounts[mood as keyof typeof moodCounts]++;
    } else {
      moodCounts.sconosciuto++;
    }
  });

  console.log('[calculateAdvancedStats] Mood counts:', moodCounts);

  return {
    topHappiest,
    topSaddest,
    topEnergetic,
    topDanceable,
    artistStats,
    featureDistribution,
    extremeMoods,
    overallStats: {
      avgValence,
      avgEnergy,
      avgDanceability,
      totalTracks: validResults.length,
      moodCounts,
    },
  };
}

export function MoodContent({ dataCache, currentPeriod }: MoodContentProps) {
  const [audioFeaturesProgress, setAudioFeaturesProgress] = useState<{ current: number; total: number; percent: number; completed?: boolean; error?: string; loadingMessage?: string; cancelled?: boolean } | null>(null);
  const [isLoadingAudioFeatures, setIsLoadingAudioFeatures] = useState(false);
  const [canLoadAudioFeatures, setCanLoadAudioFeatures] = useState(false);
  const [tracksCount, setTracksCount] = useState<number>(0);
  const [openRouterApiKey, setOpenRouterApiKey] = useState<string>('');
  const [advancedStats, setAdvancedStats] = useState<AdvancedMoodStats | null>(null);
  const [isLoadingAdvancedStats, setIsLoadingAdvancedStats] = useState(false);
  
  const moodDistribution = dataCache['mood_distribution'] as DataFrameData | undefined;
  const moodPerWeek = dataCache['mood_per_week'] as DataFrameData | undefined;
  const moodPerMonth = dataCache['mood_per_month'] as DataFrameData | undefined;
  const moodPerDay = dataCache['mood_per_day'] as DataFrameData | undefined;
  const moodPerDayOfWeek = dataCache['mood_per_day_of_week'] as DataFrameData | undefined;

  const moodPerDayChartData = React.useMemo(() => prepareMoodTimeSeriesData(moodPerDay), [moodPerDay]);
  const moodPerWeekChartData = React.useMemo(() => prepareMoodTimeSeriesData(moodPerWeek), [moodPerWeek]);
  const moodPerMonthChartData = React.useMemo(() => prepareMoodTimeSeriesData(moodPerMonth), [moodPerMonth]);

  // Calcola distribuzione del mood dai risultati filtrati invece di usare quella del dataCache
  const filteredMoodDistribution = React.useMemo(() => {
    if (!advancedStats) return null;

    const totalTracks = advancedStats.overallStats.totalTracks;
    if (totalTracks === 0) return null;

    const moodCounts = advancedStats.overallStats.moodCounts;

    // Crea array nel formato DataFrameData per compatibilità
    const data: (string | number)[][] = [];

    // Aggiungi tutti i mood, anche con conteggio 0, ordinati dal maggiore al minore
    Object.entries(moodCounts)
      .sort(([, countA], [, countB]) => (countB as number) - (countA as number))
      .forEach(([mood, count]) => {
        const numericCount = typeof count === 'number' ? count : 0;
        const percentage = totalTracks > 0
          ? Math.round((numericCount / totalTracks) * 1000) / 10 // Una cifra decimale
          : 0;
        data.push([mood, percentage, numericCount]);
      });

    return {
      columns: ['mood', 'percentuale', 'conteggio'],
      data
    };
  }, [advancedStats]);
  
  // Carica l'API key salvata
  useEffect(() => {
    const savedApiKey = localStorage.getItem('openrouter_api_key');
    if (savedApiKey) {
      setOpenRouterApiKey(savedApiKey);
    }
  }, []);

  // Stato per tracciare se l'analisi è già stata completata
  const [hasCompletedAnalysis, setHasCompletedAnalysis] = useState(false);

  // Controlla se è possibile caricare le audio features
  useEffect(() => {
    const checkAvailability = () => {
      try {
        const available = localStorage.getItem('pending_audio_features_pyodide_available');
        const tracksStr = localStorage.getItem('pending_audio_features_tracks');
        if (available === 'true' && tracksStr) {
          const tracks = JSON.parse(tracksStr);
          setCanLoadAudioFeatures(tracks.length > 0);
          setTracksCount(tracks.length);
          
          // Controlla se ci sono risultati salvati e mostra il progresso
          const savedCount = getSavedMoodResultsCount();
          if (savedCount > 0 && savedCount < tracks.length) {
            // Ci sono risultati parziali salvati
            const percent = Math.round((savedCount / tracks.length) * 100);
            setAudioFeaturesProgress({
              current: savedCount,
              total: tracks.length,
              percent,
              completed: false,
            });
            setHasCompletedAnalysis(false);
            console.log(`[MoodContent] Trovati ${savedCount}/${tracks.length} risultati salvati (${percent}%)`);
          } else if (savedCount === tracks.length && tracks.length > 0) {
            // Tutti i risultati sono già stati processati
            const isCompleted = localStorage.getItem('audio_features_completed') === 'true';
            setAudioFeaturesProgress({
              current: tracks.length,
              total: tracks.length,
              percent: 100,
              completed: true,
            });
            setHasCompletedAnalysis(true);
            console.log(`[MoodContent] Tutti i ${tracks.length} risultati sono già stati processati (completato: ${isCompleted})`);
            
            // Se l'analisi è completa, i dati dovrebbero essere già applicati
            // Ma se non ci sono dati nel dataCache, potrebbero essere stati persi
            // In quel caso, l'utente può riapplicarli cliccando di nuovo
          } else {
            setHasCompletedAnalysis(false);
          }
        } else {
          setHasCompletedAnalysis(false);
        }
      } catch (e) {
        // Ignora errori
        setHasCompletedAnalysis(false);
      }
    };
    
    checkAvailability();
  }, []);

  // Aggiorna il flag quando cambia il dataCache (per esempio quando cambia il periodo)
  useEffect(() => {
    // Controlla se l'analisi è già stata completata guardando i risultati salvati
    try {
      const tracksStr = localStorage.getItem('pending_audio_features_tracks');
      if (tracksStr) {
        const tracks = JSON.parse(tracksStr);
        const savedCount = getSavedMoodResultsCount();
        if (savedCount === tracks.length && tracks.length > 0) {
          setHasCompletedAnalysis(true);
        }
      }
    } catch (e) {
      // Ignora errori
    }
  }, [dataCache]);

  // Funzione per caricare le statistiche avanzate dai dati locali
  const loadAdvancedStatsFromLocal = useCallback(async () => {
    const savedCount = getSavedMoodResultsCount();
    console.log('[MoodContent] Caricamento statistiche avanzate:', {
      savedCount,
      currentPeriod,
      hasDataCache: !!dataCache,
      dataCacheKeys: dataCache ? Object.keys(dataCache) : []
    });

    if (savedCount > 0) {
      setIsLoadingAdvancedStats(true);
      try {
        const allResults = await loadAllMoodResults();
        console.log('[MoodContent] Risultati caricati:', allResults.length);

        if (allResults.length > 0) {
          // Filtra i risultati in base al periodo corrente
          const filteredResults = filterMoodResultsByPeriod(allResults, dataCache, currentPeriod);
          console.log('[MoodContent] Risultati filtrati per periodo:', {
            total: allResults.length,
            filtered: filteredResults.length,
            period: currentPeriod
          });

          const stats = calculateAdvancedStats(filteredResults);
          setAdvancedStats(stats);
          console.log('[MoodContent] Statistiche avanzate aggiornate:', {
            totalTracks: stats.overallStats.totalTracks,
            topHappiest: stats.topHappiest.length,
            topSaddest: stats.topSaddest.length
          });
        } else {
          setAdvancedStats(null);
        }
      } catch (error) {
        console.error('[MoodContent] Errore nel caricare le statistiche avanzate:', error);
        setAdvancedStats(null);
      } finally {
        setIsLoadingAdvancedStats(false);
      }
    } else {
      setAdvancedStats(null);
      setIsLoadingAdvancedStats(false);
    }
  }, [dataCache, currentPeriod]);

  // Carica le statistiche avanzate quando ci sono dati disponibili
  useEffect(() => {
    loadAdvancedStatsFromLocal();
  }, [hasCompletedAnalysis, loadAdvancedStatsFromLocal]);

  // Controlla il progresso delle audio features
  useEffect(() => {
    const checkProgress = () => {
      try {
        const progressStr = localStorage.getItem('audio_features_progress');
        if (progressStr) {
          const progress = JSON.parse(progressStr);
          // Aggiorna solo se il progresso è effettivamente cambiato
          setAudioFeaturesProgress(prev => {
            if (prev && 
                prev.current === progress.current && 
                prev.total === progress.total && 
                prev.percent === progress.percent &&
                prev.completed === progress.completed &&
                prev.error === progress.error) {
              return prev; // Nessun cambiamento, non aggiornare
            }
            return progress;
          });
        }
      } catch (e) {
        // Ignora errori
      }
    };
    
    // Controlla immediatamente
    checkProgress();
    
    // Controlla periodicamente solo se il caricamento è in corso
    const interval = setInterval(() => {
      if (isLoadingAudioFeatures) {
        checkProgress();
      } else {
        // Controlla anche se c'è un progresso non completato
        const progressStr = localStorage.getItem('audio_features_progress');
        if (progressStr) {
          try {
            const progress = JSON.parse(progressStr);
            if (!progress.completed) {
              checkProgress();
            }
          } catch (e) {
            // Ignora errori
          }
        }
      }
    }, 1000);
    
    // Ascolta eventi di aggiornamento
    const handleUpdate = async (_event: any) => {
      checkProgress();
      setIsLoadingAudioFeatures(false);
      // Controlla se l'analisi è stata completata
      const progressStr = localStorage.getItem('audio_features_progress');
      if (progressStr) {
        try {
          const progress = JSON.parse(progressStr);
          if (progress.completed && !progress.cancelled) {
            setHasCompletedAnalysis(true);
            // Ricarica le statistiche avanzate quando l'analisi è completata
            try {
              const allResults = await loadAllMoodResults();
              if (allResults.length > 0) {
                // Filtra i risultati in base al periodo corrente
                const filteredResults = filterMoodResultsByPeriod(allResults, dataCache, currentPeriod);
                const stats = calculateAdvancedStats(filteredResults);
                setAdvancedStats(stats);
              }
            } catch (error) {
              console.error('[MoodContent] Errore nel ricaricare le statistiche avanzate:', error);
            }
          }
        } catch (e) {
          // Ignora errori
        }
      }
      // I dati verranno aggiornati automaticamente tramite l'evento
      // Non serve ricaricare la pagina, l'aggiornamento avviene tramite App.tsx
    };
    
    window.addEventListener('audioFeaturesUpdated', handleUpdate);
    
    return () => {
      clearInterval(interval);
      window.removeEventListener('audioFeaturesUpdated', handleUpdate);
    };
  }, [isLoadingAudioFeatures]); // Rimossa audioFeaturesProgress dalle dipendenze
  
  // Funzione per salvare l'API key
  const handleSaveApiKey = () => {
    const trimmedKey = openRouterApiKey.trim();
    if (trimmedKey) {
      localStorage.setItem('openrouter_api_key', trimmedKey);
      setOpenRouterApiKey(trimmedKey); // Assicura che lo stato sia aggiornato
      alert('API key salvata con successo!');
      console.log('API key salvata nel localStorage');
    } else {
      alert('Inserisci una API key valida');
    }
  };

  // Funzione per avviare l'analisi AI
  const handleStartAudioFeaturesLoad = async () => {
    // Verifica l'API key dallo stato o dal localStorage
    const apiKeyToUse = openRouterApiKey.trim() || localStorage.getItem('openrouter_api_key') || '';
    
    if (!apiKeyToUse) {
      alert('Inserisci la tua OpenRouter API key per utilizzare l\'analisi AI');
      return;
    }

    // Verifica che ci siano track disponibili
    const tracksStr = localStorage.getItem('pending_audio_features_tracks');
    if (!tracksStr) {
      alert('Nessun track disponibile per l\'analisi. Carica prima i tuoi dati Spotify.');
      return;
    }

    console.log('Avvio analisi mood con API key:', apiKeyToUse.substring(0, 10) + '...');
    
    // Resetta il flag di cancellazione nel localStorage
    try {
      localStorage.setItem('audio_features_progress', JSON.stringify({
        current: 0,
        total: 0,
        percent: 0,
        completed: false,
        cancelled: false, // Resetta esplicitamente il flag
      }));
    } catch (e) {
      console.warn('Errore nel resettare il progresso:', e);
    }
    
    setIsLoadingAudioFeatures(true);
    setAudioFeaturesProgress({ current: 0, total: 0, percent: 0 });
    
    try {
      let pyodide = getPyodide();
      
      // Se Pyodide non è disponibile, prova a ricaricare il file salvato
      if (!pyodide) {
        console.log('Pyodide non disponibile, tentativo di ricaricare il file salvato...');
        const { loadFileFromStorage } = await import('../utils/storage');
        const savedFile = await loadFileFromStorage();
        
        if (!savedFile) {
          throw new Error(
            'Pyodide non disponibile e nessun file salvato trovato.\n\n' +
            'Per utilizzare l\'analisi del mood, devi prima caricare i tuoi dati Spotify.\n' +
            'Vai alla sezione di caricamento file e carica il tuo file ZIP di Spotify.'
          );
        }
        
        console.log('File trovato, ricarico i dati...');
        // Aggiorna il progresso per mostrare che sta ricaricando
        setAudioFeaturesProgress({ 
          current: 0, 
          total: 0, 
          percent: 0,
          completed: false 
        });
        setCanLoadAudioFeatures(true); // Assicura che il box rimanga visibile
        
        // Ricarica i dati dal file salvato
        const { processSpotifyData } = await import('../utils/pyodide');
        const result = await processSpotifyData(savedFile, (step) => {
          console.log('Ricaricamento:', step);
          // Aggiorna il progresso durante il ricaricamento
          setAudioFeaturesProgress(prev => ({
            ...prev,
            current: 0,
            total: 0,
            percent: 0,
            completed: false,
            loadingMessage: step
          }));
        });
        
        pyodide = result.pyodide;
        console.log('Pyodide inizializzato e dati ricaricati con successo');
      }

      if (!pyodide) {
        throw new Error('Pyodide non disponibile dopo il tentativo di ricarica');
      }

      console.log('Pyodide disponibile, avvio analisi AI...');
      
      // Usa l'analisi AI con OpenRouter
      await startAIMoodAnalysis(pyodide, apiKeyToUse, (current, total) => {
        console.log(`[MoodContent] onProgress chiamato: ${current}/${total}`);
        
        // Controlla se è stato cancellato solo dopo aver calcolato il progresso
        const percent = Math.round((current / total) * 100);
        console.log(`[MoodContent] Progresso calcolato: ${percent}%`);
        
        // Controlla se è stato cancellato prima di aggiornare l'UI
        if (isCancelled()) {
          console.log('[MoodContent] Analisi cancellata (flag), non aggiorno il progresso');
          return;
        }
        
        // NON controllare il localStorage per cancelled qui, perché potrebbe essere un valore vecchio
        // Il flag isCancelled() è sufficiente
        
        console.log(`[MoodContent] Aggiornamento UI: ${current}/${total} (${percent}%)`);
        setAudioFeaturesProgress({ current, total, percent });
        try {
          localStorage.setItem('audio_features_progress', JSON.stringify({
            current,
            total,
            percent,
            completed: false,
            cancelled: false, // Assicura che non sia marcato come cancellato
          }));
        } catch (e) {
          console.error('[MoodContent] Errore nel salvare il progresso:', e);
        }
      });
      
      // Controlla se è stato cancellato prima di completare
      const progressStr = localStorage.getItem('audio_features_progress');
      if (progressStr) {
        try {
          const progress = JSON.parse(progressStr);
          if (progress.cancelled) {
            console.log('Analisi cancellata');
            return;
          }
        } catch (e) {
          // Ignora errori
        }
      }
      
      console.log('Analisi completata con successo');
      setIsLoadingAudioFeatures(false);
      setHasCompletedAnalysis(true);
    } catch (error: any) {
      console.error('Errore durante l\'analisi:', error);
      const errorMessage = error.message || 'Errore durante il caricamento';
      
      // Se è stato cancellato dall'utente, non mostrare un alert di errore
      if (errorMessage.includes('cancellata') || errorMessage.includes('cancellato')) {
        console.log('Analisi cancellata dall\'utente');
        setAudioFeaturesProgress({
          current: audioFeaturesProgress?.current || 0,
          total: audioFeaturesProgress?.total || 0,
          percent: audioFeaturesProgress?.percent || 0,
          completed: true,
          cancelled: true,
        });
      } else {
        alert(`Errore: ${errorMessage}`);
        setAudioFeaturesProgress({
          current: 0,
          total: 0,
          percent: 0,
          completed: true,
          error: errorMessage,
        });
      }
      setIsLoadingAudioFeatures(false);
    }
  };

  // Funzione per fermare il caricamento
  const handleStopAudioFeaturesLoad = async () => {
    // Cancella l'analisi AI in corso
    cancelMoodAnalysis();
    
    // Aggiorna immediatamente il localStorage con lo stato di cancellazione
    try {
      const currentProgress = audioFeaturesProgress || { current: 0, total: 0, percent: 0 };
      localStorage.setItem('audio_features_progress', JSON.stringify({
        ...currentProgress,
        completed: true,
        cancelled: true,
      }));
    } catch (e) {
      // Ignora errori
    }
    
    setIsLoadingAudioFeatures(false);
    setAudioFeaturesProgress({
      current: audioFeaturesProgress?.current || 0,
      total: audioFeaturesProgress?.total || 0,
      percent: audioFeaturesProgress?.percent || 0,
      completed: true,
      cancelled: true,
    });
    
    console.log('Analisi fermata dall\'utente');
  };

  // Determina se mostrare dati giornalieri invece di settimanali per periodi brevi
  const shouldShowDailyData = currentPeriod === 'this_month' || currentPeriod === 'last_3_months';

  // Mostra il progresso del caricamento se è in corso
  const showProgress = audioFeaturesProgress && !audioFeaturesProgress.completed;
  
  return (
    <div className="space-y-8">
      {/* Banner informativo se le audio features non sono disponibili */}
      {/* Mostra il banner solo se non ci sono dati E l'analisi non è già stata completata */}
      {!moodDistribution && !moodPerWeek && !moodPerMonth && !moodPerDayOfWeek && 
       !hasCompletedAnalysis && 
       (canLoadAudioFeatures || isLoadingAudioFeatures) && (
        <div className="bg-gradient-to-br from-orange-900/30 to-red-900/30 border border-orange-700/50 rounded-xl p-6">
          <div className="flex items-start gap-3">
            <span className="text-2xl">🤖</span>
            <div className="flex-1">
              <h3 className="text-orange-200 font-semibold mb-2">
                {isLoadingAudioFeatures && audioFeaturesProgress?.loadingMessage 
                  ? `Ricaricamento dati: ${audioFeaturesProgress.loadingMessage}`
                  : 'Analisi mood con AI disponibile'}
              </h3>
              <p className="text-orange-300 text-sm mb-4">
                {isLoadingAudioFeatures && audioFeaturesProgress?.loadingMessage ? (
                  <span>Sto ricaricando i dati necessari per l'analisi...</span>
                ) : (
                  <>
                    Puoi avviare l'analisi del mood usando l'AI per visualizzare le statistiche sulle tue canzoni.
                    {tracksCount > 0 && (
                      <span className="block mt-2 text-orange-400 font-semibold">
                        {tracksCount} track pronti per l'analisi
                      </span>
                    )}
                  </>
                )}
              </p>

              {/* Campo API Key per OpenRouter - nascosto durante il ricaricamento */}
              {!(isLoadingAudioFeatures && audioFeaturesProgress?.loadingMessage) && (
              <div className="bg-blue-900/30 border border-blue-700 rounded-lg p-4 mb-4">
                <p className="text-blue-200 text-sm font-semibold mb-2">🔑 OpenRouter API Key</p>
                <p className="text-blue-300 text-xs mb-3">
                  Inserisci la tua API key di OpenRouter. Puoi ottenerla gratuitamente su{' '}
                  <a href="https://openrouter.ai" target="_blank" rel="noopener noreferrer" className="underline">
                    openrouter.ai
                  </a>
                </p>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={openRouterApiKey}
                    onChange={(e) => setOpenRouterApiKey(e.target.value)}
                    placeholder="sk-or-..."
                    className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    onClick={handleSaveApiKey}
                    className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded-lg transition-all duration-200 text-sm"
                  >
                    Salva
                  </button>
                </div>
                {openRouterApiKey && (
                  <p className="text-green-400 text-xs mt-2">✓ API key configurata</p>
                )}
              </div>
              )}

              <div className="bg-orange-900/30 border border-orange-700 rounded-lg p-4 mb-4">
                <p className="text-orange-200 text-sm font-semibold mb-2">ℹ️ Informazioni:</p>
                <ul className="text-orange-300 text-xs list-disc list-inside ml-2 space-y-1">
                  <li>L'analisi AI processa <strong>100 canzoni alla volta</strong> con <strong>10 richieste concorrenti</strong></li>
                  <li>Ogni richiesta analizza <strong>10 canzoni</strong> contemporaneamente (più veloce)</li>
                  <li>Il processo è veloce e accurato</li>
                  <li>Richiede una API key di OpenRouter (puoi usare modelli gratuiti o a pagamento)</li>
                  <li>I dati vengono salvati automaticamente durante il processo</li>
                  <li>Puoi continuare a navigare mentre l'analisi è in corso</li>
                </ul>
              </div>
              <button
                onClick={() => {
                  console.log('Pulsante cliccato, API key nello stato:', openRouterApiKey ? 'presente' : 'assente');
                  console.log('API key nel localStorage:', localStorage.getItem('openrouter_api_key') ? 'presente' : 'assente');
                  handleStartAudioFeaturesLoad();
                }}
                disabled={isLoadingAudioFeatures || (!openRouterApiKey.trim() && !localStorage.getItem('openrouter_api_key'))}
                className="bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white font-semibold py-3 px-6 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isLoadingAudioFeatures ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent"></div>
                    <span>Analisi in corso...</span>
                  </>
                ) : (
                  <>
                    <span>🚀</span>
                    <span>Avvia analisi mood</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Banner di progresso in alto */}
      {showProgress && (
        <div className="bg-gradient-to-br from-blue-900/30 to-indigo-900/30 border border-blue-700/50 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-blue-400 border-t-transparent"></div>
            <div className="flex-1">
              <p className="text-blue-200 font-semibold text-sm">
                Analisi mood AI in corso...
              </p>
              <div className="mt-2">
                <div className="flex items-center justify-between text-xs text-blue-300 mb-1">
                  <span>{audioFeaturesProgress.current} / {audioFeaturesProgress.total} track</span>
                  <span>{audioFeaturesProgress.percent}%</span>
                </div>
                <div className="w-full bg-blue-900/50 rounded-full h-2 overflow-hidden">
                  <div 
                    className="bg-gradient-to-r from-blue-500 to-indigo-500 h-2 rounded-full transition-all duration-300"
                    style={{ width: `${audioFeaturesProgress.percent}%` }}
                  ></div>
                </div>
              </div>
              <div className="flex items-center justify-between mt-3">
                <p className="text-blue-400 text-xs">
                  Puoi continuare a navigare mentre l'analisi AI è in corso in background.
                </p>
                <button
                  onClick={handleStopAudioFeaturesLoad}
                  className="bg-red-600 hover:bg-red-700 text-white font-semibold py-1.5 px-4 rounded-lg transition-all duration-200 text-xs flex items-center gap-2"
                >
                  <span>⏹️</span>
                  <span>Ferma</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* Se non ci sono dati sul mood nel dataCache, mostra il box di input solo se non ci sono statistiche avanzate */}
      {!moodDistribution && !moodPerWeek && !moodPerMonth && !moodPerDayOfWeek && 
       (!advancedStats || advancedStats.overallStats.totalTracks === 0) && (
        <div className="bg-gradient-to-br from-yellow-900/30 to-orange-900/30 border border-yellow-700/50 rounded-xl p-6">
          <div className="flex items-start gap-3">
            <span className="text-2xl">⚠️</span>
            <div className="flex-1">
              <h3 className="text-yellow-200 font-semibold mb-2">Dati sul mood non disponibili</h3>
              <p className="text-yellow-300 text-sm mb-4">
                Per visualizzare le statistiche sul mood delle tue canzoni, utilizza l'<strong>analisi AI</strong> tramite OpenRouter.
              </p>
              
              <div className="bg-purple-900/30 border border-purple-700 rounded-lg p-4 mb-4">
                <div className="flex items-start gap-2">
                  <span className="text-lg">🤖</span>
                  <div className="flex-1">
                    <p className="text-purple-200 text-sm font-semibold mb-1">Analisi AI</p>
                    <p className="text-purple-300 text-sm mb-2">
                      Utilizza modelli AI avanzati per analizzare il mood delle canzoni basandosi sul nome della canzone e dell'artista. Veloce e accurato!
                    </p>
                    <ul className="text-purple-300 text-xs list-disc list-inside ml-2 space-y-1">
                      <li>Processa 100 canzoni alla volta (10 canzoni per richiesta, 10 richieste concorrenti)</li>
                      <li>Richiede una API key di OpenRouter (gratuita o a pagamento)</li>
                      <li>Fornisce valutazioni matematiche dettagliate (valence, energy, danceability)</li>
                      <li>Funziona con qualsiasi canzone, anche se non presente nei database</li>
                    </ul>
                  </div>
                </div>
              </div>

              <div className="mt-4 bg-gray-800/30 rounded-lg p-4 text-sm text-gray-400">
                <p className="font-semibold mb-2 text-gray-300">Cosa fare:</p>
                <p className="text-gray-300 text-sm mb-2">
                  Carica i tuoi dati Spotify per abilitare l'analisi del mood. Una volta caricati i dati, potrai avviare l'analisi AI inserendo la tua OpenRouter API key.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Messaggio informativo sui grafici temporali se ci sono statistiche avanzate ma non grafici */}
      {advancedStats && advancedStats.overallStats.totalTracks > 0 && 
       !moodDistribution && !moodPerWeek && !moodPerMonth && !moodPerDayOfWeek && (
        <div className="bg-gradient-to-br from-blue-900/30 to-indigo-900/30 border border-blue-700/50 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <span className="text-xl">ℹ️</span>
            <div className="flex-1">
              <h3 className="text-blue-200 font-semibold mb-2">Grafici temporali non disponibili</h3>
              <p className="text-blue-300 text-sm mb-3">
                I grafici temporali (mood per settimana/giorno/mese) richiedono che i dati siano applicati tramite Pyodide. 
                Le statistiche avanzate mostrate di seguito sono calcolate dai dati locali salvati.
              </p>
              <button
                onClick={async () => {
                  try {
                    setIsLoadingAdvancedStats(true);
                    let pyodide = getPyodide();
                    
                    // Se Pyodide non è disponibile, prova a ricaricare il file salvato
                    if (!pyodide) {
                      console.log('[MoodContent] Pyodide non disponibile, tentativo di ricaricare il file salvato...');
                      const { loadFileFromStorage } = await import('../utils/storage');
                      const savedFile = await loadFileFromStorage();
                      
                      if (!savedFile) {
                        alert(
                          'Pyodide non disponibile e nessun file salvato trovato.\n\n' +
                          'Per generare i grafici temporali, devi prima caricare i tuoi dati Spotify.\n' +
                          'Vai alla sezione di caricamento file e carica il tuo file ZIP di Spotify.'
                        );
                        setIsLoadingAdvancedStats(false);
                        return;
                      }
                      
                      console.log('[MoodContent] File trovato, ricarico i dati...');
                      
                      // Ricarica i dati dal file salvato
                      const { processSpotifyData } = await import('../utils/pyodide');
                      const result = await processSpotifyData(savedFile, (step) => {
                        console.log('[MoodContent] Ricaricamento:', step);
                      });
                      
                      pyodide = result.pyodide;
                      console.log('[MoodContent] Pyodide inizializzato e dati ricaricati con successo');
                    }
                    
                    if (!pyodide) {
                      throw new Error('Pyodide non disponibile dopo il tentativo di ricarica');
                    }
                    
                    await applyLocalMoodResultsToDataFrame(pyodide, (step) => {
                      console.log('[MoodContent] Applicazione dati:', step);
                    });
                    // I dati verranno aggiornati automaticamente tramite l'evento audioFeaturesUpdated
                  } catch (error: any) {
                    console.error('[MoodContent] Errore nell\'applicare i dati:', error);
                    alert(`Errore: ${error.message || 'Errore durante l\'applicazione dei dati'}`);
                  } finally {
                    setIsLoadingAdvancedStats(false);
                  }
                }}
                disabled={isLoadingAdvancedStats}
                className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-semibold py-2 px-4 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                title="Applica i dati locali al DataFrame per generare i grafici temporali"
              >
                {isLoadingAdvancedStats ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                    <span>Applicazione dati...</span>
                  </>
                ) : (
                  <>
                    <span>🔄</span>
                    <span>Genera grafici temporali</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Mostra i dati se disponibili */}
      {/* Distribuzione generale del mood */}
      {filteredMoodDistribution && (
        <div className="space-y-4">
          <h3 className="text-xl font-bold text-green-400 flex items-center gap-2">
            <span>📊</span> Distribuzione generale del mood
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {(filteredMoodDistribution.data || [])
              .filter((row: any[]) => {
                if (!Array.isArray(row)) return false;
                const count = typeof row[2] === 'number' ? row[2] : 0;
                return count > 0;
              })
              .map((row: any[], index: number) => {
              const mood = row[0] as string;
              const percentuale = typeof row[1] === 'number' ? row[1] as number : 0;
              const conteggio = typeof row[2] === 'number' ? row[2] as number : 0;
              const meta = MOOD_DISPLAY_META[mood] || { gradient: 'from-gray-500 to-gray-600', emoji: '❓' };
              
              return (
                <div
                  key={index}
                  className={`bg-gradient-to-br ${meta.gradient} rounded-xl p-6 shadow-xl`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-3xl">{meta.emoji}</span>
                    <span className="text-2xl font-bold text-white">{percentuale.toFixed(1)}%</span>
                  </div>
                  <div className="text-white/90 font-medium capitalize">{mood}</div>
                  <div className="text-white/70 text-sm mt-1">
                    {conteggio.toLocaleString()} canzoni
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Mood per settimana/giorno */}
      {(shouldShowDailyData ? moodPerDayChartData : moodPerWeekChartData) && (
        <div className="space-y-4">
          <h3 className="text-xl font-bold text-green-400 flex items-center gap-2">
            <span>📅</span> Mood {shouldShowDailyData ? 'per giorno' : 'per settimana'}
          </h3>
          {shouldShowDailyData ? (
            moodPerDayChartData && (
              <MultiLinePlot
                title="Distribuzione mood per giorno"
                data={moodPerDayChartData}
                yUnit="percentuale (%)"
                yColumns={MOOD_PERCENT_COLUMN_ORDER}
                seriesColors={MOOD_PERCENT_COLORS}
              />
            )
          ) : (
            moodPerWeekChartData && (
              <MultiLinePlot
                title="Distribuzione mood per settimana"
                data={moodPerWeekChartData}
                yUnit="percentuale (%)"
                yColumns={MOOD_PERCENT_COLUMN_ORDER}
                seriesColors={MOOD_PERCENT_COLORS}
              />
            )
          )}
        </div>
      )}

      {/* Mood per mese */}
      {moodPerMonthChartData && (
        <div className="space-y-4">
          <h3 className="text-xl font-bold text-green-400 flex items-center gap-2">
            <span>📆</span> Mood per mese
          </h3>
          <MultiLinePlot
            title="Distribuzione mood per mese"
            data={moodPerMonthChartData}
            yUnit="percentuale (%)"
            yColumns={MOOD_PERCENT_COLUMN_ORDER}
            seriesColors={MOOD_PERCENT_COLORS}
          />
        </div>
      )}

      {/* Mood per giorno della settimana */}
      {moodPerDayOfWeek && (
        <div className="space-y-4">
          <h3 className="text-xl font-bold text-green-400 flex items-center gap-2">
            <span>🗓️</span> Mood per giorno della settimana
          </h3>
          <DataTable
            title="Distribuzione del mood per giorno della settimana"
            data={moodPerDayOfWeek}
          />
        </div>
      )}

      {/* Indicatore di caricamento statistiche avanzate */}
      {isLoadingAdvancedStats && (
        <div className="bg-gradient-to-br from-blue-900/30 to-indigo-900/30 border border-blue-700/50 rounded-xl p-6">
          <div className="flex items-center gap-3">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-400 border-t-transparent"></div>
            <div className="flex-1">
              <p className="text-blue-200 font-semibold text-lg">
                📊 Calcolo statistiche avanzate...
              </p>
              <p className="text-blue-400 text-sm mt-1">
                Elaborazione di {getSavedMoodResultsCount()} risultati per generare statistiche dettagliate
              </p>
              <div className="mt-3 bg-blue-900/30 rounded-full h-2 overflow-hidden">
                <div className="bg-gradient-to-r from-blue-500 to-indigo-500 h-2 rounded-full animate-pulse"></div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Statistiche avanzate sulle canzoni */}
      {advancedStats && advancedStats.overallStats.totalTracks > 0 && (
        <div className="space-y-8">
          {/* Statistiche generali */}
          <div className="space-y-4">
            <h3 className="text-xl font-bold text-green-400 flex items-center gap-2">
              <span>📈</span> Statistiche generali avanzate
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-gradient-to-br from-purple-900/30 to-purple-800/30 border border-purple-700/50 rounded-xl p-4">
                <div className="text-purple-300 text-sm mb-1">Valence media</div>
                <div className="text-2xl font-bold text-white">
                  {(advancedStats.overallStats.avgValence * 100).toFixed(1)}%
                </div>
                <div className="text-purple-400 text-xs mt-1">
                  {advancedStats.overallStats.avgValence > 0.6 ? '😊 Felice' : 
                   advancedStats.overallStats.avgValence > 0.4 ? '😐 Neutrale' : '😢 Triste'}
                </div>
              </div>
              <div className="bg-gradient-to-br from-orange-900/30 to-orange-800/30 border border-orange-700/50 rounded-xl p-4">
                <div className="text-orange-300 text-sm mb-1">Energy media</div>
                <div className="text-2xl font-bold text-white">
                  {(advancedStats.overallStats.avgEnergy * 100).toFixed(1)}%
                </div>
                <div className="text-orange-400 text-xs mt-1">
                  {advancedStats.overallStats.avgEnergy > 0.7 ? '⚡ Molto energetica' : 
                   advancedStats.overallStats.avgEnergy > 0.4 ? '🔋 Moderata' : '🌙 Calma'}
                </div>
              </div>
              <div className="bg-gradient-to-br from-pink-900/30 to-pink-800/30 border border-pink-700/50 rounded-xl p-4">
                <div className="text-pink-300 text-sm mb-1">Danceability media</div>
                <div className="text-2xl font-bold text-white">
                  {(advancedStats.overallStats.avgDanceability * 100).toFixed(1)}%
                </div>
                <div className="text-pink-400 text-xs mt-1">
                  {advancedStats.overallStats.avgDanceability > 0.7 ? '💃 Molto ballabile' : 
                   advancedStats.overallStats.avgDanceability > 0.4 ? '🎵 Moderata' : '🎼 Poco ballabile'}
                </div>
              </div>
              <div className="bg-gradient-to-br from-blue-900/30 to-blue-800/30 border border-blue-700/50 rounded-xl p-4">
                <div className="text-blue-300 text-sm mb-1">Totale canzoni</div>
                <div className="text-2xl font-bold text-white">
                  {advancedStats.overallStats.totalTracks.toLocaleString()}
                </div>
                <div className="text-blue-400 text-xs mt-1">analizzate</div>
              </div>
            </div>
          </div>

          {/* Canzoni estreme */}
          <div className="space-y-4">
            <h3 className="text-xl font-bold text-green-400 flex items-center gap-2">
              <span>⭐</span> Canzoni estreme
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-gradient-to-br from-green-900/30 to-emerald-900/30 border border-green-700/50 rounded-xl p-4">
                <div className="text-green-200 font-semibold mb-3 flex items-center gap-2">
                  <span>😊</span> Canzone più felice
                </div>
                {advancedStats.extremeMoods.happiest && (
                  <div>
                    <div className="text-white font-bold text-lg">
                      {advancedStats.extremeMoods.happiest.track}
                    </div>
                    <div className="text-green-300 text-sm mt-1">
                      {advancedStats.extremeMoods.happiest.artist}
                    </div>
                    <div className="mt-3 flex items-center gap-4 text-sm">
                      <span className="text-green-400">
                        Valence: <strong>{(advancedStats.extremeMoods.happiest.valence! * 100).toFixed(1)}%</strong>
                      </span>
                      {advancedStats.extremeMoods.happiest.energy !== null && advancedStats.extremeMoods.happiest.energy !== undefined && (
                        <span className="text-orange-400">
                          Energy: <strong>{(advancedStats.extremeMoods.happiest.energy * 100).toFixed(1)}%</strong>
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <div className="bg-gradient-to-br from-blue-900/30 to-indigo-900/30 border border-blue-700/50 rounded-xl p-4">
                <div className="text-blue-200 font-semibold mb-3 flex items-center gap-2">
                  <span>😢</span> Canzone più triste
                </div>
                {advancedStats.extremeMoods.saddest && (
                  <div>
                    <div className="text-white font-bold text-lg">
                      {advancedStats.extremeMoods.saddest.track}
                    </div>
                    <div className="text-blue-300 text-sm mt-1">
                      {advancedStats.extremeMoods.saddest.artist}
                    </div>
                    <div className="mt-3 flex items-center gap-4 text-sm">
                      <span className="text-blue-400">
                        Valence: <strong>{(advancedStats.extremeMoods.saddest.valence! * 100).toFixed(1)}%</strong>
                      </span>
                      {advancedStats.extremeMoods.saddest.energy !== null && advancedStats.extremeMoods.saddest.energy !== undefined && (
                        <span className="text-orange-400">
                          Energy: <strong>{(advancedStats.extremeMoods.saddest.energy * 100).toFixed(1)}%</strong>
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <div className="bg-gradient-to-br from-orange-900/30 to-red-900/30 border border-orange-700/50 rounded-xl p-4">
                <div className="text-orange-200 font-semibold mb-3 flex items-center gap-2">
                  <span>⚡</span> Canzone più energetica
                </div>
                {advancedStats.extremeMoods.mostEnergetic && advancedStats.extremeMoods.mostEnergetic.energy !== null && (
                  <div>
                    <div className="text-white font-bold text-lg">
                      {advancedStats.extremeMoods.mostEnergetic.track}
                    </div>
                    <div className="text-orange-300 text-sm mt-1">
                      {advancedStats.extremeMoods.mostEnergetic.artist}
                    </div>
                    <div className="mt-3 flex items-center gap-4 text-sm">
                      <span className="text-orange-400">
                        Energy: <strong>{(advancedStats.extremeMoods.mostEnergetic.energy! * 100).toFixed(1)}%</strong>
                      </span>
                      <span className="text-green-400">
                        Valence: <strong>{(advancedStats.extremeMoods.mostEnergetic.valence! * 100).toFixed(1)}%</strong>
                      </span>
                    </div>
                  </div>
                )}
              </div>
              <div className="bg-gradient-to-br from-pink-900/30 to-rose-900/30 border border-pink-700/50 rounded-xl p-4">
                <div className="text-pink-200 font-semibold mb-3 flex items-center gap-2">
                  <span>💃</span> Canzone più ballabile
                </div>
                {advancedStats.extremeMoods.mostDanceable && advancedStats.extremeMoods.mostDanceable.danceability !== null && (
                  <div>
                    <div className="text-white font-bold text-lg">
                      {advancedStats.extremeMoods.mostDanceable.track}
                    </div>
                    <div className="text-pink-300 text-sm mt-1">
                      {advancedStats.extremeMoods.mostDanceable.artist}
                    </div>
                    <div className="mt-3 flex items-center gap-4 text-sm">
                      <span className="text-pink-400">
                        Danceability: <strong>{(advancedStats.extremeMoods.mostDanceable.danceability! * 100).toFixed(1)}%</strong>
                      </span>
                      <span className="text-green-400">
                        Valence: <strong>{(advancedStats.extremeMoods.mostDanceable.valence! * 100).toFixed(1)}%</strong>
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Top 10 canzoni più felici */}
          {advancedStats.topHappiest.length > 0 && (
            <div className="space-y-4">
              <h3 className="text-xl font-bold text-green-400 flex items-center gap-2">
                <span>😊</span> Top 10 canzoni più felici
              </h3>
              <div className="bg-gradient-to-br from-green-900/20 to-emerald-900/20 border border-green-700/30 rounded-xl p-4">
                <div className="space-y-2">
                  {advancedStats.topHappiest.map((song, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between p-3 bg-green-900/20 rounded-lg hover:bg-green-900/30 transition-colors"
                    >
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <div className="text-green-400 font-bold text-lg w-8 flex-shrink-0">
                          #{index + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-white font-semibold truncate">{song.track}</div>
                          <div className="text-green-300 text-sm truncate">{song.artist}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 ml-4 flex-shrink-0">
                        <div className="text-right">
                          <div className="text-green-400 font-bold">
                            {(song.valence! * 100).toFixed(1)}%
                          </div>
                          <div className="text-green-500 text-xs">valence</div>
                        </div>
                        {song.energy !== null && song.energy !== undefined && (
                          <div className="text-right">
                            <div className="text-orange-400 font-bold">
                              {(song.energy * 100).toFixed(1)}%
                            </div>
                            <div className="text-orange-500 text-xs">energy</div>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Top 10 canzoni più tristi */}
          {advancedStats.topSaddest.length > 0 && (
            <div className="space-y-4">
              <h3 className="text-xl font-bold text-blue-400 flex items-center gap-2">
                <span>😢</span> Top 10 canzoni più tristi
              </h3>
              <div className="bg-gradient-to-br from-blue-900/20 to-indigo-900/20 border border-blue-700/30 rounded-xl p-4">
                <div className="space-y-2">
                  {advancedStats.topSaddest.map((song, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between p-3 bg-blue-900/20 rounded-lg hover:bg-blue-900/30 transition-colors"
                    >
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <div className="text-blue-400 font-bold text-lg w-8 flex-shrink-0">
                          #{index + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-white font-semibold truncate">{song.track}</div>
                          <div className="text-blue-300 text-sm truncate">{song.artist}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 ml-4 flex-shrink-0">
                        <div className="text-right">
                          <div className="text-blue-400 font-bold">
                            {(song.valence! * 100).toFixed(1)}%
                          </div>
                          <div className="text-blue-500 text-xs">valence</div>
                        </div>
                        {song.energy !== null && song.energy !== undefined && (
                          <div className="text-right">
                            <div className="text-orange-400 font-bold">
                              {(song.energy * 100).toFixed(1)}%
                            </div>
                            <div className="text-orange-500 text-xs">energy</div>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Top 10 canzoni più energetiche */}
          {advancedStats.topEnergetic.length > 0 && (
            <div className="space-y-4">
              <h3 className="text-xl font-bold text-orange-400 flex items-center gap-2">
                <span>⚡</span> Top 10 canzoni più energetiche
              </h3>
              <div className="bg-gradient-to-br from-orange-900/20 to-red-900/20 border border-orange-700/30 rounded-xl p-4">
                <div className="space-y-2">
                  {advancedStats.topEnergetic.map((song, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between p-3 bg-orange-900/20 rounded-lg hover:bg-orange-900/30 transition-colors"
                    >
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <div className="text-orange-400 font-bold text-lg w-8 flex-shrink-0">
                          #{index + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-white font-semibold truncate">{song.track}</div>
                          <div className="text-orange-300 text-sm truncate">{song.artist}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 ml-4 flex-shrink-0">
                        <div className="text-right">
                          <div className="text-orange-400 font-bold">
                            {(song.energy! * 100).toFixed(1)}%
                          </div>
                          <div className="text-orange-500 text-xs">energy</div>
                        </div>
                        <div className="text-right">
                          <div className="text-green-400 font-bold">
                            {(song.valence! * 100).toFixed(1)}%
                          </div>
                          <div className="text-green-500 text-xs">valence</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Top 10 canzoni più ballabili */}
          {advancedStats.topDanceable.length > 0 && (
            <div className="space-y-4">
              <h3 className="text-xl font-bold text-pink-400 flex items-center gap-2">
                <span>💃</span> Top 10 canzoni più ballabili
              </h3>
              <div className="bg-gradient-to-br from-pink-900/20 to-rose-900/20 border border-pink-700/30 rounded-xl p-4">
                <div className="space-y-2">
                  {advancedStats.topDanceable.map((song, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between p-3 bg-pink-900/20 rounded-lg hover:bg-pink-900/30 transition-colors"
                    >
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <div className="text-pink-400 font-bold text-lg w-8 flex-shrink-0">
                          #{index + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-white font-semibold truncate">{song.track}</div>
                          <div className="text-pink-300 text-sm truncate">{song.artist}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 ml-4 flex-shrink-0">
                        <div className="text-right">
                          <div className="text-pink-400 font-bold">
                            {(song.danceability! * 100).toFixed(1)}%
                          </div>
                          <div className="text-pink-500 text-xs">danceability</div>
                        </div>
                        <div className="text-right">
                          <div className="text-green-400 font-bold">
                            {(song.valence! * 100).toFixed(1)}%
                          </div>
                          <div className="text-green-500 text-xs">valence</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Statistiche per artista */}
          {advancedStats.artistStats.length > 0 && (
            <div className="space-y-4">
              <h3 className="text-xl font-bold text-green-400 flex items-center gap-2">
                <span>🎤</span> Statistiche per artista (Top 20)
              </h3>
              <div className="bg-gradient-to-br from-purple-900/20 to-indigo-900/20 border border-purple-700/30 rounded-xl p-4">
                <div className="space-y-3">
                  {advancedStats.artistStats.map((artist, index) => (
                    <div
                      key={index}
                      className="p-4 bg-purple-900/20 rounded-lg hover:bg-purple-900/30 transition-colors"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <div className="text-purple-400 font-bold text-lg">
                            #{index + 1}
                          </div>
                          <div>
                            <div className="text-white font-bold text-lg">{artist.artist}</div>
                            <div className="text-purple-300 text-sm">
                              {artist.trackCount} {artist.trackCount === 1 ? 'canzone' : 'canzoni'}
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
                        <div className="bg-green-900/20 rounded p-2">
                          <div className="text-green-400 text-xs mb-1">Valence media</div>
                          <div className="text-white font-bold">
                            {(artist.avgValence * 100).toFixed(1)}%
                          </div>
                        </div>
                        <div className="bg-orange-900/20 rounded p-2">
                          <div className="text-orange-400 text-xs mb-1">Energy media</div>
                          <div className="text-white font-bold">
                            {(artist.avgEnergy * 100).toFixed(1)}%
                          </div>
                        </div>
                        <div className="bg-pink-900/20 rounded p-2">
                          <div className="text-pink-400 text-xs mb-1">Danceability media</div>
                          <div className="text-white font-bold">
                            {(artist.avgDanceability * 100).toFixed(1)}%
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                        {artist.moodDistribution.euforico > 0 && (
                          <span className="text-yellow-400">
                            🎉 {artist.moodDistribution.euforico} euforici
                          </span>
                        )}
                        {artist.moodDistribution.sereno > 0 && (
                          <span className="text-green-400">
                            😊 {artist.moodDistribution.sereno} sereni
                          </span>
                        )}
                        {artist.moodDistribution.arrabbiato > 0 && (
                          <span className="text-orange-400">
                            😠 {artist.moodDistribution.arrabbiato} arrabbiati
                          </span>
                        )}
                        {artist.moodDistribution.malinconico > 0 && (
                          <span className="text-blue-400">
                            😢 {artist.moodDistribution.malinconico} malinconici
                          </span>
                        )}
                        {artist.moodDistribution.neutrale > 0 && (
                          <span className="text-gray-400">
                            😐 {artist.moodDistribution.neutrale} neutri
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Distribuzione delle features */}
          {advancedStats.featureDistribution.valence.length > 0 && (
            <div className="space-y-4">
              <h3 className="text-xl font-bold text-green-400 flex items-center gap-2">
                <span>📊</span> Distribuzione delle audio features
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {advancedStats.featureDistribution.valence.length > 0 && (
                  <div className="bg-gradient-to-br from-green-900/20 to-emerald-900/20 border border-green-700/30 rounded-xl p-4">
                    <h4 className="text-green-300 font-semibold mb-3">Distribuzione Valence</h4>
                    <div className="space-y-1">
                      {[0, 0.2, 0.4, 0.6, 0.8, 1.0].map((threshold, i) => {
                        const count = advancedStats.featureDistribution.valence.filter(
                          v => v >= threshold && (i === 5 || v < [0.2, 0.4, 0.6, 0.8, 1.0, 1.1][i])
                        ).length;
                        const percent = (count / advancedStats.featureDistribution.valence.length) * 100;
                        return (
                          <div key={i} className="flex items-center justify-between text-sm">
                            <span className="text-green-300">
                              {threshold === 0 ? '0.0-0.2' :
                               threshold === 0.2 ? '0.2-0.4' :
                               threshold === 0.4 ? '0.4-0.6' :
                               threshold === 0.6 ? '0.6-0.8' :
                               threshold === 0.8 ? '0.8-1.0' : '1.0'}
                            </span>
                            <div className="flex items-center gap-2 flex-1 mx-2">
                              <div className="flex-1 bg-green-900/30 rounded-full h-2 overflow-hidden">
                                <div
                                  className="bg-green-500 h-2 rounded-full transition-all"
                                  style={{ width: `${percent}%` }}
                                />
                              </div>
                              <span className="text-green-400 font-semibold w-12 text-right">
                                {percent.toFixed(1)}%
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {advancedStats.featureDistribution.energy.length > 0 && (
                  <div className="bg-gradient-to-br from-orange-900/20 to-red-900/20 border border-orange-700/30 rounded-xl p-4">
                    <h4 className="text-orange-300 font-semibold mb-3">Distribuzione Energy</h4>
                    <div className="space-y-1">
                      {[0, 0.2, 0.4, 0.6, 0.8, 1.0].map((threshold, i) => {
                        const count = advancedStats.featureDistribution.energy.filter(
                          e => e >= threshold && (i === 5 || e < [0.2, 0.4, 0.6, 0.8, 1.0, 1.1][i])
                        ).length;
                        const percent = (count / advancedStats.featureDistribution.energy.length) * 100;
                        return (
                          <div key={i} className="flex items-center justify-between text-sm">
                            <span className="text-orange-300">
                              {threshold === 0 ? '0.0-0.2' :
                               threshold === 0.2 ? '0.2-0.4' :
                               threshold === 0.4 ? '0.4-0.6' :
                               threshold === 0.6 ? '0.6-0.8' :
                               threshold === 0.8 ? '0.8-1.0' : '1.0'}
                            </span>
                            <div className="flex items-center gap-2 flex-1 mx-2">
                              <div className="flex-1 bg-orange-900/30 rounded-full h-2 overflow-hidden">
                                <div
                                  className="bg-orange-500 h-2 rounded-full transition-all"
                                  style={{ width: `${percent}%` }}
                                />
                              </div>
                              <span className="text-orange-400 font-semibold w-12 text-right">
                                {percent.toFixed(1)}%
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {advancedStats.featureDistribution.danceability.length > 0 && (
                  <div className="bg-gradient-to-br from-pink-900/20 to-rose-900/20 border border-pink-700/30 rounded-xl p-4">
                    <h4 className="text-pink-300 font-semibold mb-3">Distribuzione Danceability</h4>
                    <div className="space-y-1">
                      {[0, 0.2, 0.4, 0.6, 0.8, 1.0].map((threshold, i) => {
                        const count = advancedStats.featureDistribution.danceability.filter(
                          d => d >= threshold && (i === 5 || d < [0.2, 0.4, 0.6, 0.8, 1.0, 1.1][i])
                        ).length;
                        const percent = (count / advancedStats.featureDistribution.danceability.length) * 100;
                        return (
                          <div key={i} className="flex items-center justify-between text-sm">
                            <span className="text-pink-300">
                              {threshold === 0 ? '0.0-0.2' :
                               threshold === 0.2 ? '0.2-0.4' :
                               threshold === 0.4 ? '0.4-0.6' :
                               threshold === 0.6 ? '0.6-0.8' :
                               threshold === 0.8 ? '0.8-1.0' : '1.0'}
                            </span>
                            <div className="flex items-center gap-2 flex-1 mx-2">
                              <div className="flex-1 bg-pink-900/30 rounded-full h-2 overflow-hidden">
                                <div
                                  className="bg-pink-500 h-2 rounded-full transition-all"
                                  style={{ width: `${percent}%` }}
                                />
                              </div>
                              <span className="text-pink-400 font-semibold w-12 text-right">
                                {percent.toFixed(1)}%
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

