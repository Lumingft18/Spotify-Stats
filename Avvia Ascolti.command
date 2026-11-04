#!/bin/zsh -l
# Avvia "Ascolti": installa le dipendenze se servono, avvia il server locale e apre il browser.
# Doppio click nel Finder per eseguirlo. Chiudi questa finestra (o premi Ctrl+C) per fermare tutto.

cd "${0:A:h}" || exit 1
PORT=5173
URL="http://localhost:$PORT/"

echo "🎧  Ascolti — avvio in corso…"

# Node.js: prova fnm, poi nvm, poi Homebrew/sistema.
if ! command -v node >/dev/null 2>&1; then
  for f in /opt/homebrew/bin/fnm /usr/local/bin/fnm "$HOME/.local/share/fnm/fnm"; do
    [ -x "$f" ] && eval "$("$f" env --use-on-cd 2>/dev/null)" && break
  done
fi
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  source "$HOME/.nvm/nvm.sh"
fi
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "❌  Node.js non trovato. Installalo da https://nodejs.org (versione 20 o superiore) e riprova."
  read -k1 "?Premi un tasto per chiudere…"
  exit 1
fi
echo "    Node $(node -v)"

# Dipendenze: installa alla prima esecuzione o quando package-lock.json è cambiato.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "📦  Installo le dipendenze (solo la prima volta, ~1 minuto)…"
  npm ci --no-audit --no-fund || { echo "❌  Installazione non riuscita."; read -k1 "?Premi un tasto per chiudere…"; exit 1; }
fi

# Se è già in esecuzione, apri solo il browser.
if curl -sf -o /dev/null "$URL"; then
  echo "✅  Già in esecuzione: apro $URL"
  open "$URL"
  exit 0
fi

echo "🚀  Avvio il server su $URL"
npx vite --port "$PORT" --strictPort &
SERVER_PID=$!
cleanup() {
  trap - INT TERM HUP EXIT
  echo; echo "⏹  Fermo Ascolti…"
  kill $SERVER_PID 2>/dev/null
  lsof -ti:$PORT -sTCP:LISTEN | xargs kill 2>/dev/null
  exit 0
}
trap cleanup INT TERM HUP EXIT

for i in {1..60}; do
  curl -sf -o /dev/null "$URL" && break
  sleep 0.5
done
[ -z "$ASCOLTI_NO_OPEN" ] && open "$URL"
echo
echo "✅  Ascolti è aperto nel browser."
echo "    Lascia questa finestra aperta mentre lo usi; chiudila (o Ctrl+C) per fermare tutto."
wait $SERVER_PID
