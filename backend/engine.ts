import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { AttackTarget, BoardCell, CardData, CardInstance, EffectDefinition, GameState, MatchLogEntry, PlayerIndex, PlayerState, PlayCardOptions, Position, TurnPhase } from './types.js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
const db = createClient(url, key);
const N = 3;
const other = (p: PlayerIndex): PlayerIndex => p === 0 ? 1 : 0;
const label = (p: PlayerIndex) => p === 1 ? 'Tu' : 'L’IA';
const valid = (p: Position) => Number.isInteger(p.row) && Number.isInteger(p.col) && p.row >= 0 && p.row < N && p.col >= 0 && p.col < N;
const adjacent = (a: Position, b: Position) => Math.abs(a.row - b.row) + Math.abs(a.col - b.col) === 1;
const around = (p: Position): Position[] => [{ row: p.row - 1, col: p.col }, { row: p.row + 1, col: p.col }, { row: p.row, col: p.col - 1 }, { row: p.row, col: p.col + 1 }].filter(valid);
const home = (p: PlayerIndex) => p === 0 ? 0 : 2;
const allowed = (p: PlayerIndex, row: number) => row !== home(other(p));
const phaseNumber = (p: TurnPhase) => ({ start: 0, upkeep: 1, main: 2, end: 3 })[p];
const blank = (): GameState['board'] => ({ rows: [[null, null, null], [null, null, null], [null, null, null]] });
const at = (s: GameState, p: Position) => s.board.rows[p.row][p.col];
const put = (s: GameState, p: Position, c: BoardCell | null) => { s.board.rows[p.row][p.col] = c; };
const units = (s: GameState, owner: PlayerIndex) => {
  const result: { position: Position; cell: BoardCell }[] = [];
  for (let row = 0; row < N; row++) for (let col = 0; col < N; col++) {
    const cell = s.board.rows[row][col];
    if (cell?.owner_index === owner) result.push({ position: { row, col }, cell });
  }
  return result;
};
const enemies = (s: GameState, p: Position, owner: PlayerIndex) => around(p).filter(q => at(s, q)?.owner_index === other(owner));
const instance = (cell: BoardCell): CardInstance => ({ instance_id: cell.instance_id, card_id: cell.card_id });
const effects = (raw: unknown): EffectDefinition[] => {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as { effects?: unknown; type?: unknown };
  return Array.isArray(obj.effects) ? obj.effects.filter(e => e && typeof e === 'object' && 'type' in e) as EffectDefinition[] : obj.type ? [obj as EffectDefinition] : [];
};
const targeted = (card: CardData) => effects(card.effect_json).some(e => e.target === 'any_creature' || e.type === 'return_hand');
const keyword = (card: CardData, name: string) => {
  const c = card as CardData & { keywords?: unknown; keyword_json?: unknown };
  const raw = [c.keywords, c.keyword_json, (card.effect_json as { keywords?: unknown } | null)?.keywords];
  return raw.some(k => Array.isArray(k) && k.some(v => String(v).toLowerCase() === name));
};
function shuffle<T>(values: T[]) {
  const a = [...values];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
async function load(id: string): Promise<GameState> {
  const { data, error } = await db.from('game_state').select('state_json').eq('match_id', id).single();
  if (error || !data) throw new Error(`Stato partita non trovato: ${error?.message ?? id}`);
  const s = data.state_json as GameState;
  if (s.state_version !== 2 || !s.board?.rows) throw new Error('Partita precedente non compatibile: avvia una nuova partita.');
  return s;
}
export async function saveGameState(id: string, s: GameState) {
  const { error } = await db.from('game_state').update({ state_json: s, current_turn: s.current_turn, current_phase: phaseNumber(s.phase), last_updated: new Date().toISOString() }).eq('match_id', id);
  if (error) throw new Error(`Salvataggio partita: ${error.message}`);
}
export async function logMatchAction(id: string, entry: MatchLogEntry) {
  const { error } = await db.from('match_logs').insert({ match_id: id, log_data: entry });
  if (error) throw new Error(`Log partita: ${error.message}`);
}
async function log(id: string, s: GameState, owner: number, action: string, description: string, extra: Partial<MatchLogEntry> = {}) {
  await logMatchAction(id, { turn: s.current_turn, phase: s.phase, player_index: owner, action_type: action, description, ...extra });
}
export async function getCardData(id: string): Promise<CardData> {
  const { data, error } = await db.from('cards').select('id,name,faction_id,card_type,mana_cost,sacrifice_cost,attack,hp,subtype,rarity,effect_text,effect_json,effect_on_death_json,flavor_text,image_url,factions!left(code)').eq('id', id).single();
  if (error || !data) throw new Error(`Carta non trovata: ${error?.message ?? id}`);
  const f = Array.isArray(data.factions) ? data.factions[0] : data.factions;
  return { ...data, faction_code: f && typeof f === 'object' && 'code' in f ? String(f.code) : 'IND' } as CardData;
}
function locate(s: GameState, id: string) {
  for (let row = 0; row < N; row++) for (let col = 0; col < N; col++) {
    const cell = s.board.rows[row][col];
    if (cell?.instance_id === id) return { position: { row, col }, cell };
  }
  throw new Error('Creatura bersaglio non presente sulla plancia');
}
function eligible(s: GameState, owner: PlayerIndex, effect: EffectDefinition) {
  if ((effect.type === 'damage' || effect.type === 'damage_creature') && effect.timing !== 'instant') return units(s, other(owner));
  if (effect.type === 'heal' && effect.timing !== 'instant') return units(s, owner);
  return [...units(s, 0), ...units(s, 1)];
}
function chosenTarget(s: GameState, owner: PlayerIndex, effect: EffectDefinition, id: string | null) {
  if (!id) return null;
  const selected = locate(s, id);
  if (!eligible(s, owner, effect).some(x => x.cell.instance_id === id)) throw new Error('Bersaglio non valido per questo effetto');
  return selected;
}
async function clearLoop(id: string, s: GameState) {
  for (let row = 0; row < N; row++) for (let col = 0; col < N; col++) {
    const cell = s.board.rows[row][col];
    if (cell) { s.players[cell.owner_index].graveyard.push(instance(cell), ...cell.auras); s.board.rows[row][col] = null; }
  }
  for (const p of s.players) { if (p.field_spell) p.graveyard.push(p.field_spell); p.field_spell = null; }
  await log(id, s, -1, 'anti_loop_cleanup', 'La Penombra divora ogni cosa: venti trigger consecutivi, plancia svuotata.');
}
async function destroy(id: string, s: GameState, p: Position, killer: PlayerIndex) {
  const cell = at(s, p);
  if (!cell) return;
  put(s, p, null);
  s.players[cell.owner_index].graveyard.push(instance(cell), ...cell.auras);
  const card = await getCardData(cell.card_id);
  await log(id, s, cell.owner_index, 'creature_destroyed', `${card.name} viene distrutto.`, { card_id: card.id, instance_id: cell.instance_id, position: p });
  for (const effect of effects(card.effect_on_death_json)) {
    s.anti_loop_counter++;
    if (s.anti_loop_counter > 20) { await clearLoop(id, s); return; }
    await resolve(id, s, cell.owner_index, killer, card, effect, null, false);
  }
}
async function finish(id: string, s: GameState, winner: PlayerIndex, reason: string) {
  if (s.status === 'finished') return;
  s.status = 'finished'; s.phase = 'end'; s.winner_index = winner;
  const { error } = await db.from('matches').update({ player_won: winner === 1, turns_count: s.current_turn }).eq('id', id);
  if (error) throw new Error(`Chiusura partita: ${error.message}`);
  await saveGameState(id, s);
  await log(id, s, winner, 'match_end', `${winner === 1 ? 'Hai vinto' : 'L’IA ha vinto'}. ${reason}`);
}
function winner(s: GameState): PlayerIndex | null {
  if (s.players[0].life <= 0) return 1;
  if (s.players[1].life <= 0) return 0;
  return null;
}
// Ogni singolo tentativo di pesca senza carte costa esattamente 2 PV.
// La funzione non conclude direttamente la partita: il chiamante salva o chiude lo stato.
async function draw(id: string, s: GameState, recipient: PlayerIndex, amount: number): Promise<number> {
  let taken = 0;
  for (let i = 0; i < amount; i++) {
    const next = s.players[recipient].deck.shift();
    if (next) { s.players[recipient].hand.push(next); taken++; }
    else {
      s.players[recipient].life -= 2;
      await log(id, s, recipient, 'empty_draw_damage', `${label(recipient)} ${recipient === 1 ? 'dovresti pescare' : 'dovrebbe pescare'}, ma il mazzo è vuoto: subisce 2 danni (${Math.max(0, s.players[recipient].life)} PV rimasti).`, { amount: 2 });
      if (s.players[recipient].life <= 0) break;
    }
  }
  return taken;
}
type Context = { id: string; state: GameState; owner: PlayerIndex; opponent: PlayerIndex; card: CardData; effect: EffectDefinition; amount: number; targetId: string | null };
async function effectDraw(c: Context) {
  const recipient = c.effect.target === 'opponent' ? c.opponent : c.owner;
  const count = await draw(c.id, c.state, recipient, c.amount);
  await log(c.id, c.state, c.owner, 'effect_draw', `${c.card.name}: ${recipient === 1 ? 'peschi' : 'l’IA pesca'} ${count} carta/e su ${c.amount} richiesta/e.`);
}
async function effectDiscard(c: Context) {
  const recipient = c.effect.target === 'self' ? c.owner : c.opponent;
  let count = 0;
  while (count < c.amount && c.state.players[recipient].hand.length) {
    const index = Math.floor(Math.random() * c.state.players[recipient].hand.length);
    c.state.players[recipient].graveyard.push(c.state.players[recipient].hand.splice(index, 1)[0]); count++;
  }
  await log(c.id, c.state, c.owner, 'effect_discard', `${c.card.name}: ${label(recipient)} scarta ${count} carta/e.`);
}
async function effectHeal(c: Context) {
  const target = c.effect.target ?? 'self';
  if (target === 'any_creature') {
    const selected = chosenTarget(c.state, c.owner, c.effect, c.targetId)?.cell;
    if (!selected) throw new Error('Seleziona una creatura da curare');
    selected.hp = Math.min(selected.max_hp, selected.hp + c.amount);
  } else if (target.startsWith('all_creatures')) {
    const owners = target === 'all_creatures_opponent' ? [c.opponent] : [c.owner];
    for (const p of owners) for (const { cell } of units(c.state, p)) cell.hp = Math.min(cell.max_hp, cell.hp + c.amount);
  } else c.state.players[target === 'opponent' ? c.opponent : c.owner].life += c.amount;
  await log(c.id, c.state, c.owner, 'effect_heal', `${c.card.name}: cura ${c.amount}.`);
}
async function effectDamage(c: Context) {
  if (c.effect.target === 'all_creatures') {
    const snapshot = [...units(c.state, 0), ...units(c.state, 1)];
    for (const { position, cell } of snapshot) if (at(c.state, position)?.instance_id === cell.instance_id) cell.hp -= c.amount;
    await log(c.id, c.state, c.owner, 'effect_damage_all', `${c.card.name}: ${c.amount} danno/i a tutte le creature.`);
    for (const { position, cell } of snapshot) if (at(c.state, position)?.instance_id === cell.instance_id && cell.hp <= 0) await destroy(c.id, c.state, position, c.owner);
    return;
  }
  if (c.effect.target !== 'any_creature' || !c.targetId) throw new Error('Seleziona una creatura bersaglio');
  const selected = chosenTarget(c.state, c.owner, c.effect, c.targetId)!;
  selected.cell.hp -= c.amount;
  await log(c.id, c.state, c.owner, 'effect_damage', `${c.card.name}: infligge ${c.amount} danno/i a una creatura.`, { target_instance_id: c.targetId });
  if (selected.cell.hp <= 0) await destroy(c.id, c.state, selected.position, c.owner);
}
async function effectReturnHand(c: Context) {
  if (!c.targetId) throw new Error('Seleziona una creatura bersaglio');
  const { cell, position } = chosenTarget(c.state, c.owner, c.effect, c.targetId)!;
  put(c.state, position, null);
  c.state.players[cell.owner_index].hand.push(instance(cell));
  c.state.players[cell.owner_index].graveyard.push(...cell.auras);
  await log(c.id, c.state, c.owner, 'effect_return_hand', `${c.card.name}: una creatura torna in mano.`);
}
async function effectBuff(c: Context) {
  const detail = c.effect as EffectDefinition & { stat?: string; duration?: string };
  if (c.effect.target === 'all_creatures' && detail.stat === 'hp' && detail.duration === 'permanent') {
    for (const { cell } of units(c.state, c.owner)) { cell.max_hp += c.amount; cell.hp += c.amount; }
    await log(c.id, c.state, c.owner, 'effect_buff', `${c.card.name}: tutte le tue creature guadagnano ${c.amount} HP permanenti.`);
    return;
  }
  if (c.effect.target !== 'any_creature' || !c.targetId) throw new Error('Seleziona una creatura da potenziare');
  const selected = chosenTarget(c.state, c.owner, c.effect, c.targetId)!.cell as BoardCell & { temp_attack?: number };
  if (detail.stat === 'hp' && detail.duration === 'permanent') { selected.max_hp += c.amount; selected.hp += c.amount; }
  else if (detail.stat === 'attack' && (detail.duration === 'turn' || detail.duration === 'permanent')) {
    selected.attack += c.amount;
    if (detail.duration === 'turn') selected.temp_attack = (selected.temp_attack ?? 0) + c.amount;
  } else throw new Error('Potenziamento non supportato');
  await log(c.id, c.state, c.owner, 'effect_buff', `${c.card.name}: +${c.amount} ${detail.stat === 'hp' ? 'HP permanenti' : detail.duration === 'turn' ? 'attacco fino a fine turno' : 'attacco permanente'}.`);
}

function expireTemporaryBuffs(s: GameState) {
  for (const owner of [0, 1] as const) for (const { cell } of units(s, owner)) {
    const buffed = cell as BoardCell & { temp_attack?: number };
    if (buffed.temp_attack) { buffed.attack -= buffed.temp_attack; delete buffed.temp_attack; }
  }
}
async function resolve(id: string, s: GameState, owner: PlayerIndex, opponent: PlayerIndex, card: CardData, effect: EffectDefinition, targetId: string | null, etb: boolean) {
  const amount = Number(effect.amount ?? 1);
  if (!Number.isInteger(amount) || amount < 0 || amount > 20) throw new Error('Quantità effetto non valida');
  if (effect.target === 'any_creature' || effect.type === 'return_hand') {
    const available = eligible(s, owner, effect);
    if (etb && available.length === 0) {
      await log(id, s, owner, 'etb_no_target', `${card.name} entra in campo: nessun bersaglio valido, l’effetto ETB non si attiva.`, { card_id: card.id });
      return;
    }
    if (!targetId) throw new Error('Seleziona un bersaglio valido per l’effetto');
    chosenTarget(s, owner, effect, targetId);
  }
  const context: Context = { id, state: s, owner, opponent, card, effect, amount, targetId };
  if (effect.type === 'draw') await effectDraw(context);
  else if (effect.type === 'discard') await effectDiscard(context);
  else if (effect.type === 'heal') await effectHeal(context);
  else if (effect.type === 'damage' || effect.type === 'damage_creature') await effectDamage(context);
  else if (effect.type === 'return_hand') await effectReturnHand(context);
  else if (effect.type === 'buff') await effectBuff(context);
  else throw new Error(`${card.name}: effetto ${effect.type} non ancora implementato.`);
}

async function deck(): Promise<CardInstance[]> {
  const { data, error } = await db.from('cards').select('id,card_type,mana_cost,is_boss,effect_json').in('card_type', ['monster', 'instant']);
  if (error || !data) throw new Error(`Catalogo non disponibile: ${error?.message ?? 'nessun risultato'}`);
  const pool = data.map(c => ({ id: String(c.id), cost: Number(c.mana_cost), boss: Boolean(c.is_boss), type: String(c.card_type), raw: c.effect_json }));
  const monsters = pool.filter(c => c.type === 'monster');
  const instantTypes = new Set(['draw', 'discard', 'heal', 'damage', 'damage_creature', 'return_hand', 'buff']);
  const instants = pool.filter(c => c.type === 'instant' && effects(c.raw).length > 0 && effects(c.raw).every(e => instantTypes.has(e.type)));
  const low = monsters.filter(c => c.cost <= 2), mid = monsters.filter(c => c.cost >= 2 && c.cost <= 4), high = monsters.filter(c => c.cost >= 5);
  if (!instants.length || !low.length || !mid.length || !high.length) throw new Error('Catalogo insufficiente per il mazzo di test con Istantanei');
  const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
  for (let attempt = 0; attempt < 300; attempt++) {
    const bosses = high.filter(c => c.boss);
    const chosen = [pick(bosses.length ? bosses : high), pick(low), pick(low), pick(mid), pick(mid), pick(mid), pick(instants), pick(instants)];
    while (chosen.length < 10) chosen.push(pick(monsters));
    const avg = chosen.reduce((sum, c) => sum + c.cost, 0) / 10;
    if (avg >= 2.5 && avg <= 4) return shuffle(chosen.map(c => ({ instance_id: randomUUID(), card_id: c.id })));
  }
  throw new Error('Impossibile generare un mazzo con curva mana 2,5–4 e due Istantanei');
}
function player(index: PlayerIndex, userId: string | null, cards: CardInstance[]): PlayerState {
  return { player_index: index, user_id: userId, life: 20, max_mana: 0, current_mana: 0, deck: cards, hand: [], graveyard: [], extra_deck: [], color_counters: { CHI: 0, INF: 0, PES: 0, BUL: 0, GRO: 0, CLO: 0, IND: 0 }, field_spell: null };
}
export async function createNewMatch(userId: string): Promise<{ matchId: string; state: GameState }> {
  const [aiCards, humanCards] = await Promise.all([deck(), deck()]);
  const { data, error } = await db.from('matches').insert({ player_id: userId, opponent_type: 'ai', opponent_name: 'IA Bellum Penumbrum', player_won: null, turns_count: 0, duration_seconds: 0 }).select('id').single();
  if (error || !data) throw new Error(`Creazione partita: ${error?.message ?? 'nessun ID'}`);
  const matchId = String(data.id);
  const ai = player(0, null, aiCards), human = player(1, userId, humanCards);
  // La mano iniziale è assegnata durante la preparazione, non sono tentativi di pesca.
  for (let i = 0; i < 4; i++) ai.hand.push(ai.deck.shift()!);
  for (let i = 0; i < 3; i++) human.hand.push(human.deck.shift()!);
  human.max_mana = human.current_mana = 1;
  const state: GameState = { state_version: 2, match_id: matchId, status: 'running', players: [ai, human], board: blank(), current_turn: 1, active_player_index: 1, phase: 'main', anti_loop_counter: 0, winner_index: null };
  const inserted = await db.from('game_state').insert({ match_id: matchId, state_json: state, current_turn: 1, current_phase: 2, last_updated: new Date().toISOString() });
  if (inserted.error) throw new Error(`Creazione stato: ${inserted.error.message}`);
  await log(matchId, state, -1, 'match_create', 'Partita iniziata: tu hai 3 carte e 1 mana; l’IA ha 4 carte.');
  return { matchId, state };
}
export async function getMatchState(id: string) { return load(id); }
function assertTurn(s: GameState, p: PlayerIndex) {
  if (s.status !== 'running' || s.active_player_index !== p || s.phase !== 'main') throw new Error('Azione non disponibile in questo turno');
  if (s.pending_mostrissimo) throw new Error('Completa prima l’evocazione del Mostrissimo');
}
export async function playCard(id: string, p: PlayerIndex, cardInstanceId: string, options: PlayCardOptions = {}): Promise<GameState> {
  const s = await load(id); assertTurn(s, p);
  const owner = s.players[p];
  const i = owner.hand.findIndex(c => c.instance_id === cardInstanceId);
  if (i < 0) throw new Error('Carta non presente nella mano');
  const card = await getCardData(owner.hand[i].card_id);
  if (card.card_type === 'mostrissimo') throw new Error('Evoca i Mostrissimi dall’offerta condivisa');
  if (owner.current_mana < card.mana_cost) throw new Error('Mana insufficiente');
  const creature = card.card_type === 'monster' || card.card_type === 'mostrissimo';
  if (creature) {
    if (!options.position || !valid(options.position) || options.position.row !== home(p) || at(s, options.position)) throw new Error('Evoca in una cella libera della tua riga iniziale');
    if (card.card_type === 'mostrissimo') throw new Error('I Mostrissimi richiedono la selezione manuale dei sacrifici: non ancora disponibile in questa versione.');
  }
  if (card.card_type === 'terraforma' && owner.field_spell) throw new Error('Una Terraforma è già attiva');
  if (card.card_type === 'aura' && !options.targetInstanceId) throw new Error('Seleziona una creatura per l’Aura');
  const onPlay = effects(card.effect_json);
  const supported = new Set(['draw', 'discard', 'heal', 'damage', 'damage_creature', 'return_hand', 'buff']);
  if (card.card_type === 'instant' && s.active_player_index !== p) throw new Error('Le finestre reattive non sono ancora disponibili');
  if (card.card_type === 'instant' && onPlay.some(e => String(e.type) === 'counter')) throw new Error('Contromagia richiede una Stregoneria avversaria dichiarata');
  if (onPlay.some(e => !supported.has(e.type))) throw new Error('Effetto carta non ancora supportato');
  for (const effect of onPlay.filter(e => e.target === 'any_creature' || e.type === 'return_hand')) {
    const candidates = eligible(s, p, effect);
    if (options.targetInstanceId) {
      if (!candidates.some(x => x.cell.instance_id === options.targetInstanceId)) throw new Error('Bersaglio non valido per questo effetto');
    } else if (candidates.length && !(creature && effect.type === 'heal' && candidates.length === 0)) {
      throw new Error('Seleziona una creatura bersaglio per l’effetto');
    } else if (!creature) throw new Error('Questa magia richiede una creatura bersaglio');
  }
  const played = owner.hand.splice(i, 1)[0]; owner.current_mana -= card.mana_cost;
  owner.color_counters[card.faction_code] = (owner.color_counters[card.faction_code] ?? 0) + 1;
  if (creature) {
    put(s, options.position!, { instance_id: played.instance_id, card_id: played.card_id, owner_index: p, attack: Number(card.attack ?? 0), hp: Number(card.hp ?? 1), max_hp: Number(card.hp ?? 1), tired: !keyword(card, 'iperattivo'), auras: [] });
  } else if (card.card_type === 'terraforma') owner.field_spell = played;
  else if (card.card_type === 'aura') locate(s, options.targetInstanceId!).cell.auras.push(played);
  else owner.graveyard.push(played);
  await log(id, s, p, 'play_card', `${label(p)} ${p === 1 ? 'giochi' : 'gioca'} ${card.name}.`, { card_id: card.id, instance_id: played.instance_id, position: options.position ?? null });
  for (const effect of onPlay) {
    const resolvedTarget = creature && effect.type === 'heal' && effect.target === 'any_creature' && !options.targetInstanceId && units(s, p).length === 1 ? played.instance_id : options.targetInstanceId ?? null;
    await resolve(id, s, p, other(p), card, effect, resolvedTarget, creature);
    const won = winner(s);
    if (won !== null) { await finish(id, s, won, 'PV esauriti dopo un effetto di pesca.'); return s; }
  }
  await saveGameState(id, s); return s;
}
export async function moveCreature(id: string, p: PlayerIndex, from: Position, to: Position): Promise<GameState> {
  const s = await load(id); assertTurn(s, p);
  if (!valid(from) || !valid(to) || !adjacent(from, to) || !allowed(p, to.row)) throw new Error('Movimento non valido: una cella ortogonale, senza entrare nella riga avversaria');
  const c = at(s, from);
  if (!c || c.owner_index !== p || c.tired || at(s, to)) throw new Error('Creatura stanca, non tua o destinazione occupata');
  if (s.players[p].current_mana < 1) throw new Error('Serve 1 mana per Muovi');
  s.players[p].current_mana--;
  put(s, from, null); put(s, to, c);
  const card = await getCardData(c.card_id);
  await log(id, s, p, 'move_creature', `${label(p)} ${p === 1 ? 'muovi' : 'muove'} ${card.name} spendendo 1 mana. Rimane pronta.`, { from_position: from, to_position: to, card_id: card.id, instance_id: c.instance_id });
  await saveGameState(id, s); return s;
}
export async function attack(id: string, p: PlayerIndex, from: Position, target: AttackTarget): Promise<GameState> {
  const s = await load(id); assertTurn(s, p);
  if (!valid(from)) throw new Error('Attaccante non valido');
  const c = at(s, from);
  if (!c || c.owner_index !== p || c.tired) throw new Error('Creatura non tua oppure stanca');
  const options = enemies(s, from, p);
  const name = (await getCardData(c.card_id)).name;
  if (target.type === 'creature') {
    if (!valid(target.position) || !options.some(q => q.row === target.position.row && q.col === target.position.col)) throw new Error('Bersaglio non ortogonalmente adiacente');
    const victim = at(s, target.position)!;
    victim.hp -= c.attack; c.tired = true;
    await log(id, s, p, 'attack_creature', `${label(p)} ${p === 1 ? 'attacchi' : 'attacca'} con ${name}: ${c.attack} danno/i a una creatura.`, { position: from, target_instance_id: victim.instance_id });
    if (victim.hp <= 0) await destroy(id, s, target.position, p);
  } else {
    if (target.playerIndex !== other(p) || options.length) throw new Error('Attacco diretto vietato: esistono altri bersagli validi');
    s.players[other(p)].life -= c.attack; c.tired = true;
    await log(id, s, p, 'attack_player', `${label(p)} ${p === 1 ? 'attacchi' : 'attacca'} direttamente con ${name}: ${c.attack} danno/i.`, { position: from, target_player_index: other(p) });
  }
  const won = winner(s);
  if (won !== null) await finish(id, s, won, 'PV esauriti.');
  else await saveGameState(id, s);
  return s;
}
async function start(id: string, p: PlayerIndex): Promise<GameState> {
  const s = await load(id);
  s.active_player_index = p; s.phase = 'upkeep'; s.anti_loop_counter = 0;
  if (p === 1) s.current_turn++;
  const player = s.players[p]; player.max_mana = Math.min(6, player.max_mana + 1); player.current_mana = player.max_mana;
  for (const { cell } of units(s, p)) cell.tired = false;
  const count = await draw(id, s, p, 1);
  await log(id, s, p, 'upkeep', `${p === 1 ? 'Raggiungi' : 'L’IA raggiunge'} ${player.current_mana}/${player.max_mana} mana e ${p === 1 ? 'peschi' : 'pesca'} ${count} carta/e.`);
  const won = winner(s);
  if (won !== null) { await finish(id, s, won, 'PV esauriti dopo una pesca impossibile.'); return s; }
  s.phase = 'main'; await saveGameState(id, s); return s;
}
async function aiTurn(id: string) {
  for (let count = 0; count < 20; count++) {
    const s = await load(id);
    if (s.status !== 'running') break;
    const ready = units(s, 0).filter(u => !u.cell.tired);
    if (ready.length) {
      const u = ready[0]; const targets = enemies(s, u.position, 0);
      await attack(id, 0, u.position, targets.length ? { type: 'creature', position: targets[0] } : { type: 'player', playerIndex: 1 });
      continue;
    }
    const free = [0, 1, 2].filter(col => !s.board.rows[0][col]);
    if (free.length && s.players[0].hand.length) {
      const cards = await Promise.all(s.players[0].hand.map(async c => ({ instance: c, card: await getCardData(c.card_id) })));
      const choices = cards.filter(x => x.card.card_type === 'monster' && x.card.mana_cost <= s.players[0].current_mana && effects(x.card.effect_json).every(e => ['draw', 'discard', 'heal', 'damage', 'damage_creature', 'return_hand'].includes(e.type)));
      const choice = choices.find(x => !targeted(x.card)) ?? choices.find(x => effects(x.card.effect_json).every(e => (e.type === 'damage' || e.type === 'damage_creature') && e.target === 'any_creature' && units(s, 1).length === 0)) ?? choices.find(x => targeted(x.card) && units(s, 1).length);
      if (choice) {
        const options: PlayCardOptions = { position: { row: 0, col: free[0] } };
        const effect = effects(choice.card.effect_json).find(e => e.target === 'any_creature' || e.type === 'return_hand');
        if (effect && eligible(s, 0, effect).length) options.targetInstanceId = eligible(s, 0, effect)[0].cell.instance_id;
        await playCard(id, 0, choice.instance.instance_id, options); continue;
      }
    }
    const mover = units(s, 0).find(u => !u.cell.tired && s.players[0].current_mana >= 1 && around(u.position).some(q => allowed(0, q.row) && !at(s, q) && enemies(s, q, 0).length));
    if (mover) {
      const to = around(mover.position).find(q => allowed(0, q.row) && !at(s, q) && enemies(s, q, 0).length)!;
      await moveCreature(id, 0, mover.position, to); continue;
    }
    break;
  }
  const s = await load(id);
  if (s.status === 'running') { expireTemporaryBuffs(s); s.phase = 'end'; await log(id, s, 0, 'turn_end', 'L’IA termina il turno.'); await saveGameState(id, s); }
}
export async function endHumanTurn(id: string): Promise<GameState> {
  const s = await load(id); assertTurn(s, 1);
  expireTemporaryBuffs(s); s.phase = 'end'; await log(id, s, 1, 'turn_end', 'Termini il turno.'); await saveGameState(id, s);
  const ai = await start(id, 0); if (ai.status === 'finished') return ai;
  await aiTurn(id); const after = await load(id);
  return after.status === 'running' ? start(id, 1) : after;
}
