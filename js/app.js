/**
 * Bellum Penumbrum - Main Application Logic
 * Gestisce l'interfaccia, il routing tra schermate e la logica di gioco base
 */

import {
    supabase,
    signUp,
    signIn,
    signOut,
    getSession,
    getCurrentUser,
    onAuthStateChange,
    getUserProfile,
    getUserStats,
    getCards,
    getFactions,
    createDeck,
    getUserDecks,
    getDeckCards,
    addCardToDeck,
    getExtraDeck,
    addMostrissimoToExtraDeck,
    createMatch,
    updateGameState,
    getUserMatches,
    getRandomAIProfile,
    initializeSupabase
} from './supabase_client.js';

// ============================================
// STATO GLOBALE DELL'APPLICAZIONE
// ============================================
const AppState = {
    currentUser: null,
    currentScreen: 'auth',
    factions: [],
    cards: [],
    currentDeck: null,
    currentMatch: null,
    gameState: null,
    isAuthenticating: false,
    isSignUp: false
};

// ============================================
// INIZIALIZZAZIONE
// ============================================
async function initializeApp() {
    console.log('Inizializzazione Bellum Penumbrum...');
    
    // Inizializza Supabase
    const supabaseInitialized = await initializeSupabase();
    if (!supabaseInitialized) {
        showAuthMessage('Errore di connessione al database', 'error');
        return;
    }
    
    // Carica le fazioni
    await loadFactions();
    
    // Carica le carte
    await loadCards();
    
    // Configura listener auth
    setupAuthListeners();
    
    // Controlla sessione esistente
    await checkExistingSession();
    
    console.log('App inizializzata');
}

// ============================================
// GESTIONE AUTENTICAZIONE
// ============================================
function setupAuthListeners() {
    onAuthStateChange(async (event, session) => {
        console.log('Evento auth:', event);
        
        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
            AppState.currentUser = session?.user;
            await navigateTo('dashboard');
            await loadUserProfile();
        } else if (event === 'SIGNED_OUT') {
            AppState.currentUser = null;
            AppState.currentDeck = null;
            AppState.currentMatch = null;
            await navigateTo('auth');
        }
    });
}

async function checkExistingSession() {
    const { session } = await getSession();
    
    if (session) {
        AppState.currentUser = session.user;
        await navigateTo('dashboard');
        await loadUserProfile();
    } else {
        await navigateTo('auth');
    }
}

function setupAuthForm() {
    const authForm = document.getElementById('auth-form');
    const authToggleLink = document.getElementById('auth-toggle-link');
    const authToggleText = document.getElementById('auth-toggle-text');
    const authFormTitle = document.getElementById('auth-form-title');
    const authSubmit = document.getElementById('auth-submit');
    const usernameGroup = document.getElementById('username-group');
    
    // Toggle tra login e signup
    authToggleLink.addEventListener('click', (e) => {
        e.preventDefault();
        AppState.isSignUp = !AppState.isSignUp;
        
        if (AppState.isSignUp) {
            authFormTitle.textContent = 'Registrati';
            authSubmit.textContent = 'Registrati';
            authToggleText.textContent = 'Hai già un account?';
            authToggleLink.textContent = 'Accedi';
            usernameGroup.style.display = 'block';
        } else {
            authFormTitle.textContent = 'Accedi';
            authSubmit.textContent = 'Accedi';
            authToggleText.textContent = 'Non hai un account?';
            authToggleLink.textContent = 'Registrati';
            usernameGroup.style.display = 'none';
        }
        
        hideAuthMessage();
    });
    
    // Submit form
    authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        const username = document.getElementById('username').value;
        
        hideAuthMessage();
        
        if (AppState.isSignUp) {
            // Signup
            if (!username || username.length < 3) {
                showAuthMessage('Username deve avere almeno 3 caratteri', 'error');
                return;
            }
            
            const result = await signUp(email, password, username);
            
            if (result.error) {
                showAuthMessage(result.error.message, 'error');
            } else {
                showAuthMessage('Registrazione completata! Controlla la tua email per la conferma.', 'success');
                // Reset form
                authForm.reset();
                AppState.isSignUp = false;
                authFormTitle.textContent = 'Accedi';
                authSubmit.textContent = 'Accedi';
                authToggleText.textContent = 'Non hai un account?';
                authToggleLink.textContent = 'Registrati';
                usernameGroup.style.display = 'none';
            }
        } else {
            // Login
            const result = await signIn(email, password);
            
            if (result.error) {
                showAuthMessage(result.error.message, 'error');
            } else {
                // Il redirect avviene tramite il listener onAuthStateChange
            }
        }
    });
    
    // Logout button
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            await signOut();
        });
    }
}

