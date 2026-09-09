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

## 🎨 Personalizzazione

### Cambiar colori del tema
Modifica le variabili CSS in `index.html`:
```css
/* Cambia questo gradiente nella sezione <style> */
background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
```

### Aggiungi più colori ai post-it
Nel file HTML, aggiungi una nuova classe CSS `.color-*` e un nuovo elemento nel color picker.

## 💾 Come funzionano i dati

- Le proposte vengono salvate in **localStorage** del browser
- Ogni giorno ha una chiave univoca (YYYY-MM-DD)
- I dati persistono anche dopo il refresh della pagina
- Nota: Ogni browser/dispositivo ha il suo storage locale

Se vuoi condividere i dati tra più utenti, potrai aggiungere in futuro:
- Un backend (Node.js, Firebase, etc.)
- Sincronizzazione con un database
- Export/Import dei dati

## 📱 Responsive

Ottimizzato per:
- 📱 Mobile (< 768px)
- 📱 Tablet (768px - 1024px)
- 🖥️ Desktop (> 1024px)

## 📄 Licenza

MIT
