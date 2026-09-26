// backend/engine.ts — Bellum Penumbrum, stato v4.
// Caricare solo insieme a backend/types.ts v4, SQL v4 e frontend v4.
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type {
  AiProgress, AttackTarget, BoardCell, CardData, CardEffectJson,
  CardInstance, CreatureCell, EffectDefinition, GameState, MatchLogEntry,
  PendingEvent, PendingWork, PlayerIndex, PlayerState, PlayCardOptions,
  Position, ReactionTriggerEvent, TrapChoice, TurnPhase,
} from './types.js';

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
const db = createClient(url, key);
const other = (p: PlayerIndex): PlayerIndex => p === 0 ? 1 : 0;
const label = (p: PlayerIndex) => p === 1 ? 'Tu' : 'L’IA';
const home = (p: PlayerIndex) => p === 0 ? 0 : 2;
const allowed = (p: PlayerIndex, row: number) => row !== home(other(p));
const valid = (p: Position) => Number.isInteger(p.row) && Number.isInteger(p.col) && p.row >= 0 && p.row < 3 && p.col >= 0 && p.col < 3;
const adjacent = (a: Position, b: Position) => Math.abs(a.row - b.row) + Math.abs(a.col - b.col) === 1;
const around = (p: Position) => [{ row: p.row - 1, col: p.col }, { row: p.row + 1, col: p.col }, { row: p.row, col: p.col - 1 }, { row: p.row, col: p.col + 1 }].filter(valid);
const blank = (): GameState['board'] => ({ rows: [[null, null, null], [null, null, null], [null, null, null]] });
const at = (s: GameState, p: Position) => valid(p) ? s.board.rows[p.row][p.col] : null;
const put = (s: GameState, p: Position, c: BoardCell | null) => { s.board.rows[p.row][p.col] = c; };
const instance = (c: CardInstance): CardInstance => ({ instance_id: c.instance_id, card_id: c.card_id });
const effects = (raw: CardEffectJson | null): EffectDefinition[] => raw && 'effects' in raw && Array.isArray(raw.effects) ? raw.effects : raw && 'type' in raw ? [raw] : [];
const reactionTrigger = (d: CardData): ReactionTriggerEvent | undefined => d.effect_json?.reaction_trigger?.event;
const targeted = (e: EffectDefinition) => e.target === 'any_creature' || e.type === 'return_hand';
const supported = new Set(['draw', 'discard', 'heal', 'damage', 'damage_creature', 'return_hand', 'destroy', 'buff']);
const phaseNumber = (p: TurnPhase) => ({ start: 0, upkeep: 1, main: 2, end: 3 })[p];
function shuffle<T>(input: T[]) {
  const a = [...input];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function cells(s: GameState) {
  const out: { position: Position; cell: BoardCell }[] = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const cell = s.board.rows[row][col];
    if (cell) out.push({ position: { row, col }, cell });
  }
  return out;
}
function units(s: GameState, owner?: PlayerIndex) {
  return cells(s).filter((x): x is { position: Position; cell: CreatureCell } => x.cell.kind === 'creature' && (owner === undefined || x.cell.owner_index === owner));
}
function find(s: GameState, id: string) { return cells(s).find(x => x.cell.instance_id === id) ?? null; }
function findCreature(s: GameState, id: string) {
  const x = find(s, id);
  return x?.cell.kind === 'creature' ? { position: x.position, cell: x.cell } : null;
}
function findAura(s: GameState, id: string) {
  for (const host of units(s)) {
    const aura = host.cell.auras.find(a => a.instance_id === id);
    if (aura) return { ...host, aura };
  }
  return null;
}
function enemyNeighbours(s: GameState, p: Position, owner: PlayerIndex) {
  return around(p).filter(q => { const c = at(s, q); return c?.kind === 'creature' && c.owner_index === other(owner); });
}
function eligible(s: GameState, owner: PlayerIndex, e: EffectDefinition) {
  if ((e.type === 'damage' || e.type === 'damage_creature') && e.timing !== 'instant') return units(s, other(owner));
  if (e.type === 'heal' && e.timing !== 'instant') return units(s, owner);
  return units(s);
}
function target(s: GameState, owner: PlayerIndex, effect: EffectDefinition, id: string | null) {
  const x = id ? findCreature(s, id) : null;
  return x && eligible(s, owner, effect).some(v => v.cell.instance_id === id) ? x : null;
}
function prepend(s: GameState, ...items: PendingWork[]) { s.work_queue.unshift(...items); }
function keyword(d: CardData, value: string) {
  const extra = d as CardData & { keywords?: unknown; keyword_json?: unknown };
  return [extra.keywords, extra.keyword_json].some(x => Array.isArray(x) && x.some(v => String(v).toLowerCase() === value));
}
async function load(id: string): Promise<GameState> {
  const { data, error } = await db.from('game_state').select('state_json,revision').eq('match_id', id).single();
  if (error || !data) throw new Error(`Stato partita non trovato: ${error?.message ?? id}`);
  const s = data.state_json as GameState;
  if (s.state_version !== 4 || !s.board?.rows || !Array.isArray(s.work_queue)) throw new Error('Partita precedente non compatibile: avvia una nuova partita.');
  if (Number(data.revision) !== s.state_revision) throw new Error('Revisione dello stato non coerente');
  return s;
}
async function commit(id: string, s: GameState, logs: MatchLogEntry[]): Promise<GameState> {
  const { data, error } = await db.rpc('commit_match_state', {
    p_match_id: id, p_expected_revision: s.state_revision, p_next_state: s, p_log_entries: logs,
  });
  if (error) throw new Error(`Salvataggio partita: ${error.message}`);
  return data as GameState;
}
export async function saveGameState(id: string, s: GameState): Promise<GameState> { return commit(id, s, []); }
export async function logMatchAction(id: string, entry: MatchLogEntry): Promise<void> {
  const { error } = await db.from('match_logs').insert({ match_id: id, log_data: entry });
  if (error) throw new Error(`Log partita: ${error.message}`);
}
export async function getCardData(id: string): Promise<CardData> {
  const { data, error } = await db.from('cards').select('id,name,faction_id,card_type,mana_cost,sacrifice_cost,attack,hp,subtype,rarity,effect_text,effect_json,effect_on_death_json,flavor_text,image_url,factions!left(code)').eq('id', id).single();
  if (error || !data) throw new Error(`Carta non trovata: ${error?.message ?? id}`);
  const f = Array.isArray(data.factions) ? data.factions[0] : data.factions;
  return { ...data, faction_code: f && typeof f === 'object' && 'code' in f ? String(f.code) : 'IND' } as CardData;
}

