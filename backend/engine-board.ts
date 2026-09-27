// backend/engine-board.ts — utilità pure per plancia, bersagli e regole condivise.
import type {
  BoardCell, CardData, CardEffectJson, CardInstance, CreatureCell,
  EffectDefinition, GameState, PendingWork, PlayerIndex, Position,
  ReactionTriggerEvent, TurnPhase,
} from './types.js';

export const other = (p: PlayerIndex): PlayerIndex => p === 0 ? 1 : 0;
export const label = (p: PlayerIndex) => p === 1 ? 'Tu' : 'L’IA';
export const home = (p: PlayerIndex) => p === 0 ? 0 : 2;
export const allowed = (p: PlayerIndex, row: number) => row !== home(other(p));
export const valid = (p: Position) => Number.isInteger(p.row) && Number.isInteger(p.col) && p.row >= 0 && p.row < 3 && p.col >= 0 && p.col < 3;
export const adjacent = (a: Position, b: Position) => Math.abs(a.row - b.row) + Math.abs(a.col - b.col) === 1;
export const around = (p: Position) => [{ row: p.row - 1, col: p.col }, { row: p.row + 1, col: p.col }, { row: p.row, col: p.col - 1 }, { row: p.row, col: p.col + 1 }].filter(valid);
export const blank = (): GameState['board'] => ({ rows: [[null, null, null], [null, null, null], [null, null, null]] });
export const at = (s: GameState, p: Position) => valid(p) ? s.board.rows[p.row][p.col] : null;
export const put = (s: GameState, p: Position, c: BoardCell | null) => { s.board.rows[p.row][p.col] = c; };
export const instance = (c: CardInstance): CardInstance => ({ instance_id: c.instance_id, card_id: c.card_id });
export const effects = (raw: CardEffectJson | null): EffectDefinition[] => raw && 'effects' in raw && Array.isArray(raw.effects) ? raw.effects : raw && 'type' in raw ? [raw] : [];
export const reactionTrigger = (d: CardData): ReactionTriggerEvent | undefined => d.effect_json?.reaction_trigger?.event;
export const targeted = (e: EffectDefinition) => e.target === 'any_creature' || e.type === 'return_hand';
export const supported = new Set(['draw', 'discard', 'heal', 'damage', 'damage_creature', 'return_hand', 'destroy', 'buff']);
export const phaseNumber = (p: TurnPhase) => ({ start: 0, upkeep: 1, main: 2, end: 3 })[p];

export function shuffle<T>(input: T[]) {
  const a = [...input];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
export function cells(s: GameState) {
  const out: { position: Position; cell: BoardCell }[] = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const cell = s.board.rows[row][col];
    if (cell) out.push({ position: { row, col }, cell });
  }
  return out;
}
export function units(s: GameState, owner?: PlayerIndex) {
  return cells(s).filter((x): x is { position: Position; cell: CreatureCell } => x.cell.kind === 'creature' && (owner === undefined || x.cell.owner_index === owner));
}
export function find(s: GameState, id: string) { return cells(s).find(x => x.cell.instance_id === id) ?? null; }
export function findCreature(s: GameState, id: string) {
  const x = find(s, id);
  return x?.cell.kind === 'creature' ? { position: x.position, cell: x.cell } : null;
}
export function findAura(s: GameState, id: string) {
  for (const host of units(s)) {
    const aura = host.cell.auras.find(a => a.instance_id === id);
    if (aura) return { ...host, aura };
  }
  return null;
}
export function enemyNeighbours(s: GameState, p: Position, owner: PlayerIndex) {
  return around(p).filter(q => { const c = at(s, q); return c?.kind === 'creature' && c.owner_index === other(owner); });
}
export function eligible(s: GameState, owner: PlayerIndex, e: EffectDefinition) {
  if ((e.type === 'damage' || e.type === 'damage_creature') && e.timing !== 'instant') return units(s, other(owner));
  if (e.type === 'heal' && e.timing !== 'instant') return units(s, owner);
  return units(s);
}
export function target(s: GameState, owner: PlayerIndex, effect: EffectDefinition, id: string | null) {
  const x = id ? findCreature(s, id) : null;
  return x && eligible(s, owner, effect).some(v => v.cell.instance_id === id) ? x : null;
}
export function prepend(s: GameState, ...items: PendingWork[]) { s.work_queue.unshift(...items); }
export function keyword(d: CardData, value: string) {
  const extra = d as CardData & { keywords?: unknown; keyword_json?: unknown };
  return [extra.keywords, extra.keyword_json].some(x => Array.isArray(x) && x.some(v => String(v).toLowerCase() === value));
}
