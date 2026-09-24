import { Router, type Request, type Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  nextTurn,
  endTurn,
  playCard,
  attack,
  getCardData,
  logMatchAction,
} from './engine.js';
import type {
  GameState,
  PlayerState,
  CardData,
  AttackTarget,
  AttackPosition,
  PlayCardOptions,
} from './types.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
}

const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);
export const apiRouter = Router();

type ApiError = { message?: string };
type AIDecision =
  | { action: 'end_turn' }
  | { action: 'play_card'; cardInstanceId: string; options: PlayCardOptions }
  | { action: 'attack'; attackerPosition: AttackPosition; target: AttackTarget };

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as ApiError).message ?? 'Unknown error');
  }
  return 'Unknown error';
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`);
  return value;
}

function asPosition(value: unknown, label: string): AttackPosition {
  const object = asObject(value);
  const row = Number(object.row);
  const col = Number(object.col);
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > 2 || col < 0 || col > 2) {
    throw new Error(`${label} is invalid`);
  }
  return { row, col };
}

function asAttackTarget(value: unknown): AttackTarget {
  const object = asObject(value);
  if (object.type === 'player') {
    const playerIndex = Number(object.playerIndex);
    if (playerIndex !== 0 && playerIndex !== 1) throw new Error('Target player is invalid');
    return { type: 'player', playerIndex };
  }
  if (object.type === 'creature') {
    const ownerIndex = Number(object.ownerIndex);
    if (ownerIndex !== 0 && ownerIndex !== 1) throw new Error('Target owner is invalid');
    return { type: 'creature', ownerIndex, position: asPosition(object.position, 'Target position') };
  }
  throw new Error('Target is invalid');
}

async function requireAuth(req: Request): Promise<string> {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) throw new Error('Unauthorized: missing bearer token');
  const token = header.slice('Bearer '.length).trim();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new Error('Unauthorized: invalid session');
  return data.user.id;
}

async function assertMatchOwner(matchId: string, userId: string): Promise<void> {
  const { data, error } = await supabase
    .from('matches')
    .select('*')
    .eq('id', matchId)
    .single();

  if (error || !data) throw new Error('Match not found');

  const possibleOwnerKeys = ['player_user_id', 'user_id', 'owner_id', 'player_id'];
  const ownerKey = possibleOwnerKeys.find((key) => key in data);
  if (ownerKey && data[ownerKey] && data[ownerKey] !== userId) throw new Error('Unauthorized: match belongs to another user');
}

async function loadMatchState(matchId: string): Promise<GameState> {
  const { data, error } = await supabase
    .from('game_state')
    .select('state_json, current_turn, current_phase')
    .eq('match_id', matchId)
    .single();
  if (error || !data) throw new Error('Game state not found');
  return data.state_json as GameState;
}

function createPlayerState(playerIndex: 0 | 1, userId: string | null, deck: string[]): PlayerState {
  return {
    player_index: playerIndex,
    user_id: userId,
    life: 20,
    max_mana: 0,
    current_mana: 0,
    deck: shuffle([...deck]),
    hand: [],
    graveyard: [],
    extra_deck: [],
    color_counters: { CHI: 0, INF: 0, PES: 0, BUL: 0, GRO: 0, CLO: 0, IND: 0 },
    board: {
      field_spell: null,
      rows: [
        [null, null, null],
        [null, null, null],
        [null, null, null],
      ],
    },
  };
}

function shuffle<T>(items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index--) {
    const target = Math.floor(Math.random() * (index + 1));
    [items[index], items[target]] = [items[target], items[index]];
  }
  return items;
}

async function generateDeck(): Promise<string[]> {
  const { data, error } = await supabase
    .from('cards')
    .select('id, mana_cost, card_type')
    .in('card_type', ['monster', 'sorcery', 'instant', 'terraforma', 'aura'])
    .order('mana_cost', { ascending: true });

  if (error || !data || data.length < 10) throw new Error('Not enough cards to generate a deck');

  const low = data.filter((card) => Number(card.mana_cost) <= 2);
  const mid = data.filter((card) => Number(card.mana_cost) >= 2 && Number(card.mana_cost) <= 4);
  const high = data.filter((card) => Number(card.mana_cost) >= 5);
  const pool = data;
  const pick = (cards: typeof data) => cards[Math.floor(Math.random() * cards.length)]?.id;

  const selected = [
    pick(high.length ? high : pool),
    pick(low.length ? low : pool),
    pick(low.length ? low : pool),
    pick(mid.length ? mid : pool),
    pick(mid.length ? mid : pool),
    pick(mid.length ? mid : pool),
    pick(mid.length ? mid : pool),
    pick(pool),
    pick(pool),
    pick(pool),
  ].filter((id): id is string => Boolean(id));

  if (selected.length !== 10) throw new Error('Deck generation failed');
  return selected;
}

async function createMatchRecord(userId: string): Promise<string> {
  const { data: inserted, error } = await supabase
    .from('matches')
    .insert({})
    .select('id')
    .single();

  if (error || !inserted?.id) {
    throw new Error(`Could not create match. Verify matches table schema: ${error?.message ?? 'unknown error'}`);
  }

  const matchId = String(inserted.id);
  const { data: matchColumns } = await supabase
    .from('information_schema.columns' as never)
    .select('*');
  void matchColumns;
  void userId;
  return matchId;
}

apiRouter.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: 'bellum-penumbrum-api' });
});

apiRouter.post('/match/create', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const matchId = await createMatchRecord(userId);
    const [aiDeck, userDeck] = await Promise.all([generateDeck(), generateDeck()]);

    const state: GameState = {
      match_id: matchId,
      status: 'running',
      players: [createPlayerState(0, null, aiDeck), createPlayerState(1, userId, userDeck)],
      current_turn: 0,
      active_player_index: 0,
      phase: 'end',
      stack: [],
      anti_loop_counter: 0,
    };

    const { error: stateError } = await supabase.from('game_state').insert({
      match_id: matchId,
      state_json: state,
      current_turn: 0,
      current_phase: 3,
      last_updated: new Date().toISOString(),
    });

    if (stateError) throw new Error(`Could not create game state: ${stateError.message}`);

    await logMatchAction(matchId, {
      turn: 0,
      phase: 'end',
      player_index: -1,
      action_type: 'match_create',
      description: 'New match created: human player versus AI',
    });

    const started = await nextTurn(matchId);
    res.status(201).json({ match_id: matchId, state: started });
  } catch (error) {
    res.status(400).json({ error: messageFromError(error) });
  }
});

apiRouter.get('/match/:id', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const matchId = asString(req.params.id, 'match id');
    await assertMatchOwner(matchId, userId);
    res.json({ state: await loadMatchState(matchId) });
  } catch (error) {
    res.status(400).json({ error: messageFromError(error) });
  }
});

apiRouter.post('/match/:id/play-card', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const matchId = asString(req.params.id, 'match id');
    await assertMatchOwner(matchId, userId);
    const body = asObject(req.body);
    const instanceId = asString(body.cardInstanceId, 'cardInstanceId');
    const options = asObject(body.options) as PlayCardOptions;
    const state = await playCard(matchId, 1, instanceId, options);
    res.json({ state });
  } catch (error) {
    res.status(400).json({ error: messageFromError(error) });
  }
});

apiRouter.post('/match/:id/attack', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const matchId = asString(req.params.id, 'match id');
    await assertMatchOwner(matchId, userId);
    const body = asObject(req.body);
    const attackerPosition = asPosition(body.attackerPosition, 'Attacker position');
    const target = asAttackTarget(body.target);
    const state = await attack(matchId, 1, attackerPosition, target);
    res.json({ state });
  } catch (error) {
    res.status(400).json({ error: messageFromError(error) });
  }
});

apiRouter.post('/match/:id/end-turn', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const matchId = asString(req.params.id, 'match id');
    await assertMatchOwner(matchId, userId);

    const ended = await endTurn(matchId);
    if (ended.status === 'finished') return res.json({ state: ended });

    const aiState = await nextTurn(matchId);
    await runAITurn(matchId, aiState);

    const nextHumanState = await nextTurn(matchId);
    res.json({ state: nextHumanState });
  } catch (error) {
    res.status(400).json({ error: messageFromError(error) });
  }
});

apiRouter.get('/match/:id/logs', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const matchId = asString(req.params.id, 'match id');
    await assertMatchOwner(matchId, userId);
    const requestedLimit = Number(req.query.limit ?? 50);
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 50;
    const { data, error } = await supabase
      .from('match_logs')
      .select('match_id, log_data, created_at')
      .eq('match_id', matchId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Could not load logs: ${error.message}`);
    res.json({ logs: data ?? [] });
  } catch (error) {
    res.status(400).json({ error: messageFromError(error) });
  }
});

