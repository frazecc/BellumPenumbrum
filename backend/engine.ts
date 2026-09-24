// backend/engine.ts

import { createClient } from '@supabase/supabase-js';
import type {
  GameState,
  PlayerState,
  BoardCell,
  CardData,
  EffectDefinition,
  MatchLogEntry,
  PlayCardOptions,
  AttackPosition,
  AttackTarget,
} from './types';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey);

// =========================
// UTILS DI BASE
// =========================

export async function getCardData(cardId: string): Promise<CardData> {
  const { data, error } = await supabase
    .from('cards')
    .select(`
      id,
      name,
      faction_id,
      card_type,
      mana_cost,
      sacrifice_cost,
      attack,
      hp,
      subtype,
      rarity,
      effect_text,
      effect_json,
      effect_on_death_json,
      flavor_text,
      image_url,
      factions!inner(code)
    `)
    .eq('id', cardId)
    .single();

  if (error || !data) {
    throw new Error(`Carta non trovata: ${cardId}`);
  }

  return {
    ...data,
    faction_code: (data.factions as any).code,
  } as CardData;
}

export function getCardOwner(
  state: GameState,
  cardInstanceId: string
): number | null {
  for (let i = 0; i < state.players.length; i++) {
    const player = state.players[i];

    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const cell = player.board.rows[r][c];
        if (cell && cell.instance_id === cardInstanceId) {
          return i;
        }
      }
    }

    if (player.board.field_spell?.instance_id === cardInstanceId) {
      return i;
    }
  }

  return null;
}

export function findCardPosition(
  player: PlayerState,
  cardInstanceId: string
): { row: number; col: number } | null {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const cell = player.board.rows[r][c];
      if (cell && cell.instance_id === cardInstanceId) {
        return { row: r, col: c };
      }
    }
  }
  return null;
}

export async function logMatchAction(
  matchId: string,
  entry: Omit<MatchLogEntry, 'turn' | 'phase' | 'player_index'> &
    Partial<Pick<MatchLogEntry, 'turn' | 'phase' | 'player_index'>>
) {
  const { error } = await supabase.from('match_logs').insert({
    match_id: matchId,
    turn: entry.turn ?? null,
    phase: entry.phase ?? null,
    player_index: entry.player_index ?? null,
    action_type: entry.action_type,
    card_id: entry.card_id ?? null,
    target_card_id: entry.target_card_id ?? null,
    target_player_index: entry.target_player_index ?? null,
    amount: entry.amount ?? null,
    damage: entry.damage ?? null,
    stat: entry.stat ?? null,
    duration: entry.duration ?? null,
    effect_type: entry.effect_type ?? null,
    sacrificed_card_ids: entry.sacrificed_card_ids ?? null,
    position: entry.position ?? null,
    description: entry.description,
  });

  if (error) {
    console.error('Errore nel log della partita:', error);
  }
}

export async function saveGameState(matchId: string, state: GameState) {
  const { error } = await supabase
    .from('game_state')
    .update({
      state,
      updated_at: new Date().toISOString(),
    })
    .eq('match_id', matchId);

  if (error) {
    throw new Error(`Errore nel salvataggio dello stato: ${error.message}`);
  }
}

export async function finalizeMatch(
  matchId: string,
  state: GameState,
  winnerPlayerIndex: number | null
) {
  state.status = 'finished';

  const p0 = state.players[0];
  const p1 = state.players[1];

  const winnerUserId =
    winnerPlayerIndex !== null ? state.players[winnerPlayerIndex].user_id : null;
  const loserUserId =
    winnerPlayerIndex !== null
      ? state.players[winnerPlayerIndex === 0 ? 1 : 0].user_id
      : null;

  const { error } = await supabase
    .from('matches')
    .update({
      status: 'finished',
      winner_user_id: winnerUserId,
      loser_user_id: loserUserId,
      ended_at: new Date().toISOString(),
    })
    .eq('id', matchId);

  if (error) {
    throw new Error(`Errore nella chiusura della partita: ${error.message}`);
  }

  await logMatchAction(matchId, {
    turn: state.current_turn,
    phase: 'end',
    player_index: winnerPlayerIndex ?? -1,
    action_type: 'match_end',
    description:
      winnerPlayerIndex !== null
        ? `Partita finita: vince il giocatore ${winnerPlayerIndex}`
        : 'Partita finita: pareggio o interruzione',
  });

  await saveGameState(matchId, state);
}

