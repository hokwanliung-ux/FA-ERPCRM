const authRoot = document.getElementById('auth-root');
const appRoot = document.getElementById('app');
const appScript = () => {
  if (document.getElementById('application-script')) return;
  const script = document.createElement('script');
  script.id = 'application-script';
  script.src = 'app.js';
  document.body.appendChild(script);
};
async function checkSession() {
  const response = await fetch('/api/session', { credentials: 'same-origin' });
  const data = await response.json();
  if (data.user) {
    window.currentUser = data.user;
    authRoot.hidden = true;
    appRoot.hidden = false;
    document.body.classList.toggle('role-viewer', data.user.role === 'Viewer');
    appScript();
  } else if (data.setupRequired) showSetup();
  else showLogin();
}
function showSetup(message = '') {
  authRoot.hidden = false;
  authRoot.innerHTML = `<main class="auth-screen"><div class="auth-panel"><div class="brand auth-brand"><div class="brand-mark">F</div><div><div class="brand-name">FRAGMA ALCHEMY</div><div class="brand-sub">Commerce operations</div></div></div><p class="eyebrow">FIRST-TIME SETUP</p><h1 class="page-title">Create the Owner account</h1><p class="page-subtitle">This account manages workspace users and settings.</p><form id="setup-form" class="auth-form"><div class="field"><label for="owner-name">Owner name</label><input id="owner-name" name="name" value="Fragma Alchemy" autocomplete="name" required /></div><div class="field"><label for="owner-email">Email</label><input id="owner-email" name="email" type="email" value="fragmaalchemy@gmail.com" autocomplete="email" required /></div><div class="field"><label for="owner-password">Password</label><input id="owner-password" name="password" type="password" minlength="10" autocomplete="new-password" required /><div class="field-note">Use at least 10 characters. The server stores a salted hash.</div></div><div class="auth-error" role="alert">${message}</div><button class="btn btn-primary" type="submit">Create Owner account</button></form><div class="auth-foot">This creates the first Owner/Admin in the local database.</div></div></main>`;
  document.getElementById('owner-password').focus();
  document.getElementById('setup-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true; button.textContent = 'Creating account…';
    try {
      const response = await fetch('/api/setup', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      const data = await response.json();
      if (!response.ok) { showSetup(data.error || 'Could not create the Owner account.'); return; }
      window.currentUser = data.user; authRoot.hidden = true; appRoot.hidden = false; appScript();
    } catch { showSetup('The setup service is unavailable. Start the local server and try again.'); }
  });
}
function showLogin(message = '') {
  authRoot.hidden = false;
  appRoot.hidden = true;
  authRoot.innerHTML = `<main class="auth-screen"><div class="auth-panel"><div class="brand auth-brand"><div class="brand-mark">F</div><div><div class="brand-name">FRAGMA ALCHEMY</div><div class="brand-sub">Commerce operations</div></div></div><p class="eyebrow">SECURE WORKSPACE</p><h1 class="page-title">Welcome back</h1><p class="page-subtitle">Sign in to manage your marketplace operations.</p><form id="login-form" class="auth-form"><div class="field"><label for="login-email">Email</label><input id="login-email" name="email" type="email" autocomplete="username" value="fragmaalchemy@gmail.com" required /></div><div class="field"><label for="login-password">Password</label><input id="login-password" name="password" type="password" autocomplete="current-password" required /></div><div class="auth-error" role="alert">${message}</div><button class="btn btn-primary" type="submit">Sign in</button></form><div class="auth-foot">Fragma Alchemy · Private operations workspace</div></div></main>`;
  document.getElementById('login-password').focus();
  document.getElementById('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    const body = Object.fromEntries(new FormData(event.currentTarget));
    button.disabled = true; button.textContent = 'Signing in…';
    try {
      const response = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) { showLogin(data.error || 'Could not sign in.'); return; }
      window.currentUser = data.user;
      authRoot.hidden = true;
      appRoot.hidden = false;
      document.body.classList.toggle('role-viewer', data.user.role === 'Viewer');
      appScript();
    } catch { showLogin('The sign-in service is unavailable. Start the local server and try again.'); }
  });
}
window.signOut = async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  window.currentUser = null;
  const script = document.getElementById('application-script');
  script?.remove();
  appRoot.innerHTML = '';
  document.body.classList.remove('role-viewer');
  showLogin('You have signed out.');
};
checkSession().catch(() => showLogin('The sign-in service is unavailable. Start the local server and try again.'));
