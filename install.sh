#!/bin/bash
# PsicoLogo – installazione automatica su Ubuntu (Oracle Cloud, Aruba o altri).
# Si esegue come root. Richiede la variabile SETUP_CODE (il codice di installazione).
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"
LOG=/var/log/psicologo-install.log
exec > >(tee -a "$LOG") 2>&1
echo "== Installazione PsicoLogo: $(date) =="

if [ -z "${SETUP_CODE:-}" ]; then echo "ERRORE: SETUP_CODE mancante"; exit 1; fi

# 1. Aggiornamenti di sistema e aggiornamenti di sicurezza automatici
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git openssl unattended-upgrades iptables-persistent
dpkg-reconfigure -f noninteractive unattended-upgrades || true

# 2. Docker
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
systemctl enable --now docker

# 3. Firewall del sistema: apre solo 80 (HTTP) e 443 (HTTPS) oltre a SSH.
#    Sulle immagini Ubuntu di Oracle c'è una regola REJECT che blocca tutto il resto.
for PORT in 443 80; do
  if ! iptables -C INPUT -p tcp --dport "$PORT" -m state --state NEW -j ACCEPT 2>/dev/null; then
    POS=$(iptables -L INPUT --line-numbers | awk '/REJECT/{print $1; exit}')
    iptables -I INPUT "${POS:-1}" -p tcp --dport "$PORT" -m state --state NEW -j ACCEPT
  fi
done
netfilter-persistent save || true

# 4. Indirizzo pubblico e nome di dominio gratuito (sslip.io) per avere HTTPS
IP="${PUBLIC_IP:-$(curl -fsS https://api.ipify.org)}"
DOMAIN="${DOMAIN:-${IP//./-}.sslip.io}"

# 5. Configurazione: codice di installazione e chiave di cifratura (generata qui, mai nel codice)
if [ ! -f .env ]; then
  umask 077
  printf 'SETUP_CODE=%s\nDATA_KEY=%s\n' "$SETUP_CODE" "$(openssl rand -base64 32)" > .env
fi
chmod 600 .env
printf '%s {\n\tencode gzip\n\treverse_proxy 127.0.0.1:3000\n}\n' "$DOMAIN" > Caddyfile
mkdir -p data && chown -R 1000:1000 data && chmod 700 data

# 6. Avvio
docker compose up -d --build
echo "https://$DOMAIN" > INDIRIZZO.txt
echo "== Fatto. PsicoLogo sarà raggiungibile su: https://$DOMAIN =="
