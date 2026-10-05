# PsicoLogo – Installazione di prova su Oracle Cloud (gratis)

Questa guida ti porta da zero a PsicoLogo online, con indirizzo HTTPS, in circa un'ora.
Non serve usare il terminale: il server si installa da solo.

> **Importante**: questa è una versione di prova. Inserisci solo dati di fantasia.
> Prima di usare dati di pazienti reali serve un controllo di sicurezza e la documentazione privacy.

---

## Cosa ti serve

- Un indirizzo email
- Una carta di credito o di debito: Oracle la chiede solo per verificare la tua identità. Il piano "Always Free" non addebita nulla, finché non passi volontariamente a un piano a pagamento.
- Questa cartella `psicologo`, scompattata sul computer

---

## Passo 1 – Carica il codice su GitHub (10 minuti)

GitHub è il "magazzino" da cui il server scarica PsicoLogo.

1. Vai su **github.com** e crea un account gratuito (**Sign up**).
2. In alto a destra premi **+** → **New repository**.
3. In **Repository name** scrivi `psicologo`.
4. Lascia selezionato **Public**. Il codice non contiene dati né password: quelli restano solo sul tuo server.
5. Premi **Create repository**.
6. Nella pagina che si apre, premi il link **uploading an existing file**.
7. Apri la cartella `psicologo` sul tuo computer, seleziona **tutto il suo contenuto** (file e cartelle `public`, `scripts`) e trascinalo nella pagina di GitHub.
8. Aspetta che finisca il caricamento e premi **Commit changes**.
9. Copia l'indirizzo della pagina dal browser. Sarà simile a `https://github.com/tuonome/psicologo`. Ti servirà tra poco.

---

## Passo 2 – Crea l'account Oracle Cloud (15 minuti)

1. Vai su **oracle.com/cloud/free** e premi **Start for free**.
2. Compila i dati. Come **Home Region** scegli **Italy Northwest (Milan)** oppure **Germany Central (Frankfurt)**.
   Attenzione: la regione non si può cambiare dopo, e le risorse gratuite esistono solo lì.
3. Inserisci la carta per la verifica e completa la registrazione.
4. Attendi l'email di conferma, poi accedi alla console.

---

## Passo 3 – Crea il server con PsicoLogo già dentro (10 minuti)

1. Nella console premi il menu **☰** → **Compute** → **Instances** → **Create instance**.
2. **Name**: `psicologo`.
3. **Image and shape** → **Edit**:
   - **Image**: premi **Change image** → **Ubuntu** → scegli **Canonical Ubuntu 24.04**.
   - **Shape**: premi **Change shape** → **Ampere** → **VM.Standard.A1.Flex** con **1 OCPU** e **6 GB** di memoria.
     Se più avanti compare l'errore *Out of capacity*, torna qui e scegli **Specialty and previous generation** → **VM.Standard.E2.1.Micro** (anche questo gratuito).
4. **Networking**: lascia le impostazioni proposte e controlla che sia selezionato **Assign a public IPv4 address**.
5. **Add SSH keys**: scegli **Generate a key pair for me** e premi **Save private key**. Conserva il file: serve solo per interventi tecnici futuri.
6. Scorri in basso e premi **Show advanced options** → scheda **Management** → **Initialization script** → **Paste cloud-init script**.
7. Apri il file `cloud-init.txt` di questa cartella, copialo tutto e incollalo nel riquadro. Poi cambia **solo** le due righe indicate:
   - `SETUP_CODE="..."`: scegli un codice lungo e segreto, per esempio `girasole-tramonto-2026`. Ti servirà una sola volta, al primo accesso.
   - `REPO_URL="..."`: l'indirizzo GitHub del Passo 1, con `.git` alla fine, per esempio `https://github.com/tuonome/psicologo.git`.
8. Premi **Create**. Dopo un paio di minuti lo stato diventa **Running** (verde).
9. Nella pagina del server copia il **Public IP address**, per esempio `130.61.22.5`.

---

## Passo 4 – Apri le porte del sito (5 minuti)

Oracle blocca tutto per impostazione predefinita: bisogna permettere le visite al sito.

