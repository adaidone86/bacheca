class BacheaCalendar {
    constructor() {
        this.currentDate = new Date();
        this.selectedDate = null;
        this.selectedColor = 'color-yellow';
        this.notes = this.loadNotes();
        this.gistToken = localStorage.getItem('gistToken') || null;
        this.gistId = localStorage.getItem('gistId') || null;
        this.isSyncing = false;
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.render();
        this.loadFromGist();
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

        // Gist setup
        document.getElementById('settingsBtn').addEventListener('click', () => this.openSettings());
        document.getElementById('closeSettingsBtn').addEventListener('click', () => this.closeSettings());
        document.getElementById('saveSettingsBtn').addEventListener('click', () => this.saveSettings());
        document.getElementById('syncBtn').addEventListener('click', () => this.syncGist());
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

            // Aggiungi le note al giorno
            const notesContainer = dayEl.querySelector(`#notes-${dateKey}`);
            if (dayNotes.length > 0) {
                notesContainer.innerHTML = '';
                dayNotes.forEach((note, index) => {
                    const noteEl = document.createElement('div');
                    noteEl.className = `note ${note.color}`;
                    noteEl.innerHTML = `
                        <span class="note-text">${this.escapeHtml(note.text)}</span>
                        <button class="note-delete" type="button">✕</button>
                    `;
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
        const text = document.getElementById('noteText').value.trim();
        if (!text || !this.selectedDate) return;

        const dateKey = this.getDateKey(this.selectedDate);
        if (!this.notes[dateKey]) {
            this.notes[dateKey] = [];
        }

        this.notes[dateKey].push({
            text,
            color: this.selectedColor
        });

        this.saveNotes();
        this.closeModal();
        this.renderCalendar();

        // Sincronizza automaticamente su Gist
        if (this.gistToken && this.gistId) {
            this.syncGist();
        }
    }

    deleteNote(dateKey, index) {
        if (this.notes[dateKey]) {
            this.notes[dateKey].splice(index, 1);
            if (this.notes[dateKey].length === 0) {
                delete this.notes[dateKey];
            }
            this.saveNotes();
            this.renderCalendar();

            // Sincronizza automaticamente su Gist
            if (this.gistToken && this.gistId) {
                this.syncGist();
            }
        }
    }

    getDateKey(date) {
        return date.toISOString().split('T')[0];
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

    // Gist methods
    openSettings() {
        document.getElementById('settingsModal').classList.add('active');
        document.getElementById('gistTokenInput').value = this.gistToken || '';
        document.getElementById('gistIdInput').value = this.gistId || '';
        this.updateSettingsStatus();
    }

    closeSettings() {
        document.getElementById('settingsModal').classList.remove('active');
    }

    updateSettingsStatus() {
        const status = document.getElementById('settingsStatus');
        if (this.gistToken && this.gistId) {
            status.innerHTML = '✅ Configurato correttamente';
            status.style.color = '#81c784';
        } else {
            status.innerHTML = '⚠️ Configurazione incompleta';
            status.style.color = '#ff6b9d';
        }
    }

    saveSettings() {
        const token = document.getElementById('gistTokenInput').value.trim();
        const gistId = document.getElementById('gistIdInput').value.trim();

        if (!token || !gistId) {
            alert('⚠️ Inserisci sia il token che l\'ID del Gist');
            return;
        }

        this.gistToken = token;
        this.gistId = gistId;
        localStorage.setItem('gistToken', token);
        localStorage.setItem('gistId', gistId);

        alert('✅ Impostazioni salvate! Sincronizzazione in corso...');
        this.closeSettings();
        this.syncGist();
    }

    async loadFromGist() {
        if (!this.gistToken || !this.gistId) return;

        try {
            const response = await fetch(`https://api.github.com/gists/${this.gistId}`, {
                headers: {
                    'Authorization': `token ${this.gistToken}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });

            if (response.ok) {
                const gist = await response.json();
                const content = Object.values(gist.files)[0].content;
                const loadedNotes = JSON.parse(content);
                this.notes = loadedNotes;
                this.saveNotes();
                this.renderCalendar();
            }
        } catch (error) {
            console.error('Errore nel caricamento da Gist:', error);
        }
    }

    async syncGist() {
        if (!this.gistToken || !this.gistId || this.isSyncing) return;

        this.isSyncing = true;
        const syncBtn = document.getElementById('syncBtn');
        syncBtn.textContent = '⟳ Sincronizzazione...';
        syncBtn.disabled = true;

        try {
            const response = await fetch(`https://api.github.com/gists/${this.gistId}`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `token ${this.gistToken}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    files: {
                        'bacheca-data.json': {
                            content: JSON.stringify(this.notes, null, 2)
                        }
                    }
                })
            });

            if (response.ok) {
                syncBtn.textContent = '✅ Sincronizzato!';
                setTimeout(() => {
                    syncBtn.textContent = '🔄 Sincronizza';
                    syncBtn.disabled = false;
                    this.isSyncing = false;
                }, 2000);
            }
        } catch (error) {
            console.error('Errore nella sincronizzazione:', error);
            syncBtn.textContent = '❌ Errore!';
            setTimeout(() => {
                syncBtn.textContent = '🔄 Sincronizza';
                syncBtn.disabled = false;
                this.isSyncing = false;
            }, 2000);
        }
    }
}

// Inizializza il calendario
document.addEventListener('DOMContentLoaded', () => {
    new BacheaCalendar();
});