export function countAvailableSacrifices(player: PlayerState): number {
  let count = 0;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const cell = player.board.rows[r][c];
      if (cell) {
        count += 1;
      }
    }
  }
  return count;
}

export function sacrificeCreatures(
  player: PlayerState,
  count: number
): string[] {
  const sacrificed: string[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (sacrificed.length >= count) break;
      const cell = player.board.rows[r][c];
      if (cell) {
        player.graveyard.push(cell.instance_id);
        sacrificed.push(cell.instance_id);
        player.board.rows[r][c] = null as any;
      }
    }
  }
  return sacrificed;
}

// =========================
// CICLO DEL TURNO
// =========================

export async function nextTurn(matchId: string) {
  const { data: matchRow, error: matchErr } = await supabase
    .from('game_state')
    .select('state, matches')
    .eq('match_id', matchId)
    .single();

  if (matchErr || !matchRow) {
    throw new Error('Partita non trovata');
  }

  const state = matchRow.state as GameState;

  if (state.status !== 'running') {
    throw new Error('Partita non in corso');
  }

  const players = state.players;
  const prevActive = state.active_player_index;
  const nextActive = prevActive === 0 ? 1 : 0;

  state.active_player_index = nextActive;
  const player = players[nextActive];
  const opponent = players[prevActive];

  if (nextActive === 0) {
    state.current_turn += 1;
  }

  await logMatchAction(matchId, {
    turn: state.current_turn,
    phase: 'start',
    player_index: nextActive,
    action_type: 'turn_start',
    description: `Inizio turno ${state.current_turn} del giocatore ${nextActive}`,
  });

  state.phase = 'start';
  state.phase = 'upkeep';

  const MANA_CAP = 6;
  if (player.max_mana < MANA_CAP) {
    player.max_mana += 1;
  }

  player.current_mana = player.max_mana;

  for (const row of player.board.rows) {
    for (const slot of row) {
      if (slot && typeof slot === 'object' && 'tired' in slot) {
        slot.tired = false;
      }
    }
  }

  if (player.deck.length === 0) {
    state.status = 'finished';
    await finalizeMatch(matchId, state, opponent.player_index);
    return state;
  }

  const drawnCardId = player.deck.shift()!;
  player.hand.push(drawnCardId);

  await logMatchAction(matchId, {
    turn: state.current_turn,
    phase: 'upkeep',
    player_index: nextActive,
    action_type: 'draw',
    card_id: drawnCardId,
    description: `Giocatore ${nextActive} pesca una carta`,
  });

  state.phase = 'main';

  await saveGameState(matchId, state);

  return state;
}

export async function endTurn(matchId: string) {
  const { data: matchRow } = await supabase
    .from('game_state')
    .select('state')
    .eq('match_id', matchId)
    .single();

  const state = matchRow.state as GameState;

  if (state.status !== 'running') {
    throw new Error('Partita non in corso');
  }

  const playerIndex = state.active_player_index;

  state.phase = 'end';

  await logMatchAction(matchId, {
    turn: state.current_turn,
    phase: 'end',
    player_index: playerIndex,
    action_type: 'turn_end',
    description: `Fine turno del giocatore ${playerIndex}`,
  });

  const winner = checkWinCondition(state);
  if (winner !== null) {
    state.status = 'finished';
    await finalizeMatch(matchId, state, winner);
    return state;
  }

  await saveGameState(matchId, state);

  return state;
}

function checkWinCondition(state: GameState): number | null {
  const [p0, p1] = state.players;

  if (p0.life <= 0 && p1.life <= 0) {
    return null;
  }
  if (p0.life <= 0) return 1;
  if (p1.life <= 0) return 0;

  if (p0.deck.length === 0 && p0.hand.length === 0) return 1;
  if (p1.deck.length === 0 && p1.hand.length === 0) return 0;

  return null;
}

// =========================
// AZIONI BASE: PLAY CARD / ATTACK
// =========================

