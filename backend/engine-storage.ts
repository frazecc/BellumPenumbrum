// backend/engine-storage.ts — persistenza e catalogo Supabase per lo stato v4.
import { createClient } from '@supabase/supabase-js';
import type { CardData, GameState, MatchLogEntry } from './types.js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
export const db = createClient(url, key);

export async function load(id: string): Promise<GameState> {
  const { data, error } = await db.from('game_state').select('state_json,revision').eq('match_id', id).single();
  if (error || !data) throw new Error(`Stato partita non trovato: ${error?.message ?? id}`);
  const s = data.state_json as GameState;
  if (s.state_version !== 4 || !s.board?.rows || !Array.isArray(s.work_queue))
    throw new Error('Partita precedente non compatibile: avvia una nuova partita.');
  if (Number(data.revision) !== s.state_revision) throw new Error('Revisione dello stato non coerente');
  return s;
}

export async function commit(id: string, s: GameState, logs: MatchLogEntry[]): Promise<GameState> {
  // Numero deterministico per ciascun commit CAS e posizione all'interno del blocco.
  // I due campi restano in log_data, non modificano GameState né richiedono migrazioni.
  const orderedLogs = logs.map((entry, index) => ({
    ...entry, log_revision: s.state_revision + 1, log_order: index,
  }));
  const { data, error } = await db.rpc('commit_match_state', {
    p_match_id: id, p_expected_revision: s.state_revision, p_next_state: s, p_log_entries: orderedLogs,
  });
  if (error) throw new Error(`Salvataggio partita: ${error.message}`);
  return data as GameState;
}

export async function saveGameState(id: string, s: GameState): Promise<GameState> { return commit(id, s, []); }
export async function logMatchAction(id: string, entry: MatchLogEntry): Promise<void> {
  const { error } = await db.from('match_logs').insert({ match_id: id, log_data: entry });
  if (error) throw new Error(`Log partita: ${error.message}`);
}
export async function getCardData(id: string): Promise<CardData> {
  const { data, error } = await db.from('cards').select('id,name,faction_id,card_type,mana_cost,sacrifice_cost,attack,hp,subtype,rarity,effect_text,effect_json,effect_on_death_json,flavor_text,image_url,keywords,factions!left(code)').eq('id', id).single();
  if (error || !data) throw new Error(`Carta non trovata: ${error?.message ?? id}`);
  const f = Array.isArray(data.factions) ? data.factions[0] : data.factions;
  return { ...data, faction_code: f && typeof f === 'object' && 'code' in f ? String(f.code) : 'IND' } as CardData;
}
