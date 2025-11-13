/**
 * Utility per ottenere le audio features da AcousticBrainz
 * AcousticBrainz è un database open source che non richiede API key
 */

export interface AudioFeatures {
  valence: number; // 0.0 - 1.0 (triste -> felice)
  energy?: number; // 0.0 - 1.0
  danceability?: number; // 0.0 - 1.0
  acousticness?: number; // 0.0 - 1.0
  tempo?: number;
}

// AbortController globale per interrompere le richieste
let globalAbortController: AbortController | null = null;

/**
 * Crea un nuovo AbortController per le richieste
 */
function createAbortController(): AbortController {
  // Se c'è già un controller, interrompilo
  if (globalAbortController) {
    globalAbortController.abort();
  }
  globalAbortController = new AbortController();
  return globalAbortController;
}

/**
 * Interrompe tutte le richieste in corso
 */
export function abortAllRequests(): void {
  if (globalAbortController) {
    globalAbortController.abort();
    globalAbortController = null;
  }
}

/**
 * Usa un proxy CORS per fare richieste a API che non supportano CORS
 */
async function fetchWithCorsProxy(url: string, options: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  // Controlla se è stato cancellato prima di fare la richiesta
  if (isCancelled() || signal?.aborted) {
    throw new Error('Richiesta cancellata');
  }
  
  // Usa un proxy CORS pubblico
  // AllOrigins è un servizio gratuito che permette di bypassare CORS
  // Nota: gli header personalizzati potrebbero non essere passati correttamente
  const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
  
  try {
    const response = await fetch(proxyUrl, {
      method: 'GET', // AllOrigins supporta solo GET
      signal: signal,
      headers: {
        // Rimuoviamo gli header personalizzati perché il proxy potrebbe non passarli
      },
    });
    
    // Controlla di nuovo dopo la richiesta
    if (isCancelled() || signal?.aborted) {
      throw new Error('Richiesta cancellata');
    }
    
    return response;
  } catch (error: any) {
    // Se è stato cancellato, rilancia l'errore
    if (isCancelled() || signal?.aborted || error.name === 'AbortError') {
      throw new Error('Richiesta cancellata');
    }
    
    // Se AllOrigins fallisce, prova con un altro proxy
    console.warn('AllOrigins proxy fallito, provo con corsproxy.io...');
    const fallbackProxyUrl = `https://corsproxy.io/?${encodeURIComponent(url)}`;
    const response = await fetch(fallbackProxyUrl, {
      method: 'GET',
      signal: signal,
    });
    
    if (isCancelled() || signal?.aborted) {
      throw new Error('Richiesta cancellata');
    }
    
    return response;
  }
}

/**
 * Cerca un track su MusicBrainz usando nome artista e titolo
 * Restituisce il MusicBrainz Recording ID (MBID) se trovato
 */
async function searchMusicBrainzTrack(artist: string, track: string, signal?: AbortSignal): Promise<string | null> {
  try {
    // Controlla se è stato cancellato
    if (isCancelled() || signal?.aborted) {
      return null;
    }
    
    // MusicBrainz API non richiede autenticazione per ricerche semplici
    // User-Agent è richiesto dalle loro policy
    const query = encodeURIComponent(`artist:"${artist}" AND recording:"${track}"`);
    const url = `https://musicbrainz.org/ws/2/recording/?query=${query}&limit=1&fmt=json`;
    
    const response = await fetchWithCorsProxy(url, {
      headers: {
        'User-Agent': 'Spotify-Stats/1.0 (https://github.com)',
      },
    }, signal);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    if (data.recordings && data.recordings.length > 0) {
      return data.recordings[0].id; // MusicBrainz Recording ID
    }
  } catch (error: any) {
    if (error.message === 'Richiesta cancellata' || isCancelled()) {
      return null;
    }
    console.warn(`Errore nella ricerca MusicBrainz per "${artist}" - "${track}":`, error);
  }
  
  return null;
}

/**
 * Ottiene audio features da AcousticBrainz usando MusicBrainz Recording ID
 */
