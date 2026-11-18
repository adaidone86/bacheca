# 📅 Bacheca Collaborativa

Una bacheca interattiva basata su calendario dove le persone propongono eventi come post-it colorati, si iscrivono e ne parlano in una chat dedicata. I dati sono condivisi in tempo reale tramite **Firebase Realtime Database**.

## ✨ Caratteristiche

- 📱 **PWA responsive** — installabile su mobile e desktop, layout dedicati sotto/sopra i 768px
- 🗓️ **Due viste** — calendario mensile oppure lista degli eventi futuri (default: lista su mobile, calendario su desktop)
- 🎨 **7 categorie colorate** con filtri di visualizzazione
- 👥 **Partecipanti** — pulsante "Voglio partecipare" / "Non posso più"
- 💬 **Chat per evento** — riservata ai partecipanti, con badge dei messaggi non letti
- 🖼️ **Immagine di copertina** — da file o URL, ritagliata in 3:1 (Cropper.js)
- 🔗 **Multi-dispositivo** — lo stesso utente su più dispositivi tramite un codice di sincronizzazione di 5 caratteri
- ↔️ **Drag & drop** dei post-it tra i giorni (desktop)
- ⚡ **Nessuna build** — HTML, CSS e JavaScript vanilla

## 📁 Struttura progetto

```
bacheca/
├── index.html              # Markup, modal e registrazione PWA/Service Worker
├── config.js               # Scelta dell'ambiente Firebase (NONE / TEST / PROD)
├── manifest.json           # Manifest PWA
├── sw.js                   # Service Worker
├── css/
│   ├── style-desktop.css   # Stili per schermi > 768px
│   └── style-mobile.css    # Stili per schermi ≤ 768px
├── js/
│   └── script.js           # Tutta la logica (classe BacheaCalendar)
├── descrizioni/            # Testi caricati a runtime
│   ├── titolo              # 3 righe: titolo, sottotitolo, slogan
│   ├── info                # Testo del modal "Info"
│   └── versione            # Versione in formato x.x.x
├── icons/                  # Icone PWA
├── immagini/               # Immagini statiche
└── backup/                 # Esportazioni JSON degli eventi (non usate dal codice)
```

## 🚀 Come usarla

### Localmente
Il Service Worker è registrato con scope `/bacheca/`, quindi servi il sito dalla cartella **superiore** al progetto:

```bash
python -m http.server 8000
```

e apri `http://localhost:8000/bacheca/`.

### Su GitHub Pages
1. Fai il push su `main`
2. **Impostazioni → Pages** → "Deploy from a branch" → `main`
3. La bacheca sarà su `https://tuo-username.github.io/bacheca/`

## 📝 Come funziona

1. Al primo accesso ti viene chiesto il nome, oppure il codice di sincronizzazione se sei già registrato su un altro dispositivo
2. **Clicca su un giorno** (da domani in poi) o su "➕ Aggiungi evento" nella lista
3. Compila nome, ora, luogo e note; nella scheda **Dettagli** scegli categoria, link e immagine
4. Clicca su un evento per aprirlo: puoi modificarlo, eliminarlo, partecipare e usare la chat

### Regole sulle date
- **Giorni passati**: sola lettura
- **Oggi**: non si aggiungono eventi, ma quelli esistenti si possono modificare o eliminare
- **Da domani**: tutto consentito

### Menu ⚙️
- 👤 Inserisci / cambia il tuo nome
- 📋 Cambia modalità (lista ↔ calendario)
- 🎨 Visualizzazione (filtri per categoria)
- ℹ️ Info
- 👤 Utente — nome, codice di sincronizzazione (copiabile), device ID, reset

## 🎨 Categorie di Eventi per Colore

