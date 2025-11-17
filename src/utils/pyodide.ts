import { loadPyodide } from 'pyodide';
import type { PyodideInterface } from 'pyodide';
import type { MoodAnalysisResult } from '../types';
import { loadMoodResultsFromIndexedDB, saveMoodResultsToIndexedDB, saveMoodResultsMeta } from './storage';

let pyodideInstance: PyodideInterface | null = null;

async function getSavedMoodResults(): Promise<Map<string, MoodAnalysisResult>> {
  const savedResults = new Map<string, MoodAnalysisResult>();
  
  try {
    const savedResultsStr = localStorage.getItem('audio_features_results');
    if (savedResultsStr) {
      const saved = JSON.parse(savedResultsStr) as Array<{ key: string; result: MoodAnalysisResult }>;
      saved.forEach(({ key, result }) => {
        if (key && result) {
          savedResults.set(key, result);
        }
      });
    }
  } catch (error) {
    console.warn('[MoodResults] Errore nel leggere i risultati dal localStorage:', error);
  }

  try {
    const indexedResults = await loadMoodResultsFromIndexedDB();
    indexedResults.forEach(({ key, result }) => {
      if (key && result) {
        savedResults.set(key, result);
      }
    });
  } catch (error) {
    console.warn('[MoodResults] Errore nel leggere i risultati da IndexedDB:', error);
  }

  return savedResults;
}

export async function initPyodide(): Promise<PyodideInterface> {
  if (pyodideInstance) {
    return pyodideInstance;
  }

  pyodideInstance = await loadPyodide({
    indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.29.0/full/',
  });
  
  await pyodideInstance.loadPackage(['pandas']);
  
  return pyodideInstance;
}

export function getPyodide(): PyodideInterface | null {
  return pyodideInstance;
}

