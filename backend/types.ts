// backend/types.ts

export type MatchStatus = 'not_started' | 'running' | 'finished';
export type TurnPhase = 'start' | 'upkeep' | 'main' | 'end';

export type GameState = {
  match_id: string;
  status: MatchStatus;
  players: [PlayerState, PlayerState];
  current_turn: number;
  active_player_index: number;
  phase: TurnPhase;
  stack: any[];
  anti_loop_counter: number;
};

export type PlayerState = {
  player_index: number;
  user_id: string | null;
  life: number;
  max_mana: number;
  current_mana: number;
  deck: string[];
  hand: string[];
  graveyard: string[];
  extra_deck: string[];
  color_counters: Record<string, number>;
  board: BoardState;
};

export type BoardState = {
  field_spell: BoardCellFieldSpell | null;
  rows: Array<[BoardCell | null, BoardCell | null, BoardCell | null]>;
};

export type BoardCell = {
  card_id: string;
  instance_id: string;
  attack: number;
  hp: number;
  max_hp: number;
  tired: boolean;
  auras: BoardCellAura[];
};

export type BoardCellAura = {
  card_id: string;
  instance_id: string;
};

export type BoardCellFieldSpell = {
  card_id: string;
  instance_id: string;
};

export type CardType =
  | 'monster'
  | 'mostrissimo'
  | 'sorcery'
  | 'instant'
  | 'terraforma'
  | 'aura';

export type CardData = {
  id: string;
  name: string;
  faction_id: string;
  faction_code: string;
  card_type: CardType;
  mana_cost: number;
  sacrifice_cost: number | null;
  attack: number | null;
  hp: number | null;
  subtype: string | null;
  rarity: string;
  effect_text: string | null;
  effect_json: Record<string, any> | null;
  effect_on_death_json: Record<string, any> | null;
  flavor_text: string | null;
  image_url: string | null;
};

export type EffectType =
  | 'draw'
  | 'damage'
  | 'damage_creature'
  | 'heal'
  | 'discard'
  | 'discard_random'
  | 'buff'
  | 'counter'
  | 'return_hand'
  | 'destroy'
  | 'exile'
  | 'mill'
  | 'search_deck'
  | 'create_token'
  | 'custom';

export type EffectTarget =
  | 'self'
  | 'opponent'
  | 'any_creature'
  | 'all_creatures'
  | 'all_creatures_self'
  | 'all_creatures_opponent'
  | 'any_spell'
  | 'spell'
  | 'any_card'
  | 'custom';

export type EffectStat = 'attack' | 'hp';
export type EffectDuration = 'turn' | 'permanent';
export type EffectTiming = 'on_play' | 'instant' | 'on_death' | 'upkeep' | 'end';

export type EffectDefinition = {
  effect_id?: string;
  type: EffectType;
  amount?: number;
  target?: EffectTarget;
  target_card_id?: string;
  target_player_index?: number;
  stat?: EffectStat;
  duration?: EffectDuration;
  timing?: EffectTiming;
  [key: string]: any;
};

export type MatchLogEntry = {
  turn: number;
  phase: TurnPhase;
  player_index: number;
  action_type: string;
  card_id?: string;
  target_card_id?: string;
  target_player_index?: number;
  amount?: number;
  damage?: number;
  stat?: EffectStat;
  duration?: EffectDuration;
  effect_type?: EffectType;
  sacrificed_card_ids?: string[];
  position?: { row: number; col: number } | null;
  description: string;
};

export type PlayCardOptions = {
  position?: { row: number; col: number };
  targetCardId?: string;
  targetPlayerIndex?: number;
  [key: string]: any;
};

export type AttackPosition = { row: number; col: number };

export type AttackTarget =
  | { type: 'creature'; ownerIndex: number; position: AttackPosition }
  | { type: 'player'; playerIndex: number };
