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
let selectedCreaturePosition = null;
let selectedActionMode = null;
let selectedAttackTarget = null;
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

function getBoard() {
  return gameState?.board?.rows ?? null;
}

function isHumanTurn() {
  return (
    gameState?.status === 'running' &&
    gameState?.active_player_index === 1 &&
    gameState?.phase === 'main'
  );
}

function positionsEqual(first, second) {
  return Boolean(
    first &&
      second &&
      first.row === second.row &&
      first.col === second.col,
  );
}

function isOrthogonallyAdjacent(first, second) {
  if (!first || !second) {
    return false;
  }

  return (
    Math.abs(first.row - second.row) +
      Math.abs(first.col - second.col) ===
    1
  );
}

function getCell(position) {
  return getBoard()?.[position.row]?.[position.col] ?? null;
}

function findHandInstance(instanceId) {
  return (
    getHuman()?.hand?.find(
      (instance) => instance.instance_id === instanceId,
    ) ?? null
  );
}

function findSelectedCreature() {
  if (!selectedCreaturePosition) {
    return null;
  }

  return getCell(selectedCreaturePosition);
}

function clearSelection() {
  selectedHandInstanceId = null;
  selectedCreaturePosition = null;
  selectedActionMode = null;
  selectedAttackTarget = null;
}

function selectedModeText() {
  if (selectedHandInstanceId) {
    return 'Carta selezionata: scegli una cella della tua riga o una creatura bersaglio.';
  }

  if (selectedActionMode === 'move') {
    return 'Movimento: scegli una cella libera ortogonalmente adiacente. Costa 1 mana e stanca la creatura.';
  }

  if (selectedActionMode === 'attack') {
    const targets = validAttackTargets();

    if (targets.length > 0) {
      return 'Attacco: scegli una creatura IA ortogonalmente adiacente.';
    }

    return 'Attacco diretto disponibile: non ci sono nemici IA ortogonalmente adiacenti.';
  }

  if (selectedCreaturePosition) {
    return 'Scegli Attacca o Muovi per la creatura selezionata.';
  }

  return 'Seleziona una carta per giocarla o una tua creatura pronta per scegliere Attacca o Muovi.';
}

function validMovePositions() {
  if (!selectedCreaturePosition || !selectedActionMode || selectedActionMode !== 'move') {
    return [];
  }

  const creature = getCell(selectedCreaturePosition);

  if (!creature || creature.owner_index !== 1 || creature.tired) {
    return [];
  }

  const candidates = [
    { row: selectedCreaturePosition.row - 1, col: selectedCreaturePosition.col },
    { row: selectedCreaturePosition.row + 1, col: selectedCreaturePosition.col },
    { row: selectedCreaturePosition.row, col: selectedCreaturePosition.col - 1 },
    { row: selectedCreaturePosition.row, col: selectedCreaturePosition.col + 1 },
  ];

  return candidates.filter((position) => {
    const inBoard =
      position.row >= 0 &&
      position.row <= 2 &&
      position.col >= 0 &&
      position.col <= 2;

    return inBoard && !getCell(position);
  });
}

function validAttackTargets() {
  if (!selectedCreaturePosition || selectedActionMode !== 'attack') {
    return [];
  }

  const creature = getCell(selectedCreaturePosition);

  if (!creature || creature.owner_index !== 1 || creature.tired) {
    return [];
  }

  const candidates = [
    { row: selectedCreaturePosition.row - 1, col: selectedCreaturePosition.col },
    { row: selectedCreaturePosition.row + 1, col: selectedCreaturePosition.col },
    { row: selectedCreaturePosition.row, col: selectedCreaturePosition.col - 1 },
    { row: selectedCreaturePosition.row, col: selectedCreaturePosition.col + 1 },
  ];

  return candidates.filter((position) => {
    const inBoard =
      position.row >= 0 &&
      position.row <= 2 &&
      position.col >= 0 &&
      position.col <= 2;

    const cell = inBoard ? getCell(position) : null;

    return cell?.owner_index === 0;
  });
}

function canDirectAttack() {
  return (
    selectedActionMode === 'attack' &&
    selectedCreaturePosition &&
    validAttackTargets().length === 0
  );
}

function setBusy(value) {
  busy = value;
  renderControls();
}

