import { useEffect, useRef } from 'react';
// @ts-ignore
import Plotly from 'plotly.js-dist-min';
import type { DataFrameData } from '../types';

interface ChartModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  data: DataFrameData;
  plotType: 'plot' | 'multiline';
  plotProps?: {
    xColumn?: string;
    yColumn?: string;
    yColumns?: string[];
    type?: 'bar' | 'scatter' | 'line';
    percent?: boolean;
    yHour?: boolean;
    yMinute?: boolean;
    yAxisYear?: boolean;
    yUnit?: string;
    stacked?: boolean;
    barChart?: boolean;
    seriesColors?: Record<string, string>;
  };
}

export function ChartModal({ isOpen, onClose, title, data, plotType, plotProps = {} }: ChartModalProps) {
  const plotRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Gestisci il tasto ESC per chiudere il modal
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
    if (!isOpen || !plotRef.current || !containerRef.current) return;

    const handleResize = () => {
      if (plotRef.current) {
        Plotly.Plots.resize(plotRef.current);
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

  useEffect(() => {
    if (!isOpen || !plotRef.current) return;
    
    // Se non ci sono dati, pulisci il grafico
    if (!data || !data.data || !data.data.length) {
      if (plotRef.current) {
        Plotly.purge(plotRef.current);
      }
      return;
    }

    if (plotType === 'plot') {
      const xCol = plotProps.xColumn || data.columns[0];
      const yCol = plotProps.yColumn || data.columns[1];

      const xIndex = data.columns.indexOf(xCol);
      const yIndex = data.columns.indexOf(yCol);

      if (xIndex < 0 || yIndex < 0) {
        console.warn('[ChartModal] Colonne non trovate:', { xCol, yCol, columns: data.columns });
        return;
      }

      const x = data.data.map((row) => row[xIndex]);
      const y = data.data.map((row) => row[yIndex]);

      const yUnit = plotProps.percent ? '%' : yCol;

      let traces: any = [];
      
      if (plotProps.type === 'bar') {
        traces = [
          {
            x,
            y,
            type: 'bar',
            name: '',
            hovertemplate: `%{x}<br>%{y:,} ${yUnit}<extra></extra>`,
            marker: { color: '#1DB954' },
          },
        ];
      } else if (plotProps.type === 'scatter') {
        traces = [
          {
            x,
            y,
            type: 'scatter',
            mode: 'markers+lines',
            name: '',
            hovertemplate: `%{x}<br>%{y:,} ${yUnit}<extra></extra>`,
            marker: { color: '#1DB954', size: 6 },
            line: { color: '#1DB954', width: 3 },
          },
        ];
      } else {
        traces = [
          {
            x,
            y,
            type: 'scatter',
            mode: 'lines',
            name: '',
            hovertemplate: `%{x}<br>%{y:,} ${yUnit}<extra></extra>`,
            line: { color: '#1DB954', width: 3 },
          },
        ];
      }

      // Migliora il layout per periodi brevi con pochi dati
      const dataPoints = x.length;
      const layout: any = {
        font: { family: 'Inter, system-ui, sans-serif', size: 16 },
        paper_bgcolor: 'rgba(17, 24, 39, 0.95)',
        plot_bgcolor: 'rgba(17, 24, 39, 0.95)',
        margin: dataPoints <= 12 
          ? { l: 70, r: 50, b: 100, t: 70 } 
          : { l: 80, r: 60, b: 120, t: 80 },
        title: { text: title, font: { size: 24, color: '#1DB954' } },
        xaxis: { 
          title: { text: xCol, font: { size: 18 } }, 
          gridcolor: 'rgba(255,255,255,0.1)',
          tickangle: -45,
          automargin: true,
        },
        yaxis: { 
          title: { text: yUnit, font: { size: 18 } }, 
          rangemode: 'tozero', 
          gridcolor: 'rgba(255,255,255,0.1)' 
        },
      };
      
      if (plotProps.percent) {
        layout.yaxis.range = [0, 101];
      }

      if (plotProps.yAxisYear) {
        layout.xaxis.type = 'category';
        layout.xaxis.dtick = 1;
      }

      if (plotProps.yHour || plotProps.yMinute) {
        const maxTime = Math.max(...(y as number[]));
        const intervals = [1, 2, 5, 10, 15, 20, 30, 60];
        const maxTimeInMinutes = maxTime * 60;
        let tickInterval = 60;
        
        for (const interval of intervals) {
          if (maxTimeInMinutes / interval <= 7) {
            tickInterval = interval;
            break;
          }
        }

        const tickvals: number[] = [];
        const ticktext: string[] = [];
        
        for (let i = 0; i <= maxTime * 60 + tickInterval; i += tickInterval) {
          const hours = Math.floor(i / 60);
          const minutes = i % 60;
          tickvals.push(i / 60);
          ticktext.push(`${String(hours).padStart(1, '0')}:${String(minutes).padStart(2, '0')}`);
        }

        layout.yaxis.tickvals = tickvals;
        layout.yaxis.ticktext = ticktext;

        traces[0].hovertext = (y as number[]).map((value) => {
          const hours = Math.floor(value);
          const minutes = Math.round((value - hours) * 60);
          return `${String(hours).padStart(1, '0')}:${String(minutes).padStart(2, '0')}`;
        });

        traces[0].hovertemplate = '%{x}<br>%{hovertext}<extra></extra>';
      }

      Plotly.newPlot(plotRef.current, traces, layout, {
        displayModeBar: true,
        modeBarButtonsToRemove: ['pan2d', 'lasso2d'],
        responsive: true,
      }).then(() => {
        // Ridimensiona il grafico dopo il rendering iniziale
        if (plotRef.current) {
          Plotly.Plots.resize(plotRef.current);
        }
      });
    } else if (plotType === 'multiline') {
      const xCol = plotProps.xColumn || data.columns[0];
      const yCols = plotProps.yColumns || data.columns.slice(1);

      const xIndex = data.columns.indexOf(xCol);
      if (xIndex < 0) {
        console.warn('[ChartModal] Colonna X non trovata:', { xCol, columns: data.columns });
        return;
      }
      const x = data.data.map((row) => row[xIndex]);

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

        const traceColor = plotProps.seriesColors?.[yCol];

        const trace: any = {
          x,
          y,
          mode: plotProps.barChart ? undefined : 'lines',
          name: formatColumnName(yCol),
          hovertemplate: `%{x}<br>%{y:,} ${plotProps.yUnit || ''}<extra></extra>`,
        };

        if (plotProps.stacked) {
          trace.stackgroup = 'one';
        }

        if (plotProps.barChart) {
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
        console.warn('[ChartModal] Nessuna traccia valida trovata');
        return;
      }

      // Migliora il layout per periodi brevi con pochi dati
      const dataPoints = x.length;
      const layout: any = {
        font: { family: 'Inter, system-ui, sans-serif', size: 16 },
        paper_bgcolor: 'rgba(17, 24, 39, 0.95)',
        plot_bgcolor: 'rgba(17, 24, 39, 0.95)',
        margin: dataPoints <= 12 
          ? { l: 70, r: 50, b: 100, t: 70 } 
          : { l: 80, r: 60, b: 120, t: 80 },
        title: { text: title, font: { size: 24, color: '#1DB954' } },
        xaxis: { 
          title: { text: xCol, font: { size: 18 } }, 
          gridcolor: 'rgba(255,255,255,0.1)',
          tickangle: -45,
          automargin: true,
        },
        yaxis: { 
          title: { text: plotProps.yUnit || '', font: { size: 18 } }, 
          rangemode: 'tozero', 
          gridcolor: 'rgba(255,255,255,0.1)' 
        },
      };

      if (plotProps.barChart && plotProps.stacked) {
        layout.barmode = 'stack';
      }

      Plotly.newPlot(plotRef.current, traces, layout, {
        displayModeBar: true,
        modeBarButtonsToRemove: ['pan2d', 'lasso2d'],
        responsive: true,
      }).then(() => {
        // Ridimensiona il grafico dopo il rendering iniziale
        if (plotRef.current) {
          Plotly.Plots.resize(plotRef.current);
        }
      });
    }

    return () => {
      if (plotRef.current) {
        Plotly.purge(plotRef.current);
      }
    };
  }, [isOpen, title, data, plotType, plotProps]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={containerRef}
        className="relative w-full h-full max-w-[95vw] max-h-[95vh] bg-gray-900 rounded-xl border border-gray-700 shadow-2xl p-6 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-white">{title}</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors text-3xl leading-none"
            aria-label="Chiudi"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          <div ref={plotRef} className="w-full h-full" style={{ minHeight: '500px', width: '100%' }} />
        </div>
        <div className="mt-4 text-sm text-gray-400 text-center">
          Clicca fuori dal grafico o premi ESC per chiudere
        </div>
      </div>
    </div>
  );
}