function showAuthMessage(message, type) {
    const messageEl = document.getElementById('auth-message');
    messageEl.textContent = message;
    messageEl.className = `auth-message ${type}`;
}

function hideAuthMessage() {
    const messageEl = document.getElementById('auth-message');
    messageEl.className = 'auth-message';
}

// ============================================
// NAVIGAZIONE TRA SCHERMATE
// ============================================
async function navigateTo(screenName) {
    console.log('Navigazione a:', screenName);
    
    // Nascondi tutte le schermate
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
    });
    
    // Mostra schermata target
    const targetScreen = document.getElementById(`${screenName}-screen`);
    if (targetScreen) {
        targetScreen.classList.add('active');
        AppState.currentScreen = screenName;
        
        // Callback specifiche per schermata
        switch(screenName) {
            case 'dashboard':
                await loadDashboard();
                break;
            case 'game':
                await initializeGame();
                break;
            case 'deckbuilder':
                await initializeDeckbuilder();
                break;
        }
    }
}

// ============================================
// DASHBOARD
// ============================================
async function loadDashboard() {
    await loadUserProfile();
    await loadUserStats();
}

async function loadUserProfile() {
    const userDisplay = document.getElementById('user-display');
    if (!userDisplay) return;
    
    const { profile } = await getUserProfile();
    if (profile) {
        userDisplay.textContent = `Ciao, ${profile.username}`;
    } else {
        const { user } = await getCurrentUser();
        userDisplay.textContent = user ? `Ciao, ${user.email}` : 'Ospite';
    }
}

async function loadUserStats() {
    const { stats } = await getUserStats();
    
    if (stats) {
        document.getElementById('stat-matches').textContent = stats.total_matches || 0;
        document.getElementById('stat-wins').textContent = stats.total_wins || 0;
        document.getElementById('stat-losses').textContent = stats.total_losses || 0;
        document.getElementById('stat-winrate').textContent = `${stats.win_rate || 0}%`;
    } else {
        document.getElementById('stat-matches').textContent = '0';
        document.getElementById('stat-wins').textContent = '0';
        document.getElementById('stat-losses').textContent = '0';
        document.getElementById('stat-winrate').textContent = '0%';
    }
}

function setupDashboardActions() {
    document.getElementById('btn-new-deck')?.addEventListener('click', () => {
        navigateTo('deckbuilder');
    });
    
    document.getElementById('btn-my-decks')?.addEventListener('click', async () => {
        await showMyDecks();
    });
    
    document.getElementById('btn-new-match')?.addEventListener('click', async () => {
        await startNewMatch();
    });
    
    document.getElementById('btn-match-history')?.addEventListener('click', async () => {
        await showMatchHistory();
    });
}

async function showMyDecks() {
    const { decks } = await getUserDecks();
    
    if (!decks || decks.length === 0) {
        alert('Non hai ancora creato mazzi. Creane uno nuovo!');
        return;
    }
    
    // TODO: Implementare UI per visualizzare e selezionare i mazzi
    console.log('Mazzi utente:', decks);
    alert(`Hai ${decks.length} mazzi. Funzionalità in sviluppo.`);
}

