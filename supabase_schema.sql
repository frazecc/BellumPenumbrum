-- Bellum Penumbrum - Supabase Database Schema
-- Esegui questo script nell'editor SQL del tuo progetto Supabase

-- Abilita l'estensione UUID se non già attiva
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- TABELLA: users (profili utente)
-- ============================================
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_login TIMESTAMPTZ DEFAULT NOW(),
    total_matches INTEGER DEFAULT 0,
    total_wins INTEGER DEFAULT 0,
    total_losses INTEGER DEFAULT 0,
    CONSTRAINT valid_username CHECK (LENGTH(username) >= 3 AND LENGTH(username) <= 20)
);

-- ============================================
-- TABELLA: factions (le 6 fazioni + incolore)
-- ============================================
CREATE TABLE IF NOT EXISTS public.factions (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    code TEXT UNIQUE NOT NULL, -- es: 'CHI', 'INF', 'PES', 'BUL', 'GRO', 'CLO', 'IND'
    description TEXT,
    color_hex TEXT
);

-- Inserimento fazioni iniziali
INSERT INTO public.factions (name, code, description, color_hex) VALUES
    ('Chiericanza', 'CHI', 'Bianco - Supporto e protezione', '#FFFFFF'),
    ('Infamia', 'INF', 'Blu - Manipolazione e controllo', '#4169E1'),
    ('Pestilenza', 'PES', 'Nero - Distruzione e sacrificio', '#2C2C2C'),
    ('Bullismo', 'BUL', 'Rosso - Aggressione diretta', '#DC143C'),
    ('Grossanza', 'GRO', 'Verde - Potere bruto e resilienza', '#228B22'),
    ('Clownerie', 'CLO', 'Giallo - Caos e imprevedibilità', '#FFD700'),
    ('Indrazzi', 'IND', 'Incolore - Rare fortissime con sacrificio', '#8B4513')
ON CONFLICT (code) DO NOTHING;

-- ============================================
-- TABELLA: cards (catalogo di tutte le carte)
-- ============================================
CREATE TABLE IF NOT EXISTS public.cards (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    faction_id INTEGER REFERENCES public.factions(id),
    card_type TEXT NOT NULL CHECK (card_type IN ('monster', 'mostrissimo', 'sorcery', 'instant', 'field_spell', 'aura')),
    mana_cost INTEGER NOT NULL CHECK (mana_cost BETWEEN 0 AND 6),
    hp INTEGER, -- solo per mostri e mostrissimi
    attack INTEGER, -- solo per mostri e mostrissimi
    effect_text TEXT,
    effect_json JSONB, -- struttura dati per effetti complessi
    is_boss BOOLEAN DEFAULT FALSE,
    is_indrazzi BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(name, faction_id)
);

-- Indici per performance
CREATE INDEX IF NOT EXISTS idx_cards_faction ON public.cards(faction_id);
CREATE INDEX IF NOT EXISTS idx_cards_type ON public.cards(card_type);
CREATE INDEX IF NOT EXISTS idx_cards_mana ON public.cards(mana_cost);

-- ============================================
-- TABELLA: decks (mazzi degli utenti)
-- ============================================
CREATE TABLE IF NOT EXISTS public.decks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    primary_faction_id INTEGER REFERENCES public.factions(id),
    secondary_faction_id INTEGER REFERENCES public.factions(id),
    tertiary_faction_id INTEGER REFERENCES public.factions(id),
    boss_card_id UUID REFERENCES public.cards(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    mana_curve_avg NUMERIC(3,2) CHECK (mana_curve_avg BETWEEN 2.5 AND 4.0),
    is_valid BOOLEAN DEFAULT FALSE,
    CONSTRAINT valid_factions CHECK (
        primary_faction_id IS DISTINCT FROM secondary_faction_id AND
        primary_faction_id IS DISTINCT FROM tertiary_faction_id AND
        secondary_faction_id IS DISTINCT FROM tertiary_faction_id
    )
);