export async function processSpotifyData(file: File, onProgress: (step: string) => void): Promise<any> {
  const pyodide = await initPyodide();
  
  onProgress('1/9: loading pyodide and pandas');
  
  onProgress('2/9: loading and starting code');
  const response = await fetch('/data_crunching.py');
  const pythonCode = await response.text();
  await pyodide.runPythonAsync(pythonCode);
  
  onProgress('3/9: loading zip file');
  const arrayBuffer = await file.arrayBuffer();
  const data = new Uint8Array(arrayBuffer);
  pyodide.globals.set('data', data);
  
  const filenames_py = await pyodide.runPythonAsync(`
    import zipfile
    from io import BytesIO
    zip_ref = zipfile.ZipFile(BytesIO(bytes(list(data))), "r")
    filenames = [fn for fn in zip_ref.namelist() if fn.endswith(".json")]
    filenames
  `);
  
  const filenames = filenames_py.toJs();
  
  if (
    filenames.includes('MyData/share.json') ||
    filenames.includes('MyData/AddedToCollection.json') ||
    filenames.includes('MyData/Download_Hourly.json')
  ) {
    throw new Error(
      'Error: It seems like you added your "technical log information" instead of your "Extended streaming history".'
    );
  }
  
  if (filenames.includes('MyData/YourLibrary.json') || filenames.includes('MyData/Userdata.json')) {
    throw new Error(
      'Error: It seems like you added your "account data" instead of your "Extended streaming history".'
    );
  }
  
  // Controlla se i file JSON contengono dati di streaming history
  // I file possono avere nomi come:
  // - StreamingHistory_music_*.json (formato vecchio)
  // - Streaming_History_Audio_*.json (formato nuovo)
  // - Streaming_History_Video_*.json (video streaming)
  const hasStreamingHistoryFiles = filenames.some((fn: string) =>
    fn.includes('StreamingHistory') ||
    fn.includes('streaming_history') ||
    fn.includes('Streaming_History_Audio') ||
    fn.includes('Streaming_History_Video')
  );
  
  if (!hasStreamingHistoryFiles) {
    throw new Error(
      'Error: Nessun file di streaming history trovato nello zip. ' +
      'Assicurati di caricare il file ZIP che contiene i file di streaming history ' +
      'dalla sezione "Extended streaming history" di Spotify.'
    );
  }
  
  onProgress('4/9: reading json files in zip');
  await pyodide.runPythonAsync(`
    from io import StringIO
    import zipfile
    from io import BytesIO
    zip_ref = zipfile.ZipFile(BytesIO(bytes(list(data))), "r")
    df_list = []
    for i, name in enumerate(filenames):
        try:
            df_temp = read_json(StringIO(zip_ref.read(name).decode("utf-8")))
            # Aggiungi solo DataFrame non vuoti e con le colonne essenziali per streaming history
            # Le colonne essenziali sono: 'track' (o 'master_metadata_track_name' o 'trackName') e 'ts' (o 'endTime')
            has_track_col = ("track" in df_temp.columns or 
                           "master_metadata_track_name" in df_temp.columns or
                           "trackName" in df_temp.columns)
            has_ts_col = ("ts" in df_temp.columns or 
                         "endTime" in df_temp.columns)
            
            # Escludi file che sembrano essere dati di account (hanno colonne come email, birthdate, etc.)
            account_cols = ['email', 'birthdate', 'gender', 'identifierType', 'identifierValue']
            has_account_data = any(col in df_temp.columns for col in account_cols)
            
            if not df_temp.empty and has_track_col and has_ts_col and not has_account_data:
                df_list.append(df_temp)
            elif has_account_data:
                print(f"Saltato {name}: sembra contenere dati di account invece di streaming history")
        except Exception as e:
            # Salta i file che causano errori
            print(f"Errore nel leggere {name}: {e}")
            continue
    zip_ref.close()
  `);
  
  onProgress('5/9: creating database');
  await pyodide.runPythonAsync(`
    if len(df_list) == 0:
        raise ValueError("Nessun file JSON valido trovato nello zip. Assicurati che i file contengano dati di streaming history.")
    
    # Verifica che tutti i DataFrame abbiano almeno le colonne essenziali
    required_cols = ['track', 'ts']
    for i, df_temp in enumerate(df_list):
        missing_cols = [col for col in required_cols if col not in df_temp.columns]
        if missing_cols:
            print(f"Avviso: DataFrame {i} manca delle colonne: {missing_cols}")
    
    df = pd.concat(df_list, ignore_index=True)
    
    # Verifica che dopo la concatenazione le colonne essenziali esistano
    if df.empty:
        raise ValueError("Il DataFrame concatenato è vuoto. Verifica che i file JSON contengano dati validi.")
    
    missing_cols = [col for col in required_cols if col not in df.columns]
    if missing_cols:
        # Controlla se ci sono colonne che suggeriscono dati di account invece di streaming history
        account_cols = ['email', 'birthdate', 'gender', 'identifierType', 'identifierValue', 
                       'displayName', 'firstName', 'lastName', 'country', 'postalCode']
        has_account_data = any(col in df.columns for col in account_cols)
        
        if has_account_data:
            raise ValueError(
                "ERRORE: Sembra che tu abbia caricato dati di account invece della streaming history. " +
                "Le colonne disponibili includono dati personali (email, birthdate, gender, etc.) " +
                "ma mancano le colonne necessarie per lo streaming history (ts, master_metadata_track_name, etc.). " +
                "Assicurati di scaricare e caricare il file ZIP dalla sezione 'Extended streaming history' di Spotify, " +
                "non dalla sezione 'Account data'."
            )
        else:
            raise ValueError(
                f"Colonne essenziali mancanti dopo concatenazione: {missing_cols}. " +
                f"Colonne disponibili: {list(df.columns)[:20]}..." + 
                "(mostrate solo le prime 20 colonne)"
            )
    
    # Pulizia aggiuntiva dopo concatenazione: converti eventuali valori complessi residui
    import json
    for col in df.columns:
        if df[col].dtype == 'object':
            def convert_complex(x):
                import pandas as pd
                if pd.isna(x):
                    return x
                if isinstance(x, (dict, list)):
                    try:
                        return json.dumps(x)
                    except:
                        return str(x)
                return x
            df[col] = df[col].apply(convert_complex)
  `);
  
  onProgress('6/9: preprocessing data');
  await pyodide.runPythonAsync(`
    df = preprocess_df(df)
    original_df = df.copy()
    top_k = 20
  `);
  
  // Non avviamo più automaticamente il caricamento delle audio features
  // L'utente può avviarlo manualmente dalla tab mood
  // Salva i dati necessari per il caricamento manuale
  try {
    onProgress('6.5/9: preparando dati per caricamento manuale audio features...');
    
    // Estrai artista e titolo dai track (il formato è "track~~sep~~artist")
    // Limitiamo ai track più rilevanti per velocizzare il processo
    const tracksData = await pyodide.runPythonAsync(`
      # Crea una chiave unica per ogni combinazione artista-track
      # Prioritizziamo i track con più play count per ottenere statistiche più accurate
      df_unique = df[['track', 'artist']].drop_duplicates().copy()
      
      # Conta i play per ogni track
      play_counts = df[df['full_play']].groupby(['track', 'artist']).size().reset_index(name='play_count')
      df_unique = df_unique.merge(play_counts, on=['track', 'artist'], how='left')
      df_unique['play_count'] = df_unique['play_count'].fillna(0)
      
      # Estrai track e artist dal formato "track~~sep~~artist"
      split_track = df_unique['track'].str.split('~~sep~~', n=1, expand=True)
      df_unique['track_clean'] = split_track[0]
      df_unique['artist_clean'] = split_track[1].fillna(df_unique['artist'])
      df_unique['key'] = df_unique['track_clean'] + '|||' + df_unique['artist_clean']
      
      # Ordina per play count (i più rilevanti prima)
      df_unique = df_unique.sort_values('play_count', ascending=False)
      
      df_unique[['key', 'artist_clean', 'track_clean']].to_dict('records')
    `);
    
    const tracks = tracksData.toJs() as Array<{ key: string; artist_clean: string; track_clean: string }>;
    
    if (tracks.length > 0) {
      // Salva i track nel localStorage per il caricamento manuale
      try {
        localStorage.setItem('pending_audio_features_tracks', JSON.stringify(tracks));
        localStorage.setItem('pending_audio_features_pyodide_available', 'true');
      } catch (e) {
        console.warn('Impossibile salvare i track per il caricamento manuale:', e);
      }
      onProgress(`6.5/9: ${tracks.length} track pronti per caricamento manuale`);
    }
  } catch (error: any) {
    // Se c'è un errore, continua senza audio features
    const errorMessage = error.message || 'Errore sconosciuto';
    console.warn('Impossibile preparare dati per audio features:', errorMessage);
    onProgress('6.5/9: saltando preparazione audio features');
  }
  
  onProgress('7/9: generate table and plot data');
  await pyodide.runPythonAsync('df_dict = get_df_dict(df, top_k)');
  
  onProgress('8/9: postprocess table and plot data');
  await pyodide.runPythonAsync('post_process_dataframe_dict(df_dict)');
  
  onProgress('9/9: save table and plot data as json');
  const returns = await pyodide.runPythonAsync(`
    single_values = get_single_values(df, df_dict)
    df_dict_to_df_json_dict(df_dict)
    
    {"df_dict": df_dict, "single_values": single_values}
  `);
  
  onProgress('finished');
  
  const dfDict = returns.get('df_dict').toJs();
  const singleValues = returns.get('single_values').toJs();
  
  const dataCache: any = {};
  for (const [k, v] of Object.entries(dfDict)) {
    // v è già un oggetto JavaScript (convertito da to_dict(orient="split"))
    // con struttura {columns: [...], data: [[...], ...]}
    dataCache[k] = v;
  }
  dataCache['basics_dict'] = singleValues;
  
  return {
    dataCache,
    pyodide,
    originalDf: pyodide.globals.get('original_df'),
  };
}

