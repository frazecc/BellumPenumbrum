/**
 * Gestione visiva dell'HUD (Mana, Vita, Mazzo) e della mano avversario coperte di dorso.
 */

export function updateHUD(state, currentUser) {
  if (!state) return;

  const isPlayer1 = state.player1_id === currentUser?.id;
  const playerData = isPlayer1 ? state.player1 : state.player2;
  const opponentData = isPlayer1 ? state.player2 : state.player1;

  // GIOCATORE
  if (playerData) {
    setText('player-life', playerData.hp ?? 20);
    setText('player-current-mana', playerData.mana ?? 0);
    setText('player-max-mana', playerData.max_mana ?? 0);
    setText('player-deck-count', playerData.deck_count ?? 0);
    setText('player-graveyard-count', playerData.graveyard_count ?? 0);
  }

  // AVVERSARIO
  if (opponentData) {
    setText('opponent-life', opponentData.hp ?? 20);
    setText('opponent-current-mana', opponentData.mana ?? 0);
    setText('opponent-max-mana', opponentData.max_mana ?? 0);
    setText('opponent-deck-count', opponentData.deck_count ?? 0);
    setText('opponent-graveyard-count', opponentData.graveyard_count ?? 0);

    // AGGIORNAMENTO CARTE COPERTE MANO AVVERSARIO
    renderOpponentHand(opponentData.hand_count ?? 0);
  }

  // STATO PARTITA E TURNO
  setText('match-status', state.status === 'active' ? 'In corso' : state.status);
  setText('turn-status', `T${state.turn_number ?? 1}`);
  setText('phase-status', formatPhase(state.current_phase));
}

function renderOpponentHand(count) {
  const container = document.getElementById('opponent-hand');
  if (!container) return;

  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const cardBack = document.createElement('div');
    cardBack.className = 'card-back';
    container.appendChild(cardBack);
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(text);
}

function formatPhase(phase) {
  if (!phase) return '—';
  const map = {
    'upkeep': 'Inizio',
    'main': 'Principale',
    'end': 'Fine'
  };
  return map[phase] || phase;
}