function renderControls() {
  const canAct = isHumanTurn() && !busy;
  const selectedCreature = findSelectedCreature();
  const canUseCreatureActions =
    canAct &&
    selectedCreature &&
    selectedCreature.owner_index === 1 &&
    !selectedCreature.tired;

  const newMatchButton = byId('new-match-button');
  const endTurnButton = byId('end-turn-button');
  const refreshButton = byId('refresh-button');
  const cancelButton = byId('cancel-selection-button');
  const directAttackButton = byId('direct-attack-button');
  const attackChoiceButton = byId('choose-attack-button');
  const moveChoiceButton = byId('choose-move-button');

  if (newMatchButton) {
    newMatchButton.disabled = busy;
  }

  if (endTurnButton) {
    endTurnButton.disabled = !canAct;
  }

  if (refreshButton) {
    refreshButton.disabled = !matchId || busy;
  }

  if (cancelButton) {
    cancelButton.disabled =
      busy ||
      (!selectedHandInstanceId &&
        !selectedCreaturePosition &&
        !selectedActionMode &&
        !selectedAttackTarget);
  }

  if (directAttackButton) {
    directAttackButton.disabled = !canAct || !canDirectAttack();
  }

  if (attackChoiceButton) {
    attackChoiceButton.disabled = !canUseCreatureActions;
  }

  if (moveChoiceButton) {
    const hasMana = (getHuman()?.current_mana ?? 0) >= 1;
    const hasDestination = validMovePositionsForSelectedCreature().length > 0;

    moveChoiceButton.disabled = !canUseCreatureActions || !hasMana || !hasDestination;
  }

  const instructions = byId('selection-instructions');

  if (instructions) {
    instructions.textContent = selectedModeText();
  }

  renderCreatureActionPanel();
}

function validMovePositionsForSelectedCreature() {
  if (!selectedCreaturePosition) {
    return [];
  }

  const creature = getCell(selectedCreaturePosition);

  if (!creature || creature.owner_index !== 1 || creature.tired) {
    return [];
  }

  const candidates = [
    { row: selectedCreaturePosition.row - 1, col: selectedCreaturePosition.col },
    { row: selectedCreaturePosition.row + 1, col: selectedCreaturePosition.col },
    { row: selectedCreaturePosition.row, col: selectedCreaturePosition.col - 1 },
    { row: selectedCreaturePosition.row, col: selectedCreaturePosition.col + 1 },
  ];

  return candidates.filter((position) => {
    const inBoard =
      position.row >= 0 &&
      position.row <= 2 &&
      position.col >= 0 &&
      position.col <= 2;

    return inBoard && !getCell(position);
  });
}

function renderCreatureActionPanel() {
  const panel = byId('creature-action-panel');
  const name = byId('selected-creature-name');
  const details = byId('selected-creature-details');

  if (!panel || !name || !details) {
    return;
  }

  const creature = findSelectedCreature();

  if (!creature || creature.owner_index !== 1 || creature.tired || !isHumanTurn()) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');

  const card = cardCache.get(creature.card_id);
  name.textContent = card?.name ?? 'Creatura selezionata';
  details.textContent =
    `ATK ${creature.attack} · HP ${creature.hp}/${creature.max_hp} · ` +
    `Attacca gratis oppure Muovi pagando 1 mana.`;
}