/**
 * Avvia l'analisi del mood usando AI con OpenRouter
 */
export async function startAIMoodAnalysis(
  pyodide: PyodideInterface,
  apiKey: string,
  onProgress: (current: number, total: number) => void
): Promise<void> {
  try {
    console.log('[startAIMoodAnalysis] Inizio funzione');
    
    // Carica i track salvati
    const tracksStr = localStorage.getItem('pending_audio_features_tracks');
    if (!tracksStr) {
      throw new Error('Nessun track disponibile per l\'analisi');
    }
    
    console.log('[startAIMoodAnalysis] Track caricati dal localStorage');
    
    const tracks = JSON.parse(tracksStr) as Array<{ key: string; artist_clean: string; track_clean: string }>;
    
    console.log(`[startAIMoodAnalysis] ${tracks.length} track trovati`);
    
    if (tracks.length === 0) {
      throw new Error('Nessun track da processare');
    }
    
    // Carica i risultati già salvati (se presenti)
    const savedResults = await getSavedMoodResults();
    if (savedResults.size > 0) {
      console.log(`[startAIMoodAnalysis] Caricati ${savedResults.size} risultati salvati`);
    }
    
    // Filtra i track già processati
    const tracksToProcess = tracks.filter(t => !savedResults.has(t.key));
    const alreadyProcessed = tracks.length - tracksToProcess.length;
    
    console.log(`[startAIMoodAnalysis] ${alreadyProcessed} track già processati, ${tracksToProcess.length} da processare`);
    
    // Se tutti i track sono già stati processati, applica direttamente i risultati salvati
    if (tracksToProcess.length === 0) {
      console.log('[startAIMoodAnalysis] Tutti i track sono già stati processati, applico i risultati salvati');
      // Aggiorna il progresso al 100%
      onProgress(tracks.length, tracks.length);
      // I risultati sono già in savedResults, continua con l'applicazione
    } else {
      // Prepara i dati per OpenRouter solo per i track da processare
      const tracksForAI = tracksToProcess.map(t => ({
        track: t.track_clean || '',
        artist: t.artist_clean || '',
        key: t.key,
      }));
      
      console.log('[startAIMoodAnalysis] Dati preparati per OpenRouter');
      
      // Importa la funzione di analisi AI
      const { analyzeMoodWithAI } = await import('./openrouter');
      
      console.log('[startAIMoodAnalysis] Funzione analyzeMoodWithAI importata');
      
      // Il flag di cancellazione viene resettato automaticamente da initOpenRouterClient
      
      // Esegui l'analisi AI solo per i track rimanenti
      console.log('[startAIMoodAnalysis] Chiamata a analyzeMoodWithAI...');
      const newResultsMap = await analyzeMoodWithAI(
        tracksForAI,
        {
          apiKey,
          model: "google/gemini-2.0-flash-001",
          siteUrl: window.location.origin,
          siteName: "Spotify Stats",
        },
        (current, _total) => {
          // Aggiorna il progresso includendo i track già processati
          onProgress(alreadyProcessed + current, tracks.length);
        }
      );
      
      // Unisci i nuovi risultati con quelli salvati
      newResultsMap.forEach((result, key) => {
        savedResults.set(key, result);
      });
      
      // I risultati sono già stati salvati incrementally durante l'analisi
      console.log(`[startAIMoodAnalysis] Completati ${savedResults.size} risultati totali`);
    }
    
    // Usa la mappa completa dei risultati (salvati + nuovi)
    const resultsMap = savedResults;
    
    // Converti i risultati in formato compatibile con il DataFrame Python
    // Converti null in None per Python e assicurati che tutti i valori siano numerici o None
    const featuresArray = tracks.map(t => {
      const result = resultsMap.get(t.key);
      if (result) {
        return {
          key: t.key,
          valence: result.valence,
          energy: result.energy !== undefined ? result.energy : null,
          danceability: result.danceability !== undefined ? result.danceability : null,
          tempo: null, // L'AI non fornisce tempo
        };
      }
      return null;
    }).filter(f => f !== null);
    
    if (featuresArray.length > 0) {
      // Prepara i dati per Python, convertendo null in None
      const featuresForPython = featuresArray.map(f => {
        const row: any = {
          key: f.key,
          valence: f.valence,
        };
        // Aggiungi solo i campi che hanno valori, altrimenti None
        row.energy = f.energy !== null && f.energy !== undefined ? f.energy : null;
        row.danceability = f.danceability !== null && f.danceability !== undefined ? f.danceability : null;
        row.tempo = null;
        return row;
      });
      
      // Converti in JSON per una conversione più affidabile in Python
      const featuresJson = JSON.stringify(featuresForPython);
      pyodide.globals.set('audio_features_json', featuresJson);
      await pyodide.runPythonAsync(`
        import pandas as pd
        import numpy as np
        import json
        
        # Converti il JSON in una lista Python
        audio_features_data = json.loads(audio_features_json)
        
        # Crea il DataFrame dalla lista di dizionari
        # pandas gestirà automaticamente la conversione da null a NaN
        features_df = pd.DataFrame(audio_features_data)
        
        # Converti le colonne numeriche, sostituendo None/null con NaN
        for col in ['valence', 'energy', 'danceability', 'tempo']:
            if col in features_df.columns:
                features_df[col] = pd.to_numeric(features_df[col], errors='coerce')
        
        # Rimuovi eventuali righe duplicate per chiave
        features_df = features_df.drop_duplicates(subset=['key'], keep='first')

        # Rimuovi vecchie colonne per evitare dupliche
        cols_to_drop = [col for col in ['valence', 'energy', 'danceability', 'tempo', 'mood'] if col in df.columns]
        if cols_to_drop:
            df = df.drop(columns=cols_to_drop)

        # Crea la chiave anche nel DataFrame principale
        split_track = df['track'].str.split('~~sep~~', n=1, expand=True)
        df['track_clean'] = split_track[0]
        df['artist_clean'] = split_track[1].fillna(df['artist'])
        df['key'] = df['track_clean'] + '|||' + df['artist_clean']
        df = df.merge(features_df[['key', 'valence', 'energy', 'danceability', 'tempo']], on='key', how='left')
        df = df.drop(columns=['key', 'track_clean', 'artist_clean'])

        # Calcola/aggiorna il mood usando il classificatore v2
        if 'valence' in df.columns:
            if 'energy' in df.columns:
                # Usa classify_mood con valence ed energy
                df['mood'] = df.apply(lambda row: classify_mood(row['valence'], row['energy']), axis=1)
            else:
                # Fallback: usa classify_mood solo con valence (userà il fallback interno)
                df['mood'] = df['valence'].apply(lambda v: classify_mood(v, None))
        else:
            df['mood'] = None

        original_df = df.copy()
        
        # Ricalcola le statistiche con le nuove features
        df_dict = get_df_dict(df, top_k)
        post_process_dataframe_dict(df_dict)
        single_values = get_single_values(df, df_dict)
        df_dict_to_df_json_dict(df_dict)
      `);
      
      // Aggiorna i dati nella cache
      const returns = await pyodide.runPythonAsync(`
        {"df_dict": df_dict, "single_values": single_values}
      `);
      
      const dfDict = returns.get('df_dict').toJs();
      const singleValues = returns.get('single_values').toJs();
      
      const updatedDataCache: any = {};
      for (const [k, v] of Object.entries(dfDict)) {
        updatedDataCache[k] = v;
      }
      updatedDataCache['basics_dict'] = singleValues;
      
      // Salva i dati aggiornati
      const { saveDataToStorage } = await import('./storage');
      saveDataToStorage(updatedDataCache);
      
      // Mantieni i risultati salvati nel localStorage anche dopo il completamento
      try {
        const resultsToSave = Array.from(resultsMap.entries()).map(([key, result]) => ({
          key,
          result,
        }));
        localStorage.setItem('audio_features_results', JSON.stringify(resultsToSave));
        console.log(`[startAIMoodAnalysis] Risultati finali salvati: ${resultsMap.size} risultati`);
        await saveMoodResultsToIndexedDB(resultsToSave);
      } catch (e) {
        console.warn('[startAIMoodAnalysis] Errore nel salvare i risultati finali:', e);
      }
      saveMoodResultsMeta(resultsMap.size);
      
      // Salva il completamento
      try {
        localStorage.setItem('audio_features_progress', JSON.stringify({
          current: tracks.length,
          total: tracks.length,
          percent: 100,
          completed: true,
        }));
        
        // Salva anche un flag che indica che l'analisi è completa e i dati sono pronti
        localStorage.setItem('audio_features_completed', 'true');
        
        // Triggera un evento custom per notificare l'aggiornamento
        window.dispatchEvent(new CustomEvent('audioFeaturesUpdated', { 
          detail: { dataCache: updatedDataCache } 
        }));
      } catch (e) {
        // Ignora errori
      }
    } else {
      throw new Error('Nessun risultato ottenuto dall\'analisi AI');
    }
  } catch (error: any) {
    console.error('Errore nell\'analisi AI del mood:', error);
    try {
      localStorage.setItem('audio_features_progress', JSON.stringify({
        error: error.message || 'Errore sconosciuto',
        completed: true,
      }));
    } catch (e) {
      // Ignora errori
    }
    throw error;
  }
}

