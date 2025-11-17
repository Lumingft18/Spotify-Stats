/**
 * Utility per ottenere le audio features di Spotify
 * Richiede Client ID e Client Secret di Spotify
 */

export interface AudioFeatures {
  valence: number; // 0.0 - 1.0 (triste -> felice)
  energy?: number; // 0.0 - 1.0
  danceability?: number; // 0.0 - 1.0
  acousticness?: number; // 0.0 - 1.0
  instrumentalness?: number; // 0.0 - 1.0
  liveness?: number; // 0.0 - 1.0
  speechiness?: number; // 0.0 - 1.0
  tempo?: number;
  key?: number;
  mode?: number;
  time_signature?: number;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface SpotifyAudioFeatures extends AudioFeatures {
  energy: number;
  danceability: number;
  acousticness: number;
  instrumentalness: number;
  liveness: number;
  speechiness: number;
  tempo: number;
  key: number;
  mode: number;
  time_signature: number;
}

interface SpotifyTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

let accessToken: string | null = null;
let tokenExpiry: number = 0;

const SPOTIFY_CREDENTIALS_KEY = 'spotify_api_credentials';

function loadSpotifyCredentials(): { clientId: string; clientSecret: string } | null {
  try {
    const saved = localStorage.getItem(SPOTIFY_CREDENTIALS_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (error) {
    console.error('Errore nel caricamento delle credenziali:', error);
  }
  return null;
}

/**
 * Ottiene un access token da Spotify usando Client Credentials flow
 * Le credenziali possono essere configurate tramite:
 * 1. Variabili d'ambiente (.env): VITE_SPOTIFY_CLIENT_ID e VITE_SPOTIFY_CLIENT_SECRET
 * 2. localStorage (inserite dall'utente nell'interfaccia)
 */
async function getSpotifyAccessToken(): Promise<string> {
  const now = Date.now();
  
  // Se abbiamo un token valido, riutilizzalo
  if (accessToken && now < tokenExpiry) {
    return accessToken;
  }

  // Prova prima a caricare da localStorage (inserite dall'utente)
  const savedCredentials = loadSpotifyCredentials();
  let clientId = savedCredentials?.clientId;
  let clientSecret = savedCredentials?.clientSecret;

  // Se non ci sono credenziali salvate, prova con le variabili d'ambiente
  if (!clientId || !clientSecret) {
    clientId = import.meta.env.VITE_SPOTIFY_CLIENT_ID;
    clientSecret = import.meta.env.VITE_SPOTIFY_CLIENT_SECRET;
  }

  if (!clientId || !clientSecret) {
    throw new Error(
      'Credenziali Spotify non configurate. Inserisci Client ID e Client Secret nella tab Mood.'
    );
  }

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = 'Errore nell\'autenticazione Spotify';
      
      if (response.status === 400) {
        errorMessage = 'Credenziali non valide. Verifica che Client ID e Client Secret siano corretti.';
      } else if (response.status === 401) {
        errorMessage = 'Autenticazione fallita. Verifica che Client ID e Client Secret siano corretti.';
      } else if (response.status === 403) {
        errorMessage = 'Accesso negato. Verifica che l\'app Spotify sia configurata correttamente nel Developer Dashboard.';
      }
      
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error_description) {
          errorMessage += ` ${errorJson.error_description}`;
        }
      } catch {
        // Ignora errori di parsing
      }
      
      throw new Error(errorMessage);
    }

    const data: SpotifyTokenResponse = await response.json();
    accessToken = data.access_token;
    tokenExpiry = now + (data.expires_in - 60) * 1000; // Sottrai 60s per sicurezza

    return accessToken;
  } catch (error: any) {
    if (error.message && error.message.includes('Credenziali') || error.message.includes('Autenticazione') || error.message.includes('Accesso negato')) {
      throw error;
    }
    throw new Error(`Errore nel recupero del token Spotify: ${error.message}`);
  }
}

/**
 * Testa le credenziali Spotify per verificare che siano valide
 */
