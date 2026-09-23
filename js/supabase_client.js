/**
 * Bellum Penumbrum - Supabase Client Configuration
 * Utilizzo: importare in tutti i moduli che necessitano di accesso al database
 */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/main/+esm.js';

// Configurazione Supabase
const SUPABASE_URL = 'https://dgsqxnmrjfvklnjliplh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_ZwwwsHnjEWNbe2CnDKsTSA_8ljXZlOG';

// Crea istanza del client Supabase
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true
    }
});

// ============================================
// FUNZIONI DI AUTENTICAZIONE
// ============================================

/**
 * Registra un nuovo utente con email e password
 * @param {string} email 
 * @param {string} password 
 * @param {string} username 
 * @returns {Promise<{data: any, error: any}>}
 */
export async function signUp(email, password, username) {
    const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
            data: {
                username: username
            }
        }
    });
    
    if (error) {
        console.error('Errore signup:', error.message);
        return { data: null, error };
    }
    
    // Crea il profilo utente nella tabella public.users
    if (data.user) {
        const { error: profileError } = await supabase
            .from('users')
            .insert([{
                id: data.user.id,
                username: username,
                email: email
            }]);
        
        if (profileError) {
            console.error('Errore creazione profilo:', profileError.message);
            return { data: null, error: profileError };
        }
    }
    
    return { data, error: null };
}

/**
 * Effettua il login con email e password
 * @param {string} email 
 * @param {string} password 
 * @returns {Promise<{data: any, error: any}>}
 */
export async function signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password
    });
    
    if (error) {
        console.error('Errore login:', error.message);
        return { data: null, error };
    }
    
    return { data, error: null };
}

/**
 * Effettua il logout
 * @returns {Promise<{error: any}>}
 */
export async function signOut() {
    const { error } = await supabase.auth.signOut();
    
    if (error) {
        console.error('Errore logout:', error.message);
        return { error };
    }
    
    return { error: null };
}

/**
 * Ottiene la sessione corrente
 * @returns {Promise<{session: any | null}>}
 */
export async function getSession() {
    const { data: { session } } = await supabase.auth.getSession();
    return { session };
}

/**
 * Ottiene l'utente corrente
 * @returns {Promise<{user: any | null}>}
 */
export async function getCurrentUser() {
    const { data: { user } } = await supabase.auth.getUser();
    return { user };
}

/**
 * Ascolta i cambiamenti di autenticazione
 * @param {Function} callback - funzione da chiamare quando cambia lo stato auth
 * @returns {Object} subscription con unsubscribe()
 */
export function onAuthStateChange(callback) {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
        callback(event, session);
    });
    
    return subscription;
}

// ============================================
// FUNZIONI PER IL PROFILO UTENTE
// ============================================

/**
 * Ottiene il profilo dell'utente corrente
 * @returns {Promise<{profile: any | null, error: any}>}
 */
export async function getUserProfile() {
    const { user, error: authError } = await getCurrentUser();
    
    if (authError || !user) {
        return { profile: null, error: authError || new Error('Utente non autenticato') };
    }
    
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', user.id)
        .single();
    
    if (error) {
        console.error('Errore recupero profilo:', error.message);
        return { profile: null, error };
    }
    
    return { profile: data, error: null };
}

/**
 * Aggiorna il profilo dell'utente (username)
 * @param {string} username 
 * @returns {Promise<{data: any, error: any}>}
 */
export async function updateUserProfile(username) {
    const { user } = await getCurrentUser();
    
    if (!user) {
        return { data: null, error: new Error('Utente non autenticato') };
    }
    
    const { data, error } = await supabase
        .from('users')
        .update({ username })
        .eq('id', user.id)
        .select()
        .single();
    
    if (error) {
        console.error('Errore aggiornamento profilo:', error.message);
        return { data: null, error };
    }
    
    return { data, error: null };
}

/**
 * Ottiene le statistiche dell'utente
 * @returns {Promise<{stats: any | null, error: any}>}
 */
