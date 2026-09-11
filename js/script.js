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
        this.cropper = null;
        this.currentCropType = null; // 'event' o 'edit'
        this.setupCustomPopup();
        this.init();
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

    init() {
        this.setupEventListeners();
        this.detectDevice();
        this.loadVersion();
        this.loadTitle();
        // Carica da GitHub PRIMA di renderizzare
        this.loadFromGitHub().then(() => {
            // Sincronizza con Firebase PRIMA di renderizzare
            this.autoSync().then(() => {
                this.render();
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

        if (isMobile) {
            // Su mobile: attiva vista lista
            this.isListView = true;
            const viewToggleBtn = document.getElementById('viewToggleBtn');
            const listView = document.getElementById('listView');
            const calendarView = document.getElementById('calendarView');

            viewToggleBtn.textContent = '📅 Calendario';
            viewToggleBtn.classList.add('active');
            listView.style.display = 'block';
            calendarView.style.display = 'none';

            // Renderizza la lista subito
            setTimeout(() => this.renderList(), 100);
        }

        // Ascolta il ridimensionamento della finestra
        window.addEventListener('resize', () => {
            const nowMobile = window.innerWidth < 768;
            if (nowMobile !== this.isListView) {
                // Se il dispositivo cambia (es: rotazione dello schermo), cambia vista
                this.toggleView();
            }
        });
    }

    setupEventListeners() {
        document.getElementById('prevBtn').addEventListener('click', () => this.previousMonth());
        document.getElementById('nextBtn').addEventListener('click', () => this.nextMonth());
        document.querySelector('.btn-today').addEventListener('click', () => this.today());

        document.getElementById('closeBtn').addEventListener('click', (e) => {
            e.preventDefault();
            this.closeModal();
        });
        document.getElementById('modal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('modal')) this.closeModal();
        });

        document.getElementById('noteForm').addEventListener('submit', (e) => this.addNote(e));

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
            });
        });

        // Gestione partecipanti form aggiunta
        this.eventParticipantsList = [];

        document.getElementById('eventHasParticipants').addEventListener('change', (e) => {
            document.getElementById('eventParticipantsGroup').style.display = e.target.checked ? 'block' : 'none';
            if (e.target.checked) {
                this.renderEventParticipants();
            }
        });

        document.getElementById('eventAddParticipantBtn').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('eventParticipantsInputGroup').style.display = 'flex';
            document.getElementById('eventParticipantInput').focus();
        });

        document.getElementById('eventParticipantSaveBtn').addEventListener('click', (e) => {
            e.preventDefault();
            const name = document.getElementById('eventParticipantInput').value.trim();
            if (name) {
                this.eventParticipantsList.push(name);
                document.getElementById('eventParticipantInput').value = '';
                document.getElementById('eventParticipantsInputGroup').style.display = 'none';
                this.renderEventParticipants();
            }
        });

        // Gestione partecipanti form modifica
        this.editParticipantsList = [];

        document.getElementById('editHasParticipants').addEventListener('change', (e) => {
            document.getElementById('editParticipantsGroup').style.display = e.target.checked ? 'block' : 'none';
            if (e.target.checked) {
                this.renderEditParticipants();
            }
        });

        document.getElementById('editAddParticipantBtn').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('editParticipantsInputGroup').style.display = 'flex';
            document.getElementById('editParticipantInput').focus();
        });

        document.getElementById('editParticipantSaveBtn').addEventListener('click', (e) => {
            e.preventDefault();
            const name = document.getElementById('editParticipantInput').value.trim();
            if (name) {
                this.editParticipantsList.push(name);
                document.getElementById('editParticipantInput').value = '';
                document.getElementById('editParticipantsInputGroup').style.display = 'none';
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

        // Settings
        document.getElementById('settingsBtn').addEventListener('click', () => this.openSettings());
        document.getElementById('closeSettingsBtn').addEventListener('click', () => this.closeSettings());

        // Info
        document.getElementById('infoBtn').addEventListener('click', () => this.openInfo());
        document.getElementById('closeInfoBtn').addEventListener('click', () => this.closeInfo());
        document.getElementById('infoModal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('infoModal')) this.closeInfo();
        });

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
            this.showSuccessPopup('Immagine rimossa');
        });

        document.getElementById('editImageUrlBtn').addEventListener('click', (e) => {
            e.preventDefault();
            const url = document.getElementById('editImageUrl').value.trim();
            if (!url) {
                this.showErrorPopup('Inserisci un URL valido');
                return;
            }
            this.loadImageFromUrl(url, 'edit');
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
                window.open(this.currentEditingLink, '_blank');
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
                    this.autoSync();
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

        // GIF Modal
        document.getElementById('titleLine2').addEventListener('click', () => {
            const text = document.getElementById('titleLine2').textContent;
            if (text === 'Ma io che cazzo ne so, scusi?') {
                this.toggleGifModal();
            }
        });
        document.getElementById('gifModal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('gifModal')) this.toggleGifModal();
        });
    }

    render() {
        this.updateHeader();
        if (this.isListView) {
            this.renderList();
        } else {
            this.renderCalendar();
        }
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

            dayEl.innerHTML = `
                <div class="day-number">${dayObj.day}</div>
                <div class="notes-container" id="notes-${dateKey}">
                    ${dayNotes.length === 0 ? '<div class="empty-state">✨</div>' : ''}
                </div>
                <button class="add-note-btn" type="button">+</button>
            `;

            // Aggiungi le note al giorno (solo se il colore è visibile)
            const notesContainer = dayEl.querySelector(`#notes-${dateKey}`);
            const visibleNotes = dayNotes.filter(note => this.isColorVisible(note.color));

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

                    noteEl.innerHTML = `
                        <span class="note-text">${this.escapeHtml(note.title)}</span>
                    `;

                    // Click per aprire il dettaglio (solo se non è passato)
                    if (!isPastDay) {
                        noteEl.querySelector('.note-text').addEventListener('click', (e) => {
                            e.stopPropagation();
                            this.openEditModal(dateKey, index);
                        });
                    }

                    notesContainer.appendChild(noteEl);
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

    renderEditParticipants() {
        const listEl = document.getElementById('editParticipantsList');
        if (!listEl) return;
        listEl.innerHTML = '';

        this.editParticipantsList.forEach((participant, index) => {
            const itemEl = document.createElement('div');
            itemEl.className = 'participant-item';
            itemEl.innerHTML = `
                <span>${this.escapeHtml(participant)}</span>
                <button type="button" class="btn-remove-participant" data-index="${index}">Elimina</button>
            `;

            itemEl.querySelector('.btn-remove-participant').addEventListener('click', (e) => {
                e.preventDefault();
                this.editParticipantsList.splice(index, 1);
                this.renderEditParticipants();

                // Salva immediatamente su Firebase
                if (this.editingNote) {
                    const { dateKey, noteIndex } = this.editingNote;
                    this.notes[dateKey][noteIndex].participants = this.editParticipantsList;
                    this.saveNotes();
                    this.autoSync();
                }
            });

            listEl.appendChild(itemEl);
        });
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
            link: document.getElementById('eventLink').value.trim(),
            image: this.eventImageData,
            participants: this.eventParticipantsList
        });

        this.saveNotes();
        this.autoSync(); // Sincronizza con Firebase
        this.closeModal();
        this.render(); // Usa render() per renderizzare la vista corretta
        setTimeout(() => this.showSuccessPopup('Evento aggiunto con successo!'), 100);
    }

    deleteNote(dateKey, index) {
        if (this.notes[dateKey]) {
            this.notes[dateKey].splice(index, 1);
            if (this.notes[dateKey].length === 0) {
                delete this.notes[dateKey];
            }
            this.saveNotes();
            this.closeModal(); // Chiudi il modal di aggiunta se aperto
            this.autoSync(); // Sincronizza con Firebase
            this.render(); // Usa render() per renderizzare la vista corretta
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
        const viewToggleBtn = document.getElementById('viewToggleBtn');
        const listView = document.getElementById('listView');
        const calendarView = document.getElementById('calendarView');

        if (this.isListView) {
            viewToggleBtn.textContent = '📅 Calendario';
            viewToggleBtn.classList.add('active');
            listView.style.display = 'block';
            calendarView.style.display = 'none';
            this.renderList();
        } else {
            viewToggleBtn.textContent = '📋 Lista';
            viewToggleBtn.classList.remove('active');
            listView.style.display = 'none';
            calendarView.style.display = 'block';
            this.renderCalendar();
        }
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

        if (visibleEvents.length === 0) {
            eventsList.innerHTML = '<div class="empty-list">Nessun evento programmato 📭</div>';
            return;
        }

        eventsList.innerHTML = '';
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
                ? `<div class="event-participants">👥 ${event.participants.map(p => this.escapeHtml(p)).join(', ')}</div>`
                : '';

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
                    ${event.image ? `<div style="position: absolute; top: 0; right: 0; width: 100%; height: 100%; background-image: url(${event.image}); background-size: cover; background-position: center; clip-path: polygon(15% 0%, 100% 0%, 100% 100%, 0% 100%, 15% 75%, 0% 50%, 15% 25%); z-index: 1;"></div>` : ''}
                </div>
            `;

            eventEl.addEventListener('click', () => {
                this.openEditModal(event.dateKey, event.index);
            });

            eventsList.appendChild(eventEl);
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
                    database.ref('events').set(this.notes, (error) => {
                        this.isSyncing = false;
                        resolve();
                    });
                } else {
                    this.isSyncing = false;
                    resolve();
                }
            });
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

        // Set partecipanti
        this.editParticipantsList = note.participants ? [...note.participants] : [];
        const hasParticipants = this.editParticipantsList.length > 0;
        document.getElementById('editHasParticipants').checked = hasParticipants;
        document.getElementById('editParticipantsGroup').style.display = hasParticipants ? 'block' : 'none';
        if (hasParticipants) {
            this.renderEditParticipants();
        }

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

        document.getElementById('editModal').classList.add('active');
        document.getElementById('editModal').style.display = 'flex';
    }

    closeEditModal() {
        // Pulisci i campi del form
        document.getElementById('editTitle').value = '';
        document.getElementById('editTime').value = '';
        document.getElementById('editLocation').value = '';
        document.getElementById('editNotes').value = '';
        document.getElementById('editLink').value = '';
        document.getElementById('editHasParticipants').checked = false;
        document.getElementById('editParticipantsGroup').style.display = 'none';
        document.getElementById('editParticipantsInputGroup').style.display = 'none';
        document.getElementById('editParticipantInput').value = '';
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

    saveEditedNote() {
        if (!this.editingNote) return;

        const { dateKey, noteIndex } = this.editingNote;
        const eventId = this.notes[dateKey][noteIndex].id;

        this.notes[dateKey][noteIndex] = {
            id: eventId, // Mantieni l'ID originale
            title: document.getElementById('editTitle').value.trim(),
            time: document.getElementById('editTime').value.trim(),
            location: document.getElementById('editLocation').value.trim(),
            notes: document.getElementById('editNotes').value.trim(),
            color: this.selectedColor,
            link: document.getElementById('editLink').value.trim(),
            image: this.editImageData,
            participants: this.editParticipantsList
        };

        this.saveNotes();
        this.autoSync(); // Sincronizza con Firebase
        this.closeEditModal();
        this.render(); // Usa render() per renderizzare la vista corretta (calendario o lista)
        setTimeout(() => this.showSuccessPopup('Evento modificato con successo!'), 100);
    }

    deleteCurrentNote() {
        if (!this.editingNote) return;
        if (!confirm('Sei sicuro di voler eliminare questo evento?')) return;

        const { dateKey, noteIndex } = this.editingNote;
        this.deleteNote(dateKey, noteIndex); // Elimina e sincronizza Firebase
        this.closeEditModal(); // Chiude il popup
        setTimeout(() => this.showSuccessPopup('Evento eliminato con successo!'), 100);
    }

    async loadFromGitHub() {
        // Caricamento dati delegato a Firebase via autoSync()
        // Non carichiamo più da data.json per evitare conflitti
        return Promise.resolve();
    }

}

// Inizializza il calendario
document.addEventListener('DOMContentLoaded', () => {
    new BacheaCalendar();
});