export async function testSpotifyCredentials(clientId: string, clientSecret: string): Promise<void> {
  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = 'Credenziali non valide';
      
      if (response.status === 400) {
        errorMessage = 'Credenziali non valide. Verifica che Client ID e Client Secret siano corretti.';
      } else if (response.status === 401) {
        errorMessage = 'Autenticazione fallita. Verifica che Client ID e Client Secret siano corretti.';
      } else if (response.status === 403) {
        errorMessage = 'Accesso negato. Verifica che l\'app Spotify sia configurata correttamente nel Developer Dashboard e che abbia selezionato "Web API" durante la creazione.';
      }
      
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error_description) {
          errorMessage += ` ${errorJson.error_description}`;
        }
      } catch {
        // Ignora errori di parsing
      }
      
      throw new Error(errorMessage);
    }

    // Se arriviamo qui, le credenziali sono valide
    const data: SpotifyTokenResponse = await response.json();
    if (!data.access_token) {
      throw new Error('Token non ricevuto da Spotify');
    }
  } catch (error: any) {
    if (error.message && (error.message.includes('Credenziali') || error.message.includes('Autenticazione') || error.message.includes('Accesso negato'))) {
      throw error;
    }
    throw new Error(`Errore nel test delle credenziali: ${error.message}`);
  }
}

/**
 * Estrae l'ID del track da un URI di Spotify
 * Es: spotify:track:4iV5W9uYEdYUVa79Axb7Rh -> 4iV5W9uYEdYUVa79Axb7Rh
 */
function extractTrackId(uri: string): string | null {
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
 * Ottiene le audio features per un singolo track
 */
export async function getTrackAudioFeatures(trackUri: string): Promise<AudioFeatures | null> {
  const trackId = extractTrackId(trackUri);
  
  if (!trackId) {
    return null;
  }

  try {
    const token = await getSpotifyAccessToken();
    
    const response = await fetch(`https://api.spotify.com/v1/audio-features/${trackId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        // Track non trovato
        return null;
      }
      
      let errorMessage = 'Errore nel recupero delle audio features';
      
      if (response.status === 401) {
        // Token scaduto o non valido, prova a rigenerarlo
        accessToken = null;
        tokenExpiry = 0;
        const newToken = await getSpotifyAccessToken();
        // Riprova la richiesta con il nuovo token
        const retryResponse = await fetch(`https://api.spotify.com/v1/audio-features/${trackId}`, {
          headers: {
            Authorization: `Bearer ${newToken}`,
          },
        });
        if (retryResponse.ok) {
          const data = await retryResponse.json();
          return data as AudioFeatures;
        }
        errorMessage = 'Token non valido. Verifica le credenziali.';
      } else if (response.status === 403) {
        errorMessage = 'Accesso negato alle audio features. Verifica che l\'app Spotify abbia i permessi corretti.';
      } else if (response.status === 429) {
        errorMessage = 'Troppe richieste. Attendi qualche secondo e riprova.';
      }
      
      const errorText = await response.text();
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error?.message) {
          errorMessage += ` ${errorJson.error.message}`;
        }
      } catch {
        // Ignora errori di parsing
      }
      
      throw new Error(errorMessage);
    }

    const data = await response.json();
    return data as AudioFeatures;
  } catch (error: any) {
    console.warn(`Errore nel recupero delle audio features per ${trackUri}:`, error.message);
    return null;
  }
}

/**
 * Ottiene le audio features per più track in batch (max 100 per volta)
 */
