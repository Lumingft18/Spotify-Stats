import { useState, useEffect } from 'react';
import type { DataFrameData } from '../types';
import { DataTable } from './DataTable';
import { Plot } from './Plot';
import { MultiLinePlot } from './MultiLinePlot';
import { getPyodide, startManualAudioFeaturesLoad } from '../utils/pyodide';
import { cancelAudioFeaturesLoad } from '../utils/acousticbrainz';

interface MoodContentProps {
  dataCache: { [key: string]: DataFrameData | any };
}

export function MoodContent({ dataCache }: MoodContentProps) {
  const [audioFeaturesProgress, setAudioFeaturesProgress] = useState<{ current: number; total: number; percent: number; completed?: boolean; error?: string } | null>(null);
  const [isLoadingAudioFeatures, setIsLoadingAudioFeatures] = useState(false);
  const [canLoadAudioFeatures, setCanLoadAudioFeatures] = useState(false);
  const [tracksCount, setTracksCount] = useState<number>(0);
  
  const moodDistribution = dataCache['mood_distribution'] as DataFrameData | undefined;
  const moodPerWeek = dataCache['mood_per_week'] as DataFrameData | undefined;
  const moodPerMonth = dataCache['mood_per_month'] as DataFrameData | undefined;
  const moodPerDayOfWeek = dataCache['mood_per_day_of_week'] as DataFrameData | undefined;
  
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
        }
      } catch (e) {
        // Ignora errori
      }
    };
    
    checkAvailability();
  }, []);

  // Controlla il progresso delle audio features
  useEffect(() => {
    const checkProgress = () => {
      try {
        const progressStr = localStorage.getItem('audio_features_progress');
        if (progressStr) {
          const progress = JSON.parse(progressStr);
          setAudioFeaturesProgress(progress);
        }
      } catch (e) {
        // Ignora errori
      }
    };
    
    // Controlla immediatamente
    checkProgress();
    
    // Controlla periodicamente solo se il caricamento è in corso
    const interval = setInterval(() => {
      if (isLoadingAudioFeatures || (audioFeaturesProgress && !audioFeaturesProgress.completed)) {
        checkProgress();
      }
    }, 1000);
    
    // Ascolta eventi di aggiornamento
    const handleUpdate = (event: any) => {
      checkProgress();
      setIsLoadingAudioFeatures(false);
      // I dati verranno aggiornati automaticamente tramite l'evento
      // Non serve ricaricare la pagina, l'aggiornamento avviene tramite App.tsx
    };
    
    window.addEventListener('audioFeaturesUpdated', handleUpdate);
    
    return () => {
      clearInterval(interval);
      window.removeEventListener('audioFeaturesUpdated', handleUpdate);
    };
  }, [isLoadingAudioFeatures, audioFeaturesProgress]);
  
  // Funzione per avviare manualmente il caricamento
  const handleStartAudioFeaturesLoad = async () => {
    setIsLoadingAudioFeatures(true);
    setAudioFeaturesProgress({ current: 0, total: 0, percent: 0 });
    
    try {
      const pyodide = getPyodide();
      if (!pyodide) {
        throw new Error('Pyodide non disponibile. Ricarica il file dei dati.');
      }
      
      await startManualAudioFeaturesLoad(pyodide, (step) => {
        // Il progresso viene salvato nel localStorage e aggiornato automaticamente
        console.log(step);
      });
    } catch (error: any) {
      setAudioFeaturesProgress({
        current: 0,
        total: 0,
        percent: 0,
        completed: true,
        error: error.message || 'Errore durante il caricamento',
      });
      setIsLoadingAudioFeatures(false);
    }
  };

  // Funzione per fermare il caricamento
  const handleStopAudioFeaturesLoad = () => {
    cancelAudioFeaturesLoad();
    
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
  };

  // Mostra il progresso del caricamento se è in corso
  const showProgress = audioFeaturesProgress && !audioFeaturesProgress.completed;
  
  return (
    <div className="space-y-8">
      {/* Banner informativo se le audio features non sono disponibili */}
      {!moodDistribution && !moodPerWeek && !moodPerMonth && !moodPerDayOfWeek && canLoadAudioFeatures && !isLoadingAudioFeatures && (
        <div className="bg-gradient-to-br from-orange-900/30 to-red-900/30 border border-orange-700/50 rounded-xl p-6">
          <div className="flex items-start gap-3">
            <span className="text-2xl">⏱️</span>
            <div className="flex-1">
              <h3 className="text-orange-200 font-semibold mb-2">Caricamento audio features disponibile</h3>
              <p className="text-orange-300 text-sm mb-4">
                Puoi avviare il caricamento delle audio features per visualizzare le statistiche sul mood delle tue canzoni.
                {tracksCount > 0 && (
                  <span className="block mt-2 text-orange-400 font-semibold">
                    {tracksCount} track pronti per il caricamento
                  </span>
                )}
              </p>
              <div className="bg-orange-900/30 border border-orange-700 rounded-lg p-4 mb-4">
                <p className="text-orange-200 text-sm font-semibold mb-2">⚠️ Attenzione:</p>
                <ul className="text-orange-300 text-xs list-disc list-inside ml-2 space-y-1">
                  <li>Il processo può richiedere <strong>diversi minuti</strong> (10-30 minuti a seconda del numero di canzoni)</li>
                  <li>Le richieste vengono fatte tramite proxy CORS pubblici che possono essere lenti</li>
                  <li>Puoi continuare a navigare mentre il caricamento è in corso</li>
                  <li>I dati vengono salvati automaticamente, quindi non perderai il progresso</li>
                  <li>Il processo è ottimizzato con richieste parallele e cache locale</li>
                </ul>
              </div>
              <button
                onClick={handleStartAudioFeaturesLoad}
                disabled={isLoadingAudioFeatures}
                className="bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white font-semibold py-3 px-6 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isLoadingAudioFeatures ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent"></div>
                    <span>Caricamento in corso...</span>
                  </>
                ) : (
                  <>
                    <span>🚀</span>
                    <span>Avvia caricamento audio features</span>
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
                Caricamento audio features in corso...
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
                  Puoi continuare a navigare mentre le audio features vengono caricate in background.
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
      
      {/* Se non ci sono dati sul mood, mostra i box di input */}
      {!moodDistribution && !moodPerWeek && !moodPerMonth && !moodPerDayOfWeek && (
        <div className="bg-gradient-to-br from-yellow-900/30 to-orange-900/30 border border-yellow-700/50 rounded-xl p-6">
          <div className="flex items-start gap-3">
            <span className="text-2xl">⚠️</span>
            <div className="flex-1">
              <h3 className="text-yellow-200 font-semibold mb-2">Dati sul mood non disponibili</h3>
              <p className="text-yellow-300 text-sm mb-4">
                Per visualizzare le statistiche sul mood delle tue canzoni, le audio features vengono ottenute automaticamente da <strong>AcousticBrainz</strong> (database open source gratuito).
              </p>
              
              <div className="bg-blue-900/30 border border-blue-700 rounded-lg p-4">
                <div className="flex items-start gap-2">
                  <span className="text-lg">ℹ️</span>
                  <div className="flex-1">
                    <p className="text-blue-200 text-sm font-semibold mb-1">Come funziona</p>
                    <p className="text-blue-300 text-sm mb-2">
                      Quando carichi i tuoi dati, l'applicazione cercherà automaticamente le audio features su AcousticBrainz per ogni canzone. Non è necessaria alcuna configurazione!
                    </p>
                    <ul className="text-blue-300 text-xs list-disc list-inside ml-2 space-y-1">
                      <li>AcousticBrainz è un database open source gratuito</li>
                      <li>Non richiede API key o credenziali</li>
                      <li>Potrebbe richiedere più tempo rispetto a Spotify (circa 200ms per canzone)</li>
                      <li>Non tutte le canzoni potrebbero essere presenti nel database</li>
                    </ul>
                  </div>
                </div>
              </div>

              <div className="mt-4 bg-gray-800/30 rounded-lg p-4 text-sm text-gray-400">
                <p className="font-semibold mb-2 text-gray-300">Cosa fare:</p>
                <p className="text-gray-300 text-sm mb-2">
                  Ricarica i tuoi dati per ottenere le audio features. Il processo potrebbe richiedere alcuni minuti a seconda del numero di canzoni uniche nel tuo file.
                </p>
                <p className="text-xs text-gray-500 mt-2">
                  Le audio features vengono ottenute da AcousticBrainz tramite MusicBrainz. Tutti i dati vengono processati localmente nel tuo browser.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* Mostra i dati se disponibili */}
      {/* Distribuzione generale del mood */}
      {moodDistribution && (
        <div className="space-y-4">
          <h3 className="text-xl font-bold text-green-400 flex items-center gap-2">
            <span>📊</span> Distribuzione generale del mood
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {moodDistribution.data?.map((row: any[], index: number) => {
              const mood = row[0] as string;
              const percentuale = row[1] as number;
              const conteggio = row[2] as number;
              
              const moodColors: { [key: string]: string } = {
                felice: 'from-green-500 to-emerald-600',
                neutrale: 'from-yellow-500 to-orange-600',
                triste: 'from-blue-500 to-indigo-600',
                sconosciuto: 'from-gray-500 to-gray-600',
              };
              
              const moodEmojis: { [key: string]: string } = {
                felice: '😊',
                neutrale: '😐',
                triste: '😢',
                sconosciuto: '❓',
              };
              
              return (
                <div
                  key={index}
                  className={`bg-gradient-to-br ${moodColors[mood] || 'from-gray-500 to-gray-600'} rounded-xl p-6 shadow-xl`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-3xl">{moodEmojis[mood] || '❓'}</span>
                    <span className="text-2xl font-bold text-white">{percentuale.toFixed(1)}%</span>
                  </div>
                  <div className="text-white/90 font-medium capitalize">{mood}</div>
                  <div className="text-white/70 text-sm mt-1">{conteggio.toLocaleString()} canzoni</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Mood per settimana */}
      {moodPerWeek && (
        <div className="space-y-4">
          <h3 className="text-xl font-bold text-green-400 flex items-center gap-2">
            <span>📅</span> Mood per settimana
          </h3>
          {moodPerWeek.columns?.includes('felice_percent') && (
            <MultiLinePlot
              title="Percentuale di canzoni felici/neutre/tristi per settimana"
              data={{
                columns: [
                  moodPerWeek.columns[0], // year_week
                  ...moodPerWeek.columns.filter((c: string) => c.endsWith('_percent'))
                ],
                data: moodPerWeek.data?.map((row: any[]) => {
                  const newRow = [row[0]]; // year_week
                  moodPerWeek.columns?.forEach((col: string, idx: number) => {
                    if (col.endsWith('_percent')) {
                      newRow.push(row[idx]);
                    }
                  });
                  return newRow;
                }) || []
              }}
              yUnit="percentuale (%)"
              percent={true}
            />
          )}
        </div>
      )}

      {/* Mood per mese */}
      {moodPerMonth && (
        <div className="space-y-4">
          <h3 className="text-xl font-bold text-green-400 flex items-center gap-2">
            <span>📆</span> Mood per mese
          </h3>
          {moodPerMonth.columns?.includes('felice_percent') && (
            <MultiLinePlot
              title="Percentuale di canzoni felici/neutre/tristi per mese"
              data={{
                columns: [
                  moodPerMonth.columns[0], // month
                  ...moodPerMonth.columns.filter((c: string) => c.endsWith('_percent'))
                ],
                data: moodPerMonth.data?.map((row: any[]) => {
                  const newRow = [row[0]]; // month
                  moodPerMonth.columns?.forEach((col: string, idx: number) => {
                    if (col.endsWith('_percent')) {
                      newRow.push(row[idx]);
                    }
                  });
                  return newRow;
                }) || []
              }}
              yUnit="percentuale (%)"
              percent={true}
            />
          )}
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
    </div>
  );
}

