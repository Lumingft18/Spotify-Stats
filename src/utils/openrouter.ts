import OpenAI from 'openai';
import type { MoodAnalysisResult } from '../types';
import { saveMoodResultsToIndexedDB, saveMoodResultsMeta } from './storage';

export interface OpenRouterConfig {
  apiKey: string;
  model?: string;
  siteUrl?: string;
  siteName?: string;
}

let openaiClient: OpenAI | null = null;
let cancellationFlag = false;
let abortController: AbortController | null = null;

export function resetCancellationFlag(): void {
  cancellationFlag = false;
  abortController = new AbortController();
}

export function initOpenRouterClient(config: OpenRouterConfig): OpenAI {
  resetCancellationFlag();
  
  openaiClient = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: config.apiKey,
    dangerouslyAllowBrowser: true, // Necessario per eseguire in browser
    defaultHeaders: {
      ...(config.siteUrl && { "HTTP-Referer": config.siteUrl }),
      ...(config.siteName && { "X-Title": config.siteName }),
    },
  });
  return openaiClient;
}

export function cancelMoodAnalysis(): void {
  cancellationFlag = true;
  if (abortController) {
    abortController.abort();
  }
}

export function isCancelled(): boolean {
  return cancellationFlag;
}

export function getOpenRouterClient(): OpenAI | null {
  return openaiClient;
}

/**
 * Analizza il mood di un batch di canzoni usando OpenRouter
 * Ogni richiesta contiene fino a 10 canzoni
 */