export async function filterDataByPeriod(
  pyodide: any,
  startDate: Date,
  endDate: Date,
  onProgress: (step: string) => void
): Promise<any> {
  const startDateStr = startDate.toISOString().split('T')[0];
  const endDateStr = endDate.toISOString().split('T')[0];

  onProgress('Filtro dati per periodo...');
  
  // Carica i risultati dell'analisi mood salvati (se presenti)
  const savedResults = await getSavedMoodResults();
  if (savedResults.size > 0) {
    console.log(`[filterDataByPeriod] Caricati ${savedResults.size} risultati mood salvati`);
  }
  
  await pyodide.runPythonAsync(`
    import pandas as pd
    from datetime import datetime
    
    # Filtra il DataFrame originale per periodo
    start_date = pd.Timestamp('${startDateStr}')
    end_date = pd.Timestamp('${endDateStr}')
    
    df_filtered = original_df[
        (pd.to_datetime(original_df['year_month_day']) >= start_date) &
        (pd.to_datetime(original_df['year_month_day']) <= end_date)
    ].copy()
    
    # Ricalcola le statistiche con i dati filtrati
    top_k = 20
  `);

  // Se ci sono risultati mood salvati, applicali al DataFrame filtrato
  if (savedResults.size > 0) {
    onProgress('Applicazione risultati mood salvati...');
    
    // Carica i track per ottenere le chiavi
    const tracksStr = localStorage.getItem('pending_audio_features_tracks');
    if (tracksStr) {
      const tracks = JSON.parse(tracksStr) as Array<{ key: string; artist_clean: string; track_clean: string }>;
      
      // Prepara i dati per Python solo per i track che hanno risultati salvati
      const featuresArray = tracks
        .filter(t => savedResults.has(t.key))
        .map(t => {
          const result = savedResults.get(t.key)!;
          return {
            key: t.key,
            valence: result.valence,
            energy: result.energy !== undefined ? result.energy : null,
            danceability: result.danceability !== undefined ? result.danceability : null,
            tempo: null,
          };
        });
      
      if (featuresArray.length > 0) {
        const featuresForPython = featuresArray.map(f => {
          const row: any = {
            key: f.key,
            valence: f.valence,
          };
          row.energy = f.energy !== null && f.energy !== undefined ? f.energy : null;
          row.danceability = f.danceability !== null && f.danceability !== undefined ? f.danceability : null;
          row.tempo = null;
          return row;
        });
        
        const featuresJson = JSON.stringify(featuresForPython);
        pyodide.globals.set('audio_features_json', featuresJson);
        await pyodide.runPythonAsync(`
          import pandas as pd
          import numpy as np
          import json
          
          # Converti il JSON in una lista Python
          audio_features_data = json.loads(audio_features_json)
          
          # Crea il DataFrame dalla lista di dizionari
          features_df = pd.DataFrame(audio_features_data)
          
          # Converti le colonne numeriche, sostituendo None/null con NaN
          for col in ['valence', 'energy', 'danceability', 'tempo']:
              if col in features_df.columns:
                  features_df[col] = pd.to_numeric(features_df[col], errors='coerce')
          
          # Rimuovi eventuali righe duplicate per chiave
          features_df = features_df.drop_duplicates(subset=['key'], keep='first')

          # Elimina eventuali colonne precedenti per evitare duplicati
          cols_to_drop = [col for col in ['valence', 'energy', 'danceability', 'tempo', 'mood'] if col in df_filtered.columns]
          if cols_to_drop:
              df_filtered = df_filtered.drop(columns=cols_to_drop)
          
          # Crea la chiave anche nel DataFrame filtrato
          split_track = df_filtered['track'].str.split('~~sep~~', n=1, expand=True)
          df_filtered['track_clean'] = split_track[0]
          df_filtered['artist_clean'] = split_track[1].fillna(df_filtered['artist'])
          df_filtered['key'] = df_filtered['track_clean'] + '|||' + df_filtered['artist_clean']
          
          # Applica i risultati mood al DataFrame filtrato
          df_filtered = df_filtered.merge(features_df[['key', 'valence', 'energy', 'danceability', 'tempo']], on='key', how='left')
          
          # Assicurati che la colonna valence esista anche se il merge non ha trovato corrispondenze
          if 'valence' not in df_filtered.columns:
              df_filtered['valence'] = None
          
          df_filtered = df_filtered.drop(columns=['key', 'track_clean', 'artist_clean'])

          if 'valence' in df_filtered.columns:
              df_filtered['mood'] = df_filtered['valence'].apply(classify_mood)
          else:
              df_filtered['mood'] = None
        `);
        console.log(`[filterDataByPeriod] Applicati ${featuresArray.length} risultati mood al DataFrame filtrato`);
      } else {
        // Se non ci sono risultati da applicare ma ci sono risultati salvati, 
        // significa che nel periodo filtrato non ci sono canzoni con risultati mood
        // Ma dobbiamo comunque assicurarci che la colonna valence esista per generare le statistiche
        console.log(`[filterDataByPeriod] Nessun risultato mood da applicare nel periodo filtrato`);
        // Crea comunque la colonna valence vuota per permettere la generazione delle statistiche
        await pyodide.runPythonAsync(`
          if 'valence' not in df_filtered.columns:
              df_filtered['valence'] = None
          if 'valence' in df_filtered.columns:
              df_filtered['mood'] = df_filtered['valence'].apply(classify_mood)
          else:
              df_filtered['mood'] = None
        `);
      }
    } else {
      // Se ci sono risultati salvati ma non ci sono track, potrebbe essere un problema
      // Ma comunque dobbiamo assicurarci che la colonna valence esista se ci sono risultati salvati
      console.log(`[filterDataByPeriod] Nessun track disponibile per applicare i risultati mood`);
      // Crea comunque la colonna valence vuota per permettere la generazione delle statistiche
      await pyodide.runPythonAsync(`
        if 'valence' not in df_filtered.columns:
            df_filtered['valence'] = None
        if 'valence' in df_filtered.columns:
            df_filtered['mood'] = df_filtered['valence'].apply(classify_mood)
        else:
            df_filtered['mood'] = None
      `);
    }
  }

  onProgress('Ricalcolo statistiche...');
  await pyodide.runPythonAsync('df_dict = get_df_dict(df_filtered, top_k)');

  onProgress('Post-processing...');
  await pyodide.runPythonAsync('post_process_dataframe_dict(df_dict)');

  onProgress('Salvataggio dati...');
  const returns = await pyodide.runPythonAsync(`
    single_values = get_single_values(df_filtered, df_dict)
    df_dict_to_df_json_dict(df_dict)
    
    filtered_track_keys = []
    if 'track' in df_filtered.columns:
        temp_df = df_filtered[['track']].copy()
        if 'artist' in df_filtered.columns:
            temp_df['artist'] = df_filtered['artist']
        else:
            temp_df['artist'] = ''
        split_track = temp_df['track'].fillna('').astype(str).str.split('~~sep~~', n=1, expand=True)
        temp_df['track_clean'] = split_track[0].fillna('')
        temp_df['artist_clean'] = split_track[1].fillna(temp_df['artist'])
        temp_df['track_clean'] = temp_df['track_clean'].astype(str).str.strip().str.lower()
        temp_df['artist_clean'] = temp_df['artist_clean'].astype(str).str.strip().str.lower()
        temp_df['key'] = temp_df['track_clean'] + '|||' + temp_df['artist_clean']
        filtered_track_keys = temp_df['key'][(temp_df['key'].notna()) & (temp_df['key'] != '|||')].drop_duplicates().tolist()
    
    {"df_dict": df_dict, "single_values": single_values, "filtered_track_keys": filtered_track_keys}
  `);

  const dfDictProxy = returns.get('df_dict');
  const singleValuesProxy = returns.get('single_values');
  const filteredTrackKeysProxy = returns.get('filtered_track_keys');
  const dfDict = dfDictProxy.toJs();
  const singleValues = singleValuesProxy.toJs();
  const filteredTrackKeys = filteredTrackKeysProxy ? filteredTrackKeysProxy.toJs() : [];
  dfDictProxy.destroy();
  singleValuesProxy.destroy();
  filteredTrackKeysProxy?.destroy();

  const dataCache: any = {};
  for (const [k, v] of Object.entries(dfDict)) {
    dataCache[k] = v;
  }
  dataCache['basics_dict'] = singleValues;
  if (Array.isArray(filteredTrackKeys)) {
    dataCache['filtered_track_keys'] = filteredTrackKeys;
  }

  return { dataCache };
}

