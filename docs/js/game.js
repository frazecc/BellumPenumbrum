/**
 * Gestione principale di gioco, rendering carte in mano, plancia e interazioni.
 */
import { updateHUD } from './hud.js';

let currentState = null;
let currentUser = null;
let selectedCard = null;
let apiBaseUrl = 'https://bellumpenumbrum.onrender.com'; // O URL relativo / personalizzato

export function setApiBaseUrl(url) {
  if (url) apiBaseUrl = url;
}

export function initGameEngine(user, options = {}) {
  currentUser = user;
  if (options.apiBaseUrl) {
    apiBaseUrl = options.apiBaseUrl;
  }
  setupEventListeners();
}

export function renderGameState(state) {
  currentState = state;
  updateHUD(state, currentUser);
  renderBoard(state);
  renderPlayerHand(state);
  renderLogs(state.logs || []);
  updateActionButtons(state);
}

/* RENDERING MANO GIOCATORE CON ICONE E TESTO LEGGIBILE */
function renderPlayerHand(state) {
  const handContainer = document.getElementById('player-hand');
  if (!handContainer) return;

  const isPlayer1 = state.player1_id === currentUser?.id;
  const hand = isPlayer1 ? state.player1_hand : state.player2_hand;

  handContainer.innerHTML = '';

  if (!hand || hand.length === 0) {
    handContainer.innerHTML = '<p class="muted">Nessuna carta in mano.</p>';
    return;
  }

  hand.forEach((card) => {
    const cardEl = document.createElement('div');
    cardEl.className = `card-item ${selectedCard?.instance_id === card.instance_id ? 'selected' : ''}`;
    
    cardEl.innerHTML = `
      <div class="card-header">
        <span class="card-title">${escapeHtml(card.name)}</span>
        <span class="card-mana">${card.mana_cost ?? 0}</span>
      </div>
      <div class="card-body-text">${escapeHtml(card.description || card.text || '')}</div>
      <div class="card-stats">
        <span class="card-stat-atk">⚔️ ${card.attack ?? 0}</span>
        <span class="card-stat-hp">❤️ ${card.hp ?? 0}</span>
      </div>
    `;

    // CLICK SULLA CARTA IN MANO: SELEZIONA E MOSTRA MODALE DETTAGLI
    cardEl.addEventListener('click', () => {
      selectedCard = card;
      renderPlayerHand(currentState);
      openCardModal(card);
    });

    handContainer.appendChild(cardEl);
  });
}

/* RENDERING PLANCIA 3x3 CON MINIATURA CARTA */
function renderBoard(state) {
  const boardContainer = document.getElementById('shared-board');
  if (!boardContainer) return;

  boardContainer.innerHTML = '';
  const grid = state.board || Array(9).fill(null);

  grid.forEach((cell, idx) => {
    const cellEl = document.createElement('div');
    cellEl.className = 'board-cell';
    cellEl.dataset.cellIndex = idx;

    if (cell) {
      cellEl.innerHTML = `
        <div class="board-card">
          <div class="board-card-title">${escapeHtml(cell.name)}</div>
          <div class="board-card-text">${escapeHtml(cell.text || '')}</div>
          <div class="card-stats">
            <span class="card-stat-atk">⚔️ ${cell.current_attack ?? cell.attack ?? 0}</span>
            <span class="card-stat-hp">❤️ ${cell.current_hp ?? cell.hp ?? 0}</span>
          </div>
        </div>
      `;
      cellEl.addEventListener('click', () => openCardModal(cell));
    }

    boardContainer.appendChild(cellEl);
  });
}

/* RENDERING CRONOLOGIA EVENTI */
function renderLogs(logs) {
  const logList = document.getElementById('match-logs');
  if (!logList) return;

  logList.innerHTML = '';
  logs.slice(-15).reverse().forEach(log => {
    const li = document.createElement('li');
    li.textContent = typeof log === 'string' ? log : log.message;
    logList.appendChild(li);
  });
}

/* AGGIORNAMENTO PULSANTI DI AZIONE */
function updateActionButtons(state) {
  const endTurnBtn = document.getElementById('end-turn-button');
  const directAttackBtn = document.getElementById('direct-attack-button');
  const cancelBtn = document.getElementById('cancel-selection-button');

  const isMyTurn = state && state.active_player_id === currentUser?.id;

  if (endTurnBtn) endTurnBtn.disabled = !isMyTurn;
  if (directAttackBtn) directAttackBtn.disabled = !isMyTurn;
  if (cancelBtn) cancelBtn.disabled = !selectedCard;
}

/* MODALE INGRANDIMENTO CARTA AL TOCCO */
function openCardModal(card) {
  const modal = document.getElementById('card-modal');
  const body = document.getElementById('card-modal-body');
  if (!modal || !body) return;

  body.innerHTML = `
    <h3 style="color:var(--accent-gold); margin-bottom:8px;">${escapeHtml(card.name)}</h3>
    <p style="font-size:0.9rem; margin-bottom:8px; color:#fff;">${escapeHtml(card.description || card.text || 'Nessun testo aggiuntivo.')}</p>
    <div style="display:flex; justify-content:space-between; font-weight:bold; font-size:1rem; margin-top:12px;">
      <span style="color:#3498db;">💎 Costo: ${card.mana_cost ?? 0}</span>
      <span style="color:#f1c40f;">⚔️ ATK: ${card.attack ?? card.current_attack ?? 0}</span>
      <span style="color:#e74c3c;">❤️ HP: ${card.hp ?? card.current_hp ?? 0}</span>
    </div>
  `;

  modal.classList.remove('hidden');
}

/* AVVIO DI UNA NUOVA PARTITA VIA API */
async function handleNewMatch() {
  const msgEl = document.getElementById('game-message');
  const newMatchBtn = document.getElementById('new-match-button');

  try {
    if (newMatchBtn) newMatchBtn.disabled = true;
    if (msgEl) msgEl.textContent = 'Creazione nuova partita in corso...';

    const token = localStorage.getItem('bp_token') || sessionStorage.getItem('bp_token');
    const response = await fetch(`${apiBaseUrl}/api/matches/new`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error(`Errore Server: ${response.status}`);
    }

    const data = await response.json();
    if (data.state) {
      renderGameState(data.state);
      if (msgEl) msgEl.textContent = 'Nuova partita avviata!';
    } else {
      if (msgEl) msgEl.textContent = 'Partita creata. In attesa di aggiornamento...';
    }
  } catch (err) {
    console.error('Errore creazione nuova partita:', err);
    if (msgEl) msgEl.textContent = 'Impossibile avviare una nuova partita.';
  } finally {
    if (newMatchBtn) newMatchBtn.disabled = false;
  }
}

function setupEventListeners() {
  const closeBtn = document.getElementById('card-modal-close');
  const modal = document.getElementById('card-modal');
  const newMatchBtn = document.getElementById('new-match-button');
  const cancelBtn = document.getElementById('cancel-selection-button');
  
  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  }

  if (newMatchBtn) {
    newMatchBtn.addEventListener('click', handleNewMatch);
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      selectedCard = null;
      if (currentState) renderPlayerHand(currentState);
      updateActionButtons(currentState);
    });
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