export async function getUserStats() {
    const { user } = await getCurrentUser();
    
    if (!user) {
        return { stats: null, error: new Error('Utente non autenticato') };
    }
    
    const { data, error } = await supabase
        .from('user_stats')
        .select('*')
        .eq('id', user.id)
        .single();
    
    if (error) {
        console.error('Errore recupero statistiche:', error.message);
        return { stats: null, error };
    }
    
    return { stats: data, error: null };
}

// ============================================
// FUNZIONI PER LE CARTE
// ============================================

/**
 * Ottiene tutte le carte dal catalogo
 * @param {Object} filters - filtri opzionali (faction_id, card_type, mana_cost)
 * @returns {Promise<{cards: Array, error: any}>}
 */
export async function getCards(filters = {}) {
    let query = supabase
        .from('cards')
        .select(`
            *,
            factions (
                name,
                code,
                color_hex
            )
        `);
    
    if (filters.faction_id) {
        query = query.eq('faction_id', filters.faction_id);
    }
    
    if (filters.card_type) {
        query = query.eq('card_type', filters.card_type);
    }
    
    if (filters.mana_cost) {
        query = query.eq('mana_cost', filters.mana_cost);
    }
    
    if (filters.is_boss !== undefined) {
        query = query.eq('is_boss', filters.is_boss);
    }
    
    const { data, error } = await query.order('mana_cost', { ascending: true });
    
    if (error) {
        console.error('Errore recupero carte:', error.message);
        return { cards: [], error };
    }
    
    return { cards: data, error: null };
}

/**
 * Ottiene una carta specifica per ID
 * @param {string} cardId 
 * @returns {Promise<{card: any | null, error: any}>}
 */
export async function getCardById(cardId) {
    const { data, error } = await supabase
        .from('cards')
        .select(`
            *,
            factions (
                name,
                code,
                color_hex
            )
        `)
        .eq('id', cardId)
        .single();
    
    if (error) {
        console.error('Errore recupero carta:', error.message);
        return { card: null, error };
    }
    
    return { card: data, error: null };
}

/**
 * Ottiene tutte le fazioni
 * @returns {Promise<{factions: Array, error: any}>}
 */
export async function getFactions() {
    const { data, error } = await supabase
        .from('factions')
        .select('*')
        .order('id');
    
    if (error) {
        console.error('Errore recupero fazioni:', error.message);
        return { factions: [], error };
    }
    
    return { factions: data, error: null };
}

// ============================================
// FUNZIONI PER I MAZZI
// ============================================

/**
 * Crea un nuovo mazzo
 * @param {Object} deckData - dati del mazzo
 * @returns {Promise<{deck: any, error: any}>}
 */
export async function createDeck(deckData) {
    const { user } = await getCurrentUser();
    
    if (!user) {
        return { deck: null, error: new Error('Utente non autenticato') };
    }
    
    const { data, error } = await supabase
        .from('decks')
        .insert([{
            user_id: user.id,
            ...deckData
        }])
        .select()
        .single();
    
    if (error) {
        console.error('Errore creazione mazzo:', error.message);
        return { deck: null, error };
    }
    
    return { deck: data, error: null };
}

/**
 * Ottiene tutti i mazzi dell'utente corrente
 * @returns {Promise<{decks: Array, error: any}>}
 */
export async function getUserDecks() {
    const { user } = await getCurrentUser();
    
    if (!user) {
        return { decks: [], error: new Error('Utente non autenticato') };
    }
    
    const { data, error } = await supabase
        .from('deck_summary')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
    
    if (error) {
        console.error('Errore recupero mazzi:', error.message);
        return { decks: [], error };
    }
    
    return { decks: data, error: null };
}

/**
 * Ottiene le carte di un mazzo specifico
 * @param {string} deckId 
 * @returns {Promise<{cards: Array, error: any}>}
 */