async function startNewMatch() {
    const { decks } = await getUserDecks();
    
    if (!decks || decks.length === 0) {
        alert('Devi prima creare un mazzo per giocare!');
        navigateTo('deckbuilder');
        return;
    }
    
    // Per ora usa il primo mazzo
    AppState.currentDeck = decks[0];
    
    // Crea la partita
    const { profile } = await getRandomAIProfile();
    
    const { match, error } = await createMatch({
        opponent_type: 'ai',
        opponent_name: profile ? `IA - ${profile.profile_name}` : 'IA Sconosciuta',
        opponent_faction_id: null // Sarà determinato dall'IA
    });
    
    if (error || !match) {
        alert('Errore nella creazione della partita: ' + (error?.message || 'Errore sconosciuto'));
        return;
    }
    
    AppState.currentMatch = match;
    navigateTo('game');
}

async function showMatchHistory() {
    const { matches } = await getUserMatches(20);
    
    if (!matches || matches.length === 0) {
        alert('Non hai ancora giocato nessuna partita.');
        return;
    }
    
    // TODO: Implementare UI per lo storico partite
    console.log('Storico partite:', matches);
    alert(`Hai giocato ${matches.length} partite. Funzionalità in sviluppo.`);
}

// ============================================
// DECKBUILDER
// ============================================
async function initializeDeckbuilder() {
    await populateFactionSelects();
    setupDeckbuilderActions();
}

async function populateFactionSelects() {
    const primarySelect = document.getElementById('faction-primary');
    const secondarySelect = document.getElementById('faction-secondary');
    const tertiarySelect = document.getElementById('faction-tertiary');
    
    if (!primarySelect || !secondarySelect || !tertiarySelect) return;
    
    // Pulisci opzioni
    primarySelect.innerHTML = '<option value="">Seleziona...</option>';
    secondarySelect.innerHTML = '<option value="">Seleziona...</option>';
    tertiarySelect.innerHTML = '<option value="">Random</option>';
    
    // Popola con fazioni (escludi Indrazzi per scelta principale)
    const factionsToChoose = AppState.factions.filter(f => f.code !== 'IND');
    
    factionsToChoose.forEach(faction => {
        const option1 = document.createElement('option');
        option1.value = faction.id;
        option1.textContent = faction.name;
        option1.style.color = faction.color_hex;
        primarySelect.appendChild(option1);
        
        const option2 = document.createElement('option');
        option2.value = faction.id;
        option2.textContent = faction.name;
        option2.style.color = faction.color_hex;
        secondarySelect.appendChild(option2);
    });
    
    // Listener per cambiamento fazioni
    primarySelect.addEventListener('change', handleFactionChange);
    secondarySelect.addEventListener('change', handleFactionChange);
}

async function handleFactionChange() {
    const primaryId = parseInt(document.getElementById('faction-primary').value);
    const secondaryId = parseInt(document.getElementById('faction-secondary').value);
    
    const tertiarySelect = document.getElementById('faction-tertiary');
    
    if (primaryId && secondaryId && primaryId === secondaryId) {
        alert('Le fazioni principale e secondaria devono essere diverse!');
        document.getElementById('faction-secondary').value = '';
        return;
    }
    
    if (primaryId && secondaryId) {
        // Scegli una terza fazione random dalle rimanenti
        const availableFactions = AppState.factions.filter(
            f => f.id !== primaryId && f.id !== secondaryId
        );
        
        if (availableFactions.length > 0) {
            const randomFaction = availableFactions[Math.floor(Math.random() * availableFactions.length)];
            tertiarySelect.innerHTML = `<option value="${randomFaction.id}">${randomFaction.name}</option>`;
        }
    } else {
        tertiarySelect.innerHTML = '<option value="">Random</option>';
    }
}

function setupDeckbuilderActions() {
    document.getElementById('btn-back-dashboard')?.addEventListener('click', () => {
        navigateTo('dashboard');
    });
    
    document.getElementById('btn-generate-deck')?.addEventListener('click', async () => {
        await generateDeck();
    });
}

async function generateDeck() {
    const primaryId = parseInt(document.getElementById('faction-primary').value);
    const secondaryId = parseInt(document.getElementById('faction-secondary').value);
    const tertiaryId = parseInt(document.getElementById('faction-tertiary').value);
    
    if (!primaryId || !secondaryId) {
        alert('Seleziona le fazioni principale e secondaria!');
        return;
    }
    
    // TODO: Implementare algoritmo di generazione mazzo
    // 1. Seleziona Boss Card (max o max-1 del colore principale)
    // 2. Genera 9 carte con curva mana 2.5-4
    // 3. Almeno 2 carte primario, 2 secondario, 1 terziario
    // 4. Seleziona 3 Mostrissimi compatibili
    
    console.log('Generazione mazzo:', { primaryId, secondaryId, tertiaryId });
    
    // Simulazione per ora
    alert('Generazione mazzo in sviluppo. Algoritmo da implementare.');
}

