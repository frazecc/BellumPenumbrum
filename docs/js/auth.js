// auth.js - Login per Bellum Penumbrum (versione test con hash finto)

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// Sostituisci con i tuoi valori reali di Supabase
const SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Hash finto usato per tutti gli utenti di prova
const FAKE_PASSWORD_HASH = '$2a$10$fakehash';

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('login-form');
  const errorEl = document.getElementById('login-error');

  if (!form) {
    console.warn('Nessun form#login-form trovato nella pagina.');
    return;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (errorEl) {
      errorEl.textContent = '';
      errorEl.style.display = 'none';
    }

    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');

    const username = (usernameInput?.value || '').trim();
    const password = (passwordInput?.value || '').trim();

    if (!username || !password) {
      if (errorEl) {
        errorEl.textContent = 'Inserisci nome utente e password.';
        errorEl.style.display = 'block';
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
        if (errorEl) {
          errorEl.textContent = 'Nome utente o password errati.';
          errorEl.style.display = 'block';
        }
        return;
      }

      // Confronto "finto" della password (solo per test)
      // Accetta qualsiasi password non vuota se password_hash è quello finto
      const isPasswordOk =
        user.password_hash &&
        user.password_hash.startsWith(FAKE_PASSWORD_HASH) &&
        password.length > 0;

      if (!isPasswordOk) {
        if (errorEl) {
          errorEl.textContent = 'Nome utente o password errati.';
          errorEl.style.display = 'block';
        }
        return;
      }

      // Login OK: salva un token semplice in localStorage
      const sessionToken = `session_${user.id}_${Date.now()}`;
      localStorage.setItem('bp_session', sessionToken);
      localStorage.setItem('bp_username', user.username);

      // Reindirizza alla pagina del gioco (adatta il nome file se necessario)
      window.location.href = 'game.html';
    } catch (err) {
      console.error('Errore durante il login:', err);
      if (errorEl) {
        errorEl.textContent = 'Errore di connessione al server. Riprova più tardi.';
        errorEl.style.display = 'block';
      }
    }
  });
});