import { extractAccent } from './color';

/**
 * Instagram-Stories PNG export (1080×1920, 9:16, opaque sRGB).
 * Content is kept inside the IG safe zone (top ~250px and bottom ~300px are covered by the app UI).
 */

export interface StoryRow {
  label: string;
  sub?: string;
  value?: string;
  image?: string | null;
  round?: boolean;
}

export interface StoryCardSpec {
  /** Small uppercase line on top, e.g. "IL MIO 2024 IN MUSICA". */
  kicker: string;
  /** Big serif title (artist / album / page name). */
  title?: string;
  /** Line under the title. */
  subtitle?: string;
  /** Cover shown next to the title. */
  image?: string | null;
  roundImage?: boolean;
  /** Headline number. */
  hero?: { value: string; unit?: string };
  /** Up to 4 small stats (2×2 grid). */
  stats?: Array<{ label: string; value: string }>;
  /** Mini bar chart. */
  bars?: { title: string; values: number[]; from?: string; to?: string; highlight?: number };
  sections?: Array<{ title: string; rows: StoryRow[] }>;
  /** Free text, wrapped (caption / insight). */
  note?: string;
  /** Color source for the accent; defaults to `image`. */
  accentFrom?: string | null;
  accent?: string;
  /** File name without extension. */
  filename: string;
}

export const STORY_W = 1080;
export const STORY_H = 1920;
const SAFE_TOP = 250;
const SAFE_BOTTOM = STORY_H - 300;
const X = 90;
const CW = STORY_W - X * 2;

const C = { text: '#f4f5f8', muted: '#9aa0ab', faint: '#5b6170', line: '#2a2e38' };
const SANS = '"Geist Variable", system-ui, sans-serif';
const SERIF = '"Instrument Serif", Georgia, serif';
const MONO = '"Geist Mono Variable", ui-monospace, monospace';

function loadImg(src: string): Promise<HTMLImageElement | null> {
  return new Promise((res) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.onload = () => res(i);
    i.onerror = () => res(null);
    i.src = src;
  });
}

function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s.trimEnd() + '…';
}

function wrap(ctx: CanvasRenderingContext2D, text: string, max: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= max || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = fit(ctx, kept[maxLines - 1] + ' ' + lines.slice(maxLines).join(' '), max);
    return kept;
  }
  return lines.map((l) => fit(ctx, l, max));
}

function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, name: string, x: number, y: number, s: number, round: boolean) {
  ctx.save();
  ctx.beginPath();
  if (round) ctx.arc(x + s / 2, y + s / 2, s / 2, 0, Math.PI * 2);
  else ctx.roundRect(x, y, s, s, Math.max(8, s * 0.08));
  ctx.clip();
  if (img) {
    // center-crop to square
    const m = Math.min(img.width, img.height);
    ctx.drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, x, y, s, s);
  } else {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    const a = h % 360;
    const g = ctx.createLinearGradient(x, y, x + s, y + s);
    g.addColorStop(0, `hsl(${a} 45% 32%)`);
    g.addColorStop(1, `hsl(${(a + 60) % 360} 55% 22%)`);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, s, s);
  }
  ctx.restore();
}

type Images = Map<string, HTMLImageElement | null>;

