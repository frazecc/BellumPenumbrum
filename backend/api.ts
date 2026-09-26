import { Router, type Request, type Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  attack,
  createNewMatch,
  endHumanTurn,
  getCardData,
  getMatchState,
  moveCreature,
  playCard,
  resolveTrapChoice,
  startMostrissimoSummon,
  payMostrissimoSacrifice,
  completeMostrissimoSummon,
} from './engine.js';
import type {
  AttackTarget,
  PlayerIndex,
  PlayCardOptions,
  Position,
  TrapChoice,
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} obbligatorio`);
  return value.trim();
}
function playerIndexValue(value: unknown, label: string): PlayerIndex {
  const index = Number(value);
  if (index !== 0 && index !== 1) throw new Error(`${label} non valido`);
  return index;
}
function positionValue(value: unknown, label: string): Position {
  const object = objectValue(value);
  const row = Number(object.row);
  const col = Number(object.col);
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > 2 || col < 0 || col > 2) {
    throw new Error(`${label} non valida`);
  }
  return { row, col };
}
function attackTargetValue(value: unknown): AttackTarget {
  const object = objectValue(value);
  if (object.type === 'player') {
    return { type: 'player', playerIndex: playerIndexValue(object.playerIndex, 'Giocatore bersaglio') };
  }
  if (object.type === 'creature') {
    return { type: 'creature', position: positionValue(object.position, 'Posizione bersaglio') };
  }
  throw new Error('Bersaglio non valido');
}
function playOptionsValue(value: unknown): PlayCardOptions {
  const object = objectValue(value);
  const options: PlayCardOptions = {};
  if (object.position !== undefined) options.position = positionValue(object.position, 'Posizione');
  if (object.targetInstanceId !== undefined) {
    options.targetInstanceId = requiredString(object.targetInstanceId, 'ID istanza bersaglio');
  }
  return options;
}
function trapChoiceValue(value: unknown): TrapChoice {
  const body = objectValue(value);
  const window_id = requiredString(body.windowId, 'ID finestra reattiva');
  if (body.action === 'pass') return { window_id, action: 'pass' };
  if (body.action === 'play') {
    return {
      window_id,
      action: 'play',
      card_instance_id: requiredString(body.cardInstanceId, 'ID istanza Trappola'),
      ...(body.targetInstanceId === undefined || body.targetInstanceId === null
        ? {}
        : { target_instance_id: requiredString(body.targetInstanceId, 'ID istanza bersaglio') }),
    };
  }
  throw new Error('Scelta reattiva non valida');
}
async function requireAuth(req: Request): Promise<string> {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) throw new Error('Sessione assente: autenticati di nuovo');
  const token = header.slice('Bearer '.length).trim();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new Error('Sessione Supabase non valida');
  return data.user.id;
}
async function assertMatchOwner(matchId: string, userId: string): Promise<void> {
  const { data, error } = await supabase.from('matches').select('id, player_id').eq('id', matchId).single();
  if (error || !data) throw new Error('Partita non trovata');
  if (data.player_id !== userId) throw new Error('Questa partita appartiene a un altro giocatore');
}
async function ownedMatch(req: Request): Promise<string> {
  const userId = await requireAuth(req);
  const matchId = requiredString(req.params.id, 'ID partita');
  await assertMatchOwner(matchId, userId);
  return matchId;
}
function respondError(res: Response, error: unknown) {
  res.status(400).json({ error: errorMessage(error) });
}

apiRouter.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: 'bellum-penumbrum-api' });
});
apiRouter.post('/match/create', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const { matchId, state } = await createNewMatch(userId);
    res.status(201).json({ match_id: matchId, state });
  } catch (error) { respondError(res, error); }
});
apiRouter.get('/match/:id', async (req: Request, res: Response) => {
  try {
    const matchId = await ownedMatch(req);
    res.json({ state: await getMatchState(matchId) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/play-card', async (req: Request, res: Response) => {
  try {
    const matchId = await ownedMatch(req);
    const body = objectValue(req.body);
    const cardInstanceId = requiredString(body.cardInstanceId, 'ID istanza carta');
    res.json({ state: await playCard(matchId, 1, cardInstanceId, playOptionsValue(body.options)) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/mostrissimo/start', async (req: Request, res: Response) => {
  try {
    const matchId = await ownedMatch(req);
    const cardId = requiredString(objectValue(req.body).cardId, 'ID Mostrissimo');
    res.json({ state: await startMostrissimoSummon(matchId, 1, cardId) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/mostrissimo/sacrifice', async (req: Request, res: Response) => {
  try {
    const matchId = await ownedMatch(req);
    const instanceId = requiredString(objectValue(req.body).instanceId, 'ID permanente');
    res.json({ state: await payMostrissimoSacrifice(matchId, 1, instanceId) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/mostrissimo/complete', async (req: Request, res: Response) => {
  try {
    const matchId = await ownedMatch(req);
    const body = objectValue(req.body);
    const position = positionValue(body.position, 'Cella di evocazione');
    const targetId = body.targetInstanceId === undefined || body.targetInstanceId === null
      ? null : requiredString(body.targetInstanceId, 'Bersaglio');
    res.json({ state: await completeMostrissimoSummon(matchId, 1, position, targetId) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/move', async (req: Request, res: Response) => {
  try {
    const matchId = await ownedMatch(req);
    const body = objectValue(req.body);
    const from = positionValue(body.from, 'Posizione di origine');
    const to = positionValue(body.to, 'Posizione di destinazione');
    res.json({ state: await moveCreature(matchId, 1, from, to) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/attack', async (req: Request, res: Response) => {
  try {
    const matchId = await ownedMatch(req);
    const body = objectValue(req.body);
    const attackerPosition = positionValue(body.attackerPosition, 'Posizione attaccante');
    const target = attackTargetValue(body.target);
    res.json({ state: await attack(matchId, 1, attackerPosition, target) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/end-turn', async (req: Request, res: Response) => {
  try {
    const matchId = await ownedMatch(req);
    res.json({ state: await endHumanTurn(matchId) });
  } catch (error) { respondError(res, error); }
});
// Un solo endpoint: la scelta e' vincolata all'ID univoco della finestra.
// Un replay della stessa richiesta viene respinto dall'engine e/o dalla RPC CAS.
apiRouter.post('/match/:id/trap/choice', async (req: Request, res: Response) => {
  try {
    const matchId = await ownedMatch(req);
    res.json({ state: await resolveTrapChoice(matchId, 1, trapChoiceValue(req.body)) });
  } catch (error) { respondError(res, error); }
});
apiRouter.get('/match/:id/logs', async (req: Request, res: Response) => {
  try {
    const matchId = await ownedMatch(req);
    const requestedLimit = Number(req.query.limit ?? 50);
    const limit = Number.isInteger(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, 100)) : 50;
    const { data, error } = await supabase.from('match_logs')
      .select('id, match_id, log_data, created_at')
      .eq('match_id', matchId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit);
    if (error) throw new Error(`Impossibile caricare il log: ${error.message}`);
    res.json({ logs: data ?? [] });
  } catch (error) { respondError(res, error); }
});
apiRouter.get('/cards/:id', async (req: Request, res: Response) => {
  try {
    await requireAuth(req);
    const cardId = requiredString(req.params.id, 'ID carta');
    res.json({ card: await getCardData(cardId) });
  } catch (error) { respondError(res, error); }
});
