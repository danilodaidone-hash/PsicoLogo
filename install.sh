#!/bin/bash
# PsicoLogo – installazione automatica su Ubuntu o Oracle Linux (Oracle Cloud, Aruba o altri).
# Si esegue come root. Richiede la variabile SETUP_CODE (il codice di installazione).
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"
LOG=/var/log/psicologo-install.log
exec > >(tee -a "$LOG") 2>&1
echo "== Installazione PsicoLogo: $(date) =="

if [ -z "${SETUP_CODE:-}" ]; then echo "ERRORE: SETUP_CODE mancante"; exit 1; fi

# 1-3. Pacchetti, Docker, firewall e aggiornamenti automatici.
#      Funziona sia su Ubuntu/Debian (apt) sia su Oracle Linux/RHEL (dnf).
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get -o DPkg::Lock::Timeout=600 update -y
  apt-get -o DPkg::Lock::Timeout=600 install -y ca-certificates curl git openssl unattended-upgrades iptables-persistent
  dpkg-reconfigure -f noninteractive unattended-upgrades || true
  if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
  # Sulle immagini Ubuntu di Oracle c'è una regola REJECT che blocca tutto tranne SSH.
  for PORT in 443 80; do
    if ! iptables -C INPUT -p tcp --dport "$PORT" -m state --state NEW -j ACCEPT 2>/dev/null; then
      POS=$(iptables -L INPUT --line-numbers | awk '/REJECT/{print $1; exit}')
      iptables -I INPUT "${POS:-1}" -p tcp --dport "$PORT" -m state --state NEW -j ACCEPT
    fi
  done
  netfilter-persistent save || true
elif command -v dnf >/dev/null; then
  dnf install -y git curl openssl dnf-plugins-core dnf-automatic
  # Aggiornamenti di sicurezza automatici
  sed -i 's/^apply_updates *=.*/apply_updates = yes/' /etc/dnf/automatic.conf || true
  systemctl enable --now dnf-automatic.timer || true
  if ! command -v docker >/dev/null; then
    dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  # Firewall di Oracle Linux (firewalld): apre HTTP e HTTPS
  if systemctl is-active --quiet firewalld; then
    firewall-cmd --permanent --add-service=http
    firewall-cmd --permanent --add-service=https
    firewall-cmd --reload
  fi
else
  echo "ERRORE: sistema operativo non supportato (serve apt o dnf)"; exit 1
fi
systemctl enable --now docker

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
