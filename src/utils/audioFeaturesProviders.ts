/**
 * Sistema multi-provider per ottenere audio features
 * Supporta Spotify, AcousticBrainz, Last.fm e altri provider
 */

import type { AudioFeatures } from './spotifyApi';
export type { AudioFeatures };

export type ProviderName = 'spotify' | 'acousticbrainz' | 'lastfm' | 'deezer';

export interface ProviderConfig {
  spotify?: {
    clientId: string;
    clientSecret: string;
  };
  lastfm?: {
    apiKey: string;
  };
  acousticbrainz?: {
    // Nessuna API key richiesta, è open source
  };
  deezer?: {
    // Deezer API potrebbe richiedere credenziali in futuro
  };
}

/**
 * Estrae l'ID del track da un URI di Spotify
 */
function extractSpotifyTrackId(uri: string): string | null {
  if (!uri || uri === 'None' || uri === '') {
    return null;
  }
  
  const parts = uri.split(':');
  if (parts.length >= 3 && parts[1] === 'track') {
    return parts[2];
  }
  
  return null;
}

/**
 * Cerca un track su MusicBrainz usando nome artista e titolo
 */
async function searchMusicBrainzTrack(artist: string, track: string): Promise<string | null> {
  try {
    // MusicBrainz API non richiede autenticazione per ricerche semplici
    const query = encodeURIComponent(`artist:"${artist}" AND recording:"${track}"`);
    const response = await fetch(
      `https://musicbrainz.org/ws/2/recording/?query=${query}&limit=1&fmt=json`,
      {
        headers: {
          'User-Agent': 'Spotify-Stats/1.0 (https://github.com/your-repo)',
        },
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    if (data.recordings && data.recordings.length > 0) {
      return data.recordings[0].id; // MusicBrainz Recording ID
    }
  } catch (error) {
    console.warn('Errore nella ricerca MusicBrainz:', error);
  }
  
  return null;
}

/**
 * Ottiene audio features da AcousticBrainz usando MusicBrainz Recording ID
 */
async function getAcousticBrainzFeatures(mbid: string): Promise<AudioFeatures | null> {
  try {
    const response = await fetch(
      `https://acousticbrainz.org/api/v1/${mbid}/low-level`,
      {
        headers: {
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    
    // AcousticBrainz ha una struttura diversa, mappiamo i valori
    if (data.mood && data.mood.valence) {
      return {
        valence: data.mood.valence.value || 0.5,
        energy: data.rhythm?.energy || data.mood?.energy?.value || undefined,
        danceability: data.rhythm?.danceability?.value || undefined,
        acousticness: data.tonal?.chords_key || undefined,
        tempo: data.rhythm?.bpm || undefined,
      };
    }
  } catch (error) {
    console.warn('Errore nel recupero AcousticBrainz:', error);
  }
  
  return null;
}

/**
 * Ottiene tag e mood da Last.fm
 */
async function getLastFmTags(artist: string, track: string, apiKey: string): Promise<AudioFeatures | null> {
  try {
    const response = await fetch(
      `https://ws.audioscrobbler.com/2.0/?method=track.gettoptags&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(track)}&api_key=${apiKey}&format=json`
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    
    if (data.toptags && data.toptags.tag) {
      const tags = data.toptags.tag.map((tag: any) => tag.name.toLowerCase());
      
      // Mappiamo i tag Last.fm a un valore di valence approssimativo
      let valence = 0.5; // Neutrale di default
      
      // Tag che indicano mood positivo
      const positiveTags = ['happy', 'upbeat', 'energetic', 'dance', 'party', 'fun', 'cheerful', 'joyful'];
      // Tag che indicano mood negativo
      const negativeTags = ['sad', 'melancholic', 'depressing', 'dark', 'somber', 'gloomy', 'melancholy'];
      
      const hasPositive = tags.some((tag: string) => positiveTags.some(pt => tag.includes(pt)));
      const hasNegative = tags.some((tag: string) => negativeTags.some(nt => tag.includes(nt)));
      
      if (hasPositive) {
        valence = 0.7;
      } else if (hasNegative) {
        valence = 0.3;
      }
      
      return {
        valence,
        // Last.fm non fornisce energy/danceability direttamente, ma possiamo inferirli dai tag
        energy: tags.some((tag: string) => ['energetic', 'fast', 'upbeat', 'intense'].some(e => tag.includes(e))) ? 0.7 : undefined,
        danceability: tags.some((tag: string) => ['dance', 'danceable', 'party'].some(d => tag.includes(d))) ? 0.7 : undefined,
      };
    }
  } catch (error) {
    console.warn('Errore nel recupero Last.fm:', error);
  }
  
  return null;
}

/**
 * Provider principale: Spotify (usa il codice esistente)
 */
async function getSpotifyFeatures(trackUri: string, config: ProviderConfig): Promise<AudioFeatures | null> {
  if (!config.spotify) {
    return null;
  }

  // Usa la funzione esistente da spotifyApi.ts
  const { getTrackAudioFeatures } = await import('./spotifyApi');
  return await getTrackAudioFeatures(trackUri);
}

/**
 * Ottiene audio features usando il provider specificato
 */
export async function getAudioFeatures(
  trackUri: string,
  artist: string,
  track: string,
  provider: ProviderName,
  config: ProviderConfig,
  onProgress?: (message: string) => void
): Promise<AudioFeatures | null> {
  try {
    switch (provider) {
      case 'spotify':
        onProgress?.('Tentativo con Spotify API...');
        return await getSpotifyFeatures(trackUri, config);
        
      case 'acousticbrainz':
        onProgress?.('Tentativo con AcousticBrainz...');
        // Prima cerchiamo il track su MusicBrainz
        const mbid = await searchMusicBrainzTrack(artist, track);
        if (mbid) {
          return await getAcousticBrainzFeatures(mbid);
        }
        return null;
        
      case 'lastfm':
        onProgress?.('Tentativo con Last.fm...');
        if (!config.lastfm?.apiKey) {
          throw new Error('Last.fm API key non configurata');
        }
        return await getLastFmTags(artist, track, config.lastfm.apiKey);
        
      case 'deezer':
        // Deezer API non è ancora implementata
        onProgress?.('Deezer API non ancora supportata');
        return null;
        
      default:
        return null;
    }
  } catch (error: any) {
    console.warn(`Errore con provider ${provider}:`, error.message);
    return null;
  }
}

/**
 * Ottiene audio features provando più provider in sequenza fino a trovarne uno che funziona
 */
export async function getAudioFeaturesWithFallback(
  trackUri: string,
  artist: string,
  track: string,
  providers: ProviderName[],
  config: ProviderConfig,
  onProgress?: (message: string) => void
): Promise<AudioFeatures | null> {
  for (const provider of providers) {
    const features = await getAudioFeatures(trackUri, artist, track, provider, config, onProgress);
    if (features) {
      return features;
    }
  }
  
  return null;
}

/**
 * Ottiene audio features per più track usando il provider specificato
 */
export async function getTracksAudioFeaturesMultiProvider(
  tracks: Array<{ uri: string; artist: string; track: string }>,
  providers: ProviderName[],
  config: ProviderConfig,
  onProgress?: (current: number, total: number, provider?: string) => void
): Promise<Map<string, AudioFeatures>> {
  const featuresMap = new Map<string, AudioFeatures>();
  
  for (let i = 0; i < tracks.length; i++) {
    const { uri, artist, track } = tracks[i];
    
    // Prova i provider in ordine
    let features: AudioFeatures | null = null;
    let usedProvider: string | undefined;
    
    for (const provider of providers) {
      try {
        features = await getAudioFeatures(uri, artist, track, provider, config, (msg) => {
          onProgress?.(i + 1, tracks.length, `${provider}: ${msg}`);
        });
        
        if (features) {
          usedProvider = provider;
          break;
        }
      } catch (error) {
        // Continua con il prossimo provider
        continue;
      }
    }
    
    if (features) {
      featuresMap.set(uri, features);
    }
    
    onProgress?.(i + 1, tracks.length, usedProvider);
    
    // Rate limiting: aspetta un po' tra le richieste per evitare di sovraccaricare le API
    if (i < tracks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  return featuresMap;
}

