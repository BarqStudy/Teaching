/* منصة الخصوصيين — الخادم (Backend)
 * بدون أي مكتبات خارجية: Node.js 22.13+ فقط (http + sqlite المدمجة).
 * - قاعدة بيانات SQLite داخل ملف واحد
 * - التحقق من هوية المستخدم عبر توقيع تليجرام (initData) فلا يمكن تزويرها
 * - الأدمن = آيديات تليجرام المحددة في الإعدادات
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch { console.error('❌ هذا الإصدار من Node لا يدعم sqlite. استخدم Node 22.13 أو أحدث.'); process.exit(1); }

const __dir = path.dirname(fileURLToPath(import.meta.url));

/* ---------- الإعدادات (.env أو متغيرات البيئة) ---------- */
try {
  for (const line of fs.readFileSync(path.join(__dir, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
const env = process.env;
const BOT_TOKEN = env.BOT_TOKEN || '';
const ADMIN_IDS = new Set([env.OWNER_ID, ...(env.ADMIN_IDS || '').split(',')].map(x => (x || '').trim()).filter(Boolean));
const PORT = +env.PORT || 3000;
const DB_PATH = env.DB_PATH || path.join(__dir, 'data', 'barq.db');
const TRUST_PROXY = env.TRUST_PROXY === '1';
const MAX_AGE = +env.INITDATA_MAX_AGE || 60 * 60 * 24 * 2; // صلاحية توقيع تليجرام (ثانية)
if (!BOT_TOKEN || !ADMIN_IDS.size) {
  console.error('❌ لازم تحدد BOT_TOKEN و OWNER_ID في ملف .env');
  process.exit(1);
}

/* ---------- قاعدة البيانات ---------- */
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS tutors(
  id TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now')),
  name TEXT, nationality TEXT, age INTEGER, gender TEXT, whatsapp TEXT, telegram TEXT, bio TEXT DEFAULT '',
  subjects TEXT DEFAULT '[]', rating REAL DEFAULT 0, pledge INTEGER DEFAULT 0, verified INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS requests(
  id TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now')), tg_id TEXT,
  name TEXT, nationality TEXT, age INTEGER, gender TEXT, whatsapp TEXT, telegram TEXT,
  subjects TEXT DEFAULT '[]', pledge INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS ratings(
  id TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now')),
  tutor_id TEXT REFERENCES tutors(id) ON DELETE CASCADE, tg_id TEXT, who TEXT,
  score INTEGER, explain INTEGER, style INTEGER, coop INTEGER, comment TEXT DEFAULT '',
  UNIQUE(tutor_id, tg_id));
CREATE TABLE IF NOT EXISTS rating_edits(
  id TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now')),
  tutor_id TEXT REFERENCES tutors(id) ON DELETE CASCADE, tg_id TEXT, who TEXT, reason TEXT DEFAULT '',
  UNIQUE(tutor_id, tg_id));
CREATE TABLE IF NOT EXISTS terms(id TEXT PRIMARY KEY, text TEXT, sort INTEGER);
`);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const get = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const uuid = () => crypto.randomUUID();

/* ---------- أدوات عامة ---------- */
class HttpError extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code; } }
const bad = (msg) => new HttpError(400, msg);
const json = (res, status, data) => { const b = JSON.stringify(data); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(b); };
const parseSubjects = r => ({ ...r, subjects: (() => { try { return JSON.parse(r.subjects || '[]'); } catch { return []; } })() });
const pubTutor = r => { const t = parseSubjects(r); t.verified = !!t.verified; t.pledge = !!t.pledge; return t; };

/* ---------- التحقق من تليجرام ---------- */
function verifyInit(raw) {
  if (!raw || raw.length > 4096) return null;
  const p = new URLSearchParams(raw), hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest();
  let given; try { given = Buffer.from(hash, 'hex'); } catch { return null; }
  if (given.length !== calc.length || !crypto.timingSafeEqual(given, calc)) return null;
  if (Math.floor(Date.now() / 1000) - (+p.get('auth_date') || 0) > MAX_AGE) return null;
  try {
    const u = JSON.parse(p.get('user'));
    const id = String(u.id);
    return { id, name: [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || 'طالب', isAdmin: ADMIN_IDS.has(id) };
  } catch { return null; }
}
const needUser = ctx => { if (!ctx.user) throw new HttpError(401, 'افتح المنصة من داخل تليجرام أولاً', 'auth'); return ctx.user; };
const needAdmin = ctx => { const u = needUser(ctx); if (!u.isAdmin) throw new HttpError(403, 'غير مصرّح'); return u; };

/* ---------- إشعارات تليجرام (اختياري، لا توقف الخادم لو فشلت) ---------- */
function notify(chatId, text) {
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  }).catch(() => {});
}

/* ---------- التحقق من البيانات ---------- */
const str = (v, max) => String(v ?? '').trim().slice(0, max);
function parseTg(v) {
  v = String(v || '').trim().replace(/^https?:\/\//i, '').replace(/^(www\.)?(t|telegram)\.me\//i, '').replace(/^@/, '').split(/[\/?#]/)[0];
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(v) ? v : null;
}
function cleanTutor(b) {
  const name = str(b.name, 80).replace(/\s+/g, ' ');
  if (name.split(' ').length < 2) throw bad('اكتب الاسم الثنائي أو الثلاثي');
  const nationality = str(b.nationality, 40); if (!nationality) throw bad('اكتب الجنسية');
  const age = +b.age; if (!Number.isInteger(age) || age < 15 || age > 80) throw bad('العمر غير صحيح');
  if (!['ذكر', 'أنثى'].includes(b.gender)) throw bad('اختر ذكر أو أنثى');
  const ph = String(b.whatsapp || '').replace(/[\s\-+]/g, '').replace(/^966/, '');
  if (!/^0?5\d{8}$/.test(ph)) throw bad('رقم الجوال لازم يكون سعودي');
  const whatsapp = '966' + ph.replace(/^0/, '');
  const u = parseTg(b.telegram); if (!u) throw bad('يوزر التليجرام غير صحيح');
  if (!Array.isArray(b.subjects) || !b.subjects.length || b.subjects.length > 20) throw bad('أضف مادة واحدة على الأقل');
  const subjects = b.subjects.map(s => {
    const n = str(s.name, 80), targets = str(s.targets, 200), price = String(s.price ?? '').trim();
    if (!n) throw bad('اسم المادة مطلوب');
    if (!targets) throw bad('اكتب الطلاب المستهدفين لمادة: ' + n);
    if (!/^\d{1,6}$/.test(price) || +price <= 0) throw bad('سعر غير صحيح لمادة: ' + n);
    let trial = str(s.trial, 300);
    if (trial && !/^https?:\/\/[^\s.]+\.[^\s]+$/i.test(trial)) throw bad('رابط الشرح التجريبي غير صحيح لمادة: ' + n);
    return { name: n, targets, price, trial };
  });
  return { name, nationality, age, gender: b.gender, whatsapp, telegram: 'https://t.me/' + u, subjects: JSON.stringify(subjects) };
}

/* ---------- المسارات ---------- */
const routes = [];
const route = (method, pattern, handler) => routes.push([method, new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler]);

// البيانات العامة + هوية المستخدم
route('GET', '/api/bootstrap', ctx => {
  const u = ctx.user;
  return {
    me: { authed: !!u, id: u?.id || null, name: u?.name || null, isAdmin: !!u?.isAdmin },
    tutors: all('SELECT * FROM tutors ORDER BY created_at').map(pubTutor),
    ratings: all('SELECT tutor_id,tg_id,who,score,explain,style,coop,comment,created_at FROM ratings ORDER BY created_at')
      .map(({ tg_id, ...r }) => ({ ...r, mine: !!u && tg_id === u.id })),
    terms: all('SELECT * FROM terms ORDER BY sort')
  };
});

// طلب تسجيل خصوصي
route('POST', '/api/requests', ctx => {
  const u = needUser(ctx), t = cleanTutor(ctx.body);
  if (get('SELECT COUNT(*) c FROM requests WHERE tg_id=?', u.id).c >= 3) throw bad('لديك طلبات قيد المراجعة، انتظر رد الإدارة');
  run(`INSERT INTO requests(id,tg_id,name,nationality,age,gender,whatsapp,telegram,subjects,pledge) VALUES(?,?,?,?,?,?,?,?,?,1)`,
    uuid(), u.id, t.name, t.nationality, t.age, t.gender, t.whatsapp, t.telegram, t.subjects);
  for (const a of ADMIN_IDS) notify(a, `📥 طلب تسجيل خصوصي جديد\n${t.name}\nافتح لوحة الإدارة للمراجعة`);
  return { ok: true };
});

// تقييم
route('POST', '/api/ratings', ctx => {
  const u = needUser(ctx), b = ctx.body;
  if (!get('SELECT 1 x FROM tutors WHERE id=?', String(b.tutor_id))) throw new HttpError(404, 'الخصوصي غير موجود');
  const v = {};
  for (const k of ['explain', 'style', 'coop']) { v[k] = +b[k]; if (!Number.isInteger(v[k]) || v[k] < 1 || v[k] > 100) throw bad('قيمة التقييم غير صحيحة'); }
  const score = Math.round((v.explain + v.style + v.coop) / 3);
  try {
    run('INSERT INTO ratings(id,tutor_id,tg_id,who,score,explain,style,coop,comment) VALUES(?,?,?,?,?,?,?,?,?)',
      uuid(), b.tutor_id, u.id, u.name, score, v.explain, v.style, v.coop, str(b.comment, 500));
  } catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'سبق أن قيّمت هذا الخصوصي', 'exists'); throw e; }
  return { ok: true };
});

// طلب تعديل تقييم
route('POST', '/api/rating-edits', ctx => {
  const u = needUser(ctx), b = ctx.body;
  if (!get('SELECT 1 x FROM ratings WHERE tutor_id=? AND tg_id=?', String(b.tutor_id), u.id)) throw bad('لا يوجد تقييم سابق لتعديله');
  try { run('INSERT INTO rating_edits(id,tutor_id,tg_id,who,reason) VALUES(?,?,?,?,?)', uuid(), b.tutor_id, u.id, u.name, str(b.reason, 300)); }
  catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'لديك طلب تعديل قيد المراجعة', 'pending'); throw e; }
  for (const a of ADMIN_IDS) notify(a, `✏️ طلب تعديل تقييم من ${u.name}`);
  return { ok: true };
});

/* ---------- الإدارة ---------- */
route('GET', '/api/admin/data', ctx => {
  needAdmin(ctx);
  return {
    requests: all('SELECT * FROM requests ORDER BY created_at').map(parseSubjects),
    edits: all(`SELECT e.id,e.tutor_id,e.who,e.reason,e.created_at,r.score,r.explain,r.style,r.coop
                FROM rating_edits e LEFT JOIN ratings r ON r.tutor_id=e.tutor_id AND r.tg_id=e.tg_id ORDER BY e.created_at`)
  };
});
route('POST', '/api/admin/tutors', ctx => {
  needAdmin(ctx); const t = cleanTutor(ctx.body), rating = Math.max(0, Math.min(100, +ctx.body.rating || 0));
  run('INSERT INTO tutors(id,name,nationality,age,gender,whatsapp,telegram,subjects,rating,pledge) VALUES(?,?,?,?,?,?,?,?,?,1)',
    uuid(), t.name, t.nationality, t.age, t.gender, t.whatsapp, t.telegram, t.subjects, rating);
  return { ok: true };
});
route('PUT', '/api/admin/tutors/:id', ctx => {
  needAdmin(ctx); const t = cleanTutor(ctx.body), rating = Math.max(0, Math.min(100, +ctx.body.rating || 0));
  run('UPDATE tutors SET name=?,nationality=?,age=?,gender=?,whatsapp=?,telegram=?,subjects=?,rating=? WHERE id=?',
    t.name, t.nationality, t.age, t.gender, t.whatsapp, t.telegram, t.subjects, rating, ctx.params.id);
  return { ok: true };
});
route('POST', '/api/admin/tutors/:id/verify', ctx => { needAdmin(ctx); run('UPDATE tutors SET verified=? WHERE id=?', ctx.body.verified ? 1 : 0, ctx.params.id); return { ok: true }; });
route('DELETE', '/api/admin/tutors/:id', ctx => { needAdmin(ctx); run('DELETE FROM tutors WHERE id=?', ctx.params.id); return { ok: true }; });

route('POST', '/api/admin/requests/:id/approve', ctx => {
  needAdmin(ctx);
  const r = get('SELECT * FROM requests WHERE id=?', ctx.params.id); if (!r) throw new HttpError(404, 'الطلب غير موجود');
  tx(() => {
    run('INSERT INTO tutors(id,name,nationality,age,gender,whatsapp,telegram,subjects,rating,pledge,verified) VALUES(?,?,?,?,?,?,?,?,0,?,0)',
      uuid(), r.name, r.nationality, r.age, r.gender, r.whatsapp, r.telegram, r.subjects, r.pledge);
    run('DELETE FROM requests WHERE id=?', r.id);
  });
  notify(r.tg_id, '✅ تم قبول طلبك، أصبحت ضمن قائمة الخصوصيين في المنصة. بالتوفيق!');
  return { ok: true };
});
route('DELETE', '/api/admin/requests/:id', ctx => {
  needAdmin(ctx);
  const r = get('SELECT tg_id FROM requests WHERE id=?', ctx.params.id);
  run('DELETE FROM requests WHERE id=?', ctx.params.id);
  if (r) notify(r.tg_id, 'نعتذر، لم يتم قبول طلبك في الوقت الحالي.');
  return { ok: true };
});
route('POST', '/api/admin/edits/:id/allow', ctx => {
  needAdmin(ctx);
  const e = get('SELECT * FROM rating_edits WHERE id=?', ctx.params.id); if (!e) throw new HttpError(404, 'الطلب غير موجود');
  tx(() => { run('DELETE FROM ratings WHERE tutor_id=? AND tg_id=?', e.tutor_id, e.tg_id); run('DELETE FROM rating_edits WHERE id=?', e.id); });
  notify(e.tg_id, '✏️ وافقت الإدارة على طلب تعديل تقييمك، تقدر تقيّم الخصوصي من جديد.');
  return { ok: true };
});
route('DELETE', '/api/admin/edits/:id', ctx => { needAdmin(ctx); run('DELETE FROM rating_edits WHERE id=?', ctx.params.id); return { ok: true }; });
route('POST', '/api/admin/terms', ctx => {
  needAdmin(ctx); const t = str(ctx.body.text, 500); if (!t) throw bad('النص فارغ');
  run('INSERT INTO terms(id,text,sort) VALUES(?,?,?)', uuid(), t, (get('SELECT COALESCE(MAX(sort),0)+1 n FROM terms').n)); return { ok: true };
});
route('DELETE', '/api/admin/terms/:id', ctx => { needAdmin(ctx); run('DELETE FROM terms WHERE id=?', ctx.params.id); return { ok: true }; });
route('GET', '/api/admin/backup', ctx => {
  needAdmin(ctx);
  return { exported_at: new Date().toISOString(), tutors: all('SELECT * FROM tutors').map(parseSubjects), requests: all('SELECT * FROM requests').map(parseSubjects),
    ratings: all('SELECT * FROM ratings'), rating_edits: all('SELECT * FROM rating_edits'), terms: all('SELECT * FROM terms') };
});
route('GET', '/healthz', () => ({ ok: true }));

/* ---------- حد الطلبات (حماية من السبام) ---------- */
const hits = new Map();
function limited(ip, write) {
  const now = Date.now(), key = ip + (write ? ':w' : ':r'), max = write ? 30 : 240;
  let h = hits.get(key); if (!h || h.reset < now) h = { n: 0, reset: now + 60000 };
  h.n++; hits.set(key, h); return h.n > max;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.reset < n) hits.delete(k); }, 60000).unref();

/* ---------- الملفات الثابتة ---------- */
const PUB = path.join(__dir, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webp': 'image/webp' };
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname); if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB + path.sep) && file !== PUB) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('غير موجود'); }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
}

/* ---------- الخادم ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const isApi = url.pathname.startsWith('/api/') || url.pathname === '/healthz';
    if (!isApi) { if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); } return serveStatic(req, res, url.pathname); }

    const ip = (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
    if (limited(ip, req.method !== 'GET')) throw new HttpError(429, 'طلبات كثيرة، حاول بعد قليل');

    let body = {};
    if (req.method !== 'GET' && req.method !== 'DELETE') {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 100_000) throw new HttpError(413, 'الحجم كبير'); chunks.push(c); }
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { throw bad('بيانات غير صالحة'); }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('بيانات غير صالحة');
    }
    for (const [m, re, h] of routes) {
      if (m !== req.method) continue;
      const mt = url.pathname.match(re); if (!mt) continue;
      const ctx = { req, body, params: mt.groups || {}, user: verifyInit(String(req.headers['x-tg-init'] || '')) };
      return json(res, 200, await h(ctx));
    }
    throw new HttpError(404, 'غير موجود');
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.status, { error: e.message, code: e.code });
    console.error(e); json(res, 500, { error: 'خطأ في الخادم' });
  }
});
server.listen(PORT, () => console.log(`✅ المنصة تعمل على المنفذ ${PORT}`));