/** Lays out (and optionally draws) the card; returns the bottom y. */
function layout(ctx: CanvasRenderingContext2D, spec: StoryCardSpec, accent: string, imgs: Images, draw: boolean): number {
  let y = SAFE_TOP;
  const paint = (fn: () => void) => draw && fn();

  // Kicker
  ctx.font = `500 34px ${SANS}`;
  ctx.fillStyle = C.muted;
  y += 34;
  paint(() => ctx.fillText(fit(ctx, spec.kicker.toUpperCase(), CW), X, y));
  y += 50;

  // Title block (with optional cover)
  if (spec.title) {
    const s = spec.image !== undefined ? 300 : 0;
    if (s) {
      paint(() => drawCover(ctx, imgs.get(spec.image ?? '') ?? null, spec.title!, X, y, s, !!spec.roundImage));
      y += s + 50;
    }
    ctx.font = `400 120px ${SERIF}`;
    const lines = wrap(ctx, spec.title, CW, 2);
    for (const l of lines) {
      y += 110;
      paint(() => {
        ctx.fillStyle = C.text;
        ctx.fillText(l, X, y);
      });
    }
    y += 20;
    if (spec.subtitle) {
      ctx.font = `400 38px ${SANS}`;
      y += 44;
      paint(() => {
        ctx.fillStyle = C.muted;
        ctx.fillText(fit(ctx, spec.subtitle!, CW), X, y);
      });
      y += 20;
    }
    y += 30;
  }

  // Hero number
  if (spec.hero) {
    ctx.font = `400 ${spec.title ? 170 : 230}px ${SERIF}`;
    y += spec.title ? 150 : 200;
    const v = fit(ctx, spec.hero.value, CW);
    paint(() => {
      ctx.fillStyle = C.text;
      ctx.fillText(v, X - 6, y);
    });
    if (spec.hero.unit) {
      ctx.font = `400 80px ${SERIF}`;
      y += 95;
      paint(() => {
        ctx.fillStyle = accent;
        ctx.fillText(fit(ctx, spec.hero!.unit!, CW), X, y);
      });
    }
    y += 60;
  }

  // Stats grid
  if (spec.stats?.length) {
    const st = spec.stats.slice(0, 4);
    const colW = CW / 2;
    for (let i = 0; i < st.length; i += 2) {
      for (let j = 0; j < 2 && i + j < st.length; j++) {
        const s = st[i + j];
        const x = X + j * colW;
        paint(() => {
          ctx.font = `500 30px ${SANS}`;
          ctx.fillStyle = C.muted;
          ctx.fillText(fit(ctx, s.label.toUpperCase(), colW - 30), x, y + 30);
          ctx.font = `500 64px ${SANS}`;
          ctx.fillStyle = C.text;
          ctx.fillText(fit(ctx, s.value, colW - 30), x, y + 104);
        });
      }
      y += 150;
    }
    y += 20;
  }

  // Bars
  if (spec.bars && spec.bars.values.length > 1) {
    const b = spec.bars;
    paint(() => {
      ctx.font = `500 32px ${SANS}`;
      ctx.fillStyle = C.muted;
      ctx.fillText(fit(ctx, b.title.toUpperCase(), CW), X, y + 32);
    });
    y += 60;
    const h = 200;
    const max = Math.max(...b.values, 1e-9);
    const n = b.values.length;
    const gap = n > 40 ? 2 : 6;
    const bw = Math.max(2, (CW - gap * (n - 1)) / n);
    paint(() => {
      b.values.forEach((v, i) => {
        const bh = Math.max(4, (v / max) * h);
        ctx.fillStyle = accent;
        ctx.globalAlpha = b.highlight == null || b.highlight === i ? 1 : 0.4;
        ctx.beginPath();
        ctx.roundRect(X + i * (bw + gap), y + h - bh, bw, bh, Math.min(6, bw / 2));
        ctx.fill();
      });
      ctx.globalAlpha = 1;
      ctx.font = `400 28px ${MONO}`;
      ctx.fillStyle = C.faint;
      if (b.from) ctx.fillText(b.from, X, y + h + 42);
      if (b.to) {
        const w = ctx.measureText(b.to).width;
        ctx.fillText(b.to, X + CW - w, y + h + 42);
      }
    });
    y += h + 90;
  }

  // Sections
  for (const sec of spec.sections ?? []) {
    if (!sec.rows.length) continue;
    paint(() => {
      ctx.font = `500 32px ${SANS}`;
      ctx.fillStyle = C.muted;
      ctx.fillText(fit(ctx, sec.title.toUpperCase(), CW), X, y + 32);
    });
    y += 60;
    const withImg = sec.rows.some((r) => r.image !== undefined);
    const rowH = withImg ? 116 : 96;
    for (const [i, r] of sec.rows.entries()) {
      paint(() => {
        let tx = X;
        if (withImg) {
          drawCover(ctx, imgs.get(r.image ?? '') ?? null, r.label, X, y + 4, 96, !!r.round);
          tx = X + 96 + 30;
        } else {
          ctx.font = `500 40px ${MONO}`;
          ctx.fillStyle = accent;
          ctx.fillText(String(i + 1), X, y + 46);
          tx = X + 60;
        }
        let right = X + CW;
        if (r.value) {
          ctx.font = `500 34px ${MONO}`;
          ctx.fillStyle = C.muted;
          const w = ctx.measureText(r.value).width;
          ctx.fillText(r.value, right - w, y + (r.sub ? 46 : 58));
          right -= w + 24;
        }
        const tw = right - tx;
        ctx.font = `500 44px ${SANS}`;
        ctx.fillStyle = C.text;
        ctx.fillText(fit(ctx, r.label, tw), tx, y + (r.sub ? 46 : 62));
        if (r.sub) {
          ctx.font = `400 32px ${SANS}`;
          ctx.fillStyle = C.muted;
          ctx.fillText(fit(ctx, r.sub, tw), tx, y + 90);
        }
      });
      y += rowH;
    }
    y += 40;
  }

  // Note
  if (spec.note) {
    ctx.font = `400 58px ${SERIF}`;
    const lines = wrap(ctx, spec.note, CW, 14);
    for (const l of lines) {
      y += 66;
      paint(() => {
        ctx.fillStyle = C.text;
        ctx.fillText(l, X, y);
      });
    }
    y += 30;
  }
  return y;
}

