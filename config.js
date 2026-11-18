/**
 * BACHECA - Configurazione Database
 *
 * Opzioni (obbligatorie: con un valore diverso l'app mostra un errore e non parte):
 * - 'TEST': Database di test (bacheca-test) - sviluppo in locale
 * - 'PROD': Database di produzione (bacheca-c0441) - COMMIT PER ANDARE LIVE
 */

const APP_CONFIG = {
    // SCEGLI QUI: 'TEST' | 'PROD'
    ENV: 'PROD',

    databases: {
        TEST: {
            name: '🧪 TEST - bacheca-test',
            apiKey: "AIzaSyBdpFXeROIUahwuGerPtVQGWM0FqVgiU-c",
            authDomain: "bacheca-test.firebaseapp.com",
            databaseURL: "https://bacheca-test-default-rtdb.europe-west1.firebasedatabase.app",
            projectId: "bacheca-test",
            storageBucket: "bacheca-test.firebasestorage.app",
            messagingSenderId: "505150719046",
            appId: "1:505150719046:web:5c4ad06acab8a41a383647"
        },
        PROD: {
            name: '✅ PRODUZIONE - bacheca-c0441',
            apiKey: "AIzaSyBGy1u-1qF5qv8234rkEvjvEunyJAiogd4",
            authDomain: "bacheca-c0441.firebaseapp.com",
            databaseURL: "https://bacheca-c0441-default-rtdb.europe-west1.firebasedatabase.app",
            projectId: "bacheca-c0441",
            storageBucket: "bacheca-c0441.firebasestorage.app",
            messagingSenderId: "800396955473",
            appId: "1:800396955473:web:2e0a0607a0666122a58d70"
        }
    },

    /**
     * Getter per la configurazione attuale (null se ENV non è 'TEST' o 'PROD')
     */
    getConfig() {
        if (!this.databases[this.ENV]) {
            console.error(`❌ Ambiente non riconosciuto: ${this.ENV}. Usa 'TEST' o 'PROD'.`);
            return null;
        }
        return this.databases[this.ENV];
    },

    /**
     * Getter per Firebase config
     */
    getFirebaseConfig() {
        const config = this.getConfig();
        if (!config) {
            return null;
        }
        return {
            apiKey: config.apiKey,
            authDomain: config.authDomain,
            databaseURL: config.databaseURL,
            projectId: config.projectId,
            storageBucket: config.storageBucket,
            messagingSenderId: config.messagingSenderId,
            appId: config.appId
        };
    }
};
