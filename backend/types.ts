// backend/types.ts — contratto dello stato serializzato v4, checkpoint pubblici.
export type PlayerIndex = 0 | 1;
export type MatchStatus = 'not_started' | 'running' | 'finished';
export type TurnPhase = 'start' | 'upkeep' | 'main' | 'end';
export type CardType = 'monster' | 'mostrissimo' | 'maledizione' | 'instant' | 'terraforma' | 'aura';
export type DeckFaction = 'CHI' | 'INF' | 'PES' | 'BUL' | 'GRO' | 'CLO';
export type DeckColors = {
  primary: DeckFaction;
  secondary: DeckFaction;
  tertiary: DeckFaction;
};
export type EffectType =
  | 'draw' | 'damage' | 'damage_creature' | 'heal' | 'discard'
  | 'return_hand' | 'destroy' | 'buff' | 'movement_cost'
  | 'counter' | 'nope' | 'custom';
export type EffectTarget =
  | 'self' | 'opponent' | 'any_creature' | 'enchanted_creature'
  | 'all_creatures' | 'all_creatures_self' | 'all_creatures_opponent'
  | 'spell' | 'event';

export type ReactionTriggerEvent =
  | 'opponent_upkeep_start'
  | 'opponent_upkeep_end'
  | 'opponent_hand_card'
  | 'mostrissimo_before_entry'
  | 'monster_etb';
export type ReactionTrigger = { event: ReactionTriggerEvent };

export type EffectDefinition = {
  type: EffectType;
  amount?: number;
  target?: EffectTarget;
  timing?: 'on_play' | 'instant' | 'on_death' | 'upkeep_start';
  effect_id?: string;
  stat?: 'hp' | 'attack';
  duration?: 'turn' | 'permanent' | 'while_attached' | 'while_in_play';
  reaction_trigger?: ReactionTrigger;
};
export type CardEffectJson =
  | EffectDefinition
  | { effects: EffectDefinition[]; reaction_trigger?: ReactionTrigger };
export type CardData = {
  id: string;
  name: string;
  faction_id: number | null;
  faction_code: string;
  card_type: CardType;
  mana_cost: number;
  sacrifice_cost: number;
  attack: number | null;
  hp: number | null;
  subtype: string | null;
  rarity: string;
  effect_text: string | null;
  effect_json: CardEffectJson | null;
  effect_on_death_json: CardEffectJson | null;
  flavor_text: string | null;
  image_url: string | null;
};

export type CardInstance = { instance_id: string; card_id: string };
export type Position = { row: number; col: number };
export type BoardCellAura = CardInstance & { owner_index: PlayerIndex };
export type CreatureCell = CardInstance & {
  kind: 'creature';
  owner_index: PlayerIndex;
  attack: number;
  hp: number;
  max_hp: number;
  tired: boolean;
  auras: BoardCellAura[];
  temp_attack?: number;
  aura_attack_bonus?: number;
  aura_hp_bonus?: number;
  terraforma_attack_bonus?: number;
  terraforma_hp_bonus?: number;
};
export type TerraformaCell = CardInstance & {
  kind: 'terraforma';
  owner_index: PlayerIndex;
};
export type BoardCell = CreatureCell | TerraformaCell;
export type SharedBoard = {
  rows: [
    [BoardCell | null, BoardCell | null, BoardCell | null],
    [BoardCell | null, BoardCell | null, BoardCell | null],
    [BoardCell | null, BoardCell | null, BoardCell | null]
  ];
};
export type PlayerState = {
  player_index: PlayerIndex;
  user_id: string | null;
  life: number;
  max_mana: number;
  current_mana: number;
  deck: CardInstance[];
  hand: CardInstance[];
  graveyard: CardInstance[];
  extra_deck: CardInstance[];
  color_counters: Record<string, number>;
};

export type AttackTarget =
  | { type: 'creature'; position: Position }
  | { type: 'player'; playerIndex: PlayerIndex };
export type PlayCardOptions = { position?: Position; targetInstanceId?: string };

export type PendingEvent =
  | { kind: 'upkeep_start'; actor: PlayerIndex }
  | { kind: 'upkeep_end'; actor: PlayerIndex }
  | {
      kind: 'hand_card'; actor: PlayerIndex; instance_id: string;
      card_id: string; options: PlayCardOptions; paid_mana: number;
    }
  | {
      kind: 'move'; actor: PlayerIndex; instance_id: string;
      from: Position; to: Position; paid_mana: number;
    }
  | {
      kind: 'attack'; actor: PlayerIndex; instance_id: string;
      from: Position; target: AttackTarget; target_instance_id?: string;
    }
  | {
      kind: 'mostrissimo_sacrifice'; actor: PlayerIndex;
      instance_id: string; card_id: string;
    }
  | {
      kind: 'mostrissimo_before_entry'; actor: PlayerIndex;
      card_id: string; offered_instance_id: string;
      position: Position; target_instance_id: string | null;
    }
  | {
      kind: 'monster_etb'; actor: PlayerIndex;
      source_instance_id: string; card_id: string;
      effect_index: number; target_instance_id: string | null;
    };