export async function playCard(
  matchId: string,
  playerId: number,
  cardInstanceId: string,
  options: PlayCardOptions = {}
) {
  const { data: matchRow } = await supabase
    .from('game_state')
    .select('state')
    .eq('match_id', matchId)
    .single();

  const state = matchRow.state as GameState;

  if (state.status !== 'running') {
    throw new Error('Partita non in corso');
  }

  if (state.active_player_index !== playerId) {
    throw new Error('Non è il tuo turno');
  }

  if (state.phase !== 'main') {
    throw new Error('Puoi giocare carte solo in fase main');
  }

  const player = state.players[playerId];
  const opponent = state.players[playerId === 0 ? 1 : 0];

  const handIndex = player.hand.findIndex((id) => id === cardInstanceId);
  if (handIndex === -1) {
    throw new Error('Carta non in mano');
  }

  const card = await getCardData(cardInstanceId);

  if (player.current_mana < card.mana_cost) {
    throw new Error('Mana insufficiente');
  }

  if (card.card_type === 'monster' || card.card_type === 'mostrissimo') {
    if (!options.position) {
      throw new Error('Posizione obbligatoria per le creature');
    }
    const { row, col } = options.position;
    if (row < 0 || row > 2 || col < 0 || col > 2) {
      throw new Error('Posizione non valida');
    }
    const cell = player.board.rows[row][col];
    if (cell !== null) {
      throw new Error('Cella già occupata');
    }

    if (card.card_type === 'mostrissimo') {
      const sacrificeCost = card.sacrifice_cost || 0;
      if (sacrificeCost > 0) {
        const availableSacrifices = countAvailableSacrifices(player);
        if (availableSacrifices < sacrificeCost) {
          throw new Error('Creature insufficienti per il sacrificio');
        }
      }
    }
  } else if (card.card_type === 'terraforma') {
    if (player.board.field_spell !== null) {
      throw new Error('Hai già una Field Spell attiva');
    }
  } else if (card.card_type === 'aura') {
    if (!options.targetCardId) {
      throw new Error('Aura richiede un target');
    }
    const targetOwner = getCardOwner(state, options.targetCardId);
    if (targetOwner === null) {
      throw new Error('Target non valido');
    }
  }

  player.current_mana -= card.mana_cost;
  player.hand.splice(handIndex, 1);

  if (card.card_type === 'monster' || card.card_type === 'mostrissimo') {
    if (card.card_type === 'mostrissimo') {
      const sacrificeCost = card.sacrifice_cost || 0;
      if (sacrificeCost > 0) {
        const sacrificed = sacrificeCreatures(player, sacrificeCost);
        await logMatchAction(matchId, {
          turn: state.current_turn,
          phase: 'main',
          player_index: playerId,
          action_type: 'sacrifice',
          sacrificed_card_ids: sacrificed,
          description: `Sacrificio di ${sacrificed.length} creature per ${card.name}`,
        });
      }
    }

    const { row, col } = options.position!;
    player.board.rows[row][col] = {
      card_id: card.id,
      instance_id: cardInstanceId,
      attack: card.attack ?? 0,
      hp: card.hp ?? 0,
      max_hp: card.hp ?? 0,
      tired: false,
      auras: [],
    };

    await resolveOnPlayEffect(matchId, state, player, opponent, card);
  } else if (card.card_type === 'terraforma') {
    player.board.field_spell = {
      card_id: card.id,
      instance_id: cardInstanceId,
    };

    await resolveOnPlayEffect(matchId, state, player, opponent, card);
  } else if (card.card_type === 'aura') {
    const targetOwnerIndex = getCardOwner(state, options.targetCardId!)!;
    const targetOwner = state.players[targetOwnerIndex];
    const targetPos = findCardPosition(targetOwner, options.targetCardId!);

    if (!targetPos) {
      throw new Error('Target aura non trovato');
    }

    const targetCell = targetOwner.board.rows[targetPos.row][targetPos.col];
    if (!targetCell) {
      throw new Error('Target aura non è una creatura valida');
    }

    if (!targetCell.auras) {
      targetCell.auras = [];
    }
    targetCell.auras.push({
      card_id: card.id,
      instance_id: cardInstanceId,
    });

    await resolveOnPlayEffect(matchId, state, player, opponent, card);
  } else if (card.card_type === 'sorcery' || card.card_type === 'instant') {
    await resolveOnPlayEffect(matchId, state, player, opponent, card);
    player.graveyard.push(cardInstanceId);
  }

  if (card.faction_code) {
    player.color_counters[card.faction_code] =
      (player.color_counters[card.faction_code] || 0) + 1;
  }

  await logMatchAction(matchId, {
    turn: state.current_turn,
    phase: 'main',
    player_index: playerId,
    action_type: 'play_card',
    card_id: cardInstanceId,
    card_type: card.card_type,
    position: options.position || null,
    target_card_id: options.targetCardId || null,
    description: `Giocatore ${playerId} gioca ${card.name}`,
  });

  await saveGameState(matchId, state);

  return state;
}