apiRouter.get('/cards/:id', async (req: Request, res: Response) => {
  try {
    await requireAuth(req);
    const cardId = asString(req.params.id, 'card id');
    res.json({ card: await getCardData(cardId) });
  } catch (error) {
    res.status(400).json({ error: messageFromError(error) });
  }
});

async function runAITurn(matchId: string, initialState: GameState): Promise<void> {
  let state = initialState;
  const maxActions = 20;

  for (let actionCount = 0; actionCount < maxActions; actionCount++) {
    if (state.status !== 'running' || state.active_player_index !== 0 || state.phase !== 'main') break;
    const decision = await decideAIMove(state);
    if (decision.action === 'end_turn') break;

    if (decision.action === 'play_card') {
      await playCard(matchId, 0, decision.cardInstanceId, decision.options);
    } else {
      await attack(matchId, 0, decision.attackerPosition, decision.target);
    }
    state = await loadMatchState(matchId);
  }

  state = await loadMatchState(matchId);
  if (state.status === 'running' && state.active_player_index === 0) await endTurn(matchId);
}

async function decideAIMove(state: GameState): Promise<AIDecision> {
  const ai = state.players[0];
  const human = state.players[1];

  const lethal = findDirectAttack(ai, human, true);
  if (lethal) return lethal;

  const bestPlay = await findBestCardPlay(ai, human);
  if (bestPlay) return bestPlay;

  const creatureAttack = findBestCreatureAttack(ai, human);
  if (creatureAttack) return creatureAttack;

  const directAttack = findDirectAttack(ai, human, false);
  if (directAttack) return directAttack;

  return { action: 'end_turn' };
}