-- ============================================
-- TABELLA: deck_cards (carte nei mazzi)
-- ============================================
CREATE TABLE IF NOT EXISTS public.deck_cards (
    deck_id UUID REFERENCES public.decks(id) ON DELETE CASCADE,
    card_id UUID REFERENCES public.cards(id) ON DELETE CASCADE,
    quantity INTEGER DEFAULT 1 CHECK (quantity BETWEEN 1 AND 3),
    PRIMARY KEY (deck_id, card_id)
);

-- ============================================
-- TABELLA: extra_deck (mostrissimi)
-- ============================================
CREATE TABLE IF NOT EXISTS public.extra_deck (
    deck_id UUID REFERENCES public.decks(id) ON DELETE CASCADE,
    card_id UUID REFERENCES public.cards(id),
    position INTEGER CHECK (position BETWEEN 1 AND 3),
    PRIMARY KEY (deck_id, position),
    CONSTRAINT valid_mostrissimo CHECK (card_id IS NOT NULL)
);

-- ============================================
-- TABELLA: matches (storico partite)
-- ============================================
CREATE TABLE IF NOT EXISTS public.matches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    player_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    opponent_type TEXT NOT NULL CHECK (opponent_type IN ('ai', 'pvp')),
    opponent_name TEXT,
    player_won BOOLEAN,
    turns_count INTEGER,
    duration_seconds INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    player_faction_id INTEGER REFERENCES public.factions(id),
    opponent_faction_id INTEGER REFERENCES public.factions(id)
);

