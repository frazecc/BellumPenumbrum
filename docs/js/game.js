import {
  getAccessToken,
  getCurrentUser,
  signOut,
  usernameFromEmail,
} from './auth.js';

const API_BASE = 'https://bellum-penumbrum-api.onrender.com';
const REQUEST_TIMEOUT_MS = 45000;

let matchId = null;
let gameState = null;
let selectedHandInstanceId = null;
let selectedAttacker = null;
let selectedTarget = null;
let cardCache = new Map();
let busy = false;
let initialized = false;

function byId(id) {
  return document.getElementById(id);
}

function setGameMessage(message = '', kind = '') {
  const element = byId('game-message');

  if (!element) {
    return;
  }

  element.textContent = message;
  element.className = `game-message ${kind}`.trim();
}

function setBusy(value) {
  busy = value;
  renderControls();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getHuman() {
  return gameState?.players?.[1] ?? null;
}

function getAi() {
  return gameState?.players?.[0] ?? null;
}

function isHumanTurn() {
  return (
    gameState?.status === 'running' &&
    gameState?.active_player_index === 1 &&
    gameState?.phase === 'main'
  );
}

function clearSelection() {
  selectedHandInstanceId = null;
  selectedAttacker = null;
  selectedTarget = null;
}

function selectedModeText() {
  if (selectedHandInstanceId) {
    return 'Carta selezionata: scegli una cella libera o una creatura bersaglio.';
  }

  if (selectedAttacker) {
    return 'Attaccante selezionato: scegli una creatura IA oppure Attacca IA, poi conferma.';
  }

  return 'Seleziona una carta dalla mano oppure una tua creatura per attaccare.';
}

async function api(path, options = {}) {
  const token = await getAccessToken();

  if (!token) {
    throw new Error('Sessione assente. Effettua nuovamente il login.');
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        payload.error ?? `Errore API: risposta HTTP ${response.status}.`,
      );
    }

    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(
        'Il server Render non ha risposto entro 45 secondi. Riprova: il servizio Free potrebbe essersi appena riattivato.',
      );
    }

    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function getCard(cardId) {
  if (cardCache.has(cardId)) {
    return cardCache.get(cardId);
  }

  const { card } = await api(`/cards/${cardId}`);
  cardCache.set(cardId, card);

  return card;
}

function findHandInstance(instanceId) {
  return getHuman()?.hand?.find(
    (instance) => instance.instance_id === instanceId,
  ) ?? null;
}

function getCreatureAt(ownerIndex, row, col) {
  const player = ownerIndex === 1 ? getHuman() : getAi();

  return player?.board?.rows?.[row]?.[col] ?? null;
}

function isSelectedAttacker(ownerIndex, row, col) {
  return (
    ownerIndex === 1 &&
    selectedAttacker?.row === row &&
    selectedAttacker?.col === col
  );
}

function isSelectedTarget(ownerIndex, row, col) {
  return (
    selectedTarget?.type === 'creature' &&
    selectedTarget?.ownerIndex === ownerIndex &&
    selectedTarget?.position?.row === row &&
    selectedTarget?.position?.col === col
  );
}

async function createMatch() {
  if (busy) {
    return;
  }

  setBusy(true);
  clearSelection();
  cardCache = new Map();
  setGameMessage('Creazione della partita in corso…');

  try {
    const payload = await api('/match/create', {
      method: 'POST',
      body: {},
    });

    matchId = payload.match_id;
    gameState = payload.state;

    await refreshLogs();
    await render();

    setGameMessage('Partita pronta. È il tuo turno.', 'success');
  } catch (error) {
    setGameMessage(
      error instanceof Error
        ? error.message
        : 'Impossibile creare la partita.',
      'error',
    );
  } finally {
    setBusy(false);
  }
}

async function refreshState() {
  if (!matchId) {
    return;
  }

  const { state } = await api(`/match/${matchId}`);
  gameState = state;
}

async function refreshLogs() {
  const list = byId('match-logs');

  if (!list) {
    return;
  }

  if (!matchId) {
    list.innerHTML = '';
    return;
  }

  const { logs } = await api(`/match/${matchId}/logs?limit=50`);
  list.innerHTML = '';

  for (const item of logs) {
    const entry = item.log_data ?? {};
    const line = document.createElement('li');

    line.textContent =
      entry.description ??
      entry.action_type ??
      'Evento di partita';

    list.appendChild(line);
  }
}

async function refreshAll() {
  if (!matchId) {
    return;
  }

  await refreshState();
  await refreshLogs();
  await render();
}

