import { getAccessToken, getCurrentUser, signOut, usernameFromEmail } from './auth.js';

const API = 'https://bellum-penumbrum-api.onrender.com';
const $ = id => document.getElementById(id);
const cache = new Map();
let state = null, matchId = null, selectedCard = null, selectedUnit = null;
let mode = null, pendingTarget = null, bossChoice = null, bossTribute = null, busy = false, initialized = false;
const board = () => state?.board?.rows ?? [[null,null,null],[null,null,null],[null,null,null]];
const at = p => board()[p.row]?.[p.col] ?? null;
const me = () => state?.players?.[1];
const them = () => state?.players?.[0];
const myTurn = () => state?.status === 'running' && state.active_player_index === 1 && state.phase === 'main';
const pendingBoss = () => state?.pending_mostrissimo?.player_index === 1 ? state.pending_mostrissimo : null;
const canAct = () => myTurn() && !busy && !pendingBoss();
const inside = p => p.row >= 0 && p.row < 3 && p.col >= 0 && p.col < 3;
const around = p => [{row:p.row-1,col:p.col},{row:p.row+1,col:p.col},{row:p.row,col:p.col-1},{row:p.row,col:p.col+1}].filter(inside);
const eq = (a,b) => Boolean(a && b && a.row === b.row && a.col === b.col);
const foes = () => selectedUnit ? around(selectedUnit).filter(p => at(p)?.owner_index === 0) : [];
const steps = () => selectedUnit && at(selectedUnit)?.owner_index === 1 && !at(selectedUnit)?.tired ? around(selectedUnit).filter(p => p.row !== 0 && !at(p)) : [];
const escape = x => String(x ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const creature = d => d.card_type === 'monster' || d.card_type === 'mostrissimo';
const allEffects = d => Array.isArray(d?.effect_json?.effects) ? d.effect_json.effects : d?.effect_json?.type ? [d.effect_json] : [];
const targetEffect = d => allEffects(d).find(e => e?.target === 'any_creature' || e?.type === 'return_hand');
const needsTarget = d => d.card_type === 'aura' || Boolean(targetEffect(d));
function targetAllowed(d,c) {
  if (!c) return false;
  if (d.card_type === 'aura') return c.owner_index === 1;
  const e = targetEffect(d);
  if (!e) return false;
  if ((e.type === 'damage' || e.type === 'damage_creature') && e.timing !== 'instant') return c.owner_index === 0;
  if (e.type === 'heal' && e.timing !== 'instant') return c.owner_index === 1;
  return true;
}
function clear() { selectedCard = null; selectedUnit = null; mode = null; pendingTarget = null; }
function notice(text,type='') { const el=$('game-message'); if(el){el.textContent=text;el.className=`game-message ${type}`;} }
function fail(e) { console.error(e); notice(e instanceof Error ? e.message : 'Errore inatteso','error'); }
function controls() {
  const enabled=canAct(), unit=selectedUnit && at(selectedUnit), ready=enabled && unit?.owner_index===1 && !unit.tired;
  const disable=(id,value)=>{if($(id))$(id).disabled=Boolean(value);};
  disable('new-match-button',busy); disable('end-turn-button',!enabled); disable('refresh-button',busy||!matchId);
  disable('choose-attack-button',!ready); disable('choose-move-button',!ready||!me()?.current_mana||!steps().length);
  disable('direct-attack-button',!enabled||mode!=='attack'||foes().length>0);
  disable('cancel-selection-button',busy||(!selectedUnit&&!selectedCard));
  $('creature-action-panel')?.classList.toggle('hidden',!ready);
  if(unit&&$('selected-creature-name'))$('selected-creature-name').textContent=cache.get(unit.card_id)?.name??'Creatura';
  if(unit&&$('selected-creature-details'))$('selected-creature-details').textContent=`ATK ${unit.attack} · HP ${unit.hp}/${unit.max_hp} · ${unit.tired?'Stanca':'Pronta'}`;
  if($('selection-instructions'))$('selection-instructions').textContent=pendingBoss()?'Completa l’evocazione dal pannello Mostrissimi.':!state?'Premi Nuova partita.':selectedCard?pendingTarget?'Bersaglio scelto: clicca la cella di evocazione.':mode==='etb-target'?'Scegli il bersaglio e poi la cella.':'Scegli una cella o un bersaglio.':mode==='move'?'Muovi: clicca una cella verde.':mode==='attack'?foes().length?'Clicca un nemico evidenziato.':'Premi Attacca IA direttamente.':selectedUnit?'Scegli Attacca o Muovi.':'Seleziona una carta o una tua creatura.';
}
function setBusy(value) { busy=value; controls(); }
async function api(path,options={}) {
  const token=await getAccessToken(); if(!token)throw new Error('Sessione scaduta, accedi di nuovo.');
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),45000);
  try {
    const response=await fetch(`${API}${path}`,{method:options.method??'GET',headers:{Authorization:`Bearer ${token}`,...(options.body!==undefined?{'Content-Type':'application/json'}:{})},body:options.body!==undefined?JSON.stringify(options.body):undefined,signal:controller.signal});
    const json=await response.json().catch(()=>({})); if(!response.ok)throw new Error(json.error??`HTTP ${response.status}`); return json;
  } catch(e) { if(e?.name==='AbortError')throw new Error('Render non risponde entro 45 secondi.'); throw e; }
  finally {clearTimeout(timer);}
}
async function getCard(id) {if(!cache.has(id))cache.set(id,(await api(`/cards/${encodeURIComponent(id)}`)).card);return cache.get(id);}
function targets(d) {const result=[];for(let row=0;row<3;row++)for(let col=0;col<3;col++){const position={row,col},cell=at(position);if(targetAllowed(d,cell))result.push({position,cell});}return result;}
function permanents() {
  const result=[];
  for(let row=0;row<3;row++)for(let col=0;col<3;col++){
    const cell=board()[row][col];if(cell?.owner_index!==1)continue;
    result.push({id:cell.instance_id,card_id:cell.card_id,type:'Creatura'});
    for(const aura of cell.auras??[])result.push({id:aura.instance_id,card_id:aura.card_id,type:'Aura'});
  }
  if(me()?.field_spell)result.push({id:me().field_spell.instance_id,card_id:me().field_spell.card_id,type:'Terraforma'});
  return result;
}
function bossPositions(pending) {
  if(!pending)return [];
  const result=[];
  for(let row=0;row<3;row++)for(let col=0;col<3;col++){
    const pos={row,col};
    if(!at(pos)&&(row===2||(row===1&&(pending.freed_positions??[]).some(p=>eq(p,pos)))))result.push(pos);
  }
  return result;
}
async function drawBoard() {
  const root=$('shared-board');if(!root){notice('Manca #shared-board: verifica docs/index.html.','error');return;}
  root.replaceChildren();
  const selected=me()?.hand?.find(c=>c.instance_id===selectedCard), selectedDefinition=selected?cache.get(selected.card_id):null;
  const pending=pendingBoss();
  const summonCells=pending&&pending.paid.length===pending.required?bossPositions(pending):[];
  for(let row=0;row<3;row++){
    const line=document.createElement('div');line.className=`board-row ${['ai-row','center-row','human-row'][row]}`;
    for(let col=0;col<3;col++){
      const pos={row,col},c=at(pos),button=document.createElement('button');button.type='button';button.className='board-cell';
      let d=null;if(c)try{d=await getCard(c.card_id);}catch(e){console.warn(e);}
      button.classList.add(c?c.owner_index===1?'human-card':'ai-card':'empty');
      if(c?.tired)button.classList.add('tired');if(eq(pos,selectedUnit))button.classList.add('selected-creature');
      if(mode==='move'&&steps().some(p=>eq(p,pos)))button.classList.add('valid-move');
      if(mode==='attack'&&foes().some(p=>eq(p,pos)))button.classList.add('valid-target');
      if(selectedCard&&row===2&&!c)button.classList.add('valid-summon');
      if(selectedCard&&selectedDefinition&&needsTarget(selectedDefinition)&&targetAllowed(selectedDefinition,c))button.classList.add('valid-target');
      if(summonCells.some(p=>eq(p,pos)))button.classList.add('valid-summon');
      if(pendingTarget&&c?.instance_id===pendingTarget)button.classList.add('selected-target');
      button.setAttribute('aria-label',c?`${d?.name??'Creatura'} ${c.owner_index===1?'Tu':'IA'} riga ${row} colonna ${col}`:`${['Riga IA','Centro','Riga Tu'][row]} colonna ${col}`);
      button.innerHTML=c?`<span class="cell-coordinate">[${row},${col}]</span><span class="card-type">${c.owner_index===1?'TU':'IA'} · ${c.tired?'STANCA':'PRONTA'}</span><strong class="card-name">${escape(d?.name??'Creatura')}</strong><span class="card-effect">${escape(d?.effect_text??'')}</span><span class="card-stats">${c.attack} / ${c.hp}</span>`:`<span class="empty-label">${['Riga IA','Centro','Riga Tu'][row]}<br>[${row},${col}]</span>`;
      button.onclick=()=>boardClick(pos).catch(fail);line.append(button);
    }
    root.append(line);
  }
}
async function drawHand() {
  const root=$('player-hand');if(!root)return;root.replaceChildren();
  for(const inst of me()?.hand??[]){
    const button=document.createElement('button');button.type='button';button.className='hand-card';
    try{
      const d=await getCard(inst.card_id);if(selectedCard===inst.instance_id)button.classList.add('selected-hand-card');
      if(d.mana_cost>me().current_mana)button.classList.add('unaffordable');
      button.disabled=!canAct();
      button.innerHTML=`<span class="card-cost">${escape(d.mana_cost)}</span><span class="card-type">${escape(d.card_type)}</span><strong class="card-name">${escape(d.name)}</strong><span class="card-effect">${escape(d.effect_text??'')}</span><span class="card-stats">${d.attack??'—'} / ${d.hp??'—'}</span>`;
      button.onclick=async()=>{
        if(!canAct())return;
        selectedCard=selectedCard===inst.instance_id?null:inst.instance_id;selectedUnit=null;pendingTarget=null;mode=null;
        if(selectedCard&&creature(d)&&needsTarget(d)){if(targets(d).length){mode='etb-target';notice('Scegli un bersaglio ETB, poi la cella.','success');}else notice('Nessun bersaglio valido: l’ETB non si attiverà.','success');}
        await render();
      };
    }catch(e){button.textContent='Carta non caricabile';button.disabled=true;console.warn(e);}
    root.append(button);
  }
}
async function renderBoss() {
  let panel=$('mostrissimo-panel');
  if(!panel){panel=document.createElement('section');panel.id='mostrissimo-panel';panel.className='hand-section panel';panel.setAttribute('aria-label','Mostrissimi disponibili');const before=document.querySelector('.logs-panel')??$('game-message');if(before?.parentNode)before.parentNode.insertBefore(panel,before);else document.body.append(panel);}
  panel.replaceChildren();const heading=document.createElement('h2');heading.textContent='Mostrissimi · Offerta condivisa';panel.append(heading);
  if(!state){panel.classList.add('hidden');return;}panel.classList.remove('hidden');
  const pending=pendingBoss(),choices=state.shared_mostrissimi??[];
  for(const inst of choices){
    const card=await getCard(inst.card_id),button=document.createElement('button');button.type='button';button.className='hand-card';
    if(bossChoice===inst.card_id||pending?.card_id===inst.card_id)button.classList.add('selected-hand-card');
    button.textContent=`${card.name} · ${card.sacrifice_cost} sacrifici · ${card.attack??0}/${card.hp??1} · ${card.effect_text??''}`;
    button.disabled=!canAct()||state.last_mostrissimo_turn?.[1]===state.current_turn;
    button.onclick=()=>{bossChoice=inst.card_id;render().catch(fail);};panel.append(button);
  }
  if(!pending&&bossChoice&&choices.some(inst=>inst.card_id===bossChoice)&&canAct()){
    const card=await getCard(bossChoice),cost=Number(card.sacrifice_cost),ownCreatures=board().flat().filter(c=>c?.owner_index===1).length;
    const possible=Number.isInteger(cost)&&cost>=0&&cost<=6&&permanents().length>=cost&&(board()[2].some(c=>!c)||(cost>0&&ownCreatures>0))&&state.last_mostrissimo_turn?.[1]!==state.current_turn;
    if(possible){const go=document.createElement('button');go.type='button';go.className='primary-button';go.textContent='Evoca';go.onclick=()=>bossAction('start',{cardId:bossChoice},'Evocazione iniziata: non puoi annullare.');panel.append(go);}
    const cancel=document.createElement('button');cancel.type='button';cancel.className='secondary-button';cancel.textContent='Annulla';cancel.onclick=()=>{bossChoice=null;render().catch(fail);};panel.append(cancel);
  }
  if(!pending)return;
  const text=document.createElement('p');text.textContent=`Sacrifici confermati: ${pending.paid.length}/${pending.required}. Procedura non annullabile.`;panel.append(text);
  if(pending.paid.length<pending.required){
    for(const item of permanents()){
      const card=await getCard(item.card_id),button=document.createElement('button');button.type='button';button.className='hand-card';
      button.textContent=`${item.type}: ${card.name}${bossTribute===item.id?' · selezionato':''}`;
      button.disabled=busy;button.onclick=()=>{bossTribute=item.id;render().catch(fail);};panel.append(button);
    }
    const confirm=document.createElement('button');confirm.type='button';confirm.className='primary-button';confirm.textContent='Conferma sacrificio';confirm.disabled=busy||!bossTribute;
    confirm.onclick=()=>bossAction('sacrifice',{instanceId:bossTribute},'Sacrificio risolto.');panel.append(confirm);
  }else{
    const card=await getCard(pending.card_id),validTargets=targets(card);
    const text=document.createElement('p');text.textContent='Scegli il bersaglio ETB, se richiesto, poi clicca una cella libera della tua riga o liberata dai sacrifici.';panel.append(text);
    if(targetEffect(card)&&validTargets.length){
      const select=document.createElement('select');select.id='boss-effect-target';select.setAttribute('aria-label','Bersaglio effetto di ingresso');
      const empty=document.createElement('option');empty.value='';empty.textContent='Scegli il bersaglio ETB';select.append(empty);
      for(const item of validTargets){const definition=await getCard(item.cell.card_id),option=document.createElement('option');option.value=item.cell.instance_id;option.textContent=`${definition.name} (${item.cell.owner_index===1?'Tu':'IA'})`;select.append(option);}
      panel.append(select);
    }
  }
}
async function render() {
  const set=(id,value)=>{if($(id))$(id).textContent=String(value);};
  set('match-status',state?.status==='finished'?'Terminata':state?'In corso':'Nessuna partita');
  set('turn-status',state?`${state.current_turn} · ${state.active_player_index===1?'Tu':'IA'}`:'—');set('phase-status',state?.phase==='main'?'Principale':state?.phase??'—');
  set('player-life',me()?.life??20);set('player-mana',`${me()?.current_mana??0} / ${me()?.max_mana??0}`);
  set('player-hand-count',me()?.hand?.length??0);set('player-deck-count',me()?.deck?.length??0);set('player-graveyard-count',me()?.graveyard?.length??0);
  set('opponent-life',them()?.life??20);set('opponent-hand-count',them()?.hand?.length??0);set('opponent-deck-count',them()?.deck?.length??0);set('opponent-graveyard-count',them()?.graveyard?.length??0);
  for(const [id,owner,name] of [['player-field-spell',me(),'Tu'],['opponent-field-spell',them(),'IA']]){let text=`${name}: Nessuna Terraforma`;if(owner?.field_spell)try{text=`${name}: ${(await getCard(owner.field_spell.card_id)).name}`;}catch{}set(id,text);}
  await drawBoard();await drawHand();await renderBoss();controls();
}
async function logs() {if(!$('match-logs')||!matchId)return;const {logs:events}=await api(`/match/${matchId}/logs?limit=100`);$('match-logs').replaceChildren();for(const e of events??[]){const li=document.createElement('li');li.textContent=e.log_data?.description??e.log_data?.action_type??'Evento';$('match-logs').append(li);}$('match-logs').scrollTop=$('match-logs').scrollHeight;}
async function refreshView(message,type='success'){await render();try{await logs();}catch(e){console.warn(e);}if(message)notice(message,type);}
async function run(path,body,success,after=()=>{}){
  if(busy||!matchId)return;setBusy(true);
  try{
    state=(await api(`/match/${matchId}/${path}`,{method:'POST',body})).state;after();clear();
    const message=state.status==='finished'?(state.winner_index===1?'HAI VINTO!':'HAI PERSO!'):state.mostrissimo_result?.outcome==='failed'?state.mostrissimo_result.message:success;
    await refreshView(message,state.mostrissimo_result?.outcome==='failed'?'error':'success');
  }catch(e){fail(e);}finally{setBusy(false);await render().catch(fail);}
}
async function bossAction(endpoint,body,message){return run(`mostrissimo/${endpoint}`,body,message,()=>{bossTribute=null;if(!pendingBoss())bossChoice=null;});}
async function action(endpoint,body,message){if(pendingBoss())return notice('Completa prima l’evocazione del Mostrissimo.','error');return run(endpoint,body,message);}
async function boardClick(pos){
  if(!myTurn()||busy)return;const c=at(pos),pending=pendingBoss();
  if(pending){
    if(pending.paid.length<pending.required){if(!c||c.owner_index!==1)return notice('Seleziona un tuo permanente da sacrificare.','error');bossTribute=c.instance_id;await render();notice('Permanente selezionato: premi Conferma sacrificio.','success');return;}
    const card=await getCard(pending.card_id);
    if(c||!bossPositions(pending).some(p=>eq(p,pos)))return notice('Cella non valida per questa evocazione.','error');
    const targetId=$('boss-effect-target')?.value||null;
    if(targetEffect(card)&&!targetId&&targets(card).length)return notice('Seleziona prima un bersaglio ETB dal pannello.','error');
    return bossAction('complete',{position:pos,...(targetId?{targetInstanceId:targetId}:{})},'Mostrissimo evocato.');
  }
  if(selectedCard){
    const inst=me().hand.find(x=>x.instance_id===selectedCard);if(!inst){clear();return render();}
    const d=await getCard(inst.card_id);
    if(creature(d)){
      const candidates=needsTarget(d)?targets(d):[];
      if(c&&needsTarget(d)){if(!targetAllowed(d,c))return notice('Bersaglio ETB non valido.','error');pendingTarget=c.instance_id;mode='etb-target';await render();notice('Bersaglio scelto: ora clicca una cella libera della riga Tu.','success');return;}
      if(pos.row!==2||c)return notice('Evoca solo in una cella libera della riga Tu.','error');
      if(candidates.length&&!pendingTarget)return notice('Seleziona prima un bersaglio ETB.','error');
      return action('play-card',{cardInstanceId:inst.instance_id,options:{position:pos,...(pendingTarget?{targetInstanceId:pendingTarget}:{})}},'Creatura evocata.');
    }
    if(needsTarget(d)){if(!targetAllowed(d,c))return notice('Seleziona una creatura valida.','error');return action('play-card',{cardInstanceId:inst.instance_id,options:{targetInstanceId:c.instance_id}},'Carta giocata.');}
    return action('play-card',{cardInstanceId:inst.instance_id,options:{}},'Carta giocata.');
  }
  if(mode==='move'){if(!steps().some(p=>eq(p,pos)))return notice('Seleziona una cella libera adiacente, non nella riga IA.','error');return action('move',{from:selectedUnit,to:pos},'Creatura mossa.');}
  if(mode==='attack'){if(!foes().some(p=>eq(p,pos)))return notice('Seleziona un nemico adiacente oppure Attacca IA direttamente.','error');return action('attack',{attackerPosition:selectedUnit,target:{type:'creature',position:pos}},'Attacco risolto.');}
  if(c?.owner_index===1){if(c.tired)return notice('Creatura stanca: non può attaccare né muoversi.','error');selectedUnit=pos;selectedCard=null;mode=null;return render();}
  if(c?.owner_index===0)notice('Seleziona prima una tua creatura.','error');
}
async function newMatch(){
  if(busy)return;setBusy(true);notice('Creazione partita…');
  try{bossChoice=null;bossTribute=null;const result=await api('/match/create',{method:'POST',body:{}});matchId=result.match_id;state=result.state;clear();localStorage.setItem('bellum:last-match',matchId);await refreshView('Partita pronta: scegli una carta o un Mostrissimo.','success');}
  catch(e){fail(e);}finally{setBusy(false);await render().catch(fail);}
}
async function refreshMatch(){if(busy||!matchId)return;setBusy(true);try{state=(await api(`/match/${matchId}`)).state;await refreshView('Aggiornato.','success');}catch(e){fail(e);}finally{setBusy(false);await render().catch(fail);}}
async function init(){
  if(initialized)return;const user=await getCurrentUser();if(!user)return;initialized=true;
  if($('signed-in-user'))$('signed-in-user').textContent=`@${usernameFromEmail(user.email)}`;
  if($('player-title'))$('player-title').textContent=usernameFromEmail(user.email)||'Tu';
  $('new-match-button')?.addEventListener('click',()=>newMatch().catch(fail));
  $('choose-attack-button')?.addEventListener('click',()=>{if(!canAct()||!selectedUnit)return;mode='attack';render().catch(fail);notice(foes().length?'Seleziona il nemico evidenziato.':'Premi Attacca IA direttamente.','success');});
  $('choose-move-button')?.addEventListener('click',()=>{if(!canAct()||!selectedUnit||!me()?.current_mana||!steps().length)return;mode='move';render().catch(fail);});
  $('direct-attack-button')?.addEventListener('click',()=>{if(canAct()&&selectedUnit&&mode==='attack'&&!foes().length)action('attack',{attackerPosition:selectedUnit,target:{type:'player',playerIndex:0}},'Attacco diretto risolto.');});
  for(const id of ['cancel-creature-action-button','cancel-selection-button'])$(id)?.addEventListener('click',()=>{clear();render().catch(fail);});
  $('end-turn-button')?.addEventListener('click',()=>{if(canAct()){notice('L’IA sta giocando…');action('end-turn',{},'È di nuovo il tuo turno.');}});
  $('refresh-button')?.addEventListener('click',()=>refreshMatch().catch(fail));
  $('logout-button')?.addEventListener('click',()=>signOut().then(()=>{matchId=null;state=null;clear();}).catch(fail));
  await render();const prior=localStorage.getItem('bellum:last-match');
  if(prior)try{const result=await api(`/match/${prior}`);if(result.state?.state_version===2&&result.state.players?.[1]?.user_id===user.id){matchId=prior;state=result.state;await render();await logs();notice('Partita precedente ripristinata.','success');}}catch(e){console.warn('Ripristino non disponibile',e);}
}
window.addEventListener('bellum:auth-ready',()=>init().catch(fail));
getCurrentUser().then(user=>{if(user)return init();}).catch(fail);
