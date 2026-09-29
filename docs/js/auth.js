/**
 * Autenticazione e gestione sessione
 */
import { initGameEngine, renderGameState } from './game.js';

const API_BASE_URL = 'https://bellumpenumbrum.onrender.com'; // Modifica se il backend usa un altro indirizzo

document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('login-form');
  const logoutBtn = document.getElementById('logout-button');
  
  // Controlla sessione esistente
  const savedUser = localStorage.getItem('bp_user');
  if (savedUser) {
    try {
      const user = JSON.parse(savedUser);
      showGameScreen(user);
    } catch (e) {
      localStorage.removeItem('bp_user');
    }
  }

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const usernameInput = document.getElementById('login-username');
      const passwordInput = document.getElementById('login-password');
      const authMsg = document.getElementById('auth-message');

      const username = usernameInput ? usernameInput.value.trim() : '';
      const password = passwordInput ? passwordInput.value : '';

      if (!username || !password) {
        if (authMsg) authMsg.textContent = 'Inserisci username e password.';
        return;
      }

      try {
        if (authMsg) authMsg.textContent = 'Connessione in corso...';

        const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (response.ok && data.user) {
          if (data.token) localStorage.setItem('bp_token', data.token);
          localStorage.setItem('bp_user', JSON.stringify(data.user));
          showGameScreen(data.user);
        } else {
          if (authMsg) authMsg.textContent = data.message || 'Credenziali non valide.';
        }
      } catch (err) {
        console.error('Errore di autenticazione:', err);
        if (authMsg) authMsg.textContent = 'Errore di connessione al server.';
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      localStorage.removeItem('bp_user');
      localStorage.removeItem('bp_token');
      document.getElementById('game-screen').classList.add('hidden');
      document.getElementById('auth-screen').classList.remove('hidden');
    });
  }
});

function showGameScreen(user) {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('game-screen').classList.remove('hidden');
  
  const signedInSpan = document.getElementById('signed-in-user');
  if (signedInSpan) signedInSpan.textContent = `@${user.username || user.name}`;

  initGameEngine(user, { apiBaseUrl: API_BASE_URL });
}