export async function attack(
  matchId: string,
  playerId: number,
  attackerPosition: AttackPosition,
  target: AttackTarget
) {
  const { data: matchRow } = await supabase
    .from('game_state')
    .select('state')
    .eq('match_id', matchId)
    .single();

  const state = matchRow.state as GameState;

  if (state.status !== 'running') {
    throw new Error('Partita non in corso');
  }

  if (state.active_player_index !== playerId) {
    throw new Error('Non è il tuo turno');
  }

  if (state.phase !== 'main') {
    throw new Error('Puoi attaccare solo in fase main');
  }

  const attackerOwner = state.players[playerId];
  const opponent = state.players[playerId === 0 ? 1 : 0];

  const { row, col } = attackerPosition;
  if (row < 0 || row > 2 || col < 0 || col > 2) {
    throw new Error('Posizione attaccante non valida');
  }

  const attackerCell = attackerOwner.board.rows[row][col];
  if (!attackerCell) {
    throw new Error('Nessuna creatura nella posizione indicata');
  }

  if (attackerCell.tired) {
    throw new Error('Creatura già stanca, non può attaccare');
  }

  if (target.type === 'creature') {
    const targetOwner = state.players[target.ownerIndex];
    const tRow = target.position.row;
    const tCol = target.position.col;

    if (tRow < 0 || tRow > 2 || tCol < 0 || tCol > 2) {
      throw new Error('Posizione target non valida');
    }

    const targetCell = targetOwner.board.rows[tRow][tCol];
    if (!targetCell) {
      throw new Error('Nessuna creatura nel target');
    }
  }

  const damage = attackerCell.attack ?? 0;

  if (target.type === 'creature') {
    const targetOwner = state.players[target.ownerIndex];
    const tRow = target.position.row;
    const tCol = target.position.col;
    const targetCell = targetOwner.board.rows[tRow][tCol];

    targetCell.hp -= damage;

    await logMatchAction(matchId, {
      turn: state.current_turn,
      phase: 'main',
      player_index: playerId,
      action_type: 'attack_creature',
      attacker_card_id: attackerCell.instance_id,
      target_card_id: targetCell.instance_id,
      damage,
      description: `${attackerCell.card_id} attacca ${targetCell.card_id} per ${damage} danno`,
    });

    if (targetCell.hp <= 0) {
      targetOwner.graveyard.push(targetCell.instance_id);
      targetOwner.board.rows[tRow][tCol] = null as any;

      await resolveOnDeathEffect(matchId, state, targetOwner, attackerOwner, targetCell);
    }
  } else if (target.type === 'player') {
    const targetPlayer = state.players[target.playerIndex];
    targetPlayer.life -= damage;

    await logMatchAction(matchId, {
      turn: state.current_turn,
      phase: 'main',
      player_index: playerId,
      action_type: 'attack_player',
      attacker_card_id: attackerCell.instance_id,
      target_player_index: target.playerIndex,
      damage,
      description: `${attackerCell.card_id} attacca giocatore ${target.playerIndex} per ${damage} danno`,
    });

    if (targetPlayer.life <= 0) {
      state.status = 'finished';
      await finalizeMatch(matchId, state, playerId);
      return state;
    }
  }

  attackerCell.tired = true;

  await saveGameState(matchId, state);

  return state;
}

// =========================
// EFFETTI: ON-PLAY / ON-DEATH / DISPATCH
// =========================

async function dispatchEffect(
  matchId: string,
  state: GameState,
  player: PlayerState,
  opponent: PlayerState,
  card: CardData,
  effect: EffectDefinition
) {
  switch (effect.type) {
    case 'draw':
      return await effect_draw(matchId, state, player, opponent, card, effect);
    case 'damage':
    case 'damage_creature':
      return await effect_damage_creature(matchId, state, player, opponent, card, effect);
    case 'heal':
      return await effect_heal(matchId, state, player, opponent, card, effect);
    case 'discard':
    case 'discard_random':
      return await effect_discard(matchId, state, player, opponent, card, effect);
    case 'buff':
      return await effect_buff(matchId, state, player, opponent, card, effect);
    case 'counter':
      return await effect_counter(matchId, state, player, opponent, card, effect);
    case 'return_hand':
      return await effect_return_hand(matchId, state, player, opponent, card, effect);
    case 'destroy':
      return await effect_destroy(matchId, state, player, opponent, card, effect);
    case 'exile':
      return await effect_exile(matchId, state, player, opponent, card, effect);
    case 'mill':
      return await effect_mill(matchId, state, player, opponent, card, effect);
    case 'search_deck':
      return await effect_search_deck(matchId, state, player, opponent, card, effect);
    case 'create_token':
      return await effect_create_token(matchId, state, player, opponent, card, effect);
    case 'custom':
      return await effect_custom(matchId, state, player, opponent, card, effect);
    default: {
      const _unhandled: never = effect.type;
      throw new Error(`Tipo effetto non gestito: ${effect.type}`);
    }
  }
}

