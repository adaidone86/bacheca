// Version check - Auto-update quando env o versione cambia.
// Si ricarica solo DOPO aver cancellato tutte le cache e chiesto al service worker di aggiornarsi
// (prima la ricarica partiva mentre la cancellazione era ancora in corso)
let APP_FILE_VERSION = 'unknown';
fetch('./descrizioni/versione', { cache: 'no-store' })
    .then(r => r.text())
    .then(async text => {
        APP_FILE_VERSION = text.trim();
        const APP_VERSION = `${APP_CONFIG.ENV}-${APP_FILE_VERSION}`;
        const STORED_VERSION = localStorage.getItem('APP_VERSION');
        localStorage.setItem('APP_VERSION', APP_VERSION);
        if (STORED_VERSION && STORED_VERSION !== APP_VERSION) {
            console.log(`🔄 Versione app cambiata (${STORED_VERSION} → ${APP_VERSION}), ricarico...`);
            try {
                if ('caches' in window) {
                    const names = await caches.keys();
                    await Promise.all(names.map(name => caches.delete(name)));
                }
                if (navigator.serviceWorker) {
                    const registration = await navigator.serviceWorker.getRegistration();
                    if (registration) await registration.update();
                }
            } catch (e) {
                console.warn('⚠️ Pulizia cache non completa:', e);
            }
            location.reload();
        }
    })
    .catch(err => console.warn('⚠️ Non riesco a leggere la versione:', err));

// Firebase Config da config.js: senza un ambiente valido ('TEST' o 'PROD') l'app non parte
const currentConfig = APP_CONFIG.getConfig();
const firebaseConfig = APP_CONFIG.getFirebaseConfig();

let database = null;
let startupError = null;
if (!firebaseConfig) {
    startupError = `Configurazione non valida: ENV = '${APP_CONFIG.ENV}'. In config.js usa 'TEST' o 'PROD'.`;
} else {
    try {
        firebase.initializeApp(firebaseConfig);
        database = firebase.database();
        // L'accesso resta salvato sul dispositivo finché l'utente non esce
        firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL);
        console.log(`🔧 Configurazione: ${currentConfig.name}`);
    } catch (error) {
        console.error('Errore avvio Firebase:', error);
        startupError = `Impossibile collegarsi al database (${currentConfig.name}). Ricarica la pagina.`;
    }
}

// Mostra l'errore al posto del caricamento: l'app non parte
function showStartupError(message) {
    console.error('❌ ' + message);
    const loadingScreen = document.getElementById('loadingScreen');
    if (!loadingScreen) return;
    loadingScreen.innerHTML = `
        <div style="text-align: center; color: white; padding: 24px; max-width: 420px;">
            <div style="font-size: 3rem; margin-bottom: 16px;">⚠️</div>
            <div id="startupErrorMessage" style="font-size: 1.1rem; font-weight: bold; line-height: 1.4;"></div>
        </div>`;
    document.getElementById('startupErrorMessage').textContent = message;
    loadingScreen.style.display = 'flex';
}

// Mostra badge per TEST
if (APP_CONFIG.ENV === 'TEST') {
    setTimeout(() => {
        const testBadge = document.getElementById('testBadge');
        if (testBadge) testBadge.style.display = 'block';
    }, 100);
}

class BacheaCalendar {
    constructor() {
        this.currentDate = new Date();
        this.selectedDate = null;
        this.selectedColor = 'color-yellow';
        this.events = {}; // events/{id} da Firebase: id -> evento (con il campo date)
        this.chatMessages = {}; // eventChats da Firebase: id evento/proposta -> {messages}
        this.readStatus = {}; // chatReadStatus/{uid}: id evento/proposta -> {lastReadTimestamp}
        this.notes = {}; // Indice derivato da this.events: data -> [eventi ordinati per orario]
        this.editingNote = null; // Evento aperto nel modal di modifica: {id, dateKey}
        this.isListView = false; // Toggle tra calendario e lista
        this.visibleColors = this.loadColorFilters(); // Colori visibili
        this.eventImageData = null;
        this.imageCache = {}; // Cache immagini: `${eventId}:${imageVersion}` -> dataURL
        this.currentEventLink = ''; // Link in aggiunta
        this.cropper = null;
        this.currentCropType = null; // 'event' o 'edit'
        this.userId = null; // uid dell'account Firebase (lo stesso su tutti i dispositivi)
        this.username = null; // Username di login
        this.userName = null; // Nome visualizzato
        this.userNames = {}; // Mappa di userId -> nome
        this.eventsListener = null; // Listener per cambiamenti Firebase
        this.proposals = {}; // Eventi da fissare (senza data): proposals/{id}
        this.openProposalId = null; // Proposta aperta nel modal
        this.setupCustomPopup();
        this.initializeAuth().then(() => this.init());
    }

    setupCustomPopup() {
        document.getElementById('popupCloseBtn').addEventListener('click', () => {
            document.getElementById('customPopup').style.display = 'none';
        });
    }

    // ===== Avvisi non invasivi =====
    // Piccola barra in basso che sparisce da sola (o al tocco). Usata quando un limite viene superato o
    // Firebase rifiuta un salvataggio: l'utente capisce cosa è successo e può segnalarlo all'amministratore.
    showToast(message, type = 'warning') {
        let box = document.getElementById('toastBox');
        if (!box) {
            box = document.createElement('div');
            box.id = 'toastBox';
            document.body.appendChild(box);
        }
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        toast.addEventListener('click', () => toast.remove());
        box.appendChild(toast);
        while (box.children.length > 3) box.firstChild.remove(); // al massimo 3 avvisi insieme
        setTimeout(() => toast.remove(), 7000);
    }

    // Salvataggio rifiutato: avviso breve con cosa non è riuscito e, se è un limite o un permesso, l'invito a segnalarlo
    notifyWriteError(action, error) {
        console.error(`Errore: ${action}`, error);
        const code = String((error && (error.code || error.message)) || '').toUpperCase();
        if (code.includes('PERMISSION_DENIED')) {
            this.showToast(`⚠️ ${action}: non consentito (superato un limite o permesso mancante). Se ti sembra un errore, scrivi all'amministratore.`);
        } else {
            this.showToast(`⚠️ ${action}: non riuscito. Controlla la connessione e riprova.`);
        }
    }

    showSuccessPopup(message) {
        const popup = document.getElementById('customPopup');
        const icon = document.getElementById('popupIcon');
        const messageEl = document.getElementById('popupMessage');
        icon.textContent = '✅';
        messageEl.textContent = message;
        messageEl.style.whiteSpace = 'pre-line';
        messageEl.style.textAlign = message.includes('\n') ? 'left' : '';
        popup.style.display = 'flex';
    }

    showErrorPopup(message) {
        const popup = document.getElementById('customPopup');
        const icon = document.getElementById('popupIcon');
        const messageEl = document.getElementById('popupMessage');
        icon.textContent = '❌';
        messageEl.textContent = message;
        messageEl.style.whiteSpace = 'pre-line'; // elenchi su più righe
        messageEl.style.textAlign = message.includes('\n') ? 'left' : '';
        popup.style.display = 'flex';
    }

    showConfirmDialog(message, okLabel = 'Elimina', okColor = '#f44336', cancelLabel = 'Annulla') {
        return new Promise((resolve) => {
            const modal = document.getElementById('confirmModal');
            const messageEl = document.getElementById('confirmMessage');
            const cancelBtn = document.getElementById('confirmCancelBtn');
            const okBtn = document.getElementById('confirmOkBtn');

            messageEl.textContent = message;
            messageEl.style.whiteSpace = 'pre-line';
            messageEl.style.textAlign = message.includes('\n') ? 'left' : '';
            cancelBtn.textContent = cancelLabel;
            okBtn.textContent = okLabel;
            okBtn.style.background = okColor;
            modal.style.display = 'flex';

            const handleCancel = () => {
                modal.style.display = 'none';
                cancelBtn.removeEventListener('click', handleCancel);
                okBtn.removeEventListener('click', handleOk);
                resolve(false);
            };

            const handleOk = () => {
                modal.style.display = 'none';
                cancelBtn.removeEventListener('click', handleCancel);
                okBtn.removeEventListener('click', handleOk);
                resolve(true);
            };

            cancelBtn.addEventListener('click', handleCancel);
            okBtn.addEventListener('click', handleOk);

            // Chiudi premendo ESC
            const handleEsc = (e) => {
                if (e.key === 'Escape') {
                    handleCancel();
                    document.removeEventListener('keydown', handleEsc);
                }
            };
            document.addEventListener('keydown', handleEsc);
        });
    }

    showEventDeletedDialog() {
        const popup = document.getElementById('customPopup');
        const icon = document.getElementById('popupIcon');
        const messageEl = document.getElementById('popupMessage');
        const closeBtn = document.getElementById('popupCloseBtn');

        icon.textContent = '🗑️';
        messageEl.textContent = 'L\'evento a cui stavi partecipando è stato eliminato';
        popup.style.display = 'flex';

        // Rimuovi i vecchi listener dal bottone
        const newCloseBtn = closeBtn.cloneNode(true);
        closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);

