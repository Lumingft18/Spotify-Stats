import { useState } from 'react';
import { Smartphone } from 'lucide-react';
import { exportStory, type StoryCardSpec } from '../lib/storyCard';
import { Button, Spinner } from './ui';

/** "Storia" button: exports the current view as a 1080×1920 PNG for Instagram Stories. */
export function StoryButton({
  build,
  label = 'Storia',
  size = 'sm',
  variant = 'secondary',
  className,
}: {
  /** Returns null while data is still loading. */
  build: () => StoryCardSpec | null | Promise<StoryCardSpec | null>;
  label?: string;
  size?: 'sm' | 'md';
  variant?: 'primary' | 'secondary' | 'ghost';
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const spec = await build();
      if (!spec) throw new Error('Dati non ancora pronti');
      await exportStory(spec);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      onClick={() => void run()}
      disabled={busy}
      title={err ?? 'Esporta PNG 1080×1920 per le storie Instagram'}
      aria-label={`${label}: esporta PNG per storie Instagram`}
    >
      {busy ? <Spinner size={14} /> : <Smartphone size={14} />}
      {err ? 'Riprova' : label}
    </Button>
  );
}
