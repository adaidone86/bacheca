class BacheaCalendar {
    constructor() {
        this.currentDate = new Date();
        this.selectedDate = null;
        this.selectedColor = 'color-yellow';
        this.notes = this.loadNotes();
        this.isSyncing = false;
        this.editingNote = null; // Per tracciare quale nota stiamo editando
        this.isListView = false; // Toggle tra calendario e lista
        this.visibleColors = this.loadColorFilters(); // Colori visibili
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.detectDevice();
        this.loadVersion();
        // Carica da GitHub PRIMA di renderizzare
        this.loadFromGitHub().then(() => {
            this.render();
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

        document.getElementById('closeBtn').addEventListener('click', () => this.closeModal());
        document.getElementById('modal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('modal')) this.closeModal();
        });

        document.getElementById('noteForm').addEventListener('submit', (e) => this.addNote(e));

        document.querySelectorAll('.color-option').forEach(option => {
            option.addEventListener('click', (e) => {
                document.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected'));
                e.target.classList.add('selected');
                this.selectedColor = e.target.dataset.color;
            });
        });

        document.querySelectorAll('.edit-color-option').forEach(option => {
            option.addEventListener('click', (e) => {
                document.querySelectorAll('.edit-color-option').forEach(o => o.classList.remove('selected'));
                e.target.classList.add('selected');
                this.selectedColor = e.target.dataset.color;
            });
        });

        // Settings
        document.getElementById('settingsBtn').addEventListener('click', () => this.openSettings());
        document.getElementById('closeSettingsBtn').addEventListener('click', () => this.closeSettings());

        // Color filters
        document.querySelectorAll('.color-filter').forEach(checkbox => {
            checkbox.addEventListener('change', () => this.handleColorFilterChange());
        });

        // View Toggle
        document.getElementById('viewToggleBtn').addEventListener('click', () => this.toggleView());

        // Edit Modal
        document.getElementById('closeEditBtn').addEventListener('click', () => this.closeEditModal());
        document.getElementById('deleteNoteBtn').addEventListener('click', () => this.deleteCurrentNote());
        document.getElementById('saveEditBtn').addEventListener('click', () => this.saveEditedNote());
        document.getElementById('editModal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('editModal')) this.closeEditModal();
        });

        // GIF Modal
        document.getElementById('titleHeader').addEventListener('click', () => this.toggleGifModal());
        document.getElementById('gifModal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('gifModal')) this.toggleGifModal();
        });
    }

    render() {
        this.renderCalendar();
        this.updateHeader();
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

        // Giorni mese successivo
        const remainingDays = 42 - daysArray.length;
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
            dayEl.className = `day ${!dayObj.isCurrentMonth ? 'other-month' : ''}`;

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
                dayNotes.forEach((note, index) => {
                    // Mostra solo se il colore è visibile
                    if (!this.isColorVisible(note.color)) return;

                    const noteEl = document.createElement('div');
                    noteEl.className = `note ${note.color}`;
                    noteEl.style.cursor = 'pointer';

                    noteEl.innerHTML = `
                        <span class="note-text">${this.escapeHtml(note.title)}</span>
                        <button class="note-delete" type="button">✕</button>
                    `;

                    // Click per aprire il dettaglio
                    noteEl.querySelector('.note-text').addEventListener('click', () => {
                        this.openEditModal(dateKey, index);
                    });

                    // Delete button
                    noteEl.querySelector('.note-delete').addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.deleteNote(dateKey, index);
                    });

                    notesContainer.appendChild(noteEl);
                });
            }

            dayEl.addEventListener('click', () => this.openModal(dayObj.date));
            daysGrid.appendChild(dayEl);
        });
    }

    openModal(date) {
        this.selectedDate = date;
        document.getElementById('noteText').value = '';
        document.getElementById('modal').classList.add('active');
        document.getElementById('noteText').focus();

        const dateStr = date.toLocaleDateString('it-IT', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        document.getElementById('modalTitle').textContent = `Proposta per ${dateStr}`;
    }

    closeModal() {
        document.getElementById('modal').classList.remove('active');
        this.selectedDate = null;
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
            color: this.selectedColor
        });

        this.saveNotes();
        this.closeModal();
        this.renderCalendar();
    }

    deleteNote(dateKey, index) {
        if (this.notes[dateKey]) {
            this.notes[dateKey].splice(index, 1);
            if (this.notes[dateKey].length === 0) {
                delete this.notes[dateKey];
            }
            this.saveNotes();
            this.renderCalendar();
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

    today() {
        this.currentDate = new Date();
        this.render();
    }

    updateHeader() {
        const options = { year: 'numeric', month: 'long' };
        const monthYear = this.currentDate.toLocaleDateString('it-IT', options);
        document.getElementById('monthYear').textContent = monthYear.charAt(0).toUpperCase() + monthYear.slice(1);
    }

    saveNotes() {
        localStorage.setItem('bacheaNotes', JSON.stringify(this.notes));
    }

    loadNotes() {
        try {
            return JSON.parse(localStorage.getItem('bacheaNotes')) || {};
        } catch {
            return {};
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
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

        allEvents.sort((a, b) => a.date - b.date);

        // Filtra per colore visibile
        const visibleEvents = allEvents.filter(event => this.isColorVisible(event.color));

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

            eventEl.innerHTML = `
                <div class="event-date">${dateStr.charAt(0).toUpperCase() + dateStr.slice(1)}</div>
                <div class="event-title">${this.escapeHtml(event.title)}</div>
                ${event.time ? `<div class="event-time">🕐 ${this.escapeHtml(event.time)}</div>` : ''}
                ${event.location ? `<div class="event-location">📍 ${this.escapeHtml(event.location)}</div>` : ''}
                ${event.notes ? `<div class="event-notes">${this.escapeHtml(event.notes).replace(/\n/g, '<br>')}</div>` : ''}
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
        this.editingNote = { dateKey, noteIndex };
        const note = this.notes[dateKey][noteIndex];

        document.getElementById('editTitle').value = note.title || '';
        document.getElementById('editTime').value = note.time || '';
        document.getElementById('editLocation').value = note.location || '';
        document.getElementById('editNotes').value = note.notes || '';

        // Set colore
        document.querySelectorAll('.edit-color-option').forEach(o => o.classList.remove('selected'));
        document.querySelector(`.edit-color-option[data-color="${note.color}"]`).classList.add('selected');
        this.selectedColor = note.color;

        document.getElementById('editModal').classList.add('active');
    }

    closeEditModal() {
        document.getElementById('editModal').classList.remove('active');
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
            color: this.selectedColor
        };

        this.saveNotes();
        this.closeEditModal();
        this.renderCalendar();
    }

    deleteCurrentNote() {
        if (!this.editingNote) return;
        if (!confirm('Sei sicuro di voler eliminare questo evento?')) return;

        const { dateKey, noteIndex } = this.editingNote;
        this.deleteNote(dateKey, noteIndex);
        this.closeEditModal();
    }

    async loadFromGitHub() {
        try {
            // Prova a caricare dal file locale prima
            try {
                const response = await fetch('./json/data.json');
                if (response.ok) {
                    const content = await response.text();
                    const loadedNotes = JSON.parse(content);
                    this.notes = loadedNotes;
                    this.saveNotes();
                    return Promise.resolve();
                }
            } catch (localError) {
                // Se il file locale non esiste, prova GitHub
                console.log('File locale non trovato, tentando GitHub...');
            }

            // Fallback: leggi dal file pubblico su GitHub
            const response = await fetch(
                'https://raw.githubusercontent.com/adaidone86/bacheca/main/json/data.json'
            );

            if (response.ok) {
                const content = await response.text();
                const loadedNotes = JSON.parse(content);
                this.notes = loadedNotes;
                this.saveNotes();
                return Promise.resolve();
            }
        } catch (error) {
            console.error('Errore nel caricamento dei dati:', error);
        }
        return Promise.resolve();
    }

}

// Inizializza il calendario
document.addEventListener('DOMContentLoaded', () => {
    new BacheaCalendar();
});