async function api(path, options = {}) {
  const token = await getAccessToken();

  if (!token) {
    throw new Error('Sessione assente. Effettua nuovamente il login.');
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => {
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
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(
        'Il server Render non ha risposto entro 45 secondi. Riprova: il servizio potrebbe essersi appena riattivato.',
      );
    }

    throw error;
  } finally {
    window.clearTimeout(timeoutId);
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

  const activeLabel =
    gameState.active_player_index === 1 ? 'Il tuo turno' : 'Turno IA';

  matchStatus.textContent =
    gameState.status === 'finished' ? 'Terminata' : 'In corso';

  turnStatus.textContent = `${gameState.current_turn} · ${activeLabel}`;
  phaseStatus.textContent = gameState.phase;
}

function renderPlayerSummary() {
  const player = getHuman();
  const opponent = getAi();

  if (!player || !opponent) {
    return;
  }

  const values = {
    'player-life': player.life,
    'player-mana': `${player.current_mana} / ${player.max_mana}`,
    'player-hand-count': player.hand.length,
    'player-deck-count': player.deck.length,
    'player-graveyard-count': player.graveyard.length,
    'opponent-life': opponent.life,
    'opponent-hand-count': opponent.hand.length,
    'opponent-deck-count': opponent.deck.length,
    'opponent-graveyard-count': opponent.graveyard.length,
  };

  for (const [id, value] of Object.entries(values)) {
    const element = byId(id);

    if (element) {
      element.textContent = String(value);
    }
  }
}

async function renderFieldSpell(player, elementId, ownerLabel) {
  const element = byId(elementId);

  if (!element) {
    return;
  }

  if (!player?.field_spell) {
    element.textContent = `${ownerLabel}: Nessuna Terraforma`;
    return;
  }

  try {
    const card = await getCard(player.field_spell.card_id);
    element.textContent = `${ownerLabel}: ${card.name}`;
  } catch {
    element.textContent = `${ownerLabel}: Terraforma attiva`;
  }
}

function positionClass(row) {
  if (row === 0) {
    return 'ai-row';
  }

  if (row === 1) {
    return 'center-row';
  }

  return 'human-row';
}

function isValidMoveCell(position) {
  return validMovePositions().some((candidate) =>
    positionsEqual(candidate, position),
  );
}

function isValidTargetCell(position) {
  return validAttackTargets().some((candidate) =>
    positionsEqual(candidate, position),
  );
}

function boardCellElement(position, cell, card) {
  const button = document.createElement('button');

  button.type = 'button';
  button.className = 'board-cell';
  button.dataset.row = String(position.row);
  button.dataset.col = String(position.col);

  const selectedCreature = positionsEqual(position, selectedCreaturePosition);
  const selectedTarget = positionsEqual(position, selectedAttackTarget);

  if (!cell) {
    button.classList.add('empty');

    if (isValidMoveCell(position)) {
      button.classList.add('valid-move');
    }

    button.innerHTML = `
      <span class="empty-label">Cella libera</span>
      <span class="cell-coordinate">[${position.row},${position.col}]</span>
    `;

    button.addEventListener('click', () => {
      onBoardCellClick(position).catch(showUnexpectedError);
    });

    return button;
  }

  button.classList.add(cell.owner_index === 1 ? 'human-card' : 'ai-card');

  if (cell.tired) {
    button.classList.add('tired');
  }

  if (selectedCreature) {
    button.classList.add('selected-creature');
  }

  if (isValidTargetCell(position)) {
    button.classList.add('valid-target');
  }

  if (selectedTarget) {
    button.classList.add('selected-target');
  }

  const ownerName = cell.owner_index === 1 ? 'Tua creatura' : 'Creatura IA';
  const auraCount = cell.auras?.length ?? 0;

  button.innerHTML = `
    <span class="cell-coordinate">[${position.row},${position.col}]</span>
    <span class="card-cost">${escapeHtml(card?.mana_cost ?? '')}</span>
    <span class="card-type">${escapeHtml(card?.card_type ?? 'creatura')}</span>
    <strong class="card-name">${escapeHtml(card?.name ?? 'Creatura sconosciuta')}</strong>
    <span class="card-effect">${escapeHtml(card?.effect_text ?? '')}</span>
    <span class="card-owner">${ownerName}${cell.tired ? ' · Stanca' : ' · Pronta'}</span>
    <span class="card-stats">${cell.attack} / ${cell.hp}</span>
    ${auraCount > 0 ? `<span class="card-aura">Aura: ${auraCount}</span>` : ''}
  `;

  button.addEventListener('click', () => {
    onBoardCellClick(position).catch(showUnexpectedError);
  });

  return button;
}

async function renderBoard() {
  const container = byId('shared-board');

  if (!container) {
    return;
  }

  container.innerHTML = '';

  const board = getBoard();

  if (!board) {
    return;
  }

  for (let row = 0; row < 3; row += 1) {
    const rowElement = document.createElement('div');
    rowElement.className = `board-row ${positionClass(row)}`;

    for (let col = 0; col < 3; col += 1) {
      const position = { row, col };
      const cell = board[row][col];
      let card = null;

      if (cell?.card_id) {
        try {
          card = await getCard(cell.card_id);
        } catch {
          card = null;
        }
      }

      rowElement.appendChild(boardCellElement(position, cell, card));
    }

    container.appendChild(rowElement);
  }
}

function handCardElement(instance, card) {
  const button = document.createElement('button');

  button.type = 'button';
  button.className = 'hand-card';

  if (selectedHandInstanceId === instance.instance_id) {
    button.classList.add('selected-hand-card');
  }

  const stats =
    card.attack !== null &&
    card.attack !== undefined &&
    card.hp !== null &&
    card.hp !== undefined
      ? `${card.attack} / ${card.hp}`
      : card.rarity ?? '';

  button.innerHTML = `
    <span class="card-cost">${escapeHtml(card.mana_cost)}</span>
    <span class="card-type">${escapeHtml(card.card_type)}</span>
    <strong class="card-name">${escapeHtml(card.name)}</strong>
    <span class="card-effect">${escapeHtml(card.effect_text ?? 'Nessun effetto.')}</span>
    <span class="card-stats">${escapeHtml(stats)}</span>
  `;

  button.addEventListener('click', () => {
    onHandCardClick(instance.instance_id).catch(showUnexpectedError);
  });

  return button;
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
      fallback.disabled = true;
      fallback.textContent = 'Carta non caricabile';

      container.appendChild(fallback);
    }
  }
}