-- ============================================
-- TABELLA: match_logs (log dettagliato partite in JSON)
-- ============================================
CREATE TABLE IF NOT EXISTS public.match_logs (
    match_id UUID PRIMARY KEY REFERENCES public.matches(id) ON DELETE CASCADE,
    log_data JSONB NOT NULL, -- contiene l'intero log della partita
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- TABELLA: game_state (stato corrente partita attiva)
-- ============================================
CREATE TABLE IF NOT EXISTS public.game_state (
    match_id UUID REFERENCES public.matches(id) ON DELETE CASCADE,
    state_json JSONB NOT NULL,
    current_turn INTEGER,
    current_phase INTEGER CHECK (current_phase BETWEEN 0 AND 3),
    last_updated TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (match_id)
);

-- ============================================
-- TABELLA: ai_profiles (personalità IA)
-- ============================================
CREATE TABLE IF NOT EXISTS public.ai_profiles (
    id SERIAL PRIMARY KEY,
    profile_name TEXT UNIQUE NOT NULL,
    aggression_bias NUMERIC(3,2) DEFAULT 0.5 CHECK (aggression_bias BETWEEN 0 AND 1),
    defense_bias NUMERIC(3,2) DEFAULT 0.5 CHECK (defense_bias BETWEEN 0 AND 1),
    instant_usage_bias NUMERIC(3,2) DEFAULT 0.5 CHECK (instant_usage_bias BETWEEN 0 AND 1),
    sacrifice_willingness NUMERIC(3,2) DEFAULT 0.5 CHECK (sacrifice_willingness BETWEEN 0 AND 1),
    description TEXT
);

-- Inserimento profili IA iniziali
INSERT INTO public.ai_profiles (profile_name, aggression_bias, defense_bias, instant_usage_bias, sacrifice_willingness, description) VALUES
    ('Aggressivo', 0.85, 0.30, 0.50, 0.70, 'Attacca spesso, poca difesa'),
    ('Difensivo', 0.25, 0.85, 0.60, 0.20, 'Costruisce board, usa istantanei difensivi'),
    ('Bilanciato', 0.55, 0.55, 0.55, 0.50, 'Strategia equilibrata'),
    ('Combo', 0.40, 0.40, 0.90, 0.80, 'Cerca combo, usa molti istantanei e sacrifici'),
    ('Controllo', 0.35, 0.70, 0.75, 0.40, 'Controlla il board, risponde a tutto')
ON CONFLICT (profile_name) DO NOTHING;

-- ============================================
-- TABELLA: color_counters (contatori colore per utente)
-- ============================================
CREATE TABLE IF NOT EXISTS public.color_counters (
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    faction_id INTEGER REFERENCES public.factions(id),
    counter INTEGER DEFAULT 0,
    last_activated TIMESTAMPTZ,
    PRIMARY KEY (user_id, faction_id)
);

-- ============================================
-- FUNZIONI & TRIGGER
-- ============================================

-- Funzione per aggiornare last_login
CREATE OR REPLACE FUNCTION public.update_last_login()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE public.users SET last_login = NOW() WHERE id = NEW.id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger per update last_login
DROP TRIGGER IF EXISTS trg_update_last_login ON auth.users;
CREATE TRIGGER trg_update_last_login
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.update_last_login();

-- Funzione per creare profilo utente dopo signup
CREATE OR REPLACE FUNCTION public.create_user_profile()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.users (id, username, email)
    VALUES (NEW.id, NEW.email, NEW.email);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger per creare profilo utente
DROP TRIGGER IF EXISTS trg_create_user_profile ON auth.users;
CREATE TRIGGER trg_create_user_profile
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.create_user_profile();

-- Funzione per aggiornare statistiche utente dopo partita
CREATE OR REPLACE FUNCTION public.update_user_stats()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE public.users 
    SET 
        total_matches = total_matches + 1,
        total_wins = total_wins + (CASE WHEN NEW.player_won THEN 1 ELSE 0 END),
        total_losses = total_losses + (CASE WHEN NOT NEW.player_won THEN 1 ELSE 0 END)
    WHERE id = NEW.player_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger per update statistiche
DROP TRIGGER IF EXISTS trg_update_user_stats ON public.matches;
CREATE TRIGGER trg_update_user_stats
    AFTER INSERT ON public.matches
    FOR EACH ROW
    EXECUTE FUNCTION public.update_user_stats();

-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================

-- Abilita RLS su tutte le tabelle
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.decks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deck_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extra_deck ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.color_counters ENABLE ROW LEVEL SECURITY;

-- Policy per users: ognuno vede solo il proprio profilo
DROP POLICY IF EXISTS "Users can view own profile" ON public.users;
CREATE POLICY "Users can view own profile" ON public.users
    FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update own profile" ON public.users;
CREATE POLICY "Users can update own profile" ON public.users
    FOR UPDATE USING (auth.uid() = id);

-- Policy per decks
DROP POLICY IF EXISTS "Users can view own decks" ON public.decks;
CREATE POLICY "Users can view own decks" ON public.decks
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create own decks" ON public.decks;
CREATE POLICY "Users can create own decks" ON public.decks
    FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own decks" ON public.decks;
CREATE POLICY "Users can update own decks" ON public.decks
    FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own decks" ON public.decks;
CREATE POLICY "Users can delete own decks" ON public.decks
    FOR DELETE USING (auth.uid() = user_id);

-- Policy per deck_cards
DROP POLICY IF EXISTS "Users can view own deck cards" ON public.deck_cards;
CREATE POLICY "Users can view own deck cards" ON public.deck_cards
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.decks WHERE id = deck_cards.deck_id AND user_id = auth.uid())
    );

DROP POLICY IF EXISTS "Users can modify own deck cards" ON public.deck_cards;
CREATE POLICY "Users can modify own deck cards" ON public.deck_cards
    FOR ALL USING (
        EXISTS (SELECT 1 FROM public.decks WHERE id = deck_cards.deck_id AND user_id = auth.uid())
    );

-- Policy per extra_deck
DROP POLICY IF EXISTS "Users can view own extra deck" ON public.extra_deck;
CREATE POLICY "Users can view own extra deck" ON public.extra_deck
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.decks WHERE id = extra_deck.deck_id AND user_id = auth.uid())
    );

DROP POLICY IF EXISTS "Users can modify own extra deck" ON public.extra_deck;
CREATE POLICY "Users can modify own extra deck" ON public.extra_deck
    FOR ALL USING (
        EXISTS (SELECT 1 FROM public.decks WHERE id = extra_deck.deck_id AND user_id = auth.uid())
    );

-- Policy per matches
DROP POLICY IF EXISTS "Users can view own matches" ON public.matches;
CREATE POLICY "Users can view own matches" ON public.matches
    FOR SELECT USING (auth.uid() = player_id);

