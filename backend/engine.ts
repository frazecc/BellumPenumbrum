import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
}

const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

const MANA_CAP = 6;
const BOARD_SIZE = 3;
const ANTI_LOOP_LIMIT = 20;

function getPlayer(state: GameState, index: number): PlayerState {
  if (index !== 0 && index !== 1) throw new Error('Invalid player index');
  return state.players[index];
}

function otherPlayer(index: number): number {
  return index === 0 ? 1 : 0;
}

function isValidPosition(position: { row: number; col: number }): boolean {
  return Number.isInteger(position.row) && Number.isInteger(position.col) &&
    position.row >= 0 && position.row < BOARD_SIZE &&
    position.col >= 0 && position.col < BOARD_SIZE;
}

function getEffects(raw: unknown): EffectDefinition[] {
  if (!raw || typeof raw !== 'object') return [];
  const value = raw as Record<string, unknown>;
  if (Array.isArray(value.effects)) return value.effects as EffectDefinition[];
  return [value as unknown as EffectDefinition];
}

function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function loadState(matchId: string): Promise<GameState> {
  const { data, error } = await supabase
    .from('game_state')
    .select('state_json, current_turn, current_phase')
    .eq('match_id', matchId)
    .single();

  if (error || !data) throw new Error(`Game state not found: ${error?.message ?? matchId}`);

  const state = data.state_json as GameState;
  state.current_turn = Number(state.current_turn ?? data.current_turn ?? 0);
  state.phase = (state.phase ?? phaseFromNumber(data.current_phase)) as GameState['phase'];
  return state;
}

function phaseFromNumber(value: unknown): GameState['phase'] {
  switch (Number(value)) {
    case 0: return 'start';
    case 1: return 'upkeep';
    case 3: return 'end';
    default: return 'main';
  }
}

export async function getCardData(cardId: string): Promise<CardData> {
  const { data, error } = await supabase
    .from('cards')
    .select('id,name,faction_id,card_type,mana_cost,sacrifice_cost,attack,hp,subtype,rarity,effect_text,effect_json,effect_on_death_json,flavor_text,image_url,factions!inner(code)')
    .eq('id', cardId)
    .single();

  if (error || !data) throw new Error(`Card not found: ${cardId}`);
  const faction = Array.isArray(data.factions) ? data.factions[0] : data.factions;
  return { ...data, faction_code: (faction as { code: string }).code } as CardData;
}

export function findCardPosition(player: PlayerState, instanceId: string) {
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (player.board.rows[row][col]?.instance_id === instanceId) return { row, col };
    }
  }
  return null;
}

export function getCardOwner(state: GameState, instanceId: string): number | null {
  for (const player of state.players) {
    if (findCardPosition(player, instanceId)) return player.player_index;
    if (player.board.field_spell?.instance_id === instanceId) return player.player_index;
  }
  return null;
}

export async function logMatchAction(matchId: string, entry: Partial<MatchLogEntry> & { action_type: string; description: string }) {
  const logData = { ...entry };
  const { error } = await supabase.from('match_logs').insert({ match_id: matchId, log_data: logData });
  if (error) throw new Error(`Could not write match log: ${error.message}`);
}

export async function saveGameState(matchId: string, state: GameState) {
  const { error } = await supabase.from('game_state').update({
    state_json: state,
    current_turn: state.current_turn,
    current_phase: phaseToNumber(state.phase),
    last_updated: new Date().toISOString(),
  }).eq('match_id', matchId);
  if (error) throw new Error(`Could not save game state: ${error.message}`);
}

function phaseToNumber(phase: GameState['phase']): number {
  return phase === 'start' ? 0 : phase === 'upkeep' ? 1 : phase === 'end' ? 3 : 2;
}

export async function finalizeMatch(matchId: string, state: GameState, winner: number | null) {
  state.status = 'finished';
  await saveGameState(matchId, state);
  await logMatchAction(matchId, {
    turn: state.current_turn,
    phase: 'end',
    player_index: winner ?? -1,
    action_type: 'match_end',
    description: winner === null ? 'Match ended in a draw' : `Player ${winner} wins`,
  });
}

export function countAvailableSacrifices(player: PlayerState): number {
  let count = 0;
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) if (player.board.rows[row][col]) count++;
  }
  return count;
}