1. Nella pagina del server, sezione **Primary VNIC**, premi il link sotto **Subnet**.
2. Scheda **Security** (o **Security Lists**) → premi **Default Security List for …**.
3. Scheda **Security rules** → **Add Ingress Rules**.
4. Compila:
   - **Source CIDR**: `0.0.0.0/0`
   - **IP Protocol**: `TCP`
   - **Destination Port Range**: `80,443`
5. Premi **Add Ingress Rules**.

---

## Passo 5 – Primo accesso (5 minuti)

1. Aspetta **10 minuti** dalla creazione del server: nel frattempo si sta installando da solo.
2. Costruisci il tuo indirizzo sostituendo i punti dell'IP con dei trattini e aggiungendo `.sslip.io`:
   IP `130.61.22.5` → **https://130-61-22-5.sslip.io**
3. Aprilo nel browser. Compare la schermata **Prima configurazione**.
4. Compila i tuoi dati, il **codice di installazione** scelto al Passo 3, nome utente e password (almeno 10 caratteri).
5. Lascia spuntato **Inserisci pazienti e appuntamenti di esempio** se vuoi provare subito con dati di fantasia.
6. Premi **Crea il mio gestionale**. Fatto!

Ora puoi aprire lo stesso indirizzo da telefono o da un altro computer: i dati sono gli stessi ovunque.

---

## Se qualcosa non va

| Problema | Cosa fare |
|---|---|
| La pagina non si apre dopo 15 minuti | Controlla il Passo 4 (porte 80 e 443). Poi riavvia il server: **Instances** → `psicologo` → **Reboot**. |
| Avviso "connessione non sicura" | Il certificato HTTPS viene creato al primo accesso: aspetta 2 minuti e ricarica. |
| "Codice di installazione non corretto" | Usa esattamente il codice scritto in `SETUP_CODE`, senza virgolette. |
| Accesso bloccato | Dopo 5 password sbagliate l'accesso si blocca per 15 minuti. Aspetta e riprova. |
| *Out of capacity* alla creazione | Vedi il Passo 3, punto 3: usa la forma VM.Standard.E2.1.Micro. |

---

## Cosa fa il server, in breve

- **Accesso vero**: password protette con scrypt, sessioni che scadono dopo 2 ore di inattività, blocco dopo 5 tentativi sbagliati.
- **Dati cifrati** sul disco con AES-256. La chiave viene generata sul server durante l'installazione e non è mai nel codice.
- **HTTPS** automatico con certificato Let's Encrypt, tramite Caddy.
- **Backup giornaliero** automatico, con gli ultimi 14 giorni conservati sul server.
- **Registro degli accessi** e **copia dei dati** scaricabile dal tuo Profilo.
- **Aggiornamenti di sicurezza** del sistema operativo automatici.

Limiti di questa versione di prova:
- I backup restano sullo stesso server. Se il server viene cancellato, si perdono anche loro: scarica periodicamente una copia dei dati dal Profilo.
- Un solo professionista per installazione.
- Nessun controllo di sicurezza professionale ancora eseguito.

---

## Per i tecnici

- Stack: Node.js 22 (nessuna dipendenza esterna, `node:sqlite`), Caddy 2, Docker Compose.
- Installazione: `SETUP_CODE=... bash install.sh` su Ubuntu 22.04/24.04. Log in `/var/log/psicologo-install.log`.
- Aggiornamento: `sudo bash /opt/psicologo/update.sh` dopo aver caricato la nuova versione su GitHub.
- Dati: `/opt/psicologo/data` (database e backup). Configurazione e chiave: `/opt/psicologo/.env` (permessi 600).
- Dominio personalizzato: `DOMAIN=studio.esempio.it` prima di `install.sh`, con il record DNS A che punta all'IP del server.
- Server dimostrativo: con `DEMO_MODE=1` in `.env` compare nel Profilo il pulsante **Azzera demo**, che riporta l'app alla prima configurazione (non resta nessuna copia: vengono cancellati anche i backup in `data/backups`, che in questa modalità non vengono creati). Attivazione: `echo DEMO_MODE=1 | sudo tee -a /opt/psicologo/.env && cd /opt/psicologo && sudo docker compose up -d`. **Mai** su un server con dati reali.
