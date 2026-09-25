import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AttackTarget,
  BoardCell,
  CardData,
  CardInstance,
  EffectDefinition,
  GameState,
  MatchLogEntry,
  PlayerIndex,
  PlayerState,
  PlayCardOptions,
  Position,
  TurnPhase,
} from './types.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
}

const supabase: SupabaseClient = createClient(supabaseUrl, supabaseServiceKey);

const MANA_CAP = 6;
const BOARD_SIZE = 3;
const LIFE_TOTAL = 20;
const ANTI_LOOP_LIMIT = 20;

function getPlayer(state: GameState, playerIndex: PlayerIndex): PlayerState {
  return state.players[playerIndex];
}

function otherPlayer(playerIndex: PlayerIndex): PlayerIndex {
  return playerIndex === 0 ? 1 : 0;
}

function isValidPosition(position: Position): boolean {
  return (
    Number.isInteger(position.row) &&
    Number.isInteger(position.col) &&
    position.row >= 0 &&
    position.row < BOARD_SIZE &&
    position.col >= 0 &&
    position.col < BOARD_SIZE
  );
}

function phaseToNumber(phase: TurnPhase): number {
  if (phase === 'start') return 0;
  if (phase === 'upkeep') return 1;
  if (phase === 'main') return 2;
  return 3;
}

function emptyBoard() {
  return {
    field_spell: null,
    rows: [
      [null, null, null],
      [null, null, null],
      [null, null, null],
    ] as [
      [BoardCell | null, BoardCell | null, BoardCell | null],
      [BoardCell | null, BoardCell | null, BoardCell | null],
      [BoardCell | null, BoardCell | null, BoardCell | null],
    ],
  };
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }

  return result;
}

function createInstances(cardIds: string[]): CardInstance[] {
  return cardIds.map((cardId) => ({
    instance_id: randomUUID(),
    card_id: cardId,
  }));
}

function describePlayer(playerIndex: PlayerIndex): string {
  return playerIndex === 1 ? 'Tu' : 'L’IA';
}

function normalizeState(rawState: unknown): GameState {
  const state = rawState as GameState;

  if (!state || typeof state !== 'object') {
    throw new Error('Stato partita non valido');
  }

  state.anti_loop_counter = Number(state.anti_loop_counter ?? 0);
  state.winner_index = state.winner_index ?? null;

  for (const player of state.players) {
    player.deck = Array.isArray(player.deck) ? player.deck : [];
    player.hand = Array.isArray(player.hand) ? player.hand : [];
    player.graveyard = Array.isArray(player.graveyard) ? player.graveyard : [];
    player.extra_deck = Array.isArray(player.extra_deck) ? player.extra_deck : [];
    player.color_counters = player.color_counters ?? {};
    player.board = player.board ?? emptyBoard();
    player.board.field_spell = player.board.field_spell ?? null;
    player.board.rows = player.board.rows ?? emptyBoard().rows;
  }

  return state;
}

async function loadState(matchId: string): Promise<GameState> {
  const { data, error } = await supabase
    .from('game_state')
    .select('state_json')
    .eq('match_id', matchId)
    .single();

  if (error || !data) {
    throw new Error(`Game state not found: ${error?.message ?? matchId}`);
  }

  return normalizeState(data.state_json);
}

export async function saveGameState(matchId: string, state: GameState): Promise<void> {
  const { error } = await supabase
    .from('game_state')
    .update({
      state_json: state,
      current_turn: state.current_turn,
      current_phase: phaseToNumber(state.phase),
      last_updated: new Date().toISOString(),
    })
    .eq('match_id', matchId);

  if (error) {
    throw new Error(`Could not save game state: ${error.message}`);
  }
}

