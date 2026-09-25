import { Router, type Request, type Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  attack,
  createNewMatch,
  endHumanTurn,
  getCardData,
  getMatchState,
  playCard,
} from './engine.js';
import type {
  AttackTarget,
  PlayerIndex,
  PlayCardOptions,
  Position,
} from './types.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
}

const supabase: SupabaseClient = createClient(supabaseUrl, supabaseServiceKey);

export const apiRouter = Router();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Errore sconosciuto';
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} obbligatorio`);
  }

  return value.trim();
}

function playerIndexValue(value: unknown, label: string): PlayerIndex {
  const numberValue = Number(value);

  if (numberValue !== 0 && numberValue !== 1) {
    throw new Error(`${label} non valido`);
  }

  return numberValue;
}

function positionValue(value: unknown, label: string): Position {
  const object = objectValue(value);
  const row = Number(object.row);
  const col = Number(object.col);

  if (
    !Number.isInteger(row) ||
    !Number.isInteger(col) ||
    row < 0 ||
    row > 2 ||
    col < 0 ||
    col > 2
  ) {
    throw new Error(`${label} non valida`);
  }

  return { row, col };
}

function attackTargetValue(value: unknown): AttackTarget {
  const object = objectValue(value);

  if (object.type === 'player') {
    return {
      type: 'player',
      playerIndex: playerIndexValue(object.playerIndex, 'Giocatore bersaglio'),
    };
  }

  if (object.type === 'creature') {
    return {
      type: 'creature',
      ownerIndex: playerIndexValue(object.ownerIndex, 'Proprietario bersaglio'),
      position: positionValue(object.position, 'Posizione bersaglio'),
    };
  }

  throw new Error('Bersaglio non valido');
}

function playOptionsValue(value: unknown): PlayCardOptions {
  const object = objectValue(value);
  const options: PlayCardOptions = {};

  if (object.position !== undefined) {
    options.position = positionValue(object.position, 'Posizione');
  }

  if (object.targetInstanceId !== undefined) {
    options.targetInstanceId = requiredString(
      object.targetInstanceId,
      'ID istanza bersaglio',
    );
  }

  return options;
}

async function requireAuth(req: Request): Promise<string> {
  const header = req.header('authorization');

  if (!header?.startsWith('Bearer ')) {
    throw new Error('Sessione assente: autenticati di nuovo');
  }

  const token = header.slice('Bearer '.length).trim();
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    throw new Error('Sessione Supabase non valida');
  }

  return data.user.id;
}

async function assertMatchOwner(matchId: string, userId: string): Promise<void> {
  const { data, error } = await supabase
    .from('matches')
    .select('id, player_id')
    .eq('id', matchId)
    .single();

  if (error || !data) {
    throw new Error('Partita non trovata');
  }

  if (data.player_id !== userId) {
    throw new Error('Questa partita appartiene a un altro giocatore');
  }
}

apiRouter.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'bellum-penumbrum-api',
  });
});

apiRouter.post('/match/create', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const { matchId, state } = await createNewMatch(userId);

    res.status(201).json({
      match_id: matchId,
      state,
    });
  } catch (error) {
    res.status(400).json({
      error: errorMessage(error),
    });
  }
});

apiRouter.get('/match/:id', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const matchId = requiredString(req.params.id, 'ID partita');

    await assertMatchOwner(matchId, userId);

    res.json({
      state: await getMatchState(matchId),
    });
  } catch (error) {
    res.status(400).json({
      error: errorMessage(error),
    });
  }
});

apiRouter.post('/match/:id/play-card', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const matchId = requiredString(req.params.id, 'ID partita');

    await assertMatchOwner(matchId, userId);

    const body = objectValue(req.body);
    const instanceId = requiredString(body.cardInstanceId, 'ID istanza carta');
    const options = playOptionsValue(body.options);

    const state = await playCard(matchId, 1, instanceId, options);

    res.json({ state });
  } catch (error) {
    res.status(400).json({
      error: errorMessage(error),
    });
  }
});

apiRouter.post('/match/:id/attack', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const matchId = requiredString(req.params.id, 'ID partita');

    await assertMatchOwner(matchId, userId);

    const body = objectValue(req.body);
    const attackerPosition = positionValue(
      body.attackerPosition,
      'Posizione attaccante',
    );
    const target = attackTargetValue(body.target);

    const state = await attack(matchId, 1, attackerPosition, target);

    res.json({ state });
  } catch (error) {
    res.status(400).json({
      error: errorMessage(error),
    });
  }
});

apiRouter.post('/match/:id/end-turn', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const matchId = requiredString(req.params.id, 'ID partita');

    await assertMatchOwner(matchId, userId);

    const state = await endHumanTurn(matchId);

    res.json({ state });
  } catch (error) {
    res.status(400).json({
      error: errorMessage(error),
    });
  }
});

apiRouter.get('/match/:id/logs', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const matchId = requiredString(req.params.id, 'ID partita');

    await assertMatchOwner(matchId, userId);

    const requestedLimit = Number(req.query.limit ?? 50);
    const limit = Number.isInteger(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, 100))
      : 50;

    const { data, error } = await supabase
      .from('match_logs')
      .select('match_id, log_data, created_at')
      .eq('match_id', matchId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Impossibile caricare il log: ${error.message}`);
    }

    res.json({
      logs: data ?? [],
    });
  } catch (error) {
    res.status(400).json({
      error: errorMessage(error),
    });
  }
});

apiRouter.get('/cards/:id', async (req: Request, res: Response) => {
  try {
    await requireAuth(req);

    const cardId = requiredString(req.params.id, 'ID carta');

    res.json({
      card: await getCardData(cardId),
    });
  } catch (error) {
    res.status(400).json({
      error: errorMessage(error),
    });
  }
});