export function sacrificeCreatures(player: PlayerState, count: number): string[] {
  const sacrificed: string[] = [];
  for (let row = 0; row < BOARD_SIZE && sacrificed.length < count; row++) {
    for (let col = 0; col < BOARD_SIZE && sacrificed.length < count; col++) {
      const cell = player.board.rows[row][col];
      if (!cell) continue;
      sacrificed.push(cell.instance_id);
      player.graveyard.push(cell.instance_id);
      player.board.rows[row][col] = null;
    }
  }
  if (sacrificed.length !== count) throw new Error('Not enough creatures to sacrifice');
  return sacrificed;
}

export async function nextTurn(matchId: string): Promise<GameState> {
  const state = await loadState(matchId);
  if (state.status !== 'running') throw new Error('Match is not running');

  const previous = state.active_player_index;
  const active = otherPlayer(previous);
  state.active_player_index = active;
  if (active === 0) state.current_turn += 1;
  const player = getPlayer(state, active);

  state.phase = 'start';
  await logMatchAction(matchId, { turn: state.current_turn, phase: 'start', player_index: active, action_type: 'turn_start', description: `Turn ${state.current_turn} started for player ${active}` });

  state.phase = 'upkeep';
  player.max_mana = Math.min(MANA_CAP, player.max_mana + 1);
  player.current_mana = player.max_mana;
  for (const row of player.board.rows) for (const cell of row) if (cell) cell.tired = false;

  if (player.deck.length === 0) {
    await finalizeMatch(matchId, state, otherPlayer(active));
    return state;
  }

  const drawn = player.deck.shift()!;
  player.hand.push(drawn);
  await logMatchAction(matchId, { turn: state.current_turn, phase: 'upkeep', player_index: active, action_type: 'draw', card_id: drawn, description: `Player ${active} drew a card` });

  state.phase = 'main';
  await saveGameState(matchId, state);
  return state;
}

export async function endTurn(matchId: string): Promise<GameState> {
  const state = await loadState(matchId);
  if (state.status !== 'running') throw new Error('Match is not running');
  const active = state.active_player_index;
  state.phase = 'end';
  await logMatchAction(matchId, { turn: state.current_turn, phase: 'end', player_index: active, action_type: 'turn_end', description: `Player ${active} ended the turn` });
  const winner = checkWinCondition(state);
  if (winner !== null) await finalizeMatch(matchId, state, winner);
  else await saveGameState(matchId, state);
  return state;
}

function checkWinCondition(state: GameState): number | null {
  if (state.players[0].life <= 0 && state.players[1].life <= 0) return null;
  if (state.players[0].life <= 0) return 1;
  if (state.players[1].life <= 0) return 0;
  return null;
}

export async function playCard(matchId: string, playerIndex: number, instanceId: string, options: PlayCardOptions = {}) {
  const state = await loadState(matchId);
  if (state.status !== 'running') throw new Error('Match is not running');
  if (state.phase !== 'main') throw new Error('Cards can only be played in main phase');
  if (state.active_player_index !== playerIndex) throw new Error('It is not this player turn');

  const player = getPlayer(state, playerIndex);
  const opponent = getPlayer(state, otherPlayer(playerIndex));
  const handIndex = player.hand.indexOf(instanceId);
  if (handIndex < 0) throw new Error('Card is not in hand');

  const card = await getCardData(instanceId);
  if (player.current_mana < card.mana_cost) throw new Error('Not enough mana');

  if (card.card_type === 'monster' || card.card_type === 'mostrissimo') {
    if (!options.position || !isValidPosition(options.position)) throw new Error('Invalid creature position');
    if (player.board.rows[options.position.row][options.position.col]) throw new Error('Position is occupied');
    if (card.card_type === 'mostrissimo' && countAvailableSacrifices(player) < (card.sacrifice_cost ?? 0)) throw new Error('Not enough sacrifices');
  }
  if (card.card_type === 'terraforma' && player.board.field_spell) throw new Error('A terraforma is already active');
  if (card.card_type === 'aura') {
    if (!options.targetCardId || getCardOwner(state, options.targetCardId) === null) throw new Error('Aura target not found');
  }

  player.current_mana -= card.mana_cost;
  player.hand.splice(handIndex, 1);

  if (card.card_type === 'monster' || card.card_type === 'mostrissimo') {
    if (card.card_type === 'mostrissimo' && (card.sacrifice_cost ?? 0) > 0) sacrificeCreatures(player, card.sacrifice_cost!);
    const { row, col } = options.position!;
    player.board.rows[row][col] = { card_id: card.id, instance_id: instanceId, attack: card.attack ?? 0, hp: card.hp ?? 0, max_hp: card.hp ?? 0, tired: false, auras: [] };
    await resolveOnPlayEffect(matchId, state, player, opponent, card);
  } else if (card.card_type === 'terraforma') {
    player.board.field_spell = { card_id: card.id, instance_id: instanceId };
    await resolveOnPlayEffect(matchId, state, player, opponent, card);
  } else if (card.card_type === 'aura') {
    const owner = getPlayer(state, getCardOwner(state, options.targetCardId!)!);
    const position = findCardPosition(owner, options.targetCardId!);
    if (!position) throw new Error('Aura target is not on board');
    owner.board.rows[position.row][position.col]!.auras.push({ card_id: card.id, instance_id: instanceId });
    await resolveOnPlayEffect(matchId, state, player, opponent, card);
  } else {
    await resolveOnPlayEffect(matchId, state, player, opponent, card);
    player.graveyard.push(instanceId);
  }

  player.color_counters[card.faction_code] = (player.color_counters[card.faction_code] ?? 0) + 1;
  await logMatchAction(matchId, { turn: state.current_turn, phase: 'main', player_index: playerIndex, action_type: 'play_card', card_id: card.id, description: `Player ${playerIndex} played ${card.name}` });
  await saveGameState(matchId, state);
  return state;
}

