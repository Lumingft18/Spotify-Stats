import { useEffect } from 'react';
import { coverSrc } from './api';

const cache = new Map<string, string>();

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

/** Extracts a vivid, readable accent color from an image (CORS-enabled). Clamped for AA contrast on dark bg. */
export function extractAccent(src: string): Promise<string | null> {
  const hit = cache.get(src);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 32;
        const ctx = c.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0, 32, 32);
        const { data } = ctx.getImageData(0, 0, 32, 32);
        // Hue histogram weighted by saturation; pick the strongest bucket.
        const buckets = new Array(24).fill(0).map(() => ({ w: 0, s: 0, h: 0 }));
        for (let i = 0; i < data.length; i += 4) {
          const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
          if (l < 0.12 || l > 0.92 || s < 0.18) continue;
          const b = buckets[Math.floor(h / 15) % 24];
          const w = s * (1 - Math.abs(l - 0.55));
          b.w += w;
          b.s += s * w;
          b.h += h * w;
        }
        const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
        let color: string;
        if (best.w < 2) {
          // Black & white / desaturated covers: keep the brand accent.
          resolve(null);
          return;
        } else {
          const hue = best.h / best.w;
          const sat = Math.min(0.85, Math.max(0.45, best.s / best.w));
          // Lightness fixed at 68% → readable on the dark surfaces (≥ 4.5:1).
          color = `hsl(${hue.toFixed(0)} ${(sat * 100).toFixed(0)}% 68%)`;
        }
        cache.set(src, color);
        resolve(color);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = coverSrc(src) ?? src;
  });
}

/** Sets the global --accent from a cover while the component is mounted. */
export function useAccentFrom(src: string | null | undefined) {
  useEffect(() => {
    if (!src) return;
    let alive = true;
    void extractAccent(src).then((c) => {
      if (alive && c) document.documentElement.style.setProperty('--accent', c);
    });
    return () => {
      alive = false;
      document.documentElement.style.removeProperty('--accent');
    };
  }, [src]);
}

/** Deterministic pleasant gradient for entities without cover art. */
export function nameGradient(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const a = h % 360;
  const b = (a + 40 + ((h >> 8) % 60)) % 360;
  return `linear-gradient(135deg, hsl(${a} 45% 32%), hsl(${b} 55% 22%))`;
}

/** Colours of the taste-map groups (same in the app and in the PDF). */
export const CLUSTER_COLORS = ['#e8b94a', '#5cc6c0', '#e0604f', '#7f7bd6', '#8fd16a', '#e98ac0', '#4fa3e0', '#d9a066', '#b5e3d8', '#c7a3ff', '#f2d16b', '#6fd6a8', '#ff9f7a', '#9ab0ff'];