export async function getDeckCards(deckId) {
    const { data, error } = await supabase
        .from('deck_cards')
        .select(`
            *,
            cards (
                *,
                factions (
                    name,
                    code,
                    color_hex
                )
            )
        `)
        .eq('deck_id', deckId);
    
    if (error) {
        console.error('Errore recupero carte mazzo:', error.message);
        return { cards: [], error };
    }
    
    return { cards: data, error: null };
}

/**
 * Aggiunge una carta a un mazzo
 * @param {string} deckId 
 * @param {string} cardId 
 * @param {number} quantity 
 * @returns {Promise<{data: any, error: any}>}
 */
export async function addCardToDeck(deckId, cardId, quantity = 1) {
    const { data, error } = await supabase
        .from('deck_cards')
        .upsert({
            deck_id: deckId,
            card_id: cardId,
            quantity: quantity
        })
        .onConflict('deck_id,card_id')
        .select();
    
    if (error) {
        console.error('Errore aggiunta carta al mazzo:', error.message);
        return { data: null, error };
    }
    
    return { data, error: null };
}

/**
 * Rimuove una carta da un mazzo
 * @param {string} deckId 
 * @param {string} cardId 
 * @returns {Promise<{error: any}>}
 */
export async function removeCardFromDeck(deckId, cardId) {
    const { error } = await supabase
        .from('deck_cards')
        .delete()
        .eq('deck_id', deckId)
        .eq('card_id', cardId);
    
    if (error) {
        console.error('Errore rimozione carta dal mazzo:', error.message);
        return { error };
    }
    
    return { error: null };
}

/**
 * Ottiene l'extra deck (mostrissimi) di un mazzo
 * @param {string} deckId 
 * @returns {Promise<{mostrissimi: Array, error: any}>}
 */
export async function getExtraDeck(deckId) {
    const { data, error } = await supabase
        .from('extra_deck')
        .select(`
            *,
            cards (
                *,
                factions (
                    name,
                    code,
                    color_hex
                )
            )
        `)
        .eq('deck_id', deckId)
        .order('position');
    
    if (error) {
        console.error('Errore recupero extra deck:', error.message);
        return { mostrissimi: [], error };
    }
    
    return { mostrissimi: data, error: null };
}

/**
 * Aggiunge un mostrissimo all'extra deck
 * @param {string} deckId 
 * @param {string} cardId 
 * @param {number} position (1-3)
 * @returns {Promise<{data: any, error: any}>}
 */
export async function addMostrissimoToExtraDeck(deckId, cardId, position) {
    const { data, error } = await supabase
        .from('extra_deck')
        .insert([{
            deck_id: deckId,
            card_id: cardId,
            position: position
        }])
        .select();
    
    if (error) {
        console.error('Errore aggiunta mostrissimo:', error.message);
        return { data: null, error };
    }
    
    return { data, error: null };
}

// ============================================
// FUNZIONI PER LE PARTITE
// ============================================

/**
 * Crea una nuova partita
 * @param {Object} matchData - dati della partita
 * @returns {Promise<{match: any, error: any}>}
 */
export async function createMatch(matchData) {
    const { user } = await getCurrentUser();
    
    if (!user) {
        return { match: null, error: new Error('Utente non autenticato') };
    }
    
    const { data, error } = await supabase
        .from('matches')
        .insert([{
            player_id: user.id,
            ...matchData
        }])
        .select()
        .single();
    
    if (error) {
        console.error('Errore creazione partita:', error.message);
        return { match: null, error };
    }
    
    return { match: data, error: null };
}

/**
 * Salva il log di una partita
 * @param {string} matchId 
 * @param {Object} logData - log completo della partita
 * @returns {Promise<{data: any, error: any}>}
 */
export async function saveMatchLog(matchId, logData) {
    const { data, error } = await supabase
        .from('match_logs')
        .insert([{
            match_id: matchId,
            log_data: logData
        }])
        .select()
        .single();
    
    if (error) {
        console.error('Errore salvataggio log partita:', error.message);
        return { data: null, error };
    }
    
    return { data, error: null };
}

