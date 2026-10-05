#!/bin/bash
# =====================================================================
#  PsicoLogo – aggiorna GitHub e il server con un doppio clic (macOS)
#
#  1. Carica su GitHub i file di questa cartella che sono cambiati.
#  2. Se vuoi, aggiorna subito anche il server.
#
#  Serve un "token" GitHub (solo la prima volta): viene salvato nel
#  Portachiavi del Mac, non in questo file.
# =====================================================================
set -uo pipefail

# ---- Impostazioni (modifica solo se cambiano) -----------------------
REPO="danilodaidone-hash/PsicoLogo"
BRANCH="main"
SERVER="ubuntu@84.8.219.106"
SSH_KEY="$HOME/Downloads/ssh-key-2026-09-30.key"
# File del progetto da tenere allineati su GitHub
FILES=(
  "server.js"
  "pdf.js"
  "LICENSE"
  "public/index.html"
  "scripts/fetch-fonts.js"
  "scripts/reset-password.js"
  "Dockerfile"
  "docker-compose.yml"
  "install.sh"
  "update.sh"
  "cloud-init.txt"
  "GUIDA.md"
  ".gitignore"
  ".dockerignore"
  "aggiorna.command"
)
KEYCHAIN_SERVICE="psicologo-github-token"
# ---------------------------------------------------------------------

cd "$(dirname "$0")" || exit 1
API="https://api.github.com/repos/$REPO/contents"
verde(){ printf '\033[32m%s\033[0m\n' "$*"; }
rosso(){ printf '\033[31m%s\033[0m\n' "$*"; }
fine(){ echo; read -r -p "Premi Invio per chiudere la finestra…" _; exit "${1:-0}"; }

echo "=== PsicoLogo – aggiornamento ==="
echo "Cartella: $(pwd)"
echo

# ---- Token dal Portachiavi (o richiesta la prima volta) -------------
TOKEN="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then
  echo "Primo utilizzo: incolla il token GitHub (inizia con github_pat_)."
  echo "Mentre lo incolli non vedrai nulla: è normale. Poi premi Invio."
  read -r -s -p "Token: " TOKEN; echo
  [ -z "$TOKEN" ] && { rosso "Nessun token inserito."; fine 1; }
  security add-generic-password -U -s "$KEYCHAIN_SERVICE" -a "$USER" -w "$TOKEN"
  verde "Token salvato nel Portachiavi."
fi
AUTH=(-H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")

# Verifica che il token funzioni
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "https://api.github.com/repos/$REPO")
if [ "$CODE" != "200" ]; then
  rosso "GitHub non accetta il token (codice $CODE)."
  echo "Il token potrebbe essere scaduto o senza permessi. Lo cancello dal Portachiavi:"
  echo "al prossimo avvio te ne chiederò uno nuovo."
  security delete-generic-password -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1
  fine 1
fi

# Impronta git di un file locale (uguale a quella che usa GitHub)
blob_sha(){ local size; size=$(wc -c < "$1" | tr -d ' '); { printf 'blob %s\0' "$size"; cat "$1"; } | shasum -a 1 | cut -d' ' -f1; }

# ---- Caricamento su GitHub ------------------------------------------
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
CARICATI=0; ERRORI=0
for F in "${FILES[@]}"; do
  [ -f "$F" ] || { echo "  –  $F (non presente in questa cartella, salto)"; continue; }
  LOCALE=$(blob_sha "$F")
  REMOTO=$(curl -s "${AUTH[@]}" "$API/$F?ref=$BRANCH" | tr -d '\n' | grep -oE '"sha": ?"[0-9a-f]{40}"' | head -1 | grep -oE '[0-9a-f]{40}')
  if [ "$LOCALE" = "$REMOTO" ]; then echo "  =  $F (già aggiornato)"; continue; fi
  {
    printf '{"message":"Aggiornamento %s da Mac","branch":"%s","content":"' "$F" "$BRANCH"
    base64 < "$F" | tr -d '\n'
    printf '"'
    [ -n "$REMOTO" ] && printf ',"sha":"%s"' "$REMOTO"
    printf '}'
  } > "$TMP/body.json"
  RES=$(curl -s -o "$TMP/res.json" -w '%{http_code}' -X PUT "${AUTH[@]}" --data-binary @"$TMP/body.json" "$API/$F")
  if [ "$RES" = "200" ] || [ "$RES" = "201" ]; then verde "  ↑  $F caricato"; CARICATI=$((CARICATI+1))
  else rosso "  ✗  $F: errore $RES"; ERRORI=$((ERRORI+1)); fi
done
echo
if [ "$ERRORI" -gt 0 ]; then rosso "$ERRORI file non caricati: controlla i messaggi qui sopra."; fine 1; fi
if [ "$CARICATI" -eq 0 ]; then echo "Su GitHub era già tutto aggiornato."; else verde "$CARICATI file caricati su GitHub."; fi

# ---- Aggiornamento del server ---------------------------------------
echo
read -r -p "Vuoi aggiornare anche il server adesso? (s/n) " RISP
if [[ "$RISP" =~ ^[sSyY] ]]; then
  [ -f "$SSH_KEY" ] || { rosso "Chiave SSH non trovata in $SSH_KEY"; fine 1; }
  chmod 600 "$SSH_KEY"
  echo "Aggiorno il server (1-2 minuti)…"
  if ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SERVER" 'sudo bash /opt/psicologo/update.sh'; then
    verde "Server aggiornato. Ricarica l'app nel browser con Cmd+Shift+R."
  else
    rosso "L'aggiornamento del server non è riuscito: mandami le righe qui sopra."
  fi
fi
fine 0