export async function resolveOnPlayEffect(
  matchId: string,
  state: GameState,
  player: PlayerState,
  opponent: PlayerState,
  card: CardData
) {
  const effectRaw = card.effect_json;
  if (!effectRaw) return;

  const effects: EffectDefinition[] =
    'effects' in effectRaw && Array.isArray(effectRaw.effects)
      ? effectRaw.effects
      : [effectRaw as EffectDefinition];

  for (const effect of effects) {
    await dispatchEffect(matchId, state, player, opponent, card, effect);
  }
}

export async function resolveOnDeathEffect(
  matchId: string,
  state: GameState,
  deadOwner: PlayerState,
  killerOwner: PlayerState,
  deadCell: BoardCell
) {
  const card = await getCardData(deadCell.card_id);
  const effectRaw = card.effect_on_death_json;
  if (!effectRaw) return;

  const effects: EffectDefinition[] =
    'effects' in effectRaw && Array.isArray(effectRaw.effects)
      ? effectRaw.effects
      : [effectRaw as EffectDefinition];

  state.anti_loop_counter = (state.anti_loop_counter || 0) + effects.length;
  const ANTI_LOOP_LIMIT = 20;

  if (state.anti_loop_counter > ANTI_LOOP_LIMIT) {
    await wipeBoardForAntiLoop(matchId, state);
    return;
  }

  for (const effect of effects) {
    await dispatchEffect(matchId, state, deadOwner, killerOwner, card, effect);

    await logMatchAction(matchId, {
      turn: state.current_turn,
      phase: 'main',
      player_index: deadOwner.player_index,
      action_type: 'effect_on_death',
      card_id: card.id,
      effect_type: effect.type,
      description: `Trigger on_death di ${card.name}: ${effect.type}`,
    });
  }
}

async function wipeBoardForAntiLoop(matchId: string, state: GameState) {
  for (const player of state.players) {
    player.board.field_spell = null;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const cell = player.board.rows[r][c];
        if (cell) {
          player.graveyard.push(cell.instance_id);
          player.board.rows[r][c] = null as any;
        }
      }
    }
  }

  state.anti_loop_counter = 0;
  state.status = 'finished';

  await logMatchAction(matchId, {
    turn: state.current_turn,
    phase: 'main',
    player_index: -1,
    action_type: 'anti_loop_wipe',
    description:
      'Superato limite trigger consecutivi: pulizia totale della scacchiera. Qualcosa di antico si è risvegliato… e poi è svenuto.',
  });

  await saveGameState(matchId, state);
}

// =========================
// FUNZIONI EFFETTO DEDICATE
// =========================

async function effect_draw(
  matchId: string,
  state: GameState,
  player: PlayerState,
  opponent: PlayerState,
  card: CardData,
  effect: EffectDefinition
) {
  const amount = effect.amount ?? 1;
  const target = effect.target ?? 'self';

  if (target === 'self') {
    for (let i = 0; i < amount; i++) {
      if (player.deck.length === 0) break;
      const drawnId = player.deck.shift()!;
      player.hand.push(drawnId);

      await logMatchAction(matchId, {
        turn: state.current_turn,
        phase: 'main',
        player_index: player.player_index,
        action_type: 'effect_draw',
        card_id: card.id,
        target_card_id: drawnId,
        amount,
        description: `${card.name}: ${player.player_index} pesca ${amount} carta(e)`,
      });
    }
  } else if (target === 'opponent') {
    for (let i = 0; i < amount; i++) {
      if (opponent.deck.length === 0) break;
      const drawnId = opponent.deck.shift()!;
      opponent.hand.push(drawnId);
    }
  } else {
    throw new Error(`Target non supportato per draw: ${target}`);
  }
}

