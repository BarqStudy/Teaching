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
const APP_LINK = (env.APP_LINK || '').trim();           // مثال: https://t.me/MyBot/app (اختياري، لروابط المشاركة)
const BACKUP_TO_TELEGRAM = env.BACKUP_TO_TELEGRAM === '1';
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

/* ---------- ترقية الجداول (آمنة للتكرار) ---------- */
const colsOf = t => all(`PRAGMA table_info(${t})`).map(c => c.name);
const addCol = (t, c, def) => { if (!colsOf(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
addCol('tutors', 'tg_id', 'TEXT');
addCol('tutors', 'availability', "TEXT DEFAULT 'available'");
addCol('tutors', 'status', "TEXT DEFAULT 'active'");
addCol('tutors', 'warnings', 'INTEGER DEFAULT 0');
addCol('tutors', 'photo', "TEXT DEFAULT ''");
addCol('ratings', 'reply', "TEXT DEFAULT ''");
addCol('ratings', 'reply_at', 'TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS favorites(tg_id TEXT, tutor_id TEXT REFERENCES tutors(id) ON DELETE CASCADE, PRIMARY KEY(tg_id, tutor_id));
CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now')), tg_id TEXT, who TEXT, kind TEXT, tutor_id TEXT, rating_id TEXT, reason TEXT, status TEXT DEFAULT 'open');
CREATE TABLE IF NOT EXISTS warnings_log(id TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now')), tutor_id TEXT REFERENCES tutors(id) ON DELETE CASCADE, reason TEXT);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT (datetime('now')), type TEXT, tutor_id TEXT, tg_id TEXT);
CREATE TABLE IF NOT EXISTS visits(day TEXT, tg_id TEXT, PRIMARY KEY(day, tg_id));
CREATE TABLE IF NOT EXISTS users(tg_id TEXT PRIMARY KEY, name TEXT, first_seen TEXT DEFAULT (datetime('now')), last_seen TEXT DEFAULT (datetime('now')), blocked INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS subject_requests(id TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now')), tg_id TEXT, who TEXT, subject TEXT, note TEXT DEFAULT '');
CREATE INDEX IF NOT EXISTS ev_idx ON events(type, ts);
`);
const UPLOAD_DIR = path.join(path.dirname(DB_PATH), 'uploads');
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------- أدوات عامة ---------- */
class HttpError extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code; } }
const bad = (msg) => new HttpError(400, msg);
const json = (res, status, data) => { const b = JSON.stringify(data); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(b); };
const parseSubjects = r => ({ ...r, subjects: (() => { try { return JSON.parse(r.subjects || '[]'); } catch { return []; } })() });
const pubTutor = r => {
  const { tg_id, warnings, status, photo, ...t } = parseSubjects(r);
  return { ...t, verified: !!t.verified, pledge: !!t.pledge, photo: photo ? `/uploads/${t.id}.jpg?v=${photo}` : '' };
};
const adminTutor = r => ({ ...pubTutor(r), tg_id: r.tg_id || '', warnings: r.warnings || 0, status: r.status || 'active' });

/* الشارات التلقائية */
function computeBadges() {
  const out = {}, add = (id, b) => (out[id] = out[id] || []).push(b);
  for (const r of all(`SELECT tutor_id, COUNT(*) n, AVG(score) a, SUM(CASE WHEN COALESCE(reply,'')<>'' THEN 1 ELSE 0 END) rep FROM ratings GROUP BY tutor_id`)) {
    if (r.n >= 3 && r.a >= 85) add(r.tutor_id, 'top');
    if (r.n >= 2 && r.rep / r.n >= 0.5) add(r.tutor_id, 'engaged');
  }
  for (const r of all(`SELECT tutor_id, COUNT(*) n FROM events WHERE type IN ('wa','tg') AND ts >= datetime('now','-30 days') GROUP BY tutor_id HAVING n >= 5 ORDER BY n DESC LIMIT 3`)) add(r.tutor_id, 'hot');
  return out;
}

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
async function tgSend(chatId, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    return { ok: r.ok, blocked: r.status === 403 };
  } catch { return { ok: false, blocked: false }; }
}
function notify(chatId, text) { if (chatId) tgSend(chatId, text); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  let tutorId = null, favorites = [];
  if (u) {
    run(`INSERT INTO users(tg_id,name) VALUES(?,?) ON CONFLICT(tg_id) DO UPDATE SET name=excluded.name,last_seen=datetime('now'),blocked=0`, u.id, u.name);
    run(`INSERT OR IGNORE INTO visits(day,tg_id) VALUES(date('now'),?)`, u.id);
    tutorId = get(`SELECT id FROM tutors WHERE tg_id=? AND status='active'`, u.id)?.id || null;
    favorites = all('SELECT tutor_id FROM favorites WHERE tg_id=?', u.id).map(x => x.tutor_id);
  }
  const badges = computeBadges();
  return {
    me: { authed: !!u, id: u?.id || null, name: u?.name || null, isAdmin: !!u?.isAdmin, tutorId, favorites },
    config: { appLink: APP_LINK },
    tutors: all(`SELECT * FROM tutors WHERE status='active' ORDER BY created_at`).map(r => ({ ...pubTutor(r), badges: badges[r.id] || [] })),
    ratings: all(`SELECT r.id,r.tutor_id,r.tg_id,r.who,r.score,r.explain,r.style,r.coop,r.comment,r.reply,r.reply_at,r.created_at
                  FROM ratings r JOIN tutors t ON t.id=r.tutor_id WHERE t.status='active' ORDER BY r.created_at`)
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
  notify(get('SELECT tg_id FROM tutors WHERE id=?', b.tutor_id)?.tg_id, `⭐ تقييم جديد (${score}/100) من ${u.name}`);
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

/* ---------- المفضلة والتتبع وطلبات المواد والبلاغات ---------- */
route('POST', '/api/favorites', ctx => {
  const u = needUser(ctx), id = String(ctx.body.tutor_id || '');
  if (ctx.body.on) { if (!get('SELECT 1 x FROM tutors WHERE id=?', id)) throw new HttpError(404, 'الخصوصي غير موجود'); run('INSERT OR IGNORE INTO favorites(tg_id,tutor_id) VALUES(?,?)', u.id, id); }
  else run('DELETE FROM favorites WHERE tg_id=? AND tutor_id=?', u.id, id);
  return { ok: true };
});
route('POST', '/api/track', ctx => {
  const type = String(ctx.body.type || ''), id = String(ctx.body.tutor_id || '');
  if (!['wa', 'tg', 'trial', 'share'].includes(type) || !get('SELECT 1 x FROM tutors WHERE id=?', id)) return { ok: true };
  const uid_ = ctx.user?.id || null;
  if (uid_ && get(`SELECT 1 x FROM events WHERE type=? AND tutor_id=? AND tg_id=? AND ts>=datetime('now','-1 hour')`, type, id, uid_)) return { ok: true };
  run('INSERT INTO events(type,tutor_id,tg_id) VALUES(?,?,?)', type, id, uid_);
  return { ok: true };
});
route('POST', '/api/subject-requests', ctx => {
  const u = needUser(ctx), subject = str(ctx.body.subject, 80), note = str(ctx.body.note, 200);
  if (subject.length < 2) throw bad('اكتب اسم المادة');
  if (get(`SELECT COUNT(*) c FROM subject_requests WHERE tg_id=? AND created_at>=datetime('now','-1 day')`, u.id).c >= 5) throw bad('وصلت الحد اليومي لطلبات المواد');
  run('INSERT INTO subject_requests(id,tg_id,who,subject,note) VALUES(?,?,?,?,?)', uuid(), u.id, u.name, subject, note);
  return { ok: true };
});
route('POST', '/api/reports', ctx => {
  const u = needUser(ctx), b = ctx.body, kind = b.kind === 'review' ? 'review' : 'tutor';
  const reason = str(b.reason, 300); if (reason.length < 3) throw bad('اكتب سبب البلاغ');
  const tutorId = String(b.tutor_id || ''), ratingId = kind === 'review' ? String(b.rating_id || '') : null;
  if (!get('SELECT 1 x FROM tutors WHERE id=?', tutorId)) throw new HttpError(404, 'الخصوصي غير موجود');
  if (kind === 'review' && !get('SELECT 1 x FROM ratings WHERE id=? AND tutor_id=?', ratingId, tutorId)) throw new HttpError(404, 'التقييم غير موجود');
  if (get(`SELECT 1 x FROM reports WHERE tg_id=? AND kind=? AND tutor_id=? AND COALESCE(rating_id,'')=COALESCE(?,'') AND status='open'`, u.id, kind, tutorId, ratingId)) throw new HttpError(409, 'سبق أن أرسلت بلاغاً وهو قيد المراجعة', 'pending');
  run('INSERT INTO reports(id,tg_id,who,kind,tutor_id,rating_id,reason) VALUES(?,?,?,?,?,?,?)', uuid(), u.id, u.name, kind, tutorId, ratingId, reason);
  for (const a of ADMIN_IDS) notify(a, `🚩 بلاغ جديد من ${u.name}`);
  return { ok: true };
});

/* ---------- حساب الخصوصي نفسه ---------- */
const myTutor = ctx => {
  const u = needUser(ctx), t = get(`SELECT * FROM tutors WHERE tg_id=? AND status='active'`, u.id);
  if (!t) throw new HttpError(403, 'هذا الحساب غير مرتبط بخصوصي');
  return t;
};
function savePhoto(tutorId, dataUrl) {
  const m = String(dataUrl || '').match(/^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw bad('صورة غير صالحة');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 250_000) throw bad('حجم الصورة كبير');
  if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) throw bad('الصيغة المسموحة JPG فقط');
  fs.writeFileSync(path.join(UPLOAD_DIR, tutorId + '.jpg'), buf);
  const v = Date.now().toString(36);
  run('UPDATE tutors SET photo=? WHERE id=?', v, tutorId);
  return v;
}
route('PUT', '/api/me/tutor', ctx => {
  const t = myTutor(ctx), b = ctx.body, cur = parseSubjects(t);
  const clean = cleanTutor({ ...cur, whatsapp: b.whatsapp ?? cur.whatsapp, telegram: b.telegram ?? cur.telegram, subjects: b.subjects ?? cur.subjects });
  const availability = ['available', 'full'].includes(b.availability) ? b.availability : t.availability;
  run('UPDATE tutors SET whatsapp=?,telegram=?,subjects=?,availability=?,bio=? WHERE id=?',
    clean.whatsapp, clean.telegram, clean.subjects, availability, str(b.bio ?? t.bio, 300), t.id);
  return { ok: true };
});
route('POST', '/api/me/tutor/photo', ctx => { const t = myTutor(ctx); savePhoto(t.id, ctx.body.image); return { ok: true }; });
route('POST', '/api/me/replies', ctx => {
  const t = myTutor(ctx), r = get('SELECT * FROM ratings WHERE id=? AND tutor_id=?', String(ctx.body.rating_id || ''), t.id);
  if (!r) throw new HttpError(404, 'التقييم غير موجود');
  const reply = str(ctx.body.reply, 400); if (!reply) throw bad('اكتب الرد');
  run(`UPDATE ratings SET reply=?,reply_at=datetime('now') WHERE id=?`, reply, r.id);
  notify(r.tg_id, `💬 ردّ الخصوصي ${t.name} على تقييمك:\n${reply}`);
  return { ok: true };
});
route('GET', '/api/me/stats', ctx => {
  const t = myTutor(ctx), ev = type => get(`SELECT COUNT(*) c FROM events WHERE tutor_id=? AND type=? AND ts>=datetime('now','-30 days')`, t.id, type).c;
  const r = get(`SELECT COUNT(*) n, AVG(score) a, SUM(CASE WHEN COALESCE(reply,'')='' THEN 1 ELSE 0 END) unreplied FROM ratings WHERE tutor_id=?`, t.id);
  return { wa: ev('wa'), tg: ev('tg'), trial: ev('trial'), share: ev('share'), favorites: get('SELECT COUNT(*) c FROM favorites WHERE tutor_id=?', t.id).c,
    ratings: r.n, avg: r.n ? Math.round(r.a) : null, unreplied: r.unreplied || 0, warnings: t.warnings || 0, badges: computeBadges()[t.id] || [], bio: t.bio || '' };
});

/* ---------- الإدارة ---------- */
route('GET', '/api/admin/data', ctx => {
  needAdmin(ctx);
  return {
    requests: all('SELECT * FROM requests ORDER BY created_at').map(parseSubjects),
    edits: all(`SELECT e.id,e.tutor_id,e.who,e.reason,e.created_at,r.score,r.explain,r.style,r.coop
                FROM rating_edits e LEFT JOIN ratings r ON r.tutor_id=e.tutor_id AND r.tg_id=e.tg_id ORDER BY e.created_at`),
    tutors: all('SELECT * FROM tutors ORDER BY created_at').map(adminTutor),
    reports: all(`SELECT p.id,p.created_at,p.who,p.kind,p.tutor_id,p.rating_id,p.reason,t.name tutor_name,r.comment,r.who rater,r.score
                  FROM reports p LEFT JOIN tutors t ON t.id=p.tutor_id LEFT JOIN ratings r ON r.id=p.rating_id WHERE p.status='open' ORDER BY p.created_at`),
    subjectRequests: all(`SELECT MIN(subject) subject, COUNT(*) n, MAX(created_at) last FROM subject_requests GROUP BY LOWER(TRIM(subject)) ORDER BY n DESC, last DESC`)
  };
});
const cleanTgId = v => { v = String(v ?? '').trim(); if (v && !/^\d{3,15}$/.test(v)) throw bad('آيدي تليجرام يجب أن يكون أرقاماً'); return v || null; };
route('POST', '/api/admin/tutors', ctx => {
  needAdmin(ctx); const t = cleanTutor(ctx.body), rating = Math.max(0, Math.min(100, +ctx.body.rating || 0)), tgid = cleanTgId(ctx.body.tg_id);
  const id = uuid();
  run('INSERT INTO tutors(id,name,nationality,age,gender,whatsapp,telegram,subjects,rating,pledge,tg_id) VALUES(?,?,?,?,?,?,?,?,?,1,?)',
    id, t.name, t.nationality, t.age, t.gender, t.whatsapp, t.telegram, t.subjects, rating, tgid);
  if (ctx.body.image) savePhoto(id, ctx.body.image);
  return { ok: true };
});
route('PUT', '/api/admin/tutors/:id', ctx => {
  needAdmin(ctx); const t = cleanTutor(ctx.body), rating = Math.max(0, Math.min(100, +ctx.body.rating || 0));
  const tgid = cleanTgId(ctx.body.tg_id);
  run('UPDATE tutors SET name=?,nationality=?,age=?,gender=?,whatsapp=?,telegram=?,subjects=?,rating=?,tg_id=? WHERE id=?',
    t.name, t.nationality, t.age, t.gender, t.whatsapp, t.telegram, t.subjects, rating, tgid, ctx.params.id);
  if (ctx.body.image) savePhoto(ctx.params.id, ctx.body.image);
  return { ok: true };
});
route('POST', '/api/admin/tutors/:id/verify', ctx => { needAdmin(ctx); run('UPDATE tutors SET verified=? WHERE id=?', ctx.body.verified ? 1 : 0, ctx.params.id); return { ok: true }; });
function warnTutor(id, reason) {
  const t = get('SELECT * FROM tutors WHERE id=?', id); if (!t) throw new HttpError(404, 'الخصوصي غير موجود');
  run('INSERT INTO warnings_log(id,tutor_id,reason) VALUES(?,?,?)', uuid(), id, reason);
  const w = (t.warnings || 0) + 1, removed = w >= 3;
  run('UPDATE tutors SET warnings=?,status=? WHERE id=?', w, removed ? 'removed' : t.status, id);
  notify(t.tg_id, removed ? `⛔ وصلت إلى 3 إنذارات وتم إلغاؤك من قائمة الخصوصيين.\nآخر سبب: ${reason}` : `⚠️ إنذار (${w}/3)\nالسبب: ${reason}`);
  return { warnings: w, removed };
}
route('POST', '/api/admin/tutors/:id/warn', ctx => { needAdmin(ctx); const reason = str(ctx.body.reason, 300); if (reason.length < 3) throw bad('اكتب سبب الإنذار'); return { ok: true, ...warnTutor(ctx.params.id, reason) }; });
route('POST', '/api/admin/tutors/:id/restore', ctx => { needAdmin(ctx); run(`UPDATE tutors SET status='active',warnings=0 WHERE id=?`, ctx.params.id); return { ok: true }; });
route('DELETE', '/api/admin/tutors/:id', ctx => { needAdmin(ctx); run('DELETE FROM tutors WHERE id=?', ctx.params.id); return { ok: true }; });

route('POST', '/api/admin/requests/:id/approve', ctx => {
  needAdmin(ctx);
  const r = get('SELECT * FROM requests WHERE id=?', ctx.params.id); if (!r) throw new HttpError(404, 'الطلب غير موجود');
  tx(() => {
    run('INSERT INTO tutors(id,name,nationality,age,gender,whatsapp,telegram,subjects,rating,pledge,verified,tg_id) VALUES(?,?,?,?,?,?,?,?,0,?,0,?)',
      uuid(), r.name, r.nationality, r.age, r.gender, r.whatsapp, r.telegram, r.subjects, r.pledge, r.tg_id);
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
    ratings: all('SELECT * FROM ratings'), rating_edits: all('SELECT * FROM rating_edits'), terms: all('SELECT * FROM terms'), favorites: all('SELECT * FROM favorites'), subject_requests: all('SELECT * FROM subject_requests') };
});
route('POST', '/api/admin/reports/:id/resolve', ctx => {
  needAdmin(ctx);
  const p = get('SELECT * FROM reports WHERE id=?', ctx.params.id); if (!p) throw new HttpError(404, 'البلاغ غير موجود');
  const action = String(ctx.body.action || '');
  if (action === 'delete_review' && p.rating_id) run('DELETE FROM ratings WHERE id=?', p.rating_id);
  else if (action === 'warn') warnTutor(p.tutor_id, str(p.reason, 300));
  else if (action !== 'dismiss') throw bad('إجراء غير معروف');
  run(`UPDATE reports SET status='done' WHERE id=?`, p.id);
  return { ok: true };
});
route('GET', '/api/admin/stats', ctx => {
  needAdmin(ctx);
  const c = (sql, ...a) => get(sql, ...a).c;
  const subj = {};
  for (const t of all(`SELECT subjects FROM tutors WHERE status='active'`)) for (const s of JSON.parse(t.subjects || '[]')) { const k = s.name.trim(); subj[k] = (subj[k] || 0) + 1; }
  return {
    visitors: { today: c(`SELECT COUNT(*) c FROM visits WHERE day=date('now')`), week: c(`SELECT COUNT(DISTINCT tg_id) c FROM visits WHERE day>=date('now','-6 days')`), month: c(`SELECT COUNT(DISTINCT tg_id) c FROM visits WHERE day>=date('now','-29 days')`), total: c('SELECT COUNT(*) c FROM users') },
    totals: { tutors: c(`SELECT COUNT(*) c FROM tutors WHERE status='active'`), ratings: c('SELECT COUNT(*) c FROM ratings'), favorites: c('SELECT COUNT(*) c FROM favorites') },
    clicks: { wa: c(`SELECT COUNT(*) c FROM events WHERE type='wa' AND ts>=datetime('now','-30 days')`), tg: c(`SELECT COUNT(*) c FROM events WHERE type='tg' AND ts>=datetime('now','-30 days')`), trial: c(`SELECT COUNT(*) c FROM events WHERE type='trial' AND ts>=datetime('now','-30 days')`) },
    topTutors: all(`SELECT t.name, COUNT(*) n FROM events e JOIN tutors t ON t.id=e.tutor_id WHERE e.type IN ('wa','tg') AND e.ts>=datetime('now','-30 days') GROUP BY e.tutor_id ORDER BY n DESC LIMIT 5`),
    topSubjects: Object.entries(subj).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ name, n })),
    requested: all(`SELECT MIN(subject) name, COUNT(*) n FROM subject_requests GROUP BY LOWER(TRIM(subject)) ORDER BY n DESC LIMIT 8`)
  };
});
let broadcasting = false;
route('POST', '/api/admin/broadcast', ctx => {
  needAdmin(ctx);
  const text = str(ctx.body.text, 1000); if (text.length < 2) throw bad('اكتب نص الرسالة');
  if (broadcasting) throw bad('هناك إرسال جارٍ، انتظر حتى ينتهي');
  const users = all('SELECT tg_id FROM users WHERE blocked=0');
  broadcasting = true;
  (async () => {
    let ok = 0;
    for (const u of users) {
      const r = await tgSend(u.tg_id, text);
      if (r.ok) ok++; else if (r.blocked) run('UPDATE users SET blocked=1 WHERE tg_id=?', u.tg_id);
      await sleep(60);
    }
    broadcasting = false;
    for (const a of ADMIN_IDS) notify(a, `📢 اكتمل الإرسال: وصلت الرسالة إلى ${ok} من ${users.length}`);
  })().catch(() => { broadcasting = false; });
  return { ok: true, total: users.length };
});
route('POST', '/api/admin/subject-requests/clear', ctx => { needAdmin(ctx); run('DELETE FROM subject_requests WHERE LOWER(TRIM(subject))=LOWER(TRIM(?))', String(ctx.body.subject || '')); return { ok: true }; });
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
  let base = PUB;
  if (rel.startsWith('/uploads/')) { base = UPLOAD_DIR; rel = rel.slice('/uploads'.length); }
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base + path.sep) && file !== base) { res.writeHead(403); return res.end(); }
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
      for await (const c of req) { size += c.length; if (size > 400_000) throw new HttpError(413, 'الحجم كبير'); chunks.push(c); }
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
/* ---------- نسخ احتياطي تلقائي يومي ---------- */
async function backup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = `barq-${new Date().toISOString().slice(0, 10)}.db`, f = path.join(BACKUP_DIR, name);
    if (fs.existsSync(f)) return;
    db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`);
    const old = fs.readdirSync(BACKUP_DIR).filter(x => x.startsWith('barq-')).sort().slice(0, -14);
    for (const o of old) fs.unlinkSync(path.join(BACKUP_DIR, o));
    console.log('💾 نسخة احتياطية:', name);
    if (BACKUP_TO_TELEGRAM) for (const a of ADMIN_IDS) {
      const fd = new FormData(); fd.append('chat_id', a); fd.append('caption', '💾 النسخة الاحتياطية اليومية');
      fd.append('document', new Blob([fs.readFileSync(f)]), name);
      fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd }).catch(() => {});
    }
  } catch (e) { console.error('backup failed', e.message); }
}
setTimeout(backup, 10_000).unref();
setInterval(backup, 6 * 3600_000).unref();

server.listen(PORT, () => console.log(`✅ المنصة تعمل على المنفذ ${PORT}`));
