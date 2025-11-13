import { useState, useCallback, useRef, useEffect } from 'react';
import type { DataCache, TabName } from './types';
import { StatsContent } from './components/StatsContent';
import { Sidebar } from './components/Sidebar';
import { FileUpload } from './components/FileUpload';
import { PeriodFilter, type PeriodType } from './components/PeriodFilter';
import { processSpotifyData, filterDataByPeriod, getPyodide } from './utils/pyodide';
import { saveDataToStorage, loadDataFromStorage, clearStorage, saveFileToStorage, loadFileFromStorage } from './utils/storage';

function App() {
  const [dataCache, setDataCache] = useState<DataCache | null>(null);
  const [currentTab, setCurrentTab] = useState<TabName>('basics');
  const [isUserData, setIsUserData] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isFiltering, setIsFiltering] = useState(false);
  const [isLoadingFromStorage, setIsLoadingFromStorage] = useState(true);
  const pyodideRef = useRef<any>(null);
  const originalDataCacheRef = useRef<DataCache | null>(null);

  const handleFileUpload = useCallback(async (file: File) => {
    setIsProcessing(true);
    setError(null);
    setProgress('');

    try {
      const result = await processSpotifyData(file, (step) => {
        setProgress(step);
      });

      pyodideRef.current = result.pyodide;
      originalDataCacheRef.current = result.dataCache; // Salva i dati originali
      
      // Salva nel localStorage
      saveDataToStorage(result.dataCache);
      await saveFileToStorage(file);
      
      setDataCache(result.dataCache);
      setIsUserData(true);
      setCurrentTab('basics');
    } catch (err: any) {
      setError(err.message || 'Errore durante l\'elaborazione dei dati');
      console.error(err);
    } finally {
      setIsProcessing(false);
    }
  }, []);

  // Ascolta gli aggiornamenti delle audio features in background
  useEffect(() => {
    // Ascolta eventi di aggiornamento quando le audio features sono completate
    const handleUpdate = (event: any) => {
      setDataCache(event.detail.dataCache);
      originalDataCacheRef.current = event.detail.dataCache;
      saveDataToStorage(event.detail.dataCache);
    };
    
    window.addEventListener('audioFeaturesUpdated', handleUpdate);
    
    return () => {
      window.removeEventListener('audioFeaturesUpdated', handleUpdate);
    };
  }, []);

  // Carica i dati salvati all'avvio
  useEffect(() => {
    const loadSavedData = async () => {
      setIsLoadingFromStorage(true);
      
      try {
        // Prova a caricare i dati dal localStorage
        const savedData = loadDataFromStorage();
        
        if (savedData) {
          // Usa direttamente i dati salvati senza riprocessare il file
          setDataCache(savedData);
          originalDataCacheRef.current = savedData;
          setIsUserData(true);
          
          // Il file verrà ricaricato solo quando necessario (es. per filtri)
          // Inizializziamo Pyodide in modo lazy quando serve
        }
      } catch (err) {
        console.error('Errore nel caricamento dei dati salvati:', err);
      } finally {
        setIsLoadingFromStorage(false);
      }
    };

    loadSavedData();
  }, []);

  const handlePeriodChange = useCallback(async (
    period: PeriodType,
    startDate?: Date,
    endDate?: Date
  ) => {
    if (!dataCache) return;

    // Se è "totale", ripristina i dati originali senza bisogno di Pyodide
    if (period === 'total') {
      if (originalDataCacheRef.current) {
        setDataCache(originalDataCacheRef.current);
      }
      return;
    }

    // Per i filtri personalizzati, serve Pyodide con il file processato
    if (!pyodideRef.current) {
      setIsFiltering(true);
      setError(null);
      setProgress('Caricamento dati per filtri...');

      try {
        // Carica il file salvato e processalo per avere il DataFrame originale
        const savedFile = await loadFileFromStorage();
        if (!savedFile) {
          throw new Error('File non trovato. Carica un nuovo file per usare i filtri.');
        }

        const result = await processSpotifyData(savedFile, (step) => {
          setProgress(`Caricamento: ${step}`);
        });
        
        pyodideRef.current = result.pyodide;
        originalDataCacheRef.current = result.dataCache;
      } catch (err: any) {
        setError(err.message || 'Errore durante il caricamento dei dati per i filtri');
        console.error(err);
        setIsFiltering(false);
        setProgress('');
        return;
      }
    }

    setIsFiltering(true);
    setError(null);
    setProgress('Filtro dati...');

    try {
      const pyodide = getPyodide();
      if (!pyodide) {
        throw new Error('Pyodide non inizializzato');
      }

      if (startDate && endDate) {
        const result = await filterDataByPeriod(
          pyodide,
          startDate,
          endDate,
          (step) => setProgress(step)
        );
        setDataCache(result.dataCache);
      }
    } catch (err: any) {
      setError(err.message || 'Errore durante il filtraggio dei dati');
      console.error(err);
    } finally {
      setIsFiltering(false);
      setProgress('');
    }
  }, [dataCache]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-950 via-black to-gray-950 text-white">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-gray-900/80 backdrop-blur-lg border-b border-gray-800 shadow-lg">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between px-6 py-4 gap-4">
          <div className="flex items-center gap-4">
            {dataCache && (
              <button
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className="lg:hidden text-gray-300 hover:text-white transition-colors"
              >
                <span className="text-2xl">☰</span>
              </button>
            )}
            <h1 className="text-2xl font-bold bg-gradient-to-r from-green-400 to-green-600 bg-clip-text text-transparent flex items-center gap-2">
              <span className="text-3xl">🎵</span>
              Spotify Statistics
            </h1>
          </div>
          <div className="flex items-center gap-4">
            {dataCache && (
              <>
                <PeriodFilter
                  onPeriodChange={handlePeriodChange}
                  disabled={isFiltering || isProcessing}
                />
                {isFiltering && (
                  <div className="flex items-center gap-2 text-sm text-gray-400">
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-gray-600 border-t-green-500"></div>
                    <span>Filtro...</span>
                  </div>
                )}
              </>
            )}
            {dataCache && (
              <button
                onClick={() => {
                  setDataCache(null);
                  setCurrentTab('basics');
                  setIsUserData(false);
                  setError(null);
                  pyodideRef.current = null;
                  originalDataCacheRef.current = null;
                  clearStorage(); // Rimuove anche i dati salvati
                }}
                className="text-sm text-gray-400 hover:text-white transition-colors whitespace-nowrap"
              >
                Carica nuovo file
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar */}
        {dataCache && (
          <>
            {/* Mobile overlay */}
            {sidebarOpen && (
              <div
                className="fixed inset-0 bg-black/50 z-40 lg:hidden"
                onClick={() => setSidebarOpen(false)}
              />
            )}
            {/* Sidebar */}
            <div
              className={`
                fixed lg:static inset-y-0 left-0 z-50 transition-transform duration-300
                ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
              `}
            >
              <Sidebar
                currentTab={currentTab}
                onTabChange={(tab) => {
                  setCurrentTab(tab);
                  setSidebarOpen(false);
                }}
                showAdvanced={showAdvanced}
                onToggleAdvanced={() => setShowAdvanced(!showAdvanced)}
              />
            </div>
          </>
        )}

        {/* Main Content */}
        <main className="flex-1 min-h-screen">
          {isLoadingFromStorage && (
            <div className="container mx-auto px-4 py-12">
              <div className="max-w-3xl mx-auto">
                <div className="bg-gradient-to-br from-gray-800 to-gray-900 rounded-2xl p-12 border border-gray-700 shadow-2xl">
                  <div className="text-center">
                    <div className="relative inline-block mb-6">
                      <div className="animate-spin rounded-full h-12 w-12 border-4 border-gray-700 border-t-green-500"></div>
                    </div>
                    <p className="text-gray-300">Caricamento dati salvati...</p>
                  </div>
                </div>
              </div>
            </div>
          )}
          
          {!isLoadingFromStorage && !dataCache && !isProcessing && (
            <div className="container mx-auto px-4 py-12">
              <FileUpload
                onFileSelect={handleFileUpload}
                isProcessing={isProcessing}
                progress={progress}
                error={error}
              />
            </div>
          )}

          {isProcessing && (
            <div className="container mx-auto px-4 py-12">
              <FileUpload
                onFileSelect={handleFileUpload}
                isProcessing={isProcessing}
                progress={progress}
                error={error}
              />
            </div>
          )}

          {error && !isProcessing && (
            <div className="container mx-auto px-4 py-6">
              <div className="max-w-3xl mx-auto bg-red-900/30 border border-red-700 rounded-xl p-6">
                <div className="flex items-start gap-3">
                  <span className="text-xl">⚠️</span>
                  <div>
                    <p className="text-red-200 font-semibold mb-1">Errore</p>
                    <p className="text-red-300 text-sm">{error}</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {dataCache && !isProcessing && (
            <div className="container mx-auto px-4 py-8 lg:px-8">
              <div className="bg-gradient-to-br from-gray-900/50 to-gray-800/50 rounded-2xl p-6 lg:p-10 border border-gray-800 shadow-2xl">
                <StatsContent 
                  tab={currentTab} 
                  dataCache={dataCache} 
                  isUserData={isUserData}
                />
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
