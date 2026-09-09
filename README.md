# 📅 Bacheca Collaborativa

Una bacheca interattiva basata su calendario dove le persone possono aggiungere proposte di cose da fare come post-it colorati.

## ✨ Caratteristiche

- 📱 **Responsive design** — Funziona perfettamente su mobile, tablet e desktop
- 🎨 **Post-it colorati** — 6 colori diversi per organizzare le proposte
- 💾 **Persistenza locale** — I dati vengono salvati automaticamente nel browser
- 🗓️ **Navigazione calendario** — Visualizza facilmente i mesi precedenti e successivi
- 🎯 **Intuitiva** — Click su un giorno per aggiungere una proposta
- ⚡ **Zero dipendenze** — Solo HTML, CSS e JavaScript vanilla
- 🚀 **Pronto per GitHub Pages** — Deploy direttamente dal repository

## 📁 Struttura progetto

```
bacheca/
├── index.html          # File principale HTML
├── css/
│   └── style.css       # Tutti gli stili CSS
├── js/
│   └── script.js       # Logica JavaScript
├── README.md           # Documentazione
└── .gitignore         # File da ignorare
```

## 🚀 Come usarla

### Localmente
1. Clona il repository
2. Apri `index.html` nel browser
3. Inizia ad aggiungere proposte!

### Su GitHub Pages
1. Fai il push del repository
2. Vai in **Impostazioni → Pages**
3. Seleziona "Deploy from a branch" e scegli `main`
4. La bacheca sarà accessibile a `https://tuo-username.github.io/bacheca/`

## 📝 Come funziona

1. **Clicca su un giorno** del calendario
2. **Scrivi la tua proposta** (cosa vuoi fare?)
3. **Scegli un colore** per distinguere le proposte
4. **Salva** — Apparirà come post-it sul giorno

### Altre azioni
- **Elimina una proposta**: Clicca sulla ✕ sul post-it
- **Cambia mese**: Usa i pulsanti di navigazione
- **Torna a oggi**: Clicca il pulsante "Oggi"

## 🎨 Categorie di Eventi per Colore

Ogni colore rappresenta una categoria di evento. Usa il colore appropriato quando aggiungi una proposta:

| Colore | Categoria | Emoji | Esempi |
|--------|-----------|-------|--------|
| 🟨 Giallo | 🍽️ Gastronomia/Cibo | 🍴 | Sagre, cene, aperitivi |
| 🔴 Rosa | 👥 Serate/Sociali | 🎉 | Party, serate ragazze, incontri |
| 🟩 Verde | ⛹️ Sport/Attività Fisica | 🏃 | Trekking, running, palestra |
| 🟦 Blu | 🎮 Intrattenimento/Giochi | 🎯 | Gigacon, board game, cinema |
| 🟪 Viola | 🎵 Cultura/Arte/Musica | 🎭 | Concerti, mostre, teatro |
| 🟧 Arancione | 🏞️ Escursioni/Turismo | 🧳 | Gite, escursioni, weekend |

**💡 Puoi filtrare gli eventi per colore** usando le impostazioni (⚙️) per vedere solo le categorie che ti interessano!

## 🎨 Personalizzazione

### Cambiar colori del tema
Modifica le variabili CSS in `index.html`:
```css
/* Cambia questo gradiente nella sezione <style> */
background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
```

### Modificare le categorie di colore
Per cambiare l'associazione colore-categoria, semplicemente usa i colori diversamente quando aggiungi gli eventi. Non c'è configurazione da cambiare nel codice — il colore è una proprietà dell'evento!

## 💾 Come funzionano i dati

### Archiviazione locale
- Le proposte vengono salvate in **localStorage** del browser
- Ogni giorno ha una chiave univoca (YYYY-MM-DD)
- I dati persistono anche dopo il refresh della pagina

### Sincronizzazione Cloud con Firebase 🔥
La bacheca utilizza **Firebase Realtime Database** per sincronizzare i dati tra più utenti in tempo reale!

**Come funziona:**
1. Al caricamento della pagina, sincronizza automaticamente con Firebase
2. Carica gli eventi salvati da altri utenti
3. Salva i tuoi eventi nel cloud
4. Tutti vedono gli stessi eventi condivisi

**Struttura Firebase:**
```
bacheca-c0441 (progetto)
└── events/
    ├── 2024-09-01/
    │   ├── evento1
    │   ├── evento2
    ├── 2024-09-02/
    │   └── evento3
    └── ...
```

## 🔧 Configurazione Firebase

### Come è configurato
- **Progetto:** `bacheca-c0441`
- **Database:** Realtime Database (Europe West 1)
- **Credenziali:** Salvate in `js/script.js` (top del file)
- **SDK:** Firebase compat (via CDN)

### Se devi creare un nuovo progetto Firebase

1. Vai su https://console.firebase.google.com/
2. Clicca **"Crea un progetto"**
   - Nome: `Bacheca` (o quello che preferisci)
   - Disabilita Google Analytics (gratis)
3. Vai su **"Realtime Database"**
   - Clicca **"Crea database"**
   - Modalità test (per sviluppo/test)
   - Region: Europa
4. Vai su **Impostazioni progetto** → **App** → **Aggiungi app** → **Web**
5. Copia il `firebaseConfig`
6. Incolla in `js/script.js` (linee 1-12)

### Credenziali attuali
```javascript
const firebaseConfig = {
    apiKey: "AIzaSyBGy1u-1qF5qv8234rkEvjvEunyJAiogd4",
    authDomain: "bacheca-c0441.firebaseapp.com",
    databaseURL: "https://bacheca-c0441-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "bacheca-c0441",
    storageBucket: "bacheca-c0441.firebasestorage.app",
    messagingSenderId: "800396955473",
    appId: "1:800396955473:web:2e0a0607a0666122a58d70"
};
```

⚠️ **Nota:** Le API keys sono pubbliche (è normale). Usa le **regole di sicurezza** in Firebase per proteggere i dati.

## 🔐 Regole di Sicurezza Firebase

Attualmente il database è in **modalità test** (chiunque può leggere/scrivere).

**Per produzione, usa queste regole:**
```json
{
  "rules": {
    "events": {
      ".read": true,
      ".write": true
    }
  }
}
```

Per restrizioni maggiori:
- Usa **Firebase Authentication** per login
- Restrizione per utente: `".write": "auth.uid === $uid"`

## 🔄 Flusso di sincronizzazione

1. **Al caricamento:** `autoSync()` legge da Firebase e fonde con i dati locali
2. **Modifche locali:** Salvate in `localStorage` (subito)
3. **Prossimo caricamento:** Sincronizza di nuovo

**Per sync realtime durante la modifica:**
Aggiungi una chiamata a `autoSync()` dopo ogni `saveNotes()` in:
- `submitNote()` (dopo aggiunta evento)
- `saveEditedNote()` (dopo modifica)
- `deleteNote()` (dopo eliminazione)

## 📱 Responsive

Ottimizzato per:
- 📱 Mobile (< 768px)
- 📱 Tablet (768px - 1024px)
- 🖥️ Desktop (> 1024px)

## 📄 Licenza

MIT