async function effect_damage_creature(
  matchId: string,
  state: GameState,
  player: PlayerState,
  opponent: PlayerState,
  card: CardData,
  effect: EffectDefinition
) {
  const amount = effect.amount ?? 0;
  const target = effect.target ?? 'any_creature';

  if (target === 'any_creature') {
    const targetCardId = effect.target_card_id;
    if (!targetCardId) {
      throw new Error('damage_creature richiede target_card_id');
    }

    const ownerIndex = getCardOwner(state, targetCardId);
    if (ownerIndex === null) {
      throw new Error('Target creatura non trovata');
    }

    const owner = state.players[ownerIndex];
    const pos = findCardPosition(owner, targetCardId);
    if (!pos) {
      throw new Error('Target creatura non trovata sul board');
    }

    const cell = owner.board.rows[pos.row][pos.col];
    cell.hp -= amount;

    await logMatchAction(matchId, {
      turn: state.current_turn,
      phase: 'main',
      player_index: player.player_index,
      action_type: 'effect_damage_creature',
      card_id: card.id,
      target_card_id: targetCardId,
      amount,
      description: `${card.name}: infligge ${amount} danno a ${targetCardId}`,
    });

    if (cell.hp <= 0) {
      owner.graveyard.push(cell.instance_id);
      owner.board.rows[pos.row][pos.col] = null as any;

      await resolveOnDeathEffect(matchId, state, owner, player, cell);
    }
  } else if (target === 'all_creatures') {
    for (const p of state.players) {
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const cell = p.board.rows[r][c];
          if (!cell) continue;
          cell.hp -= amount;

          if (cell.hp <= 0) {
            p.graveyard.push(cell.instance_id);
            p.board.rows[r][c] = null as any;

            await resolveOnDeathEffect(matchId, state, p, player, cell);
          }
        }
      }
    }

    await logMatchAction(matchId, {
      turn: state.current_turn,
      phase: 'main',
      player_index: player.player_index,
      action_type: 'effect_damage_all_creatures',
      card_id: card.id,
      amount,
      description: `${card.name}: infligge ${amount} danno a tutte le creature`,
    });
  } else if (target === 'all_creatures_self') {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const cell = player.board.rows[r][c];
        if (!cell) continue;
        cell.hp -= amount;

        if (cell.hp <= 0) {
          player.graveyard.push(cell.instance_id);
          player.board.rows[r][c] = null as any;

          await resolveOnDeathEffect(matchId, state, player, opponent, cell);
        }
      }
    }
  } else if (target === 'all_creatures_opponent') {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const cell = opponent.board.rows[r][c];
        if (!cell) continue;
        cell.hp -= amount;

        if (cell.hp <= 0) {
          opponent.graveyard.push(cell.instance_id);
          opponent.board.rows[r][c] = null as any;

          await resolveOnDeathEffect(matchId, state, opponent, player, cell);
        }
      }
    }
  } else {
    throw new Error(`Target non supportato per damage_creature: ${target}`);
  }
}

async function effect_heal(
  matchId: string,
  state: GameState,
  player: PlayerState,
  opponent: PlayerState,
  card: CardData,
  effect: EffectDefinition
) {
  const amount = effect.amount ?? 1;
  const target = effect.target ?? 'self';

  if (target === 'any_creature') {
    const targetCardId = effect.target_card_id;
    if (!targetCardId) {
      throw new Error('heal richiede target_card_id per any_creature');
    }

    const ownerIndex = getCardOwner(state, targetCardId);
    if (ownerIndex === null) {
      throw new Error('Target creatura non trovata');
    }

    const owner = state.players[ownerIndex];
    const pos = findCardPosition(owner, targetCardId);
    if (!pos) {
      throw new Error('Target creatura non trovata sul board');
    }

    const cell = owner.board.rows[pos.row][pos.col];
    cell.hp = Math.min(cell.max_hp, cell.hp + amount);

    await logMatchAction(matchId, {
      turn: state.current_turn,
      phase: 'main',
      player_index: player.player_index,
      action_type: 'effect_heal_creature',
      card_id: card.id,
      target_card_id: targetCardId,
      amount,
      description: `${card.name}: cura ${amount} HP a ${targetCardId}`,
    });
  } else if (target === 'all_creatures') {
    for (const p of state.players) {
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const cell = p.board.rows[r][c];
          if (!cell) continue;
          cell.hp = Math.min(cell.max_hp, cell.hp + amount);
        }
      }
    }

    await logMatchAction(matchId, {
      turn: state.current_turn,
      phase: 'main',
      player_index: player.player_index,
      action_type: 'effect_heal_all_creatures',
      card_id: card.id,
      amount,
      description: `${card.name}: cura ${amount} HP a tutte le creature`,
    });
  } else if (target === 'self') {
    player.life = (player.life ?? 20) + amount;
  } else if (target === 'opponent') {
    opponent.life = (opponent.life ?? 20) + amount;
  } else {
    throw new Error(`Target non supportato per heal: ${target}`);
  }
}

