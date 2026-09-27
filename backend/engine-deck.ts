// backend/engine-deck.ts — catalogo, mazzi a tre colori e regole di giocabilità.
import { randomUUID } from 'node:crypto';
import type {
  CardData, CardEffectJson, CardInstance, DeckColors, DeckFaction, PlayerIndex, PlayerState,
} from './types.js';
import { effects, shuffle, supported } from './engine-board.js';
import { db } from './engine-storage.js';

export function passiveAura(d: CardData) {
  const list = effects(d.effect_json);
  return list.length > 0 && list.every(e =>
    e.type === 'buff' && e.duration === 'while_attached' && (e.target === 'enchanted_creature' || e.target === 'all_creatures_self') && (e.stat === 'hp' || e.stat === 'attack') && Number.isInteger(e.amount) && Number(e.amount) >= 0 && Number(e.amount) <= 20
    || e.type === 'movement_cost' && e.duration === 'while_attached' && e.target === 'enchanted_creature' && e.amount === 0);
}
export function passiveLand(d: CardData) {
  const list = effects(d.effect_json);
  return list.length > 0 && list.every(e => e.type === 'buff' && e.duration === 'while_in_play' && e.target === 'all_creatures_self' && (e.stat === 'hp' || e.stat === 'attack') && Number.isInteger(e.amount) && Number(e.amount) >= 0 && Number(e.amount) <= 20);
}
export function playableEffects(d: CardData) {
  const list = effects(d.effect_json);
  return d.card_type === 'aura' ? passiveAura(d) : d.card_type === 'terraforma' ? passiveLand(d) : list.every(e => supported.has(e.type) && e.duration !== 'while_attached' && e.duration !== 'while_in_play');
}