async function getAcousticBrainzFeatures(mbid: string, signal?: AbortSignal): Promise<AudioFeatures | null> {
  try {
    // Controlla se è stato cancellato
    if (isCancelled() || signal?.aborted) {
      return null;
    }
    
    const url = `https://acousticbrainz.org/api/v1/${mbid}/low-level`;
    const response = await fetchWithCorsProxy(url, {
      headers: {
        'Accept': 'application/json',
      },
    }, signal);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    
    // AcousticBrainz ha una struttura diversa, mappiamo i valori
    // La struttura può variare, quindi controlliamo diverse possibili posizioni
    let valence: number | undefined;
    let energy: number | undefined;
    let danceability: number | undefined;
    let tempo: number | undefined;
    
    // Prova diverse strutture di dati AcousticBrainz
    if (data.mood && data.mood.valence) {
      valence = data.mood.valence.value;
    } else if (data.mood && typeof data.mood.valence === 'number') {
      valence = data.mood.valence;
    }
    
    if (data.rhythm && data.rhythm.energy) {
      energy = data.rhythm.energy;
    } else if (data.mood && data.mood.energy) {
      if (data.mood.energy.value !== undefined) {
        energy = data.mood.energy.value;
      } else if (typeof data.mood.energy === 'number') {
        energy = data.mood.energy;
      }
    }
    
    if (data.rhythm && data.rhythm.danceability) {
      if (data.rhythm.danceability.value !== undefined) {
        danceability = data.rhythm.danceability.value;
      } else if (typeof data.rhythm.danceability === 'number') {
        danceability = data.rhythm.danceability;
      }
    }
    
    if (data.rhythm && data.rhythm.bpm) {
      tempo = data.rhythm.bpm;
    }
    
    // Se abbiamo almeno valence, restituiamo le features
    if (valence !== undefined) {
      return {
        valence,
        energy,
        danceability,
        tempo,
      };
    }
  } catch (error: any) {
    if (error.message === 'Richiesta cancellata' || isCancelled()) {
      return null;
    }
    console.warn(`Errore nel recupero AcousticBrainz per MBID ${mbid}:`, error);
  }
  
  return null;
}

/**
 * Ottiene audio features per un singolo track usando AcousticBrainz
 */
export async function getTrackAudioFeatures(
  artist: string,
  track: string,
  signal?: AbortSignal
): Promise<AudioFeatures | null> {
  // Controlla se è stato cancellato
  if (isCancelled() || signal?.aborted) {
    return null;
  }
  
  // Prima cerchiamo il track su MusicBrainz
  const mbid = await searchMusicBrainzTrack(artist, track, signal);
  
  if (!mbid || isCancelled() || signal?.aborted) {
    return null;
  }
  
  // Poi otteniamo le features da AcousticBrainz
  return await getAcousticBrainzFeatures(mbid, signal);
}

/**
 * Cache locale per le audio features già ottenute
 */
const audioFeaturesCache = new Map<string, AudioFeatures>();

/**
 * Salva la cache nel localStorage
 */
function saveCacheToStorage() {
  try {
    const cacheObj: Record<string, AudioFeatures> = {};
    audioFeaturesCache.forEach((features, key) => {
      cacheObj[key] = features;
    });
    localStorage.setItem('audio_features_cache', JSON.stringify(cacheObj));
  } catch (e) {
    // Ignora errori se localStorage è pieno
  }
}

/**
 * Carica la cache dal localStorage
 */
function loadCacheFromStorage() {
  try {
    const cacheStr = localStorage.getItem('audio_features_cache');
    if (cacheStr) {
      const cacheObj = JSON.parse(cacheStr);
      Object.entries(cacheObj).forEach(([key, features]) => {
        audioFeaturesCache.set(key, features as AudioFeatures);
      });
    }
  } catch (e) {
    // Ignora errori
  }
}

// Carica la cache all'avvio
loadCacheFromStorage();

/**
 * Controlla se il caricamento è stato cancellato
 */
export function isCancelled(): boolean {
  try {
    return localStorage.getItem('audio_features_cancelled') === 'true';
  } catch (e) {
    return false;
  }
}

/**
 * Imposta il flag di cancellazione
 */
export function cancelAudioFeaturesLoad(): void {
  try {
    localStorage.setItem('audio_features_cancelled', 'true');
    // Interrompi anche tutte le richieste HTTP in corso
    abortAllRequests();
  } catch (e) {
    // Ignora errori
  }
}

/**
 * Rimuove il flag di cancellazione
 */
function clearCancellationFlag(): void {
  try {
    localStorage.removeItem('audio_features_cancelled');
  } catch (e) {
    // Ignora errori
  }
}