async function render() {
  renderStatus();
  renderPlayerSummary();

  await Promise.all([
    renderFieldSpell(getAi(), 'opponent-field-spell', 'IA'),
    renderFieldSpell(getHuman(), 'player-field-spell', 'Tu'),
    renderBoard(),
    renderHand(),
  ]);

  renderControls();
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

  const { logs } = await api(`/match/${matchId}/logs?limit=100`);
  list.innerHTML = '';

  for (const item of logs) {
    const entry = item.log_data ?? {};
    const line = document.createElement('li');

    line.textContent =
      entry.description ??
      entry.action_type ??
      'Evento partita';

    list.appendChild(line);
  }

  list.scrollTop = list.scrollHeight;
}

async function refreshAll() {
  await refreshState();
  await refreshLogs();
  await render();
}

async function createMatch() {
  if (busy) {
    return;
  }

  setBusy(true);
  clearSelection();
  cardCache = new Map();
  setGameMessage('Creazione della partita tattica in corso…');

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

async function onHandCardClick(instanceId) {
  if (!isHumanTurn() || busy) {
    return;
  }

  selectedHandInstanceId =
    selectedHandInstanceId === instanceId ? null : instanceId;

  selectedCreaturePosition = null;
  selectedActionMode = null;
  selectedAttackTarget = null;

  await render();
}

async function onBoardCellClick(position) {
  if (!isHumanTurn() || busy) {
    return;
  }

  const cell = getCell(position);

  if (selectedHandInstanceId) {
    await handleCardPlacementOrTarget(position, cell);
    return;
  }

  if (selectedActionMode === 'move') {
    if (!isValidMoveCell(position)) {
      setGameMessage('Scegli una cella libera ortogonalmente adiacente.', 'error');
      return;
    }

    await performMove(selectedCreaturePosition, position);
    return;
  }

  if (selectedActionMode === 'attack') {
    if (cell?.owner_index === 0 && isValidTargetCell(position)) {
      selectedAttackTarget = position;
      await performAttack({
        type: 'creature',
        position,
      });
      return;
    }

    setGameMessage('Scegli una creatura IA ortogonalmente adiacente.', 'error');
    return;
  }

  if (cell?.owner_index === 1) {
    if (cell.tired) {
      setGameMessage('Questa creatura è stanca: non può attaccare né muoversi.', 'error');
      return;
    }

    selectedCreaturePosition = position;
    selectedHandInstanceId = null;
    selectedActionMode = null;
    selectedAttackTarget = null;

    await preloadSelectedCard(cell.card_id);
    await render();
    return;
  }

  if (cell?.owner_index === 0) {
    setGameMessage('Seleziona prima una tua creatura pronta.', 'error');
  }
}

async function preloadSelectedCard(cardId) {
  try {
    await getCard(cardId);
  } catch {
    return;
  }
}

async function handleCardPlacementOrTarget(position, cell) {
  const instance = findHandInstance(selectedHandInstanceId);

  if (!instance) {
    clearSelection();
    await render();
    return;
  }

  const card = await getCard(instance.card_id);

  if (card.card_type === 'monster' || card.card_type === 'mostrissimo') {
    if (position.row !== 2 || cell) {
      setGameMessage(
        'Puoi evocare creature solo in una cella libera della tua riga inferiore.',
        'error',
      );
      return;
    }

    await performPlayCard(instance.instance_id, {
      position,
    });

    return;
  }

  if (card.card_type === 'aura') {
    if (!cell) {
      setGameMessage('Un’Aura richiede una creatura bersaglio.', 'error');
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
}

async function chooseAttack() {
  const creature = findSelectedCreature();

  if (!creature || creature.owner_index !== 1 || creature.tired) {
    return;
  }

  selectedActionMode = 'attack';
  selectedAttackTarget = null;
  selectedHandInstanceId = null;

  await render();

  if (canDirectAttack()) {
    setGameMessage(
      'Nessun nemico IA è adiacente: puoi attaccare direttamente l’IA.',
      'success',
    );
  } else {
    setGameMessage(
      'Seleziona una creatura IA ortogonalmente adiacente.',
      'success',
    );
  }
}

async function chooseMove() {
  const creature = findSelectedCreature();
  const player = getHuman();

  if (!creature || creature.owner_index !== 1 || creature.tired) {
    return;
  }

  if ((player?.current_mana ?? 0) < 1) {
    setGameMessage('Servono 1 mana per muovere una creatura.', 'error');
    return;
  }

  if (validMovePositionsForSelectedCreature().length === 0) {
    setGameMessage('Non esistono celle libere ortogonalmente adiacenti.', 'error');
    return;
  }

  selectedActionMode = 'move';
  selectedAttackTarget = null;
  selectedHandInstanceId = null;

  await render();
  setGameMessage('Scegli una cella libera adiacente per muovere la creatura.', 'success');
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

async function performMove(from, to) {
  if (!matchId) {
    setGameMessage('Crea prima una nuova partita.', 'error');
    return;
  }

  setBusy(true);

  try {
    const { state } = await api(`/match/${matchId}/move`, {
      method: 'POST',
      body: {
        from,
        to,
      },
    });

    gameState = state;
    clearSelection();

    await refreshLogs();
    await render();

    setGameMessage('Creatura mossa: 1 mana speso e creatura stanca.', 'success');
  } catch (error) {
    setGameMessage(
      error instanceof Error
        ? error.message
        : 'Impossibile muovere la creatura.',
      'error',
    );
  } finally {
    setBusy(false);
  }
}

async function performAttack(target) {
  if (!matchId || !selectedCreaturePosition) {
    setGameMessage('Seleziona prima una creatura attaccante.', 'error');
    return;
  }

  setBusy(true);

  try {
    const { state } = await api(`/match/${matchId}/attack`, {
      method: 'POST',
      body: {
        attackerPosition: selectedCreaturePosition,
        target,
      },
    });

    gameState = state;
    clearSelection();

    await refreshLogs();
    await render();

    setGameMessage('Attacco risolto. La creatura ora è stanca.', 'success');
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

async function performDirectAttack() {
  if (!canDirectAttack()) {
    setGameMessage(
      'L’attacco diretto è disponibile solo se nessun nemico IA è ortogonalmente adiacente.',
      'error',
    );
    return;
  }

  await performAttack({
    type: 'player',
    playerIndex: 0,
  });
}

async function endHumanTurn() {
  if (!matchId || busy) {
    return;
  }

  setBusy(true);
  setGameMessage('L’IA sta valutando la scacchiera…');

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

async function handleRefresh() {
  if (!matchId || busy) {
    return;
  }

  setBusy(true);

  try {
    await refreshAll();
    setGameMessage('Stato aggiornato.', 'success');
  } catch (error) {
    setGameMessage(
      error instanceof Error
        ? error.message
        : 'Impossibile aggiornare lo stato.',
      'error',
    );
  } finally {
    setBusy(false);
  }
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

  byId('choose-attack-button')?.addEventListener('click', () => {
    chooseAttack().catch(showUnexpectedError);
  });

  byId('choose-move-button')?.addEventListener('click', () => {
    chooseMove().catch(showUnexpectedError);
  });

  byId('cancel-creature-action-button')?.addEventListener('click', () => {
    clearSelection();
    render().catch(showUnexpectedError);
  });

  byId('direct-attack-button')?.addEventListener('click', () => {
    performDirectAttack().catch(showUnexpectedError);
  });

  byId('cancel-selection-button')?.addEventListener('click', () => {
    clearSelection();
    render().catch(showUnexpectedError);
  });

  byId('end-turn-button')?.addEventListener('click', () => {
    endHumanTurn().catch(showUnexpectedError);
  });

  byId('refresh-button')?.addEventListener('click', () => {
    handleRefresh().catch(showUnexpectedError);
  });

  byId('logout-button')?.addEventListener('click', () => {
    handleLogout().catch(showUnexpectedError);
  });

  await render();
}

window.addEventListener('bellum:auth-ready', () => {
  initializeGame().catch(showUnexpectedError);
});

getCurrentUser()
  .then((user) => {
    if (user) {
      return initializeGame();
    }

    return undefined;
  })
  .catch(showUnexpectedError);