import { getAccessToken, getCurrentUser, signOut, usernameFromEmail } from './auth.js';

// Sostituisci questo URL solo se il dominio Render del servizio cambia.
const API_BASE = 'https://bellum-penumbrum-api.onrender.com';

let matchId = null;
let gameState = null;
let selectedHandCardId = null;
let selectedAttacker = null;
let selectedTarget = null;
let cardCache = new Map();
let busy = false;

function byId(id) {
  return document.getElementById(id);
}

function setGameMessage(message = '', kind = '') {
  const element = byId('game-message');
  element.textContent = message;
  element.className = `game-message ${kind}`.trim();
}

function setBusy(value) {
  busy = value;
  renderControls();
}

async function api(path, options = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error('Sessione assente. Effettua nuovamente il login.');

  const headers = {
    Authorization: `Bearer ${token}`,
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers ?? {}),
  };

  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Errore API (${response.status})`);
  return payload;
}

async function getCard(cardId) {
  if (cardCache.has(cardId)) return cardCache.get(cardId);
  const { card } = await api(`/cards/${cardId}`);
  cardCache.set(cardId, card);
  return card;
}

function getHuman() {
  return gameState?.players?.[1] ?? null;
}

function getAi() {
  return gameState?.players?.[0] ?? null;
}

function isHumanTurn() {
  return gameState?.status === 'running' && gameState?.active_player_index === 1 && gameState?.phase === 'main';
}

function clearSelection() {
  selectedHandCardId = null;
  selectedAttacker = null;
  selectedTarget = null;
}

function selectedModeText() {
  if (selectedHandCardId) return 'Carta selezionata: scegli una cella libera o un bersaglio valido.';
  if (selectedAttacker) return 'Attaccante selezionato: scegli una creatura IA o Attacca IA, poi conferma.';
  return 'Seleziona una carta dalla mano oppure una tua creatura per attaccare.';
}

async function createMatch() {
  setBusy(true);
  try {
    clearSelection();
    cardCache = new Map();
    setGameMessage('Creazione della partita…');
    const payload = await api('/match/create', { method: 'POST', body: {} });
    matchId = payload.match_id;
    gameState = payload.state;
    await refreshLogs();
    await render();
    setGameMessage('Partita pronta. È il tuo turno.', 'success');
  } catch (error) {
    setGameMessage(error instanceof Error ? error.message : 'Impossibile creare la partita.', 'error');
  } finally {
    setBusy(false);
  }
}

async function refreshState() {
  if (!matchId) return;
  const { state } = await api(`/match/${matchId}`);
  gameState = state;
}

async function refreshLogs() {
  if (!matchId) {
    byId('match-logs').innerHTML = '';
    return;
  }

  const { logs } = await api(`/match/${matchId}/logs?limit=50`);
  const list = byId('match-logs');
  list.innerHTML = '';

  for (const item of logs) {
    const entry = item.log_data ?? {};
    const line = document.createElement('li');
    line.textContent = entry.description ?? entry.action_type ?? 'Evento partita';
    list.appendChild(line);
  }
}

async function refreshAll() {
  await refreshState();
  await refreshLogs();
  await render();
}

function renderStatus() {
  if (!gameState) {
    byId('match-status').textContent = 'Nessuna partita';
    byId('turn-status').textContent = '—';
    byId('phase-status').textContent = '—';
    return;
  }

  const active = gameState.active_player_index === 1 ? 'Giocatore' : 'IA';
  byId('match-status').textContent = gameState.status === 'finished' ? 'Terminata' : 'In corso';
  byId('turn-status').textContent = `${gameState.current_turn} · ${active}`;
  byId('phase-status').textContent = gameState.phase;
}

function renderPlayerSummary() {
  const player = getHuman();
  const opponent = getAi();
  if (!player || !opponent) return;

  byId('player-life').textContent = String(player.life);
  byId('player-mana').textContent = `${player.current_mana} / ${player.max_mana}`;
  byId('player-hand-count').textContent = String(player.hand.length);
  byId('player-deck-count').textContent = String(player.deck.length);
  byId('player-graveyard-count').textContent = String(player.graveyard.length);

  byId('opponent-life').textContent = String(opponent.life);
  byId('opponent-hand-count').textContent = String(opponent.hand.length);
  byId('opponent-deck-count').textContent = String(opponent.deck.length);
  byId('opponent-graveyard-count').textContent = String(opponent.graveyard.length);
}

async function renderFieldSpell(player, elementId) {
  const container = byId(elementId);
  container.innerHTML = '';

  if (!player?.board?.field_spell) {
    container.textContent = 'Nessuna Terraforma';
    return;
  }

  const card = await getCard(player.board.field_spell.card_id);
  container.textContent = `Terraforma: ${card.name}`;
}

function boardCellElement({ ownerIndex, row, col, cell, card }) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'board-cell';
  element.dataset.owner = String(ownerIndex);
  element.dataset.row = String(row);
  element.dataset.col = String(col);

  const isAttacker = selectedAttacker && selectedAttacker.row === row && selectedAttacker.col === col;
  const isTarget = selectedTarget && selectedTarget.type === 'creature' && selectedTarget.ownerIndex === ownerIndex && selectedTarget.position.row === row && selectedTarget.position.col === col;

  if (!cell) {
    element.classList.add('empty');
    element.innerHTML = '<span class="empty-label">Vuoto</span>';
    element.addEventListener('click', () => onBoardCellClick(ownerIndex, row, col));
    return element;
  }

  element.classList.add(ownerIndex === 1 ? 'human-card' : 'ai-card');
  if (cell.tired) element.classList.add('tired');
  if (isAttacker) element.classList.add('selected-attacker');
  if (isTarget) element.classList.add('selected-target');

  const auraCount = cell.auras?.length ?? 0;
  element.innerHTML = `
    <span class="card-type">${card.card_type}</span>
    <strong class="card-name">${escapeHtml(card.name)}</strong>
    <span class="card-effect">${escapeHtml(card.effect_text ?? '')}</span>
    <span class="card-stats"><b>${cell.attack}</b><span>/</span><b>${cell.hp}</b></span>
    ${auraCount ? `<span class="aura-count">Aura: ${auraCount}</span>` : ''}
  `;

  element.addEventListener('click', () => onBoardCellClick(ownerIndex, row, col));
  return element;
}

async function renderBoard(player, ownerIndex, containerId) {
  const container = byId(containerId);
  container.innerHTML = '';

  for (let row = 0; row < 3; row += 1) {
    const rowElement = document.createElement('div');
    rowElement.className = 'board-row';

    for (let col = 0; col < 3; col += 1) {
      const cell = player.board.rows[row][col];
      const card = cell ? await getCard(cell.card_id) : null;
      rowElement.appendChild(boardCellElement({ ownerIndex, row, col, cell, card }));
    }

    container.appendChild(rowElement);
  }
}

function handCardElement(instanceId, card) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'hand-card';
  if (selectedHandCardId === instanceId) element.classList.add('selected-hand-card');

  element.innerHTML = `
    <span class="mana-cost">${card.mana_cost}</span>
    <span class="card-type">${card.card_type}</span>
    <strong class="hand-card-name">${escapeHtml(card.name)}</strong>
    <span class="hand-card-effect">${escapeHtml(card.effect_text ?? 'Nessun effetto.')}</span>
    <span class="hand-card-footer">${card.attack !== null && card.hp !== null ? `${card.attack}/${card.hp}` : card.rarity}</span>
  `;

  element.addEventListener('click', () => onHandCardClick(instanceId));
  return element;
}

async function renderHand() {
  const container = byId('player-hand');
  container.innerHTML = '';
  const player = getHuman();
  if (!player) return;

  for (const instanceId of player.hand) {
    const card = await getCard(instanceId);
    container.appendChild(handCardElement(instanceId, card));
  }
}

function renderControls() {
  const canAct = isHumanTurn() && !busy;
  byId('new-match-button').disabled = busy;
  byId('end-turn-button').disabled = !canAct;
  byId('refresh-button').disabled = !matchId || busy;
  byId('attack-button').disabled = !canAct || !selectedAttacker;
  byId('cancel-selection-button').disabled = busy || (!selectedHandCardId && !selectedAttacker && !selectedTarget);
  byId('opponent-player-target').disabled = !canAct || !selectedAttacker;
  byId('selection-instructions').textContent = selectedModeText();
}

async function render() {
  renderStatus();
  renderPlayerSummary();

  const player = getHuman();
  const opponent = getAi();
  if (player && opponent) {
    await Promise.all([
      renderFieldSpell(opponent, 'opponent-field-spell'),
      renderFieldSpell(player, 'player-field-spell'),
      renderBoard(opponent, 0, 'opponent-board'),
      renderBoard(player, 1, 'player-board'),
      renderHand(),
    ]);
  } else {
    byId('opponent-board').innerHTML = '';
    byId('player-board').innerHTML = '';
    byId('player-hand').innerHTML = '';
  }

  renderControls();
}

async function onHandCardClick(instanceId) {
  if (!isHumanTurn() || busy) return;
  selectedHandCardId = selectedHandCardId === instanceId ? null : instanceId;
  selectedAttacker = null;
  selectedTarget = null;
  await render();
}

async function onBoardCellClick(ownerIndex, row, col) {
  if (!isHumanTurn() || busy) return;
  const player = ownerIndex === 1 ? getHuman() : getAi();
  const cell = player.board.rows[row][col];

  if (selectedHandCardId) {
    const card = await getCard(selectedHandCardId);

    try {
      if (card.card_type === 'monster' || card.card_type === 'mostrissimo') {
        if (ownerIndex !== 1 || cell) {
          setGameMessage('Le creature devono essere giocate in una cella libera del tuo campo.', 'error');
          return;
        }
        await performPlayCard(selectedHandCardId, { position: { row, col } });
        return;
      }

      if (card.card_type === 'aura') {
        if (!cell) {
          setGameMessage('Un’Aura richiede una creatura come bersaglio.', 'error');
          return;
        }
        await performPlayCard(selectedHandCardId, { targetCardId: cell.instance_id });
        return;
      }

      if (card.card_type === 'terraforma' || card.card_type === 'sorcery' || card.card_type === 'instant') {
        await performPlayCard(selectedHandCardId, {});
        return;
      }
    } catch (error) {
      setGameMessage(error instanceof Error ? error.message : 'Mossa non valida.', 'error');
      return;
    }
  }

  if (ownerIndex === 1 && cell && !cell.tired) {
    selectedAttacker = selectedAttacker?.row === row && selectedAttacker?.col === col ? null : { row, col };
    selectedTarget = null;
    await render();
    return;
  }

  if (ownerIndex === 0 && cell && selectedAttacker) {
    selectedTarget = { type: 'creature', ownerIndex: 0, position: { row, col } };
    await render();
  }
}

async function performPlayCard(cardInstanceId, options) {
  setBusy(true);
  try {
    const { state } = await api(`/match/${matchId}/play-card`, {
      method: 'POST',
      body: { cardInstanceId, options },
    });
    gameState = state;
    clearSelection();
    await refreshLogs();
    await render();
    setGameMessage('Carta giocata.', 'success');
  } catch (error) {
    setGameMessage(error instanceof Error ? error.message : 'Impossibile giocare la carta.', 'error');
  } finally {
    setBusy(false);
  }
}

async function confirmAttack() {
  if (!selectedAttacker) {
    setGameMessage('Seleziona prima una creatura attaccante.', 'error');
    return;
  }

  const target = selectedTarget ?? { type: 'player', playerIndex: 0 };
  setBusy(true);

  try {
    const { state } = await api(`/match/${matchId}/attack`, {
      method: 'POST',
      body: { attackerPosition: selectedAttacker, target },
    });
    gameState = state;
    clearSelection();
    await refreshLogs();
    await render();
    setGameMessage('Attacco risolto.', 'success');
  } catch (error) {
    setGameMessage(error instanceof Error ? error.message : 'Impossibile attaccare.', 'error');
  } finally {
    setBusy(false);
  }
}

async function endHumanTurn() {
  if (!matchId) return;
  setBusy(true);

  try {
    setGameMessage('L’IA sta valutando la plancia…');
    const { state } = await api(`/match/${matchId}/end-turn`, { method: 'POST', body: {} });
    gameState = state;
    clearSelection();
    await refreshLogs();
    await render();
    setGameMessage(gameState.status === 'finished' ? 'La partita è terminata.' : 'È di nuovo il tuo turno.', 'success');
  } catch (error) {
    setGameMessage(error instanceof Error ? error.message : 'Impossibile terminare il turno.', 'error');
  } finally {
    setBusy(false);
  }
}

async function selectOpponentPlayerTarget() {
  if (!selectedAttacker || !isHumanTurn() || busy) return;
  selectedTarget = { type: 'player', playerIndex: 0 };
  await render();
}

async function handleLogout() {
  try {
    await signOut();
    matchId = null;
    gameState = null;
    clearSelection();
    cardCache = new Map();
  } catch (error) {
    setGameMessage(error instanceof Error ? error.message : 'Impossibile uscire.', 'error');
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function initializeGame() {
  const user = await getCurrentUser();
  if (!user) return;

  const username = usernameFromEmail(user.email ?? 'Giocatore');
  byId('signed-in-user').textContent = username;
  byId('player-title').textContent = username;

  byId('new-match-button').onclick = createMatch;
  byId('end-turn-button').onclick = endHumanTurn;
  byId('attack-button').onclick = confirmAttack;
  byId('cancel-selection-button').onclick = async () => {
    clearSelection();
    await render();
  };
  byId('opponent-player-target').onclick = selectOpponentPlayerTarget;
  byId('refresh-button').onclick = async () => {
    setBusy(true);
    try {
      await refreshAll();
      setGameMessage('Stato aggiornato.', 'success');
    } catch (error) {
      setGameMessage(error instanceof Error ? error.message : 'Impossibile aggiornare.', 'error');
    } finally {
      setBusy(false);
    }
  };
  byId('logout-button').onclick = handleLogout;

  await render();
}

window.addEventListener('bellum:auth-ready', () => {
  initializeGame().catch((error) => {
    setGameMessage(error instanceof Error ? error.message : 'Impossibile inizializzare il gioco.', 'error');
  });
});
