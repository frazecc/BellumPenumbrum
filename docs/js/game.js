/**
 * Gestione principale di gioco, rendering carte in mano, plancia e interazioni.
 */
import { updateHUD } from './hud.js';

let currentState = null;
let currentUser = null;
let selectedCard = null;

export function initGameEngine(user) {
  currentUser = user;
  setupEventListeners();
}

export function renderGameState(state) {
  currentState = state;
  updateHUD(state, currentUser);
  renderBoard(state);
  renderPlayerHand(state);
  renderLogs(state.logs || []);
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

function setupEventListeners() {
  const closeBtn = document.getElementById('card-modal-close');
  const modal = document.getElementById('card-modal');
  
  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
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
