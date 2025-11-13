import { useEffect, useRef } from 'react';
import Plotly from 'plotly.js-dist-min';
import type { DataFrameData } from '../types';
import { getPlotLayout, getPlotConfig, selectTickInterval } from '../utils/dataProcessing';

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

  useEffect(() => {
    if (!plotRef.current || !data.data.length) return;

    const xCol = xColumn || data.columns[0];
    const yCol = yColumn || data.columns[1];

    const xIndex = data.columns.indexOf(xCol);
    const yIndex = data.columns.indexOf(yCol);

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

    Plotly.newPlot(plotRef.current, traces, layout, getPlotConfig());

    return () => {
      if (plotRef.current) {
        Plotly.purge(plotRef.current);
      }
    };
  }, [title, data, xColumn, yColumn, type, percent, yHour, yMinute, yAxisYear]);

  return <div ref={plotRef} className="w-full my-8" style={{ minHeight: '400px' }} />;
}

