/// <reference types="vitest/config" />
import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ command, mode }) => {
  // Local keys from .env.local (gitignored). Injected ONLY for the local dev server:
  // a production build never contains them (no VITE_ prefix → not auto-exposed either).
  // .env.local wins over variables already set in the shell (e.g. another OPENROUTER_API_KEY).
  const fileEnv = existsSync('.env.local') ? (parseEnv(readFileSync('.env.local', 'utf8')) as Record<string, string>) : {}
  const env: Record<string, string | undefined> = { ...loadEnv(mode, process.cwd(), ''), ...fileEnv }
  const localKeys =
    command === 'serve'
      ? {
          openrouterKey: fileEnv.OPENROUTER_API_KEY || env.OPENROUTER_API_KEY || '',
          lastfmKey: fileEnv.LASTFM_API_KEY || env.LASTFM_API_KEY || '',
          llmModelBulk: fileEnv.LLM_MODEL_BULK || env.LLM_MODEL_BULK || '',
          llmModelAgent: fileEnv.LLM_MODEL_AGENT || env.LLM_MODEL_AGENT || '',
          lrclibAppId: fileEnv.LRCLIB_APP_ID || env.LRCLIB_APP_ID || '',
        }
      : {}

  return {
    plugins: [react(), tailwindcss()],
    define: { __LOCAL_KEYS__: JSON.stringify(localKeys) },
    worker: { format: 'es' },
    optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 1500,
    },
    test: {
      include: ['test/**/*.test.ts'],
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  }
})