function renderStatus() {
  const matchStatus = byId('match-status');
  const turnStatus = byId('turn-status');
  const phaseStatus = byId('phase-status');

  if (!matchStatus || !turnStatus || !phaseStatus) {
    return;
  }

  if (!gameState) {
    matchStatus.textContent = 'Nessuna partita';
    turnStatus.textContent = '—';
    phaseStatus.textContent = '—';
    return;
  }

  const activePlayer =
    gameState.active_player_index === 1
      ? 'Giocatore'
      : 'IA';

  matchStatus.textContent =
    gameState.status === 'finished'
      ? 'Terminata'
      : 'In corso';

  turnStatus.textContent =
    `${gameState.current_turn} · ${activePlayer}`;

  phaseStatus.textContent = gameState.phase;
}

function renderPlayerSummary() {
  const player = getHuman();
  const opponent = getAi();

  if (!player || !opponent) {
    return;
  }

  byId('player-life').textContent = String(player.life);
  byId('player-mana').textContent =
    `${player.current_mana} / ${player.max_mana}`;
  byId('player-hand-count').textContent = String(player.hand.length);
  byId('player-deck-count').textContent = String(player.deck.length);
  byId('player-graveyard-count').textContent = String(player.graveyard.length);

  byId('opponent-life').textContent = String(opponent.life);
  byId('opponent-hand-count').textContent = String(opponent.hand.length);
  byId('opponent-deck-count').textContent = String(opponent.deck.length);
  byId('opponent-graveyard-count').textContent = String(
    opponent.graveyard.length,
  );
}

async function renderFieldSpell(player, elementId) {
  const container = byId(elementId);

  if (!container) {
    return;
  }

  const fieldSpell = player?.board?.field_spell;

  if (!fieldSpell) {
    container.textContent = 'Nessuna Terraforma';
    return;
  }

  try {
    const card = await getCard(fieldSpell.card_id);
    container.textContent = `Terraforma: ${card.name}`;
  } catch {
    container.textContent = 'Terraforma attiva';
  }
}

function boardCellElement({ ownerIndex, row, col, cell, card }) {
  const element = document.createElement('button');

  element.type = 'button';
  element.className = 'board-cell';
  element.dataset.owner = String(ownerIndex);
  element.dataset.row = String(row);
  element.dataset.col = String(col);

  if (!cell) {
    element.classList.add('empty');
    element.innerHTML = '<span class="empty-label">Cella vuota</span>';

    element.addEventListener('click', () => {
      onBoardCellClick(ownerIndex, row, col).catch(showUnexpectedError);
    });

    return element;
  }

  element.classList.add(ownerIndex === 1 ? 'human-card' : 'ai-card');

  if (cell.tired) {
    element.classList.add('tired');
  }

  if (isSelectedAttacker(ownerIndex, row, col)) {
    element.classList.add('selected-attacker');
  }

  if (isSelectedTarget(ownerIndex, row, col)) {
    element.classList.add('selected-target');
  }

  const auraCount = cell.auras?.length ?? 0;
  const cardType = card?.card_type ?? 'creatura';
  const cardName = card?.name ?? 'Creatura sconosciuta';
  const effectText = card?.effect_text ?? '';

  element.innerHTML = `
    <span class="card-cost">${escapeHtml(card?.mana_cost ?? '')}</span>
    <span class="card-type">${escapeHtml(cardType)}</span>
    <strong class="card-name">${escapeHtml(cardName)}</strong>
    <span class="card-effect">${escapeHtml(effectText)}</span>
    <span class="card-stats">${cell.attack} / ${cell.hp}</span>
    ${auraCount > 0 ? `<span class="card-aura">Aura: ${auraCount}</span>` : ''}
  `;

  element.addEventListener('click', () => {
    onBoardCellClick(ownerIndex, row, col).catch(showUnexpectedError);
  });

  return element;
}

async function renderBoard(player, ownerIndex, containerId) {
  const container = byId(containerId);

  if (!container) {
    return;
  }

  container.innerHTML = '';

  for (let row = 0; row < 3; row += 1) {
    const rowElement = document.createElement('div');
    rowElement.className = 'board-row';

    for (let col = 0; col < 3; col += 1) {
      const cell = player?.board?.rows?.[row]?.[col] ?? null;
      let card = null;

      if (cell?.card_id) {
        try {
          card = await getCard(cell.card_id);
        } catch {
          card = null;
        }
      }

      rowElement.appendChild(
        boardCellElement({
          ownerIndex,
          row,
          col,
          cell,
          card,
        }),
      );
    }

    container.appendChild(rowElement);
  }
}