// ============================================
// GAME
// ============================================
async function initializeGame() {
    setupGameUI();
    await loadGameState();
}

function setupGameUI() {
    // Setup celle della griglia
    document.querySelectorAll('.cell').forEach(cell => {
        cell.addEventListener('click', handleCellClick);
        cell.addEventListener('mouseenter', handleCellHover);
        cell.addEventListener('mouseleave', handleCellLeave);
    });
    
    // Setup bottoni
    document.getElementById('btn-end-turn')?.addEventListener('click', endTurn);
    document.getElementById('btn-forfeit')?.addEventListener('click', forfeitMatch);
    document.getElementById('btn-undo')?.addEventListener('click', undoAction);
    
    // Setup popup
    document.getElementById('btn-play-instant')?.addEventListener('click', playInstant);
    document.getElementById('btn-pass')?.addEventListener('click', passPriority);
    document.getElementById('btn-cancel-target')?.addEventListener('click', cancelTargeting);
    document.getElementById('btn-acknowledge-lovecraft')?.addEventListener('click', acknowledgeLovecraft);
}

async function loadGameState() {
    if (!AppState.currentMatch) {
        console.error('Nessuna partita in corso');
        return;
    }
    
    // Inizializza stato di gioco vuoto se non esiste
    AppState.gameState = {
        turn: 1,
        phase: 0, // 0: Inizio, 1: Mantenimento, 2: Principale, 3: Fine
        player: {
            mana: 0,
            maxMana: 0,
            hand: [],
            board: [[null, null, null]], // Riga 2
            graveyard: [],
            faction: AppState.currentDeck?.primary_faction_id
        },
        opponent: {
            mana: 0,
            maxMana: 0,
            hand: [],
            board: [[null, null, null]], // Riga 0
            graveyard: [],
            faction: null
        },
        centerRow: [null, null, null], // Riga 1
        stack: [],
        priority: 'player' // 'player' o 'opponent'
    };
    
    updateGameUI();
}

function updateGameUI() {
    if (!AppState.gameState) return;
    
    // Aggiorna info turno e mana
    const phaseNames = ['Inizio', 'Mantenimento', 'Principale', 'Fine'];
    document.getElementById('game-turn-info').textContent = 
        `Turno ${AppState.gameState.turn} - Fase ${phaseNames[AppState.gameState.phase]}`;
    
    document.getElementById('game-mana-info').textContent = 
        `Mana: ${AppState.gameState.player.mana}/${AppState.gameState.player.maxMana}`;
    
    // Aggiorna griglia
    updateBoard();
    
    // Aggiorna mano
    updateHand();
}

function updateBoard() {
    // Pulisci tutte le celle
    document.querySelectorAll('.cell').forEach(cell => {
        cell.innerHTML = '';
        cell.classList.remove('occupied', 'targetable');
    });
    
    // Riga IA (0)
    if (AppState.gameState.opponent.board) {
        AppState.gameState.opponent.board[0]?.forEach((card, col) => {
            if (card) {
                const cell = document.querySelector(`.cell[data-row="0"][data-col="${col}"]`);
                if (cell) cell.appendChild(createCardElement(card));
            }
        });
    }
    
    // Riga Centrale (1)
    if (AppState.gameState.centerRow) {
        AppState.gameState.centerRow.forEach((card, col) => {
            if (card) {
                const cell = document.querySelector(`.cell[data-row="1"][data-col="${col}"]`);
                if (cell) cell.appendChild(createCardElement(card));
            }
        });
    }
    
    // Riga Giocatore (2)
    if (AppState.gameState.player.board) {
        AppState.gameState.player.board[0]?.forEach((card, col) => {
            if (card) {
                const cell = document.querySelector(`.cell[data-row="2"][data-col="${col}"]`);
                if (cell) cell.appendChild(createCardElement(card));
            }
        });
    }
}