const deckFactions: DeckFaction[] = ['CHI', 'INF', 'PES', 'BUL', 'GRO', 'CLO'];
export function chosenColors(primary: DeckFaction, secondary: DeckFaction): DeckColors {
  if (!deckFactions.includes(primary) || !deckFactions.includes(secondary) || primary === secondary)
    throw new Error('Seleziona due colori distinti tra le sei fazioni');
  const tertiary = shuffle(deckFactions.filter(x => x !== primary && x !== secondary))[0];
  return { primary, secondary, tertiary };
}
export function randomColors(): DeckColors {
  const [primary, secondary, tertiary] = shuffle(deckFactions);
  return { primary, secondary, tertiary };
}
type DeckCard = { id: string; cost: number; type: string; faction: DeckFaction; raw: CardEffectJson | null };
function deckPlayable(x: DeckCard): boolean {
  const d = { card_type: x.type, effect_json: x.raw } as CardData;
  const list = effects(x.raw);
  if (x.type === 'aura') return passiveAura(d);
  if (x.type === 'terraforma') return passiveLand(d);
  if (x.type === 'instant') return list.length > 0 && !!x.raw?.reaction_trigger && list.every(e => supported.has(e.type) || e.type === 'counter' || e.type === 'nope');
  return list.every(e => supported.has(e.type) && e.duration !== 'while_attached' && e.duration !== 'while_in_play');
}
export async function deckPool(): Promise<DeckCard[]> {
  const { data, error } = await db.from('cards').select('id,card_type,mana_cost,effect_json,factions!inner(code)')
    .in('card_type', ['monster', 'instant', 'aura', 'terraforma', 'maledizione']);
  if (error || !data) throw new Error(`Catalogo non disponibile: ${error?.message ?? 'nessun risultato'}`);
  const pool: DeckCard[] = [];
  for (const row of data) {
    const linked = Array.isArray(row.factions) ? row.factions[0] : row.factions;
    const code = linked && typeof linked === 'object' && 'code' in linked ? String(linked.code).toUpperCase() : '';
    if (!deckFactions.includes(code as DeckFaction)) continue;
    const x: DeckCard = { id: String(row.id), cost: Number(row.mana_cost), type: String(row.card_type),
      faction: code as DeckFaction, raw: row.effect_json as CardEffectJson | null };
    if (Number.isInteger(x.cost) && x.cost >= 0 && deckPlayable(x)) pool.push(x);
  }
  return pool;
}
export function deck(pool: DeckCard[], colors: DeckColors): CardInstance[] {
  const selected = pool.filter(x => x.faction === colors.primary || x.faction === colors.secondary || x.faction === colors.tertiary);
  const by = (faction: DeckFaction) => selected.filter(x => x.faction === faction);
  if (by(colors.primary).length < 2 || by(colors.secondary).length < 2 || by(colors.tertiary).length < 1)
    throw new Error(`Catalogo insufficiente per il mazzo ${colors.primary}/${colors.secondary}/${colors.tertiary}`);
  const monsters = selected.filter(x => x.type === 'monster');
  if (!monsters.length) throw new Error('Catalogo insufficiente: manca un Mostro nei colori del mazzo');
  const unique = new Map<string, DeckCard>();
  for (const x of selected) unique.set(x.id, x);
  const cards = [...unique.values()];
  if (cards.length < 10) throw new Error(`Catalogo insufficiente: meno di 10 carte distinte per ${colors.primary}/${colors.secondary}/${colors.tertiary}`);
  const counts = (xs: DeckCard[], faction: DeckFaction) => xs.filter(x => x.faction === faction).length;
  const validDeck = (xs: DeckCard[]) => {
    const sum = xs.reduce((n, x) => n + x.cost, 0);
    return xs.length === 10 && sum >= 25 && sum <= 40
      && counts(xs, colors.primary) >= 2 && counts(xs, colors.secondary) >= 2 && counts(xs, colors.tertiary) >= 1
      && xs.some(x => x.type === 'monster');
  };
  let best: DeckCard[] | null = null, bestScore = -Infinity;
  for (let attempt = 0; attempt < 1500; attempt++) {
    const picked: DeckCard[] = [];
    const used = new Set<string>();
    const take = (options: DeckCard[]) => {
      const available = options.filter(x => !used.has(x.id));
      if (!available.length) return false;
      const x = available[Math.floor(Math.random() * available.length)];
      picked.push(x); used.add(x.id); return true;
    };
    if (!take(by(colors.primary)) || !take(by(colors.primary)) || !take(by(colors.secondary)) || !take(by(colors.secondary)) || !take(by(colors.tertiary))) continue;
    if (!picked.some(x => x.type === 'monster') && !take(monsters)) continue;
    while (picked.length < 10 && take(cards)) { /* riempimento casuale senza duplicati */ }
    if (!validDeck(picked)) continue;
    const differentTypes = new Set(picked.map(x => x.type)).size;
    const nonMonsters = picked.filter(x => x.type !== 'monster').length;
    const score = differentTypes * 4 + Math.min(nonMonsters, 4) * 2 + Math.random() * 12;
    if (score > bestScore) { best = picked; bestScore = score; }
  }
  if (!best) throw new Error(`Nessun mazzo valido per ${colors.primary}/${colors.secondary}/${colors.tertiary}: controlla il catalogo e la curva mana 2,5–4`);
  return shuffle(best.map(x => ({ instance_id: randomUUID(), card_id: x.id })));
}
export async function offer() {
  const { data, error } = await db.from('cards').select('id').eq('card_type', 'mostrissimo');
  if (error || !data) throw new Error(`Catalogo Mostrissimi non disponibile: ${error?.message ?? 'nessun risultato'}`);
  const ids = shuffle(data.map(x => String(x.id)));
  if (!ids.length) throw new Error('Il catalogo non contiene Mostrissimi');
  return { shared: ids.slice(0, 3).map(card_id => ({ card_id, instance_id: randomUUID() })), remaining: ids.slice(3) };
}
export function player(index: PlayerIndex, userId: string | null, deckCards: CardInstance[]): PlayerState {
  return { player_index: index, user_id: userId, life: 20, max_mana: 0, current_mana: 0, deck: deckCards, hand: [], graveyard: [], extra_deck: [], color_counters: { CHI: 0, INF: 0, PES: 0, BUL: 0, GRO: 0, CLO: 0, IND: 0 } };
}
