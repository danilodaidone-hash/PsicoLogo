#!/bin/bash
# Aggiorna PsicoLogo all'ultima versione caricata su GitHub. I dati restano dove sono.
set -euo pipefail
cd "$(dirname "$0")"
git pull
docker compose up -d --build
docker image prune -f
echo "Aggiornamento completato."