export async function logMatchAction(
  matchId: string,
  entry: MatchLogEntry,
): Promise<void> {
  const { error } = await supabase
    .from('match_logs')
    .insert({
      match_id: matchId,
      log_data: entry,
    });

  if (error) {
    throw new Error(`Could not write match log: ${error.message}`);
  }
}

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
      factions!left(code)
    `)
    .eq('id', cardId)
    .single();

  if (error || !data) {
    throw new Error(`Card not found: ${cardId}`);
  }

  const factionRelation = Array.isArray(data.factions)
    ? data.factions[0]
    : data.factions;

  const factionCode =
    factionRelation && typeof factionRelation === 'object' && 'code' in factionRelation
      ? String(factionRelation.code)
      : 'IND';

  return {
    id: String(data.id),
    name: String(data.name),
    faction_id: data.faction_id === null ? null : Number(data.faction_id),
    faction_code: factionCode,
    card_type: String(data.card_type) as CardData['card_type'],
    mana_cost: Number(data.mana_cost ?? 0),
    sacrifice_cost: Number(data.sacrifice_cost ?? 0),
    attack: data.attack === null ? null : Number(data.attack),
    hp: data.hp === null ? null : Number(data.hp),
    subtype: data.subtype === null ? null : String(data.subtype),
    rarity: String(data.rarity ?? 'common'),
    effect_text: data.effect_text === null ? null : String(data.effect_text),
    effect_json: (data.effect_json ?? null) as EffectDefinition | null,
    effect_on_death_json: (data.effect_on_death_json ?? null) as EffectDefinition | null,
    flavor_text: data.flavor_text === null ? null : String(data.flavor_text),
    image_url: data.image_url === null ? null : String(data.image_url),
  };
}

function findBoardCell(
  player: PlayerState,
  instanceId: string,
): { position: Position; cell: BoardCell } | null {
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const cell = player.board.rows[row][col];

      if (cell?.instance_id === instanceId) {
        return {
          position: { row, col },
          cell,
        };
      }
    }
  }

  return null;
}

function findInstance(
  state: GameState,
  instanceId: string,
): { owner: PlayerState; instance: CardInstance; zone: string } | null {
  for (const player of state.players) {
    const zones: Array<[string, CardInstance[]]> = [
      ['deck', player.deck],
      ['hand', player.hand],
      ['graveyard', player.graveyard],
      ['extra_deck', player.extra_deck],
    ];

    for (const [zone, cards] of zones) {
      const instance = cards.find((candidate) => candidate.instance_id === instanceId);

      if (instance) {
        return { owner: player, instance, zone };
      }
    }

    const boardResult = findBoardCell(player, instanceId);

    if (boardResult) {
      return {
        owner: player,
        instance: {
          instance_id: boardResult.cell.instance_id,
          card_id: boardResult.cell.card_id,
        },
        zone: 'board',
      };
    }
  }

  return null;
}

function removeFromHand(player: PlayerState, instanceId: string): CardInstance {
  const index = player.hand.findIndex((card) => card.instance_id === instanceId);

  if (index === -1) {
    throw new Error('La carta selezionata non è nella mano del giocatore');
  }

  return player.hand.splice(index, 1)[0];
}

function drawCards(player: PlayerState, amount: number): CardInstance[] {
  const drawn: CardInstance[] = [];

  for (let index = 0; index < amount; index += 1) {
    const card = player.deck.shift();

    if (!card) {
      break;
    }

    player.hand.push(card);
    drawn.push(card);
  }

  return drawn;
}

function wakeCreatures(player: PlayerState): void {
  for (const row of player.board.rows) {
    for (const cell of row) {
      if (cell) {
        cell.tired = false;
      }
    }
  }
}

function countCreatures(player: PlayerState): number {
  let count = 0;

  for (const row of player.board.rows) {
    for (const cell of row) {
      if (cell) {
        count += 1;
      }
    }
  }

  return count;
}

function sacrificeCreatures(player: PlayerState, amount: number): CardInstance[] {
  const sacrificed: CardInstance[] = [];

  for (let row = 0; row < BOARD_SIZE && sacrificed.length < amount; row += 1) {
    for (let col = 0; col < BOARD_SIZE && sacrificed.length < amount; col += 1) {
      const cell = player.board.rows[row][col];

      if (!cell) {
        continue;
      }

      const instance = {
        instance_id: cell.instance_id,
        card_id: cell.card_id,
      };

      sacrificed.push(instance);
      player.graveyard.push(instance);
      player.board.rows[row][col] = null;
    }
  }

  if (sacrificed.length !== amount) {
    throw new Error('Non ci sono abbastanza creature da sacrificare');
  }

  return sacrificed;
}

function targetCreature(
  state: GameState,
  instanceId: string,
): { owner: PlayerState; position: Position; cell: BoardCell } {
  for (const player of state.players) {
    const found = findBoardCell(player, instanceId);

    if (found) {
      return {
        owner: player,
        position: found.position,
        cell: found.cell,
      };
    }
  }

  throw new Error('La creatura bersaglio non è sul campo');
}

async function destroyCreature(
  matchId: string,
  state: GameState,
  owner: PlayerState,
  position: Position,
  killer: PlayerState | null,
): Promise<void> {
  const cell = owner.board.rows[position.row][position.col];

  if (!cell) {
    return;
  }

  owner.board.rows[position.row][position.col] = null;

  const deadInstance: CardInstance = {
    instance_id: cell.instance_id,
    card_id: cell.card_id,
  };

  owner.graveyard.push(deadInstance);

  const card = await getCardData(cell.card_id);

  await logMatchAction(matchId, {
    turn: state.current_turn,
    phase: state.phase,
    player_index: owner.player_index,
    action_type: 'creature_destroyed',
    card_id: card.id,
    instance_id: deadInstance.instance_id,
    description: `${card.name} viene distrutto e finisce nel cimitero di ${describePlayer(owner.player_index)}.`,
  });

  if (!card.effect_on_death_json) {
    return;
  }

  state.anti_loop_counter += 1;

  if (state.anti_loop_counter > ANTI_LOOP_LIMIT) {
    await clearBoardForAntiLoop(matchId, state);
    return;
  }

  await resolveEffect(
    matchId,
    state,
    owner,
    killer ?? getPlayer(state, otherPlayer(owner.player_index)),
    card,
    card.effect_on_death_json,
    null,
  );
}

async function clearBoardForAntiLoop(
  matchId: string,
  state: GameState,
): Promise<void> {
  for (const player of state.players) {
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        const cell = player.board.rows[row][col];

        if (cell) {
          player.graveyard.push({
            instance_id: cell.instance_id,
            card_id: cell.card_id,
          });

          player.board.rows[row][col] = null;
        }
      }
    }

    player.board.field_spell = null;
  }

  await logMatchAction(matchId, {
    turn: state.current_turn,
    phase: state.phase,
    player_index: -1,
    action_type: 'anti_loop_cleanup',
    description:
      'Il ventesimo eco si spezza nel vuoto: la scacchiera viene inghiottita dalla Penombra.',
  });
}

async function resolveEffect(
  matchId: string,
  state: GameState,
  controller: PlayerState,
  opponent: PlayerState,
  sourceCard: CardData,
  effect: EffectDefinition,
  targetInstanceId: string | null,
): Promise<void> {
  const amount = Math.max(0, Number(effect.amount ?? 1));
  const target = effect.target ?? 'self';

  if (effect.type === 'draw') {
    const recipient = target === 'opponent' ? opponent : controller;
    const drawn = drawCards(recipient, amount);

    await logMatchAction(matchId, {
      turn: state.current_turn,
      phase: state.phase,
      player_index: controller.player_index,
      action_type: 'effect_draw',
      card_id: sourceCard.id,
      amount: drawn.length,
      description: `${sourceCard.name}: ${describePlayer(recipient.player_index)} pesca ${drawn.length} carta/e.`,
    });

    return;
  }

  if (effect.type === 'discard') {
    const recipient = target === 'self' ? controller : opponent;
    let discarded = 0;

    for (let index = 0; index < amount && recipient.hand.length > 0; index += 1) {
      const discardIndex = Math.floor(Math.random() * recipient.hand.length);
      const [card] = recipient.hand.splice(discardIndex, 1);

      if (card) {
        recipient.graveyard.push(card);
        discarded += 1;
      }
    }

    await logMatchAction(matchId, {
      turn: state.current_turn,
      phase: state.phase,
      player_index: controller.player_index,
      action_type: 'effect_discard',
      card_id: sourceCard.id,
      amount: discarded,
      description: `${sourceCard.name}: ${describePlayer(recipient.player_index)} scarta ${discarded} carta/e.`,
    });

    return;
  }

  if (effect.type === 'heal') {
    if (target === 'all_creatures') {
      for (const row of controller.board.rows) {
        for (const cell of row) {
          if (cell) {
            cell.hp = Math.min(cell.max_hp, cell.hp + amount);
          }
        }
      }

      await logMatchAction(matchId, {
        turn: state.current_turn,
        phase: state.phase,
        player_index: controller.player_index,
        action_type: 'effect_heal_all',
        card_id: sourceCard.id,
        amount,
        description: `${sourceCard.name}: tutte le creature di ${describePlayer(controller.player_index)} recuperano ${amount} HP.`,
      });

      return;
    }

    if (target === 'any_creature') {
      if (!targetInstanceId) {
        throw new Error('Questa carta richiede una creatura bersaglio');
      }

      const found = targetCreature(state, targetInstanceId);
      found.cell.hp = Math.min(found.cell.max_hp, found.cell.hp + amount);

      await logMatchAction(matchId, {
        turn: state.current_turn,
        phase: state.phase,
        player_index: controller.player_index,
        action_type: 'effect_heal_creature',
        card_id: sourceCard.id,
        target_instance_id: targetInstanceId,
        amount,
        description: `${sourceCard.name}: ${amount} HP recuperati da una creatura.`,
      });

      return;
    }

    const recipient = target === 'opponent' ? opponent : controller;
    recipient.life += amount;

    await logMatchAction(matchId, {
      turn: state.current_turn,
      phase: state.phase,
      player_index: controller.player_index,
      action_type: 'effect_heal_player',
      card_id: sourceCard.id,
      amount,
      description: `${sourceCard.name}: ${describePlayer(recipient.player_index)} recupera ${amount} vita.`,
    });

    return;
  }

  if (effect.type === 'damage') {
    if (target !== 'any_creature') {
      throw new Error(`Effetto danno non supportato: bersaglio ${target}`);
    }

    if (!targetInstanceId) {
      throw new Error('Questa carta richiede una creatura bersaglio');
    }

    const found = targetCreature(state, targetInstanceId);
    found.cell.hp -= amount;

    await logMatchAction(matchId, {
      turn: state.current_turn,
      phase: state.phase,
      player_index: controller.player_index,
      action_type: 'effect_damage_creature',
      card_id: sourceCard.id,
      target_instance_id: targetInstanceId,
      amount,
      description: `${sourceCard.name}: infligge ${amount} danno/i a una creatura.`,
    });

    if (found.cell.hp <= 0) {
      await destroyCreature(matchId, state, found.owner, found.position, controller);
    }

    return;
  }

  if (effect.type === 'return_hand') {
    if (!targetInstanceId) {
      throw new Error('Questa carta richiede una creatura bersaglio');
    }

    const found = targetCreature(state, targetInstanceId);

    found.owner.board.rows[found.position.row][found.position.col] = null;
    found.owner.hand.push({
      instance_id: found.cell.instance_id,
      card_id: found.cell.card_id,
    });

    await logMatchAction(matchId, {
      turn: state.current_turn,
      phase: state.phase,
      player_index: controller.player_index,
      action_type: 'effect_return_hand',
      card_id: sourceCard.id,
      target_instance_id: targetInstanceId,
      description: `${sourceCard.name}: una creatura torna nella mano del proprietario.`,
    });

    return;
  }

  await logMatchAction(matchId, {
    turn: state.current_turn,
    phase: state.phase,
    player_index: controller.player_index,
    action_type: 'effect_not_implemented',
    card_id: sourceCard.id,
    description: `${sourceCard.name}: effetto "${effect.type}" non ancora implementato.`,
  });
}

function requiresTarget(card: CardData): boolean {
  const effect = card.effect_json;

  return Boolean(
    effect &&
      (effect.target === 'any_creature' || effect.type === 'return_hand'),
  );
}

function isCreatureCard(card: CardData): boolean {
  return card.card_type === 'monster' || card.card_type === 'mostrissimo';
}

async function getGeneratedDeck(): Promise<CardInstance[]> {
  const { data, error } = await supabase
    .from('cards')
    .select('id, mana_cost, card_type')
    .in('card_type', ['monster', 'sorcery', 'instant', 'terraforma', 'aura'])
    .order('mana_cost', { ascending: true });

  if (error || !data || data.length < 10) {
    throw new Error('Il catalogo non contiene abbastanza carte per generare un mazzo');
  }

  const cards = data.map((card) => ({
    id: String(card.id),
    mana_cost: Number(card.mana_cost),
    card_type: String(card.card_type),
  }));

  const monsters = cards.filter((card) => card.card_type === 'monster');

  if (monsters.length < 6) {
    throw new Error('Il catalogo non contiene abbastanza Mostri per una partita di test');
  }

  const lowCostMonsters = monsters.filter((card) => card.mana_cost <= 2);
  const midCostMonsters = monsters.filter(
    (card) => card.mana_cost >= 2 && card.mana_cost <= 4,
  );
  const highCostMonsters = monsters.filter((card) => card.mana_cost >= 5);

  const pick = <T>(pool: T[]): T => pool[Math.floor(Math.random() * pool.length)];

  const selected = [
    pick(highCostMonsters.length ? highCostMonsters : monsters),
    pick(lowCostMonsters.length ? lowCostMonsters : monsters),
    pick(lowCostMonsters.length ? lowCostMonsters : monsters),
    pick(midCostMonsters.length ? midCostMonsters : monsters),
    pick(midCostMonsters.length ? midCostMonsters : monsters),
    pick(midCostMonsters.length ? midCostMonsters : monsters),
    pick(monsters),
    pick(monsters),
    pick(cards),
    pick(cards),
  ];

  return createInstances(selected.map((card) => card.id));
}

function createPlayerState(
  playerIndex: PlayerIndex,
  userId: string | null,
  deck: CardInstance[],
): PlayerState {
  return {
    player_index: playerIndex,
    user_id: userId,
    life: LIFE_TOTAL,
    max_mana: 0,
    current_mana: 0,
    deck: shuffle(deck),
    hand: [],
    graveyard: [],
    extra_deck: [],
    color_counters: {
      CHI: 0,
      INF: 0,
      PES: 0,
      BUL: 0,
      GRO: 0,
      CLO: 0,
      IND: 0,
    },
    board: emptyBoard(),
  };
}

export async function createNewMatch(userId: string): Promise<{
  matchId: string;
  state: GameState;
}> {
  const { data: match, error: matchError } = await supabase
    .from('matches')
    .insert({
      player_id: userId,
      opponent_type: 'ai',
      opponent_name: 'IA Bellum Penumbrum',
      player_won: null,
      turns_count: 0,
      duration_seconds: 0,
    })
    .select('id')
    .single();

  if (matchError || !match?.id) {
    throw new Error(`Could not create match: ${matchError?.message ?? 'unknown error'}`);
  }

  const matchId = String(match.id);
  const [aiDeck, playerDeck] = await Promise.all([
    getGeneratedDeck(),
    getGeneratedDeck(),
  ]);

  const ai = createPlayerState(0, null, aiDeck);
  const player = createPlayerState(1, userId, playerDeck);

  drawCards(player, 3);
  drawCards(ai, 4);

  const state: GameState = {
    match_id: matchId,
    status: 'running',
    players: [ai, player],
    current_turn: 1,
    active_player_index: 1,
    phase: 'upkeep',
    anti_loop_counter: 0,
    winner_index: null,
  };

  player.max_mana = 1;
  player.current_mana = 1;
  state.phase = 'main';

  const { error: stateError } = await supabase
    .from('game_state')
    .insert({
      match_id: matchId,
      state_json: state,
      current_turn: state.current_turn,
      current_phase: phaseToNumber(state.phase),
      last_updated: new Date().toISOString(),
    });

  if (stateError) {
    throw new Error(`Could not create game state: ${stateError.message}`);
  }

  await logMatchAction(matchId, {
    turn: 1,
    phase: 'start',
    player_index: -1,
    action_type: 'match_create',
    description: 'La partita contro IA Bellum Penumbrum è iniziata.',
  });

  await logMatchAction(matchId, {
    turn: 1,
    phase: 'upkeep',
    player_index: 1,
    action_type: 'opening_hand',
    amount: 3,
    description: 'Tu inizi la partita con 3 carte e 1 mana.',
  });

  await logMatchAction(matchId, {
    turn: 1,
    phase: 'upkeep',
    player_index: 0,
    action_type: 'opening_hand',
    amount: 4,
    description: 'L’IA inizia con 4 carte.',
  });

  return { matchId, state };
}

export async function getMatchState(matchId: string): Promise<GameState> {
  return loadState(matchId);
}

async function startTurn(matchId: string, playerIndex: PlayerIndex): Promise<GameState> {
  const state = await loadState(matchId);

  if (state.status !== 'running') {
    throw new Error('La partita è terminata');
  }

  state.active_player_index = playerIndex;
  state.phase = 'start';
  state.anti_loop_counter = 0;

  if (playerIndex === 1) {
    state.current_turn += 1;
  }

  const player = getPlayer(state, playerIndex);
  const opponent = getPlayer(state, otherPlayer(playerIndex));

  await logMatchAction(matchId, {
    turn: state.current_turn,
    phase: 'start',
    player_index: playerIndex,
    action_type: 'turn_start',
    description: `Inizia il turno di ${describePlayer(playerIndex)}.`,
  });

  state.phase = 'upkeep';
  player.max_mana = Math.min(MANA_CAP, player.max_mana + 1);
  player.current_mana = player.max_mana;
  wakeCreatures(player);

  const drawn = drawCards(player, 1);

  if (drawn.length === 0) {
    await finalizeMatch(matchId, state, opponent.player_index, 'Mazzo esaurito.');
    return state;
  }

  await logMatchAction(matchId, {
    turn: state.current_turn,
    phase: 'upkeep',
    player_index: playerIndex,
    action_type: 'upkeep',
    amount: player.current_mana,
    description: `${describePlayer(playerIndex)} raggiunge ${player.current_mana}/${player.max_mana} mana e pesca una carta.`,
  });

  state.phase = 'main';
  await saveGameState(matchId, state);

  return state;
}

async function finalizeMatch(
  matchId: string,
  state: GameState,
  winnerIndex: PlayerIndex | null,
  reason: string,
): Promise<void> {
  state.status = 'finished';
  state.phase = 'end';
  state.winner_index = winnerIndex;

  const { error } = await supabase
    .from('matches')
    .update({
      player_won: winnerIndex === null ? null : winnerIndex === 1,
      turns_count: state.current_turn,
    })
    .eq('id', matchId);

  if (error) {
    throw new Error(`Could not finalize match: ${error.message}`);
  }

  await saveGameState(matchId, state);

  const result =
    winnerIndex === null
      ? 'La partita termina in pareggio.'
      : winnerIndex === 1
        ? 'Hai vinto la partita.'
        : 'L’IA ha vinto la partita.';

  await logMatchAction(matchId, {
    turn: state.current_turn,
    phase: 'end',
    player_index: winnerIndex ?? -1,
    action_type: 'match_end',
    description: `${result} ${reason}`,
  });
}

function checkWinner(state: GameState): PlayerIndex | null {
  const aiLife = state.players[0].life;
  const playerLife = state.players[1].life;

  if (aiLife <= 0 && playerLife <= 0) {
    return null;
  }

  if (aiLife <= 0) {
    return 1;
  }

  if (playerLife <= 0) {
    return 0;
  }

  return null;
}

export async function playCard(
  matchId: string,
  playerIndex: PlayerIndex,
  instanceId: string,
  options: PlayCardOptions = {},
): Promise<GameState> {
  const state = await loadState(matchId);

  if (state.status !== 'running') {
    throw new Error('La partita è terminata');
  }

  if (state.active_player_index !== playerIndex || state.phase !== 'main') {
    throw new Error('Non è il turno del giocatore');
  }

  const player = getPlayer(state, playerIndex);
  const opponent = getPlayer(state, otherPlayer(playerIndex));
  const inHand = player.hand.find((card) => card.instance_id === instanceId);

  if (!inHand) {
    throw new Error('La carta non è nella mano del giocatore');
  }

  const card = await getCardData(inHand.card_id);

  if (player.current_mana < card.mana_cost) {
    throw new Error('Mana insufficiente');
  }

  if (isCreatureCard(card)) {
    if (!options.position || !isValidPosition(options.position)) {
      throw new Error('Scegli una posizione valida per la creatura');
    }

    if (player.board.rows[options.position.row][options.position.col]) {
      throw new Error('La cella scelta è già occupata');
    }

    if (
      card.card_type === 'mostrissimo' &&
      countCreatures(player) < card.sacrifice_cost
    ) {
      throw new Error(`Servono ${card.sacrifice_cost} creature da sacrificare`);
    }
  }

  if (card.card_type === 'terraforma' && player.board.field_spell) {
    throw new Error('Hai già una Terraforma attiva');
  }

  if (requiresTarget(card) && !options.targetInstanceId) {
    throw new Error('Questa carta richiede di selezionare una creatura bersaglio');
  }

  if (options.targetInstanceId) {
    targetCreature(state, options.targetInstanceId);
  }

  const instance = removeFromHand(player, instanceId);
  player.current_mana -= card.mana_cost;
  player.color_counters[card.faction_code] =
    Number(player.color_counters[card.faction_code] ?? 0) + 1;

  if (card.card_type === 'monster' || card.card_type === 'mostrissimo') {
    if (card.card_type === 'mostrissimo' && card.sacrifice_cost > 0) {
      const sacrificed = sacrificeCreatures(player, card.sacrifice_cost);

      await logMatchAction(matchId, {
        turn: state.current_turn,
        phase: state.phase,
        player_index: playerIndex,
        action_type: 'sacrifice',
        amount: sacrificed.length,
        card_id: card.id,
        instance_id: instance.instance_id,
        description: `${describePlayer(playerIndex)} sacrifica ${sacrificed.length} creatura/e per evocare ${card.name}.`,
      });
    }

    const position = options.position as Position;

    player.board.rows[position.row][position.col] = {
      instance_id: instance.instance_id,
      card_id: card.id,
      attack: Number(card.attack ?? 0),
      hp: Number(card.hp ?? 1),
      max_hp: Number(card.hp ?? 1),
      tired: false,
      auras: [],
    };
  } else if (card.card_type === 'terraforma') {
    player.board.field_spell = {
      instance_id: instance.instance_id,
      card_id: card.id,
    };
  } else if (card.card_type === 'aura') {
    const target = targetCreature(state, options.targetInstanceId as string);

    target.cell.auras.push({
      instance_id: instance.instance_id,
      card_id: card.id,
    });
  } else {
    player.graveyard.push(instance);
  }

  await logMatchAction(matchId, {
    turn: state.current_turn,
    phase: state.phase,
    player_index: playerIndex,
    action_type: 'play_card',
    card_id: card.id,
    instance_id: instance.instance_id,
    position: options.position ?? null,
    target_instance_id: options.targetInstanceId,
    description: `${describePlayer(playerIndex)} gioca ${card.name}.`,
  });

  if (card.effect_json) {
    await resolveEffect(
      matchId,
      state,
      player,
      opponent,
      card,
      card.effect_json,
      options.targetInstanceId ?? null,
    );
  }

  const winner = checkWinner(state);

  if (winner !== null) {
    await finalizeMatch(matchId, state, winner, 'La vita di un giocatore è scesa a zero.');
    return state;
  }

  await saveGameState(matchId, state);
  return state;
}

function hasDirectAttackBlocker(
  defender: PlayerState,
  attackerPosition: Position,
): boolean {
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    const cell = defender.board.rows[row][attackerPosition.col];

    if (cell) {
      return true;
    }
  }

  return false;
}

export async function attack(
  matchId: string,
  playerIndex: PlayerIndex,
  attackerPosition: Position,
  target: AttackTarget,
): Promise<GameState> {
  const state = await loadState(matchId);

  if (state.status !== 'running') {
    throw new Error('La partita è terminata');
  }

  if (state.active_player_index !== playerIndex || state.phase !== 'main') {
    throw new Error('Non è il turno del giocatore');
  }

  if (!isValidPosition(attackerPosition)) {
    throw new Error('Posizione attaccante non valida');
  }

  const attackerOwner = getPlayer(state, playerIndex);
  const defenderIndex = otherPlayer(playerIndex);
  const defender = getPlayer(state, defenderIndex);
  const attacker = attackerOwner.board.rows[attackerPosition.row][attackerPosition.col];

  if (!attacker) {
    throw new Error('Non c’è alcuna creatura attaccante in quella cella');
  }

  if (attacker.tired) {
    throw new Error('Questa creatura è stanca e non può attaccare');
  }

  if (target.type === 'player') {
    if (target.playerIndex !== defenderIndex) {
      throw new Error('Non puoi attaccare il tuo stesso giocatore');
    }

    if (hasDirectAttackBlocker(defender, attackerPosition)) {
      throw new Error(
        'Attacco diretto bloccato: esiste una creatura nemica nella stessa colonna.',
      );
    }

    defender.life -= attacker.attack;
    attacker.tired = true;

    await logMatchAction(matchId, {
      turn: state.current_turn,
      phase: state.phase,
      player_index: playerIndex,
      action_type: 'attack_player',
      instance_id: attacker.instance_id,
      target_player_index: defenderIndex,
      amount: attacker.attack,
      description: `${describePlayer(playerIndex)} attacca direttamente e infligge ${attacker.attack} danno/i.`,
    });
  } else {
    if (target.ownerIndex !== defenderIndex || !isValidPosition(target.position)) {
      throw new Error('Bersaglio creatura non valido');
    }

    const targetCell = defender.board.rows[target.position.row][target.position.col];

    if (!targetCell) {
      throw new Error('La creatura bersaglio non è sul campo');
    }

    targetCell.hp -= attacker.attack;
    attacker.tired = true;

    await logMatchAction(matchId, {
      turn: state.current_turn,
      phase: state.phase,
      player_index: playerIndex,
      action_type: 'attack_creature',
      instance_id: attacker.instance_id,
      target_instance_id: targetCell.instance_id,
      amount: attacker.attack,
      description: `${describePlayer(playerIndex)} infligge ${attacker.attack} danno/i a una creatura nemica.`,
    });

    if (targetCell.hp <= 0) {
      await destroyCreature(matchId, state, defender, target.position, attackerOwner);
    }
  }

  const winner = checkWinner(state);

  if (winner !== null) {
    await finalizeMatch(matchId, state, winner, 'La vita di un giocatore è scesa a zero.');
    return state;
  }

  await saveGameState(matchId, state);
  return state;
}

export async function endHumanTurn(matchId: string): Promise<GameState> {
  const state = await loadState(matchId);

  if (state.status !== 'running') {
    throw new Error('La partita è terminata');
  }

  if (state.active_player_index !== 1 || state.phase !== 'main') {
    throw new Error('Non è il tuo turno');
  }

  state.phase = 'end';

  await logMatchAction(matchId, {
    turn: state.current_turn,
    phase: 'end',
    player_index: 1,
    action_type: 'turn_end',
    description: 'Termini il tuo turno.',
  });

  await saveGameState(matchId, state);

  const aiStarted = await startTurn(matchId, 0);
  await runAiTurn(matchId, aiStarted);

  const afterAi = await loadState(matchId);

  if (afterAi.status !== 'running') {
    return afterAi;
  }

  return startTurn(matchId, 1);
}

function getFreePositions(player: PlayerState): Position[] {
  const positions: Position[] = [];

  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (!player.board.rows[row][col]) {
        positions.push({ row, col });
      }
    }
  }

  return positions;
}

async function findAiPlay(
  state: GameState,
): Promise<{ instanceId: string; options: PlayCardOptions } | null> {
  const ai = state.players[0];
  const freePositions = getFreePositions(ai);

  const cards = await Promise.all(
    ai.hand.map(async (instance) => ({
      instance,
      card: await getCardData(instance.card_id),
    })),
  );

  const playableCreatures = cards
    .filter(
      ({ card }) =>
        isCreatureCard(card) &&
        card.mana_cost <= ai.current_mana &&
        freePositions.length > 0 &&
        (card.card_type !== 'mostrissimo' ||
          countCreatures(ai) >= card.sacrifice_cost),
    )
    .sort(
      (a, b) =>
        (b.card.attack ?? 0) +
        (b.card.hp ?? 0) -
        ((a.card.attack ?? 0) + (a.card.hp ?? 0)),
    );

  if (playableCreatures.length > 0) {
    return {
      instanceId: playableCreatures[0].instance.instance_id,
      options: {
        position: freePositions[0],
      },
    };
  }

  const safeSpells = cards
    .filter(
      ({ card }) =>
        card.mana_cost <= ai.current_mana &&
        !requiresTarget(card) &&
        card.card_type !== 'aura' &&
        card.card_type !== 'instant',
    )
    .sort((a, b) => b.card.mana_cost - a.card.mana_cost);

  if (safeSpells.length > 0) {
    return {
      instanceId: safeSpells[0].instance.instance_id,
      options: {},
    };
  }

  const targetedCards = cards
    .filter(
      ({ card }) =>
        card.mana_cost <= ai.current_mana &&
        requiresTarget(card),
    )
    .sort((a, b) => b.card.mana_cost - a.card.mana_cost);

  const human = state.players[1];
  const enemyTargets: BoardCell[] = [];

  for (const row of human.board.rows) {
    for (const cell of row) {
      if (cell) {
        enemyTargets.push(cell);
      }
    }
  }

  if (targetedCards.length > 0 && enemyTargets.length > 0) {
    return {
      instanceId: targetedCards[0].instance.instance_id,
      options: {
        targetInstanceId: enemyTargets[0].instance_id,
      },
    };
  }

  return null;
}

function findAiAttack(state: GameState): {
  attackerPosition: Position;
  target: AttackTarget;
} | null {
  const ai = state.players[0];
  const human = state.players[1];

  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const attacker = ai.board.rows[row][col];

      if (!attacker || attacker.tired || attacker.attack <= 0) {
        continue;
      }

      const sameColumnTarget = human.board.rows[0][col]
        ?? human.board.rows[1][col]
        ?? human.board.rows[2][col];

      if (sameColumnTarget) {
        let targetPosition: Position | null = null;

        for (let targetRow = 0; targetRow < BOARD_SIZE; targetRow += 1) {
          const candidate = human.board.rows[targetRow][col];

          if (candidate?.instance_id === sameColumnTarget.instance_id) {
            targetPosition = { row: targetRow, col };
            break;
          }
        }

        if (targetPosition) {
          return {
            attackerPosition: { row, col },
            target: {
              type: 'creature',
              ownerIndex: 1,
              position: targetPosition,
            },
          };
        }
      } else {
        return {
          attackerPosition: { row, col },
          target: {
            type: 'player',
            playerIndex: 1,
          },
        };
      }
    }
  }

  return null;
}

async function runAiTurn(matchId: string, initialState: GameState): Promise<void> {
  let state = initialState;

  for (let actionCount = 0; actionCount < 20; actionCount += 1) {
    if (
      state.status !== 'running' ||
      state.active_player_index !== 0 ||
      state.phase !== 'main'
    ) {
      break;
    }

    const play = await findAiPlay(state);

    if (play) {
      try {
        await playCard(matchId, 0, play.instanceId, play.options);
        state = await loadState(matchId);
        continue;
      } catch {
        state = await loadState(matchId);
      }
    }

    const attackAction = findAiAttack(state);

    if (attackAction) {
      try {
        await attack(
          matchId,
          0,
          attackAction.attackerPosition,
          attackAction.target,
        );
        state = await loadState(matchId);
        continue;
      } catch {
        state = await loadState(matchId);
      }
    }

    break;
  }

  state = await loadState(matchId);

  if (state.status === 'running' && state.active_player_index === 0) {
    state.phase = 'end';

    await logMatchAction(matchId, {
      turn: state.current_turn,
      phase: 'end',
      player_index: 0,
      action_type: 'turn_end',
      description: 'L’IA termina il proprio turno.',
    });

    await saveGameState(matchId, state);
  }
}
