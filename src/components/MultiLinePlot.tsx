import { useEffect, useRef } from 'react';
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
}

export function MultiLinePlot({
  title,
  data,
  xColumn,
  yColumns,
  yUnit,
  stacked = false,
  barChart = false,
}: MultiLinePlotProps) {
  const plotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!plotRef.current || !data.data.length) return;

    const xCol = xColumn || data.columns[0];
    const yCols = yColumns || data.columns.slice(1);

    const xIndex = data.columns.indexOf(xCol);
    const x = data.data.map((row) => row[xIndex]);

    const traces: any[] = yCols.map((yCol) => {
      const yIndex = data.columns.indexOf(yCol);
      const y = data.data.map((row) => row[yIndex]);

      const trace: any = {
        x,
        y,
        mode: barChart ? undefined : 'lines',
        name: yCol.replaceAll(' by ', ' by<br>'),
        hovertemplate: `%{x}<br>%{y:,} ${yUnit}<extra></extra>`,
      };

      if (stacked) {
        trace.stackgroup = 'one';
      }

      if (barChart) {
        trace.type = 'bar';
        trace.marker = { color: '#1DB954' };
      } else {
        trace.type = 'scatter';
        trace.line = { width: 3 };
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
  }, [title, data, xColumn, yColumns, yUnit, stacked, barChart]);

  return <div ref={plotRef} className="w-full my-8" style={{ minHeight: '400px' }} />;
}