async function effect_discard(
  matchId: string,
  state: GameState,
  player: PlayerState,
  opponent: PlayerState,
  card: CardData,
  effect: EffectDefinition
) {
  const amount = effect.amount ?? 1;
  const target = effect.target ?? 'opponent';
  const isRandom = effect.type === 'discard_random';

  if (target === 'opponent') {
    for (let i = 0; i < amount; i++) {
      if (opponent.hand.length === 0) break;

      let indexToDiscard: number;
      if (isRandom) {
        indexToDiscard = Math.floor(Math.random() * opponent.hand.length);
      } else {
        indexToDiscard = opponent.hand.length - 1;
      }

      const discardedId = opponent.hand.splice(indexToDiscard, 1)[0];
      opponent.graveyard.push(discardedId);

      await logMatchAction(matchId, {
        turn: state.current_turn,
        phase: 'main',
        player_index: player.player_index,
        action_type: 'effect_discard',
        card_id: card.id,
        target_card_id: discardedId,
        amount,
        description: `${card.name}: ${opponent.player_index} scarta una carta`,
      });
    }
  } else if (target === 'self') {
    for (let i = 0; i < amount; i++) {
      if (player.hand.length === 0) break;
      const discardedId = player.hand.pop()!;
      player.graveyard.push(discardedId);
    }
  } else {
    throw new Error(`Target non supportato per discard: ${target}`);
  }
}

async function effect_buff(
  matchId: string,
  state: GameState,
  player: PlayerState,
  opponent: PlayerState,
  card: CardData,
  effect: EffectDefinition
) {
  const amount = effect.amount ?? 0;
  const stat = effect.stat ?? 'attack';
  const duration = effect.duration ?? 'permanent';
  const target = effect.target ?? 'any_creature';

  if (target === 'any_creature') {
    const targetCardId = effect.target_card_id;
    if (!targetCardId) {
      throw new Error('buff richiede target_card_id per any_creature');
    }

    const ownerIndex = getCardOwner(state, targetCardId);
    if (ownerIndex === null) {
      throw new Error('Target creatura non trovata');
    }

    const owner = state.players[ownerIndex];
    const pos = findCardPosition(owner, targetCardId);
    if (!pos) {
      throw new Error('Target creatura non trovata sul board');
    }

    const cell = owner.board.rows[pos.row][pos.col];

    if (stat === 'attack') {
      cell.attack = (cell.attack ?? 0) + amount;
    } else if (stat === 'hp') {
      cell.hp = (cell.hp ?? 0) + amount;
      cell.max_hp = (cell.max_hp ?? 0) + amount;
    }

    await logMatchAction(matchId, {
      turn: state.current_turn,
      phase: 'main',
      player_index: player.player_index,
      action_type: 'effect_buff',
      card_id: card.id,
      target_card_id: targetCardId,
      stat,
      amount,
      duration,
      description: `${card.name}: +${amount} ${stat} a ${targetCardId}`,
    });
  } else if (target === 'all_creatures') {
    for (const p of state.players) {
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const cell = p.board.rows[r][c];
          if (!cell) continue;

          if (stat === 'attack') {
            cell.attack = (cell.attack ?? 0) + amount;
          } else if (stat === 'hp') {
            cell.hp = (cell.hp ?? 0) + amount;
            cell.max_hp = (cell.max_hp ?? 0) + amount;
          }
        }
      }
    }

    await logMatchAction(matchId, {
      turn: state.current_turn,
      phase: 'main',
      player_index: player.player_index,
      action_type: 'effect_buff_all_creatures',
      card_id: card.id,
      stat,
      amount,
      duration,
      description: `${card.name}: +${amount} ${stat} a tutte le creature`,
    });
  } else {
    throw new Error(`Target non supportato per buff: ${target}`);
  }
}

async function effect_counter(
  matchId: string,
  state: GameState,
  player: PlayerState,
  opponent: PlayerState,
  card: CardData,
  effect: EffectDefinition
) {
  await logMatchAction(matchId, {
    turn: state.current_turn,
    phase: 'main',
    player_index: player.player_index,
    action_type: 'effect_counter',
    card_id: card.id,
    description: `${card.name}: contrasta (placeholder, stack non implementato)`,
  });
}

