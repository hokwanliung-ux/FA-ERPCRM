const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(crypto.scrypt);
const root = __dirname;
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'fragma.sqlite'));
db.exec(`CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 salt TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
const sessions = new Map();
const attempts = new Map();
const sessionMs = 12 * 60 * 60 * 1000;
const ownerRoles = new Set(['Owner/Admin']);
const roles = new Set(['Operations', 'Support', 'Viewer']);
const publicFiles = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/styles.css', 'styles.css'], ['/app.js', 'app.js'], ['/auth.js', 'auth.js']]);

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = await scrypt(password, salt, 64);
  return { salt, hash: hash.toString('hex') };
}
async function provisionOwner() {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n) return;
  const bootstrapPath = path.join(root, '.owner-bootstrap.json');
  if (!fs.existsSync(bootstrapPath)) return;
  const owner = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8'));
  if (!owner.email || !owner.password || owner.password.length < 10) throw new Error('Invalid initial Owner bootstrap.');
  const { salt, hash } = await hashPassword(owner.password);
  db.prepare('INSERT INTO users(name,email,salt,password_hash,role) VALUES(?,?,?,?,?)').run(owner.name || 'Fragma Alchemy', owner.email.trim().toLowerCase(), salt, hash, 'Owner/Admin');
  fs.unlinkSync(bootstrapPath);
  console.log('Initial Owner account created. Bootstrap credential file removed; password is stored as a salted hash.');
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 32768) { reject(new Error('Request too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
function cookieValue(header, key) {
  const item = (header || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${key}=`));
  return item ? decodeURIComponent(item.slice(key.length + 1)) : '';
}
function sessionFor(req) {
  const token = cookieValue(req.headers.cookie, 'fa_session');
  const entry = sessions.get(token);
  if (!entry) return null;
  if (entry.expires < Date.now()) { sessions.delete(token); return null; }
  return { token, user: db.prepare('SELECT id,name,email,role,active FROM users WHERE id=?').get(entry.userId) };
}
function originAllowed(req) {
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}`;
}
function publicUser(user) { return { id: user.id, name: user.name, email: user.email, role: user.role, active: Boolean(user.active) }; }
async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/session') {
    const session = sessionFor(req);
    return send(res, 200, { user: session?.user?.active ? publicUser(session.user) : null, setupRequired: db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0 });
  }
  if (req.method === 'POST' && ['/api/setup', '/api/login', '/api/logout', '/api/users'].includes(url.pathname)) {
    if (!originAllowed(req)) return send(res, 403, { error: 'Request origin rejected.' });
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    if (url.pathname === '/api/setup') {
      if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n !== 0) return send(res, 409, { error: 'Owner setup has already been completed.' });
      const name=String(body.name||'').trim(), email=String(body.email||'').trim().toLowerCase(), password=String(body.password||'');
      if(name.length<2||name.length>100||!(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))||password.length<10||password.length>200) return send(res,400,{error:'Enter a name, valid email, and password of at least 10 characters.'});
      const {salt,hash}=await hashPassword(password);
      const result=db.prepare('INSERT INTO users(name,email,salt,password_hash,role) VALUES(?,?,?,?,?)').run(name,email,salt,hash,'Owner/Admin');
      const token=crypto.randomBytes(32).toString('base64url'); sessions.set(token,{userId:Number(result.lastInsertRowid),expires:Date.now()+sessionMs});
      const user=db.prepare('SELECT id,name,email,role,active FROM users WHERE id=?').get(Number(result.lastInsertRowid));
      return send(res, 201, { user: publicUser(user) }, { 'Set-Cookie': 'fa_session=' + encodeURIComponent(token) + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200' });
    }
    if (url.pathname === '/api/login') {
      const ip = req.socket.remoteAddress || 'local';
      const recent = (attempts.get(ip) || []).filter(t => t > Date.now() - 15 * 60 * 1000);
      if (recent.length >= 10) return send(res, 429, { error: 'Too many sign-in attempts. Try again in 15 minutes.' });
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const user = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
      let valid = false;
      if (user && password) { const { hash } = await hashPassword(password, user.salt); valid = crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.password_hash)); }
      if (!valid) { recent.push(Date.now()); attempts.set(ip, recent); return send(res, 401, { error: 'Email or password is incorrect.' }); }
      attempts.delete(ip);
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, { userId: user.id, expires: Date.now() + sessionMs });
      return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': `fa_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` });
    }
    if (url.pathname === '/api/logout') {
      const session = sessionFor(req);
      if (session) sessions.delete(session.token);
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'fa_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    const session = sessionFor(req);
    if (!session?.user?.active) return send(res, 401, { error: 'Sign in required.' });
    if (!ownerRoles.has(session.user.role)) return send(res, 403, { error: 'Owner/Admin access required.' });
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const role = String(body.role || '');
    if (name.length < 2 || name.length > 100) return send(res, 400, { error: 'Enter a name between 2 and 100 characters.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return send(res, 400, { error: 'Enter a valid email address.' });
    if (password.length < 10 || password.length > 200) return send(res, 400, { error: 'New user passwords must be at least 10 characters.' });
    if (!roles.has(role)) return send(res, 400, { error: 'Select Operations, Support, or Viewer.' });
    const { salt, hash } = await hashPassword(password);
    try {
      const result = db.prepare('INSERT INTO users(name,email,salt,password_hash,role) VALUES(?,?,?,?,?)').run(name, email, salt, hash, role);
      return send(res, 201, { user: publicUser(db.prepare('SELECT id,name,email,role,active FROM users WHERE id=?').get(Number(result.lastInsertRowid))) });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return send(res, 409, { error: 'A user with that email already exists.' });
      throw error;
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/users') {
    const session = sessionFor(req);
    if (!session?.user?.active) return send(res, 401, { error: 'Sign in required.' });
    if (!ownerRoles.has(session.user.role)) return send(res, 403, { error: 'Owner/Admin access required.' });
    const users = db.prepare('SELECT id,name,email,role,active,created_at FROM users ORDER BY id').all().map(publicUser);
    return send(res, 200, { users });
  }
  const fileName = publicFiles.get(url.pathname);
  if (req.method === 'GET' && fileName) {
    const ext = path.extname(fileName);
    res.writeHead(200, { 'Content-Type': ext === '.css' ? 'text/css; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(root, fileName)).pipe(res);
  }
  return send(res, 404, { error: 'Not found.' });
}

provisionOwner().then(() => {
  const port = Number(process.env.PORT) || 4173;
  http.createServer((req, res) => { handler(req, res).catch(error => { console.error(error); if (!res.headersSent) send(res, 500, { error: 'Unexpected server error.' }); else res.destroy(); }); }).listen(port, '127.0.0.1', () => console.log(`Fragma Alchemy: http://localhost:${port}`));
}).catch(error => { console.error('Owner provisioning failed:', error.message); process.exitCode = 1; });
