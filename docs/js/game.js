// docs/js/game.js — Bellum Penumbrum v4, bersaglio unico ETB (3d).
import { getAccessToken, getCurrentUser, signOut, usernameFromEmail } from './auth.js';

const API = 'https://bellum-penumbrum-api.onrender.com';
const $ = id => document.getElementById(id);
const cache = new Map();
let state = null, matchId = null, busy = false, initialized = false, view = null, flow = null;
let deathDraft = { choiceId: null, instanceIds: [] };
let presentationRunning = false, presentationGeneration = 0;
const waitPresentation = ms => new Promise(resolve => setTimeout(resolve,ms));
const board = () => state?.board?.rows ?? [[null,null,null],[null,null,null],[null,null,null]];
const at = p => board()[p.row]?.[p.col] ?? null;
const me = () => state?.players?.[1];
const them = () => state?.players?.[0];
const reaction = () => state?.pending_reaction?.responder_index === 1 ? state.pending_reaction : null;
const deathOrder = () => state?.pending_death_order?.chooser_index === 1 ? state.pending_death_order : null;
const deathTarget = () => state?.pending_target_choice?.chooser_index === 1 ? state.pending_target_choice : null;
const obligatory = () => !!state?.pending_death_order || !!state?.pending_target_choice;
const turn = () => state?.status === 'running' && state.active_player_index === 1 && state.phase === 'main';
const pending = () => state?.pending_mostrissimo?.player_index === 1 ? state.pending_mostrissimo : null;
const active = () => turn() && !busy && !pending() && !state?.pending_reaction && !obligatory() && !(state?.work_queue?.length);
const inside = p => p.row >= 0 && p.row < 3 && p.col >= 0 && p.col < 3;
const around = p => [{row:p.row-1,col:p.col},{row:p.row+1,col:p.col},{row:p.row,col:p.col-1},{row:p.row,col:p.col+1}].filter(inside);
const eq = (a,b) => !!(a && b && a.row === b.row && a.col === b.col);
const isCreatureCell = c => c?.kind === 'creature';
const foes = p => around(p).filter(q => isCreatureCell(at(q)) && at(q).owner_index === 0);
const steps = p => around(p).filter(q => q.row !== 0 && !at(q));
const escape = x => String(x ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const creature = d => ['monster','mostrissimo'].includes(d.card_type);
const effects = d => Array.isArray(d?.effect_json?.effects) ? d.effect_json.effects : d?.effect_json?.type ? [d.effect_json] : [];
const targetEffect = d => effects(d).find(e => e?.target === 'any_creature' || e?.type === 'return_hand');
const factions = ['','CHI','INF','PES','BUL','GRO','CLO','IND'];
const deckFactionNames = {CHI:'Chiericanza',INF:'Infamia',PES:'Pestilenza',BUL:'Bullismo',GRO:'Grossanza',CLO:'Clownerie'};
const types = {monster:'MOSTRO',mostrissimo:'MOSTRISSIMO',maledizione:'MALEDIZIONE',instant:'TRAPPOLA',terraforma:'TERRAFORMA',aura:'AURA'};
const rarities = {common:'Comune',uncommon:'Non comune',rare:'Rara',ultra_rare:'Ultra rara',legendary:'Leggendaria'};
const faction = d => {
  const code = String(d?.faction_code ?? factions[Number(d?.faction_id)] ?? 'IND').toLowerCase();
  return ['chi','inf','pes','bul','gro','clo','ind'].includes(code) ? code : 'ind';
};
function cardHTML(d, mini = false, cell = null) {
  const cls = `faction-${faction(d)}`;
  const cost = d.card_type === 'mostrissimo' ? `✦${Number(d.sacrifice_cost ?? 0)}` : `⚡${Number(d.mana_cost ?? 0)}`;
  const art = d.image_url ? `<img src="${escape(d.image_url)}" alt="Illustrazione di ${escape(d.name)}" loading="lazy">` : '<span class="game-card-art-placeholder">🎴</span>';
  const atk = cell?.attack ?? d.attack ?? 0, hp = cell?.hp ?? d.hp ?? 0;
  if (mini) return `<article class="board-card ${cls}"><header class="board-card-titlebar"><span class="board-card-name">${escape(d.name)}</span><span class="board-card-cost">${cost}</span></header><div class="board-card-art">${art}</div><div class="board-card-type">${escape(types[d.card_type] ?? d.card_type)}</div><div class="board-card-effect">${escape(String(d.effect_text ?? '').replace(/\*\*/g,'').replace(/\s+/g,' ').slice(0,110))}</div>${creature(d) ? `<footer class="board-card-footer"><span>⚔ ${atk}</span><span>❤ ${hp}</span></footer>` : ''}</article>`;
  const rules = escape(d.effect_text || 'Nessun effetto.').replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>');
  return `<article class="game-card ${cls}"><header class="game-card-titlebar"><span class="game-card-name">${escape(d.name)}</span><span class="game-card-cost">${cost}</span></header><div class="game-card-art">${art}</div><div class="game-card-type-row"><span>${escape(types[d.card_type] ?? d.card_type)}</span><span class="game-card-subtype">${escape(d.subtype ?? '')}</span></div><div class="game-card-rules">${rules}</div><div class="game-card-flavor">${escape(d.flavor_text ?? '')}</div><footer class="game-card-footer"><span class="game-card-rarity">${escape(rarities[d.rarity] ?? d.rarity ?? 'Comune')}</span>${creature(d) ? `<span class="game-card-stats"><span class="game-card-atk">⚔ ${atk}</span><span class="game-card-hp">❤ ${hp}</span></span>` : ''}</footer></article>`;
}
// Durante monster_etb la Trappola mirata può colpire soltanto la fonte
// dell'ETB. Le altre finestre conservano le regole ordinarie di bersaglio.
function targetAllowed(d,c,event=null) {
  if (!isCreatureCell(c)) return false;
  if (d.card_type === 'aura') return true;
  const e = targetEffect(d);
  if (!e) return false;
  if (event?.kind === 'monster_etb' && c.instance_id !== event.source_instance_id) return false;
  if (['damage','damage_creature'].includes(e.type) && e.timing !== 'instant') return c.owner_index === 0;
  if (e.type === 'heal' && e.timing !== 'instant') return c.owner_index === 1;
  return true;
}
function targets(d) {
  const found = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const cell = at({row,col});
    if (targetAllowed(d,cell)) found.push(cell);
  }
  return found;
}
function permanents() {
  const found = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const c = at({row,col});
    if (!c) continue;
    if (c.owner_index === 1) found.push({id:c.instance_id,card_id:c.card_id,type:c.kind === 'terraforma' ? 'Terraforma' : 'Creatura'});
    if (isCreatureCell(c)) for (const a of c.auras ?? []) if (a.owner_index === 1) found.push({id:a.instance_id,card_id:a.card_id,type:'Aura'});
  }
  return found;
}
function bossCells(p) {
  if (!p) return [];
  const found = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const pos = {row,col};
    if (!at(pos) && (row === 2 || (row === 1 && (p.freed_positions ?? []).some(x => eq(x,pos))))) found.push(pos);
  }
  return found;
}
function notice(text,type='') {
  if ($('game-message')) { $('game-message').textContent = text; $('game-message').className = `game-message ${type}`; }
}
function fail(e) { console.error(e); notice(e instanceof Error ? e.message : 'Errore inatteso','error'); }
function close() { view = null; $('card-detail-overlay')?.classList.add('hidden'); document.body.classList.remove('detail-open'); }
async function api(path,options={}) {
  const token = await getAccessToken();
  if (!token) throw new Error('Sessione scaduta, accedi di nuovo.');
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(),45000);
  try {
    const res = await fetch(`${API}${path}`,{
      method:options.method ?? 'GET',
      headers:{Authorization:`Bearer ${token}`,...(options.body !== undefined ? {'Content-Type':'application/json'} : {})},
      body:options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal:abort.signal,cache:'no-store',
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  } catch(e) {
    if (e?.name === 'AbortError') throw new Error('Render non risponde entro 45 secondi. Aggiorna prima di riprovare: la richiesta potrebbe essere stata salvata.');
    throw e;
  } finally { clearTimeout(timer); }
}
async function card(id) {
  if (!cache.has(id)) cache.set(id,(await api(`/cards/${encodeURIComponent(id)}`)).card);
  return cache.get(id);
}
async function moveCost(cell) {
  for (const aura of cell?.auras ?? []) {
    const d = await card(aura.card_id);
    if (effects(d).some(e => e.type === 'movement_cost' && e.duration === 'while_attached' && e.target === 'enchanted_creature' && e.amount === 0)) return 0;
  }
  return 1;
}
function button(text,fn,disabled=false) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'primary-button'; b.textContent = text; b.disabled = disabled;
  b.onclick = () => Promise.resolve(fn()).catch(fail);
  return b;
}
function overlay() {
  let el = $('card-detail-overlay');
  if (el) return el;
  el = document.createElement('div'); el.id = 'card-detail-overlay'; el.className = 'card-detail-overlay hidden';
  el.setAttribute('role','dialog'); el.setAttribute('aria-modal','true');
  el.innerHTML = '<div class="detail-stage"><div class="detail-image" id="detail-image"></div><div class="detail-actions" id="detail-actions"></div></div>';
  el.onclick = e => { if (e.target === el) close(); };
  document.body.append(el); return el;
}
function reactionDialog() {
  let el = $('reaction-dialog');
  if (el) return el;
  el = document.createElement('div'); el.id = 'reaction-dialog'; el.className = 'card-detail-overlay hidden';
  el.setAttribute('role','dialog'); el.setAttribute('aria-modal','true'); el.setAttribute('aria-label','Finestra reattiva');
  const stage = document.createElement('div'); stage.className = 'panel'; stage.style.cssText = 'width:min(94vw,720px);max-height:90dvh;overflow:auto;text-align:center;border-color:#d5a758;box-shadow:0 12px 48px #000';
  const title = document.createElement('h2'); title.id = 'reaction-title'; title.textContent = 'Finestra reattiva';
  const text = document.createElement('p'); text.id = 'reaction-description';
  const choices = document.createElement('div'); choices.id = 'reaction-choices'; choices.style.cssText = 'display:flex;gap:.5rem;flex-wrap:wrap;justify-content:center;align-items:stretch;margin:.7rem 0';
  const actions = document.createElement('div'); actions.id = 'reaction-actions';
  stage.append(title,text,choices,actions); el.append(stage); document.body.append(el); return el;
}
function choiceDialog() {
  let el = $('death-choice-dialog');
  if (el) return el;
  el = document.createElement('div'); el.id = 'death-choice-dialog'; el.className = 'card-detail-overlay hidden';
  el.setAttribute('role','dialog'); el.setAttribute('aria-modal','true'); el.setAttribute('aria-labelledby','death-choice-title');
  el.style.zIndex = '150';
  const panel = document.createElement('div'); panel.className = 'panel';
  panel.style.cssText = 'width:min(94vw,740px);max-height:90dvh;overflow:auto;text-align:center;border-color:#d5a758;box-shadow:0 12px 48px #000';
  const title = document.createElement('h2'); title.id = 'death-choice-title';
  const text = document.createElement('p'); text.id = 'death-choice-description';
  const choices = document.createElement('div'); choices.id = 'death-choice-options';
  choices.style.cssText = 'display:flex;gap:.6rem;flex-wrap:wrap;justify-content:center;margin:.8rem 0';
  const actions = document.createElement('div'); actions.id = 'death-choice-actions';
  panel.append(title,text,choices,actions); el.append(panel); document.body.append(el);
  // Nessun click sullo sfondo o Escape può annullare una scelta obbligatoria.
  return el;
}
async function renderDeathChoice() {
  const el = choiceDialog(), order = deathOrder(), selected = deathTarget();
  if (!state || state.status !== 'running' || busy || (!order && !selected)) { el.classList.add('hidden'); return; }
  close(); closeGraveyard(); reactionDialog().classList.add('hidden');
  const title = $('death-choice-title'), text = $('death-choice-description');
  const options = $('death-choice-options'), actions = $('death-choice-actions');
  options.replaceChildren(); actions.replaceChildren();
  if (order) {
    if (deathDraft.choiceId !== order.choice_id) deathDraft = {choiceId:order.choice_id,instanceIds:[]};
    const creatures = order.creatures ?? [], chosen = deathDraft.instanceIds;
    title.textContent = 'Ordine degli effetti alla morte';
    text.textContent = `Scegli la prossima creatura (${chosen.length + 1}/${creatures.length}). Gli effetti di ogni creatura restano nell’ordine scritto sulla carta.`;
    for (const source of creatures) {
      if (chosen.includes(source.instance_id)) continue;
      const d = await card(source.card_id);
      if (deathOrder()?.choice_id !== order.choice_id) return;
      const b = button(`${d.name} · ${source.owner_index === 1 ? 'tua' : 'IA'} · ${source.effect_indices?.length ?? 0} effetti`, async () => {
        if (busy || deathOrder()?.choice_id !== order.choice_id) return;
        deathDraft.instanceIds.push(source.instance_id);
        if (deathDraft.instanceIds.length === creatures.length) {
          const instanceIds = [...deathDraft.instanceIds];
          await request('death/order',{choiceId:order.choice_id,instanceIds},'Ordine degli effetti alla morte confermato.');
        } else await renderDeathChoice();
      });
      options.append(b);
    }
    if (chosen.length) actions.append(button('Ricomincia ordine',async () => {
      deathDraft = {choiceId:order.choice_id,instanceIds:[]}; await renderDeathChoice();
    }));
  } else if (selected) {
    deathDraft = {choiceId:null,instanceIds:[]};
    const d = await card(selected.task.card_id);
    if (deathTarget()?.choice_id !== selected.choice_id) return;
    title.textContent = 'Bersaglio dell’effetto alla morte';
    text.textContent = `${d.name}: scegli una creatura bersaglio. La scelta è obbligatoria e si risolve prima dell’effetto successivo.`;
    for (const instanceId of selected.eligible_instance_ids ?? []) {
      let found = null;
      for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
        const cell = at({row,col});
        if (cell?.kind === 'creature' && cell.instance_id === instanceId) found = {cell,row,col};
      }
      if (!found) continue;
      const targetCard = await card(found.cell.card_id);
      if (deathTarget()?.choice_id !== selected.choice_id) return;
      const b = button(`${targetCard.name} · ${found.cell.owner_index === 1 ? 'tua' : 'IA'} · [${found.row},${found.col}] · HP ${found.cell.hp}`,() => {
        if (busy || deathTarget()?.choice_id !== selected.choice_id) return;
        return request('death/target',{choiceId:selected.choice_id,targetInstanceId:instanceId},'Effetto alla morte risolto.');
      });
      options.append(b);
    }
    if (!options.childElementCount) text.textContent = 'Nessun bersaglio visibile: aggiorna la partita per recuperare lo stato.';
  }
  el.classList.remove('hidden');
}
function reactionDescription(e) {
  const names = {
    upkeep_start:'Inizia il MANATENIMENTO avversario, prima di mana, risveglio e pesca.',
    upkeep_end:'Il MANATENIMENTO avversario sta terminando, prima della fase principale.',
    hand_card:'L’avversario ha dichiarato una carta dalla mano.',
    move:'L’avversario ha dichiarato un movimento.',attack:'L’avversario ha dichiarato un attacco.',
    mostrissimo_sacrifice:'L’avversario ha dichiarato un sacrificio.',
    mostrissimo_before_entry:'Il Mostrissimo ha pagato i sacrifici e sta per entrare nella cella scelta.',
    monster_etb:'Sta per risolversi un ETB di una creatura avversaria.',
  };
  return names[e?.kind] ?? 'L’avversario ha dichiarato un’azione.';
}
// Il popup non modifica lo stato: la richiesta /advance parte solo dopo
// che il checkpoint server-side è stato presentato per un secondo.
function presentationLayer() {
  let layer = $('public-checkpoint-layer');
  if (layer) return layer;
  layer = document.createElement('div'); layer.id = 'public-checkpoint-layer';
  Object.assign(layer.style,{position:'fixed',inset:'0',zIndex:'9999',display:'none',
    alignItems:'center',justifyContent:'center',background:'rgba(5,6,18,.78)',
    padding:'20px',boxSizing:'border-box',pointerEvents:'auto'});
  document.body.append(layer); return layer;
}
async function presentPublic(a, generation) {
  const layer = presentationLayer(); layer.replaceChildren();
  const panel = document.createElement('div');
  Object.assign(panel.style,{width:'min(440px,95vw)',maxHeight:'90vh',overflowY:'auto',
    background:'#171426',color:'#f7eedc',border:'2px solid #a78355',borderRadius:'14px',
    padding:'22px',boxShadow:'0 15px 60px #000',textAlign:'center',fontSize:'1.15rem'});
  const title = document.createElement('div');
  title.textContent = a.kind === 'phase'
    ? `Turno ${a.turn} · ${a.phase === 'upkeep' ? 'MANATENIMENTO' : a.phase === 'main' ? 'PRINCIPALE' : a.phase === 'end' ? 'FINE' : 'INIZIO'} · Mana massimo ${a.max_mana ?? 0}`
    : a.text;
  panel.append(title);
  if (a.kind === 'card' && a.card_id) {
    try { const d = await card(a.card_id); if (generation !== presentationGeneration) return;
      const box = document.createElement('div'); box.style.margin = '14px auto';
      box.innerHTML = cardHTML(d); panel.append(box);
    } catch(e) { console.warn('Anteprima della carta non disponibile',e); }
  }
  if (a.kind !== 'phase' && a.position) {
    const cell = document.createElement('div'); cell.textContent = `Cella [${a.position.row},${a.position.col}]`;
    panel.append(cell);
  }
  layer.append(panel); layer.style.display = 'flex';
  await waitPresentation(1000);
  if (generation === presentationGeneration) layer.style.display = 'none';
}
function queuePresentation() {
  if (presentationRunning || !matchId || !state?.public_announcement) return;
  const generation = presentationGeneration;
  presentationRunning = true;
  void (async () => {
    try {
      while (generation === presentationGeneration && matchId && state?.public_announcement) {
        const a = state.public_announcement, id = matchId;
        await presentPublic(a,generation);
        if (generation !== presentationGeneration || matchId !== id) break;
        if (state.status !== 'running' || state.pending_reaction || obligatory() || !state.work_queue?.length) break;
        busy = true; controls();
        try {
          state = (await api(`/match/${encodeURIComponent(id)}/advance`,
            {method:'POST',body:{expectedAnnouncementId:a.id}})).state;
          await render(); await logs();
        } catch(e) {
          fail(e);
          try { state = (await api(`/match/${encodeURIComponent(id)}`)).state; await render(); } catch(refreshError) { console.warn(refreshError); }
          break;
        } finally { busy = false; await render().catch(fail); }
        if (state.public_announcement?.id === a.id) break;
      }
    } finally { presentationRunning = false; }
  })();
}
async function renderReaction() {
  const el = reactionDialog(), r = reaction();
  if (!r || busy || obligatory() || flow?.kind === 'trap-target') { el.classList.add('hidden'); return; }
  $('reaction-title').textContent = r.event?.kind === 'monster_etb' || r.event?.kind === 'mostrissimo_before_entry' ? 'Finestra NOPE / Trappola' : 'Finestra Trappola';
  const evt = r.event;
  let declared = '';
  if (evt?.card_id) {
    try { const d = await card(evt.card_id);
      declared = ` Carta: ${d.name}. Costo ${d.card_type === 'mostrissimo' ? d.sacrifice_cost + ' sacrifici' : d.mana_cost + ' mana'}. ${d.effect_text ?? ''}`;
    } catch(e) { console.warn(e); }
  }
  const position = evt?.options?.position ?? evt?.position;
  $('reaction-description').textContent = reactionDescription(evt) + declared
    + (position ? ` Cella [${position.row},${position.col}].` : '');
  const choices = $('reaction-choices'); choices.replaceChildren();
  for (const instId of r.eligible_instance_ids ?? []) {
    const inst = me()?.hand?.find(x => x.instance_id === instId);
    if (!inst) continue;
    const d = await card(inst.card_id);
    const b = document.createElement('button'); b.type = 'button'; b.className = 'hand-card reaction-card';
    b.dataset.instanceId = inst.instance_id; b.dataset.cardId = d.id; b.innerHTML = cardHTML(d,true);
    b.setAttribute('aria-label',`Gioca ${d.name} in risposta`);
    b.onclick = () => beginTrap(inst,d).catch(fail); choices.append(b);
  }
  const actions = $('reaction-actions'); actions.replaceChildren();
  actions.append(button('Passa',() => chooseTrap({windowId:r.window_id,action:'pass'})));
  el.classList.remove('hidden');
}
async function chooseTrap(choice) {
  const r = reaction();
  if (!r || r.window_id !== choice.windowId) return notice('Finestra scaduta: aggiorna la partita.','error');
  return request('trap/choice',choice,choice.action === 'pass' ? 'Hai passato la priorità.' : 'Trappola risolta.');
}
async function beginTrap(inst,d) {
  const r = reaction();
  if (!r || !r.eligible_instance_ids.includes(inst.instance_id) || busy) return;
  if (targetEffect(d)) {
    flow = {kind:'trap-target',windowId:r.window_id,instanceId:inst.instance_id,id:d.id};
    reactionDialog().classList.add('hidden');
    await render(); notice(r.event?.kind === 'monster_etb' ? 'Scegli la creatura che ha generato l’ETB.' : `Scegli la creatura bersaglio di ${d.name}.`, 'success'); return;
  }
  await chooseTrap({windowId:r.window_id,action:'play',cardInstanceId:inst.instance_id});
}
function graveyardDialog() {
  let el = $('graveyard-dialog');
  if (el) return el;
  el = document.createElement('div'); el.id = 'graveyard-dialog'; el.className = 'card-detail-overlay hidden';
  el.setAttribute('role','dialog'); el.setAttribute('aria-modal','true'); el.setAttribute('aria-labelledby','graveyard-title'); el.style.zIndex = '120';
  const panel = document.createElement('div'); panel.className = 'panel'; panel.style.cssText = 'width:min(94vw,720px);max-height:88dvh;overflow:auto;border-color:#c6a774;text-align:center;box-shadow:0 12px 48px #000';
  const title = document.createElement('h2'); title.id = 'graveyard-title';
  const list = document.createElement('div'); list.id = 'graveyard-cards'; list.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:center;gap:.55rem;margin:.7rem 0;max-height:60dvh;overflow:auto';
  const actions = document.createElement('div'); actions.style.cssText = 'display:flex;justify-content:center'; actions.append(button('Chiudi',closeGraveyard));
  panel.append(title,list,actions); el.append(panel);
  el.addEventListener('click',e => { if (e.target === el) closeGraveyard(); });
  document.body.append(el); return el;
}
function closeGraveyard() { $('graveyard-dialog')?.classList.add('hidden'); }
async function openGraveyard(owner) {
  if ((owner !== 0 && owner !== 1) || !state || busy || obligatory()) return;
  const el = graveyardDialog(), title = $('graveyard-title'), list = $('graveyard-cards');
  const cards = state.players?.[owner]?.graveyard ?? [];
  title.textContent = `${owner === 1 ? 'Il tuo cimitero' : 'Cimitero dell’IA'} · ${cards.length}`;
  list.replaceChildren();
  if (!cards.length) { const empty = document.createElement('p'); empty.textContent = 'Cimitero vuoto.'; list.append(empty); }
  else for (const inst of cards) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'hand-card'; b.style.cssText = 'flex:0 0 125px;width:125px;height:175px';
    try {
      const d = await card(inst.card_id); b.innerHTML = cardHTML(d,true);
      b.setAttribute('aria-label',`Apri ${d.name} nel cimitero`);
      b.onclick = () => { closeGraveyard(); inspect('grave',inst.card_id).catch(fail); };
    } catch (error) { b.textContent = 'Carta non caricabile'; b.disabled = true; console.warn(error); }
    list.append(b);
  }
  el.classList.remove('hidden');
}
function wireGraveyards() {
  for (const [id,owner] of [['opponent-graveyard-count',0],['player-graveyard-count',1]]) {
    const box = $(id)?.closest('.hud-value.grave');
    if (!box || box.dataset.graveyardReady) continue;
    box.dataset.graveyardReady = 'true'; box.setAttribute('role','button'); box.setAttribute('tabindex','0');
    box.setAttribute('aria-label',`Apri ${owner === 1 ? 'il tuo cimitero' : 'il cimitero dell’IA'}`);
    box.style.cursor = 'pointer'; box.addEventListener('click',() => openGraveyard(owner).catch(fail));
    box.addEventListener('keydown',e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGraveyard(owner).catch(fail); } });
  }
}
async function inspect(kind,id,extra={}) {
  if (busy || obligatory() || (reaction() && kind !== 'grave')) return;
  view = {kind,id,...extra};
  const current = view, d = await card(id);
  if (current !== view) return;
  overlay(); $('detail-image').innerHTML = cardHTML(d,false,current.cell ?? null);
  const bar = $('detail-actions'); bar.replaceChildren();
  const add = (text,fn,disabled=false) => bar.append(button(text,fn,disabled));
  if (kind === 'hand' && active()) add(d.card_type === 'monster' ? 'Evoca' : d.card_type === 'terraforma' ? 'Colloca' : 'Gioca',() => beginCard(current.instanceId,d),!playable(d));
  if (kind === 'boss' && active() && state.last_mostrissimo_turn?.[1] !== state.current_turn) {
    const cost = Number(d.sacrifice_cost), own = board().flat().filter(c => isCreatureCell(c) && c.owner_index === 1).length;
    const legal = Number.isInteger(cost) && cost >= 0 && cost <= 6 && permanents().length >= cost && (board()[2].some(c => !c) || (cost > 0 && own > 0));
    add(`Evoca · ${cost} sacrifici`,() => request('mostrissimo/start',{cardId:id},'Evocazione iniziata: non puoi annullare.'),!legal);
  }
  if (kind === 'unit' && active() && isCreatureCell(current.cell) && current.cell.owner_index === 1 && !current.cell.tired) {
    const direct = foes(current.position).length === 0;
    add(direct ? 'Attacca direttamente IA' : 'Attacca · 0 mana',() => {
      if (direct) return request('attack',{attackerPosition:current.position,target:{type:'player',playerIndex:0}},'Attacco dichiarato.');
      flow = {kind:'attack',from:current.position}; close(); render().catch(fail); notice('Tocca il nemico evidenziato.','success');
    });
    const cost = await moveCost(current.cell);
    if (current !== view) return;
    add(`Muovi · ${cost} mana`,() => { flow = {kind:'move',from:current.position}; close(); render().catch(fail); notice('Tocca una cella libera adiacente.','success'); },Number(me()?.current_mana ?? 0) < cost || !steps(current.position).length);
  }
  if (kind === 'unit' && isCreatureCell(current.cell) && current.cell.auras?.length) {
    for (const aura of current.cell.auras) {
      const a = await card(aura.card_id);
      if (current !== view) return;
      add(`Aura ${a.name}${aura.owner_index === 1 ? ' · tua' : ' · IA'}`,() => { close(); return inspect('aura',aura.card_id,{instanceId:aura.instance_id}); });
    }
  }
  if (kind === 'tribute' && pending() && pending().stage === 'paying' && pending().paid.length < pending().required) add('Conferma sacrificio',() => request('mostrissimo/sacrifice',{instanceId:current.instanceId},'Sacrificio dichiarato.'));
  add('Chiudi',close);
  $('card-detail-overlay').classList.remove('hidden'); document.body.classList.add('detail-open');
}
async function beginCard(instanceId,d) {
  if (!playable(d)) return;
  close(); flow = {kind:'hand',instanceId,id:d.id,step:(d.card_type === 'monster' || d.card_type === 'terraforma') ? 'cell' : (d.card_type === 'aura' || targetEffect(d)) ? 'target' : 'immediate'};
  if (flow.step === 'immediate') return request('play-card',{cardInstanceId:instanceId,options:{}},'Carta dichiarata.');
  await render(); notice(flow.step === 'cell' ? 'Scegli una cella libera della tua riga.' : 'Scegli una creatura bersaglio.','success');
}
function playable(d) {
  if (!active() || d.card_type === 'mostrissimo' || d.card_type === 'instant' || Number(d.mana_cost) > me().current_mana) return false;
  if ((d.card_type === 'monster' || d.card_type === 'terraforma') && !board()[2].some(c => !c)) return false;
  if (d.card_type === 'aura' && !targets(d).length) return false;
  if (!creature(d) && d.card_type !== 'aura' && targetEffect(d) && !targets(d).length) return false;
  return true;
}
async function drawBoard() {
  const root = $('shared-board'); if (!root) return;
  root.replaceChildren();
  const p = pending(), legal = p?.stage === 'paying' && p.paid.length === p.required ? bossCells(p) : [];
  const d = flow?.id ? cache.get(flow.id) : null;
  for (let row = 0; row < 3; row++) {
    const line = document.createElement('div'); line.className = `board-row ${['ai-row','center-row','human-row'][row]}`;
    for (let col = 0; col < 3; col++) {
      const pos = {row,col}, c = at(pos), b = document.createElement('button');
      b.type = 'button'; b.className = 'board-cell';
      let definition = null;
      if (c) try { definition = await card(c.card_id); } catch(e) { console.warn(e); }
      b.classList.add(c ? c.owner_index === 1 ? 'human-card' : 'ai-card' : 'empty');
      if (c?.kind === 'terraforma') b.classList.add('terraforma-cell');
      if (isCreatureCell(c) && c.tired) b.classList.add('tired');
      if (flow?.kind === 'move' && steps(flow.from).some(x => eq(x,pos))) b.classList.add('valid-move');
      if (flow?.kind === 'attack' && foes(flow.from).some(x => eq(x,pos))) b.classList.add('valid-target');
      if (flow?.kind === 'hand' && flow.step === 'cell' && row === 2 && !c) b.classList.add('valid-summon');
      if (['hand','boss-target','trap-target'].includes(flow?.kind) && (flow?.step === 'target' || flow?.kind !== 'hand') && d && targetAllowed(d,c,flow?.kind === 'trap-target' ? reaction()?.event : null)) b.classList.add('valid-target');
      if (legal.some(x => eq(x,pos))) b.classList.add('valid-summon');
      b.setAttribute('aria-label',c ? `${definition?.name ?? 'Permanente'} ${c.owner_index === 1 ? 'Tu' : 'IA'}${isCreatureCell(c) ? ` ATK ${c.attack} HP ${c.hp}` : ', Terraforma non attaccabile'}${isCreatureCell(c) && c.auras?.length ? `, ${c.auras.length} Aura` : ''}` : `Cella [${row},${col}]`);
      b.innerHTML = c && definition ? cardHTML(definition,true,c) + (isCreatureCell(c) && c.auras?.length ? `<span class="cell-aura-count" title="Aure assegnate">✧ ${c.auras.length}</span>` : '') + `<span class="cell-coordinate">[${row},${col}]</span>` : `<span class="empty-label">${['Riga IA','Centro','Riga Tu'][row]}<br>[${row},${col}]</span>`;
      b.disabled = busy || obligatory();
      b.onclick = () => boardClick(pos).catch(fail); line.append(b);
    }
    root.append(line);
  }
}
async function drawHand() {
  const root = $('player-hand'); if (!root) return;
  root.replaceChildren();
  for (const inst of me()?.hand ?? []) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'hand-card';
    try {
      const d = await card(inst.card_id); b.innerHTML = cardHTML(d,true);
      b.disabled = !state || busy || !!reaction() || obligatory();
      if (playable(d)) b.classList.add('playable');
      b.setAttribute('aria-label',`Apri ${d.name}${playable(d) ? ', giocabile' : ''}`);
      b.onclick = () => inspect('hand',inst.card_id,{instanceId:inst.instance_id});
    } catch(e) { b.textContent = 'Carta non caricabile'; b.disabled = true; console.warn(e); }
    root.append(b);
  }
}
async function drawBoss() {
  let panel = $('mostrissimo-panel');
  if (!panel) {
    panel = document.createElement('section'); panel.id = 'mostrissimo-panel'; panel.className = 'panel'; panel.setAttribute('aria-label','Offerta Mostrissimi');
    const before = document.querySelector('.logs-panel') ?? $('game-message');
    if (before?.parentNode) before.parentNode.insertBefore(panel,before); else document.body.append(panel);
  }
  panel.replaceChildren();
  const h = document.createElement('h2'); h.textContent = '✦ Offerta'; panel.append(h);
  if (!state) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const strip = document.createElement('div'); strip.className = 'boss-offer'; panel.append(strip);
  for (const inst of state.shared_mostrissimi ?? []) {
    const d = await card(inst.card_id), b = document.createElement('button');
    b.type = 'button'; b.className = 'boss-card'; b.innerHTML = cardHTML(d,true);
    b.setAttribute('aria-label',`Apri ${d.name}, ${d.sacrifice_cost} sacrifici`);
    b.disabled = busy || !!reaction() || obligatory(); b.onclick = () => inspect('boss',inst.card_id); strip.append(b);
  }
  const p = pending(); if (!p) return;
  const info = document.createElement('p'); info.className = 'tribute-progress';
  info.textContent = p.stage === 'etb' ? 'Risoluzione degli ETB…' : p.stage === 'before_entry' ? 'Evocazione dichiarata: attendi la reazione.' : `Sacrifici ${p.paid.length}/${p.required}. Non puoi annullare.`;
  panel.append(info);
  if (p.stage !== 'paying' || reaction() || obligatory()) return;
  if (p.paid.length < p.required) {
    const list = document.createElement('div'); list.className = 'tribute-list';
    for (const item of permanents()) {
      const d = await card(item.card_id), b = document.createElement('button');
      b.type = 'button'; b.textContent = `${item.type}: ${d.name}`; b.disabled = busy;
      b.onclick = () => inspect('tribute',item.card_id,{instanceId:item.id}); list.append(b);
    }
    panel.append(list);
  } else {
    const msg = document.createElement('p'); msg.textContent = flow?.kind === 'boss-target' ? 'Tocca il bersaglio ETB evidenziato.' : 'Tocca una cella evidenziata.'; panel.append(msg);
  }
}
function controls() {
  const disable = (id,v) => { if ($(id)) $(id).disabled = !!v; };
  disable('new-match-button',busy || obligatory()); disable('end-turn-button',!active()); disable('refresh-button',busy || !matchId); disable('direct-attack-button',true);
  disable('cancel-selection-button',busy || obligatory() || !flow || (!!pending() && flow?.kind !== 'trap-target'));
  disable('choose-attack-button',true); disable('choose-move-button',true);
  $('creature-action-panel')?.classList.add('hidden');
  if ($('selection-instructions')) $('selection-instructions').textContent = deathOrder() ? 'Scegli l’ordine delle creature morte.' : deathTarget() ? 'Scegli il bersaglio dell’effetto alla morte.' : flow?.kind === 'trap-target' ? reaction()?.event?.kind === 'monster_etb' ? 'Scegli la creatura che ha generato l’ETB.' : 'Scegli il bersaglio della Trappola.' : reaction() ? 'Rispondi alla finestra reattiva o passa.' : flow?.kind === 'boss-target' ? 'Scegli il bersaglio ETB.' : pending() ? 'Evocazione obbligatoria in corso.' : flow?.kind === 'hand' && flow.step === 'cell' ? 'Scegli una cella.' : flow?.kind === 'hand' && flow.step === 'target' ? 'Scegli un bersaglio.' : flow?.kind === 'attack' ? 'Scegli il nemico.' : flow?.kind === 'move' ? 'Scegli una cella adiacente.' : 'Leggi nome e tipo delle carte; tocca per aprire il testo completo.';
}
function showDeckColors() {
  const human = state?.deck_colors?.[1], ai = state?.deck_colors?.[0];
  if ($('player-deck-colors')) $('player-deck-colors').textContent = human ? `Mazzo: ${human.primary} · ${human.secondary} · ${human.tertiary}` : '';
  if ($('opponent-deck-colors')) $('opponent-deck-colors').textContent = ai ? `Mazzo: ${ai.primary} · ${ai.secondary} · ${ai.tertiary}` : '';
}
async function render() {
  const set = (id,x) => { if ($(id)) $(id).textContent = String(x); };
  set('match-status',state?.status === 'finished' ? 'Terminata' : state ? 'In corso' : 'Nessuna partita');
  set('turn-status',state ? `${state.current_turn} · ${state.active_player_index === 1 ? 'Tu' : 'IA'}` : '—');
  set('phase-status',state?.phase === 'upkeep' ? 'MANATENIMENTO' : state?.phase === 'main' ? 'Principale' : state?.phase ?? '—');
  set('player-life',me()?.life ?? 20); set('player-mana',`${me()?.current_mana ?? 0} / ${me()?.max_mana ?? 0}`);
  set('player-hand-count',me()?.hand?.length ?? 0); set('player-deck-count',me()?.deck?.length ?? 0); set('player-graveyard-count',me()?.graveyard?.length ?? 0);
  set('opponent-life',them()?.life ?? 20); set('opponent-current-mana',them()?.current_mana ?? 0); set('opponent-max-mana',them()?.max_mana ?? 0);
  set('opponent-hand-count',them()?.hand?.length ?? 0); set('opponent-deck-count',them()?.deck?.length ?? 0); set('opponent-graveyard-count',them()?.graveyard?.length ?? 0);
  showDeckColors();
  await drawBoard(); await drawHand(); await drawBoss(); controls(); await renderReaction(); await renderDeathChoice();
}
async function logs() {
  if (!$('match-logs') || !matchId) return;
  const {logs:entries} = await api(`/match/${encodeURIComponent(matchId)}/logs?limit=1000`);
  $('match-logs').replaceChildren();
  for (const e of entries ?? []) {
    const li = document.createElement('li');
    li.textContent = e.log_data?.description ?? e.log_data?.action_type ?? 'Evento';
    $('match-logs').append(li);
  }
}
async function request(path,body,message) {
  if (busy || !matchId) return;
  close(); busy = true; controls(); reactionDialog().classList.add('hidden'); choiceDialog().classList.add('hidden');
  try {
    state = (await api(`/match/${encodeURIComponent(matchId)}/${path}`,{method:'POST',body})).state;
    flow = null; await render();
    try { await logs(); } catch(e) { console.warn(e); }
    notice(state.status === 'finished' ? state.winner_index === 1 ? 'HAI VINTO!' : 'HAI PERSO!' : state.mostrissimo_result?.outcome === 'failed' ? state.mostrissimo_result.message : deathOrder() ? 'Scegli l’ordine delle creature morte.' : deathTarget() ? 'Scegli il bersaglio dell’effetto alla morte.' : state.pending_reaction ? reactionDescription(state.pending_reaction.event) : message,state.mostrissimo_result?.outcome === 'failed' ? 'error' : 'success');
  } catch(e) {
    fail(e);
    try { state = (await api(`/match/${encodeURIComponent(matchId)}`)).state; flow = null; } catch(refreshError) { console.warn(refreshError); }
  } finally { busy = false; await render().catch(fail); queuePresentation(); }
}
async function boardClick(pos) {
  if (busy || obligatory()) return;
  const c = at(pos), r = reaction();
  if (r) {
    if (flow?.kind === 'trap-target') {
      if (flow.windowId !== r.window_id) { flow = null; await render(); return notice('Finestra reattiva scaduta.','error'); }
      const d = await card(flow.id);
      if (!targetAllowed(d,c,r.event)) return notice('Bersaglio della Trappola non valido.','error');
      return chooseTrap({windowId:r.window_id,action:'play',cardInstanceId:flow.instanceId,targetInstanceId:c.instance_id});
    }
    return notice('Scegli una Trappola oppure passa.','error');
  }
  if (!turn()) return;
  const p = pending();
  if (flow?.kind === 'boss-target') {
    if (!p || p.stage !== 'paying' || p.paid.length !== p.required) { flow = null; await render(); return notice('Evocazione non più valida.','error'); }
    const d = await card(p.card_id);
    if (!targetAllowed(d,c)) return notice('Bersaglio ETB non valido.','error');
    return request('mostrissimo/complete',{position:flow.position,targetInstanceId:c.instance_id},'Mostrissimo dichiarato.');
  }
  if (p) {
    if (p.stage !== 'paying') return;
    if (p.paid.length < p.required) {
      if (c?.owner_index === 1) return inspect('tribute',c.card_id,{instanceId:c.instance_id});
      return notice('Scegli un tuo permanente nell’elenco dei sacrifici.','error');
    }
    if (c || !bossCells(p).some(x => eq(x,pos))) return notice('Cella non valida.','error');
    const d = await card(p.card_id);
    if (targetEffect(d) && targets(d).length) {
      flow = {kind:'boss-target',position:pos,id:d.id}; await render(); notice('Cella scelta. Tocca il bersaglio ETB evidenziato.','success'); return;
    }
    return request('mostrissimo/complete',{position:pos},'Mostrissimo dichiarato.');
  }
  if (flow?.kind === 'hand') {
    const d = await card(flow.id);
    if (flow.step === 'cell') {
      if (c || pos.row !== 2) return notice('Scegli una cella libera della tua riga.','error');
      flow.position = pos;
      if (d.card_type === 'monster' && targetEffect(d) && targets(d).length) { flow.step = 'target'; await render(); notice('Cella scelta. Tocca il bersaglio ETB.','success'); return; }
      return request('play-card',{cardInstanceId:flow.instanceId,options:{position:pos}},'Carta dichiarata.');
    }
    if (flow.step === 'target') {
      if (!targetAllowed(d,c)) return notice('Bersaglio non valido.','error');
      return request('play-card',{cardInstanceId:flow.instanceId,options:{...(flow.position ? {position:flow.position} : {}),targetInstanceId:c.instance_id}},creature(d) ? 'Creatura dichiarata.' : 'Carta dichiarata.');
    }
  }
  if (flow?.kind === 'move') {
    if (!steps(flow.from).some(x => eq(x,pos))) return notice('Scegli una cella libera adiacente.','error');
    return request('move',{from:flow.from,to:pos},'Movimento dichiarato.');
  }
  if (flow?.kind === 'attack') {
    if (!foes(flow.from).some(x => eq(x,pos))) return notice('Scegli una creatura IA adiacente.','error');
    return request('attack',{attackerPosition:flow.from,target:{type:'creature',position:pos}},'Attacco dichiarato.');
  }
  if (c) return inspect('unit',c.card_id,{position:pos,cell:c});
}
function colorDialog() {
  let el = $('deck-color-dialog');
  if (el) return el;
  el = document.createElement('div'); el.id = 'deck-color-dialog'; el.className = 'card-detail-overlay hidden';
  el.setAttribute('role','dialog'); el.setAttribute('aria-modal','true'); el.setAttribute('aria-labelledby','deck-color-title');
  el.style.zIndex = '130';
  const panel = document.createElement('div'); panel.className = 'panel'; panel.style.cssText = 'width:min(92vw,440px);max-height:88dvh;overflow:auto;margin:auto;padding:1.2rem;text-align:center;border:1px solid #d5a758;box-shadow:0 12px 48px #000';
  const title = document.createElement('h2'); title.id = 'deck-color-title'; title.textContent = 'Scegli i colori del mazzo';
  const explanation = document.createElement('p'); explanation.textContent = 'Scegli principale e secondario. Il terzo colore sarà casuale; anche l’IA avrà tre colori casuali. IND non entra nel mazzo base.';
  const form = document.createElement('form'); form.id = 'deck-color-form'; form.style.cssText = 'display:grid;gap:.8rem';
  const makeSelect = (id,text) => {
    const label = document.createElement('label'); label.textContent = text; label.style.cssText = 'display:grid;gap:.3rem;text-align:left';
    const select = document.createElement('select'); select.id = id; select.required = true; select.style.cssText = 'width:100%;padding:.65rem;background:#171924;color:#fff;border:1px solid #d5a758;border-radius:6px';
    for (const [code,name] of Object.entries(deckFactionNames)) {
      const option = document.createElement('option'); option.value = code; option.textContent = `${name} (${code})`; select.append(option);
    }
    label.append(select); return label;
  };
  form.append(makeSelect('deck-primary-color','Colore principale'),makeSelect('deck-secondary-color','Colore secondario'));
  const validation = document.createElement('p'); validation.id = 'deck-color-validation'; validation.setAttribute('role','alert'); validation.style.color = '#ffbd92'; form.append(validation);
  const actions = document.createElement('div'); actions.style.cssText = 'display:flex;justify-content:center;flex-wrap:wrap;gap:.6rem';
  const confirm = document.createElement('button'); confirm.type = 'submit'; confirm.className = 'primary-button'; confirm.textContent = 'Crea partita'; confirm.id = 'deck-color-confirm';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'secondary-button'; cancel.textContent = 'Annulla'; cancel.onclick = () => closeColorDialog();
  actions.append(confirm,cancel); form.append(actions); panel.append(title,explanation,form); el.append(panel); document.body.append(el);
  form.addEventListener('submit',e => { e.preventDefault(); submitColors().catch(fail); });
  el.addEventListener('click',e => { if (e.target === el && !busy) closeColorDialog(); });
  return el;
}
function closeColorDialog() { $('deck-color-dialog')?.classList.add('hidden'); }
function openColorDialog() {
  if (busy || reaction() || pending() || obligatory()) return;
  close(); closeGraveyard();
  const el = colorDialog();
  $('deck-color-validation').textContent = '';
  if ($('deck-primary-color').value === $('deck-secondary-color').value) $('deck-secondary-color').value = 'INF';
  el.classList.remove('hidden'); $('deck-primary-color').focus();
}
async function submitColors() {
  if (busy || obligatory()) return;
  const primaryColor = $('deck-primary-color')?.value, secondaryColor = $('deck-secondary-color')?.value;
  if (!deckFactionNames[primaryColor] || !deckFactionNames[secondaryColor] || primaryColor === secondaryColor) {
    $('deck-color-validation').textContent = 'Scegli due colori diversi.'; return;
  }
  $('deck-color-validation').textContent = '';
  await newMatch(primaryColor,secondaryColor);
}
async function newMatch(primaryColor,secondaryColor) {
  if (busy || obligatory()) return; busy = true; controls();
  $('deck-color-confirm').disabled = true;
  notice('Creazione partita…');
  try {
    const result = await api('/match/create',{method:'POST',body:{primaryColor,secondaryColor}});
    presentationGeneration++; presentationLayer().style.display = 'none';
    matchId = result.match_id; state = result.state; flow = null; deathDraft = {choiceId:null,instanceIds:[]}; close(); closeGraveyard(); closeColorDialog();
    localStorage.setItem('bellum:last-match',matchId); await render(); await logs(); notice('Partita pronta. Tocca una carta.','success');
  } catch(e) { fail(e); $('deck-color-validation').textContent = e instanceof Error ? e.message : 'Impossibile creare la partita.'; }
  finally { busy = false; $('deck-color-confirm').disabled = false; await render().catch(fail); queuePresentation(); }
}
async function refreshMatch() {
  if (busy || !matchId) return; busy = true; controls();
  try {
    state = (await api(`/match/${encodeURIComponent(matchId)}`)).state;
    flow = null; close(); closeGraveyard(); await render(); await logs(); notice('Aggiornato.','success');
  } catch(e) { fail(e); }
  finally { busy = false; await render().catch(fail); queuePresentation(); }
}
async function init() {
  if (initialized) return;
  const user = await getCurrentUser(); if (!user) return;
  initialized = true;
  if ($('signed-in-user')) $('signed-in-user').textContent = `@${usernameFromEmail(user.email)}`;
  if ($('player-title')) $('player-title').textContent = usernameFromEmail(user.email) || 'Tu';
  overlay(); reactionDialog(); choiceDialog(); graveyardDialog(); colorDialog(); wireGraveyards();
  $('new-match-button')?.addEventListener('click',openColorDialog);
  $('cancel-selection-button')?.addEventListener('click',() => {
    if (obligatory()) return;
    if (flow?.kind === 'trap-target') { flow = null; render().catch(fail); notice('Scegli un’altra Trappola o passa.'); return; }
    if (!pending() && !reaction()) { flow = null; close(); render().catch(fail); notice('Selezione annullata.'); }
  });
  $('end-turn-button')?.addEventListener('click',() => { if (active()) request('end-turn',{},'È di nuovo il tuo turno.'); });
  $('refresh-button')?.addEventListener('click',() => refreshMatch().catch(fail));
  $('logout-button')?.addEventListener('click',() => signOut().then(() => { presentationGeneration++; presentationLayer().style.display = 'none'; matchId = null; state = null; flow = null; deathDraft = {choiceId:null,instanceIds:[]}; close(); closeGraveyard(); closeColorDialog(); reactionDialog().classList.add('hidden'); choiceDialog().classList.add('hidden'); }).catch(fail));
  document.addEventListener('keydown',e => { if (e.key === 'Escape' && !obligatory()) { if (!$('deck-color-dialog')?.classList.contains('hidden') && !busy) closeColorDialog(); else if (!$('graveyard-dialog')?.classList.contains('hidden')) closeGraveyard(); else if (view) close(); } });
  await render();
  const prior = localStorage.getItem('bellum:last-match');
  if (prior) try {
    const result = await api(`/match/${encodeURIComponent(prior)}`);
    if (result.state?.state_version === 4 && result.state.players?.[1]?.user_id === user.id) {
      matchId = prior; state = result.state; await render(); await logs(); notice('Partita precedente ripristinata.','success'); queuePresentation();
    }
  } catch(e) { console.warn('Ripristino non disponibile',e); }
}
window.addEventListener('bellum:auth-ready',() => init().catch(fail));
getCurrentUser().then(user => { if (user) return init(); }).catch(fail);
