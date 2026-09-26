import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type {
  AiProgress, AttackTarget, BoardCell, CardData, CardEffectJson, CardInstance,
  EffectDefinition, GameState, MatchLogEntry, PendingEvent, PendingWork,
  PlayerIndex, PlayerState, PlayCardOptions, Position, ReactionTriggerEvent,
  TrapChoice, TurnPhase,
} from './types.js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
const db = createClient(url, key);
const other = (p: PlayerIndex): PlayerIndex => p === 0 ? 1 : 0;
const label = (p: PlayerIndex) => p === 1 ? 'Tu' : 'L’IA';
const valid = (p: Position) => Number.isInteger(p.row) && Number.isInteger(p.col) && p.row >= 0 && p.row < 3 && p.col >= 0 && p.col < 3;
const adjacent = (a: Position, b: Position) => Math.abs(a.row - b.row) + Math.abs(a.col - b.col) === 1;
const around = (p: Position): Position[] => [{ row: p.row - 1, col: p.col }, { row: p.row + 1, col: p.col }, { row: p.row, col: p.col - 1 }, { row: p.row, col: p.col + 1 }].filter(valid);
const home = (p: PlayerIndex) => p === 0 ? 0 : 2;
const allowed = (p: PlayerIndex, row: number) => row !== home(other(p));
const phaseNumber = (p: TurnPhase) => ({ start: 0, upkeep: 1, main: 2, end: 3 })[p];
const blank = (): GameState['board'] => ({ rows: [[null, null, null], [null, null, null], [null, null, null]] });
const at = (s: GameState, p: Position) => valid(p) ? s.board.rows[p.row][p.col] : null;
const put = (s: GameState, p: Position, c: BoardCell | null) => { s.board.rows[p.row][p.col] = c; };
const instance = (c: BoardCell): CardInstance => ({ instance_id: c.instance_id, card_id: c.card_id });
const effects = (raw: CardEffectJson | null): EffectDefinition[] => raw && 'effects' in raw && Array.isArray(raw.effects) ? raw.effects : raw && 'type' in raw ? [raw] : [];
const trigger = (card: CardData) => card.effect_json?.reaction_trigger?.event;
const keyword = (card: CardData, name: string) => {
  const c = card as CardData & { keywords?: unknown; keyword_json?: unknown };
  return [c.keywords, c.keyword_json].some(x => Array.isArray(x) && x.some(v => String(v).toLowerCase() === name));
};
function shuffle<T>(values: T[]): T[] {
  const a = [...values];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function units(s: GameState, owner: PlayerIndex) {
  const result: { position: Position; cell: BoardCell }[] = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const cell = s.board.rows[row][col];
    if (cell?.owner_index === owner) result.push({ position: { row, col }, cell });
  }
  return result;
}
const enemies = (s: GameState, p: Position, owner: PlayerIndex) => around(p).filter(q => at(s, q)?.owner_index === other(owner));
function find(s: GameState, id: string) {
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const cell = s.board.rows[row][col];
    if (cell?.instance_id === id) return { position: { row, col }, cell };
  }
  return null;
}
function eligible(s: GameState, owner: PlayerIndex, effect: EffectDefinition) {
  if ((effect.type === 'damage' || effect.type === 'damage_creature') && effect.timing !== 'instant') return units(s, other(owner));
  if (effect.type === 'heal' && effect.timing !== 'instant') return units(s, owner);
  return [...units(s, 0), ...units(s, 1)];
}
function target(s: GameState, owner: PlayerIndex, effect: EffectDefinition, id: string | null) {
  const found = id ? find(s, id) : null;
  return found && eligible(s, owner, effect).some(x => x.cell.instance_id === id) ? found : null;
}
function prepend(s: GameState, ...steps: PendingWork[]) { s.work_queue.unshift(...steps); }
async function load(id: string): Promise<GameState> {
  const { data, error } = await db.from('game_state').select('state_json,revision').eq('match_id', id).single();
  if (error || !data) throw new Error(`Stato partita non trovato: ${error?.message ?? id}`);
  const s = data.state_json as GameState;
  if (s.state_version !== 3 || !s.board?.rows || !Array.isArray(s.work_queue)) throw new Error('Partita precedente non compatibile: avvia una nuova partita.');
  if (Number(data.revision) !== s.state_revision) throw new Error('Revisione dello stato non coerente');
  return s;
}
async function commit(id: string, s: GameState, logs: MatchLogEntry[]): Promise<GameState> {
  const { data, error } = await db.rpc('commit_match_state', {
    p_match_id: id, p_expected_revision: s.state_revision,
    p_next_state: s, p_log_entries: logs,
  });
  if (error) throw new Error(`Salvataggio partita: ${error.message}`);
  return data as GameState;
}
export async function saveGameState(id: string, s: GameState): Promise<GameState> { return commit(id, s, []); }
// Compatibilita' con l'interfaccia precedente; le azioni usano SOLO commit().
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
function log(c: Context, owner: number, action: string, description: string, extra: Partial<MatchLogEntry> = {}) {
  c.logs.push({ turn: c.s.current_turn, phase: c.s.phase, player_index: owner, action_type: action, description, ...extra });
}
function won(s: GameState): PlayerIndex | null {
  if (s.players[0].life <= 0) return 1;
  if (s.players[1].life <= 0) return 0;
  return null;
}
function checkWinner(c: Context, reason: string) {
  const winner = won(c.s);
  if (winner === null || c.s.status === 'finished') return;
  c.s.status = 'finished'; c.s.phase = 'end'; c.s.winner_index = winner;
  c.s.pending_reaction = undefined; c.s.work_queue = []; delete c.s.ai_progress;
  log(c, winner, 'match_end', `${winner === 1 ? 'Hai vinto' : 'L’IA ha vinto'}. ${reason}`);
}
function draw(c: Context, recipient: PlayerIndex, amount: number) {
  let count = 0;
  for (let n = 0; n < amount; n++) {
    const card = c.s.players[recipient].deck.shift();
    if (card) { c.s.players[recipient].hand.push(card); count++; }
    else {
      c.s.players[recipient].life -= 2;
      log(c, recipient, 'empty_draw_damage', `${label(recipient)} subisce 2 danni per una pesca a mazzo vuoto.`, { amount: 2 });
      checkWinner(c, 'PV esauriti dopo una pesca impossibile.');
      if (c.s.status === 'finished') break;
    }
  }
  return count;
}
function cleanupLoop(c: Context) {
  for (const owner of [0, 1] as const) for (const { position, cell } of units(c.s, owner)) {
    c.s.players[owner].graveyard.push(instance(cell), ...cell.auras); put(c.s, position, null);
  }
  for (const p of c.s.players) { if (p.field_spell) p.graveyard.push(p.field_spell); p.field_spell = null; }
  c.s.work_queue = c.s.work_queue.filter(step => step.kind !== 'resolve_effect');
  c.s.anti_loop_counter = 0;
  log(c, -1, 'anti_loop_cleanup', 'La Penombra divora ogni cosa: venti trigger consecutivi, plancia svuotata.');
}
async function destroy(c: Context, position: Position, killer: PlayerIndex) {
  const cell = at(c.s, position);
  if (!cell) return;
  put(c.s, position, null);
  c.s.players[cell.owner_index].graveyard.push(instance(cell), ...cell.auras);
  const card = await getCardData(cell.card_id);
  log(c, cell.owner_index, 'creature_destroyed', `${card.name} viene distrutto.`, { card_id: card.id, instance_id: cell.instance_id, position });
  const steps: PendingWork[] = effects(card.effect_on_death_json).map((_, effect_index) => ({
    kind: 'resolve_effect', owner: cell.owner_index, card_id: card.id,
    source_instance_id: cell.instance_id, source: 'on_death', effect_index,
    target_instance_id: null, require_source_on_board: false,
  }));
  prepend(c.s, ...steps);
  void killer;
}
async function applyEffect(c: Context, task: Extract<PendingWork, { kind: 'resolve_effect' }>) {
  const s = c.s;
  if (task.require_source_on_board && (!task.source_instance_id || !find(s, task.source_instance_id))) {
    log(c, task.owner, 'etb_source_gone', 'L’effetto ETB non si risolve: la creatura non è più sul campo.');
    return;
  }
  const card = await getCardData(task.card_id);
  const list = effects(task.source === 'on_death' ? card.effect_on_death_json : card.effect_json);
  const effect = list[task.effect_index];
  if (!effect) return;
  s.anti_loop_counter++;
  if (s.anti_loop_counter > 20) { cleanupLoop(c); return; }
  const owner = task.owner, opponent = other(owner), amount = Number(effect.amount ?? 1);
  if (!Number.isInteger(amount) || amount < 0 || amount > 20) throw new Error('Quantità effetto non valida');
  const chosen = effect.target === 'any_creature' || effect.type === 'return_hand'
    ? target(s, owner, effect, task.target_instance_id) : null;
  if ((effect.target === 'any_creature' || effect.type === 'return_hand') && !chosen) {
    log(c, owner, 'effect_no_target', `${card.name}: bersaglio non più valido, effetto annullato.`, { card_id: card.id });
    return;
  }
  if (effect.type === 'draw') {
    const recipient = effect.target === 'opponent' ? opponent : owner;
    const count = draw(c, recipient, amount);
    log(c, owner, 'effect_draw', `${card.name}: ${label(recipient)} pesca ${count} carta/e.`, { amount: count });
  } else if (effect.type === 'discard') {
    const recipient = effect.target === 'self' ? owner : opponent;
    let count = 0;
    while (count < amount && s.players[recipient].hand.length) {
      const i = Math.floor(Math.random() * s.players[recipient].hand.length);
      s.players[recipient].graveyard.push(s.players[recipient].hand.splice(i, 1)[0]); count++;
    }
    log(c, owner, 'effect_discard', `${card.name}: ${label(recipient)} scarta ${count} carta/e.`);
  } else if (effect.type === 'heal') {
    if (effect.target === 'any_creature') chosen!.cell.hp = Math.min(chosen!.cell.max_hp, chosen!.cell.hp + amount);
    else if (effect.target?.startsWith('all_creatures')) {
      const owners = effect.target === 'all_creatures' ? [0, 1] as const : [effect.target === 'all_creatures_opponent' ? opponent : owner];
      for (const p of owners) for (const { cell } of units(s, p)) cell.hp = Math.min(cell.max_hp, cell.hp + amount);
    } else s.players[effect.target === 'opponent' ? opponent : owner].life += amount;
    log(c, owner, 'effect_heal', `${card.name}: cura ${amount}.`);
  } else if (effect.type === 'damage' || effect.type === 'damage_creature') {
    if (effect.target === 'all_creatures' || effect.target === 'all_creatures_self' || effect.target === 'all_creatures_opponent') {
      const owners = effect.target === 'all_creatures' ? [0, 1] as const : [effect.target === 'all_creatures_self' ? owner : opponent];
      const snapshot = owners.flatMap(p => units(s, p));
      for (const { cell } of snapshot) cell.hp -= amount;
      log(c, owner, 'effect_damage_all', `${card.name}: ${amount} danno/i alle creature.`);
      for (const { position, cell } of snapshot) if (at(s, position)?.instance_id === cell.instance_id && cell.hp <= 0) await destroy(c, position, owner);
    } else if (chosen) {
      chosen.cell.hp -= amount;
      log(c, owner, 'effect_damage', `${card.name}: ${amount} danno/i a una creatura.`, { target_instance_id: chosen.cell.instance_id });
      if (chosen.cell.hp <= 0) await destroy(c, chosen.position, owner);
    } else throw new Error('Effetto danno senza bersaglio supportato');
  } else if (effect.type === 'return_hand') {
    const { cell, position } = chosen!;
    put(s, position, null); s.players[cell.owner_index].hand.push(instance(cell));
    s.players[cell.owner_index].graveyard.push(...cell.auras);
    log(c, owner, 'effect_return_hand', `${card.name}: una creatura torna in mano.`, { target_instance_id: cell.instance_id });
  } else if (effect.type === 'buff') {
    const targets = effect.target === 'all_creatures' ? units(s, owner).map(x => x.cell) : chosen ? [chosen.cell] : [];
    for (const cell of targets) {
      if (effect.stat === 'hp' && effect.duration === 'permanent') { cell.max_hp += amount; cell.hp += amount; }
      else if (effect.stat === 'attack' && (effect.duration === 'turn' || effect.duration === 'permanent')) {
        cell.attack += amount;
        if (effect.duration === 'turn') cell.temp_attack = (cell.temp_attack ?? 0) + amount;
      } else throw new Error('Potenziamento non supportato');
    }
    log(c, owner, 'effect_buff', `${card.name}: potenziamento +${amount}.`);
  } else if (effect.type === 'counter') {
    throw new Error('Contromagia si risolve solo nella finestra reattiva');
  } else throw new Error(`${card.name}: effetto ${effect.type} non ancora implementato.`);
  checkWinner(c, 'PV esauriti dopo un effetto.');
}
function eventTrigger(event: PendingEvent): ReactionTriggerEvent {
  if (event.kind === 'hand_card') return 'opponent_hand_card';
  if (event.kind === 'mostrissimo_before_entry') return 'mostrissimo_before_entry';
  if (event.kind === 'monster_etb') return 'monster_etb';
  return 'opponent_action';
}
function matchesTrigger(t: ReactionTriggerEvent | undefined, event: PendingEvent) {
  return t === 'opponent_action' || t === eventTrigger(event);
}
function legalPositions(s: GameState, p: PlayerIndex, freed: Position[]): Position[] {
  const positions: Position[] = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const pos = { row, col };
    if (!at(s, pos) && (row === home(p) || (allowed(p, row) && freed.some(q => q.row === row && q.col === col)))) positions.push(pos);
  }
  return positions;
}
function permanents(s: GameState, p: PlayerIndex) {
  const list: { id: string; card_id: string; kind: 'creature' | 'aura' | 'field'; position?: Position }[] = [];
  for (const { position, cell } of units(s, p)) {
    list.push({ id: cell.instance_id, card_id: cell.card_id, kind: 'creature', position });
    for (const aura of cell.auras) list.push({ id: aura.instance_id, card_id: aura.card_id, kind: 'aura', position });
  }
  const field = s.players[p].field_spell;
  if (field) list.push({ id: field.instance_id, card_id: field.card_id, kind: 'field' });
  return list;
}
function failSummon(c: Context, message: string) {
  delete c.s.pending_mostrissimo;
  c.s.mostrissimo_result = { outcome: 'failed', message };
  log(c, -1, 'mostrissimo_failed', message);
}
function queueOnPlay(s: GameState, owner: PlayerIndex, card: CardData, sourceId: string, targetId: string | null, creature: boolean) {
  const list = effects(card.effect_json);
  const steps: PendingWork[] = list.map((effect, effect_index) => creature ? {
    kind: 'declare_event', event: {
      kind: 'monster_etb', actor: owner, source_instance_id: sourceId,
      card_id: card.id, effect_index, target_instance_id: targetId ?? (effect.type === 'heal' && effect.target === 'any_creature' && units(s, owner).length === 1 ? sourceId : null),
    },
  } : {
    kind: 'resolve_effect', owner, card_id: card.id, source_instance_id: sourceId,
    source: 'on_play', effect_index, target_instance_id: targetId,
    require_source_on_board: false,
  });
  if (creature && s.pending_mostrissimo?.offered_instance_id === sourceId) steps.push({ kind: 'finish_mostrissimo', actor: owner, card_id: card.id });
  prepend(s, ...steps);
}
async function applyEvent(c: Context, e: PendingEvent) {
  const s = c.s, p = e.actor;
  if (s.status !== 'running') return;
  if (e.kind === 'hand_card') {
    const card = await getCardData(e.card_id);
    const paid = s.players[p].graveyard.find(x => x.instance_id === e.instance_id);
    if (!paid) { log(c, p, 'event_cancelled', `${card.name}: carta dichiarata non più disponibile.`); return; }
    if (card.card_type === 'monster') {
      if (!e.options.position || !valid(e.options.position) || e.options.position.row !== home(p) || at(s, e.options.position)) {
        log(c, p, 'event_cancelled', `${card.name}: cella di evocazione non più libera.`); return;
      }
      s.players[p].graveyard = s.players[p].graveyard.filter(x => x.instance_id !== paid.instance_id);
      put(s, e.options.position, { instance_id: paid.instance_id, card_id: paid.card_id, owner_index: p, attack: Number(card.attack ?? 0), hp: Number(card.hp ?? 1), max_hp: Number(card.hp ?? 1), tired: !keyword(card, 'iperattivo'), auras: [] });
    } else if (card.card_type === 'terraforma') {
      if (s.players[p].field_spell) { log(c, p, 'event_cancelled', `${card.name}: Terraforma già attiva.`); return; }
      s.players[p].graveyard = s.players[p].graveyard.filter(x => x.instance_id !== paid.instance_id);
      s.players[p].field_spell = paid;
    } else if (card.card_type === 'aura') {
      const selected = e.options.targetInstanceId ? find(s, e.options.targetInstanceId) : null;
      if (!selected || selected.cell.owner_index !== p) { log(c, p, 'event_cancelled', `${card.name}: bersaglio Aura non più valido.`); return; }
      s.players[p].graveyard = s.players[p].graveyard.filter(x => x.instance_id !== paid.instance_id);
      selected.cell.auras.push(paid);
    } else if (card.card_type !== 'sorcery') {
      log(c, p, 'event_cancelled', `${card.name}: tipo di carta non giocabile in questa fase.`);
      return;
    }
    s.players[p].color_counters[card.faction_code] = (s.players[p].color_counters[card.faction_code] ?? 0) + 1;
    log(c, p, 'play_card', `${label(p)} ${p === 1 ? 'giochi' : 'gioca'} ${card.name}.`, { card_id: card.id, instance_id: paid.instance_id, position: e.options.position ?? null });
    queueOnPlay(s, p, card, paid.instance_id, e.options.targetInstanceId ?? null, card.card_type === 'monster');
  } else if (e.kind === 'move') {
    const creature = at(s, e.from);
    if (!creature || creature.instance_id !== e.instance_id || creature.owner_index !== p || creature.tired || !valid(e.to) || !adjacent(e.from, e.to) || !allowed(p, e.to.row) || at(s, e.to)) {
      log(c, p, 'event_cancelled', 'Movimento annullato: creatura o destinazione non più valida.'); return;
    }
    put(s, e.from, null); put(s, e.to, creature);
    log(c, p, 'move_creature', `${label(p)} muove una creatura spendendo 1 mana. Rimane pronta.`, { instance_id: creature.instance_id, from_position: e.from, to_position: e.to });
  } else if (e.kind === 'attack') {
    const attacker = at(s, e.from);
    if (!attacker || attacker.instance_id !== e.instance_id || attacker.owner_index !== p || attacker.tired) {
      log(c, p, 'event_cancelled', 'Attacco annullato: attaccante non più valido.'); return;
    }
    if (e.target.type === 'creature') {
      const victim = at(s, e.target.position);
      if (!victim || victim.instance_id !== e.target_instance_id || victim.owner_index !== other(p) || !adjacent(e.from, e.target.position)) {
        log(c, p, 'event_cancelled', 'Attacco annullato: bersaglio non più valido.'); return;
      }
      victim.hp -= attacker.attack; attacker.tired = true;
      log(c, p, 'attack_creature', `${label(p)} attacca: ${attacker.attack} danno/i a una creatura.`, { instance_id: attacker.instance_id, target_instance_id: victim.instance_id, position: e.from });
      if (victim.hp <= 0) await destroy(c, e.target.position, p);
    } else {
      if (e.target.playerIndex !== other(p) || enemies(s, e.from, p).length) {
        log(c, p, 'event_cancelled', 'Attacco diretto annullato: ci sono bersagli validi.'); return;
      }
      s.players[other(p)].life -= attacker.attack; attacker.tired = true;
      log(c, p, 'attack_player', `${label(p)} attacca direttamente: ${attacker.attack} danno/i.`, { instance_id: attacker.instance_id, position: e.from, target_player_index: other(p) });
      checkWinner(c, 'PV esauriti.');
    }
  } else if (e.kind === 'mostrissimo_sacrifice') {
    const pending = s.pending_mostrissimo;
    if (!pending || pending.player_index !== p || pending.stage !== 'paying' || pending.paid.length >= pending.required) return;
    const selected = permanents(s, p).find(x => x.id === e.instance_id);
    if (!selected) { if (permanents(s, p).length < pending.required - pending.paid.length) failSummon(c, 'Evocazione fallita: sacrifici insufficienti.'); return; }
    if (selected.kind === 'field') { const field = s.players[p].field_spell!; s.players[p].field_spell = null; s.players[p].graveyard.push(field); }
    else if (selected.kind === 'aura') {
      const cell = at(s, selected.position!)!;
      const i = cell.auras.findIndex(a => a.instance_id === selected.id);
      s.players[p].graveyard.push(cell.auras.splice(i, 1)[0]);
    } else { pending.freed_positions.push(selected.position!); await destroy(c, selected.position!, p); }
    pending.paid.push(selected.id);
    log(c, p, 'mostrissimo_sacrifice', `Sacrificio ${pending.paid.length}/${pending.required}: ${selected.kind}.`, { instance_id: selected.id, position: selected.position ?? null });
    if (permanents(s, p).length < pending.required - pending.paid.length) failSummon(c, 'Evocazione fallita: sacrifici insufficienti dopo la reazione.');
    else if (pending.paid.length === pending.required && !legalPositions(s, p, pending.freed_positions).length) failSummon(c, 'Evocazione fallita: nessuna cella legale.');
  } else if (e.kind === 'mostrissimo_before_entry') {
    const pending = s.pending_mostrissimo;
    const offered = s.shared_mostrissimi.find(x => x.instance_id === e.offered_instance_id);
    if (!pending || pending.stage !== 'before_entry' || pending.card_id !== e.card_id || pending.player_index !== p || pending.paid.length !== pending.required || !offered || !legalPositions(s, p, pending.freed_positions).some(q => q.row === e.position.row && q.col === e.position.col)) {
      failSummon(c, 'Evocazione fallita: costo, offerta o cella non più validi.'); return;
    }
    const card = await getCardData(e.card_id);
    s.shared_mostrissimi = s.shared_mostrissimi.filter(x => x.instance_id !== offered.instance_id);
    s.used_mostrissimi.push(card.id);
    const replacement = s.remaining_mostrissimi.shift();
    if (replacement) s.shared_mostrissimi.push({ instance_id: randomUUID(), card_id: replacement });
    put(s, e.position, { instance_id: offered.instance_id, card_id: card.id, owner_index: p, attack: Number(card.attack ?? 0), hp: Number(card.hp ?? 1), max_hp: Number(card.hp ?? 1), tired: !keyword(card, 'iperattivo'), auras: [] });
    s.players[p].color_counters[card.faction_code] = (s.players[p].color_counters[card.faction_code] ?? 0) + 1;
    pending.stage = 'etb'; pending.position = e.position; pending.target_instance_id = e.target_instance_id;
    s.mostrissimo_result = { outcome: 'summoned', message: `${card.name} è stato evocato.` };
    log(c, p, 'mostrissimo_summoned', `${label(p)} evoca ${card.name}.`, { card_id: card.id, instance_id: offered.instance_id, position: e.position });
    queueOnPlay(s, p, card, offered.instance_id, e.target_instance_id, true);
    if (!effects(card.effect_json).length) delete s.pending_mostrissimo;
  } else if (e.kind === 'monster_etb') {
    if (!find(s, e.source_instance_id)) {
      log(c, p, 'etb_source_gone', 'L’effetto ETB salta: la creatura non è più sul campo.'); return;
    }
    prepend(s, { kind: 'resolve_effect', owner: p, card_id: e.card_id, source_instance_id: e.source_instance_id, source: 'on_play', effect_index: e.effect_index, target_instance_id: e.target_instance_id, require_source_on_board: true });
  }
}
async function validTraps(c: Context, e: PendingEvent): Promise<CardInstance[]> {
  const responder = other(e.actor);
  const mana = c.s.players[responder].current_mana;
  const cards: CardInstance[] = [];
  for (const inst of c.s.players[responder].hand) {
    const card = await getCardData(inst.card_id);
    if (card.card_type !== 'instant' || Number(card.mana_cost) > mana || !matchesTrigger(trigger(card), e)) continue;
    const list = effects(card.effect_json);
    if (!list.length || list.some(x => !['draw', 'discard', 'heal', 'damage', 'damage_creature', 'return_hand', 'buff', 'counter'].includes(x.type))) continue;
    if (list.some(x => x.type === 'counter') && e.kind !== 'hand_card' && trigger(card) !== 'mostrissimo_before_entry') continue;
    if (list.some(x => x.target === 'any_creature' || x.type === 'return_hand') && !list.every(x => x.target !== 'any_creature' && x.type !== 'return_hand' || eligible(c.s, responder, x).length > 0)) continue;
    cards.push(inst);
  }
  return cards;
}
function aiTrapTarget(s: GameState, card: CardData): string | null {
  const effect = effects(card.effect_json).find(x => x.target === 'any_creature' || x.type === 'return_hand');
  if (!effect) return null;
  const options = eligible(s, 0, effect);
  const enemy = options.filter(x => x.cell.owner_index === 1);
  const friend = options.filter(x => x.cell.owner_index === 0);
  if (effect.type === 'heal' || effect.type === 'buff') return friend.sort((a, b) => effect.type === 'heal' ? (b.cell.max_hp - b.cell.hp) - (a.cell.max_hp - a.cell.hp) : b.cell.attack - a.cell.attack)[0]?.cell.instance_id ?? null;
  return enemy.sort((a, b) => effect.type === 'return_hand' ? b.cell.attack - a.cell.attack : a.cell.hp - b.cell.hp)[0]?.cell.instance_id ?? null;
}
async function playTrap(c: Context, e: PendingEvent, trapId: string, targetId: string | null) {
  const p = other(e.actor), owner = c.s.players[p];
  const i = owner.hand.findIndex(x => x.instance_id === trapId);
  if (i < 0) throw new Error('Trappola non più in mano');
  const card = await getCardData(owner.hand[i].card_id);
  if (card.card_type !== 'instant' || !matchesTrigger(trigger(card), e) || owner.current_mana < card.mana_cost) throw new Error('Trappola non giocabile in questa finestra');
  const list = effects(card.effect_json);
  for (const effect of list) if (effect.target === 'any_creature' || effect.type === 'return_hand') {
    if (!target(c.s, p, effect, targetId)) throw new Error('Bersaglio della Trappola non valido');
  }
  const isCounter = list.some(x => x.type === 'counter');
  if (isCounter && e.kind !== 'hand_card' && !(e.kind === 'mostrissimo_before_entry' && trigger(card) === 'mostrissimo_before_entry')) throw new Error('Questo evento non può essere contrastato');
  owner.current_mana -= card.mana_cost;
  owner.graveyard.push(owner.hand.splice(i, 1)[0]);
  owner.color_counters[card.faction_code] = (owner.color_counters[card.faction_code] ?? 0) + 1;
  log(c, p, 'trap_played', `${label(p)} gioca ${card.name} in risposta a un’azione.`, { card_id: card.id, instance_id: trapId });
  if (isCounter) {
    if (e.kind === 'mostrissimo_before_entry') failSummon(c, `${card.name} contrasta l’evocazione; i sacrifici restano pagati.`);
    log(c, p, 'event_countered', `${card.name} contrasta l’evento dichiarato.`);
  } else {
    prepend(c.s, ...list.map((_, effect_index): PendingWork => ({ kind: 'resolve_effect', owner: p, card_id: card.id, source_instance_id: trapId, source: 'trap', effect_index, target_instance_id: targetId, require_source_on_board: false })), { kind: 'apply_event', event: e });
  }
}
async function declare(c: Context, e: PendingEvent) {
  const found = await validTraps(c, e);
  if (!found.length) { prepend(c.s, { kind: 'apply_event', event: e }); return; }
  const responder = other(e.actor);
  if (responder === 0) {
    // Valuta guadagno immediato invece di spendere automaticamente ogni Trappola.
    const evaluated = await Promise.all(found.map(async inst => {
      const card = await getCardData(inst.card_id);
      const t = aiTrapTarget(c.s, card);
      const list = effects(card.effect_json);
      let score = 0;
      for (const fx of list) {
        if (fx.type === 'counter') score += e.kind === 'hand_card' ? 3 + e.paid_mana : 7;
        else if (fx.type === 'damage' || fx.type === 'damage_creature') score += t ? Number(fx.amount ?? 1) * 2 : fx.target === 'all_creatures' ? units(c.s, 1).length * Number(fx.amount ?? 1) - units(c.s, 0).length * Number(fx.amount ?? 1) : 0;
        else if (fx.type === 'return_hand') score += t ? 3 + (find(c.s, t)?.cell.attack ?? 0) : 0;
        else if (fx.type === 'heal') score += t ? Math.min(Number(fx.amount ?? 1), (find(c.s, t)?.cell.max_hp ?? 0) - (find(c.s, t)?.cell.hp ?? 0)) : 0;
        else if (fx.type === 'buff') score += t ? 2 : 0;
        else if (fx.type === 'draw') score += c.s.players[0].deck.length ? Number(fx.amount ?? 1) : -4;
        else if (fx.type === 'discard') score += Math.min(c.s.players[1].hand.length, Number(fx.amount ?? 1));
      }
      return { inst, card, t, score: score - card.mana_cost * 0.5 };
    }));
    evaluated.sort((a, b) => b.score - a.score);
    const best = evaluated[0];
    if (best && best.score >= 2) { await playTrap(c, e, best.inst.instance_id, best.t); return; }
    prepend(c.s, { kind: 'apply_event', event: e }); return;
  }
  c.s.pending_reaction = { window_id: randomUUID(), event: e, responder_index: responder, eligible_instance_ids: found.map(x => x.instance_id) };
  log(c, responder, 'reaction_window', 'Finestra reattiva: gioca una Trappola o passa.', { window_id: c.s.pending_reaction.window_id });
}
async function drain(c: Context) {
  for (let n = 0; n < 300 && c.s.status === 'running' && !c.s.pending_reaction && c.s.work_queue.length; n++) {
    const step = c.s.work_queue.shift()!;
    if (step.kind === 'declare_event') await declare(c, step.event);
    else if (step.kind === 'apply_event') await applyEvent(c, step.event);
    else if (step.kind === 'resolve_effect') await applyEffect(c, step);
    else if (step.kind === 'finish_mostrissimo') {
      if (c.s.pending_mostrissimo?.card_id === step.card_id && c.s.pending_mostrissimo.player_index === step.actor) delete c.s.pending_mostrissimo;
    } else if (step.kind === 'check_winner') checkWinner(c, step.reason);
    else if (step.kind === 'advance_ai') await advanceAi(c);
  }
  if (c.s.status === 'running' && !c.s.pending_reaction && c.s.work_queue.length) throw new Error('Limite di sicurezza della coda eventi raggiunto');
  if (!c.s.pending_reaction && c.s.work_queue.length === 0) c.s.anti_loop_counter = 0;
}
async function mutate(id: string, action: (c: Context) => Promise<void>): Promise<GameState> {
  const s = await load(id);
  const c: Context = { id, s, logs: [] };
  if (!s.pending_reaction && s.work_queue.length === 0) s.anti_loop_counter = 0;
  await action(c); await drain(c);
  return commit(id, s, c.logs);
}
function assertTurn(s: GameState, p: PlayerIndex, allowMost = false) {
  if (s.status !== 'running' || s.active_player_index !== p || s.phase !== 'main') throw new Error('Azione non disponibile in questo turno');
  if (s.pending_reaction || s.work_queue.length) throw new Error('Risolvi prima la finestra reattiva');
  if (!allowMost && s.pending_mostrissimo) throw new Error('Completa prima l’evocazione del Mostrissimo');
}
function expireTemporaryBuffs(s: GameState) {
  for (const p of [0, 1] as const) for (const { cell } of units(s, p)) {
    if (cell.temp_attack) { cell.attack -= cell.temp_attack; delete cell.temp_attack; }
  }
}
async function startTurn(c: Context, p: PlayerIndex) {
  const s = c.s;
  s.active_player_index = p; s.phase = 'upkeep'; s.anti_loop_counter = 0; s.mostrissimo_result = null;
  if (p === 1) s.current_turn++;
  const player = s.players[p]; player.max_mana = Math.min(6, player.max_mana + 1); player.current_mana = player.max_mana;
  for (const { cell } of units(s, p)) cell.tired = false;
  const count = draw(c, p, 1);
  log(c, p, 'upkeep', `${label(p)} raggiunge ${player.current_mana}/${player.max_mana} mana e pesca ${count} carta/e.`);
  if (s.status === 'running') s.phase = 'main';
}
async function advanceAi(c: Context) {
  const s = c.s;
  if (s.status !== 'running' || s.active_player_index !== 0 || !s.ai_progress) return;
  const progress: AiProgress = s.ai_progress;
  if (progress.stage === 'upkeep') { await startTurn(c, 0); progress.stage = 'actions'; if (s.status === 'running') prepend(s, { kind: 'advance_ai' }); return; }
  if (progress.stage === 'human_upkeep') { await startTurn(c, 1); delete s.ai_progress; return; }
  if (progress.stage === 'end' || progress.actions_taken >= 20) {
    expireTemporaryBuffs(s); s.phase = 'end'; log(c, 0, 'turn_end', 'L’IA termina il turno.');
    progress.stage = 'human_upkeep'; prepend(s, { kind: 'advance_ai' }); return;
  }
  const ready = units(s, 0).find(u => !u.cell.tired);
  if (ready) {
    const destinations = enemies(s, ready.position, 0);
    const victim = destinations.length ? at(s, destinations[0]) : null;
    const e: PendingEvent = {
      kind: 'attack', actor: 0, instance_id: ready.cell.instance_id, from: ready.position,
      target: victim ? { type: 'creature', position: destinations[0] } : { type: 'player', playerIndex: 1 },
      ...(victim ? { target_instance_id: victim.instance_id } : {}),
    };
    progress.actions_taken++;
    prepend(s, { kind: 'declare_event', event: e }, { kind: 'advance_ai' }); return;
  }
  const free = [0, 1, 2].filter(col => !s.board.rows[0][col]);
  if (free.length) {
    const cards = await Promise.all(s.players[0].hand.map(async inst => ({ inst, card: await getCardData(inst.card_id) })));
    for (const { inst, card } of cards) {
      if (card.card_type !== 'monster' || card.mana_cost > s.players[0].current_mana || effects(card.effect_json).some(x => !['draw', 'discard', 'heal', 'damage', 'damage_creature', 'return_hand', 'buff'].includes(x.type))) continue;
      const fx = effects(card.effect_json).find(x => x.target === 'any_creature' || x.type === 'return_hand');
      const options: PlayCardOptions = { position: { row: 0, col: free[0] } };
      if (fx) {
        const t = eligible(s, 0, fx)[0];
        if (t) options.targetInstanceId = t.cell.instance_id;
        else if (!(fx.type === 'heal' && fx.target === 'any_creature')) continue;
      }
      s.players[0].hand = s.players[0].hand.filter(x => x.instance_id !== inst.instance_id);
      s.players[0].graveyard.push(inst); s.players[0].current_mana -= card.mana_cost;
      log(c, 0, 'card_declared', `L’IA dichiara ${card.name} pagando ${card.mana_cost} mana.`, { card_id: card.id, instance_id: inst.instance_id });
      const e: PendingEvent = { kind: 'hand_card', actor: 0, instance_id: inst.instance_id, card_id: card.id, options, paid_mana: card.mana_cost };
      progress.actions_taken++;
      prepend(s, { kind: 'declare_event', event: e }, { kind: 'advance_ai' }); return;
    }
  }
  const mover = units(s, 0).find(u => !u.cell.tired && s.players[0].current_mana >= 1 && around(u.position).some(q => allowed(0, q.row) && !at(s, q) && enemies(s, q, 0).length));
  if (mover) {
    const to = around(mover.position).find(q => allowed(0, q.row) && !at(s, q) && enemies(s, q, 0).length)!;
    s.players[0].current_mana--;
    const e: PendingEvent = { kind: 'move', actor: 0, instance_id: mover.cell.instance_id, from: mover.position, to, paid_mana: 1 };
    progress.actions_taken++;
    prepend(s, { kind: 'declare_event', event: e }, { kind: 'advance_ai' }); return;
  }
  progress.stage = 'end'; prepend(s, { kind: 'advance_ai' });
}

