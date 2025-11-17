import { useState, useEffect, useMemo, useRef } from 'react';
import type { DataFrameData } from '../types';
import { formatValue } from '../utils/dataProcessing';
import { Plot } from './Plot';

interface DataTableProps {
  title: string;
  data: DataFrameData;
  showRank?: boolean;
  monthlyDataCache?: { [key: string]: any };
}

interface ChartModalProps {
  isOpen: boolean;
  monthlyData: Array<{ month: string; play_count: number }>;
  title: string;
  onClose: () => void;
}

function ChartModal({ isOpen, monthlyData, title, onClose }: ChartModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    console.log('[ChartModal] Modal state changed:', { isOpen, monthlyDataLength: monthlyData?.length });
  }, [isOpen, monthlyData]);

  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, onClose]);

  // Gestione del ridimensionamento quando il modal viene aperto
  useEffect(() => {
    if (!isOpen || !containerRef.current) return;

    const handleResize = () => {
      // Il Plot si ridimensionerà automaticamente tramite il ResizeObserver che abbiamo aggiunto
      // Ma possiamo forzare un resize se necessario
      const plotElement = containerRef.current?.querySelector('[id^="plotly"]');
      if (plotElement && (window as any).Plotly) {
        (window as any).Plotly.Plots.resize(plotElement);
      }
    };

    // ResizeObserver per monitorare i cambiamenti di dimensione del contenitore
    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });

    resizeObserver.observe(containerRef.current);
    window.addEventListener('resize', handleResize);

    // Ridimensiona dopo un breve delay per assicurarsi che il modal sia completamente renderizzato
    setTimeout(() => {
      handleResize();
    }, 100);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [isOpen]);

  if (!isOpen) {
    console.log('[ChartModal] Modal non aperto');
    return null;
  }

  if (!monthlyData || monthlyData.length === 0) {
    console.warn('[ChartModal] Nessun dato mensile disponibile');
    return null;
  }

  console.log('[ChartModal] Rendering modal con dati:', monthlyData);

  // Converti i dati mensili in formato DataFrameData per Plot
  const chartData: DataFrameData = {
    columns: ['month', 'play_count'],
    data: monthlyData.map(item => [item.month, item.play_count])
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm overflow-auto p-4"
      onClick={onClose}
    >
      <div
        ref={containerRef}
        className="relative w-full max-w-[95vw] bg-gray-900 rounded-xl border border-gray-700 shadow-2xl p-6 my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-white">{title}</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors text-3xl leading-none"
            aria-label="Chiudi"
          >
            ×
          </button>
        </div>
        <div className="w-full" style={{ width: '100%', minHeight: '400px' }}>
          <Plot
            title={`Riproduzioni mensili - ${title}`}
            data={chartData}
            xColumn="month"
            yColumn="play_count"
            type="bar"
          />
        </div>
        <div className="mt-4 text-sm text-gray-400 text-center">
          Clicca fuori dal grafico o premi ESC per chiudere
        </div>
      </div>
    </div>
  );
}

