// auth.js - Login/Logout per Bellum Penumbrum (versione test con hash finto)

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// Sostituisci con i tuoi valori reali di Supabase
const SUPABASE_URL = 'https://dgsqxnmrjfvklnjliplh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_ZwwwsHnjEWNbe2CnDKsTSA_8ljXZlOG';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Hash finto usato per tutti gli utenti di prova
const FAKE_PASSWORD_HASH = '$2a$10$fakehash';

// Elementi DOM
const authScreen = document.getElementById('auth-screen');
const gameScreen = document.getElementById('game-screen');
const loginForm = document.getElementById('login-form');
const authMessage = document.getElementById('auth-message');
const signedInUser = document.getElementById('signed-in-user');
const logoutButton = document.getElementById('logout-button');

// Mostra/nascondi schermate
function showAuth() {
  authScreen?.classList.remove('hidden');
  gameScreen?.classList.add('hidden');
}

function showGame(username) {
  authScreen?.classList.add('hidden');
  gameScreen?.classList.remove('hidden');
  if (signedInUser) {
    signedInUser.textContent = `@${username}`;
  }
}

// Controlla se c'è già una sessione attiva
function checkExistingSession() {
  const stored = localStorage.getItem('bp_session');
  const storedUsername = localStorage.getItem('bp_username');
  if (stored && storedUsername) {
    showGame(storedUsername);
  } else {
    showAuth();
  }
}

// Gestione login
loginForm?.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (authMessage) {
    authMessage.textContent = '';
    authMessage.style.display = 'none';
  }

  const usernameInput = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');

  const username = (usernameInput?.value || '').trim();
  const password = (passwordInput?.value || '').trim();

  if (!username || !password) {
    if (authMessage) {
      authMessage.textContent = 'Inserisci nome utente e password.';
      authMessage.style.display = 'block';
    }
    return;
  }

  try {
    // Cerca l'utente in public.users
    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, email, password_hash')
      .eq('username', username)
      .single();

    if (error || !user) {
      if (authMessage) {
        authMessage.textContent = 'Nome utente o password errati.';
        authMessage.style.display = 'block';
      }
      return;
    }

    // Confronto "finto" della password (solo per test)
    const isPasswordOk =
      user.password_hash &&
      user.password_hash.startsWith(FAKE_PASSWORD_HASH) &&
      password.length > 0;

    if (!isPasswordOk) {
      if (authMessage) {
        authMessage.textContent = 'Nome utente o password errati.';
        authMessage.style.display = 'block';
      }
      return;
    }

    // Login OK: salva sessione in localStorage
    const sessionToken = `session_${user.id}_${Date.now()}`;
    localStorage.setItem('bp_session', sessionToken);
    localStorage.setItem('bp_username', user.username);

    showGame(user.username);
  } catch (err) {
    console.error('Errore durante il login:', err);
    if (authMessage) {
      authMessage.textContent = 'Errore di connessione al server. Riprova più tardi.';
      authMessage.style.display = 'block';
    }
  }
});

// Gestione logout
logoutButton?.addEventListener('click', () => {
  localStorage.removeItem('bp_session');
  localStorage.removeItem('bp_username');
  showAuth();
});

// Inizializzazione
checkExistingSession();