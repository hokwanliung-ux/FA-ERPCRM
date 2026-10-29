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
 permissions TEXT NOT NULL DEFAULT '{}',
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
if (!db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'permissions')) db.exec("ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '{}'");
db.exec(`CREATE TABLE IF NOT EXISTS business_state (
 id INTEGER PRIMARY KEY CHECK (id=1), payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, user_name TEXT NOT NULL, role TEXT NOT NULL,
 action TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
const sessions = new Map();
const attempts = new Map();
const sessionMs = 12 * 60 * 60 * 1000;
const ownerRoles = new Set(['Owner/Admin']);
const roles = new Set(['Operations', 'Support', 'Viewer', 'Sub-admin']);
const managedPages = ['Dashboard','Orders','Fulfillment','Products','New Import','Inventory','Customers','Sales pipeline','Support & returns','Reports','Connections','Settings','System version'];
const subAdminDataPages = {products:['Products','Inventory','New Import','Orders','Fulfillment'],imports:['New Import'],orders:['Orders','Fulfillment'],cases:['Support & returns'],customers:['Customers','Support & returns'],leads:['Sales pipeline'],movements:['Inventory','New Import','Orders','Fulfillment'],activity:['Products','New Import','Orders','Customers','Sales pipeline','Support & returns'],settings:['Settings'],lastSync:['Connections'],syncHistory:['Connections']};
function normalizePermissions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const page of managedPages) {
    const actions = value[page];
    if (!Array.isArray(actions)) continue;
    const allowed = [...new Set(actions.filter(action => ['read','create','update','delete'].includes(action)))];
    if (allowed.some(action => action !== 'read') && !allowed.includes('read')) allowed.unshift('read');
    if (allowed.length) result[page] = allowed;
  }
  return result;
}
function can(user, page, action='read') { return user.role === 'Owner/Admin' || user.role !== 'Sub-admin' || normalizePermissions(user.permissions)[page]?.includes(action); }
function arrayActions(before, after) {
  const oldMap = new Map((before || []).map(item => [item?.id, item]));
  const newMap = new Map((after || []).map(item => [item?.id, item]));
  const actions = new Set();
  if ([...newMap.keys()].some(id => !oldMap.has(id))) actions.add('create');
  if ([...oldMap.keys()].some(id => !newMap.has(id))) actions.add('delete');
  if ([...newMap.keys()].some(id => oldMap.has(id) && JSON.stringify(newMap.get(id)) !== JSON.stringify(oldMap.get(id)))) actions.add('update');
  return actions.size ? [...actions] : ['read'];
}
function canChangeSubAdminState(user, previous, changes) {
  const touched = Object.keys(changes || {});
  const pageFor = {imports:'New Import',orders:'Orders',cases:'Support & returns',customers:'Customers',leads:'Sales pipeline',settings:'Settings',syncHistory:'Connections',lastSync:'Connections'};
  for (const key of touched) {
    const next = changes[key], old = previous[key];
    if (key === 'activity') return false;
    if (key === 'products') {
      for (const item of next || []) {
        const prior = (old || []).find(record => record.id === item.id);
        if (!prior) { if (!can(user,'Products','create')) return false; continue; }
        const changed = Object.keys(item).filter(field => JSON.stringify(item[field]) !== JSON.stringify(prior[field]));
        if (!changed.length) continue;
        const stockFields=changed.filter(field=>['stock','cost'].includes(field)),catalogFields=changed.filter(field=>!['stock','cost'].includes(field));
        if(catalogFields.length&&!can(user,'Products','update'))return false;
        if(stockFields.length&&!can(user,'Inventory','update')&&!(can(user,'New Import','create')||can(user,'Orders','create')||can(user,'Orders','update')||can(user,'Orders','delete')))return false;
      }
      if ((old || []).some(item => !(next || []).some(record => record.id === item.id)) && !can(user,'Products','delete')) return false;
      continue;
    }
    if (key === 'movements') {
      const sourcePage = touched.includes('imports') ? 'New Import' : touched.includes('orders') ? 'Orders' : 'Inventory';
      const actions = touched.includes('imports') ? ['create'] : touched.includes('orders') ? arrayActions(previous.orders, changes.orders) : ['update'];
      if (!actions.every(action=>can(user,sourcePage,action))) return false;
      continue;
    }
    const page = pageFor[key];
    if (!page) return false;
    const actions = ['settings','lastSync','syncHistory'].includes(key) ? [key==='settings'?'update':'create'] : arrayActions(old,next);
    const permitted = key==='customers' ? actions.every(action=>can(user,'Customers',action)||can(user,'Support & returns',action)) : actions.every(action=>can(user,page,action));
    if (!permitted) return false;
  }
  return true;
}
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
function readBody(req, limit = 32768) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > limit) { reject(new Error('Request too large')); req.destroy(); } });
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
  const user=db.prepare('SELECT id,name,email,role,active,permissions FROM users WHERE id=?').get(entry.userId);
  if(user)try{user.permissions=JSON.parse(user.permissions||'{}')}catch{user.permissions={}}
  return { token, user };
}
function originAllowed(req) {
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}`;
}
function publicUser(user) { let permissions=user.permissions||{};if(typeof permissions==='string')try{permissions=JSON.parse(permissions)}catch{permissions={}};return { id: user.id, name: user.name, email: user.email, role: user.role, active: Boolean(user.active), permissions: normalizePermissions(permissions) }; }
function validWorkspaceState(state) {
  const arrays = ['products','orders','cases','customers','leads','movements','activity','syncHistory'];
  if(!state||typeof state!=='object'||Array.isArray(state)||!arrays.every(key=>Array.isArray(state[key]))||(state.imports!==undefined&&!Array.isArray(state.imports))||!state.settings||typeof state.settings!=='object'||Array.isArray(state.settings))return false;
  const unique=(values)=>new Set(values).size===values.length;
  if(!unique(state.products.map(p=>p?.sku))||!unique(state.orders.map(o=>o?.id)))return false;
  if(state.products.some(p=>!p||typeof p.sku!=='string'||!p.sku.trim()||typeof p.name!=='string'||!Number.isInteger(p.stock)||p.stock<0||!Number.isInteger(p.threshold)||p.threshold<0||![p.cost,p.price].every(n=>Number.isFinite(n)&&n>=0)))return false;
  if(state.orders.some(o=>!o||typeof o.id!=='string'||!Array.isArray(o.items)||o.items.some(i=>!Array.isArray(i)||typeof i[0]!=='string'||!Number.isInteger(i[1])||i[1]<1)||![o.total,o.fees].every(n=>Number.isFinite(n)&&n>=0)))return false;
  if(state.movements.some(m=>!m||typeof m.sku!=='string'||!Number.isInteger(m.qty)))return false;
  const imports=state.imports||[];
  if(!unique(imports.map(batch=>batch?.id))||imports.some(batch=>!batch||typeof batch.id!=='string'||!batch.id.trim()||typeof batch.date!=='string'||!batch.date||typeof batch.supplier!=='string'||!['CNY','USD'].includes(batch.currency)||!Number.isFinite(batch.exchangeRate)||batch.exchangeRate<=0||!Number.isFinite(batch.expenses)||batch.expenses<0||!Number.isFinite(batch.totalCbm)||batch.totalCbm<=0||batch.status!=='Finalized'||!Array.isArray(batch.lines)||!batch.lines.length||!unique(batch.lines.map(line=>line?.sku))||batch.lines.some(line=>!line||!state.products.some(product=>product.sku===line.sku)||!Number.isSafeInteger(line.qty)||line.qty<1||![line.unitPrice,line.directExpenses,line.lengthCm,line.widthCm,line.heightCm,line.cbm,line.purchaseCostIdr,line.allocatedExpenses,line.hpp].every(value=>Number.isFinite(value)&&value>=0)||![line.lengthCm,line.widthCm,line.heightCm,line.cbm].every(value=>value>0))))return false;
  return true;
}
function recordAudit(user, action) {
  db.prepare('INSERT INTO audit_events(user_id,user_name,role,action) VALUES(?,?,?,?)').run(user.id,user.name,user.role,String(action).slice(0,240));
}
function mutateWorkspaceState(user, action, mutate) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row=db.prepare('SELECT payload,revision FROM business_state WHERE id=1').get();
    if(!row)throw new Error('Workspace has not been initialized.');
    const state=JSON.parse(row.payload);
    if(!validWorkspaceState(state))throw new Error('Stored workspace data is invalid.');
    if(!mutate(state)) { db.exec('COMMIT'); return {ok:true,unchanged:true,state,revision:row.revision}; }
    if(!validWorkspaceState(state))throw new Error('Workspace data is incomplete or invalid.');
    const payload=JSON.stringify(state);
    if(Buffer.byteLength(payload)>2_000_000)throw new Error('Workspace data exceeds the 2 MB limit.');
    const result=db.prepare('UPDATE business_state SET payload=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=1 AND revision=?').run(payload,row.revision);
    if(result.changes!==1)throw new Error('Workspace changed while the operation was running. Please try again.');
    recordAudit(user,action);
    const revision=db.prepare('SELECT revision FROM business_state WHERE id=1').get().revision;
    db.exec('COMMIT');
    return {ok:true,state,revision};
  } catch(error) {
    try{db.exec('ROLLBACK')}catch{}
    throw error;
  }
}
async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/state') || url.pathname.startsWith('/api/backup') || url.pathname.startsWith('/api/audit') || url.pathname.startsWith('/api/workspace') || url.pathname.startsWith('/api/orders/clear')) {
    const session=sessionFor(req);
    if(!session?.user?.active)return send(res,401,{error:'Sign in required.'});
    if(req.method==='POST'&&['/api/orders/clear','/api/workspace/clear','/api/workspace/cleanup-demo'].includes(url.pathname)){
      if(!originAllowed(req))return send(res,403,{error:'Request origin rejected.'});
      if(!ownerRoles.has(session.user.role))return send(res,403,{error:'Owner/Admin access required.'});
      const now=new Date().toLocaleString('en-ID',{timeZone:'Asia/Jakarta',dateStyle:'medium',timeStyle:'short'});
      try{
        const result=mutateWorkspaceState(session.user,{
          '/api/orders/clear':'Owner cleared all orders and fulfillment records',
          '/api/workspace/clear':'Owner cleared all workspace business data',
          '/api/workspace/cleanup-demo':'Removed legacy demo orders and unsupported marketplace sample records'
        }[url.pathname],state=>{
          if(url.pathname==='/api/orders/clear'){
            if(!state.orders.length)return false;
            for(const order of state.orders){if(order.stockReserved)for(const [sku,qty] of order.items){const product=state.products.find(item=>item.sku===sku);if(product){product.stock+=qty;state.movements.unshift({id:'MOV-'+crypto.randomBytes(4).toString('hex'),sku,type:`Cleared manual order ${order.id} · stock returned`,qty,location:state.settings.warehouse||'Warehouse',date:now})}}}
            state.orders=[];state.activity.unshift({text:'Owner cleared all order and fulfillment records',time:now});state.activity=state.activity.slice(0,30);return true;
          }
          if(url.pathname==='/api/workspace/clear'){
            state.products=[];state.imports=[];state.orders=[];state.cases=[];state.customers=[];state.leads=[];state.movements=[];state.activity=[];state.syncHistory=[];state.lastSync='Not connected';state.settings={role:'Owner / Admin',warehouse:'Jakarta studio',threshold:10,timezone:'Asia/Jakarta'};return true;
          }
          const oldOrders=state.orders.length,oldCases=state.cases.length,oldActivity=state.activity.length;
          state.orders=state.orders.filter(order=>order.source!=='Demo import'&&!(!order.sourceKey&&/^FA-\d{6}-\d{4}$/.test(String(order.id||''))));
          state.cases=state.cases.filter(item=>!(item.id==='CASE-023'&&item.platform==='Shopee'));
          state.activity=state.activity.filter(item=>!String(item.text||'').includes('FA-260126-1048 imported from Shopee'));
          return oldOrders!==state.orders.length||oldCases!==state.cases.length||oldActivity!==state.activity.length;
        });
        return send(res,200,result);
      }catch(error){return send(res,400,{error:error.message||'Could not update workspace data.'})}
    }
    if(req.method==='GET'&&url.pathname==='/api/state'){
      const row=db.prepare('SELECT payload,updated_at FROM business_state WHERE id=1').get();
      if(!row)return send(res,200,{state:null,updatedAt:null,revision:0});
      const full=JSON.parse(row.payload);
      const readable={
        'Owner/Admin':Object.keys(full),
        Operations:['products','imports','orders','movements','activity','settings','lastSync','syncHistory'],
        Support:['products','orders','cases','customers','activity','settings'],
        Viewer:['products','imports','orders','cases','customers','leads','movements','activity','lastSync','syncHistory'],
        'Sub-admin':Object.keys(subAdminDataPages).filter(key => subAdminDataPages[key].some(page=>can(session.user,page,'read')))
      }[session.user.role]||[];
      return send(res,200,{state:Object.fromEntries(readable.filter(key=>key in full).map(key=>[key,full[key]])),updatedAt:row.updated_at,revision:row.revision});
    }
    if(req.method==='PUT'&&url.pathname==='/api/state'){
      if(!originAllowed(req))return send(res,403,{error:'Request origin rejected.'});
      let body;try{body=await readBody(req,2_000_000)}catch(e){return send(res,400,{error:e.message})}
      const row=db.prepare('SELECT payload,revision FROM business_state WHERE id=1').get();
      const allowed={
        'Owner/Admin':new Set(['products','imports','orders','cases','customers','leads','movements','activity','settings','lastSync','syncHistory']),
        Operations:new Set(['products','imports','orders','movements','activity','settings','lastSync','syncHistory']),
        Support:new Set(['cases','customers','activity']),
        'Sub-admin':new Set(['products','imports','orders','cases','customers','leads','movements','settings','lastSync','syncHistory']),
        Viewer:new Set()
      }[session.user.role]||new Set();
      let payloadState;
      if(!row){if(session.user.role!=='Owner/Admin'||body.initialize!==true||!validWorkspaceState(body.state))return send(res,403,{error:'An Owner/Admin must initialize the workspace first.'});payloadState=body.state;}
      else {
        if(!Number.isInteger(body.revision)||body.revision!==row.revision)return send(res,409,{error:'Workspace data changed in another session. Your view has been refreshed; please reapply your last change.'});
        let previous;try{previous=JSON.parse(row.payload)}catch{return send(res,500,{error:'Stored workspace data is invalid.'})}
        const incomingProducts=body.changes?.products;
        if(Array.isArray(incomingProducts)&&previous.products.some(old=>incomingProducts.some(next=>next?.id===old.id&&next.sku!==old.sku)))return send(res,400,{error:'A product Main SKU is permanent and cannot be changed.'});
        if(Array.isArray(incomingProducts)&&previous.imports?.some(batch=>(batch.lines||[]).some(line=>!incomingProducts.some(product=>product?.sku===line.sku))))return send(res,400,{error:'A product linked to import history cannot be deleted.'});
        const incomingImports=body.changes?.imports;
        if(Array.isArray(incomingImports)&&previous.imports?.some(old=>!incomingImports.some(next=>next?.id===old.id&&JSON.stringify(next)===JSON.stringify(old))))return send(res,400,{error:'Finalized import history cannot be changed or deleted.'});
        if(Array.isArray(incomingProducts)){
          const priorById=new Map(previous.products.map(product=>[product.id,product])),allowedReceipts=new Map(),allowedReturns=new Map();
          for(const batch of incomingImports||previous.imports||[])if(!(previous.imports||[]).some(old=>old.id===batch.id))for(const line of batch.lines||[])allowedReceipts.set(line.sku,(allowedReceipts.get(line.sku)||0)+line.qty);
          const changedOrders=body.changes?.orders;
          if(Array.isArray(changedOrders))for(const order of previous.orders){const updated=changedOrders.find(next=>next?.id===order.id);if(order.stockReserved&&(!updated||!updated.stockReserved))for(const [sku,qty] of order.items)allowedReturns.set(sku,(allowedReturns.get(sku)||0)+qty)}
          for(const product of incomingProducts){const prior=priorById.get(product?.id),priorStock=prior?.stock||0,permitted=(allowedReceipts.get(product?.sku)||0)+(allowedReturns.get(product?.sku)||0);if(product&&product.stock>priorStock+permitted)return send(res,400,{error:'Stock increases must come from a finalized New Import batch.'})}
        }
        if(!body.changes||typeof body.changes!=='object'||Array.isArray(body.changes))return send(res,400,{error:'Workspace changes are invalid.'});
        const changed=Object.keys(body.changes);
        if(session.user.role==='Sub-admin'&&!canChangeSubAdminState(session.user,previous,body.changes))return send(res,403,{error:'Your menu permissions do not allow this change.'});
        if(changed.some(key=>!allowed.has(key)))return send(res,403,{error:`Your role cannot change: ${changed.filter(key=>!allowed.has(key)).join(', ')}.`});
        if(!changed.length)return send(res,200,{ok:true,unchanged:true});
        payloadState={...previous,...body.changes};
      }
      if(!validWorkspaceState(payloadState))return send(res,400,{error:'Workspace data is incomplete or invalid.'});
      const payload=JSON.stringify(payloadState);
      if(Buffer.byteLength(payload)>2_000_000)return send(res,413,{error:'Workspace data exceeds the 2 MB limit.'});
      db.prepare(`INSERT INTO business_state(id,payload,revision,updated_at) VALUES(1,?,1,CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,revision=business_state.revision+1,updated_at=CURRENT_TIMESTAMP`).run(payload);
      recordAudit(session.user,body.initialize?'Workspace initialized':(String(body.action||'Workspace records updated').slice(0,240)));
      return send(res,200,{ok:true,...db.prepare('SELECT updated_at AS updatedAt,revision FROM business_state WHERE id=1').get()});
    }
    if(req.method==='GET'&&url.pathname==='/api/backup'){
      if(!ownerRoles.has(session.user.role))return send(res,403,{error:'Owner/Admin access required.'});
      const row=db.prepare('SELECT payload,updated_at FROM business_state WHERE id=1').get();
      if(!row)return send(res,404,{error:'No workspace data to back up yet.'});
      const backup=JSON.stringify({format:'fragma-workspace-backup',version:1,exportedAt:new Date().toISOString(),state:JSON.parse(row.payload)},null,2);
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="fragma-workspace-backup.json"','Cache-Control':'no-store'});
      return res.end(backup);
    }
    if(req.method==='POST'&&url.pathname==='/api/backup/restore'){
      if(!originAllowed(req))return send(res,403,{error:'Request origin rejected.'});
      if(!ownerRoles.has(session.user.role))return send(res,403,{error:'Owner/Admin access required.'});
      let body;try{body=await readBody(req,2_000_000)}catch(e){return send(res,400,{error:e.message})}
      if(body.format!=='fragma-workspace-backup'||body.version!==1||!validWorkspaceState(body.state))return send(res,400,{error:'This is not a valid Fragma workspace backup.'});
      const payload=JSON.stringify(body.state);
      if(Buffer.byteLength(payload)>2_000_000)return send(res,413,{error:'Backup exceeds the 2 MB limit.'});
      db.prepare(`INSERT INTO business_state(id,payload,revision,updated_at) VALUES(1,?,1,CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,revision=business_state.revision+1,updated_at=CURRENT_TIMESTAMP`).run(payload);
      recordAudit(session.user,'Restored workspace backup');
      return send(res,200,{ok:true,...db.prepare('SELECT revision FROM business_state WHERE id=1').get()});
    }
    if(req.method==='GET'&&url.pathname==='/api/audit'){
      if(!ownerRoles.has(session.user.role))return send(res,403,{error:'Owner/Admin access required.'});
      return send(res,200,{events:db.prepare('SELECT user_name,role,action,created_at FROM audit_events ORDER BY id DESC LIMIT 100').all()});
    }
  }
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
    if (!roles.has(role)) return send(res, 400, { error: 'Select Operations, Support, Viewer, or Sub-admin.' });
    const permissions=role==='Sub-admin'?normalizePermissions(body.permissions):{};
    if(role==='Sub-admin'&&!Object.keys(permissions).length)return send(res,400,{error:'Select at least one menu permission for the sub-admin.'});
    const { salt, hash } = await hashPassword(password);
    try {
      const result = db.prepare('INSERT INTO users(name,email,salt,password_hash,role,permissions) VALUES(?,?,?,?,?,?)').run(name, email, salt, hash, role, JSON.stringify(permissions));
      return send(res, 201, { user: publicUser(db.prepare('SELECT id,name,email,role,active,permissions FROM users WHERE id=?').get(Number(result.lastInsertRowid))) });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return send(res, 409, { error: 'A user with that email already exists.' });
      throw error;
    }
  }
  const userRoute = url.pathname.match(/^\/api\/users\/(\d+)$/);
  if (userRoute && ['PUT','DELETE'].includes(req.method)) {
    if (!originAllowed(req)) return send(res,403,{error:'Request origin rejected.'});
    const session=sessionFor(req);
    if(!session?.user?.active)return send(res,401,{error:'Sign in required.'});
    if(!ownerRoles.has(session.user.role))return send(res,403,{error:'Owner/Admin access required.'});
    const targetId=Number(userRoute[1]);
    const target=db.prepare('SELECT id,name,email,role,active,permissions FROM users WHERE id=?').get(targetId);
    if(target)try{target.permissions=JSON.parse(target.permissions||'{}')}catch{target.permissions={}}
    if(!target)return send(res,404,{error:'User not found.'});
    if(req.method==='DELETE'){
      if(targetId===session.user.id)return send(res,400,{error:'You cannot delete the account you are signed in with.'});
      db.prepare('DELETE FROM users WHERE id=?').run(targetId);
      for(const [token,entry] of sessions)if(entry.userId===targetId)sessions.delete(token);
      return send(res,200,{ok:true});
    }
    let body;
    try{body=await readBody(req)}catch(e){return send(res,400,{error:e.message})}
    const name=body.name===undefined?target.name:String(body.name).trim();
    const email=body.email===undefined?target.email:String(body.email).trim().toLowerCase();
    const role=body.role===undefined?target.role:String(body.role);
    const permissions=role==='Sub-admin'?normalizePermissions(body.permissions===undefined?target.permissions:body.permissions):{};
    const password=String(body.password||'');
    if(name.length<2||name.length>100||!(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))||email.length>254)return send(res,400,{error:'Enter a valid name and email address.'});
    if(!roles.has(role)&&!ownerRoles.has(role))return send(res,400,{error:'Select a valid workspace role.'});
    if(role==='Sub-admin'&&!Object.keys(permissions).length)return send(res,400,{error:'Select at least one menu permission for the sub-admin.'});
    if(targetId===session.user.id&&role!=='Owner/Admin')return send(res,400,{error:'You cannot remove your own Owner/Admin role.'});
    if(password&&(password.length<10||password.length>200))return send(res,400,{error:'Passwords must be at least 10 characters.'});
    let result;
    try{
      if(password){const {salt,hash}=await hashPassword(password);result=db.prepare('UPDATE users SET name=?,email=?,role=?,permissions=?,salt=?,password_hash=? WHERE id=?').run(name,email,role,JSON.stringify(permissions),salt,hash,targetId)}
      else result=db.prepare('UPDATE users SET name=?,email=?,role=?,permissions=? WHERE id=?').run(name,email,role,JSON.stringify(permissions),targetId);
    }catch(error){if(String(error.message).includes('UNIQUE'))return send(res,409,{error:'A user with that email already exists.'});throw error}
    const updated=db.prepare('SELECT id,name,email,role,active,permissions FROM users WHERE id=?').get(targetId);
    return send(res,200,{user:publicUser(updated)});
  }
  if (req.method === 'GET' && url.pathname === '/api/users') {
    const session = sessionFor(req);
    if (!session?.user?.active) return send(res, 401, { error: 'Sign in required.' });
    if (!ownerRoles.has(session.user.role)) return send(res, 403, { error: 'Owner/Admin access required.' });
    const users = db.prepare('SELECT id,name,email,role,active,permissions,created_at FROM users ORDER BY id').all().map(publicUser);
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