function updateHand() {
    const handContainer = document.getElementById('player-hand');
    if (!handContainer) return;
    
    handContainer.innerHTML = '';
    
    if (AppState.gameState.player.hand) {
        AppState.gameState.player.hand.forEach((card, index) => {
            const cardEl = createCardElement(card);
            cardEl.dataset.handIndex = index;
            
            // Controlla se giocabile
            if (card.mana_cost <= AppState.gameState.player.mana) {
                cardEl.classList.add('playable');
                cardEl.addEventListener('click', () => playCardFromHand(index));
            } else {
                cardEl.classList.add('unplayable');
            }
            
            handContainer.appendChild(cardEl);
        });
    }
}

function createCardElement(card) {
    const cardEl = document.createElement('div');
    cardEl.className = `card faction-${card.faction?.code || 'IND'}`;
    
    cardEl.innerHTML = `
        <div class="card-image">${card.image || '🎴'}</div>
        <div class="card-info">
            <div class="card-name">${card.name}</div>
            <div class="card-type">${card.card_type}</div>
            <div class="card-stats">
                <span class="card-mana">⚡${card.mana_cost}</span>
                ${card.attack ? `<span class="card-atk">⚔${card.attack}</span>` : ''}
                ${card.hp ? `<span class="card-hp">❤${card.hp}</span>` : ''}
            </div>
        </div>
    `;
    
    return cardEl;
}

function handleCellClick(e) {
    const cell = e.currentTarget;
    const row = parseInt(cell.dataset.row);
    const col = parseInt(cell.dataset.col);
    
    console.log('Cella cliccata:', { row, col });
    
    // TODO: Implementare logica di interazione con le celle
    // - Attacco
    - Evocazione
    - Selezione bersaglio
}

function handleCellHover(e) {
    // TODO: Highlight celle valide per attacco/evocazione
}

function handleCellLeave(e) {
    // TODO: Rimuovi highlight
}

async function playCardFromHand(handIndex) {
    const card = AppState.gameState.player.hand[handIndex];
    
    if (!card || card.mana_cost > AppState.gameState.player.mana) {
        return;
    }
    
    console.log('Giocata carta:', card);
    
    // TODO: Implementare logica di giocata carta
    // - Decidere se è mostro, incantesimo, istantaneo
    // - Gestire bersagli se necessari
    // - Scalare mana
    // - Aggiornare stato
    
    // Simulazione
    AppState.gameState.player.mana -= card.mana_cost;
    updateGameUI();
}

function endTurn() {
    console.log('Fine turno');
    
    // TODO: Implementare transizione di fase/turno
    // Fase 3 (Fine) -> Fase 0 (Inizio) -> Fase 1 (Mantenimento) -> ...
    
    // Per ora solo update UI
    AppState.gameState.phase = (AppState.gameState.phase + 1) % 4;
    if (AppState.gameState.phase === 0) {
        AppState.gameState.turn++;
    }
    
    updateGameUI();
}

function forfeitMatch() {
    const confirmed = confirm('Sei sicuro di voler abbandonare la partita?');
    if (confirmed) {
        // TODO: Salvare sconfitta e tornare alla dashboard
        navigateTo('dashboard');
    }
}

function undoAction() {
    console.log('Annulla azione');
    // TODO: Implementare sistema di undo
}

// ============================================
// POPUP & FINESTRE
// ============================================
function showInstantPopup(eventDescription) {
    const popup = document.getElementById('instant-popup');
    const description = document.getElementById('instant-event-description');
    
    description.textContent = eventDescription;
    popup.style.display = 'flex';
}

function hideInstantPopup() {
    const popup = document.getElementById('instant-popup');
    popup.style.display = 'none';
}

function playInstant() {
    console.log('Gioca istantaneo');
    hideInstantPopup();
    // TODO: Implementare selezione e giocata istantaneo
}

function passPriority() {
    console.log('Passa priorità');
    hideInstantPopup();
    // TODO: Risolvi evento originale
}