/**
 * Aggiorna lo stato corrente di una partita
 * @param {string} matchId 
 * @param {Object} stateJson - stato della partita
 * @param {number} currentTurn 
 * @param {number} currentPhase 
 * @returns {Promise<{data: any, error: any}>}
 */
export async function updateGameState(matchId, stateJson, currentTurn, currentPhase) {
    const { data, error } = await supabase
        .from('game_state')
        .upsert({
            match_id: matchId,
            state_json: stateJson,
            current_turn: currentTurn,
            current_phase: currentPhase,
            last_updated: new Date().toISOString()
        })
        .onConflict('match_id')
        .select();
    
    if (error) {
        console.error('Errore aggiornamento stato partita:', error.message);
        return { data: null, error };
    }
    
    return { data, error: null };
}

/**
 * Ottiene lo stato corrente di una partita
 * @param {string} matchId 
 * @returns {Promise<{state: any | null, error: any}>}
 */
export async function getGameState(matchId) {
    const { data, error } = await supabase
        .from('game_state')
        .select('*')
        .eq('match_id', matchId)
        .single();
    
    if (error) {
        console.error('Errore recupero stato partita:', error.message);
        return { state: null, error };
    }
    
    return { state: data, error: null };
}

/**
 * Ottiene lo storico partite dell'utente
 * @param {number} limit - numero massimo di partite da recuperare
 * @returns {Promise<{matches: Array, error: any}>}
 */
export async function getUserMatches(limit = 20) {
    const { user } = await getCurrentUser();
    
    if (!user) {
        return { matches: [], error: new Error('Utente non autenticato') };
    }
    
    const { data, error } = await supabase
        .from('matches')
        .select(`
            *,
            opponent_faction (
                name,
                code
            )
        `)
        .eq('player_id', user.id)
        .order('created_at', { ascending: false })
        .limit(limit);
    
    if (error) {
        console.error('Errore recupero storico partite:', error.message);
        return { matches: [], error };
    }
    
    return { matches: data, error: null };
}

// ============================================
// FUNZIONI PER I CONTATORI COLORE
// ============================================

/**
 * Ottiene i contatori colore dell'utente
 * @returns {Promise<{counters: Array, error: any}>}
 */
export async function getColorCounters() {
    const { user } = await getCurrentUser();
    
    if (!user) {
        return { counters: [], error: new Error('Utente non autenticato') };
    }
    
    const { data, error } = await supabase
        .from('color_counters')
        .select(`
            *,
            factions (
                name,
                code,
                color_hex
            )
        `)
        .eq('user_id', user.id);
    
    if (error) {
        console.error('Errore recupero contatori:', error.message);
        return { counters: [], error };
    }
    
    return { counters: data, error: null };
}

/**
 * Incrementa il contatore di una fazione
 * @param {number} factionId 
 * @returns {Promise<{data: any, error: any}>}
 */
export async function incrementFactionCounter(factionId) {
    const { user } = await getCurrentUser();
    
    if (!user) {
        return { data: null, error: new Error('Utente non autenticato') };
    }
    
    // Inserisci se non esiste, altrimenti incrementa
    const { data, error } = await supabase.rpc('increment_faction_counter', {
        p_user_id: user.id,
        p_faction_id: factionId
    });
    
    if (error) {
        console.error('Errore incremento contatore:', error.message);
        return { data: null, error };
    }
    
    return { data, error: null };
}

/**
 * Resetta il contatore di una fazione (dopo aver usato l'abilità)
 * @param {number} factionId 
 * @returns {Promise<{error: any}>}
 */
