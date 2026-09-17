// Firebase Config
const firebaseConfig = {
    apiKey: "AIzaSyBGy1u-1qF5qv8234rkEvjvEunyJAiogd4",
    authDomain: "bacheca-c0441.firebaseapp.com",
    databaseURL: "https://bacheca-c0441-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "bacheca-c0441",
    storageBucket: "bacheca-c0441.firebasestorage.app",
    messagingSenderId: "800396955473",
    appId: "1:800396955473:web:2e0a0607a0666122a58d70"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const database = firebase.database();

class BacheaCalendar {
    constructor() {
        this.currentDate = new Date();
        this.selectedDate = null;
        this.selectedColor = 'color-yellow';
        this.notes = {}; // Inizializza vuoto - i dati vengono caricati SOLO da Firebase
        this.isSyncing = false;
        this.isInitialLoad = true; // Flag per prima sincronizzazione
        this.editingNote = null; // Per tracciare quale nota stiamo editando
        this.isListView = false; // Toggle tra calendario e lista
        this.visibleColors = this.loadColorFilters(); // Colori visibili
        this.eventImageData = null;
        this.editImageData = null;
        this.currentEventLink = ''; // Link in aggiunta
        this.cropper = null;
        this.currentCropType = null; // 'event' o 'edit'
        this.deviceId = null; // UUID unico del dispositivo
        this.deviceName = null; // Nome dell'utente
        this.syncCode = null; // Codice di sincronizzazione multi-device
        this.deviceNames = {}; // Mappa di deviceId -> nome
        this.eventsListener = null; // Listener per cambiamenti Firebase
        this.suppressSync = false; // Flag per evitare loop di sync
        this.setupCustomPopup();
        this.initializeDevice().then(() => this.init());
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

    showConfirmDialog(message) {
        return new Promise((resolve) => {
            const modal = document.getElementById('confirmModal');
            const messageEl = document.getElementById('confirmMessage');
            const cancelBtn = document.getElementById('confirmCancelBtn');
            const okBtn = document.getElementById('confirmOkBtn');

            messageEl.textContent = message;
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

    generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    generateSyncCode() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let code = '';
        for (let i = 0; i < 5; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return code;
    }

    getDeviceInfo() {
        // Rileva browser
        let browser = 'Unknown';
        const ua = navigator.userAgent.toLowerCase();

        if (ua.indexOf('edg/') > -1) browser = 'Edge';
        else if (ua.indexOf('chrome') > -1 && ua.indexOf('chromium') === -1) browser = 'Chrome';
        else if (ua.indexOf('firefox') > -1) browser = 'Firefox';
        else if (ua.indexOf('safari') > -1 && ua.indexOf('chrome') === -1) browser = 'Safari';
        else if (ua.indexOf('opr/') > -1) browser = 'Opera';
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

    async getStoredDeviceId() {
        // Prova localStorage prima
        const localId = localStorage.getItem('deviceId');
        if (localId) {
            console.log('DeviceId da localStorage:', localId);
            return localId;
        }

        // Fallback: prova IndexedDB
        try {
            const idbId = await this.getFromIndexedDB('deviceId');
            if (idbId) {
                console.log('DeviceId da IndexedDB:', idbId);
                localStorage.setItem('deviceId', idbId);
                return idbId;
            }
        } catch (e) {
            console.warn('Errore IndexedDB:', e);
        }

        return null;
    }

    setStoredDeviceId(id) {
        localStorage.setItem('deviceId', id);
        this.saveToIndexedDB('deviceId', id);
    }

    saveToIndexedDB(key, value) {
        try {
            const request = indexedDB.open('BacheaDB', 1);
            request.onsuccess = function(e) {
                const db = e.target.result;
                const tx = db.transaction(['storage'], 'readwrite');
                tx.objectStore('storage').put({ key: key, value: value });
            };
            request.onupgradeneeded = function(e) {
                e.target.result.createObjectStore('storage', { keyPath: 'key' });
            };
        } catch (e) {
            console.warn('IndexedDB non disponibile:', e);
        }
    }

    getFromIndexedDB(key) {
        return new Promise((resolve) => {
            try {
                const request = indexedDB.open('BacheaDB', 1);
                request.onsuccess = function(e) {
                    const db = e.target.result;
                    const tx = db.transaction(['storage'], 'readonly');
                    const getReq = tx.objectStore('storage').get(key);
                    getReq.onsuccess = function() {
                        resolve(getReq.result ? getReq.result.value : null);
                    };
                };
                request.onupgradeneeded = function(e) {
                    e.target.result.createObjectStore('storage', { keyPath: 'key' });
                    resolve(null);
                };
            } catch (e) {
                console.warn('IndexedDB error:', e);
                resolve(null);
            }
        });
    }

    async initializeDevice() {
        let deviceId = await this.getStoredDeviceId();

        if (!deviceId) {
            deviceId = this.generateUUID();
            this.setStoredDeviceId(deviceId);
        }

        this.deviceId = deviceId;
        console.log('Device ID inizializzato:', this.deviceId);

        // Verifica se il dispositivo esiste su Firebase
        const deviceRef = database.ref(`devices/${deviceId}`);
        const snapshot = await deviceRef.once('value');

        if (!snapshot.exists()) {
            // Primo accesso - chiedi il nome
            await this.promptForDeviceName();
        } else {
            // Dispositivo già registrato - carica il nome e syncCode
            const deviceData = snapshot.val();
            this.deviceName = deviceData.name;
            this.syncCode = deviceData.syncCode;

            // Se il device non ha un nome, chiedi di impostarlo
            if (!this.deviceName || this.deviceName.trim() === '') {
                console.log('Device senza nome detected. Richiedendo nome...');
                await this.promptForDeviceName();
                return;
            }

            // Migrazione retrocompatibile: se il device non ha un syncCode, generane uno
            if (!this.syncCode) {
                console.log('Device vecchio senza syncCode detected. Generazione nuovo syncCode...');
                this.syncCode = this.generateSyncCode();

                // Aggiorna il device con il nuovo syncCode
                database.ref(`devices/${this.deviceId}`).update({
                    syncCode: this.syncCode
                }).then(() => {
                    // Crea l'entry di syncCodes DOPO aver aggiornato il device
                    database.ref(`syncCodes/${this.syncCode}`).set({
                        name: this.deviceName,
                        deviceIds: [this.deviceId],
                        createdAt: new Date().getTime()
                    });
                });

                console.log('SyncCode assegnato al device vecchio:', this.syncCode);
            }
        }
    }

    promptForDeviceName() {
        return new Promise((resolve) => {
            const modal = document.getElementById('namePromptModal');
            const form = document.getElementById('namePromptForm');
            const input = document.getElementById('nameInput');
            const cancelBtn = document.getElementById('namePromptCancelBtn');
            const syncCheckbox = document.getElementById('nameSyncExistingCheckbox');
            const syncCodeGroup = document.getElementById('nameSyncCodeGroup');
            const syncCodeInput = document.getElementById('nameSyncCodeInput');

            modal.classList.add('active');

            // Mostra/nascondi il campo syncCode in base al checkbox
            syncCheckbox.addEventListener('change', (e) => {
                syncCodeGroup.style.display = e.target.checked ? 'block' : 'none';
            });

            form.onsubmit = async (e) => {
                e.preventDefault();
                const inputName = input.value.trim();
                const useSyncCode = syncCheckbox.checked;

                // Se il checkbox è marcato, usa il syncCode
                if (useSyncCode) {
                    const syncCode = syncCodeInput.value.trim().toUpperCase();
                    if (!syncCode || syncCode.length !== 5) {
                        alert('Inserisci un codice valido di 5 caratteri');
                        return;
                    }

                    // Prova a sincronizzarsi con il codice
                    const success = await this.syncWithCode(syncCode);
                    if (success) {
                        modal.classList.remove('active');
                        resolve();
                        return;
                    } else {
                        alert('Codice di sincronizzazione non valido. Verifica e riprova.');
                        return;
                    }
                }

                // Altrimenti, crea un nuovo dispositivo con un nome
                if (inputName.toLowerCase() === 'anonimo') {
                    alert('Non puoi usare "Anonimo" come nominativo. Scegli un altro nome o clicca Annulla.');
                    return;
                }

                this.deviceName = inputName || `Utente ${Math.random().toString(36).substr(2, 5)}`;

                // Genera un nuovo syncCode per questo dispositivo
                const newSyncCode = this.generateSyncCode();
                this.syncCode = newSyncCode;

                // Crea un nuovo syncCode entry su Firebase
                database.ref(`syncCodes/${newSyncCode}`).set({
                    name: this.deviceName,
                    deviceIds: [this.deviceId],
                    createdAt: new Date().getTime()
                });

                // Salva il dispositivo su Firebase
                const deviceInfo = this.getDeviceInfo();
                database.ref(`devices/${this.deviceId}`).set({
                    id: this.deviceId,
                    name: this.deviceName,
                    syncCode: newSyncCode,
                    browser: deviceInfo.browser,
                    deviceType: deviceInfo.deviceType,
                    createdAt: new Date().getTime(),
                    lastSeen: new Date().getTime()
                });

                modal.classList.remove('active');
                resolve();
            };

            cancelBtn.onclick = (e) => {
                e.preventDefault();
                this.deviceName = 'Anonimo';

                // Genera un nuovo syncCode anche per l'Anonimo
                const newSyncCode = this.generateSyncCode();
                this.syncCode = newSyncCode;

                // Salva il dispositivo su Firebase come Anonimo con syncCode
                const deviceInfo = this.getDeviceInfo();
                database.ref(`devices/${this.deviceId}`).set({
                    id: this.deviceId,
                    name: this.deviceName,
                    syncCode: newSyncCode,
                    browser: deviceInfo.browser,
                    deviceType: deviceInfo.deviceType,
                    createdAt: new Date().getTime(),
                    lastSeen: new Date().getTime()
                });

                // Crea l'entry di syncCodes
                database.ref(`syncCodes/${newSyncCode}`).set({
                    name: this.deviceName,
                    deviceIds: [this.deviceId],
                    createdAt: new Date().getTime()
                });

                modal.classList.remove('active');
                resolve();
            };
        });
    }

    async syncWithCode(syncCode) {
        try {
            const syncCodeRef = database.ref(`syncCodes/${syncCode}`);
            const snapshot = await syncCodeRef.once('value');

            if (!snapshot.exists()) {
                console.error('SyncCode non valido:', syncCode);
                return false;
            }

            const syncCodeData = snapshot.val();
            this.deviceName = syncCodeData.name;
            this.syncCode = syncCode;

            // Aggiungi il dispositivo alla lista dei deviceIds
            const updatedDeviceIds = [...(syncCodeData.deviceIds || [])];
            if (!updatedDeviceIds.includes(this.deviceId)) {
                updatedDeviceIds.push(this.deviceId);
                await database.ref(`syncCodes/${syncCode}/deviceIds`).set(updatedDeviceIds);
            }

            // Salva il dispositivo su Firebase con il syncCode
            const deviceInfo = this.getDeviceInfo();
            await database.ref(`devices/${this.deviceId}`).set({
                id: this.deviceId,
                name: this.deviceName,
                syncCode: syncCode,
                browser: deviceInfo.browser,
                deviceType: deviceInfo.deviceType,
                createdAt: new Date().getTime(),
                lastSeen: new Date().getTime()
            });

            console.log('Sincronizzazione riuscita con il codice:', syncCode);
            return true;
        } catch (error) {
            console.error('Errore durante la sincronizzazione:', error);
            return false;
        }
    }

    updateLastSeen() {
        if (this.deviceId && this.deviceName) {
            database.ref(`devices/${this.deviceId}`).update({
                lastSeen: new Date().getTime()
            });
        }
    }

    displayWelcomeMessage() {
        const welcomeEl = document.getElementById('welcomeMessage');
        if (welcomeEl && this.deviceName) {
            if (this.deviceName === 'Anonimo') {
                welcomeEl.textContent = '👋 Benvenuto';
            } else {
                welcomeEl.textContent = `👋 Benvenuto, ${this.deviceName}!`;
            }
        }
    }

    async loadDeviceNames() {
        try {
            const snapshot = await database.ref('devices').once('value');
            if (snapshot.exists()) {
                const devices = snapshot.val();
                this.deviceNames = {};
                for (const [id, device] of Object.entries(devices)) {
                    this.deviceNames[id] = device.name || 'Sconosciuto';
                }
            }
        } catch (error) {
            console.error('Errore caricamento nomi device:', error);
        }
    }

    getParticipantName(participantId) {
        // Se è una stringa corta, è il vecchio formato (nome)
        if (participantId.length < 20) {
            return participantId;
        }
        // Se è un ID lungo, cerca il nome nella cache
        return this.deviceNames[participantId] || 'Sconosciuto';
    }

    updateEditNameButtonText() {
        const editNameBtn = document.getElementById('editNameBtn');
        if (editNameBtn) {
            if (this.deviceName === 'Anonimo') {
                editNameBtn.textContent = '👤 Inserisci il tuo nome';
            } else {
                editNameBtn.textContent = '👤 Cambia il tuo nome';
            }
        }
    }

    showEditNameModal() {
        const modal = document.getElementById('namePromptModal');
        const form = document.getElementById('namePromptForm');
        const input = document.getElementById('nameInput');
        const cancelBtn = document.getElementById('namePromptCancelBtn');

        input.value = this.deviceName === 'Anonimo' ? '' : this.deviceName;
        input.placeholder = this.deviceName === 'Anonimo' ? 'Inserisci il tuo nome' : `Cambia da "${this.deviceName}"`;

        modal.classList.add('active');

        const handleSubmit = (e) => {
            e.preventDefault();
            const inputName = input.value.trim();

            if (inputName.toLowerCase() === 'anonimo') {
                alert('Non puoi usare "Anonimo" come nominativo. Scegli un altro nome o clicca Annulla.');
                return;
            }

            this.deviceName = inputName || this.deviceName;

            database.ref(`devices/${this.deviceId}`).update({
                name: this.deviceName
            });

            // Se il device ha un syncCode, aggiorna il nome nel syncCode
            if (this.syncCode) {
                database.ref(`syncCodes/${this.syncCode}`).update({
                    name: this.deviceName
                });
            }

            this.displayWelcomeMessage();
            this.updateEditNameButtonText();
            modal.classList.remove('active');

            // Rimuovi i listener temporanei
            form.removeEventListener('submit', handleSubmit);
            cancelBtn.removeEventListener('click', handleCancel);
        };

        const handleCancel = (e) => {
            e.preventDefault();
            modal.classList.remove('active');

            // Rimuovi i listener temporanei
            form.removeEventListener('submit', handleSubmit);
            cancelBtn.removeEventListener('click', handleCancel);
        };

        form.addEventListener('submit', handleSubmit);
        cancelBtn.addEventListener('click', handleCancel);
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
        this.loadDeviceNames(); // Carica i nomi dei devices
        // Aggiorna lastSeen ogni minuto
        setInterval(() => this.updateLastSeen(), 60000);
        // Carica da GitHub PRIMA di renderizzare
        this.loadFromGitHub().then(() => {
            // Sincronizza con Firebase PRIMA di renderizzare
            this.autoSync().then(() => {
                this.render();
                // Nascondi il loading quando tutto è pronto
                const loadingScreen = document.getElementById('loadingScreen');
                if (loadingScreen) {
                    loadingScreen.style.display = 'none';
                }
            });
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
        const syncCodeSection = document.getElementById('syncCodeSection');
        const syncCodeDisplay = document.getElementById('syncCodeDisplay');
        const copySyncCodeBtn = document.getElementById('copySyncCodeBtn');

        if (menuBtn && menuDropdown) {
            menuBtn.addEventListener('click', () => {
                menuDropdown.style.display = menuDropdown.style.display === 'none' ? 'block' : 'none';
                // Aggiorna il syncCode quando il menu viene aperto
                if (syncCodeDisplay && this.syncCode) {
                    syncCodeDisplay.textContent = this.syncCode;
                    syncCodeSection.style.display = 'block';
                } else if (syncCodeSection) {
                    syncCodeSection.style.display = 'none';
                }
            });

            // Chiudi menu quando clicca fuori
            document.addEventListener('click', (e) => {
                if (e.target !== menuBtn && !menuDropdown.contains(e.target)) {
                    menuDropdown.style.display = 'none';
                }
            });
        }

        if (copySyncCodeBtn) {
            copySyncCodeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (this.syncCode) {
                    navigator.clipboard.writeText(this.syncCode).then(() => {
                        this.showSuccessPopup('Codice copiato: ' + this.syncCode);
                    }).catch(() => {
                        this.showErrorPopup('Errore nella copia del codice');
                    });
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
            });
        });

        // Seleziona colore form modifica evento
        document.querySelectorAll('input[name="editEventColor"]').forEach(option => {
            option.addEventListener('change', (e) => {
                this.selectedColor = e.target.dataset.color;
                // Auto-save della categoria
                if (this.editingNote) {
                    const { dateKey, noteIndex } = this.editingNote;
                    this.notes[dateKey][noteIndex].color = this.selectedColor;
                    this.syncToFirebase();
                    this.render(); // Aggiorna l'interfaccia subito
                }
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

                // Mostra/nascondi il button Salva solo nella tab Evento
                const saveEditBtn = document.getElementById('saveEditBtn');
                if (saveEditBtn) {
                    if (tabName === 'edit-evento-tab') {
                        saveEditBtn.style.display = 'inline-block';
                    } else {
                        saveEditBtn.style.display = 'none';
                    }
                }
            });
        });

        // Gestione partecipanti form aggiunta
        this.eventParticipantsList = [];

        const eventHasParticipants = document.getElementById('eventHasParticipants');
        if (eventHasParticipants) {
            eventHasParticipants.addEventListener('change', (e) => {
                const group = document.getElementById('eventParticipantsGroup');
                if (group) group.style.display = e.target.checked ? 'block' : 'none';
                if (e.target.checked) {
                    this.renderEventParticipants();
                }
            });
        }

        const eventAddParticipantBtn = document.getElementById('eventAddParticipantBtn');
        if (eventAddParticipantBtn) {
            eventAddParticipantBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const inputGroup = document.getElementById('eventParticipantsInputGroup');
                if (inputGroup) inputGroup.style.display = 'flex';
                const input = document.getElementById('eventParticipantInput');
                if (input) input.focus();
            });
        }

        const eventParticipantSaveBtn = document.getElementById('eventParticipantSaveBtn');
        if (eventParticipantSaveBtn) {
            eventParticipantSaveBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const name = document.getElementById('eventParticipantInput').value.trim();
                if (name) {
                    this.eventParticipantsList.push(name);
                    const input = document.getElementById('eventParticipantInput');
                    if (input) input.value = '';
                    const inputGroup = document.getElementById('eventParticipantsInputGroup');
                    if (inputGroup) inputGroup.style.display = 'none';
                    this.renderEventParticipants();
                }
            });
        }

        // Gestione partecipanti form modifica (LEGACY - non più utilizzati nel nuovo sistema)
        this.editParticipantsList = [];

        const editHasParticipants = document.getElementById('editHasParticipants');
        if (editHasParticipants) {
            editHasParticipants.addEventListener('change', (e) => {
                const group = document.getElementById('editParticipantsGroup');
                if (group) group.style.display = e.target.checked ? 'block' : 'none';
                if (e.target.checked) {
                    this.renderEditParticipants();
                }
            });
        }

        const editAddParticipantBtn = document.getElementById('editAddParticipantBtn');
        if (editAddParticipantBtn) {
            editAddParticipantBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const inputGroup = document.getElementById('editParticipantsInputGroup');
                if (inputGroup) inputGroup.style.display = 'flex';
                const input = document.getElementById('editParticipantInput');
                if (input) input.focus();
            });
        }

        const editParticipantSaveBtn = document.getElementById('editParticipantSaveBtn');
        if (editParticipantSaveBtn) {
            editParticipantSaveBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const name = document.getElementById('editParticipantInput').value.trim();
                if (name) {
                    this.editParticipantsList.push(name);
                    const input = document.getElementById('editParticipantInput');
                    if (input) input.value = '';
                    const group = document.getElementById('editParticipantsInputGroup');
                    if (group) group.style.display = 'none';
                    this.renderEditParticipants();

                    // Salva immediatamente su Firebase
                    if (this.editingNote) {
                        const { dateKey, noteIndex } = this.editingNote;
                        this.notes[dateKey][noteIndex].participants = this.editParticipantsList;
                        this.saveNotes();
                        this.autoSync();
                    }
                }
            });
        }

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
                console.log('Click "Voglio partecipare"', this.deviceId);
                this.addCurrentUserToParticipants();
            });
        } else {
            console.warn('Button "editWantToParticipateBtn" non trovato');
        }

        // Open chat from participants tab
        const openChatBtn = document.getElementById('openChatFromParticipantsBtn');
        if (openChatBtn) {
            openChatBtn.addEventListener('click', (e) => {
                e.preventDefault();
                // Attiva la tab chat
                document.querySelectorAll('.modal-tab').forEach(tab => tab.classList.remove('active'));
                document.querySelectorAll('.modal-tab-content').forEach(content => content.classList.remove('active'));

                // Se la tab chat esiste, attivala
                const chatTabBtn = document.querySelector('[data-tab="edit-chat-tab"]');
                const chatContent = document.getElementById('edit-chat-tab');

                if (chatContent) {
                    chatContent.classList.add('active');
                    // Se il bottone tab esiste, attivalo
                    if (chatTabBtn) chatTabBtn.classList.add('active');
                } else {
                    // Se la tab chat non esiste in pagina, mostra un messaggio
                    console.warn('Chat tab non trovata');
                }
            });
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
            this.showSuccessPopup('Immagine rimossa');
        });

        document.getElementById('eventImageUrlBtn').addEventListener('click', (e) => {
            e.preventDefault();
            const url = document.getElementById('eventImageUrl').value.trim();
            if (!url) {
                this.showErrorPopup('Inserisci un URL valido');
                return;
            }
            this.loadImageFromUrl(url, 'event');
        });

        // Edit Image buttons
        document.getElementById('editImageUploadBtn').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('editImage').click();
        });

        document.getElementById('editImage').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
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
                const { dateKey, noteIndex } = this.editingNote;
                this.notes[dateKey][noteIndex].image = null;
                this.saveNotes();
            }
            this.syncToFirebase();
            this.render();
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
            // Nascondi il container dopo il salvataggio
            document.getElementById('editImageUrlInputContainer').style.display = 'none';
            document.getElementById('editImageUrl').value = '';
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
                    const { dateKey, noteIndex } = this.editingNote;
                    this.notes[dateKey][noteIndex].link = newLink;
                    this.saveNotes();
                    this.syncToFirebase();
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
                const { dateKey, noteIndex } = this.editingNote;
                this.notes[dateKey][noteIndex].link = '';
                this.saveNotes();
                this.autoSync();
                this.renderEditLink('');
                this.showSuccessPopup('Link eliminato');
            }
        });

        document.getElementById('editLinkCancelBtn').addEventListener('click', (e) => {
            e.preventDefault();
            const currentLink = this.editingNote ? this.notes[this.editingNote.dateKey][this.editingNote.noteIndex].link : '';
            this.renderEditLink(currentLink);
        });

        // Event Link buttons (per aggiungere nuovo evento)
        document.getElementById('eventLinkOpenBtn').addEventListener('click', (e) => {
            e.preventDefault();
            if (this.currentEventLink) {
                window.open(this.currentEventLink, '_blank');
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

                sortedNotes.forEach((note, index) => {
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
                            this.openEditModal(dateKey, index);
                        });
                        // Abilita drag and drop solo se il giorno non è passato
                        this.setupDragAndDrop(noteEl, dateKey, index, dayObj);
                    }

                    notesContainer.appendChild(noteEl);

                    // Aggiorna il badge dei messaggi non letti per questo evento
                    this.updateNoteBadge(noteEl, note.id);
                });
            }

            // Aggiungi listener di click solo se il giorno non è passato e è del mese corrente
            const canAddEvents = !isDisabledDay && dayObj.isCurrentMonth;
            if (canAddEvents) {
                dayEl.addEventListener('click', () => this.openModal(dayObj.date));
                dayEl.style.cursor = 'pointer';
            } else {
                dayEl.style.cursor = 'default';
                // Nascondi il pulsante + per giorni disabilitati o giorni di altri mesi
                dayEl.querySelector('.add-note-btn').style.display = 'none';
            }

            daysGrid.appendChild(dayEl);
        });
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
        document.getElementById('eventNotes').value = '';
        document.getElementById('eventLink').value = '';
        document.getElementById('eventImage').value = '';
        document.getElementById('eventHasParticipants').checked = false;
        document.getElementById('eventParticipantsGroup').style.display = 'none';
        document.getElementById('eventParticipantsInputGroup').style.display = 'none';
        document.getElementById('eventParticipantInput').value = '';
        this.eventParticipantsList = [];
        this.eventImageData = null;

        // Reset immagine nel container (mantieni il gradiente viola)
        const coverContainerAdd = document.getElementById('eventCoverContainerAdd');
        coverContainerAdd.style.backgroundImage = 'none';
        coverContainerAdd.style.backgroundAttachment = 'scroll';
        coverContainerAdd.style.minHeight = '180px';

        // Seleziona il colore neutro di default
        document.querySelector('input[name="eventColor"][data-color="color-neutral"]').checked = true;
        this.selectedColor = 'color-neutral';

        // Reset del link
        this.currentEventLink = '';
        this.renderEventLink('');

        document.getElementById('modal').classList.add('active');
        document.getElementById('modal').style.display = 'flex';
        document.getElementById('eventTitle').focus();

        const dateStr = date.toLocaleDateString('it-IT', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        document.getElementById('modalTitle').textContent = `Proposta per ${dateStr}`;
    }

    closeModal() {
        // Pulisci i campi del form
        document.getElementById('eventTitle').value = '';
        document.getElementById('eventTime').value = '';
        document.getElementById('eventLocation').value = '';
        document.getElementById('eventNotes').value = '';
        document.getElementById('eventLink').value = '';
        document.getElementById('eventHasParticipants').checked = false;
        document.getElementById('eventParticipantsGroup').style.display = 'none';
        document.getElementById('eventParticipantsInputGroup').style.display = 'none';
        document.getElementById('eventParticipantInput').value = '';
        this.eventParticipantsList = [];
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

    renderEventParticipants() {
        const listEl = document.getElementById('eventParticipantsList');
        listEl.innerHTML = '';

        this.eventParticipantsList.forEach((participant, index) => {
            const itemEl = document.createElement('div');
            itemEl.className = 'participant-item';
            itemEl.innerHTML = `
                <span>${this.escapeHtml(participant)}</span>
                <button type="button" class="btn-remove-participant" data-index="${index}">Elimina</button>
            `;

            itemEl.querySelector('.btn-remove-participant').addEventListener('click', (e) => {
                e.preventDefault();
                this.eventParticipantsList.splice(index, 1);
                this.renderEventParticipants();
            });

            listEl.appendChild(itemEl);
        });
    }

    async renderEditParticipants() {
        const listEl = document.getElementById('editParticipantsList');
        if (!listEl) return;
        listEl.innerHTML = '';

        // Aggiorna il numero di partecipanti
        const countEl = document.getElementById('participantCountDisplay');
        if (countEl) {
            countEl.textContent = this.editParticipantsList.length;
        }

        // Carica i nomi di tutti i partecipanti
        const participantNames = await Promise.all(this.editParticipantsList.map(async (participant) => {
            // Retrocompatibilità: se è una stringa corta, è il vecchio formato (nome diretto)
            if (participant.length < 20) {
                return { id: participant, name: participant, syncCode: null };
            }

            // Nuovo formato: è un ID, leggi il nome da Firebase
            try {
                const snapshot = await database.ref(`devices/${participant}`).once('value');
                if (snapshot.exists()) {
                    const deviceData = snapshot.val();
                    return { id: participant, name: deviceData.name, syncCode: deviceData.syncCode || null };
                }
                return { id: participant, name: 'Sconosciuto', syncCode: null };
            } catch (error) {
                return { id: participant, name: 'Errore', syncCode: null };
            }
        }));

        // Deduplicare per syncCode: se più device hanno lo stesso syncCode, mostrar solo una volta
        const seenSyncCodes = new Set();
        const displayedParticipants = [];

        participantNames.forEach((participantData, originalIndex) => {
            // Se ha syncCode e l'abbiamo già visto, salta
            if (participantData.syncCode && seenSyncCodes.has(participantData.syncCode)) {
                return;
            }

            // Marca il syncCode come visto
            if (participantData.syncCode) {
                seenSyncCodes.add(participantData.syncCode);
            }

            displayedParticipants.push({ ...participantData, originalIndex });
        });

        displayedParticipants.forEach((participantData) => {
            // Controlla se è l'utente corrente (per syncCode o deviceId)
            let isCurrentUser = participantData.id === this.deviceId;
            if (!isCurrentUser && this.syncCode && participantData.syncCode) {
                isCurrentUser = participantData.syncCode === this.syncCode;
            }

            const itemEl = document.createElement('div');
            itemEl.className = 'participant-item';

            if (isCurrentUser) {
                itemEl.innerHTML = `
                    <span>${this.escapeHtml(participantData.name)} (tu)</span>
                    <button type="button" class="btn-remove-participant" data-index="${participantData.originalIndex}" style="background: #f44336;">Non posso più</button>
                `;
            } else {
                itemEl.innerHTML = `
                    <span>${this.escapeHtml(participantData.name)}</span>
                `;
            }

            const removeBtn = itemEl.querySelector('.btn-remove-participant');
            if (removeBtn) {
                removeBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const indexToRemove = parseInt(e.target.dataset.index);
                    this.editParticipantsList.splice(indexToRemove, 1);
                    this.renderEditParticipants();

                    // Salva immediatamente su Firebase
                    if (this.editingNote) {
                        const { dateKey, noteIndex } = this.editingNote;
                        this.notes[dateKey][noteIndex].participants = this.editParticipantsList;
                        this.saveNotes();
                        this.autoSync();
                    }
                });
            }

            listEl.appendChild(itemEl);
        });

        // Aggiorna il button "Voglio partecipare"
        await this.updateParticipateButton();
    }

    async updateParticipateButton() {
        const btn = document.getElementById('editWantToParticipateBtn');
        if (!btn) {
            console.warn('Button editWantToParticipateBtn non trovato in updateParticipateButton');
            return;
        }

        // Controlla se il syncCode corrente è già tra i partecipanti
        let isParticipant = false;

        if (this.syncCode) {
            // Nuovo sistema: controlla per syncCode
            for (const participantId of this.editParticipantsList) {
                try {
                    const snapshot = await database.ref(`devices/${participantId}`).once('value');
                    if (snapshot.exists()) {
                        const participantSyncCode = snapshot.val().syncCode;
                        if (participantSyncCode === this.syncCode) {
                            isParticipant = true;
                            break;
                        }
                    }
                } catch (error) {
                    console.warn('Errore caricamento syncCode partecipante:', error);
                }
            }
        } else {
            // Fallback: controlla per deviceId o nome
            isParticipant = this.editParticipantsList.some(p => {
                return p === this.deviceId || p === this.deviceName;
            });
        }

        console.log('updateParticipateButton:', { isParticipant, deviceId: this.deviceId, syncCode: this.syncCode, participants: this.editParticipantsList });

        if (isParticipant) {
            btn.style.display = 'none';
        } else {
            btn.style.display = 'block';
        }
    }

    addCurrentUserToParticipants() {
        console.log('addCurrentUserToParticipants called', { deviceId: this.deviceId, editingNote: this.editingNote });

        if (!this.editParticipantsList.includes(this.deviceId)) {
            this.editParticipantsList.push(this.deviceId);
            console.log('Aggiunto utente ai partecipanti:', this.editParticipantsList);
            this.renderEditParticipants();

            // Aggiorna la visibilità dell'input chat
            this.updateChatInputVisibility(this.editParticipantsList);

            // Salva immediatamente su Firebase
            if (this.editingNote) {
                const { dateKey, noteIndex } = this.editingNote;
                this.notes[dateKey][noteIndex].participants = this.editParticipantsList;
                this.saveNotes();
                this.autoSync();
                this.showSuccessPopup('Adesso sei un partecipante!');
            }
        } else {
            console.log('Utente già partecipante');
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

        const canvas = this.cropper.getCroppedCanvas();
        // Comprimi l'immagine a qualità 0.7 (70%) per occupare meno spazio
        const croppedImage = canvas.toDataURL('image/jpeg', 0.7);

        if (this.currentCropType === 'event') {
            this.eventImageData = croppedImage;
            // Visualizza l'immagine come copertina
            const coverDiv = document.getElementById('eventCoverContainerAdd');
            coverDiv.style.backgroundImage = `url(${croppedImage})`;
            coverDiv.style.backgroundAttachment = 'scroll';
            coverDiv.style.minHeight = '180px';
        } else if (this.currentCropType === 'edit') {
            this.editImageData = croppedImage;
            // Visualizza l'immagine come copertina
            const coverDiv = document.getElementById('eventCoverContainer');
            coverDiv.style.backgroundImage = `url(${croppedImage})`;
            coverDiv.style.backgroundAttachment = 'scroll';
            coverDiv.style.minHeight = '180px';

            // Auto-save dell'immagine
            if (this.editingNote) {
                const { dateKey, noteIndex } = this.editingNote;
                this.notes[dateKey][noteIndex].image = croppedImage;
                this.saveNotes();
                this.syncToFirebase();
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

        if (link && link.trim()) {
            openBtn.disabled = false;
            openBtn.style.background = '#2196F3';
            openBtn.style.cursor = 'pointer';
            openBtn.style.opacity = '1';
        } else {
            openBtn.disabled = true;
            openBtn.style.background = '#ccc';
            openBtn.style.cursor = 'not-allowed';
            openBtn.style.opacity = '0.6';
        }
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

        if (link && link.trim()) {
            openBtn.disabled = false;
            openBtn.style.background = '#2196F3';
            openBtn.style.cursor = 'pointer';
            openBtn.style.opacity = '1';
        } else {
            openBtn.disabled = true;
            openBtn.style.background = '#ccc';
            openBtn.style.cursor = 'not-allowed';
            openBtn.style.opacity = '0.6';
        }
    }

    addNote(e) {
        e.preventDefault();
        const title = document.getElementById('eventTitle').value.trim();
        if (!title || !this.selectedDate) return;

        const dateKey = this.getDateKey(this.selectedDate);
        if (!this.notes[dateKey]) {
            this.notes[dateKey] = [];
        }

        // Genera un ID unico
        const id = 'evt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

        this.notes[dateKey].push({
            id: id,
            title: title,
            time: document.getElementById('eventTime').value.trim(),
            location: document.getElementById('eventLocation').value.trim(),
            notes: document.getElementById('eventNotes').value.trim(),
            color: this.selectedColor,
            link: this.currentEventLink,
            image: this.eventImageData,
            participants: this.eventParticipantsList,
            creatorId: this.deviceId
        });

        this.saveNotes();
        this.syncToFirebase(); // Sincronizza con Firebase in real-time
        this.closeModal();
        this.render(); // Usa render() per renderizzare la vista corretta
        setTimeout(() => this.showSuccessPopup('Evento aggiunto con successo!'), 100);
    }

    deleteNote(dateKey, index) {
        if (this.notes[dateKey]) {
            // Prendi l'ID dell'evento prima di eliminarlo
            const eventId = this.notes[dateKey][index].id;

            this.notes[dateKey].splice(index, 1);
            if (this.notes[dateKey].length === 0) {
                delete this.notes[dateKey];
            }

            // Elimina la chat associata su Firebase
            if (eventId) {
                database.ref(`eventChats/${eventId}`).remove().catch(error => {
                    console.error('Errore eliminazione chat:', error);
                });
            }
            this.saveNotes();
            this.syncToFirebase(); // Sincronizza con Firebase in real-time
        }
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

    deleteEventsForMonth(monthDate) {
        const year = monthDate.getFullYear();
        const month = String(monthDate.getMonth() + 1).padStart(2, '0');

        const keysToDelete = Object.keys(this.notes).filter(dateKey =>
            dateKey.startsWith(`${year}-${month}-`)
        );

        keysToDelete.forEach(dateKey => {
            delete this.notes[dateKey];
        });

        this.saveNotes();
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

    saveNotes() {
        // I dati vengono salvati SOLO su Firebase via autoSync()
        // Non salviamo più su localStorage per evitare conflitti al refresh
    }

    loadNotes() {
        // I dati vengono caricati SOLO da Firebase via autoSync()
        // Non carichiamo più da localStorage
        return {};
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Drag and Drop
    setupDragAndDrop(noteEl, dateKey, noteIndex, dayObj) {
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
                this.startDrag(noteEl, dateKey, noteIndex, dayObj);
            }
        });

        noteEl.addEventListener('mouseup', () => {
            isDragging = false;
        });

        noteEl.addEventListener('mouseleave', () => {
            isDragging = false;
        });
    }

    startDrag(noteEl, sourceDateKey, noteIndex, sourceDayObj) {
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
                this.dropEvent(mouseOverDay, sourceDateKey, noteIndex, sourceDayObj);
            }
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }

    dropEvent(targetDayEl, sourceDateKey, noteIndex, sourceDayObj) {
        // Estrai la data dal giorno target (dalla classe o dall'ID)
        const notesContainer = targetDayEl.querySelector('[id^="notes-"]');
        if (!notesContainer) return;

        const targetDateKey = notesContainer.id.replace('notes-', '');

        // Valida il giorno target
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const [year, month, day] = targetDateKey.split('-').map(Number);
        const targetDate = new Date(year, month - 1, day);

        // Non puoi spostare su giorni passati o oggi
        if (targetDate <= today) {
            this.showErrorPopup('Non puoi spostare su giorni passati o di oggi');
            return;
        }

        if (sourceDateKey === targetDateKey) {
            return; // Stesso giorno
        }

        // Sposta l'evento
        const note = this.notes[sourceDateKey][noteIndex];
        this.notes[sourceDateKey].splice(noteIndex, 1);

        if (this.notes[sourceDateKey].length === 0) {
            delete this.notes[sourceDateKey];
        }

        if (!this.notes[targetDateKey]) {
            this.notes[targetDateKey] = [];
        }

        this.notes[targetDateKey].push(note);

        this.saveNotes();
        this.autoSync();
        this.render();
        this.showSuccessPopup('Evento spostato con successo!');
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
                if (isCurrentYear && monthIndex < today.getMonth()) {
                    return; // Salta i mesi passati
                }

                const option = document.createElement('option');
                option.value = monthIndex;
                option.textContent = monthName;
                monthSelect.appendChild(option);
            });

            // Preseleziona il mese corrente se disponibile, altrimenti il primo disponibile
            if (isCurrentYear) {
                monthSelect.value = today.getMonth();
            } else {
                monthSelect.value = 0; // Gennaio per anni futuri
            }
        };

        // Preseleziona il giorno dopo il corrente
        dayInput.value = today.getDate() + 1;

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

        yearSelect.addEventListener('change', () => {
            updateAvailableMonths();
            updateDayConstraints();
        });
        monthSelect.addEventListener('change', updateDayConstraints);

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

        dayInput.addEventListener('input', validateDay);
        dayInput.addEventListener('change', validateDay);
        // Ascolta i click dei button su/giù
        dayInput.addEventListener('mouseup', validateDay);

        // Button per incrementare/decrementare il giorno
        const dayPlusBtn = document.getElementById('selectDayDayPlus');
        const dayMinusBtn = document.getElementById('selectDayDayMinus');

        dayPlusBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const current = parseInt(dayInput.value) || parseInt(dayInput.min);
            const max = parseInt(dayInput.max);
            if (current < max) {
                dayInput.value = current + 1;
                validateDay();
            }
        });

        dayMinusBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const current = parseInt(dayInput.value) || parseInt(dayInput.min);
            const min = parseInt(dayInput.min);
            if (current > min) {
                dayInput.value = current - 1;
                validateDay();
            }
        });

        modal.style.display = 'flex';
    }

    closeSelectDayModal() {
        const modal = document.getElementById('selectDayModal');
        modal.style.display = 'none';
    }

    renderList() {
        const eventsList = document.getElementById('eventsList');
        const allEvents = [];

        for (const [dateKey, eventsArray] of Object.entries(this.notes)) {
            eventsArray.forEach((event, index) => {
                allEvents.push({
                    dateKey,
                    index,
                    date: new Date(dateKey),
                    ...event
                });
            });
        }

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

        if (visibleEvents.length === 0) {
            eventsList.innerHTML += '<div class="empty-list">Nessun evento programmato 📭</div>';
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

            const participantsHtml = event.participants && event.participants.length > 0
                ? `<div class="event-participants">👥 ${event.participants.map(p => this.escapeHtml(this.getParticipantName(p))).join(', ')}</div>`
                : '';

            eventEl.setAttribute('data-event-id', event.id);
            eventEl.style.position = 'relative';
            eventEl.innerHTML = `
                <div style="position: relative; background-image: url(${event.image || ''}); background-size: cover; background-position: center;">
                    <div style="position: relative; z-index: 10; padding: 16px; background: rgba(255, 255, 255, 0.95);">
                        <div class="event-date">${dateStr.charAt(0).toUpperCase() + dateStr.slice(1)}</div>
                        <div class="event-title">${this.escapeHtml(event.title)}</div>
                        ${event.time ? `<div class="event-time">🕐 ${this.escapeHtml(event.time)}</div>` : ''}
                        ${event.location ? `<div class="event-location">📍 ${this.escapeHtml(event.location)}</div>` : ''}
                        ${event.notes ? `<div class="event-notes">${this.escapeHtml(event.notes).replace(/\n/g, '<br>')}</div>` : ''}
                        ${participantsHtml}
                    </div>
                    <span class="list-event-badge" style="position: absolute; top: 10px; right: 10px; background: #f44336; color: white; border-radius: 50%; width: 24px; height: 24px; display: none; align-items: center; justify-content: center; font-size: 0.75rem; font-weight: bold; z-index: 11;"></span>
                    ${event.image ? `<div style="position: absolute; top: 0; right: 0; width: 100%; height: 100%; background-image: url(${event.image}); background-size: cover; background-position: center; clip-path: polygon(15% 0%, 100% 0%, 100% 100%, 0% 100%, 15% 75%, 0% 50%, 15% 25%); z-index: 1;"></div>` : ''}
                </div>
            `;

            eventEl.addEventListener('click', () => {
                this.openEditModal(event.dateKey, event.index);
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

    autoSync() {
        return new Promise((resolve) => {
            if (this.isSyncing) {
                resolve();
                return;
            }
            this.isSyncing = true;

            // Carica i dati da Firebase per il caricamento iniziale
            database.ref('events').once('value', (snapshot) => {
                // Se this.notes è vuoto (caricamento iniziale), usa i dati da Firebase
                if (Object.keys(this.notes).length === 0 && snapshot.exists()) {
                    this.notes = snapshot.val();
                }

                // Solo al caricamento iniziale: se è il 1° del mese, cancella gli eventi dei mesi precedenti
                if (this.isInitialLoad) {
                    this.isInitialLoad = false;
                    const today = new Date();
                    if (today.getDate() === 1) {
                        const currentYear = today.getFullYear();
                        const currentMonth = today.getMonth() + 1;

                        Object.keys(this.notes).forEach(dateKey => {
                            const [year, month, day] = dateKey.split('-');
                            const eventYear = parseInt(year);
                            const eventMonth = parseInt(month);

                            // Se l'evento è di un mese precedente, cancellalo
                            if (eventYear < currentYear || (eventYear === currentYear && eventMonth < currentMonth)) {
                                delete this.notes[dateKey];
                            }
                        });
                    }
                }

                // Salva i dati locali su Firebase (sovrascrivi completamente)
                if (Object.keys(this.notes).length > 0) {
                    this.suppressSync = true;
                    database.ref('events').set(this.notes, (error) => {
                        this.suppressSync = false;
                        this.isSyncing = false;
                        resolve();
                        this.setupRealtimeSync(); // Inizia il real-time sync
                    });
                } else {
                    this.isSyncing = false;
                    resolve();
                    this.setupRealtimeSync();
                }
            });
        });
    }

    setupRealtimeSync() {
        // Rimuovi il vecchio listener se esiste
        if (this.eventsListener) {
            database.ref('events').off('value', this.eventsListener);
        }

        // Configura listener real-time
        this.eventsListener = (snapshot) => {
            // Se il cambiamento viene da questo client (suppressSync), ignora
            if (this.suppressSync) {
                return;
            }

            if (snapshot.exists()) {
                const remoteNotes = snapshot.val();

                // Aggiorna solo se c'è una vera differenza
                if (JSON.stringify(this.notes) !== JSON.stringify(remoteNotes)) {
                    this.notes = remoteNotes;

                    // Se il modal è aperto, verifica se l'evento è stato eliminato
                    if (this.editingNote) {
                        const { dateKey, noteIndex } = this.editingNote;
                        if (!this.notes[dateKey] || !this.notes[dateKey][noteIndex]) {
                            // L'evento è stato eliminato
                            this.showEventDeletedDialog();
                        } else {
                            // L'evento esiste ancora, aggiorna il contenuto
                            this.updateEditModalContent();
                        }
                    }

                    this.render();
                }
            }
        };

        database.ref('events').on('value', this.eventsListener);

        // Listener globale per i messaggi di TUTTI gli eventi (per aggiornare badge in real-time)
        database.ref('eventChats').on('value', () => {
            // Quando arrivano messaggi nuovi, aggiorna tutti i badge nel calendario e nella lista
            this.updateAllBadges();
        });
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

        // Aggiorna il badge del pulsante Chat se il modal è aperto
        if (this.editingNote) {
            const { dateKey, noteIndex } = this.editingNote;
            const note = this.notes[dateKey] && this.notes[dateKey][noteIndex];
            if (note) {
                this.updateChatButtonBadge(note.id);
            }
        }
    }

    syncToFirebase() {
        this.suppressSync = true;
        database.ref('events').set(this.notes, (error) => {
            this.suppressSync = false;
            if (error) {
                console.error('Errore sincronizzazione Firebase:', error);
            }
        });
    }

    async getUnreadMessageCount(eventId) {
        try {
            const statusSnapshot = await database.ref(`chatReadStatus/${eventId}/${this.syncCode}`).once('value');
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

    updateChatButtonBadge(eventId) {
        const chatBtn = document.getElementById('openChatFromParticipantsBtn');
        if (!chatBtn) return;

        // Controlla se sei partecipante
        const isParticipant = this.editParticipantsList && this.editParticipantsList.includes(this.deviceId);

        // Se non sei partecipante, non mostrare il badge
        if (!isParticipant) {
            chatBtn.style.setProperty('background', 'rgba(255, 255, 255, 0.3)', 'important');
            chatBtn.style.setProperty('color', 'white', 'important');
            chatBtn.textContent = '💬 Chat';
            return;
        }

        this.getUnreadMessageCount(eventId).then(count => {
            if (count > 0) {
                chatBtn.style.setProperty('background', '#4CAF50', 'important');
                chatBtn.style.setProperty('color', 'white', 'important');
                chatBtn.textContent = `💬 Chat (${count})`;
            } else {
                chatBtn.style.setProperty('background', 'rgba(255, 255, 255, 0.3)', 'important');
                chatBtn.style.setProperty('color', 'white', 'important');
                chatBtn.textContent = '💬 Chat';
            }
        });
    }

    updateNoteBadge(noteEl, eventId) {
        // Trova l'evento e controlla se sei partecipante
        let isParticipant = false;
        let found = false;
        for (const dateKey in this.notes) {
            if (found) break;
            const dayNotes = this.notes[dateKey];
            for (let i = 0; i < dayNotes.length; i++) {
                if (dayNotes[i].id === eventId) {
                    const participants = dayNotes[i].participants || [];
                    isParticipant = participants.includes(this.deviceId);
                    found = true;
                    break;
                }
            }
        }

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
        // Trova l'evento e controlla se sei partecipante
        let isParticipant = false;
        let found = false;
        for (const dateKey in this.notes) {
            if (found) break;
            const dayNotes = this.notes[dateKey];
            for (let i = 0; i < dayNotes.length; i++) {
                if (dayNotes[i].id === eventId) {
                    const participants = dayNotes[i].participants || [];
                    isParticipant = participants.includes(this.deviceId);
                    found = true;
                    break;
                }
            }
        }

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
        // Aggiorna il contenuto del modal con i dati più recenti da Firebase
        if (!this.editingNote) return;

        const { dateKey, noteIndex } = this.editingNote;
        if (!this.notes[dateKey] || !this.notes[dateKey][noteIndex]) return;

        const note = this.notes[dateKey][noteIndex];

        // Aggiorna i campi del modal
        document.getElementById('editTitle').value = note.title || '';
        document.getElementById('editTime').value = note.time || '';
        document.getElementById('editLocation').value = note.location || '';
        document.getElementById('editNotes').value = note.notes || '';
        document.getElementById('editLink').value = note.link || '';

        // Aggiorna i partecipanti
        this.editParticipantsList = note.participants ? [...note.participants] : [];
        this.renderEditParticipants();

        // Aggiorna il colore
        this.selectedColor = note.color || 'color-yellow';
        const colorRadio = document.querySelector(`input[name="editEventColor"][data-color="${this.selectedColor}"]`);
        if (colorRadio) {
            colorRadio.checked = true;
        }

        // Aggiorna l'immagine
        this.editImageData = note.image || null;
        const coverContainer = document.getElementById('eventCoverContainer');
        if (note.image) {
            coverContainer.style.backgroundImage = `url(${note.image})`;
        } else {
            coverContainer.style.backgroundImage = 'none';
        }

        // Ricarica la lista dei partecipanti
        this.updateParticipateButton();
    }

    openEditModal(dateKey, noteIndex) {
        // Chiudi il modal di aggiunta se aperto
        document.getElementById('modal').classList.remove('active');
        document.getElementById('modal').style.display = 'none';

        this.editingNote = { dateKey, noteIndex };
        const note = this.notes[dateKey][noteIndex];

        document.getElementById('editTitle').value = note.title || '';
        document.getElementById('editTime').value = note.time || '';
        document.getElementById('editLocation').value = note.location || '';
        document.getElementById('editNotes').value = note.notes || '';
        document.getElementById('editLink').value = note.link || '';

        // Gestisci visualizzazione link
        this.renderEditLink(note.link);

        // Carica il nome del creatore
        this.loadAndDisplayCreatorName(note.creatorId);

        // Set partecipanti
        this.editParticipantsList = note.participants ? [...note.participants] : [];
        this.renderEditParticipants();

        // Set colore - mantieni il colore originale come default
        this.selectedColor = note.color || 'color-yellow';
        const colorRadio = document.querySelector(`input[name="editEventColor"][data-color="${this.selectedColor}"]`);
        if (colorRadio) {
            colorRadio.checked = true;
        }

        // Carica l'immagine se esiste
        this.editImageData = note.image || null;
        const coverContainer = document.getElementById('eventCoverContainer');
        if (note.image) {
            coverContainer.style.backgroundImage = `url(${note.image})`;
            coverContainer.style.backgroundAttachment = 'scroll';
        } else {
            coverContainer.style.backgroundImage = 'none';
            coverContainer.style.backgroundAttachment = 'fixed';
        }
        // Mantieni sempre una min-height per mostrare il gradiente viola
        coverContainer.style.minHeight = '180px';

        // Carica e visualizza i messaggi della chat
        this.loadAndDisplayChatMessages(note.id);

        // Aggiorna il badge dei messaggi non letti
        this.updateChatButtonBadge(note.id);

        // Nascondi il form di invio se non sei partecipante
        this.updateChatInputVisibility(note.participants);

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

            // Crea un nuovo listener per aggiornamenti real-time
            this.chatListener = chatRef.on('value', (snapshot) => {
                const messagesContainer = document.getElementById('chatMessagesContainer');
                if (!messagesContainer) return; // Se il container non esiste, esci

                messagesContainer.innerHTML = '';

                if (!snapshot.exists()) {
                    messagesContainer.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">Nessun messaggio ancora. Inizia una conversazione!</div>';

                    // Se non ci sono messaggi, aggiorna i badge
                    if (this.editingNote) {
                        const { dateKey, noteIndex } = this.editingNote;
                        const note = this.notes[dateKey] && this.notes[dateKey][noteIndex];
                        if (note) {
                            this.updateChatButtonBadge(note.id);
                            this.updateCalendarBadge(note.id);
                        }
                    }
                    return;
                }

                // Ottieni il lastReadTimestamp
                database.ref(`chatReadStatus/${eventId}/${this.syncCode}`).once('value', (statusSnapshot) => {
                    const lastReadTimestamp = statusSnapshot.exists() ? statusSnapshot.val().lastReadTimestamp : 0;

                    const messages = snapshot.val();
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

                        const isYou = group.deviceId === this.deviceId;
                        const messageEl = document.createElement('div');
                        messageEl.style.cssText = `
                            display: flex;
                            flex-direction: column;
                            align-items: ${isYou ? 'flex-end' : 'flex-start'};
                            gap: 4px;
                        `;

                        const bubbleEl = document.createElement('div');
                        bubbleEl.style.cssText = `
                            max-width: 70%;
                            padding: 10px 14px;
                            border-radius: 12px;
                            word-wrap: break-word;
                            font-size: 0.95rem;
                            white-space: pre-wrap;
                            ${isYou
                                ? 'background: #667eea; color: white; border-radius: 18px 18px 4px 18px;'
                                : 'background: white; color: #333; border: 1px solid #ddd; border-radius: 18px 18px 18px 4px;'}
                        `;
                        bubbleEl.textContent = group.texts.join('\n');

                        const nameEl = document.createElement('div');
                        nameEl.style.cssText = `font-size: 0.75rem; color: #999; ${isYou ? 'text-align: right;' : 'text-align: left;'}`;
                        nameEl.textContent = group.name;

                        messageEl.appendChild(nameEl);
                        messageEl.appendChild(bubbleEl);
                        messagesContainer.appendChild(messageEl);
                    });

                    // Scroll sempre al fondo
                    setTimeout(() => {
                        messagesContainer.scrollTop = messagesContainer.scrollHeight;
                        // Assicurati che lo scroll avvenga anche se il container non è ancora renderizzato
                        setTimeout(() => {
                            messagesContainer.scrollTop = messagesContainer.scrollHeight;
                        }, 50);
                    }, 150);
                });

                // Aggiorna i badge quando i messaggi cambiano
                if (this.editingNote) {
                    const { dateKey, noteIndex } = this.editingNote;
                    const note = this.notes[dateKey] && this.notes[dateKey][noteIndex];
                    if (note) {
                        this.updateChatButtonBadge(note.id);
                        // Aggiorna il badge nel calendario
                        this.updateCalendarBadge(note.id);
                    }
                }
            });
        } catch (error) {
            console.error('Errore caricamento messaggi chat:', error);
        }
    }

    markChatAsRead(eventId) {
        // Aggiorna il timestamp quando apri la chat
        database.ref(`chatReadStatus/${eventId}/${this.syncCode}`).set({
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
        const isParticipant = participants && participants.includes(this.deviceId);
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
        if (!creatorId) {
            document.getElementById('creatorNameDisplay').textContent = 'Anonimo';
            return;
        }

        try {
            const snapshot = await database.ref(`devices/${creatorId}`).once('value');
            if (snapshot.exists()) {
                const creatorName = snapshot.val().name;
                if (creatorName === 'Anonimo') {
                    document.getElementById('creatorNameDisplay').textContent = 'Anonimo';
                } else {
                    document.getElementById('creatorNameDisplay').textContent = creatorName;
                }
            } else {
                document.getElementById('creatorNameDisplay').textContent = 'Sconosciuto';
            }
        } catch (error) {
            console.error('Errore caricamento creatore:', error);
            document.getElementById('creatorNameDisplay').textContent = 'Errore';
        }
    }

    closeEditModal() {
        // Marca la chat come letta quando chiudi il modal (dopo aver letto i messaggi)
        if (this.editingNote) {
            const { dateKey, noteIndex } = this.editingNote;
            if (this.notes[dateKey] && this.notes[dateKey][noteIndex]) {
                const eventId = this.notes[dateKey][noteIndex].id;
                this.markChatAsRead(eventId);

                // Aggiorna i badge dopo aver marcato come letto
                setTimeout(() => {
                    this.updateAllBadges();
                }, 100);
            }
        }

        // Rimuovi il listener della chat
        if (this.chatListener && this.editingNote) {
            const { dateKey, noteIndex } = this.editingNote;
            if (this.notes[dateKey] && this.notes[dateKey][noteIndex]) {
                const eventId = this.notes[dateKey][noteIndex].id;
                database.ref(`eventChats/${eventId}/messages`).off('value', this.chatListener);
            }
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

        const { dateKey, noteIndex } = this.editingNote;
        const eventId = this.notes[dateKey][noteIndex].id;

        try {
            const messageRef = database.ref(`eventChats/${eventId}/messages`).push();
            const messageId = messageRef.key;

            await messageRef.set({
                deviceId: this.deviceId,
                name: this.deviceName,
                text: messageText,
                timestamp: new Date().getTime()
            });

            // Pulisci l'input
            document.getElementById('chatMessageInput').value = '';

            // Ricarica i messaggi
            this.loadAndDisplayChatMessages(eventId);
        } catch (error) {
            console.error('Errore invio messaggio:', error);
        }
    }

    saveEditedNote() {
        if (!this.editingNote) return;

        const { dateKey, noteIndex } = this.editingNote;
        const eventId = this.notes[dateKey][noteIndex].id;
        const creatorId = this.notes[dateKey][noteIndex].creatorId; // Mantieni il creatore originale

        this.notes[dateKey][noteIndex] = {
            id: eventId, // Mantieni l'ID originale
            title: document.getElementById('editTitle').value.trim(),
            time: document.getElementById('editTime').value.trim(),
            location: document.getElementById('editLocation').value.trim(),
            notes: document.getElementById('editNotes').value.trim(),
            color: this.selectedColor,
            link: document.getElementById('editLink').value.trim(),
            image: this.editImageData,
            participants: this.editParticipantsList,
            creatorId: creatorId // Mantieni il creatore originale
        };

        this.saveNotes();
        this.syncToFirebase(); // Sincronizza con Firebase in real-time
        this.closeEditModal();
        this.render(); // Usa render() per renderizzare la vista corretta (calendario o lista)
        setTimeout(() => this.showSuccessPopup('Evento modificato con successo!'), 100);
    }

    async deleteCurrentNote() {
        if (!this.editingNote) return;

        const confirmed = await this.showConfirmDialog('Sei sicuro di voler eliminare questo evento?');
        if (!confirmed) return;

        const { dateKey, noteIndex } = this.editingNote;
        this.deleteNote(dateKey, noteIndex); // Elimina e sincronizza Firebase

        // Aspetta che il listener real-time chiuda il modal
        // Se non succede entro 500ms, chiudi manualmente
        setTimeout(() => {
            if (this.editingNote) {
                // Il listener non ha chiuso il modal, lo faccio manualmente
                this.showEventDeletedDialog();
            }
        }, 500);
    }

    async loadFromGitHub() {
        // Caricamento dati delegato a Firebase via autoSync()
        // Non carichiamo più da data.json per evitare conflitti
        return Promise.resolve();
    }

}

// Inizializza il calendario
let bacheaInstance = null;
document.addEventListener('DOMContentLoaded', () => {
    bacheaInstance = new BacheaCalendar();
});
