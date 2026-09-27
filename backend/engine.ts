// backend/engine.ts — API pubblica del motore Bellum Penumbrum.
// Mantiene invariati gli import esistenti da './engine.js' nel backend.
// Pubblicare insieme a backend/types.ts, backend/engine-core.ts,
// backend/api.ts e docs/js/game.js della consegna 3c.
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
  resolveDeathOrder,
  resolveTargetChoice,
  endHumanTurn,
} from './engine-core.js';