/** Drops rows/blocks until the layout fits the IG safe area. */
function shrink(spec: StoryCardSpec): StoryCardSpec | null {
  const secs = spec.sections?.map((s) => ({ ...s, rows: [...s.rows] })) ?? [];
  const biggest = secs.reduce<(typeof secs)[number] | null>((a, b) => (b.rows.length > (a?.rows.length ?? 0) ? b : a), null);
  if (biggest && biggest.rows.length > 3) {
    biggest.rows.pop();
    return { ...spec, sections: secs };
  }
  if (spec.note) {
    const words = spec.note.split(' ');
    if (words.length > 12) return { ...spec, note: words.slice(0, Math.floor(words.length * 0.85)).join(' ') + '…' };
    return { ...spec, note: undefined };
  }
  if (spec.bars) return { ...spec, bars: undefined };
  if (biggest && biggest.rows.length > 1) {
    biggest.rows.pop();
    return { ...spec, sections: secs };
  }
  if (spec.stats && spec.stats.length > 2) return { ...spec, stats: spec.stats.slice(0, 2) };
  if (spec.image !== undefined) return { ...spec, image: undefined };
  return null;
}

export async function renderStoryCard(input: StoryCardSpec): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = STORY_W;
  c.height = STORY_H;
  const ctx = c.getContext('2d', { alpha: false })!;
  ctx.textBaseline = 'alphabetic';
  await document.fonts.ready;

  const accentSrc = input.accentFrom ?? input.image ?? input.sections?.flatMap((s) => s.rows).find((r) => r.image)?.image;
  const accent = input.accent ?? (accentSrc && (await extractAccent(accentSrc))) ?? '#8fd16a';

  const srcs = new Set<string>();
  if (input.image) srcs.add(input.image);
  input.sections?.forEach((s) => s.rows.forEach((r) => r.image && srcs.add(r.image)));
  const imgs: Images = new Map(await Promise.all([...srcs].map(async (s) => [s, await loadImg(s)] as const)));

  let spec = input;
  while (layout(ctx, spec, accent, imgs, false) > SAFE_BOTTOM) {
    const next = shrink(spec);
    if (!next) break;
    spec = next;
  }

  // Background
  const g = ctx.createLinearGradient(0, 0, 0, STORY_H);
  g.addColorStop(0, '#20232c');
  g.addColorStop(1, '#0f1116');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, STORY_W, STORY_H);
  const hero = spec.image ? imgs.get(spec.image) : null;
  if (hero) {
    ctx.save();
    ctx.filter = 'blur(60px) saturate(1.3)';
    ctx.globalAlpha = 0.35;
    const m = Math.min(hero.width, hero.height);
    ctx.drawImage(hero, (hero.width - m) / 2, (hero.height - m) / 2, m, m, -200, -200, STORY_W + 400, STORY_W + 400);
    ctx.restore();
    const fade = ctx.createLinearGradient(0, STORY_W * 0.3, 0, STORY_W + 200);
    fade.addColorStop(0, 'rgba(15,17,22,0)');
    fade.addColorStop(1, '#14161c');
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, STORY_W, STORY_W + 200);
  }
  ctx.save();
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.22;
  ctx.beginPath();
  ctx.arc(STORY_W * 0.88, 240, 420, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  layout(ctx, spec, accent, imgs, true);

  ctx.font = `400 30px ${MONO}`;
  ctx.fillStyle = C.faint;
  ctx.fillText('ascolti · calcolato in locale', X, SAFE_BOTTOM + 70);

  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Export PNG fallito'))), 'image/png'));
}

export function storySlug(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'storia'
  );
}

/** Renders and hands the PNG to the share sheet (mobile → Instagram) or downloads it. */
export async function exportStory(spec: StoryCardSpec): Promise<void> {
  const blob = await renderStoryCard(spec);
  const name = `ascolti-${storySlug(spec.filename)}-story.png`;
  const file = new File([blob], name, { type: 'image/png' });
  const mobile = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  if (mobile && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Human label for the global period filter. */
export function periodLabel(range: { from: string | null; to: string | null }): string {
  const { from, to } = range;
  if (!from && !to) return 'tutta la mia musica';
  const y = from?.slice(0, 4);
  if (from && to && from === `${y}-01-01` && to === `${y}-12-31`) return `il mio ${y}`;
  const f = (d: string) => d.split('-').reverse().join('/');
  return `${from ? f(from) : 'inizio'} – ${to ? f(to) : 'oggi'}`;
}
