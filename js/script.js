// Version check - Auto-update quando env o versione cambia
let APP_FILE_VERSION = 'unknown';
fetch('./descrizioni/versione')
    .then(r => r.text())
    .then(text => {
        APP_FILE_VERSION = text.trim();
        const APP_VERSION = `${APP_CONFIG.ENV}-${APP_FILE_VERSION}`;
        const STORED_VERSION = localStorage.getItem('APP_VERSION');
        if (STORED_VERSION && STORED_VERSION !== APP_VERSION) {
            console.log(`🔄 Versione app cambiata (${STORED_VERSION} → ${APP_VERSION}), ricaricare...`);
            if ('caches' in window) {
                caches.keys().then(names => {
                    names.forEach(name => caches.delete(name));
                });
            }
            localStorage.setItem('APP_VERSION', APP_VERSION);
            location.reload(true);
        }
        localStorage.setItem('APP_VERSION', APP_VERSION);
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
        if (testBadge) testBadge.style.display = 'inline-block';
    }, 100);
}

class BacheaCalendar {
    constructor() {
        this.currentDate = new Date();
        this.selectedDate = null;
        this.selectedColor = 'color-yellow';
        this.events = {}; // events/{id} da Firebase: id -> evento (con il campo date)
        this.notes = {}; // Indice derivato da this.events: data -> [eventi ordinati per orario]
        this.editingNote = null; // Evento aperto nel modal di modifica: {id, dateKey}
        this.isListView = false; // Toggle tra calendario e lista
        this.visibleColors = this.loadColorFilters(); // Colori visibili
        this.eventImageData = null;
        this.editImageData = null;
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

    showSuccessPopup(message) {
        const popup = document.getElementById('customPopup');
        const icon = document.getElementById('popupIcon');
        const messageEl = document.getElementById('popupMessage');
        icon.textContent = '✅';
        messageEl.textContent = message;
        popup.style.display = 'flex';
    }

    showErrorPopup(message) {
        const popup = document.getElementById('customPopup');
        const icon = document.getElementById('popupIcon');
        const messageEl = document.getElementById('popupMessage');
        icon.textContent = '❌';
        messageEl.textContent = message;
        popup.style.display = 'flex';
    }

    showConfirmDialog(message, okLabel = 'Elimina', okColor = '#f44336') {
        return new Promise((resolve) => {
            const modal = document.getElementById('confirmModal');
            const messageEl = document.getElementById('confirmMessage');
            const cancelBtn = document.getElementById('confirmCancelBtn');
            const okBtn = document.getElementById('confirmOkBtn');

            messageEl.textContent = message;
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
    // users/{uid}: {username, name, createdAt, lastSeen}

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
            'auth/requires-recent-login': 'Per sicurezza esci, rientra e riprova'
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

        if (user) {
            await this.loadUserProfile(user);
        } else {
            await this.promptForLogin();
        }

        // Se la sessione finisce (logout da un'altra scheda) ricarico: torna la schermata di login
        auth.onAuthStateChanged(u => {
            if (!u && this.userId) location.reload();
        });
    }

    async loadUserProfile(user) {
        this.userId = user.uid;
        const snapshot = await database.ref(`users/${user.uid}`).once('value');
        const profile = snapshot.val();

        if (profile && profile.username) {
            this.username = profile.username;
            this.userName = profile.name || profile.username;
        } else {
            // Account senza profilo (registrazione interrotta): lo ricreo dallo username
            this.username = (user.email || '').split('@')[0];
            this.userName = this.username;
            await database.ref(`users/${user.uid}`).set({
                username: this.username,
                name: this.userName,
                createdAt: Date.now(),
                lastSeen: Date.now()
            });
        }
        this.userNames[this.userId] = this.userName;
    }

    promptForLogin() {
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
                        name: name || username,
                        createdAt: Date.now(),
                        lastSeen: Date.now()
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

    updateLastSeen() {
        if (this.userId) {
            database.ref(`users/${this.userId}/lastSeen`).set(Date.now()).catch(() => {});
        }
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
        const editNameBtn = document.getElementById('editNameBtn');
        if (editNameBtn) {
            editNameBtn.textContent = '👤 Cambia il tuo nome';
        }
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
                console.error('Errore cambio nome:', error);
                this.showErrorPopup('Errore nel salvataggio del nome');
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
        this.detectDevice();
        this.loadVersion();
        this.loadTitle();
        this.displayWelcomeMessage();
        this.updateEditNameButtonText();
        // Aggiorna lastSeen ogni minuto
        setInterval(() => this.updateLastSeen(), 60000);
        // Eventi e nomi degli utenti PRIMA di renderizzare
        Promise.all([this.loadEvents(), this.loadUserNames()]).then(() => {
            this.cleanupPastEvents();
            this.render();
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

        // Ascolta il cambio di orientamento (più affidabile di resize su mobile)
        window.addEventListener('orientationchange', () => {
            // Aspetta che il layout si aggiorni
            setTimeout(() => {
                const nowMobile = window.innerWidth < 768;
                if (nowMobile !== this.isListView) {
                    // Se il dispositivo cambia (es: rotazione dello schermo), cambia vista
                    this.toggleView();
                }
            }, 100);
        });
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
        const changeModalBtn = document.getElementById('changeModalBtn');

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

        if (changeModalBtn) {
            changeModalBtn.addEventListener('click', () => {
                this.toggleView();
                menuDropdown.style.display = 'none';
            });
        }

        const editNameBtn = document.getElementById('editNameBtn');
        if (editNameBtn) {
            editNameBtn.addEventListener('click', () => {
                this.showEditNameModal();
                menuDropdown.style.display = 'none';
            });
        }

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
        [['editImageToggleBtn', 'editImagePanel'], ['addImageToggleBtn', 'addImagePanel']].forEach(([buttonId, panelId]) => {
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

        // Elenco partecipanti: si apre e si chiude toccando l'intestazione
        document.getElementById('participantsToggleBtn').addEventListener('click', (e) => {
            e.preventDefault();
            const list = document.getElementById('editParticipantsList');
            this.setParticipantsListOpen(list.style.display === 'none');
        });

        // Settings
        const settingsBtn = document.getElementById('settingsBtn');
        if (settingsBtn) settingsBtn.addEventListener('click', () => this.openSettings());
        const closeSettingsBtn = document.getElementById('closeSettingsBtn');
        if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', () => this.closeSettings());

        // Info
        const infoBtn = document.getElementById('infoBtn');
        if (infoBtn) infoBtn.addEventListener('click', () => this.openInfo());
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
                this.showErrorPopup('Inserisci un URL valido');
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
            this.editImageData = null;
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
                this.showErrorPopup('Inserisci un URL valido');
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
            if (this.currentEditingLink) {
                // Se il link non ha protocollo, aggiungi https://
                let url = this.currentEditingLink;
                if (!url.startsWith('http://') && !url.startsWith('https://')) {
                    url = 'https://' + url;
                }
                window.open(url, '_blank');
            }
        });

        document.getElementById('editLinkModifyBtn').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('editLinkContainer').style.display = 'none';
            document.getElementById('editLinkInputContainer').style.display = 'flex';
        });

        document.getElementById('editLinkSaveBtn').addEventListener('click', (e) => {
            e.preventDefault();
            const newLink = document.getElementById('editLink').value.trim();
            if (newLink) {
                if (this.editingNote) {
                    this.updateEvent(this.editingNote.id, { link: newLink });
                    this.renderEditLink(newLink);
                    this.showSuccessPopup('Link salvato');
                }
            } else {
                this.showErrorPopup('Inserisci un link valido oppure annulla');
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
            if (this.currentEventLink) {
                // Se il link non ha protocollo, aggiungi https://
                let url = this.currentEventLink;
                if (!url.startsWith('http://') && !url.startsWith('https://')) {
                    url = 'https://' + url;
                }
                window.open(url, '_blank');
            }
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
                const newLink = document.getElementById('eventLink').value.trim();
                if (newLink) {
                    this.currentEventLink = newLink;
                    this.renderEventLink(newLink);
                    this.showSuccessPopup('Link salvato');
                } else {
                    this.showErrorPopup('Inserisci un link valido oppure annulla');
                }
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
        // Pulisci i campi del form
        document.getElementById('eventTitle').value = '';
        document.getElementById('eventTime').value = '';
        document.getElementById('eventLocation').value = '';
        document.getElementById('eventNotes').value = '';
        document.getElementById('eventLink').value = '';
        this.currentEventLink = '';

        // Resetta i tab del modal di aggiunta
        const modal = document.getElementById('modal');
        modal.querySelectorAll('.modal-tab').forEach(tab => tab.classList.remove('active'));
        modal.querySelectorAll('.modal-tab-content').forEach(content => content.classList.remove('active'));
        // Attiva il primo tab
        modal.querySelector('.modal-tab').classList.add('active');
        modal.querySelector('.modal-tab-content').classList.add('active');

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
                `;
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
                            .catch(error => console.error('Errore rimozione partecipazione:', error));
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
            this.renderChatInto(messagesContainer, this.currentChat.messages, this.currentChat.lastReadTimestamp, this.editParticipantsList, false);
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
                    .then(() => this.showSuccessPopup('Adesso sei un partecipante!'))
                    .catch(error => {
                        console.error('Errore iscrizione:', error);
                        this.showErrorPopup('Errore nell\'iscrizione. Riprova.');
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
        const croppedImage = canvas.toDataURL('image/jpeg', 0.65);

        if (this.currentCropType === 'event') {
            this.eventImageData = croppedImage;
            // Visualizza l'immagine come copertina
            const coverDiv = document.getElementById('eventCoverContainerAdd');
            coverDiv.style.backgroundImage = `url(${croppedImage})`;
            coverDiv.style.backgroundAttachment = 'scroll';
            coverDiv.style.minHeight = '120px';
        } else if (this.currentCropType === 'edit') {
            this.editImageData = croppedImage;
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
                document.getElementById(type === 'event' ? 'eventImageUrl' : 'editImageUrl').value = '';
            })
            .catch(error => {
                this.showErrorPopup('Errore nel caricamento. Verifica l\'URL e i permessi CORS.');
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

    // Legge la quota dal modal: {ok, value}. Vuota = 0 (Gratis). Accetta "15", "15,50", "15.5", "15 €"
    readFeeInput(prefix) {
        const raw = document.getElementById(`${prefix}Fee`).value.replace('€', '').replace(',', '.').trim();
        if (!raw) return { ok: true, value: 0 };
        const value = Number(raw);
        if (!/^\d+(\.\d{1,2})?$/.test(raw) || !isFinite(value) || value > 100000) {
            this.showErrorPopup('Quota non valida: scrivi un importo (es. 15 o 12,50), oppure lascia vuoto per Gratis');
            return { ok: false };
        }
        return { ok: true, value: Math.round(value * 100) / 100 };
    }

    // Categoria (crea e modifica): il pulsante mostra la categoria scelta col suo colore
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

    addNote(e) {
        e.preventDefault();
        const title = document.getElementById('eventTitle').value.trim();
        if (!title || !this.selectedDate) return;

        const dateKey = document.getElementById('eventDate').value || this.getDateKey(this.selectedDate);
        if (!this.isFutureDateKey(dateKey)) {
            this.showErrorPopup('Puoi aggiungere eventi solo da domani in poi');
            return;
        }
        const fee = this.readFeeInput('event');
        if (!fee.ok) return;

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
            fee: fee.value,
            color: this.selectedColor,
            link: this.currentEventLink,
            imageVersion: imageVersion,
            creatorId: this.userId,
            createdAt: Date.now()
        };

        imageSaved
            .then(() => database.ref(`events/${id}`).set(event))
            .then(() => this.showSuccessPopup('Evento aggiunto con successo!'))
            .catch(error => {
                console.error('Errore creazione evento:', error);
                this.showErrorPopup('Errore nel salvataggio dell\'evento. Riprova.');
            });
        this.closeModal();
    }

    // Elimina l'evento con chat, letture chat e immagine, in un'unica scrittura
    deleteNote(eventId) {
        if (!eventId) return Promise.resolve();
        return database.ref().update({
            [`events/${eventId}`]: null,
            [`eventChats/${eventId}`]: null,
            [`chatReadStatus/${eventId}`]: null,
            [`eventImages/${eventId}`]: null
        }).catch(error => {
            console.error('Errore eliminazione evento:', error);
            this.showErrorPopup('Errore nell\'eliminazione dell\'evento. Riprova.');
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

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
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

    // Ridimensiona e ricomprime un'immagine (usata dall'import delle immagini vecchie)
    compressImage(dataUrl, maxWidth = 1200, quality = 0.65) {
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                try {
                    const scale = Math.min(1, maxWidth / img.width);
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.round(img.width * scale);
                    canvas.height = Math.round(img.height * scale);
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#fff';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    const compressed = canvas.toDataURL('image/jpeg', quality);
                    resolve(compressed.length < dataUrl.length ? compressed : dataUrl);
                } catch (e) {
                    resolve(dataUrl);
                }
            };
            img.onerror = () => resolve(dataUrl);
            img.src = dataUrl;
        });
    }

    // Mostra la copertina nel modal di modifica, se l'evento aperto è ancora lo stesso
    showEditCover(note) {
        this.getEventImage(note).then(image => {
            const current = this.getEditingEvent();
            if (!current || current.id !== note.id) return;

            this.editImageData = image;
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
        // Aggiorna lo stato dei checkbox
        document.querySelectorAll('.color-filter').forEach(checkbox => {
            const color = checkbox.dataset.color;
            checkbox.checked = this.visibleColors[color] !== false;
        });
    }

    closeSettings() {
        document.getElementById('settingsModal').classList.remove('active');
    }

    openInfo() {
        document.getElementById('infoModal').classList.add('active');
        // Carica il file info
        fetch('./descrizioni/info')
            .then(response => response.text())
            .then(content => {
                document.getElementById('infoBody').textContent = content;
            })
            .catch(error => {
                document.getElementById('infoBody').textContent = 'Errore nel caricamento del file informazioni.';
            });
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

            // Listener globale per i messaggi di TUTTI gli eventi (per aggiornare badge in real-time)
            database.ref('eventChats').on('value', () => {
                this.updateAllBadges();
            });
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

    getParticipantIds(event) {
        return Object.keys((event && event.participants) || {});
    }

    // Modifica, spostamento ed eliminazione: solo chi ha creato l'evento.
    // Gli eventi senza creatore (convertiti o importati dal vecchio DB) restano modificabili da tutti.
    // Iscriversi e scrivere in chat resta permesso a tutti.
    canEditEvent(event) {
        return !!event && (!event.creatorId || event.creatorId === this.userId);
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
            console.error('Errore salvataggio evento:', error);
            this.showErrorPopup('Errore nel salvataggio. Riprova.');
        });
    }

    // All'apertura dell'app:
    // - gli eventi dei mesi precedenti si cancellano, con chat, letture e immagine;
    // - gli eventi ancora nel formato vecchio (events/{YYYY-MM-DD}: [...]) si convertono in
    //   events/{id} se sono del mese corrente o successivi, altrimenti si cancellano.
    // Conversione e cancellazione del giorno vecchio vanno nella stessa scrittura, così non si
    // perde né si duplica niente; se due client lo fanno insieme scrivono gli stessi dati.
    async cleanupPastEvents() {
        const today = new Date();
        const firstOfMonth = this.getDateKey(new Date(today.getFullYear(), today.getMonth(), 1));
        const removeEvent = (updates, id) => {
            updates[`events/${id}`] = null;
            updates[`eventChats/${id}`] = null;
            updates[`chatReadStatus/${id}`] = null;
            updates[`eventImages/${id}`] = null;
        };

        try {
            const updates = {};
            let converted = 0;
            for (const [key, value] of Object.entries(this.events)) {
                if (!value) continue;

                if (this.isLegacyDayKey(key)) {
                    const oldEvents = Object.values(value).filter(old => old && old.title);
                    updates[`events/${key}`] = null;
                    if (key < firstOfMonth) {
                        oldEvents.forEach(old => { if (old.id) removeEvent(updates, old.id); });
                    } else {
                        for (const old of oldEvents) {
                            await this.addLegacyEventToUpdates(old, key, updates, null);
                            converted++;
                        }
                    }
                } else if (value.id && value.date && value.date < firstOfMonth && this.canEditEvent(value)) {
                    removeEvent(updates, value.id);
                }
            }

            if (Object.keys(updates).length > 0) {
                await database.ref().update(updates);
                if (converted > 0) console.log(`🔄 Convertiti ${converted} eventi dal formato vecchio`);
            }
        } catch (error) {
            console.error('Errore pulizia/conversione eventi:', error);
        }
    }

    // Formato vecchio: la chiave sotto events era la data e conteneva l'array degli eventi del giorno
    isLegacyDayKey(key) {
        return /^\d{4}-\d{2}-\d{2}$/.test(key);
    }

    // Converte un evento del formato vecchio nel nuovo e lo aggiunge a updates.
    // Partecipanti e creatore erano legati ai vecchi dispositivi e non si portano.
    // oldImages: le immagini del backup (import); null se l'immagine è già in eventImages/{id}.
    async addLegacyEventToUpdates(old, dateKey, updates, oldImages) {
        const id = old.id || ('evt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9));

        let imageVersion = null;
        let image = oldImages ? (oldImages[id] || null) : null;
        if (!image && old.image) image = await this.compressImage(old.image); // Immagine dentro l'evento (formato antico)
        if (typeof image === 'string' && image.startsWith('data:image/')) {
            imageVersion = old.imageVersion || Date.now();
            updates[`eventImages/${id}`] = image;
        } else if (!oldImages && old.imageVersion) {
            imageVersion = old.imageVersion; // Già in eventImages/{id}, con lo stesso id
        }

        updates[`events/${id}`] = {
            id: id,
            date: dateKey,
            title: old.title,
            time: old.time || '',
            location: old.location || '',
            notes: old.notes || '',
            color: old.color || 'color-neutral',
            link: old.link || '',
            imageVersion: imageVersion,
            createdAt: Date.now()
        };
        return id;
    }

    // Import una tantum dal vecchio database (JSON esportato dalla console Firebase).
    // Porta gli eventi da oggi in poi (senza partecipanti, creatore e chat), le loro immagini
    // e le proposte (con le date future, senza voti). Uso, da loggati, nella console del browser:
    //   await bacheaInstance.importBackupFromFile()   (si apre la scelta del file JSON)
    // oppure: await bacheaInstance.importBackup(<oggetto JSON incollato>)
    importBackupFromFile() {
        return new Promise((resolve, reject) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'application/json,.json';
            input.onchange = async () => {
                try {
                    const backup = JSON.parse(await input.files[0].text());
                    resolve(await this.importBackup(backup));
                } catch (error) {
                    console.error('Errore import:', error);
                    reject(error);
                }
            };
            input.click();
        });
    }

    async importBackup(backup) {
        if (!this.userId) throw new Error('Fai prima il login');
        const today = this.getDateKey(new Date());
        const oldImages = backup.eventImages || {};
        const updates = {};
        const counts = { events: 0, images: 0, proposals: 0 };

        for (const [dateKey, dayEvents] of Object.entries(backup.events || {})) {
            if (!this.isLegacyDayKey(dateKey) || dateKey < today) continue;
            for (const old of Object.values(dayEvents || {})) {
                if (!old || !old.title) continue;
                if (old.id && this.events[old.id]) continue; // Già importato

                const id = await this.addLegacyEventToUpdates(old, dateKey, updates, oldImages);
                if (updates[`eventImages/${id}`]) counts.images++;
                counts.events++;
            }
        }

        for (const old of Object.values(backup.proposals || {})) {
            if (!old || !old.id || !old.title || old.fixedDate || this.proposals[old.id]) continue;
            const dateOptions = {};
            Object.keys(old.dateOptions || {}).filter(d => d > today).forEach(d => {
                dateOptions[d] = { addedBy: (old.dateOptions[d] && old.dateOptions[d].addedBy) || '', createdAt: Date.now() };
            });
            updates[`proposals/${old.id}`] = {
                id: old.id,
                title: old.title,
                time: old.time || '',
                location: old.location || '',
                notes: old.notes || '',
                color: old.color || 'color-neutral',
                creatorId: this.userId, // Chi importa può eliminarle
                creatorName: old.creatorName || '',
                createdAt: old.createdAt || Date.now(),
                ...(Object.keys(dateOptions).length > 0 ? { dateOptions } : {})
            };
            counts.proposals++;
        }

        // A blocchi, così una scrittura non diventa troppo grande (le immagini pesano)
        const keys = Object.keys(updates);
        for (let i = 0; i < keys.length; i += 20) {
            const chunk = {};
            keys.slice(i, i + 20).forEach(key => { chunk[key] = updates[key]; });
            await database.ref().update(chunk);
        }
        console.log(`📥 Import completato: ${counts.events} eventi, ${counts.images} immagini, ${counts.proposals} proposte`);
        return counts;
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
    }

    async getUnreadMessageCount(eventId) {
        try {
            const statusSnapshot = await database.ref(`chatReadStatus/${eventId}/${this.userId}`).once('value');
            const lastReadTimestamp = statusSnapshot.exists() ? statusSnapshot.val().lastReadTimestamp : 0;

            const messagesSnapshot = await database.ref(`eventChats/${eventId}/messages`).once('value');
            if (!messagesSnapshot.exists()) return 0;

            const messages = messagesSnapshot.val();
            let unreadCount = 0;
            for (const msgId in messages) {
                if (messages[msgId].timestamp > lastReadTimestamp) {
                    unreadCount++;
                }
            }
            return unreadCount;
        } catch (error) {
            console.error('Errore conteggio messaggi non letti:', error);
            return 0;
        }
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
        this.editImageData = null;
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

                // Ottieni il lastReadTimestamp
                database.ref(`chatReadStatus/${eventId}/${this.userId}`).once('value', (statusSnapshot) => {
                    const lastReadTimestamp = statusSnapshot.exists() ? statusSnapshot.val().lastReadTimestamp : 0;

                    this.currentChat = { eventId, messages: snapshot.val(), lastReadTimestamp };
                    messagesContainer.innerHTML = '';
                    this.renderChatInto(messagesContainer, snapshot.val(), lastReadTimestamp, this.editParticipantsList);
                });

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
    renderChatInto(messagesContainer, messages, lastReadTimestamp, participantIds = null, scrollToBottom = true) {
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
                    timestamp: msg.timestamp
                };
            } else {
                // Stesso utente, aggiungi il testo al gruppo
                currentGroup.texts.push(msg.text);
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
            bubbleEl.textContent = group.texts.join('\n');

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
        database.ref(`chatReadStatus/${eventId}/${this.userId}`).set({
            lastReadTimestamp: new Date().getTime()
        });
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

            // Pulisci l'input
            document.getElementById('chatMessageInput').value = '';
            // Il listener su Firebase carica i messaggi automaticamente
        } catch (error) {
            console.error('Errore invio messaggio:', error);
        }
    }

    // Campo Data del modal di modifica: si può spostare solo da domani in poi
    setEditDateField(dateKey) {
        const dateInput = document.getElementById('editDate');
        dateInput.value = dateKey;
        dateInput.min = this.getTomorrowKey();
    }

    saveEditedNote() {
        const current = this.getEditingEvent();
        if (!current || !this.canEditEvent(current)) return;

        const title = document.getElementById('editTitle').value.trim();
        if (!title) {
            this.showErrorPopup('Il titolo non può essere vuoto');
            return;
        }

        // Cambio data: validato prima di toccare l'evento
        const dateKey = current.date;
        const newDateKey = document.getElementById('editDate').value || dateKey;
        const isMoving = newDateKey !== dateKey;
        if (isMoving && !this.isFutureDateKey(newDateKey)) {
            this.showErrorPopup('Puoi spostare un evento solo da domani in poi');
            return;
        }

        const fee = this.readFeeInput('edit');
        if (!fee.ok) return;

        // Solo i campi del modal: partecipanti, immagine e creatore restano come sono su Firebase
        const fields = {
            title: title,
            time: document.getElementById('editTime').value.trim(),
            location: document.getElementById('editLocation').value.trim(),
            notes: document.getElementById('editNotes').value.trim(),
            fee: fee.value, // 0 = Gratis
            color: this.selectedColor,
            link: document.getElementById('editLink').value.trim()
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
        document.getElementById('proposalCreateCancelBtn').addEventListener('click', () => this.closeProposalModal());
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
            this.renderProposals();

            if (this.openProposalId) {
                if (this.proposals[this.openProposalId] && this.proposals[this.openProposalId].id) {
                    this.renderProposalView();
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
    getProposalOptions(proposal) {
        const votes = proposal.votes || {};
        return Object.keys(proposal.dateOptions || {}).sort().map(date => {
            const voters = Object.entries(votes[date] || {}).map(([key, vote]) => ({ key, ...vote }));
            return { date, voters, count: voters.length, isFuture: this.isFutureDateKey(date) };
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
            if (best) {
                summary = `⭐ ${this.formatDateKey(best.date, true)} · ${best.count} ${best.count === 1 ? 'voto' : 'voti'}`;
            } else if (optionsCount > 0) {
                summary = 'Nessun voto ancora';
            }
            if (optionsCount > 0) {
                summary += ` · ${optionsCount} ${optionsCount === 1 ? 'data' : 'date'}`;
            }

            const categoryColors = {
                'color-neutral': '#999', 'color-yellow': '#ffd54f', 'color-pink': '#ff6b9d', 'color-green': '#81c784',
                'color-blue': '#64b5f6', 'color-purple': '#ba68c8', 'color-orange': '#ffb74d'
            };
            const card = document.createElement('div');
            card.style.cssText = `margin-top: 10px; padding: 10px 12px; background: white; border-left: 5px solid ${categoryColors[proposal.color] || '#999'}; border-radius: 8px; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.1);`;
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

    closeProposalModal() {
        const modal = document.getElementById('proposalModal');
        modal.classList.remove('active');
        modal.style.display = 'none';

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

            database.ref(`chatReadStatus/${proposalId}/${this.userId}`).once('value', (statusSnapshot) => {
                if (this.openProposalId !== proposalId) return;
                const lastReadTimestamp = statusSnapshot.exists() ? statusSnapshot.val().lastReadTimestamp : 0;
                messagesContainer.innerHTML = '';
                this.renderChatInto(messagesContainer, snapshot.val(), lastReadTimestamp);
            });
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
            input.value = '';
        } catch (error) {
            console.error('Errore invio messaggio proposta:', error);
            this.showErrorPopup('Errore nell\'invio del messaggio');
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
        document.getElementById('proposalCreateForm').reset();
        document.getElementById('proposalFirstDate').min = this.getTomorrowKey();
        document.getElementById('proposalModalTitle').textContent = '🗳️ Nuovo evento senza data';
        document.getElementById('proposalCreateForm').style.display = 'block';
        document.getElementById('proposalViewSection').style.display = 'none';
        this.showProposalModal();
        document.getElementById('proposalTitle').focus();
    }

    createProposal(e) {
        e.preventDefault();
        const title = document.getElementById('proposalTitle').value.trim();
        if (!title) return;

        const firstDate = document.getElementById('proposalFirstDate').value;
        if (firstDate && !this.isFutureDateKey(firstDate)) {
            this.showErrorPopup('Puoi proporre date solo da domani in poi');
            return;
        }

        const id = 'evt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const proposal = {
            id: id,
            title: title,
            time: document.getElementById('proposalTime').value.trim(),
            location: document.getElementById('proposalLocation').value.trim(),
            notes: document.getElementById('proposalNotes').value.trim(),
            color: document.getElementById('proposalColor').value,
            creatorId: this.userId,
            creatorName: this.userName || '',
            createdAt: Date.now()
        };
        // Chi crea non vota in automatico: magari non può esserci
        if (firstDate) {
            proposal.dateOptions = { [firstDate]: { addedBy: this.userName || '', createdAt: Date.now() } };
        }

        database.ref(`proposals/${id}`).set(proposal)
            .then(() => {
                this.openProposalView(id);
                this.showSuccessPopup('Proposta creata! Ora tutti possono votare le date.');
            })
            .catch(error => {
                console.error('Errore creazione proposta:', error);
                this.showErrorPopup('Errore nella creazione della proposta');
            });
    }

    openProposalView(proposalId) {
        if (!this.proposals[proposalId]) return;
        this.openProposalId = proposalId;
        document.getElementById('proposalCreateForm').style.display = 'none';
        document.getElementById('proposalViewSection').style.display = 'block';
        const newDateInput = document.getElementById('proposalNewDate');
        newDateInput.value = '';
        newDateInput.min = this.getTomorrowKey();
        this.proposalChatSeen = false;
        this.showProposalPane('proposalDatesPane');
        this.listenProposalChat(proposalId);
        this.renderProposalView();
        this.showProposalModal();
    }

    renderProposalView() {
        const proposal = this.proposals[this.openProposalId];
        if (!proposal) return;

        document.getElementById('proposalModalTitle').textContent = `🗳️ ${proposal.title}`;

        const details = [];
        if (proposal.time) details.push(`🕐 ${this.escapeHtml(proposal.time)}`);
        if (proposal.location) details.push(`📍 ${this.escapeHtml(proposal.location)}`);
        if (proposal.notes) details.push(`📝 ${this.escapeHtml(proposal.notes).replace(/\n/g, '<br>')}`);
        details.push(`👤 Proposta da: ${this.escapeHtml(proposal.creatorName || 'Anonimo')}`);
        document.getElementById('proposalDetails').innerHTML = details.map(d => `<div style="margin-bottom: 4px;">${d}</div>`).join('');

        document.getElementById('proposalDeleteBtn').style.display = this.isProposalCreator(proposal) ? 'block' : 'none';

        const listEl = document.getElementById('proposalOptionsList');
        listEl.innerHTML = '';

        const options = this.getProposalOptions(proposal);
        if (options.length === 0) {
            listEl.innerHTML = '<div style="background: rgba(255,255,255,0.15); border-radius: 8px; padding: 12px; text-align: center;">Ancora nessuna data: proponine una qui sotto 👇</div>';
            return;
        }

        const best = this.getBestProposalOption(proposal);
        const voterKey = this.getVoterKey();
        const canFix = this.hasVotedProposal(proposal) && !proposal.fixedDate;

        options.forEach(option => {
            const isBest = best && best.date === option.date;
            const mine = option.voters.some(v => v.key === voterKey);

            const row = document.createElement('div');
            row.style.cssText = `background: white; color: #333; border-radius: 8px; padding: 10px 12px; ${isBest ? 'border: 2px solid #4CAF50;' : 'border: 2px solid transparent;'} ${option.isFuture ? '' : 'opacity: 0.6;'}`;

            const names = option.voters.map(v => this.escapeHtml(v.name || 'Anonimo')).join(', ');
            row.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
                    <strong>${this.formatDateKey(option.date)}</strong>
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
                voteBtn.addEventListener('click', () => this.toggleProposalVote(option.date, mine));
                actions.appendChild(voteBtn);

                if (canFix && option.count > 0) {
                    const fixBtn = document.createElement('button');
                    fixBtn.type = 'button';
                    fixBtn.style.cssText = 'flex: 1; padding: 8px; background: #4CAF50; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;';
                    fixBtn.textContent = '📅 Fissa questa data';
                    fixBtn.addEventListener('click', () => this.fixProposalDate(option.date));
                    actions.appendChild(fixBtn);
                }
            }

            listEl.appendChild(row);
        });
    }

    toggleProposalVote(dateKey, alreadyVoted) {
        const proposalId = this.openProposalId;
        if (!proposalId || !this.isFutureDateKey(dateKey)) return;

        const ref = database.ref(`proposals/${proposalId}/votes/${dateKey}/${this.getVoterKey()}`);
        const write = alreadyVoted
            ? ref.remove()
            : ref.set({ name: this.userName, deviceId: this.userId });
        write.catch(error => {
            console.error('Errore voto proposta:', error);
            this.showErrorPopup('Errore nel salvataggio del voto');
        });
    }

    addProposalDate() {
        const proposalId = this.openProposalId;
        const proposal = this.proposals[proposalId];
        if (!proposal) return;

        const input = document.getElementById('proposalNewDate');
        const dateKey = input.value;
        if (!dateKey) {
            this.showErrorPopup('Scegli una data');
            return;
        }
        if (!this.isFutureDateKey(dateKey)) {
            this.showErrorPopup('Puoi proporre date solo da domani in poi');
            return;
        }
        if (proposal.dateOptions && proposal.dateOptions[dateKey]) {
            this.showErrorPopup('Questa data è già stata proposta: votala dalla lista');
            return;
        }

        // Chi propone una data la vota anche (può sempre togliere il voto)
        database.ref(`proposals/${proposalId}`).update({
            [`dateOptions/${dateKey}`]: { addedBy: this.userName || '', createdAt: Date.now() },
            [`votes/${dateKey}/${this.getVoterKey()}`]: { name: this.userName, deviceId: this.userId }
        }).then(() => {
            input.value = '';
        }).catch(error => {
            console.error('Errore aggiunta data:', error);
            this.showErrorPopup('Errore nel salvataggio della data');
        });
    }

    async fixProposalDate(dateKey) {
        const proposalId = this.openProposalId;
        const proposal = this.proposals[proposalId];
        if (!proposal || !this.hasVotedProposal(proposal)) return;
        if (!this.isFutureDateKey(dateKey)) {
            this.showErrorPopup('Puoi fissare solo date da domani in poi');
            return;
        }

        const confirmed = await this.showConfirmDialog(
            `Fissare "${proposal.title}" per ${this.formatDateKey(dateKey)}? ` +
            `L'evento andrà nel calendario e chi ha votato questa data diventerà partecipante.`,
            '📅 Fissa', '#4CAF50'
        );
        if (!confirmed) return;

        const proposalRef = database.ref(`proposals/${proposalId}`);
        try {
            // 1. Blocca la proposta: se due persone fissano insieme, passa solo la prima
            const lock = await proposalRef.child('fixedDate').transaction(current => current ? undefined : dateKey);
            if (!lock.committed) {
                this.showErrorPopup('Qualcun altro ha appena fissato questa proposta');
                return;
            }

            const fresh = (await proposalRef.once('value')).val() || proposal;
            const voters = Object.values((fresh.votes || {})[dateKey] || {});
            const participants = {};
            voters.forEach(v => { if (v.deviceId) participants[v.deviceId] = true; });

            const event = {
                id: proposalId, // Stesso id: chat e immagine restano collegate
                date: dateKey,
                title: fresh.title || proposal.title,
                time: fresh.time || '',
                location: fresh.location || '',
                notes: fresh.notes || '',
                color: fresh.color || 'color-neutral',
                link: '',
                imageVersion: null,
                participants: participants,
                creatorId: fresh.creatorId || this.userId,
                createdAt: Date.now()
            };

            // 2. Crea l'evento (solo se non esiste già)
            this.closeProposalModal();
            await database.ref(`events/${proposalId}`).transaction(current => current ? undefined : event);

            // 3. La proposta non serve più
            await proposalRef.remove();
            this.showSuccessPopup(`Data fissata! L'evento è nel calendario per ${this.formatDateKey(dateKey)}.`);
        } catch (error) {
            console.error('Errore nel fissare la data:', error);
            proposalRef.child('fixedDate').remove().catch(() => {});
            this.showErrorPopup('Errore nel fissare la data. Riprova.');
        }
    }

    async deleteProposal() {
        const proposalId = this.openProposalId;
        const proposal = this.proposals[proposalId];
        if (!proposal || !this.isProposalCreator(proposal)) return;

        const confirmed = await this.showConfirmDialog(`Eliminare la proposta "${proposal.title}"?`);
        if (!confirmed) return;

        this.closeProposalModal();
        // La chat serve solo alla proposta: si elimina con lei
        database.ref(`eventChats/${proposalId}`).remove().catch(() => {});
        database.ref(`chatReadStatus/${proposalId}`).remove().catch(() => {});
        database.ref(`proposals/${proposalId}`).remove()
            .then(() => this.showSuccessPopup('Proposta eliminata'))
            .catch(error => {
                console.error('Errore eliminazione proposta:', error);
                this.showErrorPopup('Errore nell\'eliminazione della proposta');
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
