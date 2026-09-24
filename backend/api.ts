// backend/api.ts

import { Router, Request, Response } from 'express';
import {
  nextTurn,
  endTurn,
  playCard,
  attack,
  saveGameState,
  finalizeMatch,
  getCardData,
  logMatchAction,
} from './engine';
import { createClient } from '@supabase/supabase-js';
import type { GameState, PlayerState, MatchLogEntry, CardData } from './types';

const router = Router();

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

// =========================
// AUTH HELPERS
// =========================

async function requireAuth(req: Request): Promise<string> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Unauthorized');
  }

  const token = authHeader.slice(7);

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    throw new Error('Unauthorized');
  }

  return user.id;
}

// =========================
// CREAZIONE PARTITA
// =========================

router.post('/match/create', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);

    const matchId = crypto.randomUUID();

    const { error: matchErr } = await supabase.from('matches').insert({
      id: matchId,
      player_user_id: userId,
      ia_user_id: null,
      status: 'not_started',
      created_at: new Date().toISOString(),
    });

    if (matchErr) {
      throw new Error(`Errore nella creazione della partita: ${matchErr.message}`);
    }

    const userDeck = await generateDeck();
    const iaDeck = await generateDeck();

    const initialState: GameState = {
      match_id: matchId,
      status: 'running',
      players: [
        createPlayerState(0, null, iaDeck),
        createPlayerState(1, userId, userDeck),
      ],
      current_turn: 0,
      active_player_index: 1,
      phase: 'start',
      stack: [],
      anti_loop_counter: 0,
    };

    const { error: stateErr } = await supabase.from('game_state').insert({
      match_id: matchId,
      state: initialState,
      updated_at: new Date().toISOString(),
    });

    if (stateErr) {
      throw new Error(`Errore nell'inizializzazione dello stato: ${stateErr.message}`);
    }

    await logMatchAction(matchId, {
      turn: 0,
      phase: 'start',
      player_index: -1,
      action_type: 'match_create',
      description: `Partita creata: utente ${userId} vs IA`,
    });

    const state = initialState;

    res.json({ state });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// =========================
// LETTURA STATO PARTITA
// =========================

