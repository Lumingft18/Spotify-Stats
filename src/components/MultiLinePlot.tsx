import { useEffect, useRef, useState, useCallback } from 'react';
// @ts-ignore
import Plotly from 'plotly.js-dist-min';
import type { DataFrameData } from '../types';
import { getPlotLayout, getPlotConfig } from '../utils/dataProcessing';
import { ChartModal } from './ChartModal';

interface MultiLinePlotProps {
  title: string;
  data: DataFrameData;
  xColumn?: string;
  yColumns?: string[];
  yUnit: string;
  stacked?: boolean;
  barChart?: boolean;
  seriesColors?: Record<string, string>;
}

export function MultiLinePlot({
  title,
  data,
  xColumn,
  yColumns,
  yUnit,
  stacked = false,
  barChart = false,
  seriesColors,
}: MultiLinePlotProps) {
  const plotRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const plotInitializedRef = useRef(false);

  // Funzione per aggiornare il grafico
  const updatePlot = useCallback(() => {
    if (!plotRef.current) return;
    
    // Se non ci sono dati, pulisci il grafico
    if (!data || !data.data || !data.data.length) {
      if (plotInitializedRef.current && plotRef.current) {
        Plotly.purge(plotRef.current);
        plotInitializedRef.current = false;
      }
      return;
    }

    const xCol = xColumn || data.columns[0];
    const yCols = yColumns || data.columns.slice(1);

    const xIndex = data.columns.indexOf(xCol);
    if (xIndex < 0) {
      console.warn('[MultiLinePlot] Colonna X non trovata:', { xCol, columns: data.columns });
      return;
    }

    const x = data.data.map((row) => row[xIndex]);

    // Funzione per formattare i nomi delle colonne
    const moodColumnNames: Record<string, string> = {
      felice_percent: 'Felice',
      neutrale_percent: 'Neutrale',
      triste_percent: 'Triste',
      sconosciuto_percent: 'Sconosciuto',
      euforico_percent: 'Euforico',
      sereno_percent: 'Sereno',
      arrabbiato_percent: 'Arrabbiato',
      malinconico_percent: 'Malinconico',
    };

    const formatColumnName = (colName: string): string => {
      if (moodColumnNames[colName]) {
        return moodColumnNames[colName];
      }

      // Gestisci altri casi comuni
      return colName.replaceAll(' by ', ' by<br>').replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
    };

    const traces: any[] = yCols
      .filter((yCol) => {
        const yIndex = data.columns.indexOf(yCol);
        return yIndex >= 0;
      })
      .map((yCol) => {
        const yIndex = data.columns.indexOf(yCol);
        const y = data.data.map((row) => row[yIndex]);

        const traceColor = seriesColors?.[yCol];

        const trace: any = {
          x,
          y,
          mode: barChart ? undefined : 'lines',
          name: formatColumnName(yCol),
          hovertemplate: `%{x}<br>%{y:,} ${yUnit}<extra></extra>`,
        };

        if (stacked) {
          trace.stackgroup = 'one';
        }

        if (barChart) {
          trace.type = 'bar';
          trace.marker = { color: traceColor || '#1DB954' };
        } else {
          trace.type = 'scatter';
          trace.line = {
            width: 3,
            color: traceColor || '#22c55e',
          };
        }

        return trace;
      });

    if (traces.length === 0) {
      console.warn('[MultiLinePlot] Nessuna traccia valida trovata');
      return;
    }

    const layout = getPlotLayout(title, xCol, yUnit);
    
    // Migliora il layout per periodi brevi con pochi dati
    const dataPoints = x.length;
    if (dataPoints > 0) {
      // Adatta i margini in base al numero di punti dati
      if (dataPoints <= 12) {
        // Per pochi dati, riduci i margini e migliora la visualizzazione
        layout.margin = { l: 60, r: 40, b: 80, t: 60 };
        layout.xaxis.tickangle = -45;
        layout.xaxis.automargin = true;
      }
    }
    
    if (barChart && stacked) {
      layout.barmode = 'stack';
    }

    // Usa react se il grafico è già stato inizializzato, altrimenti newPlot
    if (plotInitializedRef.current) {
      Plotly.react(plotRef.current, traces, layout, getPlotConfig());
    } else {
      Plotly.newPlot(plotRef.current, traces, layout, getPlotConfig());
      plotInitializedRef.current = true;
    }
  }, [title, data, xColumn, yColumns, yUnit, stacked, barChart, seriesColors]);

  useEffect(() => {
    updatePlot();

    // Aggiungi listener per il double-click usando l'API corretta di Plotly
    const handleDoubleClick = () => {
      setIsModalOpen(true);
    };

    if (plotRef.current) {
      plotRef.current.addEventListener('dblclick', handleDoubleClick);
    }

    return () => {
      if (plotRef.current) {
        plotRef.current.removeEventListener('dblclick', handleDoubleClick);
      }
    };
  }, [updatePlot]);

  // Gestione del ridimensionamento della finestra e del contenitore
  useEffect(() => {
    if (!plotRef.current || !containerRef.current) return;

    const handleResize = () => {
      if (plotRef.current && plotInitializedRef.current) {
        Plotly.Plots.resize(plotRef.current);
      }
    };

    // ResizeObserver per monitorare i cambiamenti di dimensione del contenitore
    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });

    resizeObserver.observe(containerRef.current);
    window.addEventListener('resize', handleResize);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  // Cleanup quando il componente viene smontato
  useEffect(() => {
    return () => {
      if (plotRef.current) {
        Plotly.purge(plotRef.current);
        plotInitializedRef.current = false;
      }
    };
  }, []);

  return (
    <>
      <div ref={containerRef} className="relative w-full my-8" style={{ minHeight: '400px' }}>
        <div 
          ref={plotRef} 
          className="w-full" 
          style={{ minHeight: '400px', width: '100%' }}
        />
        {/* Pulsante per aprire in fullscreen */}
        <button
          onClick={() => setIsModalOpen(true)}
          className="absolute top-2 right-2 bg-gray-900/90 hover:bg-gray-800 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 shadow-lg transition-colors z-10"
          title="Apri in modalità fullscreen"
        >
          <span>🔍</span>
          <span>Ingrandisci</span>
        </button>
      </div>
      <ChartModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={title}
        data={data}
        plotType="multiline"
        plotProps={{
          xColumn,
          yColumns,
          yUnit,
          stacked,
          barChart,
          seriesColors,
        }}
      />
    </>
  );
}

