// backend/api.ts — API HTTP Bellum Penumbrum, registro 3e ordinato e checkpoint pubblici.
import { Router, type Request, type Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  attack, createNewMatch, endHumanTurn, getCardData, getMatchState, moveCreature,
  playCard, resolveTrapChoice, resolveDeathOrder, resolveTargetChoice,
  startMostrissimoSummon, payMostrissimoSacrifice, completeMostrissimoSummon,
} from './engine.js';
import { advancePublicCheckpoint } from './engine-core.js';
import type {
  AttackTarget, DeathOrderChoice, DeckFaction, PlayerIndex, PlayCardOptions,
  Position, TargetChoice, TrapChoice,
} from './types.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !supabaseServiceKey) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
const supabase: SupabaseClient = createClient(supabaseUrl, supabaseServiceKey);
export const apiRouter = Router();
const deckFactions: readonly DeckFaction[] = ['CHI','INF','PES','BUL','GRO','CLO'];
function deckFactionValue(value: unknown, label: string): DeckFaction {
  if (typeof value !== 'string' || !deckFactions.includes(value as DeckFaction))
    throw new Error(`${label} non valido: scegli CHI, INF, PES, BUL, GRO oppure CLO`);
  return value as DeckFaction;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Errore sconosciuto'; }
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
  const object = objectValue(value), row = Number(object.row), col = Number(object.col);
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > 2 || col < 0 || col > 2)
    throw new Error(`${label} non valida`);
  return { row, col };
}
function attackTargetValue(value: unknown): AttackTarget {
  const object = objectValue(value);
  if (object.type === 'player') return { type: 'player', playerIndex: playerIndexValue(object.playerIndex, 'Giocatore bersaglio') };
  if (object.type === 'creature') return { type: 'creature', position: positionValue(object.position, 'Posizione bersaglio') };
  throw new Error('Bersaglio non valido');
}
function playOptionsValue(value: unknown): PlayCardOptions {
  const object = objectValue(value), options: PlayCardOptions = {};
  if (object.position !== undefined) options.position = positionValue(object.position, 'Posizione');
  if (object.targetInstanceId !== undefined) options.targetInstanceId = requiredString(object.targetInstanceId, 'ID istanza bersaglio');
  return options;
}
function trapChoiceValue(value: unknown): TrapChoice {
  const body = objectValue(value), window_id = requiredString(body.windowId, 'ID finestra reattiva');
  if (body.action === 'pass') return { window_id, action: 'pass' };
  if (body.action === 'play') return {
    window_id, action: 'play', card_instance_id: requiredString(body.cardInstanceId, 'ID istanza Trappola'),
    ...(body.targetInstanceId === undefined || body.targetInstanceId === null ? {}
      : { target_instance_id: requiredString(body.targetInstanceId, 'ID istanza bersaglio') }),
  };
  throw new Error('Scelta reattiva non valida');
}
function deathOrderChoiceValue(value: unknown): DeathOrderChoice {
  const body = objectValue(value);
  if (!Array.isArray(body.instanceIds) || body.instanceIds.length < 2 || body.instanceIds.length > 9
    || body.instanceIds.some(id => typeof id !== 'string' || id.trim() === ''))
    throw new Error('Ordine delle creature non valido');
  return { choice_id: requiredString(body.choiceId, 'ID scelta ordine'),
    instance_ids: body.instanceIds.map(id => requiredString(id, 'ID creatura')) };
}
function targetChoiceValue(value: unknown): TargetChoice {
  const body = objectValue(value);
  return { choice_id: requiredString(body.choiceId, 'ID scelta bersaglio'),
    target_instance_id: requiredString(body.targetInstanceId, 'ID istanza bersaglio') };
}
async function requireAuth(req: Request): Promise<string> {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) throw new Error('Sessione assente: autenticati di nuovo');
  const { data, error } = await supabase.auth.getUser(header.slice('Bearer '.length).trim());
  if (error || !data.user) throw new Error('Sessione Supabase non valida');
  return data.user.id;
}
async function assertMatchOwner(matchId: string, userId: string): Promise<void> {
  const { data, error } = await supabase.from('matches').select('id, player_id').eq('id', matchId).single();
  if (error || !data) throw new Error('Partita non trovata');
  if (data.player_id !== userId) throw new Error('Questa partita appartiene a un altro giocatore');
}
async function ownedMatch(req: Request): Promise<string> {
  const userId = await requireAuth(req), matchId = requiredString(req.params.id, 'ID partita');
  await assertMatchOwner(matchId, userId);
  return matchId;
}
function respondError(res: Response, error: unknown) { res.status(400).json({ error: errorMessage(error) }); }
apiRouter.get('/health', (_req: Request, res: Response) => res.status(200).json({ status: 'ok', service: 'bellum-penumbrum-api' }));
apiRouter.post('/match/create', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req), body = objectValue(req.body);
    const primary = deckFactionValue(body.primaryColor, 'Colore principale');
    const secondary = deckFactionValue(body.secondaryColor, 'Colore secondario');
    if (primary === secondary) throw new Error('Scegli due colori diversi');
    const { matchId, state } = await createNewMatch(userId, primary, secondary);
    res.status(201).json({ match_id: matchId, state });
  } catch (error) { respondError(res, error); }
});
apiRouter.get('/match/:id', async (req: Request, res: Response) => {
  try { res.json({ state: await getMatchState(await ownedMatch(req)) }); }
  catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/play-card', async (req: Request, res: Response) => {
  try { const id = await ownedMatch(req), body = objectValue(req.body);
    res.json({ state: await playCard(id, 1, requiredString(body.cardInstanceId, 'ID istanza carta'), playOptionsValue(body.options)) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/mostrissimo/start', async (req: Request, res: Response) => {
  try { const id = await ownedMatch(req);
    res.json({ state: await startMostrissimoSummon(id, 1, requiredString(objectValue(req.body).cardId, 'ID Mostrissimo')) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/mostrissimo/sacrifice', async (req: Request, res: Response) => {
  try { const id = await ownedMatch(req);
    res.json({ state: await payMostrissimoSacrifice(id, 1, requiredString(objectValue(req.body).instanceId, 'ID permanente')) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/mostrissimo/complete', async (req: Request, res: Response) => {
  try { const id = await ownedMatch(req), body = objectValue(req.body);
    const position = positionValue(body.position, 'Cella di evocazione');
    const targetId = body.targetInstanceId === undefined || body.targetInstanceId === null
      ? null : requiredString(body.targetInstanceId, 'Bersaglio');
    res.json({ state: await completeMostrissimoSummon(id, 1, position, targetId) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/move', async (req: Request, res: Response) => {
  try { const id = await ownedMatch(req), body = objectValue(req.body);
    res.json({ state: await moveCreature(id, 1, positionValue(body.from, 'Posizione di origine'), positionValue(body.to, 'Posizione di destinazione')) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/attack', async (req: Request, res: Response) => {
  try { const id = await ownedMatch(req), body = objectValue(req.body);
    res.json({ state: await attack(id, 1, positionValue(body.attackerPosition, 'Posizione attaccante'), attackTargetValue(body.target)) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/end-turn', async (req: Request, res: Response) => {
  try { res.json({ state: await endHumanTurn(await ownedMatch(req)) }); }
  catch (error) { respondError(res, error); }
});
// L'ID proviene dall'ultimo checkpoint persistito. Retry e chiamate da due schede
// non applicano due volte lo stesso task: il motore usa la revisione CAS.
apiRouter.post('/match/:id/advance', async (req: Request, res: Response) => {
  try {
    const id = await ownedMatch(req);
    const expectedId = requiredString(objectValue(req.body).expectedAnnouncementId, 'ID checkpoint atteso');
    res.json({ state: await advancePublicCheckpoint(id, expectedId) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/trap/choice', async (req: Request, res: Response) => {
  try { res.json({ state: await resolveTrapChoice(await ownedMatch(req), 1, trapChoiceValue(req.body)) }); }
  catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/death/order', async (req: Request, res: Response) => {
  try { res.json({ state: await resolveDeathOrder(await ownedMatch(req), 1, deathOrderChoiceValue(req.body)) }); }
  catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/death/target', async (req: Request, res: Response) => {
  try { res.json({ state: await resolveTargetChoice(await ownedMatch(req), 1, targetChoiceValue(req.body)) }); }
  catch (error) { respondError(res, error); }
});
// Le voci nuove sono ordinate per revisione CAS e posizione nel commit.
// Le vecchie voci prive di progressivo mantengono l'ordine storico restituito dal DB.
apiRouter.get('/match/:id/logs', async (req: Request, res: Response) => {
  try {
    const id = await ownedMatch(req);
    const requested = Number(req.query.limit ?? 100);
    const limit = Number.isInteger(requested) ? Math.max(1, Math.min(requested, 1000)) : 100;
    const { data, error } = await supabase.from('match_logs')
      .select('id, match_id, log_data, created_at').eq('match_id', id)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit);
    if (error) throw new Error(`Impossibile caricare il log: ${error.message}`);
    const ordered = (data ?? []).reverse();
    ordered.sort((a, b) => {
      const ar = Number(a.log_data?.log_revision), br = Number(b.log_data?.log_revision);
      const ai = Number(a.log_data?.log_order), bi = Number(b.log_data?.log_order);
      if (Number.isInteger(ar) && Number.isInteger(br) && ar !== br) return ar - br;
      if (ar === br && Number.isInteger(ar) && Number.isInteger(ai) && Number.isInteger(bi)) return ai - bi;
      return 0;
    });
    res.json({ logs: ordered });
  } catch (error) { respondError(res, error); }
});
apiRouter.get('/cards/:id', async (req: Request, res: Response) => {
  try { await requireAuth(req);
    res.json({ card: await getCardData(requiredString(req.params.id, 'ID carta')) });
  } catch (error) { respondError(res, error); }
});