async function deck(): Promise<CardInstance[]> {
  const { data, error } = await db.from('cards').select('id,card_type,mana_cost,is_boss,effect_json').in('card_type', ['monster', 'instant']);
  if (error || !data) throw new Error(`Catalogo non disponibile: ${error?.message ?? 'nessun risultato'}`);
  const pool = data.map(x => ({ id: String(x.id), cost: Number(x.mana_cost), boss: Boolean(x.is_boss), type: String(x.card_type), raw: x.effect_json as CardEffectJson | null }));
  const monsters = pool.filter(x => x.type === 'monster');
  const supported = new Set(['draw', 'discard', 'heal', 'damage', 'damage_creature', 'return_hand', 'buff']);
  const instants = pool.filter(x => x.type === 'instant' && effects(x.raw).length > 0 && effects(x.raw).every(e => supported.has(e.type)));
  const low = monsters.filter(x => x.cost <= 2), mid = monsters.filter(x => x.cost >= 2 && x.cost <= 4), high = monsters.filter(x => x.cost >= 5);
  if (!instants.length || !low.length || !mid.length || !high.length) throw new Error('Catalogo insufficiente per il mazzo di test con Istantanei');
  const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
  for (let attempt = 0; attempt < 300; attempt++) {
    const bosses = high.filter(x => x.boss);
    const chosen = [pick(bosses.length ? bosses : high), pick(low), pick(low), pick(mid), pick(mid), pick(mid), pick(instants), pick(instants)];
    while (chosen.length < 10) chosen.push(pick(monsters));
    const avg = chosen.reduce((sum, x) => sum + x.cost, 0) / 10;
    if (avg >= 2.5 && avg <= 4) return shuffle(chosen.map(x => ({ instance_id: randomUUID(), card_id: x.id })));
  }
  throw new Error('Impossibile generare un mazzo con curva mana 2,5–4 e due Istantanei');
}
async function offer(): Promise<{ shared: CardInstance[]; remaining: string[] }> {
  const { data, error } = await db.from('cards').select('id').eq('card_type', 'mostrissimo');
  if (error || !data) throw new Error(`Catalogo Mostrissimi non disponibile: ${error?.message ?? 'nessun risultato'}`);
  const ids = shuffle(data.map(x => String(x.id)));
  if (!ids.length) throw new Error('Il catalogo non contiene Mostrissimi');
  return { shared: ids.slice(0, 3).map(card_id => ({ card_id, instance_id: randomUUID() })), remaining: ids.slice(3) };
}
function player(index: PlayerIndex, userId: string | null, cards: CardInstance[]): PlayerState {
  return { player_index: index, user_id: userId, life: 20, max_mana: 0, current_mana: 0, deck: cards, hand: [], graveyard: [], extra_deck: [], color_counters: { CHI: 0, INF: 0, PES: 0, BUL: 0, GRO: 0, CLO: 0, IND: 0 }, field_spell: null };
}
export async function createNewMatch(userId: string): Promise<{ matchId: string; state: GameState }> {
  const [aiCards, humanCards, catalogue] = await Promise.all([deck(), deck(), offer()]);
  const { data, error } = await db.from('matches').insert({ player_id: userId, opponent_type: 'ai', opponent_name: 'IA Bellum Penumbrum', player_won: null, turns_count: 0, duration_seconds: 0 }).select('id').single();
  if (error || !data) throw new Error(`Creazione partita: ${error?.message ?? 'nessun ID'}`);
  const matchId = String(data.id), ai = player(0, null, aiCards), human = player(1, userId, humanCards);
  for (let i = 0; i < 4; i++) ai.hand.push(ai.deck.shift()!);
  for (let i = 0; i < 3; i++) human.hand.push(human.deck.shift()!);
  human.max_mana = human.current_mana = 1;
  const state: GameState = { state_version: 3, state_revision: 0, match_id: matchId, status: 'running', players: [ai, human], board: blank(), current_turn: 1, active_player_index: 1, phase: 'main', anti_loop_counter: 0, winner_index: null, shared_mostrissimi: catalogue.shared, remaining_mostrissimi: catalogue.remaining, used_mostrissimi: [], work_queue: [], last_mostrissimo_turn: {}, mostrissimo_result: null };
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
    const card = await getCardData(inst.card_id);
    if (card.card_type === 'mostrissimo') throw new Error('Evoca i Mostrissimi dall’offerta condivisa');
    if (card.card_type === 'instant') throw new Error('Gli Istantanei si giocano soltanto nella finestra del turno avversario');
    if (owner.current_mana < card.mana_cost) throw new Error('Mana insufficiente');
    if (card.card_type === 'monster' && (!options.position || !valid(options.position) || options.position.row !== home(p) || at(s, options.position))) throw new Error('Evoca in una cella libera della tua riga iniziale');
    if (card.card_type === 'terraforma' && owner.field_spell) throw new Error('Una Terraforma è già attiva');
    if (card.card_type === 'aura' && (!options.targetInstanceId || find(s, options.targetInstanceId)?.cell.owner_index !== p)) throw new Error('Seleziona una tua creatura per l’Aura');
    const onPlay = effects(card.effect_json);
    if (onPlay.some(x => !['draw', 'discard', 'heal', 'damage', 'damage_creature', 'return_hand', 'buff'].includes(x.type))) throw new Error('Effetto carta non ancora supportato');
    for (const effect of onPlay.filter(x => x.target === 'any_creature' || x.type === 'return_hand')) {
      if (options.targetInstanceId && !target(s, p, effect, options.targetInstanceId)) throw new Error('Bersaglio non valido');
      if (!options.targetInstanceId && eligible(s, p, effect).length && !(card.card_type === 'monster' && effect.type === 'heal' && units(s, p).length === 0)) throw new Error('Seleziona una creatura bersaglio');
      if (!options.targetInstanceId && card.card_type !== 'monster') throw new Error('Questa magia richiede una creatura bersaglio');
    }
    owner.hand = owner.hand.filter(x => x.instance_id !== inst.instance_id);
    owner.graveyard.push(inst); owner.current_mana -= card.mana_cost;
    log(c, p, 'card_declared', `${label(p)} dichiara ${card.name} e paga ${card.mana_cost} mana.`, { card_id: card.id, instance_id: inst.instance_id });
    prepend(s, { kind: 'declare_event', event: { kind: 'hand_card', actor: p, instance_id: inst.instance_id, card_id: card.id, options, paid_mana: card.mana_cost } });
  });
}
export async function moveCreature(id: string, p: PlayerIndex, from: Position, to: Position): Promise<GameState> {
  return mutate(id, async c => {
    const s = c.s; assertTurn(s, p);
    if (!valid(from) || !valid(to) || !adjacent(from, to) || !allowed(p, to.row)) throw new Error('Movimento non valido');
    const cell = at(s, from);
    if (!cell || cell.owner_index !== p || cell.tired || at(s, to)) throw new Error('Creatura stanca, non tua o destinazione occupata');
    if (s.players[p].current_mana < 1) throw new Error('Serve 1 mana per Muovi');
    s.players[p].current_mana--;
    prepend(s, { kind: 'declare_event', event: { kind: 'move', actor: p, instance_id: cell.instance_id, from, to, paid_mana: 1 } });
  });
}
export async function attack(id: string, p: PlayerIndex, from: Position, targetPosition: AttackTarget): Promise<GameState> {
  return mutate(id, async c => {
    const s = c.s; assertTurn(s, p);
    if (!valid(from)) throw new Error('Attaccante non valido');
    const cell = at(s, from);
    if (!cell || cell.owner_index !== p || cell.tired) throw new Error('Creatura non tua oppure stanca');
    const options = enemies(s, from, p);
    let victim: BoardCell | null = null;
    if (targetPosition.type === 'creature') {
      if (!valid(targetPosition.position) || !options.some(q => q.row === targetPosition.position.row && q.col === targetPosition.position.col)) throw new Error('Bersaglio non ortogonalmente adiacente');
      victim = at(s, targetPosition.position);
    } else if (targetPosition.playerIndex !== other(p) || options.length) throw new Error('Attacco diretto vietato');
    prepend(s, { kind: 'declare_event', event: { kind: 'attack', actor: p, instance_id: cell.instance_id, from, target: targetPosition, ...(victim ? { target_instance_id: victim.instance_id } : {}) } });
  });
}
export async function startMostrissimoSummon(id: string, p: PlayerIndex, cardId: string): Promise<GameState> {
  return mutate(id, async c => {
    const s = c.s; assertTurn(s, p);
    if (s.last_mostrissimo_turn[p] === s.current_turn) throw new Error('Hai già tentato un Mostrissimo in questo turno');
    const offered = s.shared_mostrissimi.find(x => x.card_id === cardId);
    if (!offered) throw new Error('Mostrissimo non presente nell’offerta condivisa');
    const card = await getCardData(cardId), required = Number(card.sacrifice_cost);
    if (card.card_type !== 'mostrissimo' || !Number.isInteger(required) || required < 0 || required > 6) throw new Error('Costo in sacrifici non valido');
    if (permanents(s, p).length < required) throw new Error('Non hai abbastanza permanenti');
    if (!legalPositions(s, p, []).length && !units(s, p).length) throw new Error('Nessuna cella legale');
    s.last_mostrissimo_turn[p] = s.current_turn;
    s.pending_mostrissimo = { player_index: p, card_id: card.id, offered_instance_id: offered.instance_id, required, paid: [], freed_positions: [], stage: 'paying' };
    s.mostrissimo_result = null;
    log(c, p, 'mostrissimo_start', `${label(p)} inizia l’evocazione di ${card.name}: ${required} permanenti.`, { card_id: card.id });
  });
}
export async function payMostrissimoSacrifice(id: string, p: PlayerIndex, instanceId: string): Promise<GameState> {
  return mutate(id, async c => {
    const s = c.s; assertTurn(s, p, true);
    const pending = s.pending_mostrissimo;
    if (!pending || pending.player_index !== p || pending.stage !== 'paying' || pending.paid.length >= pending.required) throw new Error('Nessun sacrificio richiesto');
    const selected = permanents(s, p).find(x => x.id === instanceId);
    if (!selected) throw new Error('Permanente non tuo o non più presente');
    prepend(s, { kind: 'declare_event', event: { kind: 'mostrissimo_sacrifice', actor: p, instance_id: instanceId, card_id: selected.card_id } });
  });
}
export async function completeMostrissimoSummon(id: string, p: PlayerIndex, position: Position, targetId: string | null): Promise<GameState> {
  return mutate(id, async c => {
    const s = c.s; assertTurn(s, p, true);
    const pending = s.pending_mostrissimo;
    if (!pending || pending.player_index !== p || pending.stage !== 'paying') throw new Error('Nessuna evocazione in corso');
    if (pending.paid.length !== pending.required) throw new Error('Prima completa tutti i sacrifici');
    if (!valid(position) || !legalPositions(s, p, pending.freed_positions).some(x => x.row === position.row && x.col === position.col)) throw new Error('Cella di evocazione non legale');
    const card = await getCardData(pending.card_id);
    if (effects(card.effect_json).some(x => !['draw', 'discard', 'heal', 'damage', 'damage_creature', 'return_hand', 'buff'].includes(x.type))) throw new Error('Effetto del Mostrissimo non supportato');
    if (targetId && !effects(card.effect_json).some(x => (x.target === 'any_creature' || x.type === 'return_hand') && target(s, p, x, targetId))) throw new Error('Bersaglio non valido');
    pending.stage = 'before_entry'; pending.position = position; pending.target_instance_id = targetId;
    prepend(s, { kind: 'declare_event', event: { kind: 'mostrissimo_before_entry', actor: p, card_id: card.id, offered_instance_id: pending.offered_instance_id, position, target_instance_id: targetId } });
  });
}
export async function resolveTrapChoice(id: string, p: PlayerIndex, choice: TrapChoice): Promise<GameState> {
  return mutate(id, async c => {
    const s = c.s, window = s.pending_reaction;
    if (!window || window.window_id !== choice.window_id || window.responder_index !== p || s.status !== 'running') throw new Error('Finestra reattiva scaduta o non tua');
    // Chiudere PRIMA di risolvere la carta garantisce che non si creino catene.
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
    expireTemporaryBuffs(s); s.phase = 'end';
    log(c, 1, 'turn_end', 'Termini il turno.');
    s.ai_progress = { stage: 'upkeep', actions_taken: 0 };
    prepend(s, { kind: 'advance_ai' });
  });
}
