// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { DataFrameData, BasicStats } from '../types';

export function formatNumber(num: number): string {
  return num.toLocaleString('en-US');
}

export function hoursToStr(hours: number): string {
  if (hours >= 10) {
    return Math.round(hours) + 'h';
  } else {
    return Math.floor(hours) + ':' + String(Math.round((hours % 1) * 60)).padStart(2, '0') + 'h';
  }
}

export function formatValue(value: string | number, columnName: string): string {
  if (typeof value === 'number') {
    if (columnName === 'hours played') {
      return hoursToStr(value);
    }
    return formatNumber(value);
  }
  if (typeof value === 'string' && value.slice(0, 22) === 'data:image/bmp;base64,') {
    return value; // Return image data as is
  }
  return value;
}

export function changeTextFromIToYou(text: string): string {
  text = text.replace(/\. I\b/g, '. You');
  text = text.replace(/<li>I\b/g, '<li>You');
  text = text.replace(/\bI\b/g, 'you');
  text = text.replace(/\bMy\b/g, 'Your');
  text = text.replace(/\bmy\b/g, 'your');
  return text;
}

export function formatText(text: string, stats: BasicStats, isUserData: boolean = false): string {
  if (isUserData) {
    text = changeTextFromIToYou(text);
  }
  
  Object.keys(stats).forEach((key) => {
    const pattern = new RegExp(`{${key}}`, 'g');
    let value = stats[key as keyof BasicStats];
    if (typeof value === 'number') {
      value = formatNumber(value) as any;
    }
    text = text.replace(pattern, String(value));
  });
  
  return text;
}

export function selectTickInterval(maxTime: number): number {
  const intervals = [1, 2, 5, 10, 15, 20, 30, 60];
  const maxTimeInMinutes = maxTime * 60;

  for (const interval of intervals) {
    if (maxTimeInMinutes / interval <= 7) {
      return interval;
    }
  }
  return 60;
}

export function getPlotLayout(title: string, xUnit: string, yUnit: string, percent: boolean = false) {
  const layout: any = {
    font: { family: 'Inter, system-ui, sans-serif', size: 14 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    margin: { l: 60, r: 40, b: 100, t: 60 }, // Aumentato il margin bottom per le date
    title: { text: title, font: { size: 18, color: '#1DB954' } },
    xaxis: { 
      title: { text: xUnit }, 
      gridcolor: 'rgba(255,255,255,0.1)',
      tickangle: -45, // Ruota le etichette delle date di 45 gradi
      automargin: true, // Abilita il margine automatico per le etichette
    },
    yaxis: { title: { text: yUnit }, rangemode: 'tozero', gridcolor: 'rgba(255,255,255,0.1)' },
  };
  
  if (percent) {
    layout.yaxis.range = [0, 101];
  }
  
  return layout;
}

export function getPlotConfig() {
  return {
    displayModeBar: false,
    staticPlot: window.innerWidth < 850,
    responsive: true,
  };
}