| Colore | Categoria | Esempi |
|--------|-----------|--------|
| ⚪ Grigio | Senza categoria | — |
| 🟨 Giallo | 🍽️ Gastronomia/Cibo | Sagre, cene, aperitivi |
| 🔴 Rosa | 👥 Serate/Sociali | Party, serate, incontri |
| 🟩 Verde | ⛹️ Sport/Attività | Trekking, running, palestra |
| 🟦 Blu | 🎮 Intrattenimento | Board game, cinema |
| 🟪 Viola | 🎵 Cultura/Musica | Concerti, mostre, teatro |
| 🟧 Arancione | 🏞️ Escursioni/Turismo | Gite, weekend |

## 💾 Dati

### Firebase (condiviso)
```
events/{YYYY-MM-DD}: [ {id, title, time, location, notes, color, link, imageVersion, participants: [deviceId], creatorId} ]
eventImages/{eventId}: "data:image/jpeg;base64,..."   (copertina, max 1200×400)
devices/{deviceId}: {id, name, syncCode, browser, deviceType, createdAt, lastSeen}
syncCodes/{CODICE}: {name, deviceIds: [...], createdAt}
eventChats/{eventId}/messages/{id}: {deviceId, name, text, timestamp}
chatReadStatus/{eventId}/{syncCode}: {lastReadTimestamp}
proposals/{id}: {id, title, time, location, notes, color, creatorId, creatorSyncCode, creatorName, createdAt,
                 dateOptions/{YYYY-MM-DD}: {addedBy, createdAt},
                 votes/{YYYY-MM-DD}/{syncCode}: {name, deviceId}}
```

### Eventi da fissare
Un evento può essere creato **senza data** ("➕ Evento senza data", nel riquadro 🗳️ *Da fissare* sopra il calendario e in cima alla lista). Tutti possono proporre date e votarle; chi ha votato può premere **📅 Fissa questa data**: l'evento viene aggiunto a quel giorno con lo stesso id e chi ha votato quella data diventa partecipante. Voti e date sono scritture puntuali, quindi utenti diversi non si sovrascrivono. Ogni proposta ha una **chat aperta a tutti**, salvata in `eventChats/{id}` come quella degli eventi: quando la data viene fissata, la chat continua nell'evento.

Gli eventi vengono letti e scritti **solo su Firebase**; il listener in tempo reale aggiorna tutti i client aperti.

Le immagini stanno in `eventImages`, separate dagli eventi, così la sincronizzazione di `events` resta leggera. Nell'evento c'è solo `imageVersion` (timestamp), che cambia a ogni nuova immagine e invalida la cache locale. Gli eventi nel vecchio formato (campo `image` in base64) vengono migrati in automatico al primo caricamento.

### Browser (locale)
- `localStorage`: `deviceId`, `preferredView`, `colorFilters`, `APP_VERSION`
- `IndexedDB` (`BacheaDB`): copia di riserva del `deviceId`

## 🔧 Configurazione

### Ambiente
In [config.js](config.js) imposta `ENV`:

| Valore | Database |
|--------|----------|
| `'TEST'` | `bacheca-test` — per lo sviluppo |
| `'PROD'` | `bacheca-c0441` — produzione |
| `'NONE'` | nessun database (non ancora supportato dal codice) |

⚠️ Sul branch di sviluppo lascia `TEST`; passa a `PROD` solo quando porti le modifiche su `main`.

### Versione
Aggiorna `descrizioni/versione` (formato `x.x.x`) a ogni rilascio: al cambio di versione o di ambiente l'app svuota le cache e si ricarica. Un formato non valido nasconde il sito.

### Nuovo progetto Firebase
1. https://console.firebase.google.com/ → **Crea un progetto**
2. **Realtime Database** → Crea database (regione Europa)
3. **Impostazioni progetto → App → Web** → copia il `firebaseConfig`
4. Incollalo nella sezione corrispondente di `config.js`

Le API key di Firebase sono pubbliche per natura: i dati vanno protetti con le **regole di sicurezza** del database. Al momento le regole sono aperte (chiunque può leggere e scrivere).

## 📄 Licenza

MIT