function handCardElement(instance, card) {
  const element = document.createElement('button');

  element.type = 'button';
  element.className = 'hand-card';

  if (selectedHandInstanceId === instance.instance_id) {
    element.classList.add('selected-hand-card');
  }

  const stats =
    card.attack !== null && card.attack !== undefined &&
    card.hp !== null && card.hp !== undefined
      ? `${card.attack} / ${card.hp}`
      : card.rarity ?? '';

  element.innerHTML = `
    <span class="card-cost">${escapeHtml(card.mana_cost)}</span>
    <span class="card-type">${escapeHtml(card.card_type)}</span>
    <strong class="card-name">${escapeHtml(card.name)}</strong>
    <span class="card-effect">${escapeHtml(
      card.effect_text ?? 'Nessun effetto.',
    )}</span>
    <span class="card-stats">${escapeHtml(stats)}</span>
  `;

  element.addEventListener('click', () => {
    onHandCardClick(instance.instance_id).catch(showUnexpectedError);
  });

  return element;
}

async function renderHand() {
  const container = byId('player-hand');
  const player = getHuman();

  if (!container) {
    return;
  }

  container.innerHTML = '';

  if (!player) {
    return;
  }

  for (const instance of player.hand) {
    try {
      const card = await getCard(instance.card_id);
      container.appendChild(handCardElement(instance, card));
    } catch {
      const fallback = document.createElement('button');

      fallback.type = 'button';
      fallback.className = 'hand-card';
      fallback.textContent = 'Carta non caricabile';

      container.appendChild(fallback);
    }
  }
}

function renderControls() {
  const canAct = isHumanTurn() && !busy;

  const newMatchButton = byId('new-match-button');
  const endTurnButton = byId('end-turn-button');
  const refreshButton = byId('refresh-button');
  const attackButton = byId('attack-button');
  const cancelButton = byId('cancel-selection-button');
  const opponentTarget = byId('opponent-player-target');
  const instructions = byId('selection-instructions');

  if (newMatchButton) {
    newMatchButton.disabled = busy;
  }

  if (endTurnButton) {
    endTurnButton.disabled = !canAct;
  }

  if (refreshButton) {
    refreshButton.disabled = !matchId || busy;
  }

  if (attackButton) {
    attackButton.disabled = !canAct || !selectedAttacker;
  }

  if (cancelButton) {
    cancelButton.disabled =
      busy ||
      (!selectedHandInstanceId && !selectedAttacker && !selectedTarget);
  }

  if (opponentTarget) {
    opponentTarget.disabled = !canAct || !selectedAttacker;
  }

  if (instructions) {
    instructions.textContent = selectedModeText();
  }
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
    const opponentBoard = byId('opponent-board');
    const playerBoard = byId('player-board');
    const playerHand = byId('player-hand');

    if (opponentBoard) opponentBoard.innerHTML = '';
    if (playerBoard) playerBoard.innerHTML = '';
    if (playerHand) playerHand.innerHTML = '';
  }

  renderControls();
}

async function onHandCardClick(instanceId) {
  if (!isHumanTurn() || busy) {
    return;
  }

  selectedHandInstanceId =
    selectedHandInstanceId === instanceId
      ? null
      : instanceId;

  selectedAttacker = null;
  selectedTarget = null;

  await render();
}

async function onBoardCellClick(ownerIndex, row, col) {
  if (!isHumanTurn() || busy) {
    return;
  }

  const cell = getCreatureAt(ownerIndex, row, col);

  if (selectedHandInstanceId) {
    const instance = findHandInstance(selectedHandInstanceId);

    if (!instance) {
      clearSelection();
      await render();
      return;
    }

    const card = await getCard(instance.card_id);

    if (
      card.card_type === 'monster' ||
      card.card_type === 'mostrissimo'
    ) {
      if (ownerIndex !== 1 || cell) {
        setGameMessage(
          'Le creature devono essere giocate in una cella libera del tuo campo.',
          'error',
        );
        return;
      }

      await performPlayCard(instance.instance_id, {
        position: { row, col },
      });

      return;
    }

    if (card.card_type === 'aura') {
      if (!cell) {
        setGameMessage(
          'Un’Aura richiede una creatura bersaglio.',
          'error',
        );
        return;
      }

      await performPlayCard(instance.instance_id, {
        targetInstanceId: cell.instance_id,
      });

      return;
    }

    const needsCreatureTarget =
      card.effect_json?.target === 'any_creature' ||
      card.effect_json?.type === 'return_hand';

    if (needsCreatureTarget) {
      if (!cell) {
        setGameMessage(
          'Questa carta richiede una creatura bersaglio.',
          'error',
        );
        return;
      }

      await performPlayCard(instance.instance_id, {
        targetInstanceId: cell.instance_id,
      });

      return;
    }

    await performPlayCard(instance.instance_id, {});
    return;
  }

  if (
    ownerIndex === 1 &&
    cell &&
    !cell.tired
  ) {
    const alreadySelected =
      selectedAttacker?.row === row &&
      selectedAttacker?.col === col;

    selectedAttacker = alreadySelected
      ? null
      : { row, col };

    selectedTarget = null;

    await render();
    return;
  }

  if (ownerIndex === 0 && cell && selectedAttacker) {
    selectedTarget = {
      type: 'creature',
      ownerIndex: 0,
      position: { row, col },
    };

    await render();
  }
}