DROP POLICY IF EXISTS "Users can create own matches" ON public.matches;
CREATE POLICY "Users can create own matches" ON public.matches
    FOR INSERT WITH CHECK (auth.uid() = player_id);

-- Policy per match_logs
DROP POLICY IF EXISTS "Users can view own match logs" ON public.match_logs;
CREATE POLICY "Users can view own match logs" ON public.match_logs
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.matches WHERE id = match_logs.match_id AND player_id = auth.uid())
    );

DROP POLICY IF EXISTS "Users can create own match logs" ON public.match_logs;
CREATE POLICY "Users can create own match logs" ON public.match_logs
    FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM public.matches WHERE id = match_logs.match_id AND player_id = auth.uid())
    );

-- Policy per game_state
DROP POLICY IF EXISTS "Users can view own game state" ON public.game_state;
CREATE POLICY "Users can view own game state" ON public.game_state
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.matches WHERE id = game_state.match_id AND player_id = auth.uid())
    );

DROP POLICY IF EXISTS "Users can update own game state" ON public.game_state;
CREATE POLICY "Users can update own game state" ON public.game_state
    FOR UPDATE USING (
        EXISTS (SELECT 1 FROM public.matches WHERE id = game_state.match_id AND player_id = auth.uid())
    );

-- Policy per color_counters
DROP POLICY IF EXISTS "Users can view own color counters" ON public.color_counters;
CREATE POLICY "Users can view own color counters" ON public.color_counters
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own color counters" ON public.color_counters;
CREATE POLICY "Users can update own color counters" ON public.color_counters
    FOR ALL USING (auth.uid() = user_id);

-- ============================================
-- VISTE UTILI
-- ============================================

-- Vista per vedere i mazzi con dettagli
CREATE OR REPLACE VIEW public.deck_summary AS
SELECT 
    d.id,
    d.name,
    d.user_id,
    u.username,
    f1.name AS primary_faction,
    f2.name AS secondary_faction,
    f3.name AS tertiary_faction,
    c.name AS boss_card,
    d.mana_curve_avg,
    d.is_valid,
    d.created_at
FROM public.decks d
LEFT JOIN public.users u ON d.user_id = u.id
LEFT JOIN public.factions f1 ON d.primary_faction_id = f1.id
LEFT JOIN public.factions f2 ON d.secondary_faction_id = f2.id
LEFT JOIN public.factions f3 ON d.tertiary_faction_id = f3.id
LEFT JOIN public.cards c ON d.boss_card_id = c.id;

-- Vista per statistiche utente
CREATE OR REPLACE VIEW public.user_stats AS
SELECT 
    u.id,
    u.username,
    u.email,
    u.total_matches,
    u.total_wins,
    u.total_losses,
    CASE 
        WHEN u.total_matches > 0 
        THEN ROUND((u.total_wins::NUMERIC / u.total_matches::NUMERIC) * 100, 2)
        ELSE 0 
    END AS win_rate,
    u.created_at,
    u.last_login
FROM public.users u;

-- ============================================
-- COMMENTI SULLE TABELLE
-- ============================================

COMMENT ON TABLE public.cards IS 'Catalogo di tutte le carte giocabili: Mostri, Mostrissimi, Stregonerie, Istantanei, Field Spell, Aure';
COMMENT ON TABLE public.decks IS 'Mazzi degli utenti con 10 carte (1 Boss + 9 casuali) + 3 colori';
COMMENT ON TABLE public.deck_cards IS 'Relazione molte-a-molti tra mazzi e carte con quantità';
COMMENT ON TABLE public.extra_deck IS 'I 3 Mostrissimi associati a ogni mazzo';
COMMENT ON TABLE public.matches IS 'Storico di tutte le partite (PvE contro IA o PvP)';
COMMENT ON TABLE public.match_logs IS 'Log completo della partita in formato JSON per replay e analisi';
COMMENT ON TABLE public.game_state IS 'Stato corrente di una partita attiva (aggiornato in tempo reale)';
COMMENT ON TABLE public.ai_profiles IS 'Personalità dell''IA con bias comportamentali per rigiocabilità';
COMMENT ON TABLE public.color_counters IS 'Contatori per fazione che sbloccano abilità attivabili';

-- Fine dello schema