export async function getTracksAudioFeatures(
  trackUris: string[],
  onProgress?: (current: number, total: number) => void
): Promise<Map<string, AudioFeatures>> {
  const featuresMap = new Map<string, AudioFeatures>();
  const batchSize = 100;
  
  // Raggruppa gli URI unici
  const uniqueUris = Array.from(new Set(trackUris.filter(uri => uri && uri !== 'None' && uri !== '')));
  
  let has403Error = false; // Flag per fermare i tentativi dopo il primo 403
  
  for (let i = 0; i < uniqueUris.length; i += batchSize) {
    // Se abbiamo già avuto un errore 403, fermiamo i tentativi
    if (has403Error) {
      console.warn('Errore 403 rilevato. Interruzione delle richieste per evitare spam.');
      break;
    }
    
    const batch = uniqueUris.slice(i, i + batchSize);
    const trackIds = batch.map(extractTrackId).filter(id => id !== null) as string[];
    
    if (trackIds.length === 0) {
      continue;
    }

    try {
      const token = await getSpotifyAccessToken();
      
      const idsParam = trackIds.join(',');
      const response = await fetch(`https://api.spotify.com/v1/audio-features?ids=${idsParam}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `Errore nel batch ${i / batchSize + 1}`;
        let errorJson: any = null;
        
        try {
          errorJson = JSON.parse(errorText);
        } catch {
          // Ignora errori di parsing
        }
        
        if (response.status === 401) {
          // Token scaduto o non valido, prova a rigenerarlo
          accessToken = null;
          tokenExpiry = 0;
          try {
            const newToken = await getSpotifyAccessToken();
            // Riprova la richiesta con il nuovo token
            const retryResponse = await fetch(`https://api.spotify.com/v1/audio-features?ids=${idsParam}`, {
              headers: {
                Authorization: `Bearer ${newToken}`,
              },
            });
            if (retryResponse.ok) {
              const retryData = await retryResponse.json();
              if (retryData.audio_features) {
                retryData.audio_features.forEach((features: AudioFeatures | null, index: number) => {
                  if (features) {
                    featuresMap.set(batch[index], features);
                  }
                });
              }
              if (onProgress) {
                onProgress(Math.min(i + batchSize, uniqueUris.length), uniqueUris.length);
              }
              continue;
            }
          } catch (retryError) {
            console.warn(`Errore nel retry del batch ${i / batchSize + 1}:`, retryError);
          }
          errorMessage = 'Token non valido. Verifica le credenziali.';
        } else if (response.status === 403) {
          has403Error = true; // Segna che abbiamo avuto un errore 403
          errorMessage = 'Accesso negato alle audio features (403 Forbidden).';
          
          // Log dettagliato per debugging
          console.error('Errore 403 - Dettagli:', {
            status: response.status,
            statusText: response.statusText,
            errorBody: errorText,
            errorJson: errorJson,
            trackIdsCount: trackIds.length,
            firstTrackId: trackIds[0],
          });
          
          if (errorJson?.error?.message) {
            errorMessage += ` ${errorJson.error.message}`;
          }
          
          // Lancia un errore più dettagliato invece di continuare
          throw new Error(
            `${errorMessage}\n\n` +
            `Possibili cause:\n` +
            `1. L'app Spotify potrebbe non avere i permessi per accedere alle audio features\n` +
            `2. Verifica che l'app sia stata creata correttamente nel Developer Dashboard\n` +
            `3. Assicurati di aver selezionato "Web API" durante la creazione dell'app\n` +
            `4. Potrebbe essere necessario attendere qualche minuto dopo la creazione dell'app\n` +
            `5. Verifica che Client ID e Client Secret siano corretti`
          );
        } else if (response.status === 429) {
          errorMessage = 'Troppe richieste. Attendi qualche secondo.';
          // Aspetta un po' prima di continuare
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          if (errorJson?.error?.message) {
            errorMessage += ` ${errorJson.error.message}`;
          }
        }
        
        console.warn(errorMessage);
        
        // Se non è un errore 403, continua con il prossimo batch
        if (response.status !== 403) {
          continue;
        }
      }

      const data = await response.json();
      
      if (data.audio_features) {
        data.audio_features.forEach((features: AudioFeatures | null, index: number) => {
          if (features) {
            featuresMap.set(batch[index], features);
          }
        });
      }
      
      if (onProgress) {
        onProgress(Math.min(i + batchSize, uniqueUris.length), uniqueUris.length);
      }
    } catch (error: any) {
      // Se è un errore 403, propagalo invece di continuare
      if (error.message && error.message.includes('403')) {
        throw error;
      }
      console.warn(`Errore nel batch ${i / batchSize + 1}:`, error.message);
      // Continua con il prossimo batch solo se non è un errore critico
    }
  }

  return featuresMap;
}