/**
 * Applica i risultati mood salvati localmente al DataFrame principale e genera i grafici
 */
export async function applyLocalMoodResultsToDataFrame(
  pyodide: PyodideInterface,
  onProgress?: (step: string) => void
): Promise<any> {
  onProgress?.('Caricamento risultati mood salvati...');
  
  // Carica i risultati dell'analisi mood salvati
  const savedResults = await getSavedMoodResults();
  if (savedResults.size === 0) {
    throw new Error('Nessun risultato mood salvato trovato');
  }
  
  console.log(`[applyLocalMoodResultsToDataFrame] Caricati ${savedResults.size} risultati mood salvati`);
  
  // Carica i track per ottenere le chiavi
  const tracksStr = localStorage.getItem('pending_audio_features_tracks');
  if (!tracksStr) {
    throw new Error('Nessun track disponibile per applicare i risultati mood');
  }
  
  const tracks = JSON.parse(tracksStr) as Array<{ key: string; artist_clean: string; track_clean: string }>;
  
  onProgress?.('Preparazione dati per Python...');
  
  // Prepara i dati per Python solo per i track che hanno risultati salvati
  const featuresArray = tracks
    .filter(t => savedResults.has(t.key))
    .map(t => {
      const result = savedResults.get(t.key)!;
      return {
        key: t.key,
        valence: result.valence,
        energy: result.energy !== undefined ? result.energy : null,
        danceability: result.danceability !== undefined ? result.danceability : null,
        tempo: null,
      };
    });
  
  if (featuresArray.length === 0) {
    throw new Error('Nessun risultato mood da applicare');
  }
  
  const featuresForPython = featuresArray.map(f => {
    const row: any = {
      key: f.key,
      valence: f.valence,
    };
    row.energy = f.energy !== null && f.energy !== undefined ? f.energy : null;
    row.danceability = f.danceability !== null && f.danceability !== undefined ? f.danceability : null;
    row.tempo = null;
    return row;
  });
  
  const featuresJson = JSON.stringify(featuresForPython);
  
  onProgress?.('Applicazione risultati al DataFrame...');
  
  pyodide.globals.set('audio_features_json', featuresJson);
  await pyodide.runPythonAsync(`
    import pandas as pd
    import numpy as np
    import json
    
    # Converti il JSON in una lista Python
    audio_features_data = json.loads(audio_features_json)
    
    # Crea il DataFrame dalla lista di dizionari
    features_df = pd.DataFrame(audio_features_data)
    
    # Converti le colonne numeriche, sostituendo None/null con NaN
    for col in ['valence', 'energy', 'danceability', 'tempo']:
        if col in features_df.columns:
            features_df[col] = pd.to_numeric(features_df[col], errors='coerce')
    
    # Rimuovi eventuali righe duplicate per chiave
    features_df = features_df.drop_duplicates(subset=['key'], keep='first')

    # Rimuovi vecchie colonne per evitare duplicati
    cols_to_drop = [col for col in ['valence', 'energy', 'danceability', 'tempo', 'mood'] if col in df.columns]
    if cols_to_drop:
        df = df.drop(columns=cols_to_drop)

    # Crea la chiave anche nel DataFrame principale
    split_track = df['track'].str.split('~~sep~~', n=1, expand=True)
    df['track_clean'] = split_track[0]
    df['artist_clean'] = split_track[1].fillna(df['artist'])
    df['key'] = df['track_clean'] + '|||' + df['artist_clean']
    df = df.merge(features_df[['key', 'valence', 'energy', 'danceability', 'tempo']], on='key', how='left')
    df = df.drop(columns=['key', 'track_clean', 'artist_clean'])

    # Calcola/aggiorna il mood usando il classificatore
    if 'valence' in df.columns:
        if 'energy' in df.columns:
            # Usa classify_mood con valence ed energy
            df['mood'] = df.apply(lambda row: classify_mood(row['valence'], row['energy']), axis=1)
        else:
            # Fallback: usa classify_mood solo con valence
            df['mood'] = df['valence'].apply(lambda v: classify_mood(v, None))
    else:
        df['mood'] = None

    original_df = df.copy()
    
    # Ricalcola le statistiche con le nuove features
    df_dict = get_df_dict(df, top_k)
    post_process_dataframe_dict(df_dict)
    single_values = get_single_values(df, df_dict)
    df_dict_to_df_json_dict(df_dict)
  `);
  
  onProgress?.('Salvataggio dati aggiornati...');
  
  // Aggiorna i dati nella cache
  const returns = await pyodide.runPythonAsync(`
    {"df_dict": df_dict, "single_values": single_values}
  `);
  
  const dfDict = returns.get('df_dict').toJs();
  const singleValues = returns.get('single_values').toJs();
  
  const updatedDataCache: any = {};
  for (const [k, v] of Object.entries(dfDict)) {
    updatedDataCache[k] = v;
  }
  updatedDataCache['basics_dict'] = singleValues;
  
  // Salva i dati aggiornati
  const { saveDataToStorage } = await import('./storage');
  saveDataToStorage(updatedDataCache);
  
  // Triggera un evento custom per notificare l'aggiornamento
  window.dispatchEvent(new CustomEvent('audioFeaturesUpdated', { 
    detail: { dataCache: updatedDataCache } 
  }));
  
  return { dataCache: updatedDataCache };
}