async function analyzeMoodBatch(
  client: OpenAI,
  tracks: Array<{ track: string; artist: string }>,
  model: string = "google/gemini-2.0-flash-001",
  signal?: AbortSignal
): Promise<MoodAnalysisResult[]> {
  console.log(`[analyzeMoodBatch] Inizio analisi batch per ${tracks.length} canzoni`);
  
  // Controlla se è stato cancellato
  if (cancellationFlag || signal?.aborted) {
    throw new Error('Analisi cancellata dall\'utente');
  }
  const prompt = `Analizza il mood delle seguenti canzoni e fornisci un giudizio matematico per ciascuna.

Per ogni canzone, devi restituire un JSON con i seguenti campi:
- valence: un numero da 0.0 a 1.0 dove 0.0 = molto triste/malinconico, 1.0 = molto felice/allegro
- energy: un numero da 0.0 a 1.0 dove 0.0 = molto calma/rilassante, 1.0 = molto energica/intensa (opzionale)
- danceability: un numero da 0.0 a 1.0 dove 0.0 = non ballabile, 1.0 = molto ballabile (opzionale)
- mood_category: una categoria tra "felice", "neutrale", "triste" basata sulla valence
- confidence: un numero da 0.0 a 1.0 che indica la confidenza nella valutazione (opzionale)

IMPORTANTE: Restituisci un oggetto JSON con una chiave "results" che contiene un array. Ogni elemento dell'array deve corrispondere all'ordine delle canzoni fornite.

Canzoni da analizzare:
${tracks.map((t, i) => `${i + 1}. "${t.track}" di ${t.artist}`).join('\n')}

Formato di risposta richiesto:
{
  "results": [
    {
      "valence": 0.75,
      "energy": 0.8,
      "danceability": 0.7,
      "mood_category": "felice",
      "confidence": 0.9
    },
    ...
  ]
}`;

  try {
    // Controlla se è stato cancellato prima di fare la richiesta
    if (cancellationFlag || signal?.aborted) {
      throw new Error('Analisi cancellata dall\'utente');
    }
    
    // Prova prima con response_format, se fallisce prova senza
    let completion;
    console.log(`[analyzeMoodBatch] Invio richiesta API con response_format`);
    try {
      completion = await client.chat.completions.create({
        model,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0.3, // Più deterministico per analisi consistente
      }, { signal });
    } catch (formatError: any) {
      // Se è stato cancellato, rilancia l'errore
      if (cancellationFlag || signal?.aborted || formatError.name === 'AbortError') {
        throw new Error('Analisi cancellata dall\'utente');
      }
      
      // Se il modello non supporta response_format, prova senza
      if (formatError.message?.includes('response_format') || formatError.code === 'invalid_request_error') {
        console.log(`[analyzeMoodBatch] response_format non supportato, riprovo senza`);
        // Controlla se è stato cancellato prima della seconda richiesta
        if (cancellationFlag || signal?.aborted) {
          throw new Error('Analisi cancellata dall\'utente');
        }
        completion = await client.chat.completions.create({
          model,
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.3,
        }, { signal });
      } else {
        throw formatError;
      }
    }

    // Controlla se è stato cancellato dopo la richiesta
    if (cancellationFlag || signal?.aborted) {
      throw new Error('Analisi cancellata dall\'utente');
    }

    const content = completion.choices[0]?.message?.content;
    console.log(`[analyzeMoodBatch] Ricevuta risposta, lunghezza: ${content?.length || 0} caratteri`);
    if (!content) {
      throw new Error('Nessuna risposta dal modello');
    }
    
    // Controlla se è stato cancellato durante il parsing
    if (cancellationFlag || signal?.aborted) {
      throw new Error('Analisi cancellata dall\'utente');
    }

    // Funzione helper per tentare di completare JSON troncato
    const tryCompleteJSON = (jsonStr: string): string => {
      // Conta le parentesi graffe aperte e chiuse
      let openBraces = (jsonStr.match(/\{/g) || []).length;
      let closeBraces = (jsonStr.match(/\}/g) || []).length;
      let openBrackets = (jsonStr.match(/\[/g) || []).length;
      let closeBrackets = (jsonStr.match(/\]/g) || []).length;
      
      let completed = jsonStr;
      
      // Chiudi gli array aperti
      for (let i = 0; i < openBrackets - closeBrackets; i++) {
        completed += ']';
      }
      
      // Chiudi gli oggetti aperti
      for (let i = 0; i < openBraces - closeBraces; i++) {
        completed += '}';
      }
      
      return completed;
    };

    // Prova a parsare come JSON object o array
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      // Se il JSON è incompleto, prova a completarlo
      try {
        const completed = tryCompleteJSON(content);
        parsed = JSON.parse(completed);
        console.warn('JSON troncato rilevato e completato automaticamente');
      } catch (e2) {
        // Se non funziona, prova a estrarre JSON dal testo
        // Cerca sia array che oggetto JSON
        const jsonArrayMatch = content.match(/\[[\s\S]*\]/);
        const jsonObjectMatch = content.match(/\{[\s\S]*\}/);
        
        if (jsonArrayMatch) {
          try {
            parsed = JSON.parse(jsonArrayMatch[0]);
          } catch (e3) {
            // Prova a completare anche questo
            try {
              const completed = tryCompleteJSON(jsonArrayMatch[0]);
              parsed = JSON.parse(completed);
            } catch (e4) {
              // Ignora
            }
          }
        }
        
        if (!parsed && jsonObjectMatch) {
          try {
            parsed = JSON.parse(jsonObjectMatch[0]);
          } catch (e3) {
            // Prova a completare anche questo
            try {
              const completed = tryCompleteJSON(jsonObjectMatch[0]);
              parsed = JSON.parse(completed);
            } catch (e4) {
              // Ignora
            }
          }
        }
        
        if (!parsed) {
          // Se ancora non funziona, prova a estrarre solo i risultati completi
          const resultsMatch = content.match(/"results"\s*:\s*\[([\s\S]*)/);
          if (resultsMatch) {
            try {
              // Estrai gli oggetti completi dall'array usando un approccio più robusto
              const resultsStr = resultsMatch[1];
              const objects: any[] = [];
              let depth = 0;
              let start = -1;
              
              for (let i = 0; i < resultsStr.length; i++) {
                if (resultsStr[i] === '{') {
                  if (depth === 0) start = i;
                  depth++;
                } else if (resultsStr[i] === '}') {
                  depth--;
                  if (depth === 0 && start !== -1) {
                    const objStr = resultsStr.substring(start, i + 1);
                    try {
                      const obj = JSON.parse(objStr);
                      if (obj.valence !== undefined) {
                        objects.push(obj);
                      }
                    } catch {
                      // Ignora oggetti non validi
                    }
                    start = -1;
                  }
                }
              }
              
              if (objects.length > 0) {
                parsed = { results: objects };
                console.warn(`JSON troncato: estratti ${objects.length} risultati completi su ${tracks.length} richiesti`);
              }
            } catch (e5) {
              // Ignora
            }
          }
          
          if (!parsed) {
            throw new Error('Risposta non in formato JSON valido: ' + content.substring(0, 200));
          }
        }
      }
    }

    // Gestisci sia array diretto che oggetto con array
    let results: any[];
    if (parsed.results && Array.isArray(parsed.results)) {
      results = parsed.results;
    } else if (parsed.data && Array.isArray(parsed.data)) {
      results = parsed.data;
    } else if (Array.isArray(parsed)) {
      results = parsed;
    } else {
      // Se è un oggetto con chiavi numeriche, convertilo in array ordinato
      const keys = Object.keys(parsed).map(k => parseInt(k)).filter(k => !isNaN(k)).sort((a, b) => a - b);
      if (keys.length > 0) {
        results = keys.map(k => parsed[k.toString()]);
      } else {
        results = Object.values(parsed);
      }
    }

    // Controlla se è stato cancellato prima di mappare i risultati
    if (cancellationFlag || signal?.aborted) {
      throw new Error('Analisi cancellata dall\'utente');
    }

    // Mappa i risultati alle canzoni originali
    return tracks.map((track, index) => {
      // Controlla se è stato cancellato durante il mapping
      if (cancellationFlag || signal?.aborted) {
        throw new Error('Analisi cancellata dall\'utente');
      }
      
      const result = results[index] || {};
      
      // Determina mood_category se non fornito
      let moodCategory: 'felice' | 'neutrale' | 'triste' | 'sconosciuto' = 'sconosciuto';
      if (result.mood_category) {
        moodCategory = result.mood_category;
      } else if (typeof result.valence === 'number') {
        if (result.valence >= 0.6) {
          moodCategory = 'felice';
        } else if (result.valence >= 0.4) {
          moodCategory = 'neutrale';
        } else {
          moodCategory = 'triste';
        }
      }

      return {
        track: track.track,
        artist: track.artist,
        valence: typeof result.valence === 'number' ? Math.max(0, Math.min(1, result.valence)) : 0.5,
        energy: typeof result.energy === 'number' ? Math.max(0, Math.min(1, result.energy)) : undefined,
        danceability: typeof result.danceability === 'number' ? Math.max(0, Math.min(1, result.danceability)) : undefined,
        mood_category: moodCategory,
        confidence: typeof result.confidence === 'number' ? Math.max(0, Math.min(1, result.confidence)) : undefined,
      };
    });
  } catch (error: any) {
    // Se è stato cancellato, rilancia l'errore invece di restituire risultati di default
    if (cancellationFlag || abortController?.signal.aborted || 
        error.message === 'Analisi cancellata dall\'utente' ||
        error.name === 'AbortError') {
      throw new Error('Analisi cancellata dall\'utente');
    }
    
    console.error('Errore nell\'analisi del mood batch:', error);
    // Restituisci risultati di default per tutte le canzoni del batch solo se non è stato cancellato
    return tracks.map(track => ({
      track: track.track,
      artist: track.artist,
      valence: 0.5,
      mood_category: 'sconosciuto' as const,
    }));
  }
}