function showTargetPopup(description) {
    const popup = document.getElementById('target-popup');
    const desc = document.getElementById('target-description');
    
    desc.textContent = description;
    popup.style.display = 'flex';
    
    // Highlight celle targettabili
    document.querySelectorAll('.cell').forEach(cell => {
        if (cell.classList.contains('occupied')) {
            cell.classList.add('targetable');
        }
    });
}

function hideTargetPopup() {
    const popup = document.getElementById('target-popup');
    popup.style.display = 'none';
    
    // Rimuovi highlight
    document.querySelectorAll('.cell').forEach(cell => {
        cell.classList.remove('targetable');
    });
}

function cancelTargeting() {
    hideTargetPopup();
}

function showLovecraftPopup(message) {
    const popup = document.getElementById('lovecraft-popup');
    const text = document.getElementById('lovecraft-text');
    
    text.textContent = message;
    popup.style.display = 'flex';
}

function hideLovecraftPopup() {
    const popup = document.getElementById('lovecraft-popup');
    popup.style.display = 'none';
}

function acknowledgeLovecraft() {
    hideLovecraftPopup();
    // TODO: Pulire la scacchiera e resettare la partita
    console.log('Pulizia scacchiera per anti-loop');
}

// ============================================
// CARICAMENTO DATI
// ============================================
async function loadFactions() {
    const { factions, error } = await getFactions();
    
    if (error) {
        console.error('Errore caricamento fazioni:', error);
        return;
    }
    
    AppState.factions = factions;
    console.log('Fazioni caricate:', factions.length);
}

async function loadCards() {
    const { cards, error } = await getCards();
    
    if (error) {
        console.error('Errore caricamento carte:', error);
        return;
    }
    
    AppState.cards = cards;
    console.log('Carte caricate:', cards.length);
}

// ============================================
// EVENT LISTeners GLOBALI
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM caricato');
    
    setupAuthForm();
    setupDashboardActions();
    
    initializeApp();
});

// ============================================
// FUNZIONI DI SUPPORTO
// ============================================

/**
 * Calcola la curva di mana media di un mazzo
 * @param {Array} cards - array di carte con mana_cost
 * @returns {number} - curva media
 */
function calculateManaCurve(cards) {
    if (!cards || cards.length === 0) return 0;
    
    const total = cards.reduce((sum, card) => sum + (card.mana_cost || 0), 0);
    return total / cards.length;
}

/**
 * Verifica se una carta è compatibile con un mazzo
 * @param {Object} card - carta da verificare
 * @param {Array} deckFactions - fazioni del mazzo
 * @returns {boolean}
 */
function isCardCompatible(card, deckFactions) {
    if (!card || !deckFactions) return false;
    
    // Indrazzi (incolore) sono sempre compatibili
    if (card.is_indrazzi || card.faction?.code === 'IND') {
        return true;
    }
    
    // Altrimenti deve essere una delle fazioni del mazzo
    return deckFactions.includes(card.faction_id);
}

/**
 * Seleziona una Boss Card dal catalogo
 * @param {Array} cards - tutte le carte
 * @param {number} primaryFactionId - fazione principale
 * @returns {Object|null} - boss card selezionata
 */
function selectBossCard(cards, primaryFactionId) {
    const bossCandidates = cards.filter(
        c => c.faction_id === primaryFactionId && c.card_type === 'monster'
    );
    
    if (bossCandidates.length === 0) return null;
    
    // Trova il mana cost massimo
    const maxMana = Math.max(...bossCandidates.map(c => c.mana_cost));
    
    // Filtra carte con mana max o max-1
    const validBosses = bossCandidates.filter(
        c => c.mana_cost === maxMana || c.mana_cost === maxMana - 1
    );
    
    // Scegline una a caso
    return validBosses[Math.floor(Math.random() * validBosses.length)];
}

// Esporta funzioni globali per debugging
window.BellumApp = {
    AppState,
    navigateTo,
    updateGameUI,
    showInstantPopup,
    showTargetPopup,
    showLovecraftPopup,
    calculateManaCurve,
    isCardCompatible,
    selectBossCard
};
