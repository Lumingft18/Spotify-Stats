# Ascolti — statistiche Spotify, local-first

Analisi del tuo storico Spotify **in locale**: statistiche, ere musicali, mood, mappa del gusto con embedding, modelli comportamentali e un assistente che risponde sui tuoi dati. Ogni analisi ha un nome e resta salvata in un database SQLite sul tuo computer.

## Funzioni

- **Panoramica** — ore, ascolti (≥ 30 s), confronto con il periodo precedente, insight automatici, ere, top con copertine.
- **Esplora** — artisti, brani e album con filtri; pagine dedicate per ogni entità (andamento, orari, mood, simili).
- **Tempo** — heatmap ora × giorno, calendario annuale, sessioni (tipologie), salti, dispositivi, paesi.
- **Mood & Galassia** — valence/energia misurate (ReccoBeats) o stimate da LLM (OpenRouter) su testo e tag, **solo se lo stimatore supera il benchmark**; mappa UMAP degli embedding (Gemini Embedding 2 via OpenRouter), creata in automatico quando c'è la chiave (disattivabile), cluster, ricerca semantica, selezione a lazo.
- **Modelli** — predizione degli skip (regressione logistica, validazione temporale, baseline, IC bootstrap), ere (segmentazione binaria a penalità relativa), ciclo di vita degli artisti (Kaplan–Meier con troncamento a sinistra), riscoperta (Thompson sampling). Le ere prendono il nome dagli artisti del periodo, non dai generi.
- **Chiedi** — agente con tool (`run_sql` di sola lettura, ricerca semantica, grafici, liste brani); ogni query è ispezionabile.
- **Racconto** — story mode annuale scorrevole, didascalie opzionali via AI, immagine 9:16 da condividere.
- **Confronta** — compatibilità con amici (salva solo aggregati).
- **Impostazioni** — ogni servizio esterno è un interruttore; registro delle connessioni effettuate; cancellazione totale.

## Database locale

Il server locale (lo stesso di `npm run dev` / `Avvia Ascolti.command`) apre `data/ascolti.sqlite` (`node:sqlite`, nessuna dipendenza nativa; percorso cambiabile con `ASCOLTI_DB`) ed espone `/api` (vedi `server/api.ts`).

- **Analisi**: all'avvio chiedi un nome (se carichi lo ZIP “Dati dell’account” lo prende da lì). Storico, arricchimento, chat, confronti di ogni analisi sono salvati a parte; la schermata iniziale mostra la cronologia (apri, rinomina, elimina). Si cambia analisi dal riquadro “Analisi” nella barra laterale.
- **Catalogo condiviso** tra tutte le analisi e tutte le persone che usano questa installazione: URL copertina, audio features, testi, tag, ricerche già fatte, vettori di embedding (per hash del testo) e le immagini delle copertine, scaricate una volta e poi servite da `/api/img`. Le stime AI per brano (mood, positività del testo) stanno in una cache a parte, per modello + hash del prompt: la stessa canzone non si paga due volte; restano sempre etichettate come stime. Il benchmark riusa solo stime fatte con il suo protocollo (ancore di artisti diversi).
- I dati salvati dalle versioni precedenti in IndexedDB vengono copiati nel database al primo avvio (gli originali restano intatti).
- `data/` è in `.gitignore`: contiene dati personali.

## Privacy

Nessun cloud: i dati restano nel database locale. Servizi esterni solo se attivati: `open.spotify.com` (oEmbed copertine), `api.reccobeats.com` (audio features), `lrclib.net` (testi), `ws.audioscrobbler.com` (tag, con tua chiave), `openrouter.ai` (AI, con tua chiave).

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

## Metodi e riproducibilità

Ogni numero della sezione Modelli si rigenera da un export, con seed fissi, su DuckDB nativo:

```bash
ANALYSIS_ZIP=/percorso/export.zip npm run analysis          # → analysis-out/report.md + report.json
ANALYSIS_META=/percorso/arricchimento.json …                # + mood, testi, tag (opzionale)
ANALYSIS_BENCH=1 …                                          # + benchmark del mood (usa le chiavi di .env.local)
```

Regole e scelte, tutte nel codice e mostrate in app:

- **Pulizia**: un ascolto per (istante di inizio, brano), tenuto il più lungo; “ascolto” = ≥ 30 s; brani esclusi dall'utente rimossi ovunque.
- **Salto** (modello): brano chiuso con il tasto avanti. Il campo `skipped` esplicito esiste solo negli export dal 2022, quindi non è usato come etichetta: cambierebbe significato a metà serie.
- **Skip**: split temporale 80/20, standardizzazione sul solo training, confronto con un modello “slancio” (solo il salto precedente) e uno “solo brano”; AUC con IC bootstrap al 95%; importanza = calo medio di AUC su 8 permutazioni ± sd; mood mancante con indicatore dedicato.
- **Mood AI**: benchmark su ≤ 300 brani misurati di artisti mai usati come esempio (split per artista), confronto con una costante; una dimensione è scritta solo se l'IC dell'errore è sotto la costante e l'IC di r è sopra 0. Nessuna stima viene presentata come misura. Levanto Sage (modello di decisione) è stato confrontato sugli stessi brani a novembre 2026: non migliorava l'LLM e sull'energia non batteva nemmeno la media, quindi non è usato.
- **Ere**: segmentazione binaria su vettori di quote per artista (Hellinger); un taglio resta solo se spiega ≥ 4% della varianza totale.
- **Ciclo di vita**: Kaplan–Meier, censura per gli artisti attivi, esclusi gli artisti già ascoltati all'inizio dei dati; mediana riportata per soglie 30/60/90/180 giorni.

Piano e motivazioni: [PIANO_EVOLUZIONE_2026.md](PIANO_EVOLUZIONE_2026.md).

## Debug bridge (solo `npm run dev`)

Il dev server espone `/__debug/*`: la scheda aperta dell'app risponde via websocket HMR, così strumenti locali possono ispezionarla. Non esiste nella build di produzione; le chiavi API sono oscurate; SQL in sola lettura.

```sh
curl -s localhost:5173/__debug/ping
curl -s localhost:5173/__debug/state          # store (senza chiavi), job, rete
curl -s localhost:5173/__debug/logs           # console.error/warn + eccezioni
curl -s localhost:5173/__debug/idb            # chiavi IndexedDB (?key=… per leggerne una)
curl -s -X POST localhost:5173/__debug/sql -d '{"sql":"SELECT mood_source, count(*) FROM meta GROUP BY 1"}'
curl -s -X POST localhost:5173/__debug/navigate -d '{"hash":"#/mood"}'
curl -s localhost:5173/__debug/reload         # ricarica la pagina
curl -s 'localhost:5173/__debug/dom?sel=h1'   # elementi: dimensioni + testo
curl -s localhost:5173/__debug/snapshot       # HTML renderizzato senza script (per stampare/screenshot in locale)
```
