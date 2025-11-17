import { useEffect, useRef, useState, useCallback } from 'react';
// @ts-ignore
import Plotly from 'plotly.js-dist-min';
import type { DataFrameData } from '../types';
import { getPlotLayout, getPlotConfig, selectTickInterval } from '../utils/dataProcessing';
import { ChartModal } from './ChartModal';

interface PlotProps {
  title: string;
  data: DataFrameData;
  xColumn?: string;
  yColumn?: string;
  type?: 'bar' | 'scatter' | 'line';
  percent?: boolean;
  yHour?: boolean;
  yMinute?: boolean;
  yAxisYear?: boolean;
}

export function Plot({
  title,
  data,
  xColumn,
  yColumn,
  type = 'bar',
  percent = false,
  yHour = false,
  yMinute = false,
  yAxisYear = false,
}: PlotProps) {
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
    const yCol = yColumn || data.columns[1];

    const xIndex = data.columns.indexOf(xCol);
    const yIndex = data.columns.indexOf(yCol);

    if (xIndex < 0 || yIndex < 0) {
      console.warn('[Plot] Colonne non trovate:', { xCol, yCol, columns: data.columns });
      return;
    }

    const x = data.data.map((row) => row[xIndex]);
    const y = data.data.map((row) => row[yIndex]);

    const yUnit = percent ? '%' : yCol;

    let traces: any = [];
    
    if (type === 'bar') {
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
    } else if (type === 'scatter') {
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
      // type === 'line'
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

    let layout: any = getPlotLayout(title, xCol, yUnit, percent);

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
      
      // Per grafici a barre con pochi dati, aumenta la larghezza delle barre
      if (type === 'bar' && dataPoints <= 12) {
        traces[0].marker.line = { width: 1, color: '#1DB954' };
      }
    }

    if (yAxisYear) {
      layout.xaxis.type = 'category';
      layout.xaxis.dtick = 1;
    }

    if (yHour || yMinute) {
      const maxTime = Math.max(...(y as number[]));
      const tickInterval = selectTickInterval(maxTime);

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

    // Usa react se il grafico è già stato inizializzato, altrimenti newPlot
    if (plotInitializedRef.current) {
      Plotly.react(plotRef.current, traces, layout, getPlotConfig());
    } else {
      Plotly.newPlot(plotRef.current, traces, layout, getPlotConfig());
      plotInitializedRef.current = true;
    }
  }, [title, data, xColumn, yColumn, type, percent, yHour, yMinute, yAxisYear]);

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
        plotType="plot"
        plotProps={{
          xColumn,
          yColumn,
          type,
          percent,
          yHour,
          yMinute,
          yAxisYear,
        }}
      />
    </>
  );
}

