import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export const SUPABASE_URL = 'https://dgsqxnmrjfvklnjliplh.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_ZwwwsHnjEWNbe2CnDKsTSA_8ljXZlOG';
export const LOCAL_EMAIL_DOMAIN = '@test.local';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

function setMessage(message = '', kind = '') {
  const element = document.getElementById('auth-message');
  if (!element) return;
  element.textContent = message;
  element.className = `form-message ${kind}`.trim();
}

export function usernameToLocalEmail(username) {
  const normalized = String(username)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '');

  if (normalized.length < 2) {
    throw new Error('Il nome utente deve contenere almeno 2 caratteri validi.');
  }

  return `${normalized}${LOCAL_EMAIL_DOMAIN}`;
}

export function usernameFromEmail(email = '') {
  return String(email).toLowerCase().endsWith(LOCAL_EMAIL_DOMAIN)
    ? String(email).slice(0, -LOCAL_EMAIL_DOMAIN.length)
    : String(email);
}

export async function getAccessToken() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session?.access_token ?? null;
}

export async function getCurrentUser() {
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user ?? null;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

async function signInWithLocalUsername(username, password) {
  const email = usernameToLocalEmail(username);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (!data.session || !data.user) throw new Error('Accesso non completato.');
  return data;
}

function showGame() {
  document.getElementById('auth-screen')?.classList.add('hidden');
  document.getElementById('game-screen')?.classList.remove('hidden');
}

function showAuth() {
  document.getElementById('game-screen')?.classList.add('hidden');
  document.getElementById('auth-screen')?.classList.remove('hidden');
}

async function handleLogin(event) {
  event.preventDefault();

  const usernameInput = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');
  const button = document.getElementById('login-button');

  const username = usernameInput?.value ?? '';
  const password = passwordInput?.value ?? '';

  try {
    button.disabled = true;
    setMessage('Accesso in corso…');
    await signInWithLocalUsername(username, password);
    setMessage('');
    showGame();
    window.dispatchEvent(new CustomEvent('bellum:auth-ready'));
  } catch (error) {
    setMessage(error instanceof Error ? error.message : 'Impossibile effettuare l’accesso.', 'error');
  } finally {
    button.disabled = false;
  }
}

async function bootstrapAuth() {
  document.getElementById('login-form')?.addEventListener('submit', handleLogin);

  const user = await getCurrentUser();
  if (user) {
    showGame();
    window.dispatchEvent(new CustomEvent('bellum:auth-ready'));
  } else {
    showAuth();
  }

  supabase.auth.onAuthStateChange((_event, session) => {
    if (session?.user) {
      showGame();
      window.dispatchEvent(new CustomEvent('bellum:auth-ready'));
    } else {
      showAuth();
    }
  });
}

bootstrapAuth();