/**
 * Ottiene audio features per più track usando AcousticBrainz
 * Ottimizzato con richieste parallele e cache locale
 */
export async function getTracksAudioFeatures(
  tracks: Array<{ artist: string; track: string; key: string }>,
  onProgress?: (current: number, total: number) => void
): Promise<Map<string, AudioFeatures>> {
  // Rimuovi il flag di cancellazione all'inizio
  clearCancellationFlag();
  
  // Crea un nuovo AbortController per questo caricamento
  const abortController = createAbortController();
  const signal = abortController.signal;
  
  const featuresMap = new Map<string, AudioFeatures>();
  const batchSize = 5; // Processa 5 track in parallelo
  const delayBetweenBatches = 50; // 50ms tra i batch invece di 200ms per track
  
  // Prima controlla la cache
  let cachedCount = 0;
  const tracksToFetch: Array<{ artist: string; track: string; key: string; index: number }> = [];
  
  tracks.forEach((track, index) => {
    // Controlla se è stato cancellato
    if (isCancelled() || signal.aborted) {
      return;
    }
    
    const cached = audioFeaturesCache.get(track.key);
    if (cached) {
      featuresMap.set(track.key, cached);
      cachedCount++;
    } else {
      tracksToFetch.push({ ...track, index });
    }
  });
  
  if (onProgress && !isCancelled() && !signal.aborted) {
    onProgress(cachedCount, tracks.length);
  }
  
  // Processa i track rimanenti in batch paralleli
  for (let i = 0; i < tracksToFetch.length; i += batchSize) {
    // Controlla se è stato cancellato prima di ogni batch
    if (isCancelled() || signal.aborted) {
      console.log('Caricamento audio features cancellato dall\'utente');
      break;
    }
    
    const batch = tracksToFetch.slice(i, i + batchSize);
    
    // Esegui tutte le richieste del batch in parallelo
    const promises = batch.map(async ({ artist, track, key }) => {
      // Controlla anche durante le richieste
      if (isCancelled() || signal.aborted) {
        return { success: false, key, cancelled: true };
      }
      
      try {
        const features = await getTrackAudioFeatures(artist, track, signal);
        
        // Controlla di nuovo dopo la richiesta
        if (isCancelled() || signal.aborted) {
          return { success: false, key, cancelled: true };
        }
        
        if (features) {
          featuresMap.set(key, features);
          audioFeaturesCache.set(key, features); // Salva in cache
        }
        return { success: true, key };
      } catch (error: any) {
        if (error.message === 'Richiesta cancellata' || isCancelled() || signal.aborted) {
          return { success: false, key, cancelled: true };
        }
        console.warn(`Errore per "${artist}" - "${track}":`, error);
        return { success: false, key };
      }
    });
    
    // Aspetta che tutte le richieste del batch siano completate
    await Promise.all(promises);
    
    // Controlla di nuovo dopo il batch
    if (isCancelled() || signal.aborted) {
      console.log('Caricamento audio features cancellato dall\'utente');
      break;
    }
    
    // Aggiorna il progresso
    const current = cachedCount + Math.min(i + batchSize, tracksToFetch.length);
    if (onProgress && !isCancelled() && !signal.aborted) {
      onProgress(current, tracks.length);
    }
    
    // Salva la cache periodicamente (ogni 10 batch)
    if ((i / batchSize) % 10 === 0 && !isCancelled() && !signal.aborted) {
      saveCacheToStorage();
    }
    
    // Piccolo delay tra i batch per non sovraccaricare le API
    // Durante il delay, controlla periodicamente se è stato cancellato
    if (i + batchSize < tracksToFetch.length) {
      const delayPromise = new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (isCancelled() || signal.aborted) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 10); // Controlla ogni 10ms
        
        setTimeout(() => {
          clearInterval(checkInterval);
          resolve();
        }, delayBetweenBatches);
      });
      
      await delayPromise;
      
      // Se è stato cancellato durante il delay, esci
      if (isCancelled() || signal.aborted) {
        break;
      }
    }
  }
  
  // Salva la cache finale solo se non è stato cancellato
  if (!isCancelled() && !signal.aborted) {
    saveCacheToStorage();
  }
  
  // Rimuovi il flag di cancellazione alla fine
  clearCancellationFlag();
  
  return featuresMap;
}