        newCloseBtn.addEventListener('click', () => {
            popup.style.display = 'none';
            this.editingNote = null;
            const editModal = document.getElementById('editModal');
            if (editModal) {
                editModal.classList.remove('active');
                editModal.style.display = 'none';
            }
            this.render();
        });
    }

    // ===== Account: login con username e password =====
    // Firebase Auth (email/password): lo username diventa un'email fittizia "username@bacheca.local",
    // che serve solo a Firebase. Nessuna email viene mai inviata.
    // users/{uid}: {username, name, createdAt}

    getDeviceInfo() {
        // Rileva browser
        let browser = 'Unknown';
        const ua = navigator.userAgent.toLowerCase();

        if (ua.indexOf('edg/') > -1) browser = 'Edge';
        else if (ua.indexOf('opr/') > -1) browser = 'Opera';
        else if (ua.indexOf('chrome') > -1 && ua.indexOf('chromium') === -1) browser = 'Chrome';
        else if (ua.indexOf('firefox') > -1) browser = 'Firefox';
        else if (ua.indexOf('safari') > -1 && ua.indexOf('chrome') === -1) browser = 'Safari';
        else if (ua.indexOf('trident') > -1) browser = 'IE';

        // Rileva tipo di dispositivo
        let deviceType = 'Desktop';
        if (navigator.userAgentData && navigator.userAgentData.mobile) {
            deviceType = 'Mobile';
        } else if (ua.indexOf('mobile') > -1 || ua.indexOf('android') > -1 || ua.indexOf('iphone') > -1 || ua.indexOf('ipad') > -1) {
            deviceType = 'Mobile';
        } else if (ua.indexOf('tablet') > -1 || ua.indexOf('ipad') > -1) {
            deviceType = 'Tablet';
        }

        return { browser, deviceType };
    }

    normalizeUsername(raw) {
        return (raw || '').trim().toLowerCase();
    }

    isValidUsername(username) {
        return /^[a-z0-9._-]{3,20}$/.test(username);
    }

    usernameToEmail(username) {
        return `${username}@bacheca.local`;
    }

    authErrorMessage(error) {
        const messages = {
            'auth/invalid-credential': 'Username o password errati',
            'auth/invalid-login-credentials': 'Username o password errati',
            'auth/wrong-password': 'Username o password errati',
            'auth/user-not-found': 'Username o password errati',
            'auth/invalid-email': 'Username non valido',
            'auth/email-already-in-use': 'Questo username è già usato da qualcun altro',
            'auth/weak-password': 'Password troppo corta: almeno 6 caratteri',
            'auth/too-many-requests': 'Troppi tentativi. Riprova tra qualche minuto',
            'auth/network-request-failed': 'Connessione assente. Controlla la rete e riprova',
            'auth/operation-not-allowed': 'Login non abilitato su Firebase (Authentication → Email/Password)',
            'auth/configuration-not-found': 'Authentication non attivata su questo progetto Firebase (Authentication → Inizia → Email/Password)',
            'auth/requires-recent-login': 'Per sicurezza esci, rientra e riprova',
            'app/blocked': 'Questo account è stato bloccato dall\'amministratore.'
        };
        return messages[error && error.code] || `Errore: ${(error && error.message) || error}`;
    }

    // Aspetta la sessione salvata; se non c'è, mostra login/registrazione
    async initializeAuth() {
        const auth = firebase.auth();
        const user = await new Promise(resolve => {
            const unsubscribe = auth.onAuthStateChanged(u => {
                unsubscribe();
                resolve(u);
            });
        });

        let blockedMessage = '';
        if (user) {
            try {
                await this.loadUserProfile(user);
            } catch (error) {
                if (!error || error.code !== 'app/blocked') throw error;
                blockedMessage = this.authErrorMessage(error);
                this.userId = null;
            }
        }
        if (!user || blockedMessage) {
            await this.promptForLogin(blockedMessage);
        }

        // Se la sessione finisce (logout da un'altra scheda) ricarico: torna la schermata di login
        auth.onAuthStateChanged(u => {
            if (!u && this.userId) location.reload();
        });
    }

    async loadUserProfile(user) {
        // Account bloccato dall'amministratore: si esce subito (le regole gli negano comunque tutto)
        const blocked = await database.ref(`blocked/${user.uid}`).once('value').then(s => s.exists()).catch(() => false);
        if (blocked) {
            await firebase.auth().signOut();
            const error = new Error('Account bloccato');
            error.code = 'app/blocked';
            throw error;
        }
        this.userId = user.uid;
        const snapshot = await database.ref(`users/${user.uid}`).once('value');
        const profile = snapshot.val();

        if (profile && profile.username) {
            this.username = profile.username;
            this.userName = profile.name || profile.username;
        } else {
            // Account senza profilo (registrazione interrotta): lo ricreo dallo username
            this.username = (user.email || '').split('@')[0];
            this.userName = this.username.slice(0, 10);
            await database.ref(`users/${user.uid}`).set({
                username: this.username,
                name: this.userName,
                createdAt: Date.now()
            });
        }
        this.userNames[this.userId] = this.userName;
        await this.loadRole();
    }

    promptForLogin(initialError = '') {
        return new Promise(resolve => {
            const modal = document.getElementById('authModal');
            const loginForm = document.getElementById('loginForm');
            const registerForm = document.getElementById('registerForm');
            const errorEl = document.getElementById('authError');
            const tabs = modal.querySelectorAll('.auth-tab');

            const showError = (message) => {
                errorEl.textContent = message;
                errorEl.style.display = message ? 'block' : 'none';
            };

            const setBusy = (form, busy) => {
                form.querySelectorAll('button, input').forEach(el => el.disabled = busy);
            };

            const showTab = (tabName) => {
                tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.tab === tabName));
                loginForm.style.display = tabName === 'login' ? 'block' : 'none';
                registerForm.style.display = tabName === 'register' ? 'block' : 'none';
                showError('');
                const firstInput = (tabName === 'login' ? loginForm : registerForm).querySelector('input');
                if (firstInput) firstInput.focus();
            };

            tabs.forEach(tab => tab.onclick = () => showTab(tab.dataset.tab));
            if (initialError) setTimeout(() => showError(initialError), 0);

            const finish = async (user) => {
                await this.loadUserProfile(user);
                modal.classList.remove('active');
                loginForm.reset();
                registerForm.reset();
                resolve();
            };

            loginForm.onsubmit = async (e) => {
                e.preventDefault();
                const username = this.normalizeUsername(document.getElementById('loginUsername').value);
                const password = document.getElementById('loginPassword').value;
                if (!username || !password) {
                    showError('Inserisci username e password');
                    return;
                }

                showError('');
                setBusy(loginForm, true);
                try {
                    const cred = await firebase.auth().signInWithEmailAndPassword(this.usernameToEmail(username), password);
                    await finish(cred.user);
                } catch (error) {
                    showError(this.authErrorMessage(error));
                } finally {
                    setBusy(loginForm, false);
                }
            };

            // Registrazione: suggerimenti che si aggiornano mentre si scrive (verde = ok, rosso = da correggere)
            const setHint = (id, state, text) => {
                const hint = document.getElementById(id);
                hint.textContent = text;
                hint.classList.toggle('hint-ok', state === 'ok');
                hint.classList.toggle('hint-error', state === 'error');
            };
            const usernameInput = document.getElementById('registerUsername');
            const nameInput = document.getElementById('registerName');
            const passwordInput = document.getElementById('registerPassword');
            const confirmInput = document.getElementById('registerPasswordConfirm');
            // Username mentre si scrive: le maiuscole diventano subito minuscole e i caratteri non ammessi
            // non vengono scritti (con un avviso rosso che dice quale carattere è stato tolto)
            let rejectedChars = '';
            const cleanUsernameInput = () => {
                const value = usernameInput.value;
                const cursor = usernameInput.selectionStart;
                const lower = value.toLowerCase();
                const rejected = [...new Set(lower.replace(/[a-z0-9._-]/g, ''))];
                const cleaned = lower.replace(/[^a-z0-9._-]/g, '');
                rejectedChars = rejected.map(c => c === ' ' ? 'lo spazio' : `"${c}"`).join(', ');
                if (cleaned !== value) {
                    const removedBeforeCursor = lower.slice(0, cursor).replace(/[a-z0-9._-]/g, '').length;
                    usernameInput.value = cleaned;
                    const position = Math.max(0, cursor - removedBeforeCursor);
                    usernameInput.setSelectionRange(position, position);
                }
            };
            const checkRegisterFields = () => {
                const username = usernameInput.value;
                if (rejectedChars) {
                    setHint('registerUsernameHint', 'error', `Non puoi usare ${rejectedChars}: solo lettere senza accenti, numeri, punto (.), trattino (-) e _.`);
                } else if (!username) {
                    setHint('registerUsernameHint', '', 'Da 3 a 20 caratteri: lettere, numeri, punto (.), trattino (-) e _. Serve per entrare.');
                } else if (username.length < 3) {
                    setHint('registerUsernameHint', 'error', `Troppo corto: ancora ${3 - username.length} ${3 - username.length === 1 ? 'carattere' : 'caratteri'}.`);
                } else {
                    setHint('registerUsernameHint', 'ok', `✓ Entrerai come "${username}".`);
                }

                const name = nameInput.value.trim();
                setHint('registerNameHint', name ? 'ok' : '', name
                    ? `✓ Gli altri ti vedranno come "${name}" (${name.length}/10).`
                    : "Obbligatorio: un nome breve, fino a 10 caratteri (es. Ely, Maria, Ugo).");

                const password = passwordInput.value;
                if (!password) setHint('registerPasswordHint', '', 'Almeno 6 caratteri.');
                else if (password.length < 6) setHint('registerPasswordHint', 'error', `Troppo corta: ancora ${6 - password.length} ${6 - password.length === 1 ? 'carattere' : 'caratteri'}.`);
                else setHint('registerPasswordHint', 'ok', '✓ Password valida.');

                const confirm = confirmInput.value;
                if (!confirm) setHint('registerPasswordConfirmHint', '', 'Scrivi di nuovo la stessa password.');
                else if (confirm !== password) setHint('registerPasswordConfirmHint', 'error', 'Le due password non coincidono.');
                else setHint('registerPasswordConfirmHint', 'ok', '✓ Le password coincidono.');
            };
            usernameInput.oninput = () => { cleanUsernameInput(); checkRegisterFields(); };
            [nameInput, passwordInput, confirmInput].forEach(input => { input.oninput = checkRegisterFields; });
            checkRegisterFields();

            registerForm.onsubmit = async (e) => {
                e.preventDefault();
                const username = this.normalizeUsername(document.getElementById('registerUsername').value);
                const name = document.getElementById('registerName').value.trim();
                const password = document.getElementById('registerPassword').value;
                const confirm = document.getElementById('registerPasswordConfirm').value;

                if (!this.isValidUsername(username)) {
                    showError('Username: da 3 a 20 caratteri tra lettere, numeri, punto, trattino e _');
                    return;
                }
                if (!name) {
                    showError('Scrivi il nome con cui ti vedranno gli altri (fino a 10 caratteri)');
                    return;
                }
                if (password.length < 6) {
                    showError('Password troppo corta: almeno 6 caratteri');
                    return;
                }
                if (password !== confirm) {
                    showError('Le due password non coincidono');
                    return;
                }

                showError('');
                setBusy(registerForm, true);
                let createdUser = null;
                try {
                    const cred = await firebase.auth().createUserWithEmailAndPassword(this.usernameToEmail(username), password);
                    createdUser = cred.user;
                    await database.ref(`users/${cred.user.uid}`).set({
                        username: username,
                        name: name,
                        createdAt: Date.now()
                    });
                    createdUser = null; // profilo salvato: l'account è completo
                    await finish(cred.user);
                } catch (error) {
                    // Account creato ma profilo non salvato (es. regole Firebase): lo annullo,
                    // altrimenti lo username resta occupato e non si può riprovare
                    if (createdUser) {
                        await createdUser.delete().catch(e => console.error('Errore annullamento account:', e));
                    }
                    console.error('Errore registrazione:', error);
                    showError(this.authErrorMessage(error));
                } finally {
                    setBusy(registerForm, false);
                }
            };

            showTab('login');
            modal.classList.add('active');
        });
    }

    displayWelcomeMessage() {
        const welcomeEl = document.getElementById('welcomeMessage');
        if (welcomeEl && this.userName) {
            welcomeEl.textContent = `👋 Benvenuto, ${this.userName}!`;
        }
    }

    // Nomi di tutti gli utenti, per partecipanti e creatori
    async loadUserNames() {
        try {
            const usersSnap = await database.ref('users').once('value');
            const names = {};
            const users = Object.entries(usersSnap.val() || {}).filter(([, user]) => user);
            users.forEach(([id, user]) => {
                names[id] = user.name || user.username || 'Sconosciuto';
            });
            this.userNames = names;

            // Colore di ogni utente: in ordine di registrazione, così chi si registra dopo
            // non cambia il colore degli altri e i primi 12 hanno tutti colori diversi
            this.userColorIndex = {};
            users
                .sort(([idA, a], [idB, b]) => (a.createdAt || 0) - (b.createdAt || 0) || idA.localeCompare(idB))
                .forEach(([id], index) => { this.userColorIndex[id] = index; });
            if (this.userId) this.userNames[this.userId] = this.userName;
        } catch (error) {
            console.error('Errore caricamento nomi utenti:', error);
        }
    }

    // Colore fisso di un utente (nuvolette della chat, pallino nei partecipanti)
    getUserColor(userId) {
        const palette = [
            { bg: '#1e88e5', text: '#fff' }, { bg: '#e53935', text: '#fff' }, { bg: '#43a047', text: '#fff' },
            { bg: '#8e24aa', text: '#fff' }, { bg: '#fb8c00', text: '#fff' }, { bg: '#00897b', text: '#fff' },
            { bg: '#d81b60', text: '#fff' }, { bg: '#3949ab', text: '#fff' }, { bg: '#6d4c41', text: '#fff' },
            { bg: '#c0ca33', text: '#333' }, { bg: '#00acc1', text: '#fff' }, { bg: '#f4511e', text: '#fff' }
        ];
        let index = this.userColorIndex ? this.userColorIndex[userId] : undefined;
        if (index === undefined) {
            // Utente non in elenco (registrato dopo l'apertura o vecchio dispositivo): colore dal suo id
            index = 0;
            for (const char of String(userId || '')) index = (index * 31 + char.charCodeAt(0)) >>> 0;
        }
        return palette[index % palette.length];
    }

    // Nome di un utente: dalla cache, altrimenti da users/
    async resolveUserName(id) {
        if (!id) return 'Sconosciuto';
        if (this.userNames[id]) return this.userNames[id];
        try {
            const user = (await database.ref(`users/${id}`).once('value')).val();
            const name = user ? (user.name || user.username) : null;
            if (name) this.userNames[id] = name;
            return name || 'Sconosciuto';
        } catch (error) {
            console.error('Errore caricamento nome utente:', id, error);
            return 'Sconosciuto';
        }
    }

    // Nomi non ancora in cache (utente registrato dopo l'apertura dell'app): li carico e ridisegno
    ensureUserNames(ids) {
        if (!this.requestedNames) this.requestedNames = new Set();
        const missing = ids.filter(id => id && !this.userNames[id] && !this.requestedNames.has(id));
        if (missing.length === 0) return;
        missing.forEach(id => this.requestedNames.add(id));
        Promise.all(missing.map(id => this.resolveUserName(id))).then(() => this.render());
    }

    getParticipantName(participantId) {
        return (participantId && this.userNames[participantId]) || 'Sconosciuto';
    }

    updateEditNameButtonText() {
        // Il nome si cambia da 👤 Utente: aggiorno il nome mostrato nel profilo
        const nameEl = document.getElementById('userProfileName');
        if (nameEl) nameEl.textContent = this.userName || 'Non impostato';
    }

    showEditNameModal() {
        const menuDropdown = document.getElementById('menuDropdown');
        if (menuDropdown) menuDropdown.style.display = 'none';

        const modal = document.getElementById('namePromptModal');
        const form = document.getElementById('namePromptForm');
        const input = document.getElementById('nameInput');
        const cancelBtn = document.getElementById('namePromptCancelBtn');

        input.value = this.userName || '';
        modal.classList.add('active');
        input.focus();

        // onsubmit/onclick sostituiscono i gestori precedenti: niente listener accumulati
        form.onsubmit = async (e) => {
            e.preventDefault();
            const newName = input.value.trim();
            if (!newName) {
                this.showErrorPopup('Il nome non può essere vuoto');
                return;
            }
            try {
                await database.ref(`users/${this.userId}/name`).set(newName);
                this.userName = newName;
                this.userNames[this.userId] = newName;
                this.displayWelcomeMessage();
                modal.classList.remove('active');
                this.showSuccessPopup('Nome aggiornato');
            } catch (error) {
                this.notifyWriteError('Cambio del nome', error);
            }
        };

        cancelBtn.onclick = (e) => {
            e.preventDefault();
            modal.classList.remove('active');
        };
    }

    openChangePassword() {
        this.closeUserProfile();
        const modal = document.getElementById('passwordModal');
        const form = document.getElementById('passwordForm');
        const errorEl = document.getElementById('passwordError');
        form.reset();
        errorEl.style.display = 'none';
        modal.classList.add('active');
        document.getElementById('currentPassword').focus();

        const showError = (message) => {
            errorEl.textContent = message;
            errorEl.style.display = 'block';
        };

        form.onsubmit = async (e) => {
            e.preventDefault();
            const current = document.getElementById('currentPassword').value;
            const next = document.getElementById('newPassword').value;
            const confirm = document.getElementById('newPasswordConfirm').value;
            if (next.length < 6) {
                showError('La nuova password deve avere almeno 6 caratteri');
                return;
            }
            if (next !== confirm) {
                showError('Le due password nuove non coincidono');
                return;
            }

            const user = firebase.auth().currentUser;
            try {
                const credential = firebase.auth.EmailAuthProvider.credential(user.email, current);
                await user.reauthenticateWithCredential(credential);
                await user.updatePassword(next);
                modal.classList.remove('active');
                this.showSuccessPopup('Password cambiata');
            } catch (error) {
                showError(this.authErrorMessage(error));
            }
        };

        document.getElementById('passwordCancelBtn').onclick = (e) => {
            e.preventDefault();
            modal.classList.remove('active');
        };
    }

    async logout() {
        this.closeUserProfile();
        const confirmed = await this.showConfirmDialog('Vuoi uscire dal tuo account su questo dispositivo?', 'Esci', '#667eea');
        if (!confirmed) return;
        await this.stopPresence(); // l'omino sparisce subito per gli altri
        this.userId = null; // evita il doppio reload dal listener di onAuthStateChanged
        await firebase.auth().signOut();
        location.reload();
    }

    init() {
        try {
            this.setupEventListeners();
        } catch (e) {
            console.warn('Errore setup listener:', e.message);
        }
        this.setupNotificationListeners();
        this.setupLimitWarnings();
        this.setupAdminListeners();
        this.listenSettings();
        this.recordAppOpen();
        this.detectDevice();
        this.loadVersion();
        this.loadTitle();
        this.displayWelcomeMessage();
        this.updateEditNameButtonText();
        // Eventi e nomi degli utenti PRIMA di renderizzare
        Promise.all([this.loadEvents(), this.loadUserNames(), this.loadReadStatus()]).then(() => {
            this.cleanupPastEvents();
            this.render();
            this.startPresence(); // dopo i nomi degli utenti: servono per gli omini
            this.listenProposals();
            // Nascondi il loading quando tutto è pronto
            const loadingScreen = document.getElementById('loadingScreen');
            if (loadingScreen) {
                loadingScreen.style.display = 'none';
            }
        });
    }

    loadVersion() {
        fetch('./descrizioni/versione')
            .then(response => response.text())
            .then(version => {
                const versionText = version.trim();
                // Valida il formato x.x.x
                if (/^\d+\.\d+\.\d+$/.test(versionText)) {
                    document.querySelector('footer p').innerHTML = `🪫 Powerd By: adaidone - 🆚 ${versionText}`;
                } else {
                    // Versione non valida - nascondi il sito
                    this.showError();
                }
            })
            .catch(error => {
                // Errore nel caricamento del file - nascondi il sito
                this.showError();
            });
    }

    loadTitle() {
        fetch('./descrizioni/titolo')
            .then(response => response.text())
            .then(content => {
                if (this.settingsTitleOverridden) return; // c'è il titolo impostato dall'amministratore
                const lines = content.trim().split('\n');
                if (lines[0]) {
                    document.getElementById('titleLine1').textContent = lines[0];
                }
                if (lines[1]) {
                    document.getElementById('titleLine2').textContent = lines[1];
                }
                if (lines[2]) {
                    document.getElementById('titleLine3').textContent = lines[2];
                }
            })
            .catch(error => {
                // Se il file non esiste, usa i titoli di default (già presenti in HTML)
            });
    }

    showError() {
        document.getElementById('mainContainer').style.display = 'none';
        document.getElementById('errorContainer').style.display = 'flex';
    }

    detectDevice() {
        // Rileva se è mobile o desktop
        // Controlla sia la larghezza che l'user-agent per affidabilità
        const screenWidth = window.innerWidth;
        const isMobileByWidth = screenWidth < 768;
        const isMobileByAgent = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

        const isMobile = isMobileByWidth || isMobileByAgent;

        // Carica la preferenza dal localStorage se esiste
        const savedView = localStorage.getItem('preferredView');
        if (savedView !== null) {
            this.isListView = savedView === 'list';
        } else if (isMobile) {
            // Di default: lista su mobile, calendario su desktop
            this.isListView = true;
        }

        // Rotazione dello schermo: la vista (lista o calendario) NON cambia mai da sola;
        // si cambia solo dal menu. Nell'app installata si prova anche a bloccare lo schermo in
        // verticale (Android lo fa già dal manifest; iPhone e i browser non lo permettono)
        const runningAsApp = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
        if (runningAsApp && screen.orientation && screen.orientation.lock) {
            screen.orientation.lock('portrait').catch(() => { /* non supportato: si ignora */ });
        }
    }

    setupEventListeners() {
        // Helper per aggiungere listener in modo sicuro
        const addListener = (selector, event, callback) => {
            const el = selector.startsWith('.')
                ? document.querySelector(selector)
                : document.getElementById(selector);
            if (el) {
                el.addEventListener(event, callback);
            }
        };

        // Menu dropdown
        const menuBtn = document.getElementById('menuBtn');
        const menuDropdown = document.getElementById('menuDropdown');

        if (menuBtn && menuDropdown) {
            menuBtn.addEventListener('click', () => {
                menuDropdown.style.display = menuDropdown.style.display === 'none' ? 'block' : 'none';
            });

            // Chiudi menu quando clicca fuori
            document.addEventListener('click', (e) => {
                if (e.target !== menuBtn && !menuDropdown.contains(e.target)) {
                    menuDropdown.style.display = 'none';
                }
            });
        }

        // Utente: il cambio del nome ora è dentro il profilo
        const userProfileNameBtn = document.getElementById('userProfileNameBtn');
        if (userProfileNameBtn) {
            userProfileNameBtn.addEventListener('click', () => {
                this.closeUserProfile();
                this.showEditNameModal();
            });
        }

        // Visualizzazione: Calendario o Lista (prima era "Cambia Modalità" nel menu)
        document.querySelectorAll('.view-choice-btn').forEach(btn => {
            btn.addEventListener('click', () => this.setView(btn.dataset.view === 'list'));
        });

        addListener('prevBtn', 'click', () => this.previousMonth());
        addListener('nextBtn', 'click', () => this.nextMonth());
        addListener('.btn-today', 'click', () => this.today());

        const closeBtn = document.getElementById('closeBtn');
        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.closeModal();
            });
        }

        const modal = document.getElementById('modal');
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) this.closeModal();
            });
        }

        const noteForm = document.getElementById('noteForm');
        if (noteForm) {
            noteForm.addEventListener('submit', (e) => this.addNote(e));
        }

        // Seleziona colore form aggiunta evento
        document.querySelectorAll('.color-select').forEach(option => {
            option.addEventListener('change', (e) => {
                this.selectedColor = e.target.dataset.color;
                this.updateCategoryDisplay('addCategorySelect');
                this.closeCategorySelects();
            });
        });

        // Seleziona colore form modifica evento
        document.querySelectorAll('input[name="editEventColor"]').forEach(option => {
            option.addEventListener('change', (e) => {
                this.selectedColor = e.target.dataset.color;
                // Auto-save della categoria
                this.updateCategoryDisplay('editCategorySelect');
                this.closeCategorySelects();
                if (this.editingNote) {
                    this.updateEvent(this.editingNote.id, { color: this.selectedColor });
                }
            });
        });

        // Categoria (crea e modifica): apre/chiude la lista; si chiude cliccando fuori
        document.querySelectorAll('.category-select-current').forEach(button => {
            button.addEventListener('click', (e) => {
                e.preventDefault();
                const select = button.closest('.category-select');
                const wasOpen = select.classList.contains('open');
                this.closeCategorySelects();
                if (wasOpen) return;
                select.classList.add('open');
                // La categoria scelta al centro: si vedono anche quella sopra e quella sotto
                const list = select.querySelector('.category-select-options');
                const checked = select.querySelector('input:checked');
                const row = checked ? checked.closest('.category-option') : null;
                list.scrollTop = row ? row.offsetTop - (list.clientHeight - row.offsetHeight) / 2 : 0;
            });
        });
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.category-select')) this.closeCategorySelects();
        });

        // Matita sulla copertina (crea e modifica): mostra/nasconde i pulsanti dell'immagine
        [['editImageToggleBtn', 'editImagePanel'], ['addImageToggleBtn', 'addImagePanel'], ['proposalImageToggleBtn', 'proposalImagePanel']].forEach(([buttonId, panelId]) => {
            document.getElementById(buttonId).addEventListener('click', (e) => {
                e.preventDefault();
                const panel = document.getElementById(panelId);
                panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
            });
        });

        // Tab navigation
        document.querySelectorAll('.modal-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                const tabName = e.target.dataset.tab;
                const modal = e.target.closest('.modal-content');

                // Rimuovi active da tutti i tab e contenuti
                modal.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
                modal.querySelectorAll('.modal-tab-content').forEach(c => c.classList.remove('active'));

                // Aggiungi active al tab cliccato e al suo contenuto
                e.target.classList.add('active');
                modal.querySelector(`#${tabName}`).classList.add('active');

                // La chat è nella scheda Partecipanti: aprendola si va all'ultimo messaggio
                // (finché la scheda è nascosta lo scroll non ha effetto)
                if (tabName === 'edit-participants-tab') {
                    const messages = document.getElementById('chatMessagesContainer');
                    if (messages) messages.scrollTop = messages.scrollHeight;
                }

                // Mostra/nascondi il button Salva solo nella tab Evento
                const saveEditBtn = document.getElementById('saveEditBtn');
                if (saveEditBtn) {
                    if (tabName === 'edit-evento-tab' && this.canEditCurrentEvent) {
                        saveEditBtn.style.display = 'inline-block';
                    } else {
                        saveEditBtn.style.display = 'none';
                    }
                }
            });
        });

        // Partecipanti del modal di modifica
        this.editParticipantsList = [];

        // Form "Evento senza data": immagine (si chiude dopo ogni azione)
        document.getElementById('proposalImageUploadBtn').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('proposalImage').click();
        });
        document.getElementById('proposalImage').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            this.closeProposalImagePanel();
            const reader = new FileReader();
            reader.onload = (event) => {
                this.currentCropType = 'proposal';
                this.openCropperModal(event.target.result);
            };
            reader.readAsDataURL(file);
        });
        document.getElementById('proposalImageDeleteBtn').addEventListener('click', (e) => {
            e.preventDefault();
            this.proposalImageData = null;
            this.proposalImageRemoved = true; // In modifica: l'immagine attuale si cancella con "Salva"
            document.getElementById('proposalImage').value = '';
            this.setProposalCover(null);
            this.closeProposalImagePanel();
            this.showSuccessPopup('Immagine rimossa');
        });
        document.getElementById('proposalImageUrlBtn').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('proposalImageUrlInputContainer').style.display = 'flex';
        });
        document.getElementById('proposalImageUrlSaveBtn').addEventListener('click', (e) => {
            e.preventDefault();
            const url = document.getElementById('proposalImageUrl').value.trim();
            if (!url) {
                this.showErrorPopup('Scrivi l\'indirizzo dell\'immagine oppure chiudi');
                return;
            }
            this.loadImageFromUrl(url, 'proposal');
            document.getElementById('proposalImageUrl').value = '';
            this.closeProposalImagePanel();
        });

        // Form "Evento senza data": categoria e link
        document.querySelectorAll('input[name="proposalColor"]').forEach(option => {
            option.addEventListener('change', () => {
                this.updateCategoryDisplay('proposalCategorySelect');
                this.closeCategorySelects();
            });
        });
        document.getElementById('proposalLinkOpenBtn').addEventListener('click', (e) => {
            e.preventDefault();
            const url = this.safeLink(this.currentProposalLink);
            if (url) window.open(url, '_blank', 'noopener');
        });
        document.getElementById('proposalLinkModifyBtn').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('proposalLinkContainer').style.display = 'none';
            document.getElementById('proposalLinkInputContainer').style.display = 'flex';
            document.getElementById('proposalLink').focus();
        });
        document.getElementById('proposalLinkSaveBtn').addEventListener('click', (e) => {
            e.preventDefault();
            const check = this.checkLink(document.getElementById('proposalLink').value);
            this.clearFieldErrors();
            if (check.error || !check.value) {
                this.markFieldError({ id: 'proposalLink', anchor: 'proposalLinkInputContainer', label: 'Link',
                    message: check.error || 'è vuoto: scrivi l\'indirizzo del sito oppure premi ✖' });
                return;
            }
            this.renderProposalLink(check.value);
        });
        document.getElementById('proposalLinkDeleteBtn').addEventListener('click', (e) => {
            e.preventDefault();
            this.renderProposalLink('');
        });
        document.getElementById('proposalLinkCancelBtn').addEventListener('click', (e) => {
            e.preventDefault();
            this.renderProposalLink(this.currentProposalLink);
        });

        // Elenco partecipanti: si apre e si chiude toccando l'intestazione
        document.getElementById('participantsToggleBtn').addEventListener('click', (e) => {
            e.preventDefault();
            const list = document.getElementById('editParticipantsList');
            this.setParticipantsListOpen(list.style.display === 'none');
        });

        // Settings
        const settingsBtn = document.getElementById('settingsBtn');
        if (settingsBtn) settingsBtn.addEventListener('click', () => { this.closeMenu(); this.openSettings(); });
        const closeSettingsBtn = document.getElementById('closeSettingsBtn');
        if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', () => this.closeSettings());

        // Info
        const infoBtn = document.getElementById('infoBtn');
        if (infoBtn) infoBtn.addEventListener('click', () => { this.closeMenu(); this.openInfo(); });
        const guideBtn = document.getElementById('guideBtn');
        if (guideBtn) guideBtn.addEventListener('click', () => { this.closeMenu(); this.openGuide(); });
        const closeInfoBtn = document.getElementById('closeInfoBtn');
        if (closeInfoBtn) closeInfoBtn.addEventListener('click', () => this.closeInfo());
        const infoModal = document.getElementById('infoModal');
        if (infoModal) {
            infoModal.addEventListener('click', (e) => {
                if (e.target === infoModal) this.closeInfo();
            });
        }

        // User Profile
        const userProfileBtn = document.getElementById('userProfileBtn');
        if (userProfileBtn) {
            userProfileBtn.addEventListener('click', () => this.openUserProfile());
        }

        const userProfileCloseBtn = document.getElementById('userProfileCloseBtn');
        if (userProfileCloseBtn) {
            userProfileCloseBtn.addEventListener('click', () => this.closeUserProfile());
        }

        const userProfileLogoutBtn = document.getElementById('userProfileLogoutBtn');
        if (userProfileLogoutBtn) {
            userProfileLogoutBtn.addEventListener('click', () => this.logout());
        }

        const userProfilePasswordBtn = document.getElementById('userProfilePasswordBtn');
        if (userProfilePasswordBtn) {
            userProfilePasswordBtn.addEventListener('click', () => this.openChangePassword());
        }

        // Color filters
        document.querySelectorAll('.color-filter').forEach(checkbox => {
            checkbox.addEventListener('change', () => this.handleColorFilterChange());
        });

        // View Toggle
        document.getElementById('viewToggleBtn').addEventListener('click', () => this.toggleView());

        // Edit Modal
        document.getElementById('closeEditBtn').addEventListener('click', (e) => {
            e.preventDefault();
            this.closeEditModal();
        });
        document.getElementById('deleteNoteBtn').addEventListener('click', (e) => {
            e.preventDefault();
            this.deleteCurrentNote();
        });
        document.getElementById('saveEditBtn').addEventListener('click', (e) => {
            e.preventDefault();
            this.saveEditedNote();
        });
        document.getElementById('editModal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('editModal')) this.closeEditModal();
        });

        const participateBtn = document.getElementById('editWantToParticipateBtn');
        if (participateBtn) {
            participateBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.addCurrentUserToParticipants();
            });
        } else {
            console.warn('Button "editWantToParticipateBtn" non trovato');
        }

        // Chat send button
        const chatSendBtn = document.getElementById('chatSendBtn');
        if (chatSendBtn) {
            chatSendBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.sendChatMessage();
            });
        }

        // Chat input: invia con Enter
        const chatInput = document.getElementById('chatMessageInput');
        if (chatInput) {
            chatInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.sendChatMessage();
                }
            });
        }

        // Event Image buttons
        document.getElementById('eventImageUploadBtn').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('eventImage').click();
        });

        document.getElementById('eventImage').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                this.closeAddImagePanel();
                const reader = new FileReader();
                reader.onload = (event) => {
                    this.currentCropType = 'event';
                    this.openCropperModal(event.target.result);
                };
                reader.readAsDataURL(file);
            }
        });

        document.getElementById('eventImageDeleteBtn').addEventListener('click', (e) => {
            e.preventDefault();
            this.eventImageData = null;
            document.getElementById('eventImage').value = '';
            document.getElementById('eventCoverContainerAdd').style.backgroundImage = 'none';
            this.closeAddImagePanel();
            this.showSuccessPopup('Immagine rimossa');
        });

        document.getElementById('eventImageUrlBtn').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('eventImageUrlInputContainer').style.display = 'flex';
        });

        document.getElementById('eventImageUrlSaveBtn').addEventListener('click', (e) => {
            e.preventDefault();
            const url = document.getElementById('eventImageUrl').value.trim();
            if (!url) {
                this.showErrorPopup('Scrivi l\'indirizzo dell\'immagine oppure chiudi');
                return;
            }
            this.loadImageFromUrl(url, 'event');
            document.getElementById('eventImageUrl').value = '';
            this.closeAddImagePanel();
        });

        // Edit Image buttons
        document.getElementById('editImageUploadBtn').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('editImage').click();
        });

        document.getElementById('editImage').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                this.closeEditImagePanel();
                const reader = new FileReader();
                reader.onload = (event) => {
                    this.currentCropType = 'edit';
                    this.openCropperModal(event.target.result);
                };
                reader.readAsDataURL(file);
            }
        });

        document.getElementById('editImageDeleteBtn').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('editImage').value = '';
            document.getElementById('eventCoverContainer').style.backgroundImage = 'none';
            if (this.editingNote) {
                const eventId = this.editingNote.id;
                this.saveEventImage(eventId, null);
                this.updateEvent(eventId, { imageVersion: null });
            }
            this.closeEditImagePanel();
            this.showSuccessPopup('Immagine rimossa');
        });

        document.getElementById('editImageUrlBtn').addEventListener('click', (e) => {
            e.preventDefault();
            // Mostra il container con input URL
            document.getElementById('editImageUrlInputContainer').style.display = 'flex';
        });

        document.getElementById('editImageUrlSaveBtn').addEventListener('click', (e) => {
            e.preventDefault();
            const url = document.getElementById('editImageUrl').value.trim();
            if (!url) {
                this.showErrorPopup('Scrivi l\'indirizzo dell\'immagine oppure chiudi');
                return;
            }
            this.loadImageFromUrl(url, 'edit');
            document.getElementById('editImageUrl').value = '';
            this.closeEditImagePanel();
        });

        // Cropper buttons
        document.getElementById('cropSaveBtn').addEventListener('click', (e) => {
            e.preventDefault();
            this.saveCrop();
        });

        document.getElementById('cropCancelBtn').addEventListener('click', (e) => {
            e.preventDefault();
            this.closeCropperModal();
            document.getElementById('eventImage').value = '';
            document.getElementById('editImage').value = '';
        });

        // Edit Link buttons
        document.getElementById('editLinkOpenBtn').addEventListener('click', (e) => {
            e.preventDefault();
            const url = this.safeLink(this.currentEditingLink); // solo http/https, aggiunge https:// se manca
            if (url) window.open(url, '_blank', 'noopener');
        });

        document.getElementById('editLinkModifyBtn').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('editLinkContainer').style.display = 'none';
            document.getElementById('editLinkInputContainer').style.display = 'flex';
        });

        document.getElementById('editLinkSaveBtn').addEventListener('click', (e) => {
            e.preventDefault();
            const check = this.checkLink(document.getElementById('editLink').value);
            this.clearFieldErrors();
            if (check.error || !check.value) {
                this.markFieldError({ id: 'editLink', anchor: 'editLinkInputContainer', label: 'Link',
                    message: check.error || 'è vuoto: scrivi l\'indirizzo del sito oppure premi ✖' });
                return;
            }
            if (this.editingNote) {
                this.updateEvent(this.editingNote.id, { link: check.value });
                this.renderEditLink(check.value);
                this.showSuccessPopup('Link salvato');
            }
        });

        document.getElementById('editLinkDeleteBtn').addEventListener('click', (e) => {
            e.preventDefault();
            if (this.editingNote) {
                this.updateEvent(this.editingNote.id, { link: '' });
                this.renderEditLink('');
                this.showSuccessPopup('Link eliminato');
            }
        });

        document.getElementById('editLinkCancelBtn').addEventListener('click', (e) => {
            e.preventDefault();
            const editingEvent = this.getEditingEvent();
            const currentLink = editingEvent ? editingEvent.link : '';
            this.renderEditLink(currentLink);
        });

        // Event Link buttons (per aggiungere nuovo evento)
        document.getElementById('eventLinkOpenBtn').addEventListener('click', (e) => {
            e.preventDefault();
            const url = this.safeLink(this.currentEventLink); // solo http/https, aggiunge https:// se manca
            if (url) window.open(url, '_blank', 'noopener');
        });

        document.getElementById('eventLinkModifyBtn').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('eventLinkContainer').style.display = 'none';
            document.getElementById('eventLinkInputContainer').style.display = 'flex';
        });

        const eventLinkSaveBtn = document.getElementById('eventLinkSaveBtn');
        if (eventLinkSaveBtn) {
            eventLinkSaveBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const check = this.checkLink(document.getElementById('eventLink').value);
                this.clearFieldErrors();
                if (check.error || !check.value) {
                    this.markFieldError({ id: 'eventLink', anchor: 'eventLinkInputContainer', label: 'Link',
                        message: check.error || 'è vuoto: scrivi l\'indirizzo del sito oppure premi ✖' });
                    return;
                }
                this.currentEventLink = check.value;
                this.renderEventLink(check.value);
                this.showSuccessPopup('Link salvato');
            });
        }

        const eventLinkDeleteBtn = document.getElementById('eventLinkDeleteBtn');
        if (eventLinkDeleteBtn) {
            eventLinkDeleteBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.currentEventLink = '';
                const linkInput = document.getElementById('eventLink');
                if (linkInput) linkInput.value = '';
                this.renderEventLink('');
                this.showSuccessPopup('Link eliminato');
            });
        }

        const eventLinkCancelBtn = document.getElementById('eventLinkCancelBtn');
        if (eventLinkCancelBtn) {
            eventLinkCancelBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const currentLink = this.currentEventLink || '';
                this.renderEventLink(currentLink);
            });
        }

        // GIF Modal
        const titleLine2 = document.getElementById('titleLine2');
        if (titleLine2) {
            titleLine2.addEventListener('click', () => {
                const text = titleLine2.textContent;
                if (text === 'Ma io che cazzo ne so, scusi?') {
                    this.toggleGifModal();
                }
            });
        }
        const gifModal = document.getElementById('gifModal');
        if (gifModal) {
            gifModal.addEventListener('click', (e) => {
                if (e.target === gifModal) this.toggleGifModal();
            });
        }

        // Select Day Modal
        const closeSelectDayBtn = document.getElementById('closeSelectDayBtn');
        if (closeSelectDayBtn) {
            closeSelectDayBtn.addEventListener('click', () => {
                this.closeSelectDayModal();
            });
        }

        const selectDayModal = document.getElementById('selectDayModal');
        if (selectDayModal) {
            selectDayModal.addEventListener('click', (e) => {
                if (e.target === selectDayModal) {
                    this.closeSelectDayModal();
                }
            });
        }

        this.setupProposalListeners();
    }

    showLoading() {
        const loadingScreen = document.getElementById('loadingScreen');
        if (loadingScreen) {
            loadingScreen.style.display = 'flex';
        }
    }

    hideLoading() {
        const loadingScreen = document.getElementById('loadingScreen');
        if (loadingScreen) {
            loadingScreen.style.display = 'none';
        }
    }

    updateViewUI() {
        const viewToggleBtn = document.getElementById('viewToggleBtn');
        const listView = document.getElementById('listView');
        const calendarView = document.getElementById('calendarView');

        if (this.isListView) {
            viewToggleBtn.textContent = '📅 Calendario';
            viewToggleBtn.classList.add('active');
            listView.style.display = 'block';
            calendarView.style.display = 'none';
        } else {
            viewToggleBtn.textContent = '📋 Lista';
            viewToggleBtn.classList.remove('active');
            listView.style.display = 'none';
            calendarView.style.display = 'block';
        }
    }

    render() {
        this.showLoading();
        setTimeout(() => {
            this.updateViewUI();
            this.updateHeader();
            if (this.isListView) {
                this.renderList();
            } else {
                this.renderCalendar();
            }
            this.hideLoading();
        }, 50);
    }

    renderCalendar() {
        const year = this.currentDate.getFullYear();
        const month = this.currentDate.getMonth();

        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        const prevLastDay = new Date(year, month, 0);

        const daysInMonth = lastDay.getDate();
        const daysInPrevMonth = prevLastDay.getDate();
        const firstDayOfWeek = firstDay.getDay() === 0 ? 6 : firstDay.getDay() - 1;

        let daysArray = [];

        // Giorni mese precedente
        for (let i = firstDayOfWeek - 1; i >= 0; i--) {
            daysArray.push({
                day: daysInPrevMonth - i,
                isCurrentMonth: false,
                date: new Date(year, month - 1, daysInPrevMonth - i)
            });
        }

        // Giorni mese corrente
        for (let i = 1; i <= daysInMonth; i++) {
            daysArray.push({
                day: i,
                isCurrentMonth: true,
                date: new Date(year, month, i)
            });
        }

        // Giorni mese successivo - solo per completare l'ultima riga (fino a 7 giorni per riga)
        const remainingDays = (7 - (daysArray.length % 7)) % 7;
        for (let i = 1; i <= remainingDays; i++) {
            daysArray.push({
                day: i,
                isCurrentMonth: false,
                date: new Date(year, month + 1, i)
            });
        }

        const daysGrid = document.getElementById('daysGrid');
        daysGrid.innerHTML = '';

        daysArray.forEach(dayObj => {
            const dayEl = document.createElement('div');

            // Controlla se il giorno è oggi o nel passato
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const isDisabledDay = dayObj.isCurrentMonth && dayObj.date <= today;

            let className = 'day';
            if (!dayObj.isCurrentMonth) {
                className += ' other-month'; // Giorni mese precedente/successivo
            } else if (isDisabledDay && dayObj.date < today) {
                className += ' past-event'; // Giorni passati (non oggi)
            }
            dayEl.className = className;

            const dateKey = this.getDateKey(dayObj.date);
            const dayNotes = this.notes[dateKey] || [];
            const visibleNotes = dayNotes.filter(note => this.isColorVisible(note.color));

            // Aggiungi classe has-events se il giorno ha eventi visibili
            if (visibleNotes.length > 0) {
                className += ' has-events';
            }
            dayEl.className = className;

            dayEl.innerHTML = `
                <div class="day-number">${dayObj.day}</div>
                <div class="notes-container" id="notes-${dateKey}">
                    ${visibleNotes.length === 0 ? '<div class="empty-state">✨</div>' : ''}
                </div>
                <button class="add-note-btn" type="button">+</button>
            `;

            // Aggiungi le note al giorno (solo se il colore è visibile)
            const notesContainer = dayEl.querySelector(`#notes-${dateKey}`);

            if (visibleNotes.length > 0) {
                notesContainer.innerHTML = '';
                // Ordina gli eventi per orario
                const sortedNotes = this.sortByTime(dayNotes);

                // Determina se il giorno è nel passato
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const isPastDay = dayObj.date < today;

                sortedNotes.forEach((note) => {
                    // Mostra solo se il colore è visibile
                    if (!this.isColorVisible(note.color)) return;

                    const noteEl = document.createElement('div');
                    noteEl.className = `note ${note.color}`;

                    // Se è un evento passato, rendilo grigio e non cliccabile
                    // Se è oggi, mantieni il colore (acceso)
                    if (isPastDay) {
                        noteEl.classList.add('past-event');
                        noteEl.style.opacity = '0.5';
                        noteEl.style.cursor = 'default';
                    } else {
                        noteEl.style.cursor = 'pointer';
                    }

                    noteEl.setAttribute('data-event-id', note.id);
                    noteEl.innerHTML = `
                        <span class="note-text">${this.escapeHtml(note.title)}</span>
                        <span class="note-badge" style="position: absolute; top: 2px; right: 2px; background: #f44336; color: white; border-radius: 50%; width: 20px; height: 20px; display: none; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: bold;"></span>
                    `;

                    // Click per aprire il dettaglio (solo se non è passato)
                    if (!isPastDay) {
                        noteEl.querySelector('.note-text').addEventListener('click', (e) => {
                            e.stopPropagation();
                            if (this.suppressNextClick) return; // Click generato dalla fine di un trascinamento touch
                            this.openEditModal(note.id);
                        });
                        // Abilita drag and drop solo se il giorno non è passato
                        if (this.canEditEvent(note)) this.setupDragAndDrop(noteEl, dateKey, note.id, dayObj);
                    }

                    notesContainer.appendChild(noteEl);

                    // Aggiorna il badge dei messaggi non letti per questo evento
                    this.updateNoteBadge(noteEl, note.id);
                });
            }

            // Aggiungi listener di click solo se il giorno non è passato e è del mese corrente
            const canAddEvents = !isDisabledDay && dayObj.isCurrentMonth;
            if (canAddEvents) {
                dayEl.addEventListener('click', () => {
                    if (this.suppressNextClick) return;
                    this.openModal(dayObj.date);
                });
                dayEl.style.cursor = 'pointer';
            } else {
                dayEl.style.cursor = 'default';
                // Nascondi il pulsante + per giorni disabilitati o giorni di altri mesi
                dayEl.querySelector('.add-note-btn').style.display = 'none';
            }

            daysGrid.appendChild(dayEl);
        });

        this.renderProposals();
    }

    openModal(date) {
        // Controlla se la data è oggi o nel passato
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (date <= today) {
            this.showErrorPopup('Puoi aggiungere eventi solo da domani in poi');
            return;
        }

        this.selectedDate = date;
        // Pulisci tutti i campi del form
        document.getElementById('eventTitle').value = '';
        document.getElementById('eventTime').value = '';
        document.getElementById('eventLocation').value = '';
        this.setFeeInput('event', 0);
        document.getElementById('eventNotes').value = '';
        document.getElementById('eventLink').value = '';
        document.getElementById('eventImage').value = '';
        this.eventImageData = null;

        // Reset immagine nel container (mantieni il gradiente viola)
        const coverContainerAdd = document.getElementById('eventCoverContainerAdd');
        coverContainerAdd.style.backgroundImage = 'none';
        coverContainerAdd.style.backgroundAttachment = 'scroll';
        coverContainerAdd.style.minHeight = '120px';
        this.closeAddImagePanel();

        // Data: quella del giorno scelto, modificabile (da domani in poi)
        const dateInput = document.getElementById('eventDate');
        dateInput.value = this.getDateKey(date);
        dateInput.min = this.getTomorrowKey();

        // Seleziona il colore neutro di default
        document.querySelector('input[name="eventColor"][data-color="color-neutral"]').checked = true;
        this.selectedColor = 'color-neutral';
        this.updateCategoryDisplay('addCategorySelect');
        this.closeCategorySelects();

        // Reset del link
        this.currentEventLink = '';
        this.renderEventLink('');

        document.getElementById('modal').classList.add('active');
        document.getElementById('modal').style.display = 'flex';
        document.getElementById('eventTitle').focus();
    }

    closeModal() {
        this.clearFieldErrors(); // gli avvisi sui campi non restano per la prossima apertura
        // Pulisci i campi del form
        document.getElementById('eventTitle').value = '';
        document.getElementById('eventTime').value = '';
        document.getElementById('eventLocation').value = '';
        document.getElementById('eventNotes').value = '';
        document.getElementById('eventLink').value = '';
        this.currentEventLink = '';

        document.getElementById('modal').classList.remove('active');
        document.getElementById('modal').style.display = 'none';
        this.selectedDate = null;
    }

    async renderEditParticipants() {
        const listEl = document.getElementById('editParticipantsList');
        if (!listEl) return;

        // Aggiorna il numero di partecipanti e i pallini colorati (visibili anche con l'elenco chiuso)
        const countEl = document.getElementById('participantCountDisplay');
        if (countEl) {
            countEl.textContent = this.editParticipantsList.length;
        }
        const dotsEl = document.getElementById('participantDots');
        if (dotsEl) {
            dotsEl.innerHTML = this.editParticipantsList.map(id =>
                `<span style="flex: 0 0 auto; width: 12px; height: 12px; border-radius: 50%; background: ${this.getUserColor(id).bg}; border: 1px solid rgba(255,255,255,0.7);"></span>`
            ).join('');
        }

        // Carica i nomi di tutti i partecipanti (dalla cache o da users/)
        const participants = [...this.editParticipantsList];
        const names = await Promise.all(participants.map(id => this.resolveUserName(id)));
        listEl.innerHTML = '';

        participants.forEach((participantId, index) => {
            const isCurrentUser = participantId === this.userId;

            const itemEl = document.createElement('div');
            itemEl.className = 'participant-item';

            if (isCurrentUser) {
                itemEl.innerHTML = `
                    <span><span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; background: ${this.getUserColor(participantId).bg};"></span>${this.escapeHtml(names[index])} (tu)</span>
                    <button type="button" class="btn-remove-participant" style="background: #f44336;">Non posso più</button>
                `;
            } else {
                itemEl.innerHTML = `
                    <span><span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; background: ${this.getUserColor(participantId).bg};"></span>${this.escapeHtml(names[index])}</span>
                    ${this.isAdmin ? '<button type="button" class="btn-admin-remove-participant" style="background: #ff9800;">Togli</button>' : ''}
                `;
                const adminRemoveBtn = itemEl.querySelector('.btn-admin-remove-participant');
                if (adminRemoveBtn) {
                    adminRemoveBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        this.adminRemoveParticipant(participantId);
                    });
                }
            }

            const removeBtn = itemEl.querySelector('.btn-remove-participant');
            if (removeBtn) {
                removeBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.editParticipantsList = this.editParticipantsList.filter(p => p !== this.userId);
                    this.renderEditParticipants();
                    this.updateChatInputVisibility(this.editParticipantsList);

                    // Scrive solo la propria iscrizione: non tocca quelle degli altri
                    if (this.editingNote) {
                        database.ref(`events/${this.editingNote.id}/participants/${this.userId}`).remove()
                            .catch(error => this.notifyWriteError('Ritiro dall\'evento', error));
                    }
                });
            }

            listEl.appendChild(itemEl);
        });

        // Aggiorna il button "Voglio partecipare"
        this.updateParticipateButton();

        // Chi non partecipa più: i suoi messaggi diventano grigi
        if (this.currentChat && this.editingNote && this.currentChat.eventId === this.editingNote.id) {
            const messagesContainer = document.getElementById('chatMessagesContainer');
            const scrollTop = messagesContainer.scrollTop;
            messagesContainer.innerHTML = '';
            this.renderChatInto(messagesContainer, this.currentChat.messages, this.currentChat.lastReadTimestamp, this.editParticipantsList, false, this.currentChat.eventId);
            messagesContainer.scrollTop = scrollTop;
        }
    }

    setParticipantsListOpen(open) {
        document.getElementById('editParticipantsList').style.display = open ? 'block' : 'none';
        document.getElementById('participantsToggleArrow').textContent = open ? '▴' : '▾';
        document.getElementById('participantsToggleBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    updateParticipateButton() {
        const btn = document.getElementById('editWantToParticipateBtn');
        if (!btn) {
            console.warn('Button editWantToParticipateBtn non trovato in updateParticipateButton');
            return;
        }
        const isParticipant = this.editParticipantsList.includes(this.userId);
        btn.style.display = isParticipant ? 'none' : 'block';
    }

    addCurrentUserToParticipants() {
        if (!this.editParticipantsList.includes(this.userId)) {
            this.editParticipantsList.push(this.userId);

            // Assicura che il dispositivo corrente sia nella cache dei nomi
            if (!this.userNames[this.userId]) {
                this.userNames[this.userId] = this.userName;
            }

            this.renderEditParticipants();

            // Aggiorna la visibilità dell'input chat
            this.updateChatInputVisibility(this.editParticipantsList);

            // Scrive solo la propria iscrizione: non tocca quelle degli altri
            if (this.editingNote) {
                database.ref(`events/${this.editingNote.id}/participants/${this.userId}`).set(true)
                    .then(() => { this.recordStat('joins'); this.showSuccessPopup('Adesso sei un partecipante!'); })
                    .catch(error => {
                        this.notifyWriteError('Iscrizione all\'evento', error);
                    });
            }
        }
    }

    openCropperModal(imageSrc) {
        const modal = document.getElementById('cropperModal');
        const img = document.getElementById('cropperImage');
        modal.style.display = 'flex';

        // Distruggi il cropper precedente se esiste
        if (this.cropper) {
            this.cropper.destroy();
        }

        // Aspetta che l'immagine sia caricata prima di inizializzare il Cropper
        img.onload = () => {
            this.cropper = new Cropper(img, {
                aspectRatio: 3 / 1, // 3:1 (molto largo, occupa meno spazio)
                responsive: true,
                restore: true,
                guides: true,
                center: true,
                highlight: true,
                cropBoxMovable: true,
                cropBoxResizable: true,
                toggleDragModeOnDblclick: true,
                autoCropArea: 0.8, // Occupa l'80% dello spazio
            });
        };
        img.src = imageSrc;
    }

    saveCrop() {
        if (!this.cropper) return;

        // Limita la risoluzione (3:1) e comprimi per occupare meno spazio
        const canvas = this.cropper.getCroppedCanvas({
            maxWidth: 1200,
            maxHeight: 400,
            fillColor: '#fff',
            imageSmoothingQuality: 'high'
        });
        // Sotto il limite delle regole (100.000 caratteri, ~73 KB): si punta a 80.000.
        // Prima si abbassa la qualità, poi, se non basta, si rimpicciolisce l'immagine
        const TARGET = 80000;
        let source = canvas;
        let quality = 0.65;
        let croppedImage = source.toDataURL('image/jpeg', quality);
        while (croppedImage.length > TARGET && quality > 0.4) {
            quality -= 0.1;
            croppedImage = source.toDataURL('image/jpeg', quality);
        }
        while (croppedImage.length > TARGET && source.width > 300) {
            const smaller = document.createElement('canvas');
            smaller.width = Math.round(source.width * 0.8);
            smaller.height = Math.round(source.height * 0.8);
            const ctx = smaller.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, smaller.width, smaller.height);
            ctx.drawImage(source, 0, 0, smaller.width, smaller.height);
            source = smaller;
            croppedImage = source.toDataURL('image/jpeg', quality);
        }

        if (this.currentCropType === 'event') {
            this.eventImageData = croppedImage;
            // Visualizza l'immagine come copertina
            const coverDiv = document.getElementById('eventCoverContainerAdd');
            coverDiv.style.backgroundImage = `url(${croppedImage})`;
            coverDiv.style.backgroundAttachment = 'scroll';
            coverDiv.style.minHeight = '120px';
        } else if (this.currentCropType === 'proposal') {
            this.proposalImageData = croppedImage;
            this.setProposalCover(croppedImage);
        } else if (this.currentCropType === 'edit') {
            // Visualizza l'immagine come copertina
            const coverDiv = document.getElementById('eventCoverContainer');
            coverDiv.style.backgroundImage = `url(${croppedImage})`;
            coverDiv.style.backgroundAttachment = 'scroll';
            coverDiv.style.minHeight = '120px';

            // Auto-save dell'immagine: prima l'immagine, poi l'evento che la referenzia
            if (this.editingNote) {
                const eventId = this.editingNote.id;
                const imageVersion = Date.now();
                this.saveEventImage(eventId, croppedImage, imageVersion)
                    .then(() => this.updateEvent(eventId, { imageVersion }));
            }
        }

        this.closeCropperModal();
        this.showSuccessPopup('Immagine ritagliata con successo!');
    }

    closeCropperModal() {
        const modal = document.getElementById('cropperModal');
        modal.style.display = 'none';
        if (this.cropper) {
            this.cropper.destroy();
            this.cropper = null;
        }
    }

    loadImageFromUrl(url, type) {
        fetch(url, { mode: 'cors' })
            .then(response => {
                if (!response.ok) throw new Error('Errore nel caricamento');
                return response.blob();
            })
            .then(blob => {
                const reader = new FileReader();
                reader.onload = (event) => {
                    this.currentCropType = type;
                    this.openCropperModal(event.target.result);
                };
                reader.readAsDataURL(blob);
                document.getElementById({ event: 'eventImageUrl', edit: 'editImageUrl', proposal: 'proposalImageUrl' }[type]).value = '';
            })
            .catch(error => {
                this.showErrorPopup('Non riesco a caricare l\'immagine da questo indirizzo: forse non è un\'immagine, oppure il sito non permette di usarla.\nProva a salvarla sul telefono o sul PC e caricala con "Carica Img".');
            });
    }

    renderEventLink(link) {
        const linkContainer = document.getElementById('eventLinkContainer');
        const linkInputContainer = document.getElementById('eventLinkInputContainer');
        const linkInput = document.getElementById('eventLink');
        const openBtn = document.getElementById('eventLinkOpenBtn');
        this.currentEventLink = link;

        // Mostra sempre il container con i button
        linkContainer.style.display = 'flex';
        linkInputContainer.style.display = 'none';
        linkInput.value = link || '';

        // "Vai sul sito" attivo solo se c'è un link; accanto si aggiunge o si modifica il link
        const modifyBtn = document.getElementById('eventLinkModifyBtn');
        const hasLink = !!(link && link.trim());
        openBtn.disabled = !hasLink;
        openBtn.style.opacity = hasLink ? '1' : '0.45';
        openBtn.style.cursor = hasLink ? 'pointer' : 'not-allowed';
        // Con il link: "Vai sul sito" prende quasi tutta la riga, accanto solo la matita
        modifyBtn.textContent = hasLink ? '✏️' : '🔗 Aggiungi link';
        modifyBtn.title = hasLink ? 'Modifica link' : '';
        modifyBtn.style.flex = hasLink ? '0 0 44px' : '1';
        modifyBtn.style.padding = hasLink ? '0' : '';
    }

    renderEditLink(link) {
        const linkContainer = document.getElementById('editLinkContainer');
        const linkInputContainer = document.getElementById('editLinkInputContainer');
        const linkInput = document.getElementById('editLink');
        const openBtn = document.getElementById('editLinkOpenBtn');
        this.currentEditingLink = link;

        // Mostra sempre il container con i button
        linkContainer.style.display = 'flex';
        linkInputContainer.style.display = 'none';
        linkInput.value = link || '';

        // "Vai sul sito" attivo solo se c'è un link; accanto si aggiunge o si modifica il link
        const modifyBtn = document.getElementById('editLinkModifyBtn');
        const hasLink = !!(link && link.trim());
        openBtn.disabled = !hasLink;
        openBtn.style.opacity = hasLink ? '1' : '0.45';
        openBtn.style.cursor = hasLink ? 'pointer' : 'not-allowed';
        // Con il link: "Vai sul sito" prende quasi tutta la riga, accanto solo la matita
        modifyBtn.textContent = hasLink ? '✏️' : '🔗 Aggiungi link';
        modifyBtn.title = hasLink ? 'Modifica link' : '';
        modifyBtn.style.flex = hasLink ? '0 0 44px' : '1';
        modifyBtn.style.padding = hasLink ? '0' : '';
        modifyBtn.style.display = this.canEditCurrentEvent === false ? 'none' : 'block';
    }

    // ===== Quota: vuota o 0 = Gratis, altrimenti l'importo in euro scritto dall'organizzatore =====
    formatFee(fee) {
        if (!fee) return 'Gratis';
        const decimals = Number.isInteger(Number(fee)) ? 0 : 2; // 12,50 € e non 12,5 €
        return `${Number(fee).toLocaleString('it-IT', { minimumFractionDigits: decimals, maximumFractionDigits: 2 })} €`;
    }

    setFeeInput(prefix, fee) {
        document.getElementById(`${prefix}Fee`).value = fee ? String(fee).replace('.', ',') : '';
    }

    // ===== Controllo dei campi prima di salvare (0.5.0) =====
    // Obbligatori sbagliati (nome, data): non si salva e si spiega cosa sistemare.
    // Facoltativi scritti ma sbagliati (link, quota, immagine, prima data): si chiede se salvare senza.
    // Ogni campo sbagliato diventa rosso e sotto compare cosa non va; sparisce appena lo si corregge.

    // Link: spazi all'inizio e alla fine tolti da soli; https:// aggiunto se manca. {value} oppure {error}
    checkLink(raw) {
        const text = String(raw || '').trim();
        if (!text) return { value: '' };
        if (/\s/.test(text)) return { error: 'c\'è uno spazio in mezzo. Un indirizzo si scrive tutto attaccato (es. https://www.sito.it)' };
        if (text.length > 500) return { error: 'è troppo lungo (al massimo 500 caratteri)' };
        const url = this.safeLink(text);
        if (!url) return { error: 'non è l\'indirizzo di un sito. Scrivilo così: https://www.sito.it' };
        const host = new URL(url).hostname;
        if (!host.includes('.') || host.startsWith('.') || host.endsWith('.')) {
            return { error: 'manca il nome del sito con il punto (es. www.sito.it)' };
        }
        if (url.length > 500) return { error: 'è troppo lungo (al massimo 500 caratteri)' };
        return { value: url };
    }

    // Quota: vuota = Gratis. Accetta "15", "15,50", "15.5", "15 €". {value} oppure {error}
    checkFee(raw) {
        const text = String(raw || '').replace('€', '').replace(',', '.').trim();
        if (!text) return { value: 0 };
        const value = Number(text);
        if (!/^\d+(\.\d{1,2})?$/.test(text) || !isFinite(value)) {
            return { error: 'scrivi solo un importo, es. 15 oppure 12,50 (vuota = Gratis)' };
        }
        if (value > 999) return { error: 'al massimo 999 €' };
        return { value: Math.round(value * 100) / 100 };
    }

    // problem: {id, anchor?, label, message, without?, show?}
    markFieldError(problem) {
        const input = document.getElementById(problem.id);
        if (!input) return;
        input.classList.add('field-error');
        const anchor = (problem.anchor && document.getElementById(problem.anchor)) || input;
        const msg = document.createElement('div');
        msg.className = 'field-error-msg';
        msg.dataset.for = problem.id;
        msg.textContent = `⚠️ ${problem.label}: ${problem.message}`;
        anchor.insertAdjacentElement('afterend', msg);
        const clear = () => {
            input.classList.remove('field-error');
            document.querySelectorAll(`.field-error-msg[data-for="${problem.id}"]`).forEach(el => el.remove());
            input.removeEventListener('input', clear);
        };
        input.addEventListener('input', clear);
    }

    clearFieldErrors() {
        document.querySelectorAll('.field-error-msg').forEach(el => el.remove());
        document.querySelectorAll('.field-error').forEach(el => el.classList.remove('field-error'));
    }

    // true = si può salvare (senza i campi facoltativi sbagliati); false = l'utente deve correggere
    async checkFormFields(required, optional, action) {
        this.clearFieldErrors();
        [...required, ...optional].forEach(problem => {
            if (problem.show) problem.show();
            this.markFieldError(problem);
        });
        const line = (problem) => `• ${problem.label}: ${problem.message}`;
        if (required.length) {
            let message = `⚠️ Prima di salvare sistema:\n${required.map(line).join('\n')}`;
            if (optional.length) message += `\n\nControlla anche:\n${optional.map(line).join('\n')}`;
            this.showErrorPopup(message);
            return false;
        }
        if (!optional.length) return true;
        const parts = optional.map(problem => `senza ${problem.without}`);
        const withoutText = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}` : parts[0];
        const ok = await this.showConfirmDialog(
            `❓ ${optional.length > 1 ? 'Alcuni campi non vanno bene' : 'Un campo non va bene'}:\n${optional.map(line).join('\n')}\n\nVuoi ${action} ${withoutText}?`,
            optional.length > 1 ? 'Salva senza questi campi' : 'Salva senza questo campo', '#ff9800', '✏️ Correggo');
        if (ok) this.clearFieldErrors();
        return ok;
    }

    // Indirizzo di un'immagine scritto ma non caricato con ✅
    pendingImageUrlProblem(inputId, containerId, panelId, keepText) {
        const value = document.getElementById(inputId).value.trim();
        if (!value) return null;
        return {
            id: inputId, anchor: containerId, label: 'Immagine',
            message: 'hai scritto un indirizzo ma non hai premuto ✅ per caricarla',
            without: keepText,
            show: () => {
                document.getElementById(panelId).style.display = 'block';
                document.getElementById(containerId).style.display = 'flex';
            }
        };
    }

    setProposalCover(image) {
        const cover = document.getElementById('proposalCoverContainer');
        cover.style.backgroundImage = image ? `url("${image}")` : 'none';
        cover.style.minHeight = image ? '120px' : '';
    }

    closeProposalImagePanel() {
        document.getElementById('proposalImagePanel').style.display = 'none';
        document.getElementById('proposalImageUrlInputContainer').style.display = 'none';
    }

    // Link nel form "Evento senza data": come nel crea evento
    renderProposalLink(link) {
        this.currentProposalLink = link || '';
        const hasLink = !!this.currentProposalLink.trim();
        document.getElementById('proposalLinkContainer').style.display = 'flex';
        document.getElementById('proposalLinkInputContainer').style.display = 'none';
        document.getElementById('proposalLink').value = this.currentProposalLink;
        const openBtn = document.getElementById('proposalLinkOpenBtn');
        openBtn.disabled = !hasLink;
        openBtn.style.opacity = hasLink ? '1' : '0.45';
        openBtn.style.cursor = hasLink ? 'pointer' : 'not-allowed';
        const modifyBtn = document.getElementById('proposalLinkModifyBtn');
        modifyBtn.textContent = hasLink ? '✏️' : '🔗 Aggiungi link';
        modifyBtn.title = hasLink ? 'Modifica link' : '';
        modifyBtn.style.flex = hasLink ? '0 0 44px' : '1';
        modifyBtn.style.padding = hasLink ? '0' : '';
    }

    // Categoria (crea, modifica, proposta): il pulsante mostra la categoria scelta col suo colore
    // e lo sfondo del modal prende il colore della categoria
    updateCategoryDisplay(selectId) {
        const select = document.getElementById(selectId);
        if (!select) return;
        const checked = select.querySelector('input:checked');
        const current = select.querySelector('.category-select-current');
        if (!checked || !current) return;
        const option = checked.closest('.category-option');
        current.textContent = option.textContent.trim();
        current.style.background = option.style.background;
        current.style.color = option.style.color;
        const modal = select.closest('.modal');
        if (modal) this.applyCategoryTheme(modal.id, checked.dataset.color);
    }

    // Sfondo del modal per categoria: sfumatura dal colore della categoria a una sua tonalità più scura
    // (abbastanza scura per il testo bianco). Senza categoria = viola dell'app
    applyCategoryTheme(modalId, color) {
        const themes = {
            'color-neutral': ['#667eea', '#764ba2'],
            'color-yellow': ['#fbc02d', '#f57f17'],
            'color-pink': ['#ec407a', '#ad1457'],
            'color-green': ['#66bb6a', '#2e7d32'],
            'color-blue': ['#42a5f5', '#1565c0'],
            'color-purple': ['#26a69a', '#00695c'], // Concerti (verde acqua)
            'color-teal': ['#b71c1c', '#7f0000'],   // Teatro (rosso sipario)
            'color-orange': ['#fb8c00', '#e64a19']
        };
        const [from, to] = themes[color] || themes['color-neutral'];
        const content = document.querySelector(`#${modalId} .modal-content`);
        // !important: il CSS di .modal-content usa !important per il viola di base
        if (content) content.style.setProperty('background', `linear-gradient(135deg, ${from} 0%, ${to} 100%)`, 'important');
    }

    closeCategorySelects() {
        document.querySelectorAll('.category-select.open').forEach(select => select.classList.remove('open'));
    }

    // Pannello immagine della copertina (si apre con la matita): si chiude dopo ogni azione
    closeEditImagePanel() {
        document.getElementById('editImagePanel').style.display = 'none';
        document.getElementById('editImageUrlInputContainer').style.display = 'none';
    }

    closeAddImagePanel() {
        document.getElementById('addImagePanel').style.display = 'none';
        document.getElementById('eventImageUrlInputContainer').style.display = 'none';
    }

    async addNote(e) {
        e.preventDefault();
        const title = document.getElementById('eventTitle').value.trim();
        const dateKey = document.getElementById('eventDate').value || (this.selectedDate ? this.getDateKey(this.selectedDate) : '');

        // Controllo di tutti i campi
        const required = [];
        const optional = [];
        if (!title) required.push({ id: 'eventTitle', label: 'Nome evento', message: 'è vuoto: scrivi come si chiama l\'evento' });
        if (!dateKey) required.push({ id: 'eventDate', label: 'Data', message: 'scegli il giorno dell\'evento' });
        else if (!this.isFutureDateKey(dateKey)) required.push({ id: 'eventDate', label: 'Data', message: 'gli eventi si creano da domani in poi' });
        const fee = this.checkFee(document.getElementById('eventFee').value);
        if (fee.error) optional.push({ id: 'eventFee', label: 'Quota', message: fee.error, without: 'quota (sarà Gratis)' });
        // Il link scritto e non confermato con ✅ vale lo stesso
        const linkTyping = document.getElementById('eventLinkInputContainer').style.display === 'flex';
        const link = this.checkLink(linkTyping ? document.getElementById('eventLink').value : this.currentEventLink);
        if (link.error) optional.push({
            id: 'eventLink', anchor: 'eventLinkInputContainer', label: 'Link', message: link.error, without: 'link',
            show: () => {
                document.getElementById('eventLinkContainer').style.display = 'none';
                document.getElementById('eventLinkInputContainer').style.display = 'flex';
            }
        });
        const pendingImage = this.pendingImageUrlProblem('eventImageUrl', 'eventImageUrlInputContainer', 'addImagePanel', 'l\'immagine di quell\'indirizzo');
        if (pendingImage) optional.push(pendingImage);
        if (!await this.checkFormFields(required, optional, 'creare l\'evento')) return;
        document.getElementById('eventImageUrl').value = '';

        // Genera un ID unico
        const id = 'evt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

        // L'immagine va salvata prima dell'evento, così gli altri client la trovano già
        const imageVersion = this.eventImageData ? Date.now() : null;
        const imageSaved = this.eventImageData
            ? this.saveEventImage(id, this.eventImageData, imageVersion)
            : Promise.resolve();

        const event = {
            id: id,
            date: dateKey,
            title: title,
            time: document.getElementById('eventTime').value.trim(),
            location: document.getElementById('eventLocation').value.trim(),
            notes: document.getElementById('eventNotes').value.trim(),
            fee: fee.error ? 0 : fee.value,
            color: this.selectedColor,
            link: link.error ? '' : link.value,
            imageVersion: imageVersion,
            creatorId: this.userId,
            createdAt: Date.now()
        };

        imageSaved
            .then(() => database.ref(`events/${id}`).set(event))
            .then(() => { this.recordStat('eventsCreated'); this.showSuccessPopup('Evento aggiunto con successo!'); })
            .catch(error => {
                this.notifyWriteError('Creazione dell\'evento', error);
            });
        this.closeModal();
    }

    // Elimina l'evento con chat, letture chat e immagine, in un'unica scrittura
    deleteNote(eventId) {
        if (!eventId) return Promise.resolve();
        return database.ref().update({
            [`events/${eventId}`]: null,
            [`eventChats/${eventId}`]: null,
            [`chatReadStatus/${this.userId}/${eventId}`]: null,
            [`eventImages/${eventId}`]: null
        }).catch(error => {
            this.notifyWriteError('Eliminazione dell\'evento', error);
        });
    }

    getDateKey(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    previousMonth() {
        this.currentDate.setMonth(this.currentDate.getMonth() - 1);
        this.render();
    }

    nextMonth() {
        this.currentDate.setMonth(this.currentDate.getMonth() + 1);
        this.render();
    }

    today() {
        this.currentDate = new Date();
        this.render();
    }

    updateHeader() {
        const options = { year: 'numeric', month: 'long' };
        const monthYear = this.currentDate.toLocaleDateString('it-IT', options);
        document.getElementById('monthYear').textContent = monthYear.charAt(0).toUpperCase() + monthYear.slice(1);

        // Mostra/nascondi bottone "Mese Precedente" a seconda se siamo nel mese corrente
        const today = new Date();
        const isCurrentMonth = this.currentDate.getFullYear() === today.getFullYear() &&
                               this.currentDate.getMonth() === today.getMonth();

        const prevBtn = document.getElementById('prevBtn');
        prevBtn.style.display = isCurrentMonth ? 'none' : 'block';
    }

    // Rende sicuro un testo da inserire in HTML, sia come contenuto sia DENTRO un attributo:
    // si trasformano anche le virgolette (prima no: un link o un id con " poteva aggiungere attributi e codice)
    escapeHtml(text) {
        return String(text === undefined || text === null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Link sicuro: solo http/https (aggiunge https:// se manca), altrimenti null
    safeLink(link) {
        if (!link) return null;
        const raw = /^https?:\/\//i.test(link) ? link : `https://${link}`;
        try {
            const url = new URL(raw);
            return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
        } catch (e) {
            return null;
        }
    }

    // Immagini: salvate a parte in eventImages/{eventId}.
    // Nell'evento resta solo imageVersion (timestamp), che cambia a ogni nuova immagine.
    getEventImage(event) {
        if (!event || !event.id) return Promise.resolve(null);
        if (!event.imageVersion) return Promise.resolve(null);

        const cacheKey = `${event.id}:${event.imageVersion}`;
        if (this.imageCache[cacheKey]) return Promise.resolve(this.imageCache[cacheKey]);

        return database.ref(`eventImages/${event.id}`).once('value')
            .then(snapshot => {
                const image = snapshot.val();
                if (image) this.imageCache[cacheKey] = image;
                return image;
            })
            .catch(error => {
                console.error('Errore caricamento immagine:', error);
                return null;
            });
    }

    saveEventImage(eventId, image, imageVersion) {
        const ref = database.ref(`eventImages/${eventId}`);
        if (image) {
            this.imageCache[`${eventId}:${imageVersion}`] = image;
            return ref.set(image);
        }
        return ref.remove();
    }

    // Mostra la copertina nel modal di modifica, se l'evento aperto è ancora lo stesso
    showEditCover(note) {
        this.getEventImage(note).then(image => {
            const current = this.getEditingEvent();
            if (!current || current.id !== note.id) return;

            const coverContainer = document.getElementById('eventCoverContainer');
            coverContainer.style.backgroundImage = image ? `url("${image}")` : 'none';
            coverContainer.style.backgroundAttachment = image ? 'scroll' : 'fixed';
        });
    }

    // Drag and Drop
    setupDragAndDrop(noteEl, dateKey, eventId, dayObj) {
        let isDragging = false;
        let dragStartX = 0;
        let dragStartY = 0;
        const dragThreshold = 10; // pixel per distinguere click da drag

        noteEl.addEventListener('mousedown', (e) => {
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            isDragging = false;
        });

        noteEl.addEventListener('mousemove', (e) => {
            if (e.buttons === 0) return; // Mouse non è premuto

            const moveX = Math.abs(e.clientX - dragStartX);
            const moveY = Math.abs(e.clientY - dragStartY);

            if ((moveX > dragThreshold || moveY > dragThreshold) && !isDragging) {
                isDragging = true;
                this.startDrag(noteEl, dateKey, eventId, dayObj);
            }
        });

        noteEl.addEventListener('mouseup', () => {
            isDragging = false;
        });

        noteEl.addEventListener('mouseleave', () => {
            isDragging = false;
        });

        // Touch (mobile): tieni premuto il post-it, poi trascinalo sul giorno.
        // Se il dito si muove prima della pressione lunga è uno scroll e non si trascina nulla.
        const longPressDelay = 400;
        let longPressTimer = null;
        let touchStartX = 0;
        let touchStartY = 0;

        // Niente menu contestuale o selezione del testo durante la pressione lunga
        noteEl.style.webkitTouchCallout = 'none';
        noteEl.style.webkitUserSelect = 'none';
        noteEl.style.userSelect = 'none';

        const cancelLongPress = () => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        };

        noteEl.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            cancelLongPress();
            longPressTimer = setTimeout(() => {
                longPressTimer = null;
                if (navigator.vibrate) navigator.vibrate(30);
                this.startTouchDrag(noteEl, dateKey, eventId, touchStartX, touchStartY);
            }, longPressDelay);
        }, { passive: true });

        noteEl.addEventListener('touchmove', (e) => {
            if (!longPressTimer) return;
            const touch = e.touches[0];
            if (Math.abs(touch.clientX - touchStartX) > dragThreshold || Math.abs(touch.clientY - touchStartY) > dragThreshold) {
                cancelLongPress();
            }
        }, { passive: true });

        noteEl.addEventListener('touchend', cancelLongPress);
        noteEl.addEventListener('touchcancel', cancelLongPress);
        noteEl.addEventListener('contextmenu', (e) => {
            if (this.isTouchDragging) e.preventDefault();
        });
    }

    startTouchDrag(noteEl, sourceDateKey, eventId, startX, startY) {
        this.isTouchDragging = true;

        const dragGhost = noteEl.cloneNode(true);
        dragGhost.style.position = 'fixed';
        dragGhost.style.opacity = '0.8';
        dragGhost.style.pointerEvents = 'none';
        dragGhost.style.zIndex = '10000';
        dragGhost.style.width = noteEl.offsetWidth + 'px';
        dragGhost.style.transform = 'scale(1.1)';
        dragGhost.style.boxShadow = '0 6px 16px rgba(0, 0, 0, 0.3)';
        document.body.appendChild(dragGhost);

        const daysGrid = document.getElementById('daysGrid');
        const daysElements = Array.from(daysGrid.querySelectorAll('.day'));
        let lastX = startX;
        let lastY = startY;

        const findDayAt = (x, y) => {
            const el = document.elementFromPoint(x, y);
            return el ? el.closest('#daysGrid .day') : null;
        };

        const moveGhost = (x, y) => {
            // Il fantasma sta sopra il dito, così resta visibile
            dragGhost.style.left = (x - noteEl.offsetWidth / 2) + 'px';
            dragGhost.style.top = (y - 50) + 'px';
            daysElements.forEach(dayEl => dayEl.classList.remove('drag-over'));
            const dayEl = findDayAt(x, y);
            if (dayEl) dayEl.classList.add('drag-over');
        };
        moveGhost(startX, startY);

        const handleTouchMove = (e) => {
            e.preventDefault(); // Blocca lo scroll mentre si trascina
            const touch = e.touches[0];
            lastX = touch.clientX;
            lastY = touch.clientY;
            moveGhost(lastX, lastY);
        };

        const finish = (drop) => {
            document.removeEventListener('touchmove', handleTouchMove);
            document.removeEventListener('touchend', handleTouchEnd);
            document.removeEventListener('touchcancel', handleTouchCancel);
            dragGhost.remove();
            daysElements.forEach(dayEl => dayEl.classList.remove('drag-over'));
            this.isTouchDragging = false;

            // Il browser può generare un click alla fine del tocco: non deve aprire modal
            this.suppressNextClick = true;
            setTimeout(() => { this.suppressNextClick = false; }, 400);

            if (drop) {
                const targetDay = findDayAt(lastX, lastY);
                if (targetDay) this.dropEvent(targetDay, eventId);
            }
        };
        const handleTouchEnd = () => finish(true);
        const handleTouchCancel = () => finish(false);

        document.addEventListener('touchmove', handleTouchMove, { passive: false });
        document.addEventListener('touchend', handleTouchEnd);
        document.addEventListener('touchcancel', handleTouchCancel);
    }

    startDrag(noteEl, sourceDateKey, eventId, sourceDayObj) {
        // Crea un elemento fantasma per il trascinamento
        const dragGhost = noteEl.cloneNode(true);
        dragGhost.style.position = 'fixed';
        dragGhost.style.opacity = '0.7';
        dragGhost.style.pointerEvents = 'none';
        dragGhost.style.zIndex = '10000';
        document.body.appendChild(dragGhost);

        const daysGrid = document.getElementById('daysGrid');
        const daysElements = Array.from(daysGrid.querySelectorAll('.day'));

        const handleMouseMove = (e) => {
            dragGhost.style.left = (e.clientX - 30) + 'px';
            dragGhost.style.top = (e.clientY - 15) + 'px';

            // Evidenzia il giorno dove è il mouse
            daysElements.forEach(dayEl => {
                dayEl.classList.remove('drag-over');
            });

            const mouseOverDay = daysElements.find(dayEl => {
                const rect = dayEl.getBoundingClientRect();
                return e.clientX >= rect.left && e.clientX <= rect.right &&
                       e.clientY >= rect.top && e.clientY <= rect.bottom;
            });

            if (mouseOverDay) {
                mouseOverDay.classList.add('drag-over');
            }
        };

        const handleMouseUp = (e) => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            dragGhost.remove();

            // Rimuovi evidenziazione
            daysElements.forEach(dayEl => {
                dayEl.classList.remove('drag-over');
            });

            // Trova il giorno dove è stato rilasciato
            const mouseOverDay = daysElements.find(dayEl => {
                const rect = dayEl.getBoundingClientRect();
                return e.clientX >= rect.left && e.clientX <= rect.right &&
                       e.clientY >= rect.top && e.clientY <= rect.bottom;
            });

            if (mouseOverDay) {
                this.dropEvent(mouseOverDay, eventId);
            }
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }

    dropEvent(targetDayEl, eventId) {
        // Estrai la data dal giorno target (dall'ID del contenitore)
        const notesContainer = targetDayEl.querySelector('[id^="notes-"]');
        if (!notesContainer) return;

        const targetDateKey = notesContainer.id.replace('notes-', '');

        if (this.moveEvent(eventId, targetDateKey)) {
            this.showSuccessPopup('Evento spostato con successo!');
        }
    }

    // Sposta un evento in un altro giorno (drag & drop o campo Data del modal).
    // Cambia solo il campo date: chat, immagine e partecipanti restano collegati.
    moveEvent(eventId, targetDateKey) {
        const event = this.events[eventId];
        if (!event || event.date === targetDateKey) {
            return false; // Evento sparito o stesso giorno
        }
        if (!this.canEditEvent(event)) {
            this.showErrorPopup('Solo chi ha proposto l\'evento può spostarlo');
            return false;
        }

        // Non puoi spostare su giorni passati o oggi
        if (!this.isFutureDateKey(targetDateKey)) {
            this.showErrorPopup('Non puoi spostare su giorni passati o di oggi');
            return false;
        }

        this.updateEvent(eventId, { date: targetDateKey });
        return true;
    }

    // Ordina eventi per orario
    sortByTime(events) {
        return events.sort((a, b) => {
            const timeA = this.extractHours(a.time);
            const timeB = this.extractHours(b.time);
            return timeA - timeB;
        });
    }

    // Estrae le ore in minuti da una stringa di tempo
    extractHours(timeStr) {
        if (!timeStr) return 1440; // Fine giornata se non specificato

        // Se contiene "Tutto il giorno" o simili, mettilo alla fine
        if (timeStr.toLowerCase().includes('giorno') ||
            timeStr.toLowerCase().includes('sera') ||
            timeStr.toLowerCase().includes('mattina')) {
            return 1440;
        }

        // Estrai il primo orario (HH:MM)
        const match = timeStr.match(/(\d{1,2}):(\d{2})/);
        if (match) {
            const hours = parseInt(match[1]);
            const minutes = parseInt(match[2]);
            return hours * 60 + minutes;
        }

        return 1440; // Default: fine giornata
    }

    // View Toggle
    setView(isList) {
        if (this.isListView !== isList) this.toggleView();
        this.updateViewChoice();
    }

    updateViewChoice() {
        document.querySelectorAll('.view-choice-btn').forEach(btn => {
            btn.classList.toggle('active', (btn.dataset.view === 'list') === !!this.isListView);
        });
    }

    closeMenu() {
        const menuDropdown = document.getElementById('menuDropdown');
        if (menuDropdown) menuDropdown.style.display = 'none';
    }

    toggleView() {
        this.isListView = !this.isListView;
        // Salva la preferenza nel localStorage
        localStorage.setItem('preferredView', this.isListView ? 'list' : 'calendar');
        this.render();
    }

    openSelectDayModal() {
        const modal = document.getElementById('selectDayModal');
        const today = new Date();
        const yearSelect = document.getElementById('selectDayYear');
        const monthSelect = document.getElementById('selectDayMonth');
        const dayInput = document.getElementById('selectDayDay');
        const form = document.getElementById('selectDayForm');

        // Popola gli anni (da quello corrente in poi, fino a 10 anni avanti)
        yearSelect.innerHTML = '';
        for (let i = 0; i < 10; i++) {
            const year = today.getFullYear() + i;
            const option = document.createElement('option');
            option.value = year;
            option.textContent = year;
            yearSelect.appendChild(option);
        }
        yearSelect.value = today.getFullYear();

        // Aggiorna i mesi disponibili quando cambia l'anno
        // Ultimo giorno del mese: da domani si parte dal mese successivo
        const isLastDayOfMonth = today.getDate() === new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
        const firstMonth = isLastDayOfMonth ? today.getMonth() + 1 : today.getMonth(); // 12 = gennaio dell'anno dopo
        if (firstMonth > 11) {
            yearSelect.querySelector(`option[value="${today.getFullYear()}"]`).remove();
            yearSelect.value = today.getFullYear() + 1;
        }

        const updateAvailableMonths = () => {
            const selectedYear = parseInt(yearSelect.value);
            const currentYear = today.getFullYear();
            const isCurrentYear = selectedYear === currentYear;

            // Salva il mese selezionato (se esiste)
            const previousMonth = monthSelect.value;

            // Ripopola i mesi
            monthSelect.innerHTML = '';
            const allMonths = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
                             'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];

            allMonths.forEach((monthName, monthIndex) => {
                // Se è l'anno corrente, mostra solo i mesi da quello corrente in poi
                if (isCurrentYear && monthIndex < firstMonth) {
                    return; // Salta i mesi passati
                }

                const option = document.createElement('option');
                option.value = monthIndex;
                option.textContent = monthName;
                monthSelect.appendChild(option);
            });

            // Preseleziona il mese corrente se disponibile, altrimenti il primo disponibile
            if (isCurrentYear) {
                monthSelect.value = firstMonth;
            } else {
                monthSelect.value = 0; // Gennaio per anni futuri
            }
        };

        // Preseleziona domani (il 1° del mese dopo, se oggi è l'ultimo giorno)
        dayInput.value = isLastDayOfMonth ? 1 : today.getDate() + 1;

        // Aggiorna i vincoli del giorno quando cambia mese o anno
        const updateDayConstraints = () => {
            const selectedYear = parseInt(yearSelect.value);
            const selectedMonth = parseInt(monthSelect.value);
            const isCurrentMonth = selectedYear === today.getFullYear() && selectedMonth === today.getMonth();
            const minDay = isCurrentMonth ? today.getDate() + 1 : 1;
            const maxDay = new Date(selectedYear, selectedMonth + 1, 0).getDate();

            dayInput.min = minDay;
            dayInput.max = maxDay;
            dayInput.placeholder = `${minDay} - ${maxDay}`;

            // Se il giorno attuale è fuori range, aggiorna
            if (parseInt(dayInput.value) < minDay) {
                dayInput.value = minDay;
            } else if (parseInt(dayInput.value) > maxDay) {
                dayInput.value = maxDay;
            }
        };

        // on... invece di addEventListener: a ogni apertura il gestore si sostituisce,
        // non si aggiunge (prima dopo N aperture +/- spostavano il giorno di N)
        yearSelect.onchange = () => {
            updateAvailableMonths();
            updateDayConstraints();
        };
        monthSelect.onchange = updateDayConstraints;

        // Inizializza i mesi disponibili
        updateAvailableMonths();
        updateDayConstraints();

        // Gestisci il submit del form
        form.onsubmit = (e) => {
            e.preventDefault();
            const year = parseInt(yearSelect.value);
            const month = parseInt(monthSelect.value);
            const day = parseInt(dayInput.value);
            const errorEl = document.getElementById('selectDayError');

            // Valida il giorno
            if (!day || day < parseInt(dayInput.min) || day > parseInt(dayInput.max)) {
                errorEl.textContent = `Giorno non valido. Intervallo: ${dayInput.min} - ${dayInput.max}`;
                errorEl.style.display = 'block';
                return;
            }

            const selectedDate = new Date(year, month, day);
            this.closeSelectDayModal();
            this.openModal(selectedDate);
        };

        // Valida il giorno in tempo reale (input, click su button su/giù, change)
        const validateDay = () => {
            const day = parseInt(dayInput.value);
            const min = parseInt(dayInput.min);
            const max = parseInt(dayInput.max);
            const errorEl = document.getElementById('selectDayError');

            if (day < min || day > max) {
                // Correggi il valore fuori range
                if (day < min) {
                    dayInput.value = min;
                } else if (day > max) {
                    dayInput.value = max;
                }
                errorEl.textContent = `Giorno deve essere tra ${min} e ${max}`;
                errorEl.style.display = 'block';
            } else {
                errorEl.style.display = 'none';
            }
        };

        dayInput.oninput = validateDay;
        dayInput.onchange = validateDay;
        // Ascolta i click dei button su/giù
        dayInput.onmouseup = validateDay;

        // Button per incrementare/decrementare il giorno
        const dayPlusBtn = document.getElementById('selectDayDayPlus');
        const dayMinusBtn = document.getElementById('selectDayDayMinus');

        dayPlusBtn.onclick = (e) => {
            e.preventDefault();
            const current = parseInt(dayInput.value) || parseInt(dayInput.min);
            const max = parseInt(dayInput.max);
            if (current < max) {
                dayInput.value = current + 1;
                validateDay();
            }
        };

        dayMinusBtn.onclick = (e) => {
            e.preventDefault();
            const current = parseInt(dayInput.value) || parseInt(dayInput.min);
            const min = parseInt(dayInput.min);
            if (current > min) {
                dayInput.value = current - 1;
                validateDay();
            }
        };

        document.getElementById('selectDayError').style.display = 'none';
        modal.style.display = 'flex';
    }

    closeSelectDayModal() {
        const modal = document.getElementById('selectDayModal');
        modal.style.display = 'none';
    }

    renderList() {
        const eventsList = document.getElementById('eventsList');
        const allEvents = [];

        Object.values(this.events).forEach(event => {
            if (!event || !event.date) return;
            allEvents.push({
                ...event,
                dateKey: event.date,
                date: new Date(event.date)
            });
        });

        // Ordina per data, poi per orario
        allEvents.sort((a, b) => {
            const dateCompare = a.date - b.date;
            if (dateCompare !== 0) return dateCompare;
            // Se la data è uguale, ordina per orario
            return this.extractHours(a.time) - this.extractHours(b.time);
        });

        // Filtra: mostra solo eventi di oggi e futuri (nasconde eventi passati)
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const futureEvents = allEvents.filter(event => event.date >= today);

        // Filtra per colore visibile
        const visibleEvents = futureEvents.filter(event => this.isColorVisible(event.color));

        eventsList.innerHTML = '';

        // Aggiungi il tasto "+" in cima
        const addBtn = document.createElement('button');
        addBtn.style.cssText = 'width: 100%; padding: 16px; margin-bottom: 20px; background: #667eea; color: white; border: none; border-radius: 8px; font-size: 1.2rem; cursor: pointer; font-weight: bold;';
        addBtn.textContent = '➕ Aggiungi evento';
        addBtn.addEventListener('click', () => this.openSelectDayModal());
        eventsList.appendChild(addBtn);

        // Eventi da fissare, sotto il tasto "+"
        const proposalsSection = document.createElement('div');
        proposalsSection.id = 'proposalsSection';
        proposalsSection.style.marginBottom = '8px';
        eventsList.appendChild(proposalsSection);
        this.renderProposals();

        if (visibleEvents.length === 0) {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'empty-list';
            emptyDiv.textContent = 'Nessun evento programmato 📭';
            eventsList.appendChild(emptyDiv);
            return;
        }
        visibleEvents.forEach(event => {
            const dateStr = event.date.toLocaleDateString('it-IT', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });

            const eventEl = document.createElement('div');
            eventEl.className = `event-item ${event.color}`;

            const participantIds = this.getParticipantIds(event);
            this.ensureUserNames(participantIds);
            const participantsHtml = participantIds.length > 0
                ? `<div class="event-participants">👥 ${participantIds.map(p => this.escapeHtml(this.getParticipantName(p))).join(', ')}</div>`
                : '';

            eventEl.setAttribute('data-event-id', event.id);
            eventEl.style.position = 'relative';
            eventEl.innerHTML = `
                <div class="event-cover" style="position: relative; background-size: cover; background-position: center;">
                    <div style="position: relative; z-index: 10; padding: 16px; background: rgba(255, 255, 255, 0.95);">
                        <div class="event-date">${dateStr.charAt(0).toUpperCase() + dateStr.slice(1)}</div>
                        <div class="event-title">${this.escapeHtml(event.title)}</div>
                        ${event.time ? `<div class="event-time">🕐 ${this.escapeHtml(event.time)}</div>` : ''}
                        ${event.location ? `<div class="event-location">📍 ${this.escapeHtml(event.location)}</div>` : ''}
                        <div class="event-location">💶 ${this.formatFee(event.fee)}</div>
                        ${event.notes ? `<div class="event-notes">${this.escapeHtml(event.notes).replace(/\n/g, '<br>')}</div>` : ''}
                        ${participantsHtml}
                    </div>
                    <span class="list-event-badge" style="position: absolute; top: 10px; right: 10px; background: #f44336; color: white; border-radius: 50%; width: 24px; height: 24px; display: none; align-items: center; justify-content: center; font-size: 0.75rem; font-weight: bold; z-index: 11;"></span>
                </div>
            `;

            // Copertina caricata a parte (da eventImages)
            if (event.imageVersion) {
                this.getEventImage(event).then(image => {
                    if (!image) return;
                    const cover = eventEl.querySelector('.event-cover');
                    cover.style.backgroundImage = `url("${image}")`;
                    const decoration = document.createElement('div');
                    decoration.style.cssText = 'position: absolute; top: 0; right: 0; width: 100%; height: 100%; background-size: cover; background-position: center; clip-path: polygon(15% 0%, 100% 0%, 100% 100%, 0% 100%, 15% 75%, 0% 50%, 15% 25%); z-index: 1;';
                    decoration.style.backgroundImage = `url("${image}")`;
                    cover.appendChild(decoration);
                });
            }

            eventEl.addEventListener('click', () => {
                this.openEditModal(event.id);
            });

            eventsList.appendChild(eventEl);

            // Aggiorna il badge dei messaggi non letti
            this.updateListEventBadge(eventEl, event.id);
        });
    }

    // Settings
    openSettings() {
        document.getElementById('settingsModal').classList.add('active');
        this.updateViewChoice();
        // Aggiorna lo stato dei checkbox
        document.querySelectorAll('.color-filter').forEach(checkbox => {
            const color = checkbox.dataset.color;
            checkbox.checked = this.visibleColors[color] !== false;
        });
    }

    closeSettings() {
        document.getElementById('settingsModal').classList.remove('active');
    }

    // 📖 Modo d'uso: la guida (descrizioni/info)
    openGuide() {
        document.getElementById('infoHeader').textContent = '📖 Modo d\'uso';
        const body = document.getElementById('infoBody');
        body.textContent = 'Caricamento…';
        document.getElementById('infoModal').classList.add('active');
        fetch('./descrizioni/info', { cache: 'no-store' })
            .then(response => response.text())
            .then(content => this.renderGuideSections(body, content))
            .catch(() => { body.textContent = 'Errore nel caricamento della guida.'; });
    }

    // La guida è divisa in sezioni: ogni riga che inizia senza spazi è il titolo di una sezione,
    // le righe rientrate sotto sono il suo testo. Ogni sezione ha la freccetta (tutte chiuse);
    // la prima riga del file ("🎯 Come usare la Bacheca") resta come introduzione
    renderGuideSections(body, content) {
        const lines = content.replace(/\r/g, '').split('\n');
        const sections = [];
        let intro = '';
        lines.forEach(line => {
            if (!line.trim()) {
                if (sections.length) sections[sections.length - 1].lines.push('');
                return;
            }
            if (!/^\s/.test(line)) {
                if (!intro && !sections.length) intro = line.trim();
                else sections.push({ title: line.trim(), lines: [] });
                return;
            }
            if (sections.length) sections[sections.length - 1].lines.push(line.replace(/^ {3}/, '')); // toglie il primo rientro
        });
        body.innerHTML = '';
        if (intro) {
            const introEl = document.createElement('div');
            introEl.style.cssText = 'font-weight: 600; margin-bottom: 4px;';
            introEl.textContent = `${intro} (tocca una sezione per aprirla)`;
            body.appendChild(introEl);
        }
        this.renderAccordion(body, sections.map(section => ({ title: section.title, text: section.lines.join('\n').trim(), open: false })));
    }

    // Elenco di sezioni con la freccetta ▸/▾ (Modo d'uso e Info): aprendone una, le altre si chiudono
    renderAccordion(body, items) {
        items.forEach(item => {
            const details = document.createElement('details');
            details.className = item.className ? `release-old ${item.className}` : 'release-old';
            details.open = !!item.open;
            const summary = document.createElement('summary');
            summary.textContent = item.title;
            const content = document.createElement('div');
            content.textContent = item.text;
            details.appendChild(summary);
            details.appendChild(content);
            details.addEventListener('toggle', () => {
                if (!details.open) return;
                body.querySelectorAll('details.release-old').forEach(other => {
                    if (other !== details) other.open = false;
                });
            });
            body.appendChild(details);
        });
    }

    // ℹ️ Info: cosa c'è di nuovo nell'ultima versione, e le due precedenti da aprire con la freccetta.
    // L'elenco delle versioni è in rilasci/elenco (dalla più nuova), il testo in rilasci/<versione>
    async openInfo() {
        document.getElementById('infoHeader').textContent = 'ℹ️ Informazione';
        const body = document.getElementById('infoBody');
        body.textContent = 'Caricamento…';
        document.getElementById('infoModal').classList.add('active');
        const get = (path) => fetch(path, { cache: 'no-store' }).then(r => {
            if (!r.ok) throw new Error(r.status);
            return r.text();
        });
        try {
            const current = (await get('./descrizioni/versione')).trim();
            const all = (await get('./rilasci/elenco')).split('\n').map(v => v.trim()).filter(Boolean);
            const index = all.indexOf(current);
            const versions = (index >= 0 ? all.slice(index) : [current, ...all]).slice(0, 3);
            const texts = await Promise.all(versions.map(v => get(`./rilasci/${v}`).catch(() => `🆕 Versione ${v}\n\nNessuna descrizione.`)));
            body.innerHTML = '';
            // Tre versioni con la freccetta: l'ultima aperta, le altre chiuse; aprendone una le altre si chiudono
            this.renderAccordion(body, texts.map((text, i) => ({
                title: i === 0 ? `🆕 Versione ${versions[i]}` : `Versione ${versions[i]}`,
                text: text.trim().split(/\r?\n/).slice(1).join('\n').trim(), // senza la riga del titolo
                open: i === 0,
                className: i === 0 ? 'release-latest' : ''
            })));
        } catch (e) {
            body.textContent = 'Errore nel caricamento delle novità.';
        }
    }

    closeInfo() {
        document.getElementById('infoModal').classList.remove('active');
    }

    openUserProfile() {
        // Chiudi il menu dropdown
        const menuDropdown = document.getElementById('menuDropdown');
        if (menuDropdown) menuDropdown.style.display = 'none';

        // Popola le informazioni nel modal
        document.getElementById('userProfileName').textContent = this.userName || 'Non impostato';
        document.getElementById('userProfileUsername').textContent = this.username || '';

        const deviceInfo = this.getDeviceInfo();
        document.getElementById('userProfileDevice').textContent = `${deviceInfo.browser} (${deviceInfo.deviceType})`;

        // Mostra il modal
        const modal = document.getElementById('userProfileModal');
        if (modal) {
            modal.style.display = 'flex';
        }
    }

    closeUserProfile() {
        const modal = document.getElementById('userProfileModal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    // ===== Eventi: events/{id} = {id, date, title, time, location, notes, color, link, imageVersion,
    //                            participants/{uid}: true, creatorId, createdAt}
    // Ogni modifica scrive solo i campi del suo evento (update), mai tutto il nodo events:
    // due persone che modificano eventi diversi, o si iscrivono insieme, non si sovrascrivono.
    // this.events arriva dal listener; this.notes è l'indice per giorno usato per disegnare.

    loadEvents() {
        return new Promise(resolve => {
            let firstLoad = true;
            this.eventsListener = (snapshot) => {
                this.events = snapshot.val() || {};
                this.rebuildNotesIndex();
                this.scheduleNotificationCheck();

                if (firstLoad) {
                    firstLoad = false;
                    resolve(); // Il primo disegno lo fa init()
                    return;
                }

                // Se il modal è aperto, verifica se l'evento è stato eliminato o modificato
                if (this.editingNote) {
                    const event = this.getEditingEvent();
                    if (!event) {
                        this.showEventDeletedDialog();
                    } else {
                        this.editingNote.dateKey = event.date;
                        this.updateEditModalContent();
                    }
                }

                this.render();
            };

            database.ref('events').on('value', this.eventsListener, (error) => {
                console.error('Errore lettura eventi:', error);
                this.showErrorPopup('Non riesco a leggere gli eventi. Ricarica la pagina.');
                resolve();
            });

            // Listener globale per i messaggi di TUTTI gli eventi: scarica tutto all'avvio, poi solo
            // i messaggi nuovi. I messaggi restano in memoria e i badge si calcolano da qui
            database.ref('eventChats').on('value', (snapshot) => {
                const previousChats = this.chatMessagesLoaded ? this.chatMessages : null;
                this.chatMessages = snapshot.val() || {};
                this.chatMessagesLoaded = true;
                this.checkNewChatMessages(previousChats);
                this.updateAllBadges();
            });
        });
    }

    // Messaggi già letti: chatReadStatus/{uid}/{id evento o proposta} = {lastReadTimestamp}.
    // Un solo listener sul proprio nodo: niente letture di rete per i badge
    loadReadStatus() {
        return new Promise(resolve => {
            let firstLoad = true;
            database.ref(`chatReadStatus/${this.userId}`).on('value', (snapshot) => {
                this.readStatus = snapshot.val() || {};
                if (firstLoad) {
                    firstLoad = false;
                    resolve();
                    return;
                }
                this.updateAllBadges();
            }, (error) => {
                console.error('Errore lettura messaggi letti:', error);
                resolve();
            });
        });
    }

    getLastRead(chatId) {
        const status = this.readStatus[chatId];
        return (status && status.lastReadTimestamp) || 0;
    }

    // ===== Notifiche (livello 1: campanella nell'app; livello 2: notifiche del telefono) =====
    // Le novità si calcolano confrontando lo stato attuale di eventi e proposte con l'ultimo visto,
    // salvato su questo dispositivo (localStorage, per utente). Così all'apertura compaiono anche le
    // novità successe mentre l'app era chiusa. Niente letture o scritture in più su Firebase.
    // Le notifiche del telefono partono solo con l'app aperta o in background (niente push ad app chiusa).

    notificationKey(name) {
        return `bacheca_${name}_${this.userId}`;
    }

    readLocal(name, fallback) {
        try {
            const value = localStorage.getItem(this.notificationKey(name));
            return value ? JSON.parse(value) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    writeLocal(name, value) {
        try {
            localStorage.setItem(this.notificationKey(name), JSON.stringify(value));
        } catch (e) {
            // Spazio pieno o storage non disponibile: le notifiche restano solo per questa sessione
        }
    }

    getNotificationPrefs() {
        return Object.assign({
            newEvents: true,     // nuovo evento o nuova proposta di altri
            joins: true,         // qualcuno si iscrive a un mio evento
            changes: true,       // un evento a cui partecipo è spostato, modificato o annullato
            proposals: true,     // novità nelle proposte che ho creato o votato
            chat: true,          // nuovi messaggi nelle mie chat (solo notifica del telefono: in app ci sono i badge)
            phone: false         // notifiche del telefono attive
        }, this.readLocal('notificationPrefs', {}));
    }

    setNotificationPref(name, value) {
        const prefs = this.getNotificationPrefs();
        prefs[name] = value;
        this.writeLocal('notificationPrefs', prefs);
    }

    // Fotografia compatta di ciò che serve per capire cosa è cambiato
    buildNotificationSnapshot() {
        const events = {};
        Object.values(this.events).forEach(event => {
            if (!event || !event.id) return;
            events[event.id] = {
                t: event.title || '', d: event.date || '', h: event.time || '', l: event.location || '',
                c: event.creatorId || '', p: this.getParticipantIds(event)
            };
        });
        const proposals = {};
        Object.values(this.proposals || {}).forEach(proposal => {
            if (!proposal || !proposal.id) return;
            proposals[proposal.id] = {
                t: proposal.title || '', c: proposal.creatorId || '',
                o: Object.keys(proposal.dateOptions || {}),
                v: this.hasVotedProposal(proposal)
            };
        });
        return { events, proposals };
    }

    // Chiamato dai listener di eventi e proposte: aspetta che si calmino e poi confronta
    scheduleNotificationCheck() {
        if (!this.proposalsLoaded) return;
        clearTimeout(this.notificationTimer);
        this.notificationTimer = setTimeout(() => this.checkNotifications(), 400);
    }

    checkNotifications() {
        const previous = this.readLocal('notificationSnapshot', null);
        const current = this.buildNotificationSnapshot();
        this.writeLocal('notificationSnapshot', current);
        if (!previous) {
            this.renderNotificationBell(); // Prima volta su questo dispositivo: nessuna notifica arretrata
            return;
        }

        const prefs = this.getNotificationPrefs();
        const me = this.userId;
        const today = this.getDateKey(new Date());
        const found = [];
        const add = (type, item) => { if (prefs[type]) found.push(Object.assign({ type }, item)); };

        // --- Eventi ---
        Object.entries(current.events).forEach(([id, now]) => {
            const before = previous.events[id];
            if (!before) {
                const fromProposal = previous.proposals[id];
                if (fromProposal) {
                    // Proposta fissata: interessa chi l'ha votata o creata
                    if ((fromProposal.v || fromProposal.c === me) && now.c !== me) {
                        add('proposals', { eventId: id, title: `📅 Data fissata: ${now.t}`, body: `${this.formatDateKey(now.d)}${now.h ? ' · ' + now.h : ''}` });
                    }
                } else if (now.c !== me && now.d >= today) {
                    add('newEvents', { eventId: id, title: `🆕 Nuovo evento: ${now.t}`, body: `${this.formatDateKey(now.d)}${now.l ? ' · ' + now.l : ''} · da ${this.getParticipantName(now.c)}` });
                }
                return;
            }
            // Iscrizioni ai miei eventi
            if (now.c === me) {
                now.p.filter(uid => uid !== me && !before.p.includes(uid)).forEach(uid => {
                    add('joins', { eventId: id, title: `🙋 ${this.getParticipantName(uid)} partecipa`, body: now.t });
                });
                return;
            }
            // Modifiche agli eventi a cui partecipo (le fa solo il creatore)
            if (now.p.includes(me)) {
                if (now.d !== before.d) {
                    add('changes', { eventId: id, title: `📅 Evento spostato: ${now.t}`, body: `Ora è ${this.formatDateKey(now.d)}${now.h ? ' · ' + now.h : ''}` });
                } else if (now.h !== before.h || now.l !== before.l || now.t !== before.t) {
                    const what = [now.t !== before.t && 'nome', now.h !== before.h && 'ora', now.l !== before.l && 'luogo'].filter(Boolean).join(', ');
                    add('changes', { eventId: id, title: `✏️ Evento modificato: ${now.t}`, body: `Cambiato: ${what}` });
                }
            }
        });
        Object.entries(previous.events).forEach(([id, before]) => {
            // Annullato: ero iscritto, non l'ho eliminato io, e non è la pulizia dei mesi passati
            if (!current.events[id] && before.p.includes(me) && before.c !== me && before.d >= today) {
                add('changes', { title: `❌ Evento annullato: ${before.t}`, body: this.formatDateKey(before.d) });
            }
        });

        // --- Proposte ---
        Object.entries(current.proposals).forEach(([id, now]) => {
            const before = previous.proposals[id];
            if (!before) {
                if (now.c !== me) add('newEvents', { proposalId: id, title: `🗳️ Nuova proposta: ${now.t}`, body: `da ${this.getParticipantName(now.c)}: vota le date` });
                return;
            }
            if (now.v || now.c === me) {
                const proposal = this.proposals[id];
                now.o.filter(key => !before.o.includes(key)).forEach(key => {
                    const option = proposal && proposal.dateOptions && proposal.dateOptions[key];
                    if (option && (option.addedById === me || (!option.addedById && option.addedBy === this.userName))) return;
                    add('proposals', { proposalId: id, title: `🗳️ Nuova data per ${now.t}`, body: this.formatProposalOption(key) });
                });
            }
        });
        Object.entries(previous.proposals).forEach(([id, before]) => {
            if (!current.proposals[id] && !current.events[id] && (before.v) && before.c !== me) {
                add('proposals', { title: `❌ Proposta eliminata: ${before.t}`, body: '' });
            }
        });

        if (found.length > 0) this.addNotifications(found);
        this.renderNotificationBell();
    }

    addNotifications(items) {
        const list = this.readLocal('notifications', []);
        const now = Date.now();
        items.forEach((item, index) => {
            list.unshift(Object.assign({ id: `${now}_${index}`, at: now, read: false }, item));
            this.showPhoneNotification(item.title, item.body, item);
        });
        this.writeLocal('notifications', list.slice(0, 50)); // Si tengono le ultime 50
    }

    // Chat: notifica del telefono per i messaggi nuovi delle mie chat (in app bastano i badge)
    checkNewChatMessages(previousChats) {
        if (!previousChats || !this.getNotificationPrefs().chat) return;
        Object.entries(this.chatMessages).forEach(([chatId, chat]) => {
            const before = (previousChats[chatId] && previousChats[chatId].messages) || {};
            const event = this.events[chatId];
            const proposal = this.proposals && this.proposals[chatId];
            const mine = event
                ? this.getParticipantIds(event).includes(this.userId)
                : !!proposal && (this.hasVotedProposal(proposal) || this.isProposalCreator(proposal));
            if (!mine) return;
            Object.entries((chat && chat.messages) || {}).forEach(([messageId, message]) => {
                if (before[messageId] || !message || message.deviceId === this.userId) return;
                const where = event ? event.title : proposal.title;
                this.showPhoneNotification(`💬 ${message.name} · ${where}`, message.text, event ? { eventId: chatId } : { proposalId: chatId }, `chat-${chatId}`);
            });
        });
    }

    // Notifica del sistema, solo se attivata e solo se l'app non è in primo piano
    showPhoneNotification(title, body, target = {}, tag) {
        if (!this.getNotificationPrefs().phone || !('Notification' in window) || Notification.permission !== 'granted') return;
        if (document.visibilityState === 'visible') return;
        const options = {
            body: body || '',
            icon: 'icons/icon-192.png?v=2',
            badge: 'icons/icon-192.png?v=2',
            tag: tag || undefined,
            data: { eventId: target.eventId || null, proposalId: target.proposalId || null }
        };
        // Su Android le notifiche si mostrano solo tramite il service worker
        if (navigator.serviceWorker && navigator.serviceWorker.ready) {
            navigator.serviceWorker.ready
                .then(registration => registration.showNotification(title, options))
                .catch(() => { try { new Notification(title, options); } catch (e) { /* non supportate */ } });
        } else {
            try { new Notification(title, options); } catch (e) { /* non supportate */ }
        }
    }

    async enablePhoneNotifications() {
        if (!('Notification' in window)) {
            const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
            this.showErrorPopup(iOS
                ? 'Su iPhone le notifiche funzionano solo con l\'app installata: Safari → Condividi → Aggiungi alla schermata Home, poi apri l\'app da lì.'
                : 'Questo browser non supporta le notifiche.');
            return false;
        }
        const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
        if (permission !== 'granted') {
            this.showErrorPopup('Notifiche bloccate: abilitale dalle impostazioni del browser per questo sito.');
            this.setNotificationPref('phone', false);
            return false;
        }
        this.setNotificationPref('phone', true);
        return true;
    }

    // Numero sulla campanella: notifiche non lette + chat con messaggi non letti
    getUnreadChats() {
        const chats = [];
        Object.values(this.events).forEach(event => {
            if (event && this.getParticipantIds(event).includes(this.userId)) {
                const count = this.countUnreadMessages(event.id);
                if (count > 0) chats.push({ eventId: event.id, title: event.title, count });
            }
        });
        Object.values(this.proposals || {}).forEach(proposal => {
            if (proposal && proposal.id && (this.hasVotedProposal(proposal) || this.isProposalCreator(proposal))) {
                const count = this.countUnreadMessages(proposal.id);
                if (count > 0) chats.push({ proposalId: proposal.id, title: proposal.title, count });
            }
        });
        return chats;
    }

    renderNotificationBell() {
        const badge = document.getElementById('notificationBadge');
        if (!badge || !this.userId) return;
        const unread = this.readLocal('notifications', []).filter(n => !n.read).length + this.getUnreadChats().length;
        badge.textContent = unread > 99 ? '99+' : String(unread);
        badge.style.display = unread > 0 ? 'flex' : 'none';
        const modal = document.getElementById('notificationsModal');
        if (modal && modal.style.display === 'flex') this.renderNotificationsPanel();
    }

    openNotificationsPanel() {
        const menuDropdown = document.getElementById('menuDropdown');
        if (menuDropdown) menuDropdown.style.display = 'none';
        this.renderNotificationsPanel();
        document.getElementById('notificationsModal').style.display = 'flex';
    }

    closeNotificationsPanel() {
        document.getElementById('notificationsModal').style.display = 'none';
        // Aprendo il pannello le notifiche contano come lette
        const list = this.readLocal('notifications', []).map(n => Object.assign(n, { read: true }));
        this.writeLocal('notifications', list);
        this.renderNotificationBell();
    }

    renderNotificationsPanel() {
        const listEl = document.getElementById('notificationsList');
        const list = this.readLocal('notifications', []);
        const chats = this.getUnreadChats();
        const timeAgo = (at) => {
            const minutes = Math.round((Date.now() - at) / 60000);
            if (minutes < 1) return 'adesso';
            if (minutes < 60) return `${minutes} min fa`;
            const hours = Math.round(minutes / 60);
            if (hours < 24) return `${hours} h fa`;
            return new Date(at).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
        };
        const row = (item, text, sub, unread) => `
            <button type="button" class="notification-row" data-event-id="${this.escapeHtml(item.eventId || '')}" data-proposal-id="${this.escapeHtml(item.proposalId || '')}"
                style="width: 100%; text-align: left; display: block; padding: 10px 12px; margin-bottom: 6px; border-radius: 8px; cursor: pointer;
                       border: 1px solid ${unread ? '#667eea' : '#eee'}; background: ${unread ? '#eef0fd' : '#fff'}; color: #333;">
                <div style="font-weight: 600; font-size: 0.95rem;">${this.escapeHtml(text)}</div>
                ${sub ? `<div style="font-size: 0.85rem; color: #666; margin-top: 2px;">${this.escapeHtml(sub)}</div>` : ''}
            </button>`;

        let html = '';
        if (chats.length > 0) {
            html += '<div style="font-weight: 600; color: #667eea; margin: 4px 0 8px;">💬 Messaggi da leggere</div>';
            html += chats.map(chat => row(chat, `${chat.title}`, `${chat.count} ${chat.count === 1 ? 'messaggio nuovo' : 'messaggi nuovi'}`, true)).join('');
        }
        html += '<div style="font-weight: 600; color: #667eea; margin: 12px 0 8px;">🔔 Novità</div>';
        html += list.length === 0
            ? '<div style="color: #999; text-align: center; padding: 16px;">Nessuna novità per ora</div>'
            : list.map(n => row(n, n.title, [n.body, timeAgo(n.at)].filter(Boolean).join(' · '), !n.read)).join('');
        listEl.innerHTML = html;

        // Tocco su una riga: apre l'evento o la proposta, se esiste ancora
        listEl.querySelectorAll('.notification-row').forEach(btn => {
            btn.addEventListener('click', () => this.openNotificationTarget(btn.dataset.eventId, btn.dataset.proposalId));
        });

        // Impostazioni
        const prefs = this.getNotificationPrefs();
        document.querySelectorAll('.notification-pref').forEach(box => {
            box.checked = !!prefs[box.dataset.pref];
        });
        const phoneOn = prefs.phone && 'Notification' in window && Notification.permission === 'granted';
        const phoneBtn = document.getElementById('notificationsPhoneBtn');
        phoneBtn.textContent = phoneOn ? '🔕 Disattiva notifiche del telefono' : '📲 Attiva notifiche del telefono';
        phoneBtn.style.background = phoneOn ? '#9e9e9e' : '#4CAF50';
    }

    openNotificationTarget(eventId, proposalId) {
        if (eventId && this.events[eventId]) {
            this.closeNotificationsPanel();
            this.openEditModal(eventId);
            if (this.countUnreadMessages(eventId) > 0) {
                // Messaggi nuovi: si apre direttamente la scheda con la chat
                const tab = document.getElementById('editParticipantsTabBtn');
                if (tab) tab.click();
            }
        } else if (proposalId && this.proposals[proposalId]) {
            this.closeNotificationsPanel();
            this.showProposalModal();
            this.openProposalView(proposalId);
        } else if (eventId || proposalId) {
            this.showErrorPopup('Non esiste più');
        }
    }

    // Avvisi globali: salvataggi rifiutati non gestiti altrove e limite di caratteri raggiunto in un campo
    setupLimitWarnings() {
        window.addEventListener('unhandledrejection', (e) => {
            const code = String((e.reason && (e.reason.code || e.reason.message)) || '').toUpperCase();
            if (code.includes('PERMISSION_DENIED')) this.notifyWriteError('Salvataggio', e.reason);
        });
        document.addEventListener('input', (e) => {
            const field = e.target;
            if (!field || !(field.maxLength > 0) || field.type === 'password') return;
            if (field.value.length >= field.maxLength) {
                if (!field.dataset.limitWarned) {
                    field.dataset.limitWarned = '1';
                    this.showToast(`✋ Hai raggiunto il limite di ${field.maxLength} caratteri per questo campo.`, 'info');
                }
            } else {
                delete field.dataset.limitWarned;
            }
        });
    }

    setupNotificationListeners() {
        document.getElementById('notificationsBtn').addEventListener('click', () => this.openNotificationsPanel());
        document.getElementById('notificationsCloseBtn').addEventListener('click', () => this.closeNotificationsPanel());
        document.getElementById('notificationsModal').addEventListener('click', (e) => {
            if (e.target.id === 'notificationsModal') this.closeNotificationsPanel();
        });
        document.getElementById('notificationsClearBtn').addEventListener('click', () => {
            this.writeLocal('notifications', []);
            this.renderNotificationsPanel();
            this.renderNotificationBell();
        });
        document.querySelectorAll('.notification-pref').forEach(box => {
            box.addEventListener('change', () => this.setNotificationPref(box.dataset.pref, box.checked));
        });
        document.getElementById('notificationsPhoneBtn').addEventListener('click', async () => {
            const prefs = this.getNotificationPrefs();
            const phoneOn = prefs.phone && 'Notification' in window && Notification.permission === 'granted';
            if (phoneOn) {
                this.setNotificationPref('phone', false);
            } else if (await this.enablePhoneNotifications()) {
                this.showSuccessPopup('Notifiche attive: arrivano quando l\'app è aperta o in background');
            }
            this.renderNotificationsPanel();
        });
        // Tocco su una notifica del telefono: il service worker riporta qui evento o proposta
        if (navigator.serviceWorker) {
            navigator.serviceWorker.addEventListener('message', (e) => {
                if (e.data && e.data.type === 'open-notification') {
                    this.openNotificationTarget(e.data.eventId, e.data.proposalId);
                }
            });
        }
    }

    // ===== Presenza: chi è collegato in questo momento =====
    // presence/{uid}/{connectionId}: {active, at}. Una voce per dispositivo o scheda aperta;
    // Firebase la toglie da solo (onDisconnect) quando la scheda si chiude o la rete cade.
    // active = la Bacheca è in primo piano; false = aperta ma in background.
    // Gli altri utenti collegati compaiono come omini del loro colore che camminano nella zona del titolo:
    // salutano se attivi, sono fermi e sbiaditi se in background. Se non sono collegati, non c'è niente.

    startPresence() {
        if (!this.userId) return;
        const isActive = () => document.visibilityState === 'visible';
        database.ref('.info/connected').on('value', (snapshot) => {
            if (snapshot.val() !== true) {
                // Connessione caduta: Firebase toglie la voce, non va più usata (alla riconnessione se ne crea una nuova)
                this.presenceRef = null;
                return;
            }
            // A ogni (ri)connessione una voce nuova, tolta da Firebase alla disconnessione
            const ref = database.ref(`presence/${this.userId}`).push();
            this.presenceRef = ref;
            ref.onDisconnect().remove()
                .then(() => ref.set({ active: isActive(), at: firebase.database.ServerValue.TIMESTAMP }))
                .then(() => this.removeGhostPresence(ref.key))
                .catch(error => console.error('Errore presenza:', error));
        });
        document.addEventListener('visibilitychange', () => {
            const ref = this.presenceRef;
            if (!ref) return;
            // Solo se la voce esiste ancora sul server: se Firebase l'ha già tolta (telefono in background),
            // una semplice update la ricreerebbe senza onDisconnect e resterebbe per sempre ("fantasma").
            // La transazione viene confermata dal server: con la voce sparita si annulla.
            const active = isActive();
            ref.transaction(current => current ? Object.assign({}, current, { active }) : undefined, null, false)
                .catch(() => {});
        });
        database.ref('presence').on('value', (snapshot) => this.renderPresence(snapshot.val() || {}));

        // Ridimensionamento o pagina cambiata: se un omino finisce sopra qualcosa, si sposta
        let checkTimer = null;
        const scheduleCheck = () => {
            clearTimeout(checkTimer);
            checkTimer = setTimeout(() => this.checkPresenceSpots(), 300);
        };
        window.addEventListener('resize', scheduleCheck);
        setInterval(() => this.checkPresenceSpots(), 5000); // la pagina cambia anche senza scroll (lista, calendario)
    }

    // Voci fantasma lasciate dalle versioni precedenti (solo {active}, senza "at"): le tolgo, sono mie
    removeGhostPresence(currentKey) {
        database.ref(`presence/${this.userId}`).once('value').then(snapshot => {
            const updates = {};
            snapshot.forEach(child => {
                const value = child.val();
                if (child.key !== currentKey && (!value || typeof value.at !== 'number')) updates[child.key] = null;
            });
            if (Object.keys(updates).length) return database.ref(`presence/${this.userId}`).update(updates);
        }).catch(() => {});
    }

    // Una connessione conta solo se ha l'ora di collegamento: le voci fantasma non ce l'hanno
    getLiveConnections(connections) {
        return Object.values(connections || {}).filter(c => c && typeof c.at === 'number');
    }

    stopPresence() {
        if (!this.presenceRef) return Promise.resolve();
        const ref = this.presenceRef;
        this.presenceRef = null;
        return ref.remove().catch(() => {});
    }

    renderPresence(presence) {
        // Gli omini girano nella zona del titolo (#presenceArea), non su tutta la pagina
        const area = document.getElementById('presenceArea');
        if (!area) return;
        let layer = document.getElementById('presenceLayer');
        if (!layer) {
            layer = document.createElement('div');
            layer.id = 'presenceLayer';
            area.appendChild(layer);
        }
        if (!this.presenceEyes) this.presenceEyes = {};

        // Utenti collegati (escluso me): attivo se almeno un suo dispositivo è in primo piano
        const online = {};
        Object.entries(presence).forEach(([uid, connections]) => {
            if (uid === this.userId || !connections) return;
            const list = this.getLiveConnections(connections);
            if (list.length > 0) online[uid] = list.some(c => c.active);
        });

        // Spariscono gli omini di chi si è scollegato
        Object.keys(this.presenceEyes).forEach(uid => {
            if (!(uid in online)) {
                clearInterval(this.presenceEyes[uid].timer);
                this.presenceEyes[uid].el.remove();
                delete this.presenceEyes[uid];
            }
        });

        Object.entries(online).forEach(([uid, active]) => {
            let figure = this.presenceEyes[uid];
            if (!figure) {
                figure = { el: this.createPresenceFigure(uid) };
                layer.appendChild(figure.el);
                this.movePresenceEye(figure.el, true);
                // Ogni tanto cammina fino a un altro punto libero
                figure.timer = setInterval(() => this.movePresenceEye(figure.el, false), 12000 + Math.random() * 12000);
                this.presenceEyes[uid] = figure;
            }
            figure.el.classList.toggle('presence-asleep', !active);
            const name = this.getParticipantName(uid);
            figure.el.querySelector('.presence-name').textContent = active ? name : `${name} · in pausa`;
            figure.el.setAttribute('aria-label', `${name} è collegato${active ? '' : ' (in pausa)'}`);
        });
        this.ensureUserNames(Object.keys(online)); // nomi di chi si è registrato dopo l'apertura
    }

    // Omino del colore dell'utente: saluta con la mano; in pausa resta fermo e sbiadito
    createPresenceFigure(uid) {
        const color = this.getUserColor(uid).bg;
        const delay = (Math.random() * 3).toFixed(2);
        const el = document.createElement('div');
        el.className = 'presence-figure';
        el.setAttribute('role', 'img');
        el.innerHTML = `
            <svg width="26" height="38" viewBox="0 0 26 38" aria-hidden="true">
                <circle cx="13" cy="7" r="5.5" fill="${color}" stroke="#fff" stroke-width="1.2"/>
                <rect x="7.5" y="13.5" width="11" height="13" rx="4.5" fill="${color}" stroke="#fff" stroke-width="1.2"/>
                <rect x="8" y="25.5" width="4" height="10" rx="2" fill="${color}" stroke="#fff" stroke-width="1"/>
                <rect x="14" y="25.5" width="4" height="10" rx="2" fill="${color}" stroke="#fff" stroke-width="1"/>
                <rect x="3" y="15" width="4" height="9.5" rx="2" fill="${color}" stroke="#fff" stroke-width="1"/>
                <rect class="presence-wave" style="animation-delay: ${delay}s" x="19" y="6" width="4" height="9.5" rx="2" fill="${color}" stroke="#fff" stroke-width="1"/>
            </svg>
            <span class="presence-name"></span>`;
        // Sul telefono: il nome compare al tocco per qualche secondo
        el.addEventListener('click', () => {
            el.classList.add('presence-show');
            clearTimeout(el.hideTimer);
            el.hideTimer = setTimeout(() => el.classList.remove('presence-show'), 2500);
        });
        return el;
    }

    // Gli omini stanno nella zona del titolo ma mai sopra le scritte o sopra qualcosa di cliccabile.
    // Si usano i rettangoli del TESTO (non dei blocchi: un <h1> è largo quanto tutta la zona),
    // così gli omini possono stare ai lati del titolo. Se non c'è un punto libero l'omino resta dov'è,
    // semitrasparente e trasparente ai clic.
    getPresenceObstacles() {
        const area = document.getElementById('presenceArea');
        const rects = [];
        if (!area) return rects;
        area.querySelectorAll('h1, h2, p, button, a, input, img').forEach(el => {
            const range = document.createRange();
            range.selectNodeContents(el);
            for (const r of range.getClientRects()) {
                if (r.width > 0 && r.height > 0) rects.push(r);
            }
        });
        return rects;
    }

    isPresenceSpotFree(x, y, obstacles = this.getPresenceObstacles()) {
        const W = 26, H = 38, M = 6; // dimensioni dell'omino + margine
        return !obstacles.some(r => x - M < r.right && x + W + M > r.left && y - M < r.bottom && y + H + M > r.top);
    }

    pickPresenceSpot() {
        const area = document.getElementById('presenceArea');
        if (!area) return null;
        const rect = area.getBoundingClientRect();
        const maxLeft = rect.width - 26, maxTop = rect.height - 38;
        if (maxLeft <= 0 || maxTop < 0) return null;
        const obstacles = this.getPresenceObstacles();
        for (let attempt = 0; attempt < 60; attempt++) {
            const left = Math.random() * maxLeft;
            const top = Math.random() * maxTop;
            // Il controllo usa le coordinate della finestra: zona + posizione nella zona
            if (this.isPresenceSpotFree(rect.left + left, rect.top + top, obstacles)) {
                return { left, top, side: top < 30 ? 'top' : 'bottom' };
            }
        }
        return null;
    }

    movePresenceEye(el, instant) {
        const spot = this.pickPresenceSpot();
        if (!spot) {
            el.classList.add('presence-passive'); // nessun posto libero: non intercetta i clic
            return;
        }
        el.classList.remove('presence-passive');
        const fromLeft = parseFloat(el.style.left) || 0;
        el.style.transform = spot.left < fromLeft ? 'scaleX(-1)' : ''; // si gira verso dove cammina
        el.querySelector('.presence-name').style.transform = spot.left < fromLeft ? 'translateX(-50%) scaleX(-1)' : '';
        if (instant) {
            el.style.transition = 'none';
        } else {
            // Mentre cammina saltella e non intercetta i clic
            el.style.transition = '';
            el.classList.add('presence-moving');
            clearTimeout(el.movingTimer);
            el.movingTimer = setTimeout(() => el.classList.remove('presence-moving'), 4200);
        }
        el.style.left = `${Math.round(spot.left)}px`;
        el.style.top = `${Math.round(spot.top)}px`;
        el.dataset.side = spot.side;
    }

    // Dopo un ridimensionamento (o un cambio della zona) sotto un omino può esserci qualcosa: si sposta
    checkPresenceSpots() {
        const area = document.getElementById('presenceArea');
        if (!area) return;
        const rect = area.getBoundingClientRect();
        Object.values(this.presenceEyes || {}).forEach(({ el }) => {
            if (el.classList.contains('presence-moving')) return;
            const left = parseFloat(el.style.left) || 0;
            const top = parseFloat(el.style.top) || 0;
            const outside = left > rect.width - 26 || top > rect.height - 38;
            if (outside || !this.isPresenceSpotFree(rect.left + left, rect.top + top)) this.movePresenceEye(el, false);
        });
    }

    rebuildNotesIndex() {
        const index = {};
        Object.values(this.events).forEach(event => {
            if (!event || !event.id || !event.date) return;
            if (!index[event.date]) index[event.date] = [];
            index[event.date].push(event);
        });
        Object.values(index).forEach(dayEvents => this.sortByTime(dayEvents));
        this.notes = index;
    }

    // ===== Ruoli, blocco, statistiche e impostazioni dell'app (0.5.0) =====
    // roles/{uid}: "admin"        -> si imposta SOLO dalla console di Firebase
    // blocked/{uid}: true         -> l'admin blocca un utente: le regole gli negano letture e scritture
    // stats/{uid}: {eventsCreated, proposalsCreated, messagesSent, joins, opens, lastActiveAt, firstSeenAt, days/{YYYY-MM-DD}}
    // settings: {announcement: {text, updatedAt}, title: {line1, line2, line3}}

    async loadRole() {
        try {
            const snapshot = await database.ref(`roles/${this.userId}`).once('value');
            this.isAdmin = snapshot.val() === 'admin';
        } catch (e) {
            this.isAdmin = false;
        }
        const adminBtn = document.getElementById('adminBtn');
        if (adminBtn) adminBtn.style.display = this.isAdmin ? 'block' : 'none';
    }

    // Contatori d'uso: li scrive ognuno per sé (con increment, senza leggere prima)
    recordStat(field) {
        if (!this.userId) return;
        database.ref(`stats/${this.userId}/${field}`).set(firebase.database.ServerValue.increment(1)).catch(() => {});
    }

    // All'apertura: un'apertura in più, ultimo accesso e giorno di attività (un solo aggiornamento)
    recordAppOpen() {
        if (!this.userId) return;
        const today = this.getDateKey(new Date());
        database.ref(`stats/${this.userId}`).update({
            opens: firebase.database.ServerValue.increment(1),
            lastActiveAt: firebase.database.ServerValue.TIMESTAMP,
            [`days/${today}`]: true
        }).catch(() => {});
        database.ref(`stats/${this.userId}/firstSeenAt`).transaction(current => current || Date.now()).catch(() => {});
    }

    // Avviso a tutti (striscia in alto) e titoli modificabili dall'admin
    listenSettings() {
        // Se l'admin blocca questo account mentre è aperto: si ricarica e compare il messaggio di blocco
        database.ref(`blocked/${this.userId}`).on('value', (snapshot) => {
            if (snapshot.exists()) location.reload();
        }, () => {});
        database.ref('settings').on('value', (snapshot) => {
            this.settings = snapshot.val() || {};
            const banner = document.getElementById('announcementBanner');
            const text = this.settings.announcement && this.settings.announcement.text;
            if (banner) {
                banner.textContent = text ? `📣 ${text}` : '';
                banner.style.display = text ? 'block' : 'none';
            }
            const title = this.settings.title;
            const wasOverridden = this.settingsTitleOverridden;
            this.settingsTitleOverridden = !!(title && (title.line1 || title.line2 || title.line3));
            if (this.settingsTitleOverridden) {
                document.getElementById('titleLine1').textContent = title.line1 || '';
                document.getElementById('titleLine2').textContent = title.line2 || '';
                document.getElementById('titleLine3').textContent = title.line3 || '';
            } else if (wasOverridden) {
                this.loadTitle(); // titolo tolto dall'admin: torna quello del file
            }
        }, () => { /* utente bloccato o regole vecchie: niente impostazioni */ });
    }

    async adminDeleteMessage(chatId, messageId, text) {
        if (!this.isAdmin) return;
        const preview = text.length > 60 ? text.slice(0, 60) + '…' : text;
        const ok = await this.showConfirmDialog(`Cancellare il messaggio "${preview}"?`);
        if (!ok) return;
        database.ref(`eventChats/${chatId}/messages/${messageId}`).remove()
            .then(() => this.showToast('Messaggio cancellato', 'info'))
            .catch(error => this.notifyWriteError('Cancellazione del messaggio', error));
    }

    // Amministratore: toglie un partecipante dall'evento
    async adminRemoveParticipant(participantId) {
        const event = this.getEditingEvent();
        if (!this.isAdmin || !event) return;
        const ok = await this.showConfirmDialog(`Togliere ${this.getParticipantName(participantId)} dai partecipanti di "${event.title}"?`, 'Togli');
        if (!ok) return;
        database.ref(`events/${event.id}/participants/${participantId}`).remove()
            .then(() => this.showToast('Partecipante tolto', 'info'))
            .catch(error => this.notifyWriteError('Rimozione del partecipante', error));
    }

    canManageProposal(proposal) {
        return this.isProposalCreator(proposal) || !!this.isAdmin;
    }

    // ===== Pagina Amministrazione =====
    async openAdminPanel() {
        if (!this.isAdmin) return;
        const menuDropdown = document.getElementById('menuDropdown');
        if (menuDropdown) menuDropdown.style.display = 'none';
        document.getElementById('adminModal').style.display = 'flex';
        document.body.style.overflow = 'hidden'; // a tutta pagina: sotto non scorre niente
        this.showAdminTab(this.adminTab || 'users');
        document.getElementById('adminContent').innerHTML = '<p style="color:#666">Caricamento…</p>';
        await this.loadAdminData();
        this.renderAdminPanel();
    }

    closeAdminPanel() {
        document.getElementById('adminModal').style.display = 'none';
        document.body.style.overflow = '';
    }

    async loadAdminData() {
        const [users, stats, blocked, presence] = await Promise.all(
            ['users', 'stats', 'blocked', 'presence'].map(path =>
                database.ref(path).once('value').then(s => s.val() || {}).catch(() => ({}))));
        this.adminData = { users, stats, blocked, presence };
    }

    showAdminTab(tab) {
        this.adminTab = tab;
        document.querySelectorAll('.admin-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
        if (this.adminData) this.renderAdminPanel();
    }

    formatAgo(timestamp) {
        if (!timestamp) return 'mai';
        const minutes = Math.round((Date.now() - timestamp) / 60000);
        if (minutes < 2) return 'adesso';
        if (minutes < 60) return `${minutes} min fa`;
        const hours = Math.round(minutes / 60);
        if (hours < 24) return `${hours} h fa`;
        const days = Math.round(hours / 24);
        if (days < 30) return `${days} g fa`;
        return new Date(timestamp).toLocaleDateString('it-IT');
    }

    renderAdminPanel() {
        const content = document.getElementById('adminContent');
        if (!content || !this.adminData) return;
        const { users, stats, blocked, presence } = this.adminData;
        const esc = (t) => this.escapeHtml(t);

        if (this.adminTab === 'users') {
            const rows = Object.entries(users)
                .map(([uid, user]) => ({ uid, user, s: stats[uid] || {} }))
                .sort((a, b) => (b.s.lastActiveAt || 0) - (a.s.lastActiveAt || 0));
            const last30 = new Date(); last30.setDate(last30.getDate() - 30);
            const from = this.getDateKey(last30);
            content.innerHTML = rows.map(({ uid, user, s }) => {
                const online = this.getLiveConnections(presence[uid]).length > 0;
                const isBlocked = !!blocked[uid];
                const days30 = Object.keys(s.days || {}).filter(d => d >= from).length;
                const registered = user.createdAt ? new Date(user.createdAt).toLocaleDateString('it-IT') : '?';
                return `
                    <div class="admin-user" style="border-left: 5px solid ${this.getUserColor(uid).bg}; ${isBlocked ? 'opacity: 0.6;' : ''}">
                        <div style="display:flex; justify-content:space-between; gap:8px; align-items:baseline;">
                            <strong>${esc(user.name || '?')}${uid === this.userId ? ' (tu)' : ''}</strong>
                            <span style="font-size:0.8rem; color:${online ? '#2e7d32' : '#888'};">${online ? '● collegato' : esc(this.formatAgo(s.lastActiveAt))}</span>
                        </div>
                        <div style="font-size:0.8rem; color:#666;">@${esc(user.username || '?')} · registrato il ${esc(registered)}${isBlocked ? ' · <b style="color:#c62828">BLOCCATO</b>' : ''}</div>
                        <div style="font-size:0.8rem; color:#444; margin:4px 0;">
                            📅 ${s.eventsCreated || 0} eventi · 🗳️ ${s.proposalsCreated || 0} proposte · 💬 ${s.messagesSent || 0} messaggi · 🙋 ${s.joins || 0} iscrizioni · 📲 ${s.opens || 0} aperture · 🗓️ ${days30} giorni attivi (30 g)
                        </div>
                        ${uid === this.userId ? '' : `
                        <div style="display:flex; gap:6px;">
                            <button type="button" class="admin-action" data-action="rename" data-uid="${esc(uid)}">✏️ Rinomina</button>
                            <button type="button" class="admin-action" data-action="${isBlocked ? 'unblock' : 'block'}" data-uid="${esc(uid)}">${isBlocked ? '✅ Sblocca' : '⛔ Blocca'}</button>
                        </div>`}
                    </div>`;
            }).join('') || '<p>Nessun utente</p>';
            content.querySelectorAll('.admin-action').forEach(btn => btn.addEventListener('click', () => this.adminUserAction(btn.dataset.action, btn.dataset.uid)));
            return;
        }

        if (this.adminTab === 'stats') {
            const now = Date.now();
            const list = Object.entries(users).map(([uid, user]) => ({ uid, name: user.name || '?', s: stats[uid] || {} }));
            const activeSince = (ms) => list.filter(u => u.s.lastActiveAt && now - u.s.lastActiveAt < ms).length;
            const sum = (f) => list.reduce((t, u) => t + (u.s[f] || 0), 0);
            const events = Object.values(this.events || {}).filter(e => e && e.id);
            const bar = (label, value, max, color) => `
                <div style="margin:4px 0;">
                    <div style="display:flex; justify-content:space-between; font-size:0.85rem;"><span>${esc(label)}</span><b>${value}</b></div>
                    <div style="height:8px; background:#eee; border-radius:4px;"><div style="height:8px; width:${max ? Math.round(value / max * 100) : 0}%; background:${color}; border-radius:4px;"></div></div>
                </div>`;
            const top = (field, label) => {
                const sorted = list.filter(u => u.s[field]).sort((a, b) => b.s[field] - a.s[field]).slice(0, 5);
                const max = sorted.length ? sorted[0].s[field] : 0;
                return `<h4>${label}</h4>` + (sorted.map(u => bar(u.name, u.s[field], max, this.getUserColor(u.uid).bg)).join('') || '<p style="color:#888">Ancora niente</p>');
            };
            const byParticipants = events.map(e => ({ t: e.title, n: this.getParticipantIds(e).length }))
                .filter(e => e.n > 0).sort((a, b) => b.n - a.n).slice(0, 5);
            const categories = {};
            events.forEach(e => { categories[e.color || 'color-neutral'] = (categories[e.color || 'color-neutral'] || 0) + 1; });
            const catNames = {};
            document.querySelectorAll('input[name="editEventColor"]').forEach(input => {
                catNames[input.dataset.color] = input.closest('.category-option').textContent.trim();
            });
            const catSorted = Object.entries(categories).sort((a, b) => b[1] - a[1]);
            const catMax = catSorted.length ? catSorted[0][1] : 0;
            content.innerHTML = `
                <div class="admin-cards">
                    <div><b>${list.length}</b><span>utenti</span></div>
                    <div><b>${activeSince(86400000)}</b><span>attivi oggi</span></div>
                    <div><b>${activeSince(7 * 86400000)}</b><span>attivi in 7 giorni</span></div>
                    <div><b>${events.length}</b><span>eventi in calendario</span></div>
                    <div><b>${Object.keys(this.proposals || {}).length}</b><span>proposte aperte</span></div>
                    <div><b>${sum('messagesSent')}</b><span>messaggi scritti</span></div>
                </div>
                ${top('eventsCreated', '📅 Chi crea più eventi')}
                ${top('messagesSent', '💬 Chi scrive di più in chat')}
                ${top('opens', '📲 Chi apre di più l\'app')}
                <h4>👥 Eventi più partecipati</h4>
                ${byParticipants.map(e => bar(e.t, e.n, byParticipants[0].n, '#667eea')).join('') || '<p style="color:#888">Nessuna iscrizione</p>'}
                <h4>🎨 Categorie più usate</h4>
                ${catSorted.map(([c, n]) => bar(catNames[c] || c, n, catMax, '#ffb74d')).join('') || '<p style="color:#888">Nessun evento</p>'}
                <p style="font-size:0.75rem; color:#888;">I contatori partono dalla versione 0.5.0: le azioni precedenti non sono contate.</p>`;
            return;
        }

        // Scheda App: avviso a tutti e titolo
        const s = this.settings || {};
        const a = s.announcement || {};
        const t = s.title || {};
        content.innerHTML = `
            <h4>📣 Avviso a tutti</h4>
            <p style="font-size:0.8rem; color:#666; margin:0 0 6px;">Compare in una striscia in cima alla Bacheca per tutti, finché non lo togli.</p>
            <textarea id="adminAnnouncement" maxlength="200" rows="2" style="width:100%; box-sizing:border-box; padding:8px; border:2px solid #eee; border-radius:8px;">${esc(a.text || '')}</textarea>
            <div style="display:flex; gap:8px; margin:6px 0 16px;">
                <button type="button" id="adminAnnouncementSave" class="admin-action">💾 Pubblica</button>
                <button type="button" id="adminAnnouncementClear" class="admin-action">🗑️ Togli</button>
            </div>
            <h4>🏷️ Titolo della Bacheca</h4>
            <p style="font-size:0.8rem; color:#666; margin:0 0 6px;">Se vuoti si usa il testo del file descrizioni/titolo.</p>
            <input id="adminTitle1" maxlength="60" placeholder="Riga 1" value="${esc(t.line1 || '')}" style="width:100%; box-sizing:border-box; padding:8px; margin-bottom:6px; border:2px solid #eee; border-radius:8px;">
            <input id="adminTitle2" maxlength="60" placeholder="Riga 2" value="${esc(t.line2 || '')}" style="width:100%; box-sizing:border-box; padding:8px; margin-bottom:6px; border:2px solid #eee; border-radius:8px;">
            <input id="adminTitle3" maxlength="100" placeholder="Sottotitolo" value="${esc(t.line3 || '')}" style="width:100%; box-sizing:border-box; padding:8px; margin-bottom:6px; border:2px solid #eee; border-radius:8px;">
            <div style="display:flex; gap:8px;">
                <button type="button" id="adminTitleSave" class="admin-action">💾 Salva titolo</button>
                <button type="button" id="adminTitleReset" class="admin-action">↩️ Usa quello del file</button>
            </div>`;
        const done = (msg) => () => this.showToast(msg, 'info');
        const fail = (what) => (error) => this.notifyWriteError(what, error);
        document.getElementById('adminAnnouncementSave').addEventListener('click', () => {
            const text = document.getElementById('adminAnnouncement').value.trim();
            if (!text) return this.showToast('Scrivi il testo dell\'avviso', 'info');
            database.ref('settings/announcement').set({ text, updatedAt: Date.now() }).then(done('📣 Avviso pubblicato')).catch(fail('Avviso a tutti'));
        });
        document.getElementById('adminAnnouncementClear').addEventListener('click', () => {
            database.ref('settings/announcement').remove().then(done('Avviso tolto')).catch(fail('Avviso a tutti'));
        });
        document.getElementById('adminTitleSave').addEventListener('click', () => {
            const title = {
                line1: document.getElementById('adminTitle1').value.trim(),
                line2: document.getElementById('adminTitle2').value.trim(),
                line3: document.getElementById('adminTitle3').value.trim()
            };
            database.ref('settings/title').set(title).then(done('Titolo salvato')).catch(fail('Titolo'));
        });
        document.getElementById('adminTitleReset').addEventListener('click', () => {
            database.ref('settings/title').remove().then(done('Titolo del file ripristinato')).catch(fail('Titolo'));
        });
    }

    async adminUserAction(action, uid) {
        const user = (this.adminData.users || {})[uid] || {};
        const name = user.name || 'questo utente';
        if (action === 'rename') {
            const newName = (prompt(`Nuovo nome per ${name} (massimo 10 caratteri):`, user.name || '') || '').trim();
            if (!newName) return;
            if (newName.length > 10) return this.showToast('Il nome può avere al massimo 10 caratteri', 'info');
            await database.ref(`users/${uid}/name`).set(newName).then(() => {
                this.userNames[uid] = newName;
                this.showToast(`Nome cambiato in "${newName}"`, 'info');
            }).catch(error => this.notifyWriteError('Rinomina utente', error));
        } else if (action === 'block') {
            const ok = await this.showConfirmDialog(`Bloccare ${name}? Non potrà più vedere né scrivere niente finché non lo sblocchi.`, '⛔ Blocca');
            if (!ok) return;
            await database.ref(`blocked/${uid}`).set(true).then(() => this.showToast(`${name} è bloccato`, 'info'))
                .catch(error => this.notifyWriteError('Blocco utente', error));
        } else if (action === 'unblock') {
            await database.ref(`blocked/${uid}`).remove().then(() => this.showToast(`${name} è sbloccato`, 'info'))
                .catch(error => this.notifyWriteError('Sblocco utente', error));
        }
        await this.loadAdminData();
        this.renderAdminPanel();
    }

    setupAdminListeners() {
        document.getElementById('adminBtn').addEventListener('click', () => this.openAdminPanel());
        document.getElementById('adminCloseBtn').addEventListener('click', () => this.closeAdminPanel());
        document.getElementById('adminRefreshBtn').addEventListener('click', async () => {
            await this.loadAdminData();
            this.renderAdminPanel();
        });
        document.querySelectorAll('.admin-tab').forEach(btn => btn.addEventListener('click', () => this.showAdminTab(btn.dataset.tab)));
        document.getElementById('adminModal').addEventListener('click', (e) => {
            if (e.target.id === 'adminModal') this.closeAdminPanel();
        });
        document.getElementById('editCreatorSelect').addEventListener('change', async (e) => {
            const event = this.getEditingEvent();
            const newCreator = e.target.value;
            if (!event || !this.isAdmin || !newCreator || newCreator === event.creatorId) return;
            const ok = await this.showConfirmDialog(`Passare l'evento "${event.title}" a ${this.getParticipantName(newCreator)}? Da quel momento potrà modificarlo solo lui (e l'amministratore).`, 'Passa', '#667eea');
            if (!ok) { e.target.value = event.creatorId || ''; return; }
            database.ref(`events/${event.id}`).update({ creatorId: newCreator })
                .then(() => this.showToast('Creatore cambiato', 'info'))
                .catch(error => {
                    e.target.value = event.creatorId || '';
                    this.notifyWriteError('Cambio del creatore', error);
                });
        });
    }

    // Nel modal di modifica, solo per l'admin: scelta del creatore dell'evento
    renderCreatorSelect(event) {
        const group = document.getElementById('editCreatorGroup');
        const select = document.getElementById('editCreatorSelect');
        if (!group || !select) return;
        group.style.display = this.isAdmin ? 'block' : 'none';
        if (!this.isAdmin) return;
        const options = Object.entries(this.userNames || {})
            .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
            .map(([uid, name]) => `<option value="${this.escapeHtml(uid)}">${this.escapeHtml(name)}</option>`);
        select.innerHTML = (event.creatorId && !this.userNames[event.creatorId] ? '<option value="">(sconosciuto)</option>' : '') + options.join('');
        select.value = event.creatorId || '';
    }

    getParticipantIds(event) {
        return Object.keys((event && event.participants) || {});
    }

    // Modifica, spostamento ed eliminazione: solo chi ha creato l'evento (come nelle regole Firebase).
    // Un evento senza creatore è in sola lettura per tutti. Iscriversi e scrivere in chat resta permesso.
    canEditEvent(event) {
        if (event && this.isAdmin) return true; // l'amministratore modera tutto
        return !!event && !!event.creatorId && event.creatorId === this.userId;
    }

    // Modal di modifica in sola lettura per chi non è il creatore
    applyEditPermissions(event) {
        const canEdit = this.canEditEvent(event);
        this.canEditCurrentEvent = canEdit;
        ['editTitle', 'editDate', 'editTime', 'editLocation', 'editFee', 'editNotes', 'editCategoryCurrent'].forEach(id => {
            document.getElementById(id).disabled = !canEdit;
        });
        const show = (id, visible, display = 'inline-block') => {
            document.getElementById(id).style.display = visible ? display : 'none';
        };
        show('editImageToggleBtn', canEdit);
        show('editLinkModifyBtn', canEdit, 'block');
        show('deleteNoteBtn', canEdit);
        const onEventTab = document.getElementById('edit-evento-tab').classList.contains('active');
        show('saveEditBtn', canEdit && onEventTab);
        if (!canEdit) {
            this.closeEditImagePanel();
            this.closeCategorySelects();
            document.getElementById('editLinkContainer').style.display = 'flex';
            document.getElementById('editLinkInputContainer').style.display = 'none';
        }
    }

    getEditingEvent() {
        return this.editingNote ? (this.events[this.editingNote.id] || null) : null;
    }

    updateEvent(eventId, fields) {
        return database.ref(`events/${eventId}`).update(fields).catch(error => {
            this.notifyWriteError('Salvataggio dell\'evento', error);
        });
    }

    // All'apertura dell'app gli eventi dei mesi precedenti si cancellano, con chat, letture e immagine.
    // Ognuno cancella solo i propri (le regole non permettono di più): quelli degli altri non si vedono comunque.
    async cleanupPastEvents() {
        const today = new Date();
        const firstOfMonth = this.getDateKey(new Date(today.getFullYear(), today.getMonth(), 1));
        const removeEvent = (updates, id) => {
            updates[`events/${id}`] = null;
            updates[`eventChats/${id}`] = null;
            updates[`chatReadStatus/${this.userId}/${id}`] = null;
            updates[`eventImages/${id}`] = null;
        };

        try {
            const updates = {};
            Object.values(this.events).forEach(event => {
                if (event && event.id && event.date && event.date < firstOfMonth && event.creatorId && event.creatorId === this.userId) { // solo i propri, anche per l'admin
                    removeEvent(updates, event.id);
                }
            });
            if (Object.keys(updates).length > 0) {
                await database.ref().update(updates);
            }
        } catch (error) {
            console.error('Errore pulizia eventi passati:', error);
        }
    }

    updateAllBadges() {
        // Aggiorna i badge di tutti gli eventi visibili
        const noteElements = document.querySelectorAll('[data-event-id]');
        noteElements.forEach(noteEl => {
            const eventId = noteEl.getAttribute('data-event-id');
            if (eventId) {
                this.updateNoteBadge(noteEl, eventId);
                // Aggiorna anche il badge nella lista
                const listEl = document.querySelector(`.event-item[data-event-id="${eventId}"]`);
                if (listEl) {
                    this.updateListEventBadge(listEl, eventId);
                }
            }
        });

        // Badge delle proposte "Da fissare"
        this.updateProposalBadges();

        // Aggiorna il badge del pulsante Chat se il modal è aperto
        if (this.editingNote) {
            this.updateChatButtonBadge(this.editingNote.id);
        }

        this.renderNotificationBell();
    }

    // Messaggi non letti: tutto in memoria (messaggi dal listener globale, letture dal proprio nodo)
    countUnreadMessages(chatId) {
        const messages = (this.chatMessages[chatId] && this.chatMessages[chatId].messages) || {};
        const lastRead = this.getLastRead(chatId);
        return Object.values(messages).filter(message => message && message.timestamp > lastRead).length;
    }

    getUnreadMessageCount(chatId) {
        return Promise.resolve(this.countUnreadMessages(chatId));
    }

    // Messaggi non letti sulla scheda "Partecipanti" (dove c'è la chat), solo per chi partecipa
    updateChatButtonBadge(eventId) {
        const tabBtn = document.getElementById('editParticipantsTabBtn');
        if (!tabBtn) return;

        const isParticipant = this.editParticipantsList && this.editParticipantsList.includes(this.userId);
        if (!isParticipant) {
            tabBtn.textContent = '👥 Partecipanti';
            return;
        }

        this.getUnreadMessageCount(eventId).then(count => {
            tabBtn.textContent = count > 0 ? `👥 Partecipanti 💬${count}` : '👥 Partecipanti';
        });
    }

    updateNoteBadge(noteEl, eventId) {
        // Mostra il badge solo a chi partecipa all'evento
        const isParticipant = this.getParticipantIds(this.events[eventId]).includes(this.userId);

        // Se non sei partecipante, nascondi il badge
        if (!isParticipant) {
            const badge = noteEl.querySelector('.note-badge');
            if (badge) badge.style.display = 'none';
            return;
        }

        this.getUnreadMessageCount(eventId).then(count => {
            const badge = noteEl.querySelector('.note-badge');
            if (badge && count > 0) {
                badge.textContent = count;
                badge.style.display = 'flex';
            } else if (badge) {
                badge.style.display = 'none';
            }
        });
    }

    updateListEventBadge(eventEl, eventId) {
        // Mostra il badge solo a chi partecipa all'evento
        const isParticipant = this.getParticipantIds(this.events[eventId]).includes(this.userId);

        // Se non sei partecipante, nascondi il badge
        if (!isParticipant) {
            const badge = eventEl.querySelector('.list-event-badge');
            if (badge) badge.style.display = 'none';
            return;
        }

        this.getUnreadMessageCount(eventId).then(count => {
            const badge = eventEl.querySelector('.list-event-badge');
            if (badge && count > 0) {
                badge.textContent = count;
                badge.style.display = 'flex';
            } else if (badge) {
                badge.style.display = 'none';
            }
        });
    }

    toggleGifModal() {
        const gifModal = document.getElementById('gifModal');
        gifModal.classList.toggle('active');
    }

    loadColorFilters() {
        const saved = localStorage.getItem('colorFilters');
        if (saved) {
            return JSON.parse(saved);
        }
        // Default: tutti i colori visibili
        return {
            'color-neutral': true,
            'color-yellow': true,
            'color-pink': true,
            'color-green': true,
            'color-blue': true,
            'color-purple': true,
            'color-teal': true,
            'color-orange': true
        };
    }

    saveColorFilters() {
        localStorage.setItem('colorFilters', JSON.stringify(this.visibleColors));
    }

    handleColorFilterChange() {
        document.querySelectorAll('.color-filter').forEach(checkbox => {
            const color = checkbox.dataset.color;
            this.visibleColors[color] = checkbox.checked;
        });
        this.saveColorFilters();
        // Ricarica il calendario e la lista
        this.renderCalendar();
        if (this.isListView) {
            this.renderList();
        }
    }

    isColorVisible(color) {
        return this.visibleColors[color] !== false;
    }

    // Edit Modal
    updateEditModalContent() {
        // Aggiorna il modal con i dati arrivati da Firebase. Titolo, ora, luogo, note e data
        // non si toccano: l'utente potrebbe star scrivendo, e si salvano solo con "Salva".
        const note = this.getEditingEvent();
        if (!note) return;

        // Aggiorna i partecipanti
        this.editParticipantsList = this.getParticipantIds(note);
        this.renderEditParticipants();
        this.updateChatInputVisibility(this.editParticipantsList);
        this.loadAndDisplayCreatorName(note.creatorId);
        this.renderCreatorSelect(note);

        // Aggiorna il colore
        this.selectedColor = note.color || 'color-yellow';
        const colorRadio = document.querySelector(`input[name="editEventColor"][data-color="${this.selectedColor}"]`);
        if (colorRadio) {
            colorRadio.checked = true;
        }

        this.updateCategoryDisplay('editCategorySelect');

        // Aggiorna link e immagine
        document.getElementById('editLink').value = note.link || '';
        this.renderEditLink(note.link);
        this.showEditCover(note);
        this.applyEditPermissions(note);
    }

    openEditModal(eventId) {
        const note = this.events[eventId];
        if (!note) return;

        // Chiudi il modal di aggiunta se aperto
        document.getElementById('modal').classList.remove('active');
        document.getElementById('modal').style.display = 'none';

        this.editingNote = { id: eventId, dateKey: note.date };

        document.getElementById('editTitle').value = note.title || '';
        this.setEditDateField(note.date);
        document.getElementById('editTime').value = note.time || '';
        document.getElementById('editLocation').value = note.location || '';
        document.getElementById('editNotes').value = note.notes || '';
        this.setFeeInput('edit', note.fee);
        document.getElementById('editLink').value = note.link || '';

        // Gestisci visualizzazione link
        this.renderEditLink(note.link);

        // Carica il nome del creatore
        this.loadAndDisplayCreatorName(note.creatorId);
        this.renderCreatorSelect(note);

        // Set partecipanti (elenco chiuso a ogni apertura)
        this.editParticipantsList = this.getParticipantIds(note);
        this.setParticipantsListOpen(false);
        this.renderEditParticipants();

        // Set colore - mantieni il colore originale come default
        this.selectedColor = note.color || 'color-yellow';
        const colorRadio = document.querySelector(`input[name="editEventColor"][data-color="${this.selectedColor}"]`);
        if (colorRadio) {
            colorRadio.checked = true;
        }

        this.updateCategoryDisplay('editCategorySelect');
        this.closeCategorySelects();

        // Pannello immagine chiuso: si apre con la matita
        this.closeEditImagePanel();

        // Parti dal gradiente viola, poi carica l'immagine se esiste
        const coverContainer = document.getElementById('eventCoverContainer');
        coverContainer.style.backgroundImage = 'none';
        coverContainer.style.backgroundAttachment = 'fixed';
        // Mantieni sempre una min-height per mostrare il gradiente viola
        coverContainer.style.minHeight = '120px';
        this.showEditCover(note);

        // Carica e visualizza i messaggi della chat
        this.loadAndDisplayChatMessages(note.id);

        // Aggiorna il badge dei messaggi non letti
        this.updateChatButtonBadge(note.id);

        // Nascondi il form di invio se non sei partecipante
        this.updateChatInputVisibility(this.editParticipantsList);

        this.applyEditPermissions(note);

        document.getElementById('editModal').classList.add('active');
        document.getElementById('editModal').style.display = 'flex';
    }

    loadAndDisplayChatMessages(eventId) {
        try {
            const chatRef = database.ref(`eventChats/${eventId}/messages`);

            // Rimuovi il vecchio listener se esiste
            if (this.chatListener) {
                chatRef.off('value', this.chatListener);
            }

            this.currentChat = null;

            // Crea un nuovo listener per aggiornamenti real-time
            this.chatListener = chatRef.on('value', (snapshot) => {
                const messagesContainer = document.getElementById('chatMessagesContainer');
                if (!messagesContainer) return; // Se il container non esiste, esci

                messagesContainer.innerHTML = '';
                this.currentChat = null;

                if (!snapshot.exists()) {
                    messagesContainer.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">Nessun messaggio ancora. Inizia una conversazione!</div>';

                    // Se non ci sono messaggi, aggiorna i badge
                    if (this.editingNote) {
                        this.updateChatButtonBadge(this.editingNote.id);
                        this.updateCalendarBadge(this.editingNote.id);
                    }
                    return;
                }

                // Ultima lettura dalla memoria (separatore "Nuovi messaggi")
                const lastReadTimestamp = this.getLastRead(eventId);
                this.currentChat = { eventId, messages: snapshot.val(), lastReadTimestamp };
                messagesContainer.innerHTML = '';
                this.renderChatInto(messagesContainer, snapshot.val(), lastReadTimestamp, this.editParticipantsList, true, eventId);

                // Aggiorna i badge quando i messaggi cambiano
                if (this.editingNote) {
                    this.updateChatButtonBadge(this.editingNote.id);
                    // Aggiorna il badge nel calendario
                    this.updateCalendarBadge(this.editingNote.id);
                }
            });
        } catch (error) {
            console.error('Errore caricamento messaggi chat:', error);
        }
    }

    // Disegna i messaggi di una chat (eventi e proposte): gruppi per mittente e separatore "Nuovi messaggi"
    // participantIds: se indicato (chat degli eventi), chi non è tra i partecipanti è scritto in grigio.
    // Il grigio non è nella tavolozza degli utenti, quindi non si confonde con nessuno.
    renderChatInto(messagesContainer, messages, lastReadTimestamp, participantIds = null, scrollToBottom = true, chatId = null) {
        const messageIds = Object.keys(messages).sort((a, b) => messages[a].timestamp - messages[b].timestamp);

        // Accorpa messaggi consecutivi dello stesso utente
        let groupedMessages = [];
        let currentGroup = null;

        messageIds.forEach(msgId => {
            const msg = messages[msgId];

            if (!currentGroup || currentGroup.deviceId !== msg.deviceId) {
                // Nuovo utente, crea un nuovo gruppo
                if (currentGroup) {
                    groupedMessages.push(currentGroup);
                }
                currentGroup = {
                    deviceId: msg.deviceId,
                    name: msg.name,
                    texts: [msg.text],
                    ids: [msgId],
                    timestamp: msg.timestamp
                };
            } else {
                // Stesso utente, aggiungi il testo al gruppo
                currentGroup.texts.push(msg.text);
                currentGroup.ids.push(msgId);
            }
        });

        if (currentGroup) {
            groupedMessages.push(currentGroup);
        }

        // Visualizza i gruppi di messaggi con separatore
        let separatorAdded = false;
        let separatorElement = null;
        groupedMessages.forEach(group => {
            // Aggiungi il separatore prima del primo messaggio non letto
            if (!separatorAdded && group.timestamp > lastReadTimestamp) {
                const separatorEl = document.createElement('div');
                separatorEl.style.cssText = `
                    width: 100%;
                    height: 2px;
                    background: linear-gradient(to right, transparent, #667eea, transparent);
                    margin: 12px 0;
                    position: relative;
                `;
                const labelEl = document.createElement('div');
                labelEl.style.cssText = `
                    text-align: center;
                    font-size: 0.75rem;
                    color: #667eea;
                    margin-top: -10px;
                    margin-bottom: 12px;
                `;
                labelEl.textContent = 'Nuovi messaggi';
                messagesContainer.appendChild(separatorEl);
                messagesContainer.appendChild(labelEl);
                separatorElement = separatorEl;
                separatorAdded = true;
            }

            const isYou = group.deviceId === this.userId;
            const messageEl = document.createElement('div');
            messageEl.style.cssText = `
                display: flex;
                flex-direction: column;
                align-items: ${isYou ? 'flex-end' : 'flex-start'};
                gap: 4px;
            `;

            // Ogni persona ha il suo colore: si vede subito se scrive sempre la stessa.
            // Chi ha lasciato l'evento ("Non posso più") resta, ma in grigio
            const hasLeft = Array.isArray(participantIds) && !participantIds.includes(group.deviceId);
            const color = hasLeft ? { bg: '#e0e0e0', text: '#757575' } : this.getUserColor(group.deviceId);
            const bubbleEl = document.createElement('div');
            bubbleEl.style.cssText = `
                max-width: 70%;
                padding: 10px 14px;
                word-wrap: break-word;
                font-size: 0.95rem;
                white-space: pre-wrap;
                background: ${color.bg};
                color: ${color.text};
                border-radius: ${isYou ? '18px 18px 4px 18px' : '18px 18px 18px 4px'};
            `;
            if (this.isAdmin && chatId) {
                // Amministratore: ogni messaggio ha il suo cestino per cancellarlo
                group.texts.forEach((text, i) => {
                    const row = document.createElement('div');
                    row.style.cssText = 'display: flex; gap: 6px; align-items: flex-start; justify-content: space-between;';
                    const textEl = document.createElement('span');
                    textEl.textContent = text;
                    const delBtn = document.createElement('button');
                    delBtn.type = 'button';
                    delBtn.textContent = '🗑️';
                    delBtn.title = 'Cancella questo messaggio (amministratore)';
                    delBtn.style.cssText = 'background: none; border: none; cursor: pointer; padding: 0; font-size: 0.8rem; opacity: 0.7;';
                    delBtn.addEventListener('click', () => this.adminDeleteMessage(chatId, group.ids[i], text));
                    row.appendChild(textEl);
                    row.appendChild(delBtn);
                    bubbleEl.appendChild(row);
                });
            } else {
                bubbleEl.textContent = group.texts.join('\n');
            }

            const nameEl = document.createElement('div');
            nameEl.style.cssText = `font-size: 0.75rem; font-weight: 600; color: ${hasLeft ? '#9e9e9e' : color.bg}; ${isYou ? 'text-align: right;' : 'text-align: left;'}`;
            nameEl.textContent = (isYou ? `${group.name} (tu)` : group.name) + (hasLeft ? ' · non partecipa più' : '');

            messageEl.appendChild(nameEl);
            messageEl.appendChild(bubbleEl);
            messagesContainer.appendChild(messageEl);
        });

        // Scroll al fondo (non quando si ridisegna solo per i partecipanti)
        if (!scrollToBottom) return;
        setTimeout(() => {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
            // Assicurati che lo scroll avvenga anche se il container non è ancora renderizzato
            setTimeout(() => {
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            }, 50);
        }, 150);
    }

    markChatAsRead(eventId) {
        // Aggiorna il timestamp quando apri la chat
        const status = { lastReadTimestamp: Date.now() };
        this.readStatus[eventId] = status; // subito in memoria, prima della risposta di Firebase
        database.ref(`chatReadStatus/${this.userId}/${eventId}`).set(status)
            .catch(error => this.notifyWriteError('Segnare i messaggi come letti', error));
    }

    updateCalendarBadge(eventId) {
        // Trova il post-it nel calendario e aggiorna il badge
        const noteEl = document.querySelector(`[data-event-id="${eventId}"]`);
        if (noteEl) {
            this.updateNoteBadge(noteEl, eventId);
        }
    }

    updateChatInputVisibility(participants) {
        const isParticipant = participants && participants.includes(this.userId);
        const inputContainer = document.getElementById('chatInputContainer');
        if (inputContainer) {
            inputContainer.style.display = isParticipant ? 'flex' : 'none';
            if (!isParticipant) {
                // Rimuovi il vecchio messaggio se esiste
                const oldPlaceholder = inputContainer.parentElement.querySelector('.chat-not-participant-message');
                if (oldPlaceholder) {
                    oldPlaceholder.remove();
                }
                // Aggiungi il nuovo messaggio solo se non è partecipante
                const placeholder = document.createElement('div');
                placeholder.className = 'chat-not-participant-message';
                placeholder.style.cssText = 'text-align: center; color: #999; padding: 10px;';
                placeholder.textContent = 'Solo i partecipanti possono inviare messaggi';
                inputContainer.parentElement.appendChild(placeholder);
            } else {
                // Se è partecipante, rimuovi il messaggio
                const oldPlaceholder = inputContainer.parentElement.querySelector('.chat-not-participant-message');
                if (oldPlaceholder) {
                    oldPlaceholder.remove();
                }
            }
        }
    }

    async loadAndDisplayCreatorName(creatorId) {
        const el = document.getElementById('creatorNameDisplay');
        el.textContent = creatorId ? await this.resolveUserName(creatorId) : 'Sconosciuto';
    }

    closeEditModal() {
        this.clearFieldErrors(); // gli avvisi sui campi non restano per la prossima apertura
        // Marca la chat come letta quando chiudi il modal (dopo aver letto i messaggi)
        if (this.editingNote && this.getEditingEvent()) {
            this.markChatAsRead(this.editingNote.id);

            // Aggiorna i badge dopo aver marcato come letto
            setTimeout(() => {
                this.updateAllBadges();
            }, 100);
        }

        // Rimuovi il listener della chat (anche se l'evento è stato eliminato)
        if (this.chatListener && this.editingNote) {
            database.ref(`eventChats/${this.editingNote.id}/messages`).off('value', this.chatListener);
            this.chatListener = null;
        }

        // Pulisci i campi del form
        document.getElementById('editTitle').value = '';
        document.getElementById('editTime').value = '';
        document.getElementById('editLocation').value = '';
        document.getElementById('editNotes').value = '';
        document.getElementById('editLink').value = '';
        document.getElementById('chatMessageInput').value = '';
        document.getElementById('chatMessagesContainer').innerHTML = '';
        this.editParticipantsList = [];

        // Resetta i tab del modal di modifica
        const editModal = document.getElementById('editModal');
        editModal.querySelectorAll('.modal-tab').forEach(tab => tab.classList.remove('active'));
        editModal.querySelectorAll('.modal-tab-content').forEach(content => content.classList.remove('active'));
        // Attiva il primo tab
        editModal.querySelector('.modal-tab').classList.add('active');
        editModal.querySelector('.modal-tab-content').classList.add('active');

        document.getElementById('editModal').classList.remove('active');
        document.getElementById('editModal').style.display = 'none';
        this.closeModal(); // Chiudi anche il modal di aggiunta se aperto
        this.editingNote = null;
    }

    async sendChatMessage() {
        if (!this.editingNote) return;

        const messageText = document.getElementById('chatMessageInput').value.trim();
        if (!messageText) return;

        const eventId = this.editingNote.id;

        try {
            const messageRef = database.ref(`eventChats/${eventId}/messages`).push();
            const messageId = messageRef.key;

            await messageRef.set({
                deviceId: this.userId,
                name: this.userName,
                text: messageText,
                timestamp: new Date().getTime()
            });
            this.recordStat('messagesSent');

            // Pulisci l'input
            document.getElementById('chatMessageInput').value = '';
            // Il listener su Firebase carica i messaggi automaticamente
        } catch (error) {
            this.notifyWriteError('Invio del messaggio', error);
        }
    }

    // Campo Data del modal di modifica: si può spostare solo da domani in poi
    setEditDateField(dateKey) {
        const dateInput = document.getElementById('editDate');
        dateInput.value = dateKey;
        dateInput.min = this.getTomorrowKey();
    }

    async saveEditedNote() {
        const current = this.getEditingEvent();
        if (!current || !this.canEditEvent(current)) return;

        const title = document.getElementById('editTitle').value.trim();
        const dateKey = current.date;
        const newDateKey = document.getElementById('editDate').value || dateKey;
        const isMoving = newDateKey !== dateKey;

        // Controllo di tutti i campi (in modifica, un campo facoltativo sbagliato resta com'era)
        const required = [];
        const optional = [];
        if (!title) required.push({ id: 'editTitle', label: 'Nome evento', message: 'è vuoto: scrivi come si chiama l\'evento' });
        if (isMoving && !this.isFutureDateKey(newDateKey)) required.push({ id: 'editDate', label: 'Data', message: 'un evento si sposta solo da domani in poi' });
        const fee = this.checkFee(document.getElementById('editFee').value);
        if (fee.error) optional.push({ id: 'editFee', label: 'Quota', message: fee.error, without: 'cambiare la quota (resta quella di prima)' });
        const link = this.checkLink(document.getElementById('editLink').value);
        if (link.error) optional.push({
            id: 'editLink', anchor: 'editLinkInputContainer', label: 'Link', message: link.error, without: 'cambiare il link (resta quello di prima)',
            show: () => {
                document.getElementById('editLinkContainer').style.display = 'none';
                document.getElementById('editLinkInputContainer').style.display = 'flex';
            }
        });
        const pendingImage = this.pendingImageUrlProblem('editImageUrl', 'editImageUrlInputContainer', 'editImagePanel', 'cambiare l\'immagine');
        if (pendingImage) optional.push(pendingImage);
        if (!await this.checkFormFields(required, optional, 'salvare')) return;
        document.getElementById('editImageUrl').value = '';

        // Solo i campi del modal: partecipanti, immagine e creatore restano come sono su Firebase
        const fields = {
            title: title,
            time: document.getElementById('editTime').value.trim(),
            location: document.getElementById('editLocation').value.trim(),
            notes: document.getElementById('editNotes').value.trim(),
            fee: fee.error ? (current.fee || 0) : fee.value, // 0 = Gratis
            color: this.selectedColor,
            link: link.error ? (current.link || '') : link.value
        };
        if (isMoving) fields.date = newDateKey;

        this.updateEvent(current.id, fields);
        this.closeEditModal();
        const message = isMoving
            ? `Evento spostato a ${this.formatDateKey(newDateKey)}`
            : 'Evento modificato con successo!';
        setTimeout(() => this.showSuccessPopup(message), 100);
    }

    async deleteCurrentNote() {
        if (!this.editingNote || !this.canEditEvent(this.getEditingEvent())) return;

        const confirmed = await this.showConfirmDialog('Sei sicuro di voler eliminare questo evento?');
        if (!confirmed) return;

        // Chiudo prima il modal: chi elimina non deve vedere "l'evento è stato eliminato"
        const eventId = this.editingNote.id;
        this.closeEditModal();
        this.deleteNote(eventId).then(() => this.showSuccessPopup('Evento eliminato'));
    }

    // Eventi da fissare: proposte senza data, salvate in proposals/{id} (separate da events).
    //   proposals/{id}: {id, title, time, location, notes, color, creatorId, creatorName, createdAt,
    //                    dateOptions/{YYYY-MM-DD}: {addedBy, createdAt},
    //                    votes/{YYYY-MM-DD}/{voterKey}: {name, deviceId}}
    // Ogni scrittura tocca un solo percorso, così voti contemporanei non si sovrascrivono.
    // Chi ha votato può fissare una data: la proposta diventa un evento normale con lo stesso id.

    setupProposalListeners() {
        document.getElementById('proposalCreateForm').addEventListener('submit', (e) => this.createProposal(e));
        document.getElementById('proposalCreateCancelBtn').addEventListener('click', () => {
            if (this.editingProposalId) {
                const proposalId = this.editingProposalId;
                this.editingProposalId = null;
                this.proposalImageData = null;
                this.proposalImageRemoved = false;
                this.openProposalView(proposalId);
            } else {
                this.closeProposalModal();
            }
        });
        document.getElementById('proposalEditBtn').addEventListener('click', () => this.openProposalEdit());
        document.getElementById('proposalCloseBtn').addEventListener('click', () => this.closeProposalModal());
        document.getElementById('proposalAddDateBtn').addEventListener('click', () => this.addProposalDate());
        document.getElementById('proposalDeleteBtn').addEventListener('click', () => this.deleteProposal());

        // Schede Date / Chat
        document.querySelectorAll('.proposal-tab').forEach(tab => {
            tab.addEventListener('click', () => this.showProposalPane(tab.dataset.pane));
        });

        // Chat della proposta
        document.getElementById('proposalChatSendBtn').addEventListener('click', () => this.sendProposalChatMessage());
        document.getElementById('proposalChatInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.sendProposalChatMessage();
            }
        });

        const proposalModal = document.getElementById('proposalModal');
        proposalModal.addEventListener('click', (e) => {
            if (e.target === proposalModal) this.closeProposalModal();
        });
    }

    listenProposals() {
        database.ref('proposals').on('value', (snapshot) => {
            this.proposals = snapshot.val() || {};
            this.proposalsLoaded = true;
            this.renderProposals();
            this.scheduleNotificationCheck();

            if (this.openProposalId) {
                if (this.proposals[this.openProposalId] && this.proposals[this.openProposalId].id) {
                    // Durante la modifica non si ridisegna il dettaglio (sovrascriverebbe il form)
                    if (!this.editingProposalId) this.renderProposalView();
                } else {
                    // Fissata o eliminata da un altro utente mentre era aperta
                    this.closeProposalModal();
                    this.showSuccessPopup('Questa proposta è stata fissata o eliminata');
                }
            }
        });
    }

    // Identifica l'account: lo stesso utente su più dispositivi vota una volta sola
    getVoterKey() {
        return this.userId;
    }

    isFutureDateKey(dateKey) {
        return dateKey > this.getDateKey(new Date()); // YYYY-MM-DD si confronta come stringa
    }

    getTomorrowKey() {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        return this.getDateKey(tomorrow);
    }

    formatDateKey(dateKey, short = false) {
        const [year, month, day] = dateKey.split('-').map(Number);
        const options = short
            ? { weekday: 'short', day: 'numeric', month: 'short' }
            : { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
        const text = new Date(year, month - 1, day).toLocaleDateString('it-IT', options);
        return text.charAt(0).toUpperCase() + text.slice(1);
    }

    // Date proposte in ordine cronologico, con i votanti
    // Opzione proposta: chiave "YYYY-MM-DD" (solo data) o "YYYY-MM-DD_HHMM" (data e ora).
    // La chiave identifica l'opzione sia in dateOptions sia in votes.
    proposalOptionKey(date, time) {
        return time ? `${date}_${time.replace(':', '')}` : date;
    }

    parseProposalOptionKey(key) {
        const date = key.slice(0, 10);
        const time = key.length >= 15 ? `${key.slice(11, 13)}:${key.slice(13, 15)}` : '';
        return { date, time };
    }

    formatProposalOption(key, short = false) {
        const { date, time } = this.parseProposalOptionKey(key);
        return this.formatDateKey(date, short) + (time ? ` · 🕐 ${time}` : '');
    }

    getProposalOptions(proposal) {
        const votes = proposal.votes || {};
        return Object.keys(proposal.dateOptions || {}).sort().map(key => {
            const { date, time } = this.parseProposalOptionKey(key);
            const voters = Object.entries(votes[key] || {}).map(([voterKey, vote]) => ({ key: voterKey, ...vote }));
            return { key, date, time, voters, count: voters.length, isFuture: this.isFutureDateKey(date) };
        });
    }

    // Data futura con più voti (a parità, la più vicina)
    getBestProposalOption(proposal) {
        let best = null;
        this.getProposalOptions(proposal).forEach(option => {
            if (option.isFuture && option.count > 0 && (!best || option.count > best.count)) {
                best = option;
            }
        });
        return best;
    }

    // Date più votate, con i pari merito: solo date future con almeno un voto
    getTopProposalOptions(proposal) {
        const future = this.getProposalOptions(proposal).filter(option => option.isFuture && option.count > 0);
        const max = Math.max(0, ...future.map(option => option.count));
        return future.filter(option => option.count === max && max > 0);
    }

    // Date che il creatore può fissare:
    // - si parte dalle più votate (pari merito compresi);
    // - se il creatore ne ha votata qualcuna, solo quelle che ha votato;
    // - se non ne ha votata nessuna, tutte le più votate.
    getFixableProposalOptions(proposal) {
        const top = this.getTopProposalOptions(proposal);
        const withCreator = top.filter(option => option.voters.some(v => v.key === proposal.creatorId));
        return withCreator.length > 0 ? withCreator : top;
    }

    hasVotedProposal(proposal) {
        const voterKey = this.getVoterKey();
        return Object.values(proposal.votes || {}).some(dateVotes => dateVotes && dateVotes[voterKey]);
    }

    isProposalCreator(proposal) {
        return proposal.creatorId === this.userId;
    }

    renderProposals() {
        const proposals = Object.values(this.proposals || {})
            .filter(p => p && p.id && this.isColorVisible(p.color))
            .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

        ['proposalsBanner', 'proposalsSection'].forEach(containerId => {
            const container = document.getElementById(containerId);
            if (container) this.fillProposalsContainer(container, proposals);
        });
    }

    fillProposalsContainer(container, proposals) {
        container.innerHTML = '';

        const box = document.createElement('div');
        box.style.cssText = 'background: #f3f0ff; border: 2px dashed #667eea; border-radius: 12px; padding: 12px;';

        const header = document.createElement('div');
        header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;';
        const label = document.createElement('strong');
        label.style.color = '#667eea';
        label.textContent = `🗳️ Da fissare (${proposals.length})`;
        const newBtn = document.createElement('button');
        newBtn.type = 'button';
        newBtn.style.cssText = 'padding: 8px 12px; background: #667eea; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;';
        newBtn.textContent = '➕ Evento senza data';
        newBtn.addEventListener('click', () => this.openProposalCreate());
        header.appendChild(label);
        header.appendChild(newBtn);
        box.appendChild(header);

        proposals.forEach(proposal => {
            const best = this.getBestProposalOption(proposal);
            const optionsCount = Object.keys(proposal.dateOptions || {}).length;
            const voted = this.hasVotedProposal(proposal);

            let summary = 'Nessuna data proposta';
            const tied = this.getTopProposalOptions(proposal).length;
            if (best && tied > 1) {
                summary = `⭐ ${tied} date a pari merito · ${best.count} ${best.count === 1 ? 'voto' : 'voti'}`;
            } else if (best) {
                summary = `⭐ ${this.formatProposalOption(best.key, true)} · ${best.count} ${best.count === 1 ? 'voto' : 'voti'}`;
            } else if (optionsCount > 0) {
                summary = 'Nessun voto ancora';
            }
            if (optionsCount > 0) {
                summary += ` · ${optionsCount} ${optionsCount === 1 ? 'data' : 'date'}`;
            }

            const categoryColors = {
                'color-neutral': '#764ba2', 'color-yellow': '#ffd54f', 'color-pink': '#ff6b9d', 'color-green': '#81c784',
                'color-blue': '#64b5f6', 'color-purple': '#26a69a', 'color-teal': '#b71c1c', 'color-orange': '#ffb74d'
            };
            const card = document.createElement('div');
            card.style.cssText = `margin-top: 10px; padding: 10px 12px; background: white; border: 3px solid ${categoryColors[proposal.color] || '#999'}; border-radius: 8px; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.1);`;
            card.setAttribute('data-proposal-id', proposal.id);
            card.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
                    <span style="font-weight: 600; color: #333;">${this.escapeHtml(proposal.title)}</span>
                    <span class="proposal-badge" style="display: none; background: #f44336; color: white; border-radius: 10px; padding: 2px 8px; font-size: 0.75rem; font-weight: bold; white-space: nowrap;"></span>
                </div>
                <div style="font-size: 0.85rem; color: #666; margin-top: 2px;">${this.escapeHtml(summary)}${voted ? ' · <span style="color: #4CAF50;">✓ hai votato</span>' : ''}</div>
            `;
            card.addEventListener('click', () => this.openProposalView(proposal.id));
            box.appendChild(card);
        });

        container.appendChild(box);
        this.updateProposalBadges();
    }

    showProposalModal() {
        const modal = document.getElementById('proposalModal');
        modal.classList.add('active');
        modal.style.display = 'flex';
    }

    closeProposalChat() {
        if (this.proposalChatRef) {
            this.proposalChatRef.off('value', this.proposalChatListener);
            this.proposalChatRef = null;
            this.proposalChatListener = null;
        }
    }

    closeProposalModal() {
        this.clearFieldErrors(); // gli avvisi sui campi non restano per la prossima apertura
        const modal = document.getElementById('proposalModal');
        modal.classList.remove('active');
        modal.style.display = 'none';
        this.editingProposalId = null;

        // Chiude la chat: se è stata aperta, i messaggi contano come letti
        if (this.proposalChatRef) {
            this.proposalChatRef.off('value', this.proposalChatListener);
            this.proposalChatRef = null;
            this.proposalChatListener = null;
        }
        if (this.openProposalId && this.proposalChatSeen) {
            this.markChatAsRead(this.openProposalId);
            setTimeout(() => this.updateProposalBadges(), 300);
        }
        this.proposalChatSeen = false;
        document.getElementById('proposalChatInput').value = '';
        document.getElementById('proposalChatMessages').innerHTML = '';

        this.openProposalId = null;
    }

    showProposalPane(paneId) {
        ['proposalDatesPane', 'proposalChatPane'].forEach(id => {
            document.getElementById(id).style.display = id === paneId ? 'block' : 'none';
        });
        document.querySelectorAll('.proposal-tab').forEach(tab => {
            const active = tab.dataset.pane === paneId;
            tab.style.background = active ? 'rgba(255, 255, 255, 0.95)' : 'rgba(255, 255, 255, 0.4)';
            tab.style.color = active ? '#667eea' : '#333';
        });

        if (paneId === 'proposalChatPane') {
            this.proposalChatSeen = true;
            const messagesContainer = document.getElementById('proposalChatMessages');
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
            document.getElementById('proposalChatInput').focus();
        }
    }

    // Stessa chat degli eventi (eventChats/{id}): quando la data viene fissata, l'evento ha lo stesso id
    listenProposalChat(proposalId) {
        const messagesContainer = document.getElementById('proposalChatMessages');
        messagesContainer.innerHTML = '';

        if (this.proposalChatRef) {
            this.proposalChatRef.off('value', this.proposalChatListener);
        }
        this.proposalChatRef =database.ref(`eventChats/${proposalId}/messages`);
        this.proposalChatListener = this.proposalChatRef.on('value', (snapshot) => {
            if (this.openProposalId !== proposalId) return;

            const count = snapshot.exists() ? Object.keys(snapshot.val()).length : 0;
            document.getElementById('proposalChatTabBtn').textContent = count > 0 ? `💬 Chat (${count})` : '💬 Chat';

            if (!snapshot.exists()) {
                messagesContainer.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">Nessun messaggio ancora. Scrivi quando puoi esserci!</div>';
                return;
            }

            if (this.openProposalId !== proposalId) return;
            messagesContainer.innerHTML = '';
            this.renderChatInto(messagesContainer, snapshot.val(), this.getLastRead(proposalId), null, true, proposalId);
        });
    }

    async sendProposalChatMessage() {
        const proposalId = this.openProposalId;
        if (!proposalId || !this.proposals[proposalId]) return;

        const input = document.getElementById('proposalChatInput');
        const text = input.value.trim();
        if (!text) return;

        try {
            await database.ref(`eventChats/${proposalId}/messages`).push().set({
                deviceId: this.userId,
                name: this.userName,
                text: text,
                timestamp: new Date().getTime()
            });
            this.recordStat('messagesSent');
            input.value = '';
        } catch (error) {
            this.notifyWriteError('Invio del messaggio', error);
        }
    }

    // Badge dei messaggi non letti sulle card "Da fissare" (solo per chi ha votato o creato la proposta)
    updateProposalBadges() {
        document.querySelectorAll('[data-proposal-id]').forEach(card => {
            const proposal = this.proposals[card.getAttribute('data-proposal-id')];
            const badge = card.querySelector('.proposal-badge');
            if (!badge) return;
            if (!proposal || !(this.hasVotedProposal(proposal) || this.isProposalCreator(proposal))) {
                badge.style.display = 'none';
                return;
            }
            this.getUnreadMessageCount(proposal.id).then(count => {
                badge.textContent = `💬 ${count}`;
                badge.style.display = count > 0 ? 'inline-block' : 'none';
            });
        });
    }

    openProposalCreate() {
        this.openProposalId = null;
        this.editingProposalId = null;
        this.proposalImageRemoved = false;
        document.getElementById('proposalFirstDateSection').style.display = 'block';
        document.getElementById('proposalSubmitBtn').textContent = 'Crea proposta';
        document.getElementById('proposalImageToggleBtn').textContent = '✏️ Aggiungi immagine';
        document.getElementById('proposalCreateForm').reset(); // svuota i campi e torna a "Senza categoria"
        document.getElementById('proposalFirstDate').min = this.getTomorrowKey();
        this.setFeeInput('proposal', 0);
        this.renderProposalLink('');
        this.proposalImageData = null;
        this.setProposalCover(null);
        this.closeProposalImagePanel();
        document.getElementById('proposalImage').value = '';
        document.getElementById('proposalImageTools').style.display = 'block';
        this.updateCategoryDisplay('proposalCategorySelect');
        this.closeCategorySelects();
        document.getElementById('proposalModalTitle').textContent = '🗳️ Nuovo evento senza data';
        document.getElementById('proposalCreateForm').style.display = 'block';
        document.getElementById('proposalViewSection').style.display = 'none';
        this.showProposalModal();
        document.getElementById('proposalTitle').focus();
    }

    // Modifica della proposta: solo chi l'ha creata. Stesso form della creazione, senza data/ora:
    // le date si propongono e si votano dal dettaglio
    openProposalEdit() {
        const proposal = this.proposals[this.openProposalId];
        if (!proposal || !this.canManageProposal(proposal)) return;
        const proposalId = proposal.id;

        this.closeProposalChat();
        this.editingProposalId = proposalId;
        this.proposalImageData = null;
        this.proposalImageRemoved = false;

        const form = document.getElementById('proposalCreateForm');
        form.reset();
        document.getElementById('proposalTitle').value = proposal.title || '';
        document.getElementById('proposalLocation').value = proposal.location || '';
        document.getElementById('proposalNotes').value = proposal.notes || '';
        this.setFeeInput('proposal', proposal.fee);
        this.renderProposalLink(proposal.link || '');
        const colorRadio = document.querySelector(`input[name="proposalColor"][data-color="${proposal.color || 'color-neutral'}"]`);
        if (colorRadio) colorRadio.checked = true;
        this.updateCategoryDisplay('proposalCategorySelect');
        this.closeCategorySelects();

        document.getElementById('proposalFirstDateSection').style.display = 'none';
        document.getElementById('proposalSubmitBtn').textContent = 'Salva';
        document.getElementById('proposalImageToggleBtn').textContent = '✏️ Modifica immagine';
        document.getElementById('proposalImageTools').style.display = 'block';
        this.closeProposalImagePanel();
        document.getElementById('proposalImage').value = '';
        document.getElementById('proposalModalTitle').textContent = '✏️ Modifica proposta';
        form.style.display = 'block';
        document.getElementById('proposalViewSection').style.display = 'none';
        // La copertina resta quella attuale finché non si cambia
        this.setProposalCover(null);
        if (proposal.imageVersion) {
            this.getEventImage(proposal).then(image => {
                if (this.editingProposalId === proposalId && !this.proposalImageData && !this.proposalImageRemoved) this.setProposalCover(image);
            });
        }
        document.getElementById('proposalTitle').focus();
    }

    saveProposalEdit(title, fee, color, link) {
        const proposalId = this.editingProposalId;
        const proposal = this.proposals[proposalId];
        if (!proposal || !this.canManageProposal(proposal)) return;

        // Solo i campi del form: date, voti e creatore non si toccano
        const fields = {
            title: title,
            location: document.getElementById('proposalLocation').value.trim(),
            notes: document.getElementById('proposalNotes').value.trim(),
            fee: fee,
            link: link !== undefined ? link : (this.currentProposalLink || ''),
            color: color
        };

        let imageSaved = Promise.resolve();
        if (this.proposalImageData) {
            fields.imageVersion = Date.now();
            imageSaved = this.saveEventImage(proposalId, this.proposalImageData, fields.imageVersion);
        } else if (this.proposalImageRemoved) {
            fields.imageVersion = null;
            imageSaved = this.saveEventImage(proposalId, null);
        }

        imageSaved
            .then(() => database.ref(`proposals/${proposalId}`).update(fields))
            .then(() => {
                this.editingProposalId = null;
                this.proposalImageData = null;
                this.proposalImageRemoved = false;
                this.openProposalView(proposalId);
                this.showSuccessPopup('Proposta modificata');
            })
            .catch(error => {
                this.notifyWriteError('Salvataggio della proposta', error);
            });
    }

    async createProposal(e) {
        e.preventDefault();
        const title = document.getElementById('proposalTitle').value.trim();
        const editing = this.proposals[this.editingProposalId] || null;

        // Controllo di tutti i campi
        const required = [];
        const optional = [];
        if (!title) required.push({ id: 'proposalTitle', label: 'Nome evento', message: 'è vuoto: scrivi come si chiama l\'evento' });
        const fee = this.checkFee(document.getElementById('proposalFee').value);
        if (fee.error) optional.push({ id: 'proposalFee', label: 'Quota', message: fee.error,
            without: editing ? 'cambiare la quota (resta quella di prima)' : 'quota (sarà Gratis)' });
        const linkTyping = document.getElementById('proposalLinkInputContainer').style.display === 'flex';
        const link = this.checkLink(linkTyping ? document.getElementById('proposalLink').value : this.currentProposalLink);
        if (link.error) optional.push({
            id: 'proposalLink', anchor: 'proposalLinkInputContainer', label: 'Link', message: link.error,
            without: editing ? 'cambiare il link (resta quello di prima)' : 'link',
            show: () => {
                document.getElementById('proposalLinkContainer').style.display = 'none';
                document.getElementById('proposalLinkInputContainer').style.display = 'flex';
            }
        });
        let firstDate = editing ? '' : document.getElementById('proposalFirstDate').value;
        if (firstDate && !this.isFutureDateKey(firstDate)) {
            optional.push({ id: 'proposalFirstDate', label: 'Prima data', message: 'si possono proporre date solo da domani in poi',
                without: 'la prima data (si può proporre dopo)' });
        }
        const pendingImage = this.pendingImageUrlProblem('proposalImageUrl', 'proposalImageUrlInputContainer', 'proposalImagePanel',
            editing ? 'cambiare l\'immagine' : 'l\'immagine di quell\'indirizzo');
        if (pendingImage) optional.push(pendingImage);
        if (!await this.checkFormFields(required, optional, editing ? 'salvare' : 'creare la proposta')) return;
        document.getElementById('proposalImageUrl').value = '';
        if (firstDate && !this.isFutureDateKey(firstDate)) firstDate = '';

        if (this.editingProposalId) {
            const editColor = document.querySelector('input[name="proposalColor"]:checked');
            this.saveProposalEdit(title, fee.error ? (editing && editing.fee) || 0 : fee.value,
                editColor ? editColor.dataset.color : 'color-neutral',
                link.error ? (editing && editing.link) || '' : link.value);
            return;
        }

        const checkedColor = document.querySelector('input[name="proposalColor"]:checked');

        const id = 'evt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const proposal = {
            id: id,
            title: title,
            time: firstDate ? '' : document.getElementById('proposalTime').value.trim(),
            location: document.getElementById('proposalLocation').value.trim(),
            notes: document.getElementById('proposalNotes').value.trim(),
            fee: fee.error ? 0 : fee.value,
            link: link.error ? '' : link.value,
            color: checkedColor ? checkedColor.dataset.color : 'color-neutral',
            creatorId: this.userId,
            creatorName: (this.userName || '').slice(0, 10), // regola: al massimo 10 caratteri (i nomi vecchi possono essere più lunghi)
            createdAt: Date.now()
        };
        // Chi crea non vota in automatico: magari non può esserci
        if (firstDate) {
            const firstKey = this.proposalOptionKey(firstDate, document.getElementById('proposalTime').value);
            proposal.dateOptions = { [firstKey]: { addedBy: this.userName || '', addedById: this.userId, createdAt: Date.now() } };
        }

        const image = this.proposalImageData;
        if (image) proposal.imageVersion = Date.now();
        const imageSaved = image ? this.saveEventImage(id, image, proposal.imageVersion) : Promise.resolve();

        imageSaved
            .then(() => database.ref(`proposals/${id}`).set(proposal))
            .then(() => {
                this.recordStat('proposalsCreated');
                this.proposalImageData = null;
                this.openProposalView(id);
                this.showSuccessPopup('Proposta creata! Ora tutti possono votare le date.');
            })
            .catch(error => {
                this.notifyWriteError('Creazione della proposta', error);
            });
    }

    openProposalView(proposalId) {
        if (!this.proposals[proposalId]) return;
        this.openProposalId = proposalId;
        document.getElementById('proposalImageTools').style.display = 'none';
        document.getElementById('proposalCreateForm').style.display = 'none';
        document.getElementById('proposalViewSection').style.display = 'block';
        const newDateInput = document.getElementById('proposalNewDate');
        newDateInput.value = '';
        newDateInput.min = this.getTomorrowKey();
        document.getElementById('proposalNewTime').value = '';
        this.proposalChatSeen = false;
        this.showProposalPane('proposalDatesPane');
        this.listenProposalChat(proposalId);
        this.renderProposalView();
        this.showProposalModal();
    }

    renderProposalView() {
        const proposal = this.proposals[this.openProposalId];
        if (!proposal) return;
        this.applyCategoryTheme('proposalModal', proposal.color);

        document.getElementById('proposalModalTitle').textContent = `🗳️ ${proposal.title}`;
        this.setProposalCover(null);
        if (proposal.imageVersion) {
            this.getEventImage(proposal).then(image => {
                if (this.openProposalId === proposal.id) this.setProposalCover(image);
            });
        }

        const details = [];
        if (proposal.time) details.push(`🕐 ${this.escapeHtml(proposal.time)}`);
        if (proposal.location) details.push(`📍 ${this.escapeHtml(proposal.location)}`);
        details.push(`💶 ${this.formatFee(proposal.fee)}`);
        const proposalUrl = this.safeLink(proposal.link);
        if (proposalUrl) {
            details.push(`🌐 <a href="${this.escapeHtml(proposalUrl)}" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: underline;">Vai sul sito</a>`);
        }
        if (proposal.notes) details.push(`📝 ${this.escapeHtml(proposal.notes).replace(/\n/g, '<br>')}`);
        details.push(`👤 Proposta da: ${this.escapeHtml(proposal.creatorName || 'Anonimo')}`);
        document.getElementById('proposalDetails').innerHTML = details.map(d => `<div style="margin-bottom: 4px;">${d}</div>`).join('');

        const isCreator = this.canManageProposal(proposal);
        document.getElementById('proposalDeleteBtn').style.display = isCreator ? 'block' : 'none';
        document.getElementById('proposalEditBtn').style.display = isCreator ? 'block' : 'none';

        const listEl = document.getElementById('proposalOptionsList');
        listEl.innerHTML = '';

        const options = this.getProposalOptions(proposal);
        if (options.length === 0) {
            listEl.innerHTML = '<div style="background: rgba(255,255,255,0.15); border-radius: 8px; padding: 12px; text-align: center;">Ancora nessuna data: proponine una qui sotto 👇</div>';
            return;
        }

        const topKeys = this.getTopProposalOptions(proposal).map(option => option.key);
        const fixableKeys = this.getFixableProposalOptions(proposal).map(option => option.key);
        const voterKey = this.getVoterKey();
        // "Fissa questa data": solo per il creatore e solo sulle date ammesse (vedi getFixableProposalOptions)
        const canFix = this.canManageProposal(proposal) && !proposal.fixedDate;

        options.forEach(option => {
            const isBest = topKeys.includes(option.key); // ⭐ su tutte le più votate (pari merito compresi)
            const mine = option.voters.some(v => v.key === voterKey);

            const row = document.createElement('div');
            row.style.cssText = `background: white; color: #333; border-radius: 8px; padding: 10px 12px; ${isBest ? 'border: 2px solid #4CAF50;' : 'border: 2px solid transparent;'} ${option.isFuture ? '' : 'opacity: 0.6;'}`;

            const names = option.voters.map(v => this.escapeHtml(v.name || 'Anonimo')).join(', ');
            row.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
                    <strong>${this.escapeHtml(this.formatProposalOption(option.key))}</strong>
                    <span style="white-space: nowrap; font-weight: 600;">👍 ${option.count}</span>
                </div>
                ${isBest ? '<div style="font-size: 0.8rem; color: #4CAF50; font-weight: 600;">⭐ La più votata</div>' : ''}
                <div style="font-size: 0.8rem; color: #888; margin-top: 2px;">${names || 'Nessun voto'}</div>
                <div class="proposal-option-actions" style="display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap;"></div>
            `;

            const actions = row.querySelector('.proposal-option-actions');
            if (!option.isFuture) {
                actions.innerHTML = '<span style="font-size: 0.85rem; color: #999;">⏳ Data passata</span>';
            } else {
                const voteBtn = document.createElement('button');
                voteBtn.type = 'button';
                voteBtn.style.cssText = `flex: 1; padding: 8px; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; ${mine ? 'background: #e8f5e9; color: #2e7d32;' : 'background: #667eea; color: white;'}`;
                voteBtn.textContent = mine ? '✓ Ci sono (togli)' : '👍 Ci sono';
                voteBtn.addEventListener('click', () => this.toggleProposalVote(option.key, mine));
                actions.appendChild(voteBtn);

                if (canFix && fixableKeys.includes(option.key)) {
                    const fixBtn = document.createElement('button');
                    fixBtn.type = 'button';
                    fixBtn.style.cssText = 'flex: 1; padding: 8px; background: #4CAF50; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;';
                    fixBtn.textContent = '📅 Fissa questa data';
                    fixBtn.addEventListener('click', () => this.fixProposalDate(option.key));
                    actions.appendChild(fixBtn);
                }
            }

            listEl.appendChild(row);
        });
    }

    toggleProposalVote(optionKey, alreadyVoted) {
        const proposalId = this.openProposalId;
        if (!proposalId || !this.isFutureDateKey(this.parseProposalOptionKey(optionKey).date)) return;

        const ref = database.ref(`proposals/${proposalId}/votes/${optionKey}/${this.getVoterKey()}`);
        const write = alreadyVoted
            ? ref.remove()
            : ref.set({ name: this.userName, deviceId: this.userId });
        write.catch(error => {
            this.notifyWriteError('Voto', error);
        });
    }

    addProposalDate() {
        const proposalId = this.openProposalId;
        const proposal = this.proposals[proposalId];
        if (!proposal) return;

        const input = document.getElementById('proposalNewDate');
        const timeInput = document.getElementById('proposalNewTime');
        const dateKey = input.value;
        const optionKey = this.proposalOptionKey(dateKey, timeInput.value);
        if (!dateKey) {
            this.showErrorPopup('Scegli una data');
            return;
        }
        if (!this.isFutureDateKey(dateKey)) {
            this.showErrorPopup('Puoi proporre date solo da domani in poi');
            return;
        }
        if (proposal.dateOptions && proposal.dateOptions[optionKey]) {
            this.showErrorPopup('Questa data (e ora) è già stata proposta: votala dalla lista');
            return;
        }

        // Chi propone una data la vota anche (può sempre togliere il voto)
        database.ref(`proposals/${proposalId}`).update({
            [`dateOptions/${optionKey}`]: { addedBy: this.userName || '', addedById: this.userId, createdAt: Date.now() },
            [`votes/${optionKey}/${this.getVoterKey()}`]: { name: this.userName, deviceId: this.userId }
        }).then(() => {
            input.value = '';
            timeInput.value = '';
        }).catch(error => {
            this.notifyWriteError('Proposta della data', error);
        });
    }

    async fixProposalDate(optionKey) {
        const proposalId = this.openProposalId;
        const proposal = this.proposals[proposalId];
        if (!proposal || !this.canManageProposal(proposal)) return;
        if (!this.getFixableProposalOptions(proposal).some(option => option.key === optionKey)) {
            this.showErrorPopup('Si può fissare solo una delle date più votate (tra quelle votate da chi ha creato la proposta, se ce ne sono)');
            return;
        }
        const { date: dateKey, time: optionTime } = this.parseProposalOptionKey(optionKey);
        if (!this.isFutureDateKey(dateKey)) {
            this.showErrorPopup('Puoi fissare solo date da domani in poi');
            return;
        }

        const confirmed = await this.showConfirmDialog(
            `Fissare "${proposal.title}" per ${this.formatProposalOption(optionKey)}? ` +
            `L'evento andrà nel calendario e chi ha votato questa data diventerà partecipante.`,
            '📅 Fissa', '#4CAF50'
        );
        if (!confirmed) return;

        const proposalRef = database.ref(`proposals/${proposalId}`);
        try {
            // 1. Blocca la proposta: se due persone fissano insieme, passa solo la prima
            const lock = await proposalRef.child('fixedDate').transaction(current => current ? undefined : optionKey);
            if (!lock.committed) {
                this.showErrorPopup('Qualcun altro ha appena fissato questa proposta');
                return;
            }

            const fresh = (await proposalRef.once('value')).val() || proposal;
            const voters = Object.values((fresh.votes || {})[optionKey] || {});
            const participants = {};
            voters.forEach(v => { if (v.deviceId) participants[v.deviceId] = true; });

            const event = {
                id: proposalId, // Stesso id: chat e immagine restano collegate
                date: dateKey,
                title: fresh.title || proposal.title,
                time: optionTime || fresh.time || '', // L'ora dell'opzione votata, altrimenti quella generale
                location: fresh.location || '',
                notes: fresh.notes || '',
                fee: fresh.fee || 0,
                color: fresh.color || 'color-neutral',
                link: fresh.link || '',
                imageVersion: fresh.imageVersion || null, // Stesso id: eventImages/{id} resta collegata
                participants: participants,
                creatorId: fresh.creatorId || this.userId,
                createdAt: Date.now()
            };

            // 2. Crea l'evento (solo se non esiste già)
            this.closeProposalModal();
            await database.ref(`events/${proposalId}`).transaction(current => current ? undefined : event);

            // 3. La proposta non serve più
            await proposalRef.remove();
            this.showSuccessPopup(`Data fissata! L'evento è nel calendario per ${this.formatProposalOption(optionKey)}.`);
        } catch (error) {
            this.notifyWriteError('Fissare la data', error);
            proposalRef.child('fixedDate').remove().catch(() => {});
        }
    }

    async deleteProposal() {
        const proposalId = this.openProposalId;
        const proposal = this.proposals[proposalId];
        if (!proposal || !this.canManageProposal(proposal)) return;

        const confirmed = await this.showConfirmDialog(`Eliminare la proposta "${proposal.title}"?`);
        if (!confirmed) return;

        this.closeProposalModal();
        // Proposta, chat, immagine e letture in un'unica scrittura: le regole permettono di cancellare
        // una chat solo insieme alla sua proposta (o al suo evento)
        database.ref().update({
            [`proposals/${proposalId}`]: null,
            [`eventChats/${proposalId}`]: null,
            [`eventImages/${proposalId}`]: null,
            [`chatReadStatus/${this.userId}/${proposalId}`]: null
        })
            .then(() => this.showSuccessPopup('Proposta eliminata'))
            .catch(error => {
                this.notifyWriteError('Eliminazione della proposta', error);
            });
    }
}

// Inizializza il calendario
let bacheaInstance = null;
document.addEventListener('DOMContentLoaded', () => {
    if (startupError) {
        showStartupError(startupError);
        return;
    }
    bacheaInstance = new BacheaCalendar();
});