async function effect_return_hand(
  matchId: string,
  state: GameState,
  player: PlayerState,
  opponent: PlayerState,
  card: CardData,
  effect: EffectDefinition
) {
  const target = effect.target ?? 'any_creature';
  if (target === 'any_creature') {
    const targetCardId = effect.target_card_id;
    if (!targetCardId) {
      throw new Error('return_hand richiede target_card_id');
    }

    const ownerIndex = getCardOwner(state, targetCardId);
    if (ownerIndex === null) {
      throw new Error('Target creatura non trovata');
    }

    const owner = state.players[ownerIndex];
    const pos = findCardPosition(owner, targetCardId);
    if (!pos) {
      throw new Error('Target creatura non trovata sul board');
    }

    const cell = owner.board.rows[pos.row][pos.col];
    owner.board.rows[pos.row][pos.col] = null as any;
    owner.hand.push(cell.instance_id);

    await logMatchAction(matchId, {
      turn: state.current_turn,
      phase: 'main',
      player_index: player.player_index,
      action_type: 'effect_return_hand',
      card_id: card.id,
      target_card_id: targetCardId,
      description: `${card.name}: ${targetCardId} torna in mano`,
    });
  } else {
    throw new Error(`Target non supportato per return_hand: ${target}`);
  }
}

async function effect_destroy(
  matchId: string,
  state: GameState,
  player: PlayerState,
  opponent: PlayerState,
  card: CardData,
  effect: EffectDefinition
) {
  const target = effect.target ?? 'any_creature';

  if (target === 'any_creature') {
    const targetCardId = effect.target_card_id;
    if (!targetCardId) {
      throw new Error('destroy richiede target_card_id');
    }

    const ownerIndex = getCardOwner(state, targetCardId);
    if (ownerIndex === null) {
      throw new Error('Target creatura non trovata');
    }

    const owner = state.players[ownerIndex];
    const pos = findCardPosition(owner, targetCardId);
    if (!pos) {
      throw new Error('Target creatura non trovata sul board');
    }

    const cell = owner.board.rows[pos.row][pos.col];
    owner.graveyard.push(cell.instance_id);
    owner.board.rows[pos.row][pos.col] = null as any;

    await logMatchAction(matchId, {
      turn: state.current_turn,
      phase: 'main',
      player_index: player.player_index,
      action_type: 'effect_destroy',
      card_id: card.id,
      target_card_id: targetCardId,
      description: `${card.name}: distrugge ${targetCardId}`,
    });

    await resolveOnDeathEffect(matchId, state, owner, player, cell);
  } else {
    throw new Error(`Target non supportato per destroy: ${target}`);
  }
}

async function effect_exile(
  matchId: string,
  state: GameState,
  player: PlayerState,
  opponent: PlayerState,
  card: CardData,
  effect: EffectDefinition
) {
  const target = effect.target ?? 'any_creature';

  if (target === 'any_creature') {
    const targetCardId = effect.target_card_id;
    if (!targetCardId) {
      throw new Error('exile richiede target_card_id');
    }

    const ownerIndex = getCardOwner(state, targetCardId);
    if (ownerIndex === null) {
      throw new Error('Target creatura non trovata');
    }

    const owner = state.players[ownerIndex];
    const pos = findCardPosition(owner, targetCardId);
    if (!pos) {
      throw new Error('Target creatura non trovata sul board');
    }

    const cell = owner.board.rows[pos.row][pos.col];
    owner.graveyard.push(cell.instance_id);
    owner.board.rows[pos.row][pos.col] = null as any;

    await logMatchAction(matchId, {
      turn: state.current_turn,
      phase: 'main',
      player_index: player.player_index,
      action_type: 'effect_exile',
      card_id: card.id,
      target_card_id: targetCardId,
      description: `${card.name}: esilia ${targetCardId}`,
    });

    await resolveOnDeathEffect(matchId, state, owner, player, cell);
  } else {
    throw new Error(`Target non supportato per exile: ${target}`);
  }
}

async function effect_mill(
  matchId: string,
  state: GameState,
  player: PlayerState,
  opponent: PlayerState,
  card: CardData,
  effect: EffectDefinition
) {
  const amount = effect.amount ?? 1;
  const target = effect.target ?? 'opponent';

  if (target === 'opponent') {
    for (let i = 0; i < amount; i++) {
      if (opponent.deck.length === 0) break;
      const milledId = opponent.deck.shift()!;
      opponent.graveyard.push(milledId);
    }

    await logMatchAction(matchId, {
      turn: state.current_turn,
      phase: 'main',
      player_index: player.player_index,
      action_type: 'effect_mill',
      card_id: card.id,
