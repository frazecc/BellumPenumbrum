// backend/engine.ts — API pubblica del motore Bellum Penumbrum.
// Mantiene invariati gli import esistenti da './engine.js' nel backend.
// Non pubblicare da solo: richiede backend/engine-core.ts nella stessa consegna.
export {
  saveGameState,
  logMatchAction,
  getCardData,
  createNewMatch,
  getMatchState,
  playCard,
  moveCreature,
  attack,
  startMostrissimoSummon,
  payMostrissimoSacrifice,
  completeMostrissimoSummon,
  resolveTrapChoice,
  endHumanTurn,
} from './engine-core.js';