export type PendingReaction = {
  window_id: string;
  event: PendingEvent;
  responder_index: PlayerIndex;
  eligible_instance_ids: string[];
};
export type TrapChoice =
  | { window_id: string; action: 'pass' }
  | {
      window_id: string; action: 'play'; card_instance_id: string;
      target_instance_id?: string;
    };

// Ogni evento raccoglie le morti delle creature prima di accodarne gli effetti.
export type DeathTriggerSource = {
  instance_id: string;
  card_id: string;
  owner_index: PlayerIndex;
  effect_indices: number[];
};
export type PendingDeathOrder = {
  choice_id: string;
  chooser_index: PlayerIndex;
  creatures: DeathTriggerSource[];
};
export type DeathOrderChoice = {
  choice_id: string;
  instance_ids: string[];
};

export type ResolveEffectWork = {
  kind: 'resolve_effect';
  owner: PlayerIndex;
  card_id: string;
  source_instance_id: string | null;
  source: 'on_play' | 'on_death' | 'trap' | 'aura_upkeep';
  effect_index: number;
  target_instance_id: string | null;
  require_source_on_board: boolean;
};
export type PendingTargetChoice = {
  choice_id: string;
  chooser_index: PlayerIndex;
  task: ResolveEffectWork;
  eligible_instance_ids: string[];
};
export type TargetChoice = {
  choice_id: string;
  target_instance_id: string;
};

// FIFO persistita: le scelte aperte risiedono nei rispettivi pending.
// Le Trappole non generano eventi dichiarati aggiuntivi (niente catene).
export type PendingWork =
  | { kind: 'declare_event'; event: PendingEvent }
  | { kind: 'apply_event'; event: PendingEvent }
  | ResolveEffectWork
  | { kind: 'finish_mostrissimo'; card_id: string; actor: PlayerIndex }
  | { kind: 'check_winner'; reason: string }
  | { kind: 'advance_ai' };

export type PendingMostrissimo = {
  player_index: PlayerIndex;
  card_id: string;
  offered_instance_id: string;
  required: number;
  paid: string[];
  freed_positions: Position[];
  stage: 'paying' | 'before_entry' | 'etb';
  position?: Position;
  target_instance_id?: string | null;
};
export type MostrissimoResult = {
  outcome: 'failed' | 'summoned';
  message: string;
};
export type AiProgress = {
  stage: 'upkeep' | 'actions' | 'end' | 'human_upkeep';
  actions_taken: number;
};

// Solo dati pubblici: mai mano, mazzo, carta pescata o valutazioni dell'IA.
// L'annuncio è salvato con lo stato che ha prodotto il checkpoint.
export type PublicAnnouncement = {
  id: string;
  kind: 'phase' | 'card' | 'action' | 'effect' | 'result';
  actor: PlayerIndex | null;
  text: string;
  turn: number;
  phase: TurnPhase;
  duration_ms: 1000;
  card_id?: string;
  instance_id?: string;
  position?: Position | null;
  from_position?: Position | null;
  to_position?: Position | null;
  target_instance_id?: string;
  target_player_index?: PlayerIndex;
  effect_index?: number;
  max_mana?: number;
};

export type GameState = {
  state_version: 4;
  state_revision: number;
  match_id: string;
  status: MatchStatus;
  players: [PlayerState, PlayerState];
  deck_colors: [DeckColors, DeckColors];
  board: SharedBoard;
  current_turn: number;
  active_player_index: PlayerIndex;
  phase: TurnPhase;
  anti_loop_counter: number;
  winner_index: PlayerIndex | null;
  shared_mostrissimi: CardInstance[];
  remaining_mostrissimi: string[];
  used_mostrissimi: string[];
  pending_mostrissimo?: PendingMostrissimo;
  pending_reaction?: PendingReaction;
  pending_death_order?: PendingDeathOrder;
  pending_target_choice?: PendingTargetChoice;
  work_queue: PendingWork[];
  ai_progress?: AiProgress;
  // Un solo annuncio corrente: l'ID consente il replay visivo dopo refresh.
  public_announcement?: PublicAnnouncement;
  last_mostrissimo_turn: Partial<Record<PlayerIndex, number>>;
  mostrissimo_result: MostrissimoResult | null;
};

export type MatchLogEntry = {
  turn: number;
  phase: TurnPhase;
  player_index: number;
  action_type: string;
  card_id?: string;
  instance_id?: string;
  target_instance_id?: string;
  target_player_index?: PlayerIndex;
  amount?: number;
  position?: Position | null;
  from_position?: Position | null;
  to_position?: Position | null;
  window_id?: string;
  description: string;
};