export function DataTable({ title, data, showRank = false, monthlyDataCache }: DataTableProps) {
  const [sortColumn, setSortColumn] = useState<number | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedChart, setSelectedChart] = useState<{ monthlyData: Array<{ month: string; play_count: number }>; title: string } | null>(null);

  const handleSort = (columnIndex: number) => {
    let newDirection: 'asc' | 'desc' = 'asc';
    
    if (sortColumn === columnIndex) {
      newDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    }
    
    setSortColumn(columnIndex);
    setSortDirection(newDirection);
  };

  const filteredAndSortedData = useMemo(() => {
    let result = [...data.data];

    // Filter by search term
    if (searchTerm) {
      result = result.filter((row) =>
        row.some((cell) =>
          String(cell).toLowerCase().includes(searchTerm.toLowerCase())
        )
      );
    }

    // Sort
    if (sortColumn !== null) {
      result.sort((a, b) => {
        const aVal = a[sortColumn];
        const bVal = b[sortColumn];
        
        if (typeof aVal === 'number' && typeof bVal === 'number') {
          return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
        }
        
        const aStr = String(aVal);
        const bStr = String(bVal);
        return sortDirection === 'asc' 
          ? aStr.localeCompare(bStr)
          : bStr.localeCompare(aStr);
      });
    }

    return result;
  }, [data.data, searchTerm, sortColumn, sortDirection]);
  
  useEffect(() => {
    setSortColumn(null);
    setSearchTerm('');
  }, [data]);

  return (
    <div className="w-full">
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h3 className="text-2xl font-bold text-white">{title}</h3>
        <div className="relative">
          <input
            type="text"
            placeholder="Cerca..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full sm:w-64 pl-10 pr-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
          />
          <span className="absolute left-3 top-2.5 text-gray-400">🔍</span>
        </div>
      </div>

      <div className="bg-gradient-to-br from-gray-800 to-gray-900 rounded-xl border border-gray-700 overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-gray-800/50 border-b border-gray-700">
                {showRank && (
                  <th className="px-6 py-4 text-left font-semibold text-gray-300 text-sm uppercase tracking-wider">
                    #
                  </th>
                )}
                {data.columns.map((col, idx) => {
                  const containsBr = typeof col === 'string' && col.includes('<br>');
                  return (
                    <th
                      key={idx}
                      onClick={() => handleSort(idx)}
                      className="px-6 py-4 text-left font-semibold text-gray-300 text-sm uppercase tracking-wider cursor-pointer hover:bg-gray-700/50 transition-colors whitespace-nowrap"
                    >
                      <div className="flex items-center gap-2">
                        {containsBr ? (
                          <span dangerouslySetInnerHTML={{ __html: col }} />
                        ) : (
                          <span>{col}</span>
                        )}
                        {sortColumn === idx && (
                          <span className="text-green-500">
                            {sortDirection === 'asc' ? '↑' : '↓'}
                          </span>
                        )}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700">
              {filteredAndSortedData.length === 0 ? (
                <tr>
                  <td
                    colSpan={data.columns.length + (showRank ? 1 : 0)}
                    className="px-6 py-12 text-center text-gray-400"
                  >
                    Nessun risultato trovato
                  </td>
                </tr>
              ) : (
                filteredAndSortedData.map((row, rowIdx) => (
                  <tr
                    key={rowIdx}
                    className="hover:bg-gray-800/50 transition-colors group"
                  >
                    {showRank && (
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <span className="text-gray-400 font-medium">{rowIdx + 1}</span>
                          {rowIdx < 3 && (
                            <span className="text-xl">
                              {rowIdx === 0 ? '🥇' : rowIdx === 1 ? '🥈' : '🥉'}
                            </span>
                          )}
                        </div>
                      </td>
                    )}
                    {row.map((cell, cellIdx) => {
                      const columnName = data.columns[cellIdx];
                      const formattedValue = formatValue(cell, columnName);
                      
                      if (typeof formattedValue === 'string' && formattedValue.startsWith('data:image')) {
                        // Trova il nome dell'artista/canzone/album dalla prima colonna che non è un'immagine
                        const artistName = row.find((cell, idx) => {
                          const colName = data.columns[idx];
                          return (colName && typeof colName === 'string' && 
                                  (colName.toLowerCase().includes('artist') || 
                                   colName.toLowerCase().includes('track') || 
                                   colName.toLowerCase().includes('album')) &&
                                  typeof cell === 'string' && 
                                  !cell.startsWith('data:image'));
                        }) || row[0] || `Riga ${rowIdx + 1}`;
                        
                        const nameStr = typeof artistName === 'string' ? artistName : String(artistName);
                        
                        // Funzione per normalizzare i nomi per il confronto
                        const normalizeName = (name: string): string => {
                          return name
                            .toLowerCase()
                            .trim()
                            .replace(/\s+/g, ' ')
                            .replace(/~~sep~~/g, ' ')
                            .replace(/\(feat\./gi, '(feat.')
                            .replace(/\(by/gi, '(by');
                        };
                        
                        const normalizedNameStr = normalizeName(nameStr);
                        
                        // Cerca i dati mensili nel cache
                        let monthlyData: Array<{ month: string; play_count: number }> | null = null;
                        if (monthlyDataCache) {
                          // Cerca in tutte le chiavi del cache
                          for (const cacheKey in monthlyDataCache) {
                            if (cacheKey.includes('monthly_data') && Array.isArray(monthlyDataCache[cacheKey])) {
                              // Prima prova match esatto
                              let item = monthlyDataCache[cacheKey].find((item: any) => {
                                const itemName = item.artist || item.track || item.album;
                                if (!itemName) return false;
                                const normalizedItemName = normalizeName(String(itemName));
                                return normalizedItemName === normalizedNameStr;
                              });
                              
                              // Se non trova, prova corrispondenza parziale (per gestire il caso "track~~sep~~artist")
                              if (!item) {
                                item = monthlyDataCache[cacheKey].find((item: any) => {
                                  const itemName = String(item.artist || item.track || item.album);
                                  if (!itemName) return false;
                                  const normalizedItemName = normalizeName(itemName);
                                  // Controlla se il nome normalizzato contiene il nome cercato o viceversa
                                  return normalizedItemName.includes(normalizedNameStr) || 
                                         normalizedNameStr.includes(normalizedItemName) ||
                                         // Oppure se il nome contiene "~~sep~~", estrai solo la parte del track
                                         (itemName.includes('~~sep~~') && normalizeName(itemName.split('~~sep~~')[0]) === normalizedNameStr);
                                });
                              }
                              
                              if (item && item.data && Array.isArray(item.data)) {
                                monthlyData = item.data;
                                break;
                              }
                            }
                          }
                        }
                        
                        // Log per debug - mostra anche tutte le colonne della riga per capire meglio
                        if (!monthlyData && monthlyDataCache) {
                          console.log('[DataTable] Dati mensili non trovati per:', nameStr, 'Normalizzato:', normalizedNameStr);
                          console.log('[DataTable] Colonne disponibili:', data.columns);
                          console.log('[DataTable] Valori riga:', row.map((cell, idx) => ({
                            col: data.columns[idx],
                            value: typeof cell === 'string' ? cell.substring(0, 50) : cell
                          })));
                          console.log('[DataTable] Cache keys:', Object.keys(monthlyDataCache));
                          if (monthlyDataCache[Object.keys(monthlyDataCache)[0]]) {
                            const cacheArray = monthlyDataCache[Object.keys(monthlyDataCache)[0]] as any[];
                            const firstFew = cacheArray.slice(0, 5);
                            console.log('[DataTable] Primi elementi nel cache:', firstFew.map((item: any) => ({
                              name: item.artist || item.track || item.album,
                              normalized: normalizeName(String(item.artist || item.track || item.album)),
                              hasData: !!item.data
                            })));
                            // Prova a trovare una corrispondenza parziale
                            const partialMatch = cacheArray.find((item: any) => {
                              const itemName = String(item.artist || item.track || item.album);
                              return itemName.toLowerCase().includes(normalizedNameStr) || 
                                     normalizedNameStr.includes(itemName.toLowerCase());
                            });
                            if (partialMatch) {
                              console.log('[DataTable] Trovata corrispondenza parziale:', partialMatch);
                            }
                          }
                        }
                        
                        return (
                          <td key={cellIdx} className="px-6 py-4">
                            <div 
                              className="cursor-pointer hover:opacity-80 transition-opacity relative group"
                              onClick={() => {
                                console.log('[DataTable] Click su immagine:', nameStr, 'monthlyData:', monthlyData);
                                if (monthlyData && monthlyData.length > 0) {
                                  console.log('[DataTable] Apertura modal con dati:', monthlyData);
                                  setSelectedChart({ 
                                    monthlyData, 
                                    title: `${nameStr} - ${columnName.replace(/<br>/gi, ' ')}` 
                                  });
                                } else {
                                  console.warn('[DataTable] Nessun dato mensile disponibile per:', nameStr);
                                  alert('Dati mensili non disponibili. Ricarica i dati Spotify per vedere i grafici interattivi.');
                                }
                              }}
                            >
                              <img 
                                src={formattedValue} 
                                alt="Monthly play count" 
                                className="h-12 rounded"
                              />
                              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 rounded transition-colors flex items-center justify-center">
                                <span className="opacity-0 group-hover:opacity-100 text-white text-xs font-semibold bg-gray-900/80 px-2 py-1 rounded">
                                  🔍 Clicca per grafico interattivo
                                </span>
                              </div>
                            </div>
                          </td>
                        );
                      }
                      
                      // Se il valore contiene <br>, renderizzalo come HTML
                      const containsBr = typeof formattedValue === 'string' && formattedValue.includes('<br>');
                      
                      return (
                        <td key={cellIdx} className="px-6 py-4 text-gray-300 group-hover:text-white transition-colors">
                          {containsBr ? (
                            <span dangerouslySetInnerHTML={{ __html: formattedValue as string }} />
                          ) : (
                            formattedValue
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {filteredAndSortedData.length > 0 && (
          <div className="px-6 py-3 bg-gray-800/50 border-t border-gray-700 text-sm text-gray-400">
            Mostrando {filteredAndSortedData.length} di {data.data.length} risultati
          </div>
        )}
      </div>
      {selectedChart && (
        <ChartModal
          isOpen={!!selectedChart}
          monthlyData={selectedChart.monthlyData}
          title={selectedChart.title}
          onClose={() => setSelectedChart(null)}
        />
      )}
    </div>
  );
}
