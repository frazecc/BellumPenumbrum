import { getAccessToken, getCurrentUser, signOut, usernameFromEmail } from './auth.js';
const API = 'https://bellum-penumbrum-api.onrender.com';
const EMPTY = [[null,null,null],[null,null,null],[null,null,null]];
let state = null, matchId = null, selectedCard = null, selectedUnit = null, mode = null, pendingTarget = null, busy = false, initialized = false;
const cache = new Map();
let bossChoice = null, bossTribute = null;
const $ = id => document.getElementById(id);
const board = () => state?.board?.rows ?? EMPTY;
const at = p => board()[p.row]?.[p.col] ?? null;
const me = () => state?.players?.[1];
const them = () => state?.players?.[0];
const myTurn = () => state?.status === 'running' && state.active_player_index === 1 && state.phase === 'main';
const inside = p => p.row >= 0 && p.row < 3 && p.col >= 0 && p.col < 3;
const around = p => [{row:p.row-1,col:p.col},{row:p.row+1,col:p.col},{row:p.row,col:p.col-1},{row:p.row,col:p.col+1}].filter(inside);
const eq = (a,b) => Boolean(a && b && a.row === b.row && a.col === b.col);
const foes = () => selectedUnit ? around(selectedUnit).filter(p => at(p)?.owner_index === 0) : [];
const steps = () => selectedUnit && at(selectedUnit)?.owner_index === 1 && !at(selectedUnit)?.tired ? around(selectedUnit).filter(p => p.row !== 0 && !at(p)) : [];
const escape = x => String(x ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const creature = d => d.card_type === 'monster' || d.card_type === 'mostrissimo';
const effect = d => Array.isArray(d.effect_json?.effects) ? d.effect_json.effects.find(e => e?.target === 'any_creature' || e?.type === 'return_hand') : d.effect_json;
const needsTarget = d => d.card_type === 'aura' || effect(d)?.target === 'any_creature' || effect(d)?.type === 'return_hand';
const targetAllowed = (d,c) => Boolean(c && (d.card_type === 'aura' || d.card_type === 'instant' || !creature(d) && !needsTarget(d) || (effect(d)?.type === 'heal' ? c.owner_index === 1 : effect(d)?.type === 'damage' || effect(d)?.type === 'damage_creature' ? c.owner_index === 0 : true)));
function clear() { selectedCard = null; selectedUnit = null; mode = null; pendingTarget = null; }
function notice(text, type = '') { if ($('game-message')) { $('game-message').textContent = text; $('game-message').className = `game-message ${type}`; } }
function fail(error) { console.error(error); notice(error instanceof Error ? error.message : 'Errore inatteso', 'error'); }
function control() {
  const enabled = myTurn() && !busy, unit = selectedUnit && at(selectedUnit), ready = enabled && unit?.owner_index === 1 && !unit.tired;
  const disable = (id,x) => { if ($(id)) $(id).disabled = Boolean(x); };
  disable('new-match-button',busy); disable('end-turn-button',!enabled); disable('refresh-button',busy || !matchId);
  disable('choose-attack-button',!ready); disable('choose-move-button',!ready || !me()?.current_mana || !steps().length);
  disable('direct-attack-button',!enabled || mode !== 'attack' || foes().length > 0);
  disable('cancel-selection-button',busy || (!selectedUnit && !selectedCard));
  if ($('creature-action-panel')) $('creature-action-panel').classList.toggle('hidden',!ready);
  if (unit && $('selected-creature-name')) $('selected-creature-name').textContent = cache.get(unit.card_id)?.name ?? 'Creatura';
  if (unit && $('selected-creature-details')) $('selected-creature-details').textContent = `ATK ${unit.attack} · HP ${unit.hp}/${unit.max_hp} · ${unit.tired ? 'Stanca' : 'Pronta'}`;
  if ($('selection-instructions')) $('selection-instructions').textContent = !state ? 'Premi Nuova partita.' : selectedCard ? pendingTarget ? 'Bersaglio ETB scelto: clicca una cella libera nella riga Tu.' : mode === 'etb-target' ? 'Seleziona un bersaglio evidenziato, poi una cella libera nella riga Tu.' : (cache.get(me()?.hand?.find(c => c.instance_id === selectedCard)?.card_id)?.card_type === 'instant' ? 'Istantaneo selezionato: clicca una creatura bersaglio oppure una cella libera per risolverlo nel tuo turno.' : 'Scegli una cella della riga Tu per evocare.') : mode === 'move' ? 'Muovi: clicca una cella verde; costa 1 mana e non stanca.' : mode === 'attack' ? foes().length ? 'Clicca una creatura IA evidenziata.' : 'Nessun altro bersaglio valido: premi Attacca IA direttamente.' : selectedUnit ? 'Scegli Attacca (0 mana) oppure Muovi (1 mana).' : 'Seleziona una carta in mano oppure una tua creatura pronta.';
}
function setBusy(value) { busy = value; control(); }
async function api(path, options = {}) {
  const token = await getAccessToken(); if (!token) throw new Error('Sessione scaduta, accedi di nuovo.');
  const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 45000);
  try {
    const res = await fetch(`${API}${path}`, { method: options.method ?? 'GET', headers: { Authorization: `Bearer ${token}`, ...(options.body !== undefined ? {'Content-Type':'application/json'} : {}) }, body: options.body !== undefined ? JSON.stringify(options.body) : undefined, signal: abort.signal });
    const json = await res.json().catch(() => ({})); if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`); return json;
  } catch (e) { if (e?.name === 'AbortError') throw new Error('Render non risponde entro 45 secondi.'); throw e; }
  finally { clearTimeout(timeout); }
}
async function getCard(id) { if (!cache.has(id)) cache.set(id, (await api(`/cards/${encodeURIComponent(id)}`)).card); return cache.get(id); }
function targetsOnBoard(d) {
  const result=[];
  for (let row=0;row<3;row++) for (let col=0;col<3;col++) {
    const p={row,col}, c=at(p);
    if (targetAllowed(d,c)) result.push({position:p,cell:c});
  }
  return result;
}
async function drawBoard() {
  const root = $('shared-board'); if (!root) { notice('Manca #shared-board: verifica docs/index.html.', 'error'); return; }
  root.replaceChildren();
  let selectedDefinition=null;
  if (selectedCard) { const selected=me()?.hand?.find(c=>c.instance_id===selectedCard); if (selected) selectedDefinition=cache.get(selected.card_id)??null; }
  for (let row=0;row<3;row++) {
    const line=document.createElement('div'); line.className=`board-row ${['ai-row','center-row','human-row'][row]}`;
    for (let col=0;col<3;col++) {
      const pos={row,col}, c=at(pos), button=document.createElement('button'); button.type='button'; button.className='board-cell';
      let d=null; if (c) try { d=await getCard(c.card_id); } catch (e) { console.warn(e); }
      if (!c) button.classList.add('empty'); else button.classList.add(c.owner_index===1?'human-card':'ai-card');
      if (c?.tired) button.classList.add('tired'); if (eq(pos,selectedUnit)) button.classList.add('selected-creature');
      if (mode==='move' && steps().some(p=>eq(p,pos))) button.classList.add('valid-move');
      if (mode==='attack' && foes().some(p=>eq(p,pos))) button.classList.add('valid-target');
      if (selectedCard && row===2 && !c) button.classList.add('valid-summon');
      if (selectedCard && selectedDefinition && targetAllowed(selectedDefinition,c) && needsTarget(selectedDefinition)) button.classList.add('valid-target');
      if (pendingTarget && c?.instance_id===pendingTarget) button.classList.add('selected-target');
      button.setAttribute('aria-label',c?`${d?.name ?? 'Creatura'} ${c.owner_index===1?'Tu':'IA'} ${c.tired?'stanca':'pronta'} riga ${row} colonna ${col}`:`${['Riga IA','Centro','Riga Tu'][row]} colonna ${col}`);
      button.innerHTML=c?`<span class="cell-coordinate">[${row},${col}]</span><span class="card-type">${c.owner_index===1?'TU':'IA'} · ${c.tired?'STANCA':'PRONTA'}</span><strong class="card-name">${escape(d?.name??'Creatura')}</strong><span class="card-effect">${escape(d?.effect_text??'')}</span><span class="card-stats">${c.attack} / ${c.hp}</span>`:`<span class="empty-label">${['Riga IA','Centro','Riga Tu'][row]}<br>[${row},${col}]</span>`;
      button.onclick=()=>boardClick(pos).catch(fail); line.append(button);
    }
    root.append(line);
  }
}
async function drawHand() {
  const root=$('player-hand'); if (!root) return; root.replaceChildren();
  for (const inst of me()?.hand??[]) {
    const button=document.createElement('button'); button.type='button'; button.className='hand-card';
    try {
      const d=await getCard(inst.card_id); if (selectedCard===inst.instance_id) button.classList.add('selected-hand-card');
      if (d.mana_cost>me().current_mana) button.classList.add('unaffordable');
      button.innerHTML=`<span class="card-cost">${escape(d.mana_cost)}</span><span class="card-type">${escape(d.card_type)}</span><strong class="card-name">${escape(d.name)}</strong><span class="card-effect">${escape(d.effect_text??'')}</span><span class="card-stats">${d.attack??'—'} / ${d.hp??'—'}</span>`;
      button.onclick=async()=>{
        if (!myTurn() || busy) return;
        selectedCard=selectedCard===inst.instance_id?null:inst.instance_id; selectedUnit=null; pendingTarget=null; mode=null;
        if (selectedCard && creature(d) && needsTarget(d)) {
          const candidates=targetsOnBoard(d);
          if (candidates.length) { mode='etb-target'; notice('ETB: scegli una creatura bersaglio evidenziata, poi la cella dove evocare.', 'success'); }
          else notice('Nessun bersaglio valido: evoca normalmente; l’ETB non si attiverà.', 'success');
        }
        await render();
      };
    } catch(e) { button.textContent='Carta non caricabile'; button.disabled=true; console.warn(e); }
    root.append(button);
  }
}
function bossTargets(card) {
  const e=effect(card);
  if (!e || (e.target!=='any_creature' && e.type!=='return_hand')) return [];
  const cells=[];
  for (let row=0;row<3;row++) for (let col=0;col<3;col++) {
    const c=board()[row][col]; if (!c) continue;
    if ((e.type==='damage' || e.type==='damage_creature') && c.owner_index!==0) continue;
    if (e.type==='heal' && c.owner_index!==1) continue;
    cells.push(c);
  }
  return cells;
}
function bossPermanents() {
  const result=[];
  for (let row=0;row<3;row++) for (let col=0;col<3;col++) {
    const c=board()[row][col]; if (c?.owner_index!==1) continue;
    result.push({id:c.instance_id,card_id:c.card_id,type:'Creatura'});
    for (const aura of c.auras??[]) result.push({id:aura.instance_id,card_id:aura.card_id,type:'Aura'});
  }
  if (me()?.field_spell) result.push({id:me().field_spell.instance_id,card_id:me().field_spell.card_id,type:'Terraforma'});
  return result;
}
async function bossAction(endpoint,body,success) {
  if (busy || !matchId) return;
  setBusy(true);
  try {
    state=(await api(`/match/${matchId}/mostrissimo/${endpoint}`,{method:'POST',body})).state;
    bossTribute=null; clear();
    if (!state.pending_mostrissimo) bossChoice=null;
    await render(); try { await logs(); } catch(e) { console.warn(e); }
    notice(state.status==='finished'?(state.winner_index===1?'HAI VINTO!':'HAI PERSO!'):state.mostrissimo_result?.outcome==='failed'?state.mostrissimo_result.message:success,state.mostrissimo_result?.outcome==='failed'?'error':'success');
  } catch(e) { fail(e); } finally { setBusy(false); }
}
async function renderBoss() {
  let panel=$('mostrissimo-panel');
  if (!panel) {
    panel=document.createElement('section'); panel.id='mostrissimo-panel'; panel.className='hand-section panel';
    panel.setAttribute('aria-label','Mostrissimi disponibili');
    const before=document.querySelector('.logs-panel') ?? $('game-message');
    before?.parentNode?.insertBefore(panel,before);
  }
  panel.replaceChildren();
  const heading=document.createElement('h2'); heading.textContent='Mostrissimi · Offerta condivisa'; panel.append(heading);
  if (!state) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const pending=state.pending_mostrissimo;
  const choices=state.shared_mostrissimi??[];
  const eligible=()=>bossPermanents().length;
  for (const inst of choices) {
    const card=await getCard(inst.card_id);
    const b=document.createElement('button'); b.type='button'; b.className='hand-card';
    if (bossChoice===inst.card_id || pending?.card_id===inst.card_id) b.classList.add('selected-hand-card');
    b.textContent=`${card.name} · ${card.sacrifice_cost} sacrifici · ${card.attack??0}/${card.hp??1} · ${card.effect_text??''}`;
    b.disabled=busy || !myTurn() || Boolean(pending) || state.last_mostrissimo_turn?.[1]===state.current_turn;
    b.onclick=()=>{bossChoice=inst.card_id; render().catch(fail);}; panel.append(b);
  }
  if (!pending && bossChoice && choices.some(x=>x.card_id===bossChoice)) {
    const card=await getCard(bossChoice), cost=Number(card.sacrifice_cost);
    const ownCreatures=()=>{let count=0; for(const row of board())for(const c of row)if(c?.owner_index===1)count++;return count;};
    const hasHomeSpace=board()[2].some(c=>!c);
    const can=cost>=0&&cost<=6&&eligible()>=cost&&(hasHomeSpace||(cost>0&&ownCreatures()>0))&&state.last_mostrissimo_turn?.[1]!==state.current_turn;
    if (can) {
      const go=document.createElement('button');go.className='primary-button';go.textContent='Evoca';go.disabled=busy;
      go.onclick=()=>bossAction('start',{cardId:bossChoice},'Evocazione iniziata: non puoi annullare.');panel.append(go);
    }
    const cancel=document.createElement('button');cancel.className='secondary-button';cancel.textContent='Annulla';cancel.onclick=()=>{bossChoice=null;render().catch(fail);};panel.append(cancel);
  }
  if (pending?.player_index===1) {
    const text=document.createElement('p');text.textContent=`Sacrifici confermati: ${pending.paid.length}/${pending.required}. Procedura non annullabile.`;panel.append(text);
    if (pending.paid.length<pending.required) {
      for(const permanent of bossPermanents()) {
        const card=await getCard(permanent.card_id);
        const b=document.createElement('button');b.type='button';b.className='hand-card';
        b.textContent=`${permanent.type}: ${card.name}${bossTribute===permanent.id?' · selezionato':''}`;
        b.disabled=busy;b.onclick=()=>{bossTribute=permanent.id;render().catch(fail);};panel.append(b);
      }
      const confirm=document.createElement('button');confirm.type='button';confirm.className='primary-button';confirm.textContent='Conferma sacrificio';confirm.disabled=!bossTribute||busy;
      confirm.onclick=()=>bossAction('sacrifice',{instanceId:bossTribute},'Sacrificio risolto.');panel.append(confirm);
    } else {
      const card=await getCard(pending.card_id), targets=bossTargets(card);
      const instructions=document.createElement('p');instructions.textContent='Sacrifici completi. Scegli il bersaglio ETB, se richiesto, poi clicca una cella libera della tua riga o liberata dai sacrifici.';panel.append(instructions);
      if (targets.length) {
        const select=document.createElement('select');select.id='boss-effect-target';select.setAttribute('aria-label','Bersaglio effetto di ingresso');
        const empty=document.createElement('option');empty.value='';empty.textContent='Scegli il bersaglio ETB';select.append(empty);
        for(const c of targets) {const d=await getCard(c.card_id),o=document.createElement('option');o.value=c.instance_id;o.textContent=`${d.name} (${c.owner_index===1?'Tu':'IA'})`;select.append(o);}
        panel.append(select);
      }
    }
  }
}

async function render() {
  const set=(id,value)=>{ if ($(id)) $(id).textContent=String(value); };
  set('match-status',state?.status==='finished'?'Terminata':state?'In corso':'Nessuna partita');
  set('turn-status',state?`${state.current_turn} · ${state.active_player_index===1?'Tu':'IA'}`:'—'); set('phase-status',state?.phase==='main'?'Principale':state?.phase??'—');
  set('player-life',me()?.life??20); set('player-mana',`${me()?.current_mana??0} / ${me()?.max_mana??0}`);
  set('player-hand-count',me()?.hand?.length??0); set('player-deck-count',me()?.deck?.length??0); set('player-graveyard-count',me()?.graveyard?.length??0);
  set('opponent-life',them()?.life??20); set('opponent-hand-count',them()?.hand?.length??0); set('opponent-deck-count',them()?.deck?.length??0); set('opponent-graveyard-count',them()?.graveyard?.length??0);
  for (const [id,owner,label] of [['player-field-spell',me(),'Tu'],['opponent-field-spell',them(),'IA']]) { let text=`${label}: Nessuna Terraforma`; if (owner?.field_spell) try { text=`${label}: ${(await getCard(owner.field_spell.card_id)).name}`; } catch {} set(id,text); }
  await drawBoard(); await drawHand(); await renderBoss(); control();
}
async function logs() { if (!$('match-logs') || !matchId) return; const {logs:events}=await api(`/match/${matchId}/logs?limit=100`); $('match-logs').replaceChildren(); for (const e of events??[]) { const li=document.createElement('li'); li.textContent=e.log_data?.description??e.log_data?.action_type??'Evento'; $('match-logs').append(li); } $('match-logs').scrollTop=$('match-logs').scrollHeight; }
async function action(endpoint, body, success) {
  if (busy || !matchId) return; setBusy(true);
  try { state=(await api(`/match/${matchId}/${endpoint}`,{method:'POST',body})).state; clear(); await render(); try { await logs(); } catch(e) { console.warn(e); } notice(state.status==='finished'?(state.winner_index===1?'Hai vinto!':'L’IA ha vinto.'):success,'success'); }
  catch(e) { fail(e); } finally { setBusy(false); }
}
async function boardClick(pos) {
  if (!myTurn() || busy) return;
  const c=at(pos);
  const pendingBoss = state?.pending_mostrissimo;
  if (pendingBoss?.player_index === 1) {
    if (pendingBoss.paid.length < pendingBoss.required) {
      if (!c || c.owner_index !== 1) return notice('Seleziona un tuo permanente da sacrificare.','error');
      bossTribute=c.instance_id; await render(); notice('Permanente selezionato: premi Conferma sacrificio.','success'); return;
    }
    const card = await getCard(pendingBoss.card_id);
    const targetedEffect = effect(card);
    const requiresTarget = targetedEffect?.target === 'any_creature' || targetedEffect?.type === 'return_hand';
    if (c) return notice('Seleziona una cella libera. Il bersaglio ETB si sceglie dal pannello Mostrissimi.','error');
    if (pos.row !== 2 && !(pendingBoss.freed_positions??[]).some(q=>eq(q,pos))) return notice('Cella non valida per questa evocazione.','error');
    const targetId = document.getElementById('boss-effect-target')?.value || null;
    if (requiresTarget && !targetId && bossTargets(card).length) return notice('Seleziona prima un bersaglio ETB dal pannello.','error');
    await bossAction('complete',{position:pos,...(targetId?{targetInstanceId:targetId}:{})},'Mostrissimo evocato.'); return;
  }

  if (selectedCard) {
    const inst=me().hand.find(x=>x.instance_id===selectedCard); if (!inst) { clear(); return render(); }
    const d=await getCard(inst.card_id);
    if (creature(d)) {
      const candidates=needsTarget(d)?targetsOnBoard(d):[];
      if (c && needsTarget(d)) {
        if (!targetAllowed(d,c)) return notice(effect(d)?.type==='damage'?'Questo ETB può colpire solo creature avversarie.':'Bersaglio non valido per questo ETB.','error');
        pendingTarget=c.instance_id; mode='etb-target'; await render(); notice('Bersaglio scelto: ora clicca una cella libera della riga Tu per evocare.','success'); return;
      }
      if (pos.row!==2 || c) return notice('Evoca solo in una cella libera della riga Tu: [2,0], [2,1], [2,2].','error');
      if (candidates.length && !pendingTarget) return notice('Esiste un bersaglio valido: selezionalo prima di evocare.','error');
      return action('play-card',{cardInstanceId:inst.instance_id,options:{position:pos,...(pendingTarget?{targetInstanceId:pendingTarget}:{})}},'Creatura evocata.');
    }
    if (needsTarget(d)) { if (!targetAllowed(d,c)) return notice('Seleziona una creatura valida per questo effetto.','error'); return action('play-card',{cardInstanceId:inst.instance_id,options:{targetInstanceId:c.instance_id}},'Carta giocata.'); }
    return action('play-card',{cardInstanceId:inst.instance_id,options:{}},'Carta giocata.');
  }
  if (mode==='move') { if (!steps().some(p=>eq(p,pos))) return notice('Seleziona una cella libera adiacente, non nella riga IA.','error'); return action('move',{from:selectedUnit,to:pos},'Creatura mossa: -1 mana; rimane pronta.'); }
  if (mode==='attack') { if (!foes().some(p=>eq(p,pos))) return notice('Seleziona un nemico adiacente oppure premi Attacca IA direttamente.','error'); return action('attack',{attackerPosition:selectedUnit,target:{type:'creature',position:pos}},'Attacco risolto.'); }
  if (c?.owner_index===1) { if (c.tired) return notice('Creatura stanca: non può attaccare né muoversi.','error'); selectedUnit=pos; selectedCard=null; mode=null; return render(); }
  if (c?.owner_index===0) notice('Seleziona prima una tua creatura.','error');
}
async function newMatch() {
  if (busy) return; setBusy(true); notice('Creazione partita…');
  try { bossChoice=null; bossTribute=null; const result=await api('/match/create',{method:'POST',body:{}}); matchId=result.match_id; state=result.state; clear(); localStorage.setItem('bellum:last-match',matchId); await render(); try { await logs(); } catch(e) { console.warn(e); } notice('Partita pronta: scegli una carta e clicca una cella della riga Tu.','success'); }
  catch(e) { fail(e); } finally { setBusy(false); }
}
async function init() {
  if (initialized) return; const user=await getCurrentUser(); if (!user) return; initialized=true;
  if ($('signed-in-user')) $('signed-in-user').textContent=`@${usernameFromEmail(user.email)}`;
  if ($('player-title')) $('player-title').textContent=usernameFromEmail(user.email)||'Tu';
  $('new-match-button')?.addEventListener('click',()=>newMatch().catch(fail));
  $('choose-attack-button')?.addEventListener('click',()=>{ if (!selectedUnit || busy) return; mode='attack'; render().catch(fail); notice(foes().length?'Seleziona il nemico evidenziato.':'Nessun altro bersaglio valido: premi Attacca IA direttamente.','success'); });
  $('choose-move-button')?.addEventListener('click',()=>{ if (!selectedUnit || busy || !me()?.current_mana || !steps().length) return; mode='move'; render().catch(fail); });
  $('direct-attack-button')?.addEventListener('click',()=>{ if (selectedUnit && mode==='attack' && !foes().length) action('attack',{attackerPosition:selectedUnit,target:{type:'player',playerIndex:0}},'Attacco diretto risolto.'); });
  for (const id of ['cancel-creature-action-button','cancel-selection-button']) $(id)?.addEventListener('click',()=>{ clear(); render().catch(fail); });
  $('end-turn-button')?.addEventListener('click',()=>{ if (!busy && myTurn()) { notice('L’IA sta giocando…'); action('end-turn',{},'È di nuovo il tuo turno.'); } });
  $('refresh-button')?.addEventListener('click',async()=>{ if (busy || !matchId) return; setBusy(true); try { state=(await api(`/match/${matchId}`)).state; await render(); await logs(); notice('Aggiornato.','success'); } catch(e) { fail(e); } finally { setBusy(false); } });
  $('logout-button')?.addEventListener('click',()=>{ signOut().then(()=>{ matchId=null; state=null; clear(); }).catch(fail); });
  await render(); const prior=localStorage.getItem('bellum:last-match');
  if (prior) try { const result=await api(`/match/${prior}`); if (result.state?.state_version===2 && result.state.players?.[1]?.user_id===user.id) { matchId=prior; state=result.state; await render(); await logs(); notice('Partita precedente ripristinata.','success'); } } catch(e) { console.warn('Ripristino non disponibile',e); }
}
window.addEventListener('bellum:auth-ready',()=>init().catch(fail));
getCurrentUser().then(user=>{ if (user) return init(); }).catch(fail);
