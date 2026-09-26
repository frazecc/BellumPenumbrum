// backend/types.ts — contratto completo dello stato serializzato v3.
// Sostituisce 02_types.ts: la prima versione del file 2 non va caricata.
// Installare soltanto insieme ai corrispondenti engine.ts e api.ts v3.

export type PlayerIndex = 0 | 1;
export type MatchStatus = 'not_started' | 'running' | 'finished';
export type TurnPhase = 'start' | 'upkeep' | 'main' | 'end';
export type CardType = 'monster' | 'mostrissimo' | 'sorcery' | 'instant' | 'terraforma' | 'aura';
export type EffectType =
  | 'draw' | 'damage' | 'damage_creature' | 'heal' | 'discard'
  | 'return_hand' | 'destroy' | 'buff' | 'counter' | 'custom';
export type EffectTarget =
  | 'self' | 'opponent' | 'any_creature' | 'all_creatures'
  | 'all_creatures_self' | 'all_creatures_opponent' | 'spell';

// Valori di cards.effect_json.reaction_trigger.event. Il trigger non si
// ricava mai leggendo effect_text.
export type ReactionTriggerEvent =
  | 'opponent_action'
  | 'opponent_hand_card'
  | 'mostrissimo_before_entry'
  | 'monster_etb';
export type ReactionTrigger = { event: ReactionTriggerEvent };

export type EffectDefinition = {
  type: EffectType;
  amount?: number;
  target?: EffectTarget;
  timing?: 'on_play' | 'instant' | 'on_death';
  effect_id?: string;
  stat?: 'hp' | 'attack';
  duration?: 'turn' | 'permanent';
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
export type BoardCellAura = CardInstance;
export type BoardCellFieldSpell = CardInstance;
export type BoardCell = {
  instance_id: string;
  card_id: string;
  owner_index: PlayerIndex;
  attack: number;
  hp: number;
  max_hp: number;
  tired: boolean;
  auras: BoardCellAura[];
  temp_attack?: number;
};
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
  field_spell: BoardCellFieldSpell | null;
};
export type Position = { row: number; col: number };
export type AttackTarget =
  | { type: 'creature'; position: Position }
  | { type: 'player'; playerIndex: PlayerIndex };
export type PlayCardOptions = { position?: Position; targetInstanceId?: string };

// L'azione e' stata dichiarata ma non ancora applicata. I costi indicati sono
// gia' pagati e non sono rimborsati se la reazione annulla l'evento.
// Per le creature una verifica dopo la reazione controlla nuovamente la cella
// e l'identita' delle carte coinvolte.
export type PendingEvent =
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

// Coda FIFO persistita in game_state.state_json. Ogni voce si consuma una
// sola volta. Quando un effetto genera altre operazioni, queste vengono
// inserite DAVANTI alla coda restante e si salvano nello stesso commit.
// Un evento che apre una finestra e' in pending_reaction e NON si trova
// contemporaneamente come apply_event nella coda: al pass/trap si inserisce
// apply_event una sola volta (oppure si annulla esplicitamente).
export type PendingWork =
  | { kind: 'declare_event'; event: PendingEvent }
  | { kind: 'apply_event'; event: PendingEvent }
  | {
      kind: 'resolve_effect';
      owner: PlayerIndex;
      card_id: string;
      source_instance_id: string | null;
      source: 'on_play' | 'on_death' | 'trap';
      effect_index: number;
      target_instance_id: string | null;
      // Per ETB: se la fonte non e' piu' in campo, l'effetto salta.
      require_source_on_board: boolean;
    }
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

export type GameState = {
  state_version: 3;
  // La RPC commit_match_state incrementa atomicamente game_state.revision
  // e aggiorna questa copia nello JSON. L'engine non deve incrementarla.
  state_revision: number;
  match_id: string;
  status: MatchStatus;
  players: [PlayerState, PlayerState];
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
  // Deve essere vuota al termine di una richiesta, a meno che esista
  // pending_reaction; dopo una scelta si riprende dalla coda salvata.
  work_queue: PendingWork[];
  ai_progress?: AiProgress;
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