export async function attack(matchId: string, playerIndex: number, attackerPosition: AttackPosition, target: AttackTarget) {
  const state = await loadState(matchId);
  if (state.status !== 'running') throw new Error('Match is not running');
  if (state.phase !== 'main') throw new Error('Attacks can only happen in main phase');
  if (state.active_player_index !== playerIndex) throw new Error('It is not this player turn');
  if (!isValidPosition(attackerPosition)) throw new Error('Invalid attacker position');

  const attackerOwner = getPlayer(state, playerIndex);
  const attacker = attackerOwner.board.rows[attackerPosition.row][attackerPosition.col];
  if (!attacker) throw new Error('Attacker not found');
  if (attacker.tired) throw new Error('Attacker is tired');

  if (target.type === 'creature') {
    if (target.ownerIndex === playerIndex || !isValidPosition(target.position)) throw new Error('Invalid creature target');
    const targetOwner = getPlayer(state, target.ownerIndex);
    const targetCell = targetOwner.board.rows[target.position.row][target.position.col];
    if (!targetCell) throw new Error('Target creature not found');
    targetCell.hp -= attacker.attack;
    if (targetCell.hp <= 0) {
      targetOwner.graveyard.push(targetCell.instance_id);
      targetOwner.board.rows[target.position.row][target.position.col] = null;
      await resolveOnDeathEffect(matchId, state, targetOwner, attackerOwner, targetCell);
    }
  } else {
    if (target.playerIndex === playerIndex) throw new Error('Cannot attack yourself');
    getPlayer(state, target.playerIndex).life -= attacker.attack;
  }

  attacker.tired = true;
  await logMatchAction(matchId, { turn: state.current_turn, phase: 'main', player_index: playerIndex, action_type: 'attack', attacker_card_id: attacker.instance_id, target_player_index: target.type === 'player' ? target.playerIndex : undefined, description: `Player ${playerIndex} attacked` });
  const winner = checkWinCondition(state);
  if (winner !== null) await finalizeMatch(matchId, state, winner);
  else await saveGameState(matchId, state);
  return state;
}

async function dispatchEffect(matchId: string, state: GameState, player: PlayerState, opponent: PlayerState, card: CardData, effect: EffectDefinition) {
  switch (effect.type) {
    case 'draw': return effectDraw(matchId, state, player, opponent, card, effect);
    case 'damage':
    case 'damage_creature': return effectDamage(matchId, state, player, opponent, card, effect);
    case 'heal': return effectHeal(matchId, state, player, opponent, card, effect);
    case 'discard':
    case 'discard_random': return effectDiscard(matchId, state, player, opponent, card, effect);
    case 'buff': return effectBuff(matchId, state, player, opponent, card, effect);
    case 'return_hand': return effectReturnHand(matchId, state, player, opponent, card, effect);
    case 'destroy': return effectDestroy(matchId, state, player, opponent, card, effect);
    case 'exile': return effectExile(matchId, state, player, opponent, card, effect);
    case 'mill': return effectMill(matchId, state, player, opponent, card, effect);
    case 'counter':
    case 'search_deck':
    case 'create_token':
    case 'custom':
      return logMatchAction(matchId, { turn: state.current_turn, phase: state.phase, player_index: player.player_index, action_type: `effect_${effect.type}`, card_id: card.id, description: `${card.name}: ${effect.type} is not implemented yet` });
    default: throw new Error(`Unsupported effect type: ${String(effect.type)}`);
  }
}

