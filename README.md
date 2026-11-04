# Ascolti — statistiche Spotify, local-first

Analisi del tuo storico Spotify **interamente nel browser**: statistiche, ere musicali, mood, mappa del gusto con embedding, modelli comportamentali e un assistente che risponde sui tuoi dati.

## Funzioni

- **Panoramica** — ore, ascolti (≥ 30 s), confronto con il periodo precedente, insight automatici, ere, top con copertine.
- **Esplora** — artisti, brani e album con filtri; pagine dedicate per ogni entità (andamento, orari, mood, simili).
- **Tempo** — heatmap ora × giorno, calendario annuale, sessioni (tipologie), salti, dispositivi, paesi.
- **Mood & Galassia** — valence/energia misurate (ReccoBeats) o stimate dall'AI su testo e tag con anchor few-shot e confidenza; mappa UMAP degli embedding (EmbeddingGemma 2 via transformers.js/WebGPU), cluster, ricerca semantica, selezione a lazo.
- **Modelli** — predizione degli skip (regressione logistica, validazione temporale, importanza per permutazione), ere (segmentazione binaria), ciclo di vita degli artisti (Kaplan–Meier), riscoperta (Thompson sampling).
- **Chiedi** — agente con tool (`run_sql` di sola lettura, ricerca semantica, grafici, liste brani); ogni query è ispezionabile.
- **Racconto** — story mode annuale scorrevole, didascalie opzionali via AI, immagine 9:16 da condividere.
- **Confronta** — compatibilità con amici (salva solo aggregati).
- **Impostazioni** — ogni servizio esterno è un interruttore; registro delle connessioni effettuate; cancellazione totale.

## Privacy

Nessun backend. I dati restano in IndexedDB. Servizi esterni solo se attivati: `open.spotify.com` (oEmbed copertine), `api.reccobeats.com` (audio features), `lrclib.net` (testi), `ws.audioscrobbler.com` (tag, con tua chiave), `huggingface.co` (download modello), `openrouter.ai` (AI, con tua chiave).

## Stack

React 19 · TypeScript · Vite 7 · Tailwind 4 · DuckDB-WASM · Apache Arrow · transformers.js · umap-js · Observable Plot · cmdk · zustand.

## Avvio rapido

Doppio click su **`Avvia Ascolti.command`** (macOS): installa le dipendenze la prima volta, avvia il server locale e apre il browser su http://localhost:5173. Chiudi la finestra del Terminale per fermare tutto.

Chiavi API in locale: copia `.env.example` in `.env.local` e compilala. Vengono caricate in automatico dal server locale (mai incluse nella build né nel repository).

## Sviluppo

```bash
npm install
npm run dev
npm test                                   # unit test
SPOTIFY_TEST_ZIP=/percorso/export.zip npm test   # + test SQL su un export reale (DuckDB nativo)
npm run build
```

Piano e motivazioni: [PIANO_EVOLUZIONE_2026.md](PIANO_EVOLUZIONE_2026.md).