/**
 * Processa le canzoni in batch da 100, con 10 richieste concorrenti per batch
 * Ogni richiesta contiene 10 canzoni (più veloce rispetto a 100)
 */
export async function analyzeMoodWithAI(
  tracks: Array<{ track: string; artist: string; key: string }>,
  config: OpenRouterConfig,
  onProgress?: (current: number, total: number) => void
): Promise<Map<string, MoodAnalysisResult>> {
  console.log(`[analyzeMoodWithAI] Inizio analisi per ${tracks.length} track`);
  
  const client = initOpenRouterClient(config);
  const model = config.model || "google/gemini-2.0-flash-001";
  
  console.log(`[analyzeMoodWithAI] Client inizializzato, modello: ${model}`);
  
  const resultsMap = new Map<string, MoodAnalysisResult>();
  const BATCH_SIZE = 100; // Canzoni per batch principale
  const CONCURRENT_REQUESTS = 10; // Richieste concorrenti
  const SONGS_PER_REQUEST = 10; // Canzoni per ogni richiesta (più veloce)
  
  // Aggiorna il progresso all'inizio
  if (onProgress) {
    onProgress(0, tracks.length);
  }
  
  // Dividi in batch da 100
  for (let i = 0; i < tracks.length; i += BATCH_SIZE) {
    console.log(`[analyzeMoodWithAI] Processando batch ${Math.floor(i / BATCH_SIZE) + 1}, track ${i} a ${Math.min(i + BATCH_SIZE, tracks.length)}`);
    // Controlla se è stato cancellato prima di ogni batch principale
    if (cancellationFlag || abortController?.signal.aborted) {
      throw new Error('Analisi cancellata dall\'utente');
    }
    
    const batch = tracks.slice(i, i + BATCH_SIZE);
    
    // Dividi il batch in gruppi da 10 per le richieste concorrenti
    const requestGroups: Array<{ tracks: Array<{ track: string; artist: string }>; keys: string[] }> = [];
    for (let j = 0; j < batch.length; j += SONGS_PER_REQUEST) {
      // Controlla se è stato cancellato durante la preparazione
      if (cancellationFlag || abortController?.signal.aborted) {
        throw new Error('Analisi cancellata dall\'utente');
      }
      
      const groupBatch = batch.slice(j, j + SONGS_PER_REQUEST);
      requestGroups.push({
        tracks: groupBatch.map(t => ({
          track: t.track,
          artist: t.artist,
        })),
        keys: groupBatch.map(t => t.key),
      });
    }
    
    // Processa fino a 10 richieste contemporaneamente
    for (let k = 0; k < requestGroups.length; k += CONCURRENT_REQUESTS) {
      // Controlla se è stato cancellato prima di ogni batch
      if (cancellationFlag || abortController?.signal.aborted) {
        throw new Error('Analisi cancellata dall\'utente');
      }
      
      const concurrentGroup = requestGroups.slice(k, k + CONCURRENT_REQUESTS);
      
      console.log(`[analyzeMoodWithAI] Eseguendo ${concurrentGroup.length} richieste concorrenti (gruppo ${Math.floor(k / CONCURRENT_REQUESTS) + 1})`);
      
      // Esegui le richieste in parallelo
      const promises = concurrentGroup.map((group, idx) => {
        // Controlla se è stato cancellato prima di creare la promise
        if (cancellationFlag || abortController?.signal.aborted) {
          return Promise.reject(new Error('Analisi cancellata dall\'utente'));
        }
        
        console.log(`[analyzeMoodWithAI] Avvio richiesta ${idx + 1} per ${group.tracks.length} canzoni`);
        
        return analyzeMoodBatch(client, group.tracks, model, abortController?.signal).then(results => {
          console.log(`[analyzeMoodWithAI] Richiesta ${idx + 1} completata con ${results.length} risultati`);
          // Controlla se è stato cancellato dopo il completamento
          if (cancellationFlag || abortController?.signal.aborted) {
            throw new Error('Analisi cancellata dall\'utente');
          }
          return {
            keys: group.keys,
            results,
          };
        }).catch(error => {
          // Se è stato cancellato, rilancia l'errore
          if (cancellationFlag || abortController?.signal.aborted || error.message === 'Analisi cancellata' || error.name === 'AbortError') {
            throw new Error('Analisi cancellata dall\'utente');
          }
          // Altrimenti restituisci risultati vuoti per questo batch
          return { keys: group.keys, results: [] };
        });
      });
      
      // Usa Promise.allSettled per gestire meglio le cancellazioni
      const batchResults = await Promise.allSettled(promises).then(results => {
        // Controlla se è stato cancellato durante l'esecuzione
        if (cancellationFlag || abortController?.signal.aborted) {
          throw new Error('Analisi cancellata dall\'utente');
        }
        
        const fulfilled: Array<{ keys: string[]; results: MoodAnalysisResult[] }> = [];
        for (const result of results) {
          if (result.status === 'rejected') {
            // Se è stato cancellato, rilancia l'errore
            if (cancellationFlag || abortController?.signal.aborted || 
                result.reason?.message === 'Analisi cancellata dall\'utente' ||
                result.reason?.name === 'AbortError') {
              throw new Error('Analisi cancellata dall\'utente');
            }
            // Altrimenti ignora l'errore e continua
            continue;
          }
          fulfilled.push(result.value);
        }
        return fulfilled;
      });
      
      // Se è stato cancellato durante l'esecuzione, interrompi
      if (cancellationFlag || abortController?.signal.aborted) {
        throw new Error('Analisi cancellata dall\'utente');
      }
      
      // Mappa i risultati alle chiavi originali e salva incrementalmente
      const newRecords: { key: string; result: MoodAnalysisResult }[] = [];
      batchResults.forEach(({ keys, results }) => {
        results.forEach((result, resultIndex) => {
          const key = keys[resultIndex];
          if (key && result) {
            resultsMap.set(key, result);
            newRecords.push({ key, result });
          }
        });
      });
      
      if (newRecords.length) {
        await saveMoodResultsToIndexedDB(newRecords);
      }
      
      // Salva i risultati incrementali nel localStorage dopo ogni batch
      try {
        const resultsToSave = Array.from(resultsMap.entries()).map(([key, result]) => ({
          key,
          result,
        }));
        localStorage.setItem('audio_features_results', JSON.stringify(resultsToSave));
        console.log(`[analyzeMoodWithAI] Salvati ${resultsMap.size} risultati incrementali`);
      } catch (e) {
        console.warn('[analyzeMoodWithAI] Errore nel salvare i risultati incrementali:', e);
      }
      saveMoodResultsMeta(resultsMap.size);
      
      // Aggiorna il progresso solo se non è stato cancellato
      // Controlla il flag prima e dopo il calcolo per evitare race conditions
      if (cancellationFlag || abortController?.signal.aborted) {
        throw new Error('Analisi cancellata dall\'utente');
      }
      
      const processed = Math.min(i + (k + concurrentGroup.length) * SONGS_PER_REQUEST, tracks.length);
      console.log(`[analyzeMoodWithAI] Progresso calcolato: ${processed}/${tracks.length} (batch ${Math.floor(i / BATCH_SIZE) + 1}, gruppo ${Math.floor(k / CONCURRENT_REQUESTS) + 1})`);
      
      if (onProgress && !cancellationFlag && !abortController?.signal.aborted) {
        console.log(`[analyzeMoodWithAI] Chiamata onProgress(${processed}, ${tracks.length})`);
        onProgress(processed, tracks.length);
        console.log(`[analyzeMoodWithAI] onProgress chiamato con successo`);
      } else {
        console.log(`[analyzeMoodWithAI] onProgress non chiamato: onProgress=${!!onProgress}, cancelled=${cancellationFlag || abortController?.signal.aborted}`);
      }
      
      // Piccola pausa tra i gruppi concorrenti per evitare rate limiting
      // Ma solo se non è stato cancellato
      if (k + CONCURRENT_REQUESTS < requestGroups.length && !cancellationFlag && !abortController?.signal.aborted) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
  
  return resultsMap;
}