function findDirectAttack(ai: PlayerState, opponent: PlayerState, lethalOnly: boolean): AIDecision | null {
  let best: { position: AttackPosition; power: number } | null = null;
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const cell = ai.board.rows[row][col];
    if (!cell || cell.tired || cell.attack <= 0) continue;
    if (!best || cell.attack > best.power) best = { position: { row, col }, power: cell.attack };
  }
  if (!best || (lethalOnly && best.power < opponent.life)) return null;
  return { action: 'attack', attackerPosition: best.position, target: { type: 'player', playerIndex: 1 } };
}

function findBestCreatureAttack(ai: PlayerState, opponent: PlayerState): AIDecision | null {
  let choice: { score: number; attacker: AttackPosition; target: AttackTarget } | null = null;
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const attacker = ai.board.rows[row][col];
    if (!attacker || attacker.tired || attacker.attack <= 0) continue;
    for (let targetRow = 0; targetRow < 3; targetRow++) for (let targetCol = 0; targetCol < 3; targetCol++) {
      const target = opponent.board.rows[targetRow][targetCol];
      if (!target) continue;
      const score = (attacker.attack >= target.hp ? 10 : 0) + target.attack * 1.5 + target.hp * 0.5 - attacker.attack * 0.1;
      if (!choice || score > choice.score) choice = {
        score,
        attacker: { row, col },
        target: { type: 'creature', ownerIndex: 1, position: { row: targetRow, col: targetCol } },
      };
    }
  }
  return choice ? { action: 'attack', attackerPosition: choice.attacker, target: choice.target } : null;
}

async function findBestCardPlay(ai: PlayerState, opponent: PlayerState): Promise<AIDecision | null> {
  let best: { score: number; cardId: string; options: PlayCardOptions } | null = null;
  const freeSlots: AttackPosition[] = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) if (!ai.board.rows[row][col]) freeSlots.push({ row, col });

  for (const cardId of ai.hand) {
    const card = await getCardData(cardId);
    if (card.mana_cost > ai.current_mana) continue;
    if ((card.card_type === 'monster' || card.card_type === 'mostrissimo') && freeSlots.length === 0) continue;
    if (card.card_type === 'mostrissimo' && countCreatures(ai) < (card.sacrifice_cost ?? 0)) continue;
    if (card.card_type === 'terraforma' && ai.board.field_spell) continue;
    if (card.card_type === 'aura') continue;

    const score = evaluateCardPlay(card, ai, opponent);
    const options: PlayCardOptions = (card.card_type === 'monster' || card.card_type === 'mostrissimo')
      ? { position: freeSlots[0] }
      : {};
    if (!best || score > best.score) best = { score, cardId, options };
  }

  return best && best.score > 0 ? { action: 'play_card', cardInstanceId: best.cardId, options: best.options } : null;
}

function evaluateCardPlay(card: CardData, ai: PlayerState, opponent: PlayerState): number {
  const attackValue = card.attack ?? 0;
  const hpValue = card.hp ?? 0;
  const cost = Math.max(card.mana_cost, 1);
  const effectText = (card.effect_text ?? '').toLowerCase();
  const aiCreatures = countCreatures(ai);
  const opponentCreatures = countCreatures(opponent);
  let score = ((attackValue * 1.35) + hpValue) / cost * 3;

  if (aiCreatures < opponentCreatures) score += 3;
  if (opponent.life <= 10) score += attackValue * 0.8;
  if (ai.life <= 10) score += hpValue * 0.6;
  if (attackValue >= 4 && hpValue >= 4) score += 2;
  if (hpValue <= 1 && attackValue <= 2) score -= 1.5;
  if (effectText.includes('pesca')) score += ai.hand.length <= 2 ? 4 : 2;
  if (effectText.includes('infliggi') || effectText.includes('danno')) score += opponentCreatures > 0 ? 3 : 1;
  if (effectText.includes('cura')) score += ai.life <= 12 ? 3 : 0.5;
  if (effectText.includes('scarta')) score += opponent.hand.length >= 3 ? 2 : 0.5;
  if (card.card_type === 'terraforma') score += ai.board.field_spell ? -10 : 1;
  if (card.card_type === 'sorcery' || card.card_type === 'instant') score += 1;
  if (card.mana_cost === ai.current_mana) score += 0.5;
  return score;
}

function countCreatures(player: PlayerState): number {
  let count = 0;
  for (const row of player.board.rows) for (const cell of row) if (cell) count++;
  return count;
}
