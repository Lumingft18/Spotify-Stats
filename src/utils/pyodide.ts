import { loadPyodide } from 'pyodide';
import type { PyodideInterface } from 'pyodide';
import { getTracksAudioFeatures } from './acousticbrainz';

let pyodideInstance: PyodideInterface | null = null;

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
  
  onProgress('4/9: reading json files in zip');
  await pyodide.runPythonAsync(`
    from io import StringIO
    import zipfile
    from io import BytesIO
    zip_ref = zipfile.ZipFile(BytesIO(bytes(list(data))), "r")
    df_list = []
    for i, name in enumerate(filenames):
        df_list.append(read_json(StringIO(zip_ref.read(name).decode("utf-8"))))
    zip_ref.close()
  `);
  
  onProgress('5/9: creating database');
  await pyodide.runPythonAsync('df = pd.concat(df_list)');
  
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
      
      # Ordina per play count e limita a max 1000 track (i più rilevanti)
      df_unique = df_unique.sort_values('play_count', ascending=False).head(1000)
      
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
 * Avvia manualmente il caricamento delle audio features
 */
export async function startManualAudioFeaturesLoad(
  pyodide: PyodideInterface,
  onProgress: (step: string) => void
): Promise<void> {
  try {
    // Carica i track salvati
    const tracksStr = localStorage.getItem('pending_audio_features_tracks');
    if (!tracksStr) {
      throw new Error('Nessun track disponibile per il caricamento');
    }
    
    const tracks = JSON.parse(tracksStr) as Array<{ key: string; artist_clean: string; track_clean: string }>;
    
    if (tracks.length === 0) {
      throw new Error('Nessun track da processare');
    }
    
    // Avvia il caricamento
    await loadAudioFeaturesInBackground(pyodide, tracks, onProgress);
  } catch (error: any) {
    console.error('Errore nel caricamento manuale delle audio features:', error);
    throw error;
  }
}

/**
 * Carica le audio features in background e aggiorna il DataFrame quando completato
 */
async function loadAudioFeaturesInBackground(
  pyodide: PyodideInterface,
  tracks: Array<{ key: string; artist_clean: string; track_clean: string }>,
  onProgress: (step: string) => void
): Promise<void> {
  try {
    // Prepara i dati per AcousticBrainz
    const tracksForAcousticBrainz = tracks.map(t => ({
      artist: t.artist_clean || '',
      track: t.track_clean || '',
      key: t.key,
    }));
    
    const { getTracksAudioFeatures, isCancelled } = await import('./acousticbrainz');
    
    // Mantieni traccia del progresso corrente per la cancellazione
    let lastProgress = { current: 0, total: tracks.length, percent: 0 };
    
    // Crea un callback per aggiornare il progresso
    const progressCallback = (current: number, total: number) => {
      const percent = Math.round((current / total) * 100);
      lastProgress = { current, total, percent };
      onProgress(`Caricamento audio features: ${current}/${total} (${percent}%)`);
      
      // Salva il progresso nel localStorage per poterlo mostrare nella UI
      try {
        localStorage.setItem('audio_features_progress', JSON.stringify({
          current,
          total,
          percent,
        }));
      } catch (e) {
        // Ignora errori di localStorage
      }
    };
    
    const featuresMap = await getTracksAudioFeatures(tracksForAcousticBrainz, progressCallback);
    
    // Controlla se è stato cancellato
    if (isCancelled()) {
      // Il caricamento è stato cancellato - salva il progresso corrente
      try {
        localStorage.setItem('audio_features_progress', JSON.stringify({
          ...lastProgress,
          completed: true,
          cancelled: true,
        }));
      } catch (e) {
        // Ignora errori
      }
      onProgress('Caricamento audio features cancellato');
      return;
    }
    
    // Aggiungi le audio features al DataFrame Python
    const featuresArray = tracks.map(t => {
      const features = featuresMap.get(t.key);
      if (features) {
        return {
          key: t.key,
          valence: features.valence,
          energy: features.energy || null,
          danceability: features.danceability || null,
          tempo: features.tempo || null,
        };
      }
      return null;
    }).filter(f => f !== null);
    
    if (featuresArray.length > 0) {
      pyodide.globals.set('audio_features_data', featuresArray);
      await pyodide.runPythonAsync(`
        import pandas as pd
        features_df = pd.DataFrame(audio_features_data)
        # Crea la chiave anche nel DataFrame principale
        split_track = df['track'].str.split('~~sep~~', n=1, expand=True)
        df['track_clean'] = split_track[0]
        df['artist_clean'] = split_track[1].fillna(df['artist'])
        df['key'] = df['track_clean'] + '|||' + df['artist_clean']
        df = df.merge(features_df[['key', 'valence', 'energy', 'danceability', 'tempo']], on='key', how='left')
        df = df.drop(columns=['key', 'track_clean', 'artist_clean'])
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
      
      // Notifica che il caricamento è completato
      onProgress(`Audio features completate: ${featuresArray.length}/${tracks.length} track trovati`);
      
      // Salva il completamento
      try {
        localStorage.setItem('audio_features_progress', JSON.stringify({
          current: tracks.length,
          total: tracks.length,
          percent: 100,
          completed: true,
        }));
        
        // Triggera un evento custom per notificare l'aggiornamento
        window.dispatchEvent(new CustomEvent('audioFeaturesUpdated', { 
          detail: { dataCache: updatedDataCache } 
        }));
      } catch (e) {
        // Ignora errori
      }
    } else {
      onProgress('Nessuna audio feature trovata su AcousticBrainz');
      try {
        localStorage.setItem('audio_features_progress', JSON.stringify({
          current: 0,
          total: tracks.length,
          percent: 0,
          completed: true,
        }));
      } catch (e) {
        // Ignora errori
      }
    }
  } catch (error: any) {
    console.error('Errore nel caricamento background delle audio features:', error);
    try {
      localStorage.setItem('audio_features_progress', JSON.stringify({
        error: error.message || 'Errore sconosciuto',
        completed: true,
      }));
    } catch (e) {
      // Ignora errori
    }
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

  onProgress('Ricalcolo statistiche...');
  await pyodide.runPythonAsync('df_dict = get_df_dict(df_filtered, top_k)');

  onProgress('Post-processing...');
  await pyodide.runPythonAsync('post_process_dataframe_dict(df_dict)');

  onProgress('Salvataggio dati...');
  const returns = await pyodide.runPythonAsync(`
    single_values = get_single_values(df_filtered, df_dict)
    df_dict_to_df_json_dict(df_dict)
    
    {"df_dict": df_dict, "single_values": single_values}
  `);

  const dfDict = returns.get('df_dict').toJs();
  const singleValues = returns.get('single_values').toJs();

  const dataCache: any = {};
  for (const [k, v] of Object.entries(dfDict)) {
    dataCache[k] = v;
  }
  dataCache['basics_dict'] = singleValues;

  return { dataCache };
}

