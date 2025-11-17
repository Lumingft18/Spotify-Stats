import { useEffect, useRef } from 'react';
// @ts-ignore
import Plotly from 'plotly.js-dist-min';
import type { DataFrameData } from '../types';
import { getPlotLayout, getPlotConfig } from '../utils/dataProcessing';

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

  useEffect(() => {
    if (!plotRef.current || !data.data.length) return;

    const xCol = xColumn || data.columns[0];
    const yCols = yColumns || data.columns.slice(1);

    const xIndex = data.columns.indexOf(xCol);
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

    const traces: any[] = yCols.map((yCol) => {
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

    const layout = getPlotLayout(title, xCol, yUnit);
    if (barChart && stacked) {
      layout.barmode = 'stack';
    }

    Plotly.newPlot(plotRef.current, traces, layout, getPlotConfig());

    return () => {
      if (plotRef.current) {
        Plotly.purge(plotRef.current);
      }
    };
  }, [title, data, xColumn, yColumns, yUnit, stacked, barChart, seriesColors]);

  return <div ref={plotRef} className="w-full my-8" style={{ minHeight: '400px' }} />;
}