export async function resolveOnPlayEffect(matchId: string, state: GameState, player: PlayerState, opponent: PlayerState, card: CardData) {
  for (const effect of getEffects(card.effect_json)) await dispatchEffect(matchId, state, player, opponent, card, effect);
}

export async function resolveOnDeathEffect(matchId: string, state: GameState, deadOwner: PlayerState, killerOwner: PlayerState, deadCell: BoardCell) {
  const card = await getCardData(deadCell.card_id);
  const effects = getEffects(card.effect_on_death_json);
  state.anti_loop_counter = (state.anti_loop_counter ?? 0) + effects.length;
  if (state.anti_loop_counter > ANTI_LOOP_LIMIT) {
    for (const player of state.players) {
      for (let row = 0; row < BOARD_SIZE; row++) for (let col = 0; col < BOARD_SIZE; col++) {
        const cell = player.board.rows[row][col];
        if (cell) { player.graveyard.push(cell.instance_id); player.board.rows[row][col] = null; }
      }
      player.board.field_spell = null;
    }
    state.status = 'finished';
    await saveGameState(matchId, state);
    return;
  }
  for (const effect of effects) await dispatchEffect(matchId, state, deadOwner, killerOwner, card, effect);
}

async function effectDraw(matchId: string, state: GameState, player: PlayerState, opponent: PlayerState, card: CardData, effect: EffectDefinition) {
  const recipient = effect.target === 'opponent' ? opponent : player;
  const amount = Math.max(0, effect.amount ?? 1);
  for (let i = 0; i < amount && recipient.deck.length; i++) recipient.hand.push(recipient.deck.shift()!);
  await logMatchAction(matchId, { turn: state.current_turn, phase: state.phase, player_index: player.player_index, action_type: 'effect_draw', card_id: card.id, amount, description: `${card.name}: draw ${amount}` });
}

function locateTarget(state: GameState, instanceId?: string) {
  if (!instanceId) throw new Error('Effect requires target_card_id');
  const ownerIndex = getCardOwner(state, instanceId);
  if (ownerIndex === null) throw new Error('Effect target not found');
  const owner = state.players[ownerIndex];
  const position = findCardPosition(owner, instanceId);
  if (!position) throw new Error('Effect target is not a creature');
  const cell = owner.board.rows[position.row][position.col];
  if (!cell) throw new Error('Effect target is empty');
  return { owner, position, cell };
}

async function effectDamage(matchId: string, state: GameState, player: PlayerState, opponent: PlayerState, card: CardData, effect: EffectDefinition) {
  const amount = Math.max(0, effect.amount ?? 0);
  const target = effect.target ?? 'any_creature';
  const cells: Array<{ owner: PlayerState; row: number; col: number; cell: BoardCell }> = [];
  if (target === 'any_creature') {
    const located = locateTarget(state, effect.target_card_id);
    cells.push({ owner: located.owner, row: located.position.row, col: located.position.col, cell: located.cell });
  } else {
    const owners = target === 'all_creatures_self' ? [player] : target === 'all_creatures_opponent' ? [opponent] : state.players;
    for (const owner of owners) for (let row = 0; row < BOARD_SIZE; row++) for (let col = 0; col < BOARD_SIZE; col++) {
      const cell = owner.board.rows[row][col];
      if (cell) cells.push({ owner, row, col, cell });
    }
  }
  for (const item of cells) {
    item.cell.hp -= amount;
    if (item.cell.hp <= 0) {
      item.owner.graveyard.push(item.cell.instance_id);
      item.owner.board.rows[item.row][item.col] = null;
      await resolveOnDeathEffect(matchId, state, item.owner, player, item.cell);
    }
  }
  await logMatchAction(matchId, { turn: state.current_turn, phase: state.phase, player_index: player.player_index, action_type: 'effect_damage', card_id: card.id, amount, description: `${card.name}: damage ${amount}` });
}