router.get('/match/:id', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const { id } = req.params;

    const { data, error } = await supabase
      .from('game_state')
      .select('state, matches')
      .eq('match_id', id)
      .single();

    if (error || !data) {
      throw new Error('Partita non trovata');
    }

    const match = data.matches as any;
    if (match && match.player_user_id !== userId) {
      // Opzionale: impedire di vedere partite altrui
    }

    res.json({ state: data.state as GameState });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// =========================
// AVANZAMENTO TURNO
// =========================

router.post('/match/:id/next-turn', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const { id } = req.params;

    const { data: matchData } = await supabase
      .from('matches')
      .select('player_user_id')
      .eq('id', id)
      .single();

    if (!matchData || matchData.player_user_id !== userId) {
      throw new Error('Unauthorized');
    }

    const state = await nextTurn(id);

    if (state.status === 'running' && state.active_player_index === 0) {
      await runAITurn(id, state);
      const { data: refreshed } = await supabase
        .from('game_state')
        .select('state')
        .eq('match_id', id)
        .single();

      res.json({ state: refreshed!.state as GameState });
    } else {
      res.json({ state });
    }
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/match/:id/end-turn', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const { id } = req.params;

    const { data: matchData } = await supabase
      .from('matches')
      .select('player_user_id')
      .eq('id', id)
      .single();

    if (!matchData || matchData.player_user_id !== userId) {
      throw new Error('Unauthorized');
    }

    const state = await endTurn(id);

    if (state.status === 'finished') {
      res.json({ state });
      return;
    }

    if (state.status === 'running' && state.active_player_index === 0) {
      await runAITurn(id, state);
      const { data: refreshed } = await supabase
        .from('game_state')
        .select('state')
        .eq('match_id', id)
        .single();

      res.json({ state: refreshed!.state as GameState });
    } else {
      res.json({ state });
    }
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// =========================
// AZIONI: PLAY CARD / ATTACK
// =========================

router.post('/match/:id/play-card', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const { id } = req.params;
    const { cardInstanceId, options } = req.body;

    const { data: matchData } = await supabase
      .from('matches')
      .select('player_user_id')
      .eq('id', id)
      .single();

    if (!matchData || matchData.player_user_id !== userId) {
      throw new Error('Unauthorized');
    }

    const state = await playCard(id, 1, cardInstanceId, options);

    res.json({ state });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/match/:id/attack', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const { id } = req.params;
    const { attackerPosition, target } = req.body;

    const { data: matchData } = await supabase
      .from('matches')
      .select('player_user_id')
      .eq('id', id)
      .single();

    if (!matchData || matchData.player_user_id !== userId) {
      throw new Error('Unauthorized');
    }

    const state = await attack(id, 1, attackerPosition, target);

    res.json({ state });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// =========================
// LOG PARTITA
// =========================

router.get('/match/:id/logs', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const { id } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;

    const { data: matchData } = await supabase
      .from('matches')
      .select('player_user_id')
      .eq('id', id)
      .single();

    if (!matchData || matchData.player_user_id !== userId) {
      throw new Error('Unauthorized');
    }

    const { data, error } = await supabase
      .from('match_logs')
      .select('*')
      .eq('match_id', id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error('Errore nel recupero dei log');
    }

    res.json({ logs: data as MatchLogEntry[] });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// =========================
// CARTE
// =========================

router.get('/cards/:id', async (req: Request, res: Response) => {
  try {
    await requireAuth(req);
    const { id } = req.params;

    const card = await getCardData(id);

    res.json({ card });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// =========================
// HELPERS PER CREAZIONE PARTITA
// =========================

function createPlayerState(
  playerIndex: number,
  userId: string | null,
  deck: string[]
): PlayerState {
  return {
    player_index: playerIndex,
    user_id: userId,
    life: 20,
    max_mana: 3,
    current_mana: 3,
    deck: [...deck],
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

async function generateDeck(): Promise<string[]> {
  const { data: allCards, error } = await supabase
    .from('cards')
    .select('id, mana_cost, faction_code, card_type')
    .in('card_type', ['monster', 'sorcery', 'instant', 'terraforma', 'aura'])
    .not('mana_cost', 'is', null);

  if (error || !allCards || allCards.length === 0) {
    throw new Error('Nessuna carta disponibile per generare il mazzo');
  }

  const bossCandidates = allCards.filter((c) => c.mana_cost! >= 5);
  const boss =
    bossCandidates.length > 0
      ? bossCandidates[Math.floor(Math.random() * bossCandidates.length)]
      : allCards[Math.floor(Math.random() * allCards.length)];

  const deck: string[] = [boss.id];

  const pool = allCards.filter((c) => c.id !== boss.id);

  for (let i = 0; i < 9; i++) {
    const card = pool[Math.floor(Math.random() * pool.length)];
    deck.push(card.id);
  }

  return deck;
}

// =========================
// IA TURN
// =========================

async function runAITurn(matchId: string, initialState: GameState) {
  let state = initialState;

  let actionsThisTurn = 0;
  const MAX_ACTIONS_PER_TURN = 20;

  while (state.status === 'running' && state.active_player_index === 0) {
    actionsThisTurn++;
    if (actionsThisTurn > MAX_ACTIONS_PER_TURN) {
      await endTurn(matchId);
      break;
    }

    const decision = await decideAIMove(matchId, state);

    if (!decision || decision.action === 'end_turn') {
      await endTurn(matchId);
      break;
    }

    if (decision.action === 'play_card') {
      const { cardInstanceId, options } = decision;
      await playCard(matchId, 0, cardInstanceId, options);
    } else if (decision.action === 'attack') {
      const { attackerPosition, target } = decision;
      await attack(matchId, 0, attackerPosition, target);
    }

    const { data: refreshed } = await supabase
      .from('game_state')
      .select('state')
      .eq('match_id', matchId)
      .single();

    if (!refreshed) {
      break;
    }

    state = refreshed.state as GameState;
  }
}

type AIDecision =
  | { action: 'end_turn' }
  | { action: 'play_card'; cardInstanceId: string; options: any }
  | { action: 'attack'; attackerPosition: { row: number; col: number }; target: any };

async function decideAIMove(
  matchId: string,
  state: GameState
): Promise<AIDecision | null> {
  const aiPlayer = state.players[0];
  const opponent = state.players[1];

  const lethalAttack = findLethalAttack(aiPlayer, opponent);
  if (lethalAttack) {
    return {
      action: 'attack',
      attackerPosition: lethalAttack.attackerPosition,
      target: lethalAttack.target,
    };
  }

  const bestPlay = await findBestCardPlay(matchId, aiPlayer, opponent);
  if (bestPlay) {
    return bestPlay;
  }

  const nonLethalAttack = findNonLethalAttack(aiPlayer, opponent);
  if (nonLethalAttack) {
    return {
      action: 'attack',
      attackerPosition: nonLethalAttack.attackerPosition,
      target: nonLethalAttack.target,
    };
  }

  return { action: 'end_turn' };
}

function findLethalAttack(
  aiPlayer: PlayerState,
  opponent: PlayerState
): { attackerPosition: { row: number; col: number }; target: any } | null {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const cell = aiPlayer.board.rows[r][c];
      if (cell && !cell.tired && cell.attack > 0) {
        if (opponent.life - cell.attack <= 0) {
          return {
            attackerPosition: { row: r, col: c },
            target: { type: 'player', playerIndex: 1 },
          };
        }
      }
    }
  }
  return null;
}

function findNonLethalAttack(
  aiPlayer: PlayerState,
  opponent: PlayerState
): { attackerPosition: { row: number; col: number }; target: any } | null {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const cell = aiPlayer.board.rows[r][c];
      if (cell && !cell.tired && cell.attack > 0) {
        return {
          attackerPosition: { row: r, col: c },
          target: { type: 'player', playerIndex: 1 },
        };
      }
    }
  }
  return null;
}

async function findBestCardPlay(
  matchId: string,
  aiPlayer: PlayerState,
  opponent: PlayerState
): Promise<AIDecision | null> {
  let bestScore = -Infinity;
  let bestMove: AIDecision | null = null;

  for (const cardId of aiPlayer.hand) {
    const card = await getCardData(cardId);

    if (card.mana_cost > aiPlayer.current_mana) {
      continue;
    }

    if (card.card_type !== 'monster') {
      continue;
    }

    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        if (!aiPlayer.board.rows[r][c]) {
          const score = evaluateCardPlay(card, aiPlayer, opponent);
          if (score > bestScore) {
            bestScore = score;
            bestMove = {
              action: 'play_card',
              cardInstanceId: cardId,
              options: { position: { row: r, col: c } },
            };
          }
        }
      }
    }
  }

  if (bestMove && bestScore >= 0) {
    return bestMove;
  }

  return null;
}

function evaluateCardPlay(
  card: CardData,
  aiPlayer: PlayerState,
  opponent: PlayerState
): number {
  let score = 0;

  const attack = card.attack ?? 0;
  const hp = card.hp ?? 0;
  const manaCost = card.mana_cost;

  const totalStats = attack + hp;
  const efficiency = manaCost > 0 ? totalStats / manaCost : totalStats;
  score += efficiency * 3;

  score += attack * 1.3;
  score += hp * 1.0;

  if (aiPlayer.max_mana <= 3) {
    if (manaCost <= 2) {
      score += 2;
    } else if (manaCost >= 4) {
      score -= 2;
    }
  }

  const aiCreatures = countCreatures(aiPlayer);
  const opponentCreatures = countCreatures(opponent);

  if (aiCreatures <= 1) {
    score += 2;
  }

  if (opponentCreatures >= 3) {
    if (hp >= 4) {
      score += 2;
    }
    if (attack >= 4) {
      score += 1.5;
    }
  }

  if (opponent.life <= 10) {
    if (attack >= 4) {
      score += 3;
    }
    if (attack >= 2) {
      score += 1;
    }
  }

  if (aiPlayer.life <= 10) {
    if (hp >= 5) {
      score += 2;
    }
    if (attack >= 3 && hp >= 4) {
      score += 1.5;
    }
  }

  const effectText = (card.effect_text || '').toLowerCase();

  if (effectText.includes('pesca')) {
    const handSize = aiPlayer.hand.length;
    if (handSize <= 2) {
      score += 3;
    } else {
      score += 1.5;
    }
  }

  if (effectText.includes('danno') || effectText.includes('infliggi')) {
    if (opponent.life <= 12) {
      score += 2;
    } else {
      score += 1;
    }
  }

  if (effectText.includes('cura')) {
    if (aiPlayer.life <= 12) {
      score += 2.5;
    } else {
      score += 1;
    }
  }

  if (effectText.includes('scarta')) {
    const opponentHandSize = opponent.hand.length;
    if (opponentHandSize >= 4) {
      score += 2;
    } else {
      score += 0.5;
    }
  }

  if (aiPlayer.max_mana >= 5) {
    // late game
  } else {
    if (manaCost >= 5) {
      score -= 3;
    } else if (manaCost === 4) {
      score -= 1.5;
    }
  }

  if (attack >= 4 && hp >= 4) {
    score += 2;
  }

  if (hp <= 2 && attack <= 2) {
    score -= 1;
  }

  return score;
}

function countCreatures(player: PlayerState): number {
  let count = 0;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (player.board.rows[r][c]) {
        count++;
      }
    }
  }
  return count;
}

export { router as apiRouter };