export async function resetFactionCounter(factionId) {
    const { user } = await getCurrentUser();
    
    if (!user) {
        return { error: new Error('Utente non autenticato') };
    }
    
    const { error } = await supabase
        .from('color_counters')
        .update({ 
            counter: 0,
            last_activated: new Date().toISOString()
        })
        .eq('user_id', user.id)
        .eq('faction_id', factionId);
    
    if (error) {
        console.error('Errore reset contatore:', error.message);
        return { error };
    }
    
    return { error: null };
}

// ============================================
// FUNZIONI PER L'IA
// ============================================

/**
 * Ottiene tutti i profili IA disponibili
 * @returns {Promise<{profiles: Array, error: any}>}
 */
export async function getAIProfiles() {
    const { data, error } = await supabase
        .from('ai_profiles')
        .select('*')
        .order('id');
    
    if (error) {
        console.error('Errore recupero profili IA:', error.message);
        return { profiles: [], error };
    }
    
    return { profiles: data, error: null };
}

/**
 * Ottiene un profilo IA casuale per una partita
 * @returns {Promise<{profile: any, error: any}>}
 */
export async function getRandomAIProfile() {
    const { data, error } = await supabase
        .from('ai_profiles')
        .select('*')
        .order('id')
        .limit(10); // Prende 10 profili
    
    if (error || data.length === 0) {
        console.error('Errore recupero profilo IA casuale:', error?.message);
        return { profile: null, error: error || new Error('Nessun profilo IA trovato') };
    }
    
    // Sceglie un profilo casuale
    const randomIndex = Math.floor(Math.random() * data.length);
    return { profile: data[randomIndex], error: null };
}

// ============================================
// FUNZIONE RPC: increment_faction_counter
// ============================================
// Questa funzione deve essere creata in Supabase con:
/*
CREATE OR REPLACE FUNCTION public.increment_faction_counter(
    p_user_id UUID,
    p_faction_id INTEGER
)
RETURNS TABLE(counter INTEGER) AS $$
DECLARE
    v_counter INTEGER;
BEGIN
    -- Inserisci se non esiste
    INSERT INTO public.color_counters (user_id, faction_id, counter)
    VALUES (p_user_id, p_faction_id, 0)
    ON CONFLICT (user_id, faction_id) DO NOTHING;
    
    -- Incrementa e ritorna
    UPDATE public.color_counters
    SET counter = counter + 1
    WHERE user_id = p_user_id AND faction_id = p_faction_id
    RETURNING counter INTO v_counter;
    
    RETURN QUERY SELECT v_counter;
END;
$$ LANGUAGE plpgsql;
*/

// ============================================
// INIZIALIZZAZIONE
// ============================================

/**
 * Inizializza il client e verifica la connessione
 * @returns {Promise<boolean>}
 */
export async function initializeSupabase() {
    try {
        const { session, error } = await getSession();
        
        if (error) {
            console.error('Errore inizializzazione Supabase:', error.message);
            return false;
        }
        
        console.log('Supabase inizializzato con successo');
        if (session) {
            console.log('Sessione attiva per utente:', session.user.email);
        } else {
            console.log('Nessuna sessione attiva');
        }
        
        return true;
    } catch (err) {
        console.error('Eccezione durante inizializzazione:', err);
        return false;
    }
}

// Esporta tutto come oggetto globale per debugging
if (typeof window !== 'undefined') {
    window.BellumSupabase = {
        supabase,
        signUp,
        signIn,
        signOut,
        getSession,
        getCurrentUser,
        onAuthStateChange,
        getUserProfile,
        updateUserProfile,
        getUserStats,
        getCards,
        getCardById,
        getFactions,
        createDeck,
        getUserDecks,
        getDeckCards,
        addCardToDeck,
        removeCardFromDeck,
        getExtraDeck,
        addMostrissimoToExtraDeck,
        createMatch,
        saveMatchLog,
        updateGameState,
        getGameState,
        getUserMatches,
        getColorCounters,
        incrementFactionCounter,
        resetFactionCounter,
        getAIProfiles,
        getRandomAIProfile,
        initializeSupabase
    };
}