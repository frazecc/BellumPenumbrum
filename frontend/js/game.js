// js/game.js

const API_BASE = 'https://bellum-api.onrender.com'; // SOSTITUISCI con il tuo dominio

let matchId = null;
let gameState = null;

let selectedCardId = null;
let selectedAttacker = null;
let selectedTarget = null;

const cardDataCache = new Map();

async function callApi(path, body) {
  const token = localStorage.getItem('sb-token');
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(API_BASE + path, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }

  return res.json();
}

async function loadCardData(cardId) {
  if (cardDataCache.has(cardId)) {
    return cardDataCache.get(cardId);
  }
  const { card } = await callApi(`/cards/${cardId}`);
  cardDataCache.set(cardId, card);
  return card;
}

async function initGame() {
  try {
    const { state } = await callApi('/match/create', {});
    matchId = state.match_id;
    gameState = state;
    render();
    loadLogs();
  } catch (err) {
    alert('Errore nella creazione della partita: ' + err.message);
  }
}

async function loadState() {
  const { state } = await callApi(`/match/${matchId}`);
  gameState = state;
  render();
}

async function loadLogs() {
  const { logs } = await callApi(`/match/${matchId}/logs?limit=50`);
  const logList = document.getElementById('log-list');
  logList.innerHTML = '';
  for (const log of logs) {
    const div = document.createElement('div');
    div.textContent = log.description;
    logList.appendChild(div);
  }
}

async function render() {
  if (!gameState) return;

  const player = gameState.players[1];
  const opponent = gameState.players[0];

  document.getElementById('player-life').textContent = player.life;
  document.getElementById('player-mana').textContent =
    `${player.current_mana}/${player.max_mana}`;

  document.getElementById('opponent-life').textContent = opponent.life;

  const opponentBoardEl = document.getElementById('opponent-board');
  opponentBoardEl.innerHTML = '';
  for (let r = 0; r < 3; r++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    for (let c = 0; c < 3; c++) {
      const cellEl = document.createElement('div');
      cellEl.className = 'cell';
      const cell = opponent.board.rows[r][c];
      if (cell) {
        const card = await loadCardData(cell.card_id);
        const cardEl = renderCardOnBoard(cell, card, r, c, 'opponent');
        cellEl.appendChild(cardEl);
      }
      cellEl.addEventListener('click', () => onOpponentCellClick(r, c));
      rowEl.appendChild(cellEl);
    }
    opponentBoardEl.appendChild(rowEl);
  }

  const playerBoardEl = document.getElementById('player-board');
  playerBoardEl.innerHTML = '';
  for (let r = 0; r < 3; r++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    for (let c = 0; c < 3; c++) {
      const cellEl = document.createElement('div');
      cellEl.className = 'cell';
      const cell = player.board.rows[r][c];
      if (cell) {
        const card = await loadCardData(cell.card_id);
        const cardEl = renderCardOnBoard(cell, card, r, c, 'player');
        cellEl.appendChild(cardEl);
      }
      cellEl.addEventListener('click', () => onPlayerCellClick(r, c));
      rowEl.appendChild(cellEl);
    }
    playerBoardEl.appendChild(rowEl);
  }

  const handEl = document.getElementById('hand-cards');
  handEl.innerHTML = '';
  for (const cardId of player.hand) {
    const card = await loadCardData(cardId);
    const cardEl = renderHandCard(cardId, card);
    handEl.appendChild(cardEl);
  }

  const btnNext = document.getElementById('btn-next-turn');
  const btnEnd = document.getElementById('btn-end-turn');
  const btnAttack = document.getElementById('btn-attack');

  btnNext.onclick = onNextTurn;
  btnEnd.onclick = onEndTurn;
  btnAttack.onclick = onAttack;

  btnAttack.disabled = !selectedAttacker;
}

function renderCardOnBoard(cell, card, row, col, owner) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = card.name;
  cardEl.appendChild(name);

  const stats = document.createElement('div');
  stats.className = 'stats';
  stats.textContent = `${cell.attack}/${cell.hp}`;
  cardEl.appendChild(stats);

  if (cell.tired) {
    cardEl.classList.add('tired');
  }

  if (
    selectedAttacker &&
    selectedAttacker.row === row &&
    selectedAttacker.col === col &&
    selectedAttacker.owner === owner
  ) {
    cardEl.classList.add('selected');
  }

  if (
    selectedTarget &&
    selectedTarget.type === 'creature' &&
    selectedTarget.ownerIndex === (owner === 'player' ? 1 : 0) &&
    selectedTarget.row === row &&
    selectedTarget.col === col
  ) {
    cardEl.classList.add('target');
  }

  return cardEl;
}

function renderHandCard(cardId, card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'hand-card';

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = card.name;
  cardEl.appendChild(name);

  const cost = document.createElement('div');
  cost.className = 'cost';
  cost.textContent = `Costo: ${card.mana_cost}`;
  cardEl.appendChild(cost);

  const effect = document.createElement('div');
  effect.className = 'effect';
  effect.textContent = card.effect_text || '';
  cardEl.appendChild(effect);

  if (cardId === selectedCardId) {
    cardEl.classList.add('selected');
  }

  cardEl.addEventListener('click', () => onHandCardClick(cardId));
  return cardEl;
}

async function onHandCardClick(cardId) {
  selectedAttacker = null;
  selectedTarget = null;
  selectedCardId = cardId;
  render();
}

async function onPlayerCellClick(row, col) {
  const player = gameState.players[1];
  const cell = player.board.rows[row][col];

  if (selectedCardId && !cell) {
    try {
      await callApi(`/match/${matchId}/play-card`, {
        cardInstanceId: selectedCardId,
        options: { position: { row, col } },
      });
      selectedCardId = null;
      await loadState();
      await loadLogs();
      return;
    } catch (err) {
      alert('Errore nel giocare la carta: ' + err.message);
      return;
    }
  }

  if (cell && !cell.tired) {
    selectedAttacker = { row, col, owner: 'player' };
    selectedTarget = null;
    render();
  }
}

async function onOpponentCellClick(row, col) {
  const cell = gameState.players[0].board.rows[row][col];

  if (selectedAttacker && cell) {
    selectedTarget = {
      type: 'creature',
      ownerIndex: 0,
      row,
      col,
    };
    render();
    return;
  }
}

async function onAttack() {
  if (!selectedAttacker) {
    alert('Seleziona una creatura attaccante.');
    return;
  }

  const target = selectedTarget || { type: 'player', playerIndex: 0 };

  try {
    await callApi(`/match/${matchId}/attack`, {
      attackerPosition: { row: selectedAttacker.row, col: selectedAttacker.col },
      target,
    });
    selectedAttacker = null;
    selectedTarget = null;
    await loadState();
    await loadLogs();
  } catch (err) {
    alert('Errore nell attacco: ' + err.message);
  }
}

async function onNextTurn() {
  try {
    await callApi(`/match/${matchId}/next-turn`, {});
    await loadState();
    await loadLogs();
  } catch (err) {
    alert('Errore nell avanzare il turno: ' + err.message);
  }
}

async function onEndTurn() {
  try {
    await callApi(`/match/${matchId}/end-turn`, {});
    await loadState();
    await loadLogs();
  } catch (err) {
    alert('Errore nel finire il turno: ' + err.message);
  }
}

initGame();
