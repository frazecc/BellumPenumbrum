// js/trap_preview.js — anteprima Trappole v4.
// Usare insieme a js/game.js v4: il pulsante contiene data-instance-id.
// La conferma richiama l'handler esistente: nessuna seconda finestra di gioco.
import { getAccessToken } from './auth.js';

const API = 'https://bellum-penumbrum-api.onrender.com';
let preview = null;
let confirmedClick = false;
let loading = false;

function escape(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
async function authorizedGet(path) {
  const token = await getAccessToken();
  if (!token) throw new Error('Sessione scaduta. Accedi di nuovo.');
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
  return json;
}
function closePreview() {
  preview?.remove();
  preview = null;
  document.body.classList.remove('trap-preview-open');
}
function showError(message) {
  const status = document.getElementById('game-message');
  if (status) { status.textContent = message; status.className = 'game-message error'; }
}
function sameButton(button, instanceId) {
  return button.isConnected && button.closest('#reaction-choices')
    && button.dataset.instanceId === instanceId;
}
async function previewTrap(button) {
  if (loading || preview) return;
  loading = true;
  try {
    const matchId = localStorage.getItem('bellum:last-match');
    if (!matchId) throw new Error('Partita non trovata.');
    const instanceId = button.dataset.instanceId;
    if (!instanceId) throw new Error('ID della Trappola mancante: aggiorna la partita.');

    const { state } = await authorizedGet(`/match/${encodeURIComponent(matchId)}`);
    const window = state?.pending_reaction;
    if (!window || window.responder_index !== 1 || !window.eligible_instance_ids?.includes(instanceId))
      throw new Error('Questa Trappola non è più disponibile: aggiorna la partita.');
    const inst = state.players?.[1]?.hand?.find(item => item.instance_id === instanceId);
    if (!inst || !sameButton(button, instanceId) || button.dataset.cardId !== inst.card_id)
      throw new Error('La mano o la finestra è cambiata: aggiorna la partita.');
    const { card } = await authorizedGet(`/cards/${encodeURIComponent(inst.card_id)}`);
    if (!card || card.card_type !== 'instant') throw new Error('Carta non valida per questa finestra.');

    const panel = document.createElement('div');
    panel.id = 'trap-full-preview'; panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', `Conferma Trappola ${card.name}`);
    panel.style.cssText = 'position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;padding:12px;background:#05050bf0;overflow:auto';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:min(96vw,480px);max-height:96dvh;display:flex;flex-direction:column;align-items:center;gap:10px';
    const face = document.createElement('div');
    face.style.cssText = 'width:min(92vw,420px);height:min(74dvh,650px);min-height:300px';
    const image = card.image_url ? `<img src="${escape(card.image_url)}" alt="Illustrazione di ${escape(card.name)}">` : '<span class="game-card-art-placeholder">🎴</span>';
    const text = escape(card.effect_text || 'Nessun effetto.').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    face.innerHTML = `<article class="game-card"><header class="game-card-titlebar"><span class="game-card-name">${escape(card.name)}</span><span class="game-card-cost">⚡${Number(card.mana_cost ?? 0)}</span></header><div class="game-card-art">${image}</div><div class="game-card-type-row"><span>TRAPPOLA</span><span class="game-card-subtype">${escape(card.subtype ?? '')}</span></div><div class="game-card-rules">${text}</div><div class="game-card-flavor">${escape(card.flavor_text ?? '')}</div><footer class="game-card-footer"><span class="game-card-rarity">${escape(card.rarity ?? '')}</span></footer></article>`;
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:center;gap:12px;flex-wrap:wrap;width:100%';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'secondary-button'; cancel.textContent = 'Annulla';
    cancel.style.minHeight = '44px'; cancel.onclick = closePreview;
    const confirm = document.createElement('button');
    confirm.type = 'button'; confirm.className = 'primary-button'; confirm.textContent = 'Conferma Trappola';
    confirm.style.minHeight = '44px';
    confirm.onclick = async () => {
      if (confirm.disabled) return;
      confirm.disabled = true;
      try {
        const currentMatchId = localStorage.getItem('bellum:last-match');
        if (currentMatchId !== matchId) throw new Error('È cambiata la partita: aggiorna la pagina.');
        const current = (await authorizedGet(`/match/${encodeURIComponent(matchId)}`)).state;
        if (current?.pending_reaction?.window_id !== window.window_id
          || current.pending_reaction.responder_index !== 1
          || !current.pending_reaction.eligible_instance_ids?.includes(instanceId)
          || !current.players?.[1]?.hand?.some(item => item.instance_id === instanceId && item.card_id === inst.card_id)
          || !sameButton(button, instanceId))
          throw new Error('La finestra o la mano è cambiata: aggiorna la partita.');
        closePreview();
        confirmedClick = true;
        try { button.click(); } finally { confirmedClick = false; }
      } catch (error) {
        showError(error instanceof Error ? error.message : 'Errore durante la conferma.');
        confirm.disabled = false;
      }
    };
    actions.append(cancel, confirm); wrap.append(face, actions); panel.append(wrap);
    panel.addEventListener('click', event => { if (event.target === panel) closePreview(); });
    document.body.append(panel); preview = panel;
    document.body.classList.add('trap-preview-open');
    cancel.focus();
  } finally { loading = false; }
}

// Capture blocca il clic iniziale. Dopo la conferma il medesimo pulsante
// riceve un solo clic, senza riaprire la preview o generare catene.
document.addEventListener('click', event => {
  const button = event.target instanceof Element ? event.target.closest('#reaction-choices > button[data-instance-id]') : null;
  if (!button || confirmedClick) return;
  event.preventDefault(); event.stopImmediatePropagation();
  previewTrap(button).catch(error => showError(error instanceof Error ? error.message : 'Impossibile aprire la Trappola.'));
}, true);

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && preview) {
    event.preventDefault(); event.stopImmediatePropagation(); closePreview();
  }
}, true);