type Context = { id: string; s: GameState; logs: MatchLogEntry[] };
type AuraStats = CreatureCell & { aura_attack_bonus?: number; aura_hp_bonus?: number };
function log(c: Context, owner: number, action: string, description: string, extra: Partial<MatchLogEntry> = {}) {
  c.logs.push({ turn: c.s.current_turn, phase: c.s.phase, player_index: owner, action_type: action, description, ...extra });
}
function checkWinner(c: Context, reason: string) {
  if (c.s.status !== 'running') return;
  const winner: PlayerIndex | null = c.s.players[0].life <= 0 ? 1 : c.s.players[1].life <= 0 ? 0 : null;
  if (winner === null) return;
  c.s.status = 'finished'; c.s.phase = 'end'; c.s.winner_index = winner;
  delete c.s.pending_reaction; delete c.s.pending_mostrissimo; delete c.s.ai_progress;
  c.s.work_queue = [];
  log(c, winner, 'match_end', `${winner === 1 ? 'Hai vinto' : 'L’IA ha vinto'}. ${reason}`);
}
function draw(c: Context, p: PlayerIndex, count: number) {
  let taken = 0;
  for (let i = 0; i < count && c.s.status === 'running'; i++) {
    const card = c.s.players[p].deck.shift();
    if (card) { c.s.players[p].hand.push(card); taken++; }
    else {
      c.s.players[p].life -= 2;
      log(c, p, 'empty_draw_damage', `${label(p)} subisce 2 danni per una pesca a mazzo vuoto.`, { amount: 2 });
      checkWinner(c, 'PV esauriti dopo una pesca impossibile.');
    }
  }
  return taken;
}
function cleanupLoop(c: Context) {
  for (const { position, cell } of cells(c.s)) {
    c.s.players[cell.owner_index].graveyard.push(instance(cell));
    if (cell.kind === 'creature') for (const aura of cell.auras) c.s.players[aura.owner_index].graveyard.push(instance(aura));
    put(c.s, position, null);
  }
  c.s.work_queue = c.s.work_queue.filter(x => x.kind !== 'resolve_effect');
  c.s.anti_loop_counter = 0;
  log(c, -1, 'anti_loop_cleanup', 'La Penombra divora ogni cosa: venti trigger consecutivi, plancia svuotata.');
}
async function destroyCell(c: Context, position: Position, killer: PlayerIndex, reason: 'destroy' | 'sacrifice' = 'destroy') {
  const cell = at(c.s, position);
  if (!cell) return;
  put(c.s, position, null);
  c.s.players[cell.owner_index].graveyard.push(instance(cell));
  if (cell.kind === 'creature') for (const aura of cell.auras) c.s.players[aura.owner_index].graveyard.push(instance(aura));
  const d = await getCardData(cell.card_id);
  log(c, cell.owner_index, reason === 'sacrifice' ? 'permanent_sacrificed' : 'permanent_destroyed', `${d.name} lascia il campo.`, { card_id: d.id, instance_id: cell.instance_id, position });
  const steps: PendingWork[] = effects(d.effect_on_death_json).map((_, effect_index) => ({
    kind: 'resolve_effect', owner: cell.owner_index, card_id: d.id,
    source_instance_id: cell.instance_id, source: 'on_death', effect_index,
    target_instance_id: null, require_source_on_board: false,
  }));
  prepend(c.s, ...steps);
  await reconcileAuras(c);
  void killer;
}
async function reconcileAuras(c: Context) {
  const s = c.s, all = units(s);
  const totals = new Map<string, { attack: number; hp: number }>();
  for (const host of all) totals.set(host.cell.instance_id, { attack: 0, hp: 0 });
  for (const host of all) for (const aura of host.cell.auras) {
    const d = await getCardData(aura.card_id);
    for (const e of effects(d.effect_json)) {
      if (e.type !== 'buff' || e.duration !== 'while_attached' || !e.stat) continue;
      const n = Number(e.amount);
      if (!Number.isInteger(n) || n < 0 || n > 20) throw new Error('Bonus Aura non valido');
      const recipients = e.target === 'enchanted_creature' ? [host] : e.target === 'all_creatures_self' ? units(s, aura.owner_index) : [];
      for (const recipient of recipients) {
        const entry = totals.get(recipient.cell.instance_id)!;
        entry[e.stat] += n;
      }
    }
  }
  for (const { position, cell } of all) {
    const tracked = cell as AuraStats, next = totals.get(cell.instance_id)!;
    const attackDelta = next.attack - (tracked.aura_attack_bonus ?? 0);
    const hpDelta = next.hp - (tracked.aura_hp_bonus ?? 0);
    cell.attack += attackDelta; cell.max_hp += hpDelta; cell.hp += hpDelta;
    tracked.aura_attack_bonus = next.attack; tracked.aura_hp_bonus = next.hp;
    if (cell.hp <= 0 && at(s, position)?.instance_id === cell.instance_id) await destroyCell(c, position, cell.owner_index);
  }
}
async function removeAura(c: Context, id: string) {
  const found = findAura(c.s, id);
  if (!found) return false;
  found.cell.auras = found.cell.auras.filter(a => a.instance_id !== id);
  c.s.players[found.aura.owner_index].graveyard.push(instance(found.aura));
  log(c, found.aura.owner_index, 'aura_removed', 'Un’Aura lascia il campo.', { instance_id: id });
  await reconcileAuras(c);
  return true;
}
async function applyEffect(c: Context, task: Extract<PendingWork, { kind: 'resolve_effect' }>) {
  const s = c.s;
  const onBoard = task.source_instance_id && (find(s, task.source_instance_id) || findAura(s, task.source_instance_id));
  if (task.require_source_on_board && !onBoard) {
    log(c, task.owner, 'effect_source_gone', 'L’effetto non si risolve: la fonte non è più in campo.'); return;
  }
  const d = await getCardData(task.card_id);
  const e = effects(task.source === 'on_death' ? d.effect_on_death_json : d.effect_json)[task.effect_index];
  if (!e) return;
  s.anti_loop_counter++;
  if (s.anti_loop_counter > 20) { cleanupLoop(c); return; }
  const p = task.owner, foe = other(p), n = Number(e.amount ?? 1);
  if (!Number.isInteger(n) || n < 0 || n > 20) throw new Error('Quantità effetto non valida');
  const selected = targeted(e) ? target(s, p, e, task.target_instance_id) : null;
  if (targeted(e) && !selected) {
    log(c, p, 'effect_no_target', `${d.name}: bersaglio non più valido, effetto annullato.`, { card_id: d.id }); return;
  }
  if (e.type === 'draw') {
    const recipient = e.target === 'opponent' ? foe : p;
    const count = draw(c, recipient, n);
    log(c, p, 'effect_draw', `${d.name}: ${label(recipient)} pesca ${count} carta/e.`, { amount: count });
  } else if (e.type === 'discard') {
    const recipient = e.target === 'self' ? p : foe;
    let count = 0;
    while (count < n && s.players[recipient].hand.length) {
      const i = Math.floor(Math.random() * s.players[recipient].hand.length);
      s.players[recipient].graveyard.push(s.players[recipient].hand.splice(i, 1)[0]); count++;
    }
    log(c, p, 'effect_discard', `${d.name}: ${label(recipient)} scarta ${count} carta/e.`);
  } else if (e.type === 'heal') {
    if (e.target === 'any_creature') selected!.cell.hp = Math.min(selected!.cell.max_hp, selected!.cell.hp + n);
    else if (e.target?.startsWith('all_creatures')) {
      const owners = e.target === 'all_creatures' ? [0, 1] as const : [e.target === 'all_creatures_opponent' ? foe : p];
      for (const owner of owners) for (const { cell } of units(s, owner)) cell.hp = Math.min(cell.max_hp, cell.hp + n);
    } else s.players[e.target === 'opponent' ? foe : p].life += n;
    log(c, p, 'effect_heal', `${d.name}: cura ${n}.`);
  } else if (e.type === 'damage' || e.type === 'damage_creature') {
    if (e.target === 'all_creatures' || e.target === 'all_creatures_self' || e.target === 'all_creatures_opponent') {
      const owners = e.target === 'all_creatures' ? [0, 1] as const : [e.target === 'all_creatures_self' ? p : foe];
      const snapshot = owners.flatMap(owner => units(s, owner));
      for (const x of snapshot) x.cell.hp -= n;
      log(c, p, 'effect_damage_all', `${d.name}: ${n} danno/i alle creature.`);
      for (const x of snapshot) if (at(s, x.position)?.instance_id === x.cell.instance_id && x.cell.hp <= 0) await destroyCell(c, x.position, p);
    } else if (selected) {
      selected.cell.hp -= n;
      log(c, p, 'effect_damage', `${d.name}: ${n} danno/i a una creatura.`, { target_instance_id: selected.cell.instance_id });
      if (selected.cell.hp <= 0) await destroyCell(c, selected.position, p);
    } else throw new Error('Effetto danno senza bersaglio supportato');
  } else if (e.type === 'return_hand') {
    const x = selected!;
    put(s, x.position, null);
    s.players[x.cell.owner_index].hand.push(instance(x.cell));
    for (const aura of x.cell.auras) s.players[aura.owner_index].graveyard.push(instance(aura));
    log(c, p, 'effect_return_hand', `${d.name}: una creatura torna in mano.`, { target_instance_id: x.cell.instance_id });
    await reconcileAuras(c);
  } else if (e.type === 'destroy') {
    if (selected) await destroyCell(c, selected.position, p);
    else throw new Error('Distruzione senza bersaglio valido');
  } else if (e.type === 'buff') {
    const recipients = e.target === 'all_creatures' || e.target === 'all_creatures_self' ? units(s, p).map(x => x.cell) : selected ? [selected.cell] : [];
    if (e.duration === 'while_attached') throw new Error('Il bonus continuo Aura non si risolve come evento');
    for (const cell of recipients) {
      if (e.stat === 'hp' && e.duration === 'permanent') { cell.max_hp += n; cell.hp += n; }
      else if (e.stat === 'attack' && (e.duration === 'turn' || e.duration === 'permanent')) {
        cell.attack += n;
        if (e.duration === 'turn') cell.temp_attack = (cell.temp_attack ?? 0) + n;
      } else throw new Error('Potenziamento non supportato');
    }
    log(c, p, 'effect_buff', `${d.name}: potenziamento +${n}.`);
  } else if (e.type === 'counter' || e.type === 'nope') {
    throw new Error('NOPE si risolve esclusivamente nella finestra reattiva');
  } else throw new Error(`${d.name}: effetto ${e.type} non implementato.`);
  checkWinner(c, 'PV esauriti dopo un effetto.');
}
function eventTrigger(e: PendingEvent): ReactionTriggerEvent | null {
  if (e.kind === 'upkeep_start') return 'opponent_upkeep_start';
  if (e.kind === 'upkeep_end') return 'opponent_upkeep_end';
  if (e.kind === 'hand_card') return 'opponent_hand_card';
  if (e.kind === 'mostrissimo_before_entry') return 'mostrissimo_before_entry';
  if (e.kind === 'monster_etb') return 'monster_etb';
  return null;
}
async function noPeAllowed(d: CardData, e: PendingEvent) {
  const tr = reactionTrigger(d);
  if (tr === 'opponent_hand_card') {
    if (e.kind !== 'hand_card') return false;
    const declared = await getCardData(e.card_id);
    return declared.card_type === 'maledizione';
  }
  return (tr === 'mostrissimo_before_entry' && e.kind === 'mostrissimo_before_entry')
    || (tr === 'monster_etb' && e.kind === 'monster_etb');
}
function legalPositions(s: GameState, p: PlayerIndex, freed: Position[]) {
  const out: Position[] = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const pos = { row, col };
    if (!at(s, pos) && (row === home(p) || (allowed(p, row) && freed.some(q => q.row === row && q.col === col)))) out.push(pos);
  }
  return out;
}
function permanents(s: GameState, p: PlayerIndex) {
  const out: { id: string; card_id: string; kind: 'creature' | 'aura' | 'terraforma'; position: Position }[] = [];
  for (const { position, cell } of cells(s)) {
    if (cell.owner_index === p) out.push({ id: cell.instance_id, card_id: cell.card_id, kind: cell.kind, position });
    if (cell.kind === 'creature') for (const aura of cell.auras) if (aura.owner_index === p)
      out.push({ id: aura.instance_id, card_id: aura.card_id, kind: 'aura', position });
  }
  return out;
}
function failSummon(c: Context, message: string) {
  delete c.s.pending_mostrissimo;
  c.s.mostrissimo_result = { outcome: 'failed', message };
  log(c, -1, 'mostrissimo_failed', message);
}
function queueOnPlay(s: GameState, p: PlayerIndex, d: CardData, sourceId: string, targetId: string | null, creature: boolean) {
  const list = effects(d.effect_json);
  const work: PendingWork[] = list.map((fx, effect_index) => creature ? {
    kind: 'declare_event', event: {
      kind: 'monster_etb', actor: p, source_instance_id: sourceId,
      card_id: d.id, effect_index,
      target_instance_id: targetId ?? (fx.type === 'heal' && fx.target === 'any_creature' && units(s, p).length === 1 ? sourceId : null),
    },
  } : {
    kind: 'resolve_effect', owner: p, card_id: d.id, source_instance_id: sourceId,
    source: 'on_play', effect_index, target_instance_id: targetId, require_source_on_board: false,
  });
  if (creature && s.pending_mostrissimo?.offered_instance_id === sourceId)
    work.push({ kind: 'finish_mostrissimo', actor: p, card_id: d.id });
  prepend(s, ...work);
}
function auraEffectsValid(d: CardData) {
  return effects(d.effect_json).length > 0 && effects(d.effect_json).every(e =>
    e.type === 'buff' && e.duration === 'while_attached' && (e.target === 'enchanted_creature' || e.target === 'all_creatures_self') && (e.stat === 'hp' || e.stat === 'attack')
    || e.type === 'draw' && e.timing === 'upkeep_start' && e.target === 'self');
}
function playableEffects(d: CardData) {
  const list = effects(d.effect_json);
  return d.card_type === 'aura' ? auraEffectsValid(d) : list.every(e => supported.has(e.type));
}
async function applyEvent(c: Context, e: PendingEvent) {
  const s = c.s, p = e.actor;
  if (s.status !== 'running') return;
  if (e.kind === 'upkeep_start') {
    s.phase = 'upkeep'; s.anti_loop_counter = 0;
    const player = s.players[p];
    player.max_mana = Math.min(6, player.max_mana + 1); player.current_mana = player.max_mana;
    for (const { cell } of units(s, p)) cell.tired = false;
    const count = draw(c, p, 1);
    log(c, p, 'upkeep', `${label(p)} ottiene ${player.current_mana}/${player.max_mana} mana e pesca ${count} carta/e.`);
    if (s.status !== 'running') return;
    const periodic: PendingWork[] = [];
    for (const host of units(s)) for (const aura of host.cell.auras) if (aura.owner_index === p) {
      const d = await getCardData(aura.card_id);
      effects(d.effect_json).forEach((fx, effect_index) => {
        if (fx.type === 'draw' && fx.timing === 'upkeep_start') periodic.push({
          kind: 'resolve_effect', owner: p, card_id: d.id, source_instance_id: aura.instance_id,
          source: 'aura_upkeep', effect_index, target_instance_id: null, require_source_on_board: true,
        });
      });
    }
    prepend(s, ...periodic, { kind: 'declare_event', event: { kind: 'upkeep_end', actor: p } });
  } else if (e.kind === 'upkeep_end') {
    s.phase = 'main';
    log(c, p, 'upkeep_end', `Termina il MANATENIMENTO di ${label(p)}.`);
    if (p === 0 && s.ai_progress?.stage === 'actions') prepend(s, { kind: 'advance_ai' });
  } else if (e.kind === 'hand_card') {
    const d = await getCardData(e.card_id);
    const paid = s.players[p].graveyard.find(x => x.instance_id === e.instance_id);
    if (!paid) return;
    if (d.card_type === 'monster' || d.card_type === 'terraforma') {
      if (!e.options.position || !valid(e.options.position) || e.options.position.row !== home(p) || at(s, e.options.position)) {
        log(c, p, 'event_cancelled', `${d.name}: cella non più libera.`); return;
      }
      s.players[p].graveyard = s.players[p].graveyard.filter(x => x.instance_id !== paid.instance_id);
      if (d.card_type === 'terraforma') put(s, e.options.position, { ...paid, kind: 'terraforma', owner_index: p });
      else {
        put(s, e.options.position, { ...paid, kind: 'creature', owner_index: p,
          attack: Number(d.attack ?? 0), hp: Number(d.hp ?? 1), max_hp: Number(d.hp ?? 1),
          tired: !keyword(d, 'iperattivo'), auras: [] });
        await reconcileAuras(c);
      }
    } else if (d.card_type === 'aura') {
      const host = e.options.targetInstanceId ? findCreature(s, e.options.targetInstanceId) : null;
      if (!host) { log(c, p, 'event_cancelled', `${d.name}: creatura non più presente.`); return; }
      s.players[p].graveyard = s.players[p].graveyard.filter(x => x.instance_id !== paid.instance_id);
      host.cell.auras.push({ ...paid, owner_index: p });
      await reconcileAuras(c);
    } else if (d.card_type !== 'maledizione') {
      log(c, p, 'event_cancelled', `${d.name}: tipo di carta non giocabile.`); return;
    }
    s.players[p].color_counters[d.faction_code] = (s.players[p].color_counters[d.faction_code] ?? 0) + 1;
    log(c, p, 'play_card', `${label(p)} gioca ${d.name}.`, { card_id: d.id, instance_id: paid.instance_id, position: e.options.position ?? null });
    if (d.card_type !== 'aura') queueOnPlay(s, p, d, paid.instance_id, e.options.targetInstanceId ?? null, d.card_type === 'monster');
  } else if (e.kind === 'move') {
    const unit = at(s, e.from);
    if (unit?.kind !== 'creature' || unit.instance_id !== e.instance_id || unit.owner_index !== p || unit.tired || !valid(e.to) || !adjacent(e.from, e.to) || !allowed(p, e.to.row) || at(s, e.to)) {
      log(c, p, 'event_cancelled', 'Movimento annullato: creatura o destinazione non più valida.'); return;
    }
    put(s, e.from, null); put(s, e.to, unit);
    log(c, p, 'move_creature', `${label(p)} muove una creatura spendendo 1 mana.`, { instance_id: unit.instance_id, from_position: e.from, to_position: e.to });
  } else if (e.kind === 'attack') {
    const attacker = at(s, e.from);
    if (attacker?.kind !== 'creature' || attacker.instance_id !== e.instance_id || attacker.owner_index !== p || attacker.tired) {
      log(c, p, 'event_cancelled', 'Attacco annullato: attaccante non disponibile.'); return;
    }
    if (e.target.type === 'creature') {
      const victim = at(s, e.target.position);
      if (victim?.kind !== 'creature' || victim.instance_id !== e.target_instance_id || victim.owner_index !== other(p) || !adjacent(e.from, e.target.position)) {
        log(c, p, 'event_cancelled', 'Attacco annullato: bersaglio non valido.'); return;
      }
      victim.hp -= attacker.attack; attacker.tired = true;
      log(c, p, 'attack_creature', `${label(p)} infligge ${attacker.attack} danno/i.`, { instance_id: attacker.instance_id, target_instance_id: victim.instance_id, position: e.from });
      if (victim.hp <= 0) await destroyCell(c, e.target.position, p);
    } else {
      if (e.target.playerIndex !== other(p) || enemyNeighbours(s, e.from, p).length) {
        log(c, p, 'event_cancelled', 'Attacco diretto annullato: bersagli validi presenti.'); return;
      }
      s.players[other(p)].life -= attacker.attack; attacker.tired = true;
      log(c, p, 'attack_player', `${label(p)} attacca direttamente: ${attacker.attack} danno/i.`, { instance_id: attacker.instance_id, target_player_index: other(p) });
      checkWinner(c, 'PV esauriti.');
    }
  } else if (e.kind === 'mostrissimo_sacrifice') {
    const pending = s.pending_mostrissimo;
    if (!pending || pending.player_index !== p || pending.stage !== 'paying' || pending.paid.length >= pending.required) return;
    const item = permanents(s, p).find(x => x.id === e.instance_id);
    if (!item) { if (permanents(s, p).length < pending.required - pending.paid.length) failSummon(c, 'Evocazione fallita: sacrifici insufficienti.'); return; }
    if (item.kind === 'aura') await removeAura(c, item.id);
    else {
      if (item.kind === 'creature') pending.freed_positions.push(item.position);
      await destroyCell(c, item.position, p, 'sacrifice');
      await reconcileAuras(c);
    }
    pending.paid.push(item.id);
    log(c, p, 'mostrissimo_sacrifice', `Sacrificio ${pending.paid.length}/${pending.required}: ${item.kind}.`, { instance_id: item.id, position: item.position });
    if (permanents(s, p).length < pending.required - pending.paid.length) failSummon(c, 'Evocazione fallita: sacrifici insufficienti.');
    else if (pending.paid.length === pending.required && !legalPositions(s, p, pending.freed_positions).length) failSummon(c, 'Evocazione fallita: nessuna cella legale.');
  } else if (e.kind === 'mostrissimo_before_entry') {
    const pending = s.pending_mostrissimo;
    const offered = s.shared_mostrissimi.find(x => x.instance_id === e.offered_instance_id);
    if (!pending || pending.stage !== 'before_entry' || pending.player_index !== p || pending.card_id !== e.card_id || pending.paid.length !== pending.required || !offered || !legalPositions(s, p, pending.freed_positions).some(q => q.row === e.position.row && q.col === e.position.col)) {
      failSummon(c, 'Evocazione fallita: costo, offerta o cella non più validi.'); return;
    }
    const d = await getCardData(e.card_id);
    s.shared_mostrissimi = s.shared_mostrissimi.filter(x => x.instance_id !== offered.instance_id);
    s.used_mostrissimi.push(d.id);
    const replacement = s.remaining_mostrissimi.shift();
    if (replacement) s.shared_mostrissimi.push({ instance_id: randomUUID(), card_id: replacement });
    put(s, e.position, { instance_id: offered.instance_id, card_id: d.id, kind: 'creature', owner_index: p,
      attack: Number(d.attack ?? 0), hp: Number(d.hp ?? 1), max_hp: Number(d.hp ?? 1), tired: !keyword(d, 'iperattivo'), auras: [] });
    await reconcileAuras(c);
    s.players[p].color_counters[d.faction_code] = (s.players[p].color_counters[d.faction_code] ?? 0) + 1;
    pending.stage = 'etb'; pending.position = e.position; pending.target_instance_id = e.target_instance_id;
    s.mostrissimo_result = { outcome: 'summoned', message: `${d.name} è stato evocato.` };
    log(c, p, 'mostrissimo_summoned', `${label(p)} evoca ${d.name}.`, { card_id: d.id, instance_id: offered.instance_id, position: e.position });
    queueOnPlay(s, p, d, offered.instance_id, e.target_instance_id, true);
    if (!effects(d.effect_json).length) delete s.pending_mostrissimo;
  } else if (e.kind === 'monster_etb') {
    if (!findCreature(s, e.source_instance_id)) { log(c, p, 'etb_source_gone', 'ETB saltato: creatura non più sul campo.'); return; }
    const d = await getCardData(e.card_id), fx = effects(d.effect_json)[e.effect_index];
    if (!fx) return;
    if (targeted(fx) && !target(s, p, fx, e.target_instance_id)) {
      log(c, p, 'etb_no_target', `${d.name}: ETB senza bersaglio valido.`); return;
    }
    prepend(s, { kind: 'resolve_effect', owner: p, card_id: e.card_id, source_instance_id: e.source_instance_id,
      source: 'on_play', effect_index: e.effect_index, target_instance_id: e.target_instance_id, require_source_on_board: true });
  }
}
async function validTraps(c: Context, e: PendingEvent) {
  const type = eventTrigger(e);
  if (!type) return [] as CardInstance[];
  const responder = other(e.actor), mana = c.s.players[responder].current_mana;
  const result: CardInstance[] = [];
  for (const inst of c.s.players[responder].hand) {
    const d = await getCardData(inst.card_id);
    if (d.card_type !== 'instant' || reactionTrigger(d) !== type || Number(d.mana_cost) > mana) continue;
    const list = effects(d.effect_json);
    if (!list.length || list.some(fx => !supported.has(fx.type) && fx.type !== 'counter' && fx.type !== 'nope')) continue;
    if (list.some(fx => fx.type === 'counter' || fx.type === 'nope') && !(await noPeAllowed(d, e))) continue;
    if (list.some(fx => targeted(fx) && !eligible(c.s, responder, fx).length)) continue;
    if (e.kind === 'monster_etb' && list.some(fx => targeted(fx) && !target(c.s, responder, fx, e.source_instance_id))) continue;
    if (e.kind === 'monster_etb' && !findCreature(c.s, e.source_instance_id)) continue;
    if (e.kind === 'mostrissimo_before_entry' && !c.s.pending_mostrissimo) continue;
    result.push(inst);
  }
  return result;
}
function aiTrapTarget(s: GameState, d: CardData) {
  const fx = effects(d.effect_json).find(targeted);
  if (!fx) return null;
  const options = eligible(s, 0, fx);
  const enemies = options.filter(x => x.cell.owner_index === 1), friends = options.filter(x => x.cell.owner_index === 0);
  if (fx.type === 'heal' || fx.type === 'buff') return friends.sort((a, b) => fx.type === 'heal' ? (b.cell.max_hp - b.cell.hp) - (a.cell.max_hp - a.cell.hp) : b.cell.attack - a.cell.attack)[0]?.cell.instance_id ?? null;
  return enemies.sort((a, b) => fx.type === 'return_hand' ? b.cell.attack - a.cell.attack : a.cell.hp - b.cell.hp)[0]?.cell.instance_id ?? null;
}
async function playTrap(c: Context, e: PendingEvent, trapId: string, targetId: string | null) {
  const p = other(e.actor), owner = c.s.players[p];
  const i = owner.hand.findIndex(x => x.instance_id === trapId);
  if (i < 0) throw new Error('Trappola non più in mano');
  const d = await getCardData(owner.hand[i].card_id), list = effects(d.effect_json);
  if (d.card_type !== 'instant' || reactionTrigger(d) !== eventTrigger(e) || owner.current_mana < d.mana_cost || !list.length)
    throw new Error('Trappola non giocabile in questa finestra');
  const chosenTarget = targetId ?? (e.kind === 'monster_etb' ? e.source_instance_id : null);
  for (const fx of list) if (targeted(fx) && !target(c.s, p, fx, chosenTarget)) throw new Error('Bersaglio della Trappola non valido');
  const nope = list.some(x => x.type === 'counter' || x.type === 'nope');
  if (nope && !(await noPeAllowed(d, e))) throw new Error('NOPE non compatibile con questo evento');
  owner.current_mana -= d.mana_cost;
  owner.graveyard.push(owner.hand.splice(i, 1)[0]);
  owner.color_counters[d.faction_code] = (owner.color_counters[d.faction_code] ?? 0) + 1;
  log(c, p, 'trap_played', `${label(p)} gioca ${d.name}.`, { card_id: d.id, instance_id: trapId });
  if (nope) {
    if (e.kind === 'mostrissimo_before_entry') failSummon(c, `NOPE! ${d.name} contrasta l’ingresso; sacrifici già pagati.`);
    log(c, p, 'event_countered', `NOPE! ${d.name} annulla ${e.kind === 'monster_etb' ? 'questo ETB' : e.kind === 'hand_card' ? 'la Maledizione dichiarata' : 'l’ingresso del Mostrissimo'}.`);
  }
  const ordinary = list.flatMap((fx, effect_index): PendingWork[] => fx.type === 'counter' || fx.type === 'nope' ? [] : [{
    kind: 'resolve_effect', owner: p, card_id: d.id, source_instance_id: trapId,
    source: 'trap', effect_index, target_instance_id: chosenTarget, require_source_on_board: false,
  }]);
  prepend(c.s, ...ordinary, ...(!nope ? [{ kind: 'apply_event', event: e } as PendingWork] : []));
}
async function declare(c: Context, e: PendingEvent) {
  if (e.kind === 'monster_etb') {
    const d = await getCardData(e.card_id), fx = effects(d.effect_json)[e.effect_index];
    if (!findCreature(c.s, e.source_instance_id) || !fx || targeted(fx) && !target(c.s, e.actor, fx, e.target_instance_id)) {
      prepend(c.s, { kind: 'apply_event', event: e }); return;
    }
  }
  const found = await validTraps(c, e);
  if (!found.length) { prepend(c.s, { kind: 'apply_event', event: e }); return; }
  if (other(e.actor) === 0) {
    const evaluated = await Promise.all(found.map(async inst => {
      const d = await getCardData(inst.card_id), t = aiTrapTarget(c.s, d);
      let score = 0;
      for (const fx of effects(d.effect_json)) {
        const n = Number(fx.amount ?? 1);
        if (fx.type === 'counter' || fx.type === 'nope') score += e.kind === 'mostrissimo_before_entry' ? 8 : e.kind === 'monster_etb' ? 5 : 4;
        else if (fx.type === 'damage' || fx.type === 'damage_creature') score += t ? n * 2 : fx.target === 'all_creatures' ? (units(c.s, 1).length - units(c.s, 0).length) * n : 0;
        else if (fx.type === 'return_hand' || fx.type === 'destroy') score += t ? 3 + (findCreature(c.s, t)?.cell.attack ?? 0) : 0;
        else if (fx.type === 'heal') score += t ? Math.min(n, (findCreature(c.s, t)?.cell.max_hp ?? 0) - (findCreature(c.s, t)?.cell.hp ?? 0)) : 0;
        else if (fx.type === 'buff') score += t ? 2 : 0;
        else if (fx.type === 'draw') score += c.s.players[0].deck.length ? n : -4;
        else if (fx.type === 'discard') score += Math.min(c.s.players[1].hand.length, n);
      }
      return { inst, t, score: score - d.mana_cost * .5 };
    }));
    evaluated.sort((a, b) => b.score - a.score);
    if (evaluated[0]?.score >= 2) { await playTrap(c, e, evaluated[0].inst.instance_id, evaluated[0].t); return; }
    prepend(c.s, { kind: 'apply_event', event: e }); return;
  }
  c.s.pending_reaction = { window_id: randomUUID(), event: e, responder_index: 1, eligible_instance_ids: found.map(x => x.instance_id) };
  log(c, 1, 'reaction_window', 'Finestra reattiva: Trappola oppure Passa.', { window_id: c.s.pending_reaction.window_id });
}
async function drain(c: Context) {
  for (let n = 0; n < 300 && c.s.status === 'running' && !c.s.pending_reaction && c.s.work_queue.length; n++) {
    const item = c.s.work_queue.shift()!;
    if (item.kind === 'declare_event') await declare(c, item.event);
    else if (item.kind === 'apply_event') await applyEvent(c, item.event);
    else if (item.kind === 'resolve_effect') await applyEffect(c, item);
    else if (item.kind === 'finish_mostrissimo') {
      if (c.s.pending_mostrissimo?.card_id === item.card_id && c.s.pending_mostrissimo.player_index === item.actor) delete c.s.pending_mostrissimo;
    } else if (item.kind === 'check_winner') checkWinner(c, item.reason);
    else if (item.kind === 'advance_ai') { c.s.anti_loop_counter = 0; await advanceAi(c); }
  }
  if (c.s.status === 'running' && !c.s.pending_reaction && c.s.work_queue.length) throw new Error('Limite di sicurezza della coda eventi raggiunto');
  if (!c.s.pending_reaction && !c.s.work_queue.length) c.s.anti_loop_counter = 0;
}
async function mutate(id: string, action: (c: Context) => Promise<void>) {
  const s = await load(id), c: Context = { id, s, logs: [] };
  if (!s.pending_reaction && !s.work_queue.length) s.anti_loop_counter = 0;
  await action(c); await drain(c);
  return commit(id, s, c.logs);
}
function assertTurn(s: GameState, p: PlayerIndex, allowMost = false) {
  if (s.status !== 'running' || s.active_player_index !== p || s.phase !== 'main') throw new Error('Azione non disponibile in questo turno');
  if (s.pending_reaction || s.work_queue.length) throw new Error('Risolvi prima la finestra reattiva');
  if (!allowMost && s.pending_mostrissimo) throw new Error('Completa prima l’evocazione del Mostrissimo');
}
function expireTemporaryBuffs(s: GameState) {
  for (const { cell } of units(s)) if (cell.temp_attack) { cell.attack -= cell.temp_attack; delete cell.temp_attack; }
}
function startTurn(c: Context, p: PlayerIndex) {
  const s = c.s;
  s.active_player_index = p; s.phase = 'upkeep'; s.anti_loop_counter = 0; s.mostrissimo_result = null;
  if (p === 1) s.current_turn++;
  prepend(s, { kind: 'declare_event', event: { kind: 'upkeep_start', actor: p } });
}
function aiChooseTarget(s: GameState, d: CardData) {
  const fx = effects(d.effect_json).find(targeted);
  if (!fx) return null;
  const options = eligible(s, 0, fx);
  return (fx.type === 'heal' || fx.type === 'buff'
    ? options.find(x => x.cell.owner_index === 0)
    : options.find(x => x.cell.owner_index === 1) ?? options[0])?.cell.instance_id ?? null;
}
async function continueAiMostrissimo(c: Context) {
  const s = c.s, pending = s.pending_mostrissimo;
  if (!pending || pending.player_index !== 0) return;
  if (pending.stage === 'paying') {
    const remaining = pending.required - pending.paid.length;
    if (remaining > 0) {
      const choices = permanents(s, 0);
      if (choices.length < remaining) { failSummon(c, 'Evocazione IA fallita: sacrifici insufficienti.'); prepend(s, { kind: 'advance_ai' }); return; }
      choices.sort((a, b) => (a.kind === 'aura' ? 0 : a.kind === 'terraforma' ? .5 : 1 + (findCreature(s, a.id)?.cell.attack ?? 0) * 2 + (findCreature(s, a.id)?.cell.hp ?? 0))
        - (b.kind === 'aura' ? 0 : b.kind === 'terraforma' ? .5 : 1 + (findCreature(s, b.id)?.cell.attack ?? 0) * 2 + (findCreature(s, b.id)?.cell.hp ?? 0)));
      const item = choices[0];
      prepend(s, { kind: 'declare_event', event: { kind: 'mostrissimo_sacrifice', actor: 0, instance_id: item.id, card_id: item.card_id } }, { kind: 'advance_ai' }); return;
    }
    const positions = legalPositions(s, 0, pending.freed_positions);
    if (!positions.length) { failSummon(c, 'Evocazione IA fallita: nessuna cella legale.'); prepend(s, { kind: 'advance_ai' }); return; }
    const pos = positions.find(x => x.row === 0) ?? positions[0], d = await getCardData(pending.card_id);
    const targetId = aiChooseTarget(s, d);
    pending.stage = 'before_entry'; pending.position = pos; pending.target_instance_id = targetId;
    log(c, 0, 'mostrissimo_position', `L’IA sceglie [${pos.row},${pos.col}] per ${d.name}.`, { position: pos, card_id: d.id });
    prepend(s, { kind: 'declare_event', event: { kind: 'mostrissimo_before_entry', actor: 0, card_id: d.id, offered_instance_id: pending.offered_instance_id, position: pos, target_instance_id: targetId } }, { kind: 'advance_ai' });
    return;
  }
  if (pending.stage === 'before_entry') return;
  delete s.pending_mostrissimo; prepend(s, { kind: 'advance_ai' });
}
async function attemptAiMostrissimo(c: Context) {
  const s = c.s;
  if (s.last_mostrissimo_turn[0] === s.current_turn || !s.shared_mostrissimi.length) return false;
  const resources = permanents(s, 0), candidates: { offered: CardInstance; card: CardData; required: number; score: number }[] = [];
  for (const offered of s.shared_mostrissimi) {
    const d = await getCardData(offered.card_id), required = Number(d.sacrifice_cost);
    if (d.card_type !== 'mostrissimo' || !Number.isInteger(required) || required < 0 || required > 6 || resources.length < required || !playableEffects(d)) continue;
    if (!legalPositions(s, 0, []).length && !units(s, 0).length) continue;
    const costs = resources.map(x => x.kind === 'creature' ? (findCreature(s, x.id)?.cell.attack ?? 0) * 2 + (findCreature(s, x.id)?.cell.hp ?? 0) : .5).sort((a, b) => a - b);
    const score = Number(d.attack ?? 0) * 2 + Number(d.hp ?? 1) - costs.slice(0, required).reduce((a, b) => a + b, 0);
    if (score > 0) candidates.push({ offered, card: d, required, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const pick = candidates[0];
  if (!pick) return false;
  s.last_mostrissimo_turn[0] = s.current_turn;
  s.pending_mostrissimo = { player_index: 0, card_id: pick.card.id, offered_instance_id: pick.offered.instance_id, required: pick.required, paid: [], freed_positions: [], stage: 'paying' };
  s.mostrissimo_result = null; s.ai_progress!.actions_taken++;
  log(c, 0, 'mostrissimo_start', `L’IA inizia l’evocazione di ${pick.card.name}: ${pick.required} sacrifici.`, { card_id: pick.card.id });
  prepend(s, { kind: 'advance_ai' }); return true;
}
async function advanceAi(c: Context) {
  const s = c.s, progress: AiProgress | undefined = s.ai_progress;
  if (s.status !== 'running' || !progress) return;
  if (progress.stage === 'upkeep') { startTurn(c, 0); progress.stage = 'actions'; return; }
  if (progress.stage === 'human_upkeep') { startTurn(c, 1); delete s.ai_progress; return; }
  if (s.active_player_index !== 0) throw new Error('Cursore IA incoerente');
  if (s.phase !== 'main') throw new Error('Avanzamento IA fuori dalla fase principale');
  if (s.pending_mostrissimo?.player_index === 0) { await continueAiMostrissimo(c); return; }
  if (progress.stage === 'end' || progress.actions_taken >= 20) {
    expireTemporaryBuffs(s); s.phase = 'end'; log(c, 0, 'turn_end', 'L’IA termina il turno.');
    progress.stage = 'human_upkeep'; prepend(s, { kind: 'advance_ai' }); return;
  }
  const ready = units(s, 0).find(x => !x.cell.tired);
  if (ready) {
    const enemies = enemyNeighbours(s, ready.position, 0), victim = enemies.length ? at(s, enemies[0]) : null;
    const event: PendingEvent = { kind: 'attack', actor: 0, instance_id: ready.cell.instance_id, from: ready.position,
      target: victim?.kind === 'creature' ? { type: 'creature', position: enemies[0] } : { type: 'player', playerIndex: 1 },
      ...(victim?.kind === 'creature' ? { target_instance_id: victim.instance_id } : {}) };
    progress.actions_taken++; prepend(s, { kind: 'declare_event', event }, { kind: 'advance_ai' }); return;
  }
  const cards = await Promise.all(s.players[0].hand.map(async inst => ({ inst, d: await getCardData(inst.card_id) })));
  for (const { inst, d } of cards) {
    if (d.card_type === 'instant' || d.card_type === 'mostrissimo' || d.mana_cost > s.players[0].current_mana || !playableEffects(d)) continue;
    const options: PlayCardOptions = {};
    if (d.card_type === 'monster' || d.card_type === 'terraforma') {
      const free = [0, 1, 2].find(col => !s.board.rows[0][col]);
      if (free === undefined) continue;
      options.position = { row: 0, col: free };
    }
    if (d.card_type === 'aura') {
      const host = units(s, 0)[0] ?? units(s, 1)[0];
      if (!host) continue;
      options.targetInstanceId = host.cell.instance_id;
    } else {
      const fx = effects(d.effect_json).find(targeted);
      if (fx) {
        const t = aiChooseTarget(s, d);
        if (t) options.targetInstanceId = t;
        else if (!(d.card_type === 'monster' && fx.type === 'heal' && fx.target === 'any_creature')) continue;
      }
    }
    s.players[0].hand = s.players[0].hand.filter(x => x.instance_id !== inst.instance_id);
    s.players[0].graveyard.push(inst); s.players[0].current_mana -= d.mana_cost;
    log(c, 0, 'card_declared', `L’IA dichiara ${d.name} pagando ${d.mana_cost} mana.`, { card_id: d.id, instance_id: inst.instance_id });
    progress.actions_taken++;
    prepend(s, { kind: 'declare_event', event: { kind: 'hand_card', actor: 0, instance_id: inst.instance_id, card_id: d.id, options, paid_mana: d.mana_cost } }, { kind: 'advance_ai' }); return;
  }
  if (await attemptAiMostrissimo(c)) return;
  const mover = units(s, 0).find(x => !x.cell.tired && s.players[0].current_mana >= 1 && around(x.position).some(q => allowed(0, q.row) && !at(s, q) && enemyNeighbours(s, q, 0).length));
  if (mover) {
    const to = around(mover.position).find(q => allowed(0, q.row) && !at(s, q) && enemyNeighbours(s, q, 0).length)!;
    s.players[0].current_mana--; progress.actions_taken++;
    prepend(s, { kind: 'declare_event', event: { kind: 'move', actor: 0, instance_id: mover.cell.instance_id, from: mover.position, to, paid_mana: 1 } }, { kind: 'advance_ai' }); return;
  }
  progress.stage = 'end'; prepend(s, { kind: 'advance_ai' });
}

async function deck(): Promise<CardInstance[]> {
  const { data, error } = await db.from('cards').select('id,card_type,mana_cost,is_boss,effect_json').in('card_type', ['monster', 'instant', 'aura', 'terraforma', 'maledizione']);
  if (error || !data) throw new Error(`Catalogo non disponibile: ${error?.message ?? 'nessun risultato'}`);
  const pool = data.map(x => ({ id: String(x.id), cost: Number(x.mana_cost), boss: Boolean(x.is_boss), type: String(x.card_type), raw: x.effect_json as CardEffectJson | null }));
  const playable = pool.filter(x => {
    const list = effects(x.raw);
    if (x.type === 'aura') return list.length > 0 && list.every(e =>
      (e.type === 'buff' && e.duration === 'while_attached' && (e.target === 'enchanted_creature' || e.target === 'all_creatures_self') && (e.stat === 'hp' || e.stat === 'attack'))
      || (e.type === 'draw' && e.timing === 'upkeep_start' && e.target === 'self'));
    if (x.type === 'instant') return list.length > 0 && !!x.raw?.reaction_trigger && list.every(e => supported.has(e.type) || e.type === 'counter' || e.type === 'nope');
    return list.every(e => supported.has(e.type));
  });
  const monsters = playable.filter(x => x.type === 'monster');
  const low = monsters.filter(x => x.cost <= 2), mid = monsters.filter(x => x.cost >= 2 && x.cost <= 4), high = monsters.filter(x => x.cost >= 5);
  const instants = playable.filter(x => x.type === 'instant' && effects(x.raw).length);
  if (!low.length || !mid.length || !high.length || !instants.length) throw new Error('Catalogo insufficiente per la curva mana 2,5–4');
  const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
  for (let attempt = 0; attempt < 500; attempt++) {
    const bosses = high.filter(x => x.boss);
    const chosen = [pick(bosses.length ? bosses : high), pick(low), pick(low), pick(mid), pick(mid), pick(mid), pick(instants), pick(instants)];
    while (chosen.length < 10) chosen.push(pick(playable));
    const avg = chosen.reduce((sum, x) => sum + x.cost, 0) / 10;
    if (avg >= 2.5 && avg <= 4) return shuffle(chosen.map(x => ({ instance_id: randomUUID(), card_id: x.id })));
  }
  throw new Error('Impossibile generare un mazzo con curva mana 2,5–4');
}
async function offer() {
  const { data, error } = await db.from('cards').select('id').eq('card_type', 'mostrissimo');
  if (error || !data) throw new Error(`Catalogo Mostrissimi non disponibile: ${error?.message ?? 'nessun risultato'}`);
  const ids = shuffle(data.map(x => String(x.id)));
  if (!ids.length) throw new Error('Il catalogo non contiene Mostrissimi');
  return { shared: ids.slice(0, 3).map(card_id => ({ card_id, instance_id: randomUUID() })), remaining: ids.slice(3) };
}
function player(index: PlayerIndex, userId: string | null, deckCards: CardInstance[]): PlayerState {
  return { player_index: index, user_id: userId, life: 20, max_mana: 0, current_mana: 0, deck: deckCards, hand: [], graveyard: [], extra_deck: [], color_counters: { CHI: 0, INF: 0, PES: 0, BUL: 0, GRO: 0, CLO: 0, IND: 0 } };
}
export async function createNewMatch(userId: string): Promise<{ matchId: string; state: GameState }> {
  const [aiCards, humanCards, catalogue] = await Promise.all([deck(), deck(), offer()]);
  const { data, error } = await db.from('matches').insert({ player_id: userId, opponent_type: 'ai', opponent_name: 'IA Bellum Penumbrum', player_won: null, turns_count: 0, duration_seconds: 0 }).select('id').single();
  if (error || !data) throw new Error(`Creazione partita: ${error?.message ?? 'nessun ID'}`);
  const matchId = String(data.id), ai = player(0, null, aiCards), human = player(1, userId, humanCards);
  for (let i = 0; i < 4; i++) ai.hand.push(ai.deck.shift()!);
  for (let i = 0; i < 3; i++) human.hand.push(human.deck.shift()!);
  human.max_mana = human.current_mana = 1;
  const state: GameState = { state_version: 4, state_revision: 0, match_id: matchId, status: 'running', players: [ai, human], board: blank(), current_turn: 1, active_player_index: 1, phase: 'main', anti_loop_counter: 0, winner_index: null, shared_mostrissimi: catalogue.shared, remaining_mostrissimi: catalogue.remaining, used_mostrissimi: [], work_queue: [], last_mostrissimo_turn: {}, mostrissimo_result: null };
  const inserted = await db.from('game_state').insert({ match_id: matchId, state_json: state, revision: 0, current_turn: 1, current_phase: phaseNumber(state.phase), last_updated: new Date().toISOString() });
  if (inserted.error) throw new Error(`Creazione stato: ${inserted.error.message}`);
  await logMatchAction(matchId, { turn: 1, phase: 'main', player_index: -1, action_type: 'match_create', description: 'Partita iniziata: tu hai 3 carte e 1 mana; l’IA ha 4 carte.' });
  return { matchId, state };
}
export async function getMatchState(id: string): Promise<GameState> { return load(id); }
export async function playCard(id: string, p: PlayerIndex, cardInstanceId: string, options: PlayCardOptions = {}): Promise<GameState> {
  return mutate(id, async c => {
    const s = c.s; assertTurn(s, p);
    const owner = s.players[p], inst = owner.hand.find(x => x.instance_id === cardInstanceId);
    if (!inst) throw new Error('Carta non presente nella mano');
    const d = await getCardData(inst.card_id);
    if (d.card_type === 'mostrissimo' || d.card_type === 'instant') throw new Error('Questa carta non si gioca dalla mano nella fase principale');
    if (owner.current_mana < d.mana_cost) throw new Error('Mana insufficiente');
    if ((d.card_type === 'monster' || d.card_type === 'terraforma') && (!options.position || !valid(options.position) || options.position.row !== home(p) || at(s, options.position))) throw new Error('Scegli una cella libera della tua riga');
    if (d.card_type === 'aura' && (!options.targetInstanceId || !findCreature(s, options.targetInstanceId))) throw new Error('Seleziona una creatura alleata o nemica per l’Aura');
    if (!playableEffects(d)) throw new Error('Effetto carta non ancora supportato');
    if (d.card_type !== 'aura') for (const fx of effects(d.effect_json).filter(targeted)) {
      if (options.targetInstanceId && !target(s, p, fx, options.targetInstanceId)) throw new Error('Bersaglio non valido');
      if (!options.targetInstanceId && eligible(s, p, fx).length && !(d.card_type === 'monster' && fx.type === 'heal' && units(s, p).length === 0)) throw new Error('Seleziona una creatura bersaglio');
      if (!options.targetInstanceId && d.card_type !== 'monster') throw new Error('Questa carta richiede un bersaglio');
    }
    owner.hand = owner.hand.filter(x => x.instance_id !== inst.instance_id);
    owner.graveyard.push(inst); owner.current_mana -= d.mana_cost;
    log(c, p, 'card_declared', `${label(p)} dichiara ${d.name} e paga ${d.mana_cost} mana.`, { card_id: d.id, instance_id: inst.instance_id });
    prepend(s, { kind: 'declare_event', event: { kind: 'hand_card', actor: p, instance_id: inst.instance_id, card_id: d.id, options, paid_mana: d.mana_cost } });
  });
}
export async function moveCreature(id: string, p: PlayerIndex, from: Position, to: Position): Promise<GameState> {
  return mutate(id, async c => {
    const s = c.s; assertTurn(s, p);
    if (!valid(from) || !valid(to) || !adjacent(from, to) || !allowed(p, to.row)) throw new Error('Movimento non valido');
    const cell = at(s, from);
    if (cell?.kind !== 'creature' || cell.owner_index !== p || cell.tired || at(s, to)) throw new Error('Creatura stanca, non tua o destinazione occupata');
    if (s.players[p].current_mana < 1) throw new Error('Serve 1 mana per Muovi');
    s.players[p].current_mana--;
    prepend(s, { kind: 'declare_event', event: { kind: 'move', actor: p, instance_id: cell.instance_id, from, to, paid_mana: 1 } });
  });
}
export async function attack(id: string, p: PlayerIndex, from: Position, targetPosition: AttackTarget): Promise<GameState> {
  return mutate(id, async c => {
    const s = c.s; assertTurn(s, p);
    if (!valid(from)) throw new Error('Attaccante non valido');
    const attacker = at(s, from);
    if (attacker?.kind !== 'creature' || attacker.owner_index !== p || attacker.tired) throw new Error('Creatura non tua oppure stanca');
    const options = enemyNeighbours(s, from, p);
    let victim: CreatureCell | null = null;
    if (targetPosition.type === 'creature') {
      if (!valid(targetPosition.position) || !options.some(q => q.row === targetPosition.position.row && q.col === targetPosition.position.col)) throw new Error('Bersaglio non ortogonalmente adiacente');
      const chosen = at(s, targetPosition.position);
      if (chosen?.kind !== 'creature') throw new Error('Solo le creature possono essere attaccate');
      victim = chosen;
    } else if (targetPosition.playerIndex !== other(p) || options.length) throw new Error('Attacco diretto vietato');
    prepend(s, { kind: 'declare_event', event: { kind: 'attack', actor: p, instance_id: attacker.instance_id, from, target: targetPosition, ...(victim ? { target_instance_id: victim.instance_id } : {}) } });
  });
}
export async function startMostrissimoSummon(id: string, p: PlayerIndex, cardId: string): Promise<GameState> {
  return mutate(id, async c => {
    const s = c.s; assertTurn(s, p);
    if (s.last_mostrissimo_turn[p] === s.current_turn) throw new Error('Hai già tentato un Mostrissimo in questo turno');
    const offered = s.shared_mostrissimi.find(x => x.card_id === cardId);
    if (!offered) throw new Error('Mostrissimo non presente nell’offerta');
    const d = await getCardData(cardId), required = Number(d.sacrifice_cost);
    if (d.card_type !== 'mostrissimo' || !Number.isInteger(required) || required < 0 || required > 6) throw new Error('Costo in sacrifici non valido');
    if (permanents(s, p).length < required) throw new Error('Non hai abbastanza permanenti');
    if (!legalPositions(s, p, []).length && !units(s, p).length) throw new Error('Nessuna cella legale');
    s.last_mostrissimo_turn[p] = s.current_turn;
    s.pending_mostrissimo = { player_index: p, card_id: d.id, offered_instance_id: offered.instance_id, required, paid: [], freed_positions: [], stage: 'paying' };
    s.mostrissimo_result = null;
    log(c, p, 'mostrissimo_start', `${label(p)} inizia l’evocazione di ${d.name}: ${required} sacrifici.`, { card_id: d.id });
  });
}
export async function payMostrissimoSacrifice(id: string, p: PlayerIndex, instanceId: string): Promise<GameState> {
  return mutate(id, async c => {
    const s = c.s; assertTurn(s, p, true);
    const pending = s.pending_mostrissimo;
    if (!pending || pending.player_index !== p || pending.stage !== 'paying' || pending.paid.length >= pending.required) throw new Error('Nessun sacrificio richiesto');
    const chosen = permanents(s, p).find(x => x.id === instanceId);
    if (!chosen) throw new Error('Permanente non tuo o non più presente');
    prepend(s, { kind: 'declare_event', event: { kind: 'mostrissimo_sacrifice', actor: p, instance_id: instanceId, card_id: chosen.card_id } });
  });
}
export async function completeMostrissimoSummon(id: string, p: PlayerIndex, position: Position, targetId: string | null): Promise<GameState> {
  return mutate(id, async c => {
    const s = c.s; assertTurn(s, p, true);
    const pending = s.pending_mostrissimo;
    if (!pending || pending.player_index !== p || pending.stage !== 'paying') throw new Error('Nessuna evocazione in corso');
    if (pending.paid.length !== pending.required) throw new Error('Prima completa tutti i sacrifici');
    if (!valid(position) || !legalPositions(s, p, pending.freed_positions).some(q => q.row === position.row && q.col === position.col)) throw new Error('Cella di evocazione non legale');
    const d = await getCardData(pending.card_id);
    if (!playableEffects(d)) throw new Error('Effetto del Mostrissimo non supportato');
    if (targetId && !effects(d.effect_json).some(fx => targeted(fx) && target(s, p, fx, targetId))) throw new Error('Bersaglio non valido');
    pending.stage = 'before_entry'; pending.position = position; pending.target_instance_id = targetId;
    prepend(s, { kind: 'declare_event', event: { kind: 'mostrissimo_before_entry', actor: p, card_id: d.id, offered_instance_id: pending.offered_instance_id, position, target_instance_id: targetId } });
  });
}
export async function resolveTrapChoice(id: string, p: PlayerIndex, choice: TrapChoice): Promise<GameState> {
  return mutate(id, async c => {
    const s = c.s, window = s.pending_reaction;
    if (!window || window.window_id !== choice.window_id || window.responder_index !== p || s.status !== 'running') throw new Error('Finestra reattiva scaduta o non tua');
    delete s.pending_reaction;
    if (choice.action === 'pass') {
      log(c, p, 'trap_pass', `${label(p)} passa.`, { window_id: window.window_id });
      prepend(s, { kind: 'apply_event', event: window.event });
    } else {
      if (!window.eligible_instance_ids.includes(choice.card_instance_id)) throw new Error('Trappola non disponibile in questa finestra');
      await playTrap(c, window.event, choice.card_instance_id, choice.target_instance_id ?? null);
    }
  });
}
export async function endHumanTurn(id: string): Promise<GameState> {
  return mutate(id, async c => {
    const s = c.s; assertTurn(s, 1);
    expireTemporaryBuffs(s); s.phase = 'end'; log(c, 1, 'turn_end', 'Termini il turno.');
    s.ai_progress = { stage: 'upkeep', actions_taken: 0 };
    prepend(s, { kind: 'advance_ai' });
  });
}