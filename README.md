# Bellum Penumbrum

Gioco di carte tattico 1vs1 (giocatore vs IA) su griglia 3x3.

## Struttura

- `backend/` – API Node/Express + motore di gioco + Supabase.
- `frontend/` – Sito statico pubblicabile su GitHub Pages.

## Backend

```bash
cd backend
cp .env.example .env
# modifica .env inserendo SUPABASE_SERVICE_KEY
npm install
npm run dev
```

Deploy su Render/Railway/Fly:

- Imposta le env `SUPABASE_URL` e `SUPABASE_SERVICE_KEY`.
- Comando di start: `npm start`.

## Frontend

Pubblica il contenuto di `frontend/` su GitHub Pages.

Modifica `frontend/js/game.js` e imposta:

```js
const API_BASE = '[https://tuodominioapi.com](https://tuodominioapi.com)';
```

## Supabase

URL: `https://dgsqxnmrjfvklnjliplh.supabase.co`  
Publishable key: `sb_publishable_ZwwwsHnjEWNbe2CnDKsTSA_8ljXZlOG`

Assicurati di avere le tabelle: `users`, `matches`, `game_state`, `match_logs`, `cards`, `factions`, `card_subtypes`, `card_subtype_links`, ecc.
