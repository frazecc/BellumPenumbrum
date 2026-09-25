import { getAccessToken, getCurrentUser, signOut, usernameFromEmail } from './auth.js';

const API = 'https://bellum-penumbrum-api.onrender.com';
const EMPTY = [[null, null, null], [null, null, null], [null, null, null]];
let state = null, matchId = null, handId = null, chosen = null, mode = null, busy = false, initialized = false;
const cache = new Map();
const el = id => document.getElementById(id);
const board = () => state?.board?.rows ?? EMPTY;
const cell = p => board()[p.row]?.[p.col] ?? null;
const human = () => state?.players?.[1];
const ai = () => state?.players?.[0];
const turn = () => state?.status === 'running' && state.active_player_index === 1 && state.phase === 'main';
const valid = p => p.row >= 0 && p.row < 3 && p.col >= 0 && p.col < 3;
const adjacent = p => [{ row: p.row - 1, col: p.col }, { row: p.row + 1, col: p.col }, { row: p.row, col: p.col - 1 }, { row: p.row, col: p.col + 1 }].filter(valid);
const targets = () => chosen ? adjacent(chosen).filter(p => cell(p)?.owner_index === 0) : [];
const moves = () => chosen && cell(chosen)?.owner_index === 1 && !cell(chosen)?.tired ? adjacent(chosen).filter(p => p.row !== 0 && !cell(p)) : [];
const same = (a, b) => a && b && a.row === b.row && a.col === b.col;
const escape = x => String(x ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const clear = () => { handId = null; chosen = null; mode = null; };
function message(text, kind = '') { const e = el('game-message'); if (e) { e.textContent = text; e.className = `game-message ${kind}`; } }
function controls() {
  const enabled = turn() && !busy;
  const ready = Boolean(chosen && cell(chosen)?.owner_index === 1 && !cell(chosen)?.tired && enabled);
  const set = (id, disabled) => { if (el(id)) el(id).disabled = disabled; };
  set('new-match-button', busy);
  set('end-turn-button', !enabled);
  set('refresh-button', busy || !matchId);
  set('choose-attack-button', !ready);
  set('choose-move-button', !ready || !human()?.current_mana || !moves().length);
  set('direct-attack-button', !enabled || mode !== 'attack' || targets().length > 0);
  set('cancel-selection-button', busy || (!chosen && !handId));
  if (el('selection-instructions')) el('selection-instructions').textContent = !state ? 'Premi Nuova partita per giocare.' : handId ? 'Carta selezionata: clicca una cella libera della riga Tu (riga 2), oppure una creatura se la carta richiede un bersaglio.' : mode === 'move' ? 'Clicca una cella verde: Muovi costa 1 mana, non stanca; la riga IA (0) resta inaccessibile.' : mode === 'attack' ? targets().length ? 'Clicca una creatura IA evidenziata.' : 'Nessun altro bersaglio valido: puoi attaccare direttamente.' : chosen ? 'Scegli Attacca (0 mana) oppure Muovi (1 mana).' : 'Seleziona una carta oppure clicca una tua creatura pronta.';
  const panel = el('creature-action-panel');
  if (panel) panel.classList.toggle('hidden', !ready);
  const c = chosen && cell(chosen);
  if (c && el('selected-creature-name')) el('selected-creature-name').textContent = cache.get(c.card_id)?.name ?? 'Creatura';
  if (c && el('selected-creature-details')) el('selected-creature-details').textContent = `ATK ${c.attack} · HP ${c.hp}/${c.max_hp} · ${c.tired ? 'Stanca' : 'Pronta'}`;
}
function setBusy(x) { busy = x; controls(); }
async function request(path, options = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error('Sessione scaduta: accedi nuovamente.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const res = await fetch(`${API}${path}`, { method: options.method ?? 'GET', headers: { Authorization: `Bearer ${token}`, ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: options.body !== undefined ? JSON.stringify(options.body) : undefined, signal: controller.signal });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error ?? `HTTP ${res.status}`);
    return result;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Server non raggiungibile entro 45 secondi. Verifica il deploy Render.');
    throw error;
  } finally { clearTimeout(timeout); }
}
async function card(id) {
  if (!cache.has(id)) { const result = await request(`/cards/${encodeURIComponent(id)}`); cache.set(id, result.card); }
  return cache.get(id);
}
async function renderBoard() {
  const root = el('shared-board');
  if (!root) { message('Manca #shared-board in docs/index.html: aggiorna anche il file HTML.', 'error'); return; }
  root.replaceChildren();
  for (let row = 0; row < 3; row++) {
    const wrap = document.createElement('div');
    wrap.className = `board-row ${['ai-row', 'center-row', 'human-row'][row]}`;
    for (let col = 0; col < 3; col++) {
      const p = { row, col }, c = cell(p);
      let definition = null;
      if (c) try { definition = await card(c.card_id); } catch (error) { console.warn('Carta non disponibile', error); }
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'board-cell';
      if (!c) button.classList.add('empty');
      else button.classList.add(c.owner_index === 1 ? 'human-card' : 'ai-card');
      if (c?.tired) button.classList.add('tired');
      if (same(p, chosen)) button.classList.add('selected-creature');
      if (mode === 'move' && moves().some(q => same(q, p))) button.classList.add('valid-move');
      if (mode === 'attack' && targets().some(q => same(q, p))) button.classList.add('valid-target');
      if (handId && row === 2 && !c) button.classList.add('valid-summon');
      button.setAttribute('aria-label', c ? `${definition?.name ?? 'Creatura'}: ${c.owner_index === 0 ? 'IA' : 'Tu'}, ${c.attack} attacco, ${c.hp} vita, ${c.tired ? 'stanca' : 'pronta'}, riga ${row} colonna ${col}` : `Cella libera, riga ${row} colonna ${col}`);
      button.innerHTML = c ? `<span class="cell-coordinate">[${row},${col}]</span><span class="card-type">${c.owner_index === 0 ? 'IA' : 'TU'} · ${c.tired ? 'STANCA' : 'PRONTA'}</span><strong class="card-name">${escape(definition?.name ?? 'Creatura')}</strong><span class="card-effect">${escape(definition?.effect_text ?? '')}</span><span class="card-stats">${c.attack} / ${c.hp}</span>` : `<span class="empty-label">${['Riga IA', 'Centro', 'Riga Tu'][row]}<br>[${row},${col}]</span>`;
      button.onclick = () => handleCell(p).catch(showError);
      wrap.append(button);
    }
    root.append(wrap);
  }
}
async function renderHand() {
  const root = el('player-hand'); if (!root) return;
  root.replaceChildren();
  for (const inst of human()?.hand ?? []) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'hand-card';
    try {
      const d = await card(inst.card_id);
      if (handId === inst.instance_id) button.classList.add('selected-hand-card');
      if (d.mana_cost > human().current_mana) button.classList.add('unaffordable');
      button.innerHTML = `<span class="card-cost">${escape(d.mana_cost)}</span><span class="card-type">${escape(d.card_type)}</span><strong class="card-name">${escape(d.name)}</strong><span class="card-effect">${escape(d.effect_text ?? '')}</span><span class="card-stats">${d.attack ?? '—'} / ${d.hp ?? '—'}</span>`;
      button.onclick = async () => {
        if (!turn() || busy) return;
        handId = handId === inst.instance_id ? null : inst.instance_id;
        chosen = null; mode = null;
        await render();
        if (handId && (d.card_type === 'sorcery' || d.card_type === 'instant' || d.card_type === 'terraforma') && d.effect_json?.target !== 'any_creature' && d.effect_json?.type !== 'return_hand') message('Clicca una cella qualunque della plancia per giocare questa carta.', 'success');
      };
    } catch (error) { button.textContent = `Carta non disponibile: ${error.message}`; button.disabled = true; }
    root.append(button);
  }
}
async function render() {
  if (el('match-status')) el('match-status').textContent = state ? state.status === 'finished' ? 'Terminata' : 'In corso' : 'Nessuna partita';
  if (el('turn-status')) el('turn-status').textContent = state ? `${state.current_turn} · ${state.active_player_index === 1 ? 'Tu' : 'IA'}` : '—';
  if (el('phase-status')) el('phase-status').textContent = state?.phase === 'main' ? 'Principale' : state?.phase ?? '—';
  for (const [id, value] of Object.entries({ 'player-life': human()?.life ?? 20, 'player-mana': `${human()?.current_mana ?? 0} / ${human()?.max_mana ?? 0}`, 'player-hand-count': human()?.hand?.length ?? 0, 'player-deck-count': human()?.deck?.length ?? 0, 'player-graveyard-count': human()?.graveyard?.length ?? 0, 'opponent-life': ai()?.life ?? 20, 'opponent-hand-count': ai()?.hand?.length ?? 0, 'opponent-deck-count': ai()?.deck?.length ?? 0, 'opponent-graveyard-count': ai()?.graveyard?.length ?? 0 })) if (el(id)) el(id).textContent = value;
  for (const [id, owner, label] of [['player-field-spell', human(), 'Tu'], ['opponent-field-spell', ai(), 'IA']]) {
    if (!el(id)) continue;
    let text = `${label}: Nessuna Terraforma`;
    if (owner?.field_spell) try { text = `${label}: ${(await card(owner.field_spell.card_id)).name}`; } catch { text = `${label}: Terraforma attiva`; }
    el(id).textContent = text;
  }
  await renderBoard(); await renderHand(); controls();
}
async function logs() {
  if (!el('match-logs') || !matchId) return;
  const { logs: events } = await request(`/match/${matchId}/logs?limit=100`);
  el('match-logs').replaceChildren();
  for (const e of events ?? []) { const li = document.createElement('li'); li.textContent = e.log_data?.description ?? e.log_data?.action_type ?? 'Evento'; el('match-logs').append(li); }
  el('match-logs').scrollTop = el('match-logs').scrollHeight;
}
async function action(path, body, success) {
  if (busy) return;
  setBusy(true);
  try {
    const result = await request(`/match/${matchId}/${path}`, { method: 'POST', body });
    state = result.state; clear();
    await render();
    try { await logs(); } catch (error) { console.warn('Log non aggiornato', error); }
    message(state.status === 'finished' ? state.winner_index === 1 ? 'Hai vinto!' : 'L’IA ha vinto.' : success, 'success');
  } catch (error) { showError(error); }
  finally { setBusy(false); }
}
async function handleCell(p) {
  if (!turn() || busy) return;
  const c = cell(p);
  if (handId) {
    const inst = human().hand.find(x => x.instance_id === handId);
    if (!inst) { clear(); return render(); }
    const d = await card(inst.card_id);
    let options = {};
    if (d.card_type === 'monster' || d.card_type === 'mostrissimo') {
      if (p.row !== 2 || c) return message('Evoca solo nelle celle libere della riga Tu, coordinate [2,0], [2,1], [2,2].', 'error');
      options = { position: p };
    } else if (d.card_type === 'aura' || d.effect_json?.target === 'any_creature' || d.effect_json?.type === 'return_hand') {
      if (!c) return message('Scegli una creatura bersaglio.', 'error');
      options = { targetInstanceId: c.instance_id };
    }
    return action('play-card', { cardInstanceId: inst.instance_id, options }, 'Carta giocata.');
  }
  if (mode === 'move') {
    if (!moves().some(q => same(q, p))) return message('Scegli una cella libera ortogonale, fuori dalla riga IA.', 'error');
    return action('move', { from: chosen, to: p }, 'Creatura spostata: -1 mana, rimane pronta.');
  }
  if (mode === 'attack') {
    if (!targets().some(q => same(q, p))) return message('Scegli una creatura IA ortogonalmente adiacente.', 'error');
    return action('attack', { attackerPosition: chosen, target: { type: 'creature', position: p } }, 'Attacco risolto.');
  }
  if (c?.owner_index === 1) {
    if (c.tired) return message('Questa creatura è stanca: non può attaccare né muoversi.', 'error');
    chosen = p; handId = null; mode = null; return render();
  }
  if (c?.owner_index === 0) message('Seleziona prima una tua creatura pronta.', 'error');
}
async function newMatch() {
  if (busy) return;
  setBusy(true); message('Creazione partita in corso…');
  try {
    const result = await request('/match/create', { method: 'POST', body: {} });
    matchId = result.match_id; state = result.state; clear();
    localStorage.setItem('bellum:last-match', matchId);
    await render();
    try { await logs(); } catch (error) { console.warn('Log non aggiornato', error); }
    message('Partita pronta: scegli un Mostro in mano e clicca una cella nella riga Tu.', 'success');
  } catch (error) { showError(error); } finally { setBusy(false); }
}
function showError(error) { console.error(error); message(error instanceof Error ? error.message : 'Errore sconosciuto.', 'error'); }
async function init() {
  if (initialized) return;
  const user = await getCurrentUser(); if (!user) return;
  initialized = true;
  const username = usernameFromEmail(user.email);
  if (el('signed-in-user')) el('signed-in-user').textContent = `@${username}`;
  if (el('player-title')) el('player-title').textContent = username || 'Tu';
  el('new-match-button')?.addEventListener('click', () => newMatch().catch(showError));
  el('choose-attack-button')?.addEventListener('click', () => { if (!chosen || busy) return; mode = 'attack'; render().catch(showError); });
  el('choose-move-button')?.addEventListener('click', () => { if (!chosen || busy) return; mode = 'move'; render().catch(showError); });
  el('direct-attack-button')?.addEventListener('click', () => { if (chosen && mode === 'attack' && !targets().length) action('attack', { attackerPosition: chosen, target: { type: 'player', playerIndex: 0 } }, 'Attacco diretto risolto.'); });
  for (const id of ['cancel-creature-action-button', 'cancel-selection-button']) el(id)?.addEventListener('click', () => { clear(); render().catch(showError); });
  el('end-turn-button')?.addEventListener('click', () => { if (busy || !turn()) return; message('L’IA sta giocando…'); action('end-turn', {}, 'È di nuovo il tuo turno.'); });
  el('refresh-button')?.addEventListener('click', async () => { if (busy || !matchId) return; setBusy(true); try { state = (await request(`/match/${matchId}`)).state; await render(); await logs(); message('Stato aggiornato.', 'success'); } catch (error) { showError(error); } finally { setBusy(false); } });
  el('logout-button')?.addEventListener('click', () => { signOut().then(() => { matchId = null; state = null; clear(); }).catch(showError); });
  await render();
  const previous = localStorage.getItem('bellum:last-match');
  if (previous) {
    try { const result = await request(`/match/${previous}`); if (result.state?.state_version === 2 && result.state.players?.[1]?.user_id === user.id) { matchId = previous; state = result.state; await render(); await logs(); message('Partita precedente ripristinata.', 'success'); } }
    catch (error) { console.warn('Partita precedente non ripristinata', error); }
  }
}
window.addEventListener('bellum:auth-ready', () => init().catch(showError));
getCurrentUser().then(user => { if (user) return init(); }).catch(showError);
