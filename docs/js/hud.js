import { getAccessToken } from './auth.js';

const API = 'https://bellum-penumbrum-api.onrender.com';
const $ = id => document.getElementById(id);
let timer = null;
let requestInFlight = false;
let refreshAgain = false;
let observed = false;

function set(id, value) {
  const element = $(id);
  if (element && element.textContent !== String(value)) element.textContent = String(value);
}

function updateHumanMana() {
  const source = $('player-mana')?.textContent ?? '';
  const values = source.match(/(\d+)\s*\/\s*(\d+)/);
  if (!values) return;
  set('player-current-mana', values[1]);
  set('player-max-mana', values[2]);
}

async function updateAIMana() {
  const matchId = localStorage.getItem('bellum:last-match');
  if (!matchId || requestInFlight) {
    if (requestInFlight) refreshAgain = true;
    return;
  }
  requestInFlight = true;
  try {
    const token = await getAccessToken();
    if (!token) return;
    const response = await fetch(`${API}/match/${encodeURIComponent(matchId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store'
    });
    if (!response.ok) return;
    const json = await response.json();
    if (localStorage.getItem('bellum:last-match') !== matchId) return;
    const ai = json.state?.players?.[0];
    if (!ai) return;
    set('opponent-current-mana', ai.current_mana ?? 0);
    set('opponent-max-mana', ai.max_mana ?? 0);
  } catch (error) {
    console.warn('HUD: mana IA non aggiornato', error);
  } finally {
    requestInFlight = false;
    if (refreshAgain) {
      refreshAgain = false;
      scheduleUpdate();
    }
  }
}

function scheduleUpdate() {
  updateHumanMana();
  clearTimeout(timer);
  timer = setTimeout(() => { void updateAIMana(); }, 400);
}

function startObservers() {
  if (observed) return;
  const source = $('player-mana');
  const board = $('shared-board');
  const turn = $('turn-status');
  if (!source || !board || !turn) return;
  observed = true;
  const observer = new MutationObserver(scheduleUpdate);
  for (const target of [source, board, turn]) {
    observer.observe(target, { childList: true, characterData: true, subtree: true });
  }
  scheduleUpdate();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startObservers, { once: true });
} else {
  startObservers();
}
window.addEventListener('bellum:auth-ready', scheduleUpdate);
