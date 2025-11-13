# Spotify Statistics

Un'applicazione React moderna per analizzare le tue statistiche di ascolto Spotify in modo dettagliato e personalizzato.

## Caratteristiche

- 🎵 Analisi completa delle tue statistiche di ascolto Spotify
- 🔒 Elaborazione completamente lato client - i tuoi dati non lasciano mai il tuo computer
- 📊 Visualizzazioni interattive con grafici e tabelle
- 🎨 UI moderna e responsive
- ⚡ Elaborazione veloce con Pyodide (Python nel browser)

## Come iniziare

1. Vai alla [pagina account Spotify](https://www.spotify.com/us/account/privacy/)
2. Richiedi la tua "Extended streaming history"
3. Una volta scaricata, carica il file ZIP nell'applicazione

## Installazione

```bash
npm install
npm run dev
```

## Build per produzione

```bash
npm run build
npm run preview
```

## Tecnologie utilizzate

- React 19
- TypeScript
- Vite
- Tailwind CSS
- Plotly.js
- Pyodide (Python nel browser)
- Pandas (Python)

## Note

L'applicazione elabora i tuoi dati completamente nel browser utilizzando Pyodide per eseguire codice Python. Questo significa che:
- I tuoi dati non vengono mai inviati a server esterni
- L'elaborazione avviene completamente sul tuo dispositivo
- La prima volta potrebbe richiedere qualche minuto per scaricare Pyodide e le dipendenze Python
