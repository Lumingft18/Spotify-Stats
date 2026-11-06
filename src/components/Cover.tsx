import { useState } from 'react';
import { nameGradient } from '../lib/color';
import { cx } from './ui';
import { coverSrc } from '../lib/api';

export function Cover({
  src,
  name,
  size = 48,
  round = false,
  className,
}: {
  src?: string | null;
  name: string;
  size?: number | 'fill';
  round?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const style = size === 'fill' ? undefined : { width: size, height: size };
  const initials = name
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  return (
    <div
      className={cx(
        'relative shrink-0 overflow-hidden bg-surface-3',
        round ? 'rounded-full' : 'rounded-lg',
        size === 'fill' && 'aspect-square w-full',
        className,
      )}
      style={{ ...style, background: !src || failed ? nameGradient(name) : undefined }}
    >
      {src && !failed ? (
        <img
          src={coverSrc(src) ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          crossOrigin="anonymous"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center font-medium text-white/80"
          style={{ fontSize: typeof size === 'number' ? Math.max(10, size * 0.32) : 28 }}
        >
          {initials || '♪'}
        </span>
      )}
    </div>
  );
}