async function performPlayCard(instanceId, options) {
  if (!matchId) {
    setGameMessage('Crea prima una nuova partita.', 'error');
    return;
  }

  setBusy(true);

  try {
    const { state } = await api(`/match/${matchId}/play-card`, {
      method: 'POST',
      body: {
        cardInstanceId: instanceId,
        options,
      },
    });

    gameState = state;
    clearSelection();

    await refreshLogs();
    await render();

    setGameMessage('Carta giocata.', 'success');
  } catch (error) {
    setGameMessage(
      error instanceof Error
        ? error.message
        : 'Impossibile giocare la carta.',
      'error',
    );
  } finally {
    setBusy(false);
  }
}

async function confirmAttack() {
  if (!matchId) {
    setGameMessage('Crea prima una nuova partita.', 'error');
    return;
  }

  if (!selectedAttacker) {
    setGameMessage('Seleziona prima una creatura attaccante.', 'error');
    return;
  }

  const target = selectedTarget ?? {
    type: 'player',
    playerIndex: 0,
  };

  setBusy(true);

  try {
    const { state } = await api(`/match/${matchId}/attack`, {
      method: 'POST',
      body: {
        attackerPosition: selectedAttacker,
        target,
      },
    });

    gameState = state;
    clearSelection();

    await refreshLogs();
    await render();

    setGameMessage('Attacco risolto.', 'success');
  } catch (error) {
    setGameMessage(
      error instanceof Error
        ? error.message
        : 'Impossibile risolvere l’attacco.',
      'error',
    );
  } finally {
    setBusy(false);
  }
}

async function endHumanTurn() {
  if (!matchId || busy) {
    return;
  }

  setBusy(true);
  setGameMessage('L’IA sta valutando la plancia…');

  try {
    const { state } = await api(`/match/${matchId}/end-turn`, {
      method: 'POST',
      body: {},
    });

    gameState = state;
    clearSelection();

    await refreshLogs();
    await render();

    setGameMessage(
      gameState.status === 'finished'
        ? 'La partita è terminata.'
        : 'È di nuovo il tuo turno.',
      'success',
    );
  } catch (error) {
    setGameMessage(
      error instanceof Error
        ? error.message
        : 'Impossibile terminare il turno.',
      'error',
    );
  } finally {
    setBusy(false);
  }
}

async function selectOpponentPlayerTarget() {
  if (!selectedAttacker || !isHumanTurn() || busy) {
    return;
  }

  selectedTarget = {
    type: 'player',
    playerIndex: 0,
  };

  await render();
}

async function handleLogout() {
  try {
    await signOut();

    matchId = null;
    gameState = null;
    cardCache = new Map();
    clearSelection();
  } catch (error) {
    setGameMessage(
      error instanceof Error
        ? error.message
        : 'Impossibile uscire.',
      'error',
    );
  }
}

function showUnexpectedError(error) {
  console.error(error);

  setGameMessage(
    error instanceof Error
      ? error.message
      : 'Errore inatteso durante l’azione.',
    'error',
  );
}

async function initializeGame() {
  if (initialized) {
    return;
  }

  const user = await getCurrentUser();

  if (!user) {
    return;
  }

  initialized = true;

  const username = usernameFromEmail(user.email ?? 'Giocatore');

  const signedInUser = byId('signed-in-user');
  const playerTitle = byId('player-title');

  if (signedInUser) {
    signedInUser.textContent = `@${username}`;
  }

  if (playerTitle) {
    playerTitle.textContent = username || 'Tu';
  }

  byId('new-match-button')?.addEventListener('click', () => {
    createMatch().catch(showUnexpectedError);
  });

  byId('end-turn-button')?.addEventListener('click', () => {
    endHumanTurn().catch(showUnexpectedError);
  });

  byId('attack-button')?.addEventListener('click', () => {
    confirmAttack().catch(showUnexpectedError);
  });

  byId('cancel-selection-button')?.addEventListener('click', () => {
    clearSelection();
    render().catch(showUnexpectedError);
  });