async function effectHeal(matchId: string, state: GameState, player: PlayerState, opponent: PlayerState, card: CardData, effect: EffectDefinition) {
  const amount = Math.max(0, effect.amount ?? 1);
  if (effect.target === 'self' || !effect.target) player.life += amount;
  else if (effect.target === 'opponent') opponent.life += amount;
  else if (effect.target === 'any_creature') {
    const { cell } = locateTarget(state, effect.target_card_id);
    cell.hp = Math.min(cell.max_hp, cell.hp + amount);
  } else {
    const owners = effect.target === 'all_creatures_self' ? [player] : effect.target === 'all_creatures_opponent' ? [opponent] : state.players;
    for (const owner of owners) for (const row of owner.board.rows) for (const cell of row) if (cell) cell.hp = Math.min(cell.max_hp, cell.hp + amount);
  }
  await logMatchAction(matchId, { turn: state.current_turn, phase: state.phase, player_index: player.player_index, action_type: 'effect_heal', card_id: card.id, amount, description: `${card.name}: heal ${amount}` });
}

async function effectDiscard(matchId: string, state: GameState, player: PlayerState, opponent: PlayerState, card: CardData, effect: EffectDefinition) {
  const target = effect.target === 'self' ? player : opponent;
  const amount = Math.max(0, effect.amount ?? 1);
  for (let i = 0; i < amount && target.hand.length; i++) {
    const index = effect.type === 'discard_random' ? Math.floor(Math.random() * target.hand.length) : target.hand.length - 1;
    target.graveyard.push(target.hand.splice(index, 1)[0]);
  }
  await logMatchAction(matchId, { turn: state.current_turn, phase: state.phase, player_index: player.player_index, action_type: 'effect_discard', card_id: card.id, amount, description: `${card.name}: discard ${amount}` });
}

async function effectBuff(matchId: string, state: GameState, player: PlayerState, opponent: PlayerState, card: CardData, effect: EffectDefinition) {
  const amount = effect.amount ?? 0;
  const apply = (cell: BoardCell) => {
    if (effect.stat === 'hp') { cell.max_hp += amount; cell.hp += amount; }
    else cell.attack += amount;
  };
  if (effect.target === 'any_creature' || !effect.target) apply(locateTarget(state, effect.target_card_id).cell);
  else {
    const owners = effect.target === 'all_creatures_self' ? [player] : effect.target === 'all_creatures_opponent' ? [opponent] : state.players;
    for (const owner of owners) for (const row of owner.board.rows) for (const cell of row) if (cell) apply(cell);
  }
  await logMatchAction(matchId, { turn: state.current_turn, phase: state.phase, player_index: player.player_index, action_type: 'effect_buff', card_id: card.id, amount, stat: effect.stat, description: `${card.name}: buff ${amount}` });
}

async function effectReturnHand(matchId: string, state: GameState, player: PlayerState, opponent: PlayerState, card: CardData, effect: EffectDefinition) {
  const located = locateTarget(state, effect.target_card_id);
  located.owner.board.rows[located.position.row][located.position.col] = null;
  located.owner.hand.push(located.cell.instance_id);
  await logMatchAction(matchId, { turn: state.current_turn, phase: state.phase, player_index: player.player_index, action_type: 'effect_return_hand', card_id: card.id, description: `${card.name}: return to hand` });
}

async function effectDestroy(matchId: string, state: GameState, player: PlayerState, opponent: PlayerState, card: CardData, effect: EffectDefinition) {
  const located = locateTarget(state, effect.target_card_id);
  located.owner.board.rows[located.position.row][located.position.col] = null;
  located.owner.graveyard.push(located.cell.instance_id);
  await resolveOnDeathEffect(matchId, state, located.owner, player, located.cell);
  await logMatchAction(matchId, { turn: state.current_turn, phase: state.phase, player_index: player.player_index, action_type: 'effect_destroy', card_id: card.id, description: `${card.name}: destroy` });
}

async function effectExile(matchId: string, state: GameState, player: PlayerState, opponent: PlayerState, card: CardData, effect: EffectDefinition) {
  const located = locateTarget(state, effect.target_card_id);
  located.owner.board.rows[located.position.row][located.position.col] = null;
  await logMatchAction(matchId, { turn: state.current_turn, phase: state.phase, player_index: player.player_index, action_type: 'effect_exile', card_id: card.id, description: `${card.name}: exile` });
}

async function effectMill(matchId: string, state: GameState, player: PlayerState, opponent: PlayerState, card: CardData, effect: EffectDefinition) {
  const target = effect.target === 'self' ? player : opponent;
  const amount = Math.max(0, effect.amount ?? 1);
  for (let i = 0; i < amount && target.deck.length; i++) target.graveyard.push(target.deck.shift()!);
  await logMatchAction(matchId, { turn: state.current_turn, phase: state.phase, player_index: player.player_index, action_type: 'effect_mill', card_id: card.id, amount, description: `${card.name}: mill ${amount}` });
}
