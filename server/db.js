/* 数据层：better-sqlite3 连接 + 建表（幂等）+ 种子数据
 * 启动时 initDb()：7 张表 + 种子管理员(admin/123456, 首登强制改密) + 首次导入 routes.json 为全员可见示例 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const config = require('./config');

/* 9 类支出 */
const EXP_KEYS = ['交通', '机票', '高铁', '住宿', '餐饮', '门票', '团费', '购物', '其他'];
const EXP_COL = {
  '交通': 'exp_traffic', '机票': 'exp_flight', '高铁': 'exp_train',
  '住宿': 'exp_hotel', '餐饮': 'exp_meal', '门票': 'exp_ticket',
  '团费': 'exp_group', '购物': 'exp_shopping', '其他': 'exp_other'
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT,
  password_salt TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  email_verified INTEGER NOT NULL DEFAULT 0,
  force_reset INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS email_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  smtp_host TEXT, smtp_port INTEGER, smtp_secure INTEGER NOT NULL DEFAULT 1,
  smtp_user TEXT, smtp_pass TEXT, from_name TEXT, from_address TEXT,
  enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER, updated_by INTEGER
);

CREATE TABLE IF NOT EXISTS verification_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL, purpose TEXT NOT NULL, code TEXT NOT NULL,
  expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vc_email ON verification_codes(email, purpose, consumed);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
  ip TEXT, ua TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, is_seed INTEGER NOT NULL DEFAULT 0,
  year TEXT, name TEXT, daterange TEXT, type TEXT, days INTEGER, people INTEGER,
  dest TEXT, scenic TEXT, hotel TEXT,
  start_date TEXT, end_date TEXT, currency TEXT DEFAULT 'CNY',
  budget_total REAL DEFAULT 0, budget_daily REAL DEFAULT 0,
  exp_traffic REAL DEFAULT 0, exp_flight REAL DEFAULT 0, exp_train REAL DEFAULT 0,
  exp_hotel REAL DEFAULT 0, exp_meal REAL DEFAULT 0, exp_ticket REAL DEFAULT 0,
  exp_group REAL DEFAULT 0, exp_shopping REAL DEFAULT 0, exp_other REAL DEFAULT 0,
  notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_routes_owner ON routes(owner_id);
CREATE INDEX IF NOT EXISTS idx_routes_year ON routes(owner_id, year);

CREATE TABLE IF NOT EXISTS site_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  site_name TEXT NOT NULL DEFAULT '旅行经费工作台',
  allow_register INTEGER NOT NULL DEFAULT 1,
  register_mode TEXT NOT NULL DEFAULT 'all',
  announce_text TEXT, home_currency TEXT NOT NULL DEFAULT 'CNY',
  updated_at INTEGER, updated_by INTEGER
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER,
  action TEXT NOT NULL, target_type TEXT, target_id TEXT, detail TEXT, ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at);
`;

let db = null;

function num(v) { const x = parseFloat(v); return isFinite(x) ? x : 0; }
function scryptHash(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString('hex'); }
function uid(prefix) { return (prefix || 'r') + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }

function initDb() {
  if (!fs.existsSync(config.DATA_DIR)) fs.mkdirSync(config.DATA_DIR, { recursive: true });
  const dbPath = path.join(config.DATA_DIR, config.DB_FILE);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  /* 幂等迁移：为已存在的库补加新列（CREATE TABLE IF NOT EXISTS 不会改旧表） */
  addColumn('routes', 'start_date', 'TEXT');
  addColumn('routes', 'end_date', 'TEXT');
  addColumn('routes', 'currency', "TEXT DEFAULT 'CNY'");
  addColumn('routes', 'budget_total', 'REAL DEFAULT 0');
  addColumn('routes', 'budget_daily', 'REAL DEFAULT 0');
  addColumn('routes', 'share_token', 'TEXT');
  addColumn('site_settings', 'home_currency', "TEXT NOT NULL DEFAULT 'CNY'");
  seedSingleton();
  seedAdmin();
  seedRoutes();
  return db;
}

/* 仅当列不存在时添加（兼容老库升级） */
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
  if (!cols.includes(col)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
  }
}

function seedSingleton() {
  db.prepare('INSERT OR IGNORE INTO email_config (id) VALUES (1)').run();
  db.prepare('INSERT OR IGNORE INTO site_settings (id) VALUES (1)').run();
}

function seedAdmin() {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(config.SEED_ADMIN.username);
  if (exists) return;
  const now = Date.now();
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = scryptHash(config.SEED_ADMIN.password, salt);
  db.prepare(`INSERT INTO users (username, email, password_hash, password_salt, role, status, email_verified, force_reset, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'active', 0, 1, ?, ?)`)
    .run(config.SEED_ADMIN.username, null, hash, salt, config.SEED_ADMIN.role, now, now);
}

/* 首次运行（routes 表为空）时，把 data/routes.json 导入为全员可见示例（is_seed=1） */
function seedRoutes() {
  const n = db.prepare('SELECT COUNT(*) AS c FROM routes').get().c;
  if (n > 0) return;
  const file = path.join(config.DATA_DIR, 'routes.json');
  if (!fs.existsSync(file)) return;
  let arr;
  try { arr = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return; }
  if (!Array.isArray(arr) || !arr.length) return;
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get(config.SEED_ADMIN.username);
  const now = Date.now();
  const ins = db.prepare(`INSERT INTO routes (
      id, owner_id, is_seed, year, name, daterange, type, days, people, dest, scenic, hotel,
      exp_traffic, exp_flight, exp_train, exp_hotel, exp_meal, exp_ticket, exp_group, exp_shopping, exp_other,
      notes, created_at, updated_at)
    VALUES (@id, @owner_id, 1, @year, @name, @daterange, @type, @days, @people, @dest, @scenic, @hotel,
      @exp_traffic, @exp_flight, @exp_train, @exp_hotel, @exp_meal, @exp_ticket, @exp_group, @exp_shopping, @exp_other,
      @notes, @created_at, @updated_at)`);
  const tx = db.transaction(() => {
    for (const r of arr) {
      const e = r.exp || {};
      ins.run({
        id: r.id || uid('r'), owner_id: admin.id,
        year: r.year || '', name: r.name || '', daterange: r.daterange || '', type: r.type || '自由行',
        days: parseInt(r.days) || 0, people: parseInt(r.people) || 0,
        dest: r.dest || '', scenic: r.scenic || '', hotel: r.hotel || '',
        exp_traffic: num(e['交通']), exp_flight: num(e['机票']), exp_train: num(e['高铁']),
        exp_hotel: num(e['住宿']), exp_meal: num(e['餐饮']), exp_ticket: num(e['门票']),
        exp_group: num(e['团费']), exp_shopping: num(e['购物']), exp_other: num(e['其他']),
        notes: r.notes || '', created_at: now, updated_at: now
      });
    }
  });
  tx();
}

/* 解析日期区间文本 → ISO 起止（兼容 YYYY/M/D—YYYY/M/D、M/D—M/D、单日期） */
function isoDate(y, mo, d) { return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function parseDateRange(dr, year) {
  if (!dr) return { start: '', end: '' };
  let m = dr.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\s*[-—~]\s*(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return { start: isoDate(m[1], m[2], m[3]), end: isoDate(m[4], m[5], m[6]) };
  m = dr.match(/(\d{1,2})[\/\-.](\d{1,2})\s*[-—~]\s*(\d{1,2})[\/\-.](\d{1,2})/);
  if (m && year) return { start: isoDate(year, m[1], m[2]), end: isoDate(year, m[3], m[4]) };
  m = dr.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return { start: isoDate(m[1], m[2], m[3]), end: isoDate(m[1], m[2], m[3]) };
  m = dr.match(/(\d{1,2})[\/\-.](\d{1,2})/);
  if (m && year) return { start: isoDate(year, m[1], m[2]), end: isoDate(year, m[1], m[2]) };
  return { start: '', end: '' };
}

/* 行 → JSON（重组 exp 对象，兼容原前端） */
function routeToJson(row) {
  const exp = {};
  for (const k of EXP_KEYS) exp[k] = num(row[EXP_COL[k]]);
  const out = { id: row.id, owner_id: row.owner_id, is_seed: !!row.is_seed, year: row.year, name: row.name,
    daterange: row.daterange, type: row.type, days: row.days, people: row.people, dest: row.dest,
    scenic: row.scenic, hotel: row.hotel, start_date: row.start_date || '', end_date: row.end_date || '',
    currency: row.currency || 'CNY', budget_total: num(row.budget_total), budget_daily: num(row.budget_daily),
    notes: row.notes, created_at: row.created_at, updated_at: row.updated_at, exp };
  return out;
}

function bind(data, userId, isSeed, now, id) {
  const e = data.exp || {};
  const dr = parseDateRange(data.daterange, data.year);
  return {
    id: id || data.id || uid('r'), owner_id: userId, is_seed: isSeed ? 1 : 0,
    year: data.year || '', name: data.name || '', daterange: data.daterange || '', type: data.type || '自由行',
    days: parseInt(data.days) || 0, people: parseInt(data.people) || 0,
    dest: data.dest || '', scenic: data.scenic || '', hotel: data.hotel || '',
    start_date: data.start_date || dr.start || '', end_date: data.end_date || dr.end || '',
    currency: (data.currency && String(data.currency).trim()) || 'CNY',
    budget_total: num(data.budget_total), budget_daily: num(data.budget_daily),
    exp_traffic: num(e['交通']), exp_flight: num(e['机票']), exp_train: num(e['高铁']),
    exp_hotel: num(e['住宿']), exp_meal: num(e['餐饮']), exp_ticket: num(e['门票']),
    exp_group: num(e['团费']), exp_shopping: num(e['购物']), exp_other: num(e['其他']),
    notes: data.notes || '', created_at: now, updated_at: now
  };
}

const ROUTE_COLS = `id, owner_id, is_seed, year, name, daterange, type, days, people, dest, scenic, hotel, start_date, end_date, currency, budget_total, budget_daily,
  exp_traffic, exp_flight, exp_train, exp_hotel, exp_meal, exp_ticket, exp_group, exp_shopping, exp_other, notes, created_at, updated_at`;

function insertRoute(userId, data, isSeed) {
  const now = Date.now();
  const p = bind(data, userId, isSeed, now);
  db.prepare(`INSERT INTO routes (${ROUTE_COLS}) VALUES (@id,@owner_id,@is_seed,@year,@name,@daterange,@type,@days,@people,@dest,@scenic,@hotel,@start_date,@end_date,@currency,@budget_total,@budget_daily,
    @exp_traffic,@exp_flight,@exp_train,@exp_hotel,@exp_meal,@exp_ticket,@exp_group,@exp_shopping,@exp_other,@notes,@created_at,@updated_at)`).run(p);
  return getRoute(p.id);
}

function updateRoute(id, userId, data) {
  const now = Date.now();
  const p = bind(data, userId, false, now, id);
  db.prepare(`UPDATE routes SET year=@year, name=@name, daterange=@daterange, type=@type, days=@days, people=@people,
    dest=@dest, scenic=@scenic, hotel=@hotel, start_date=@start_date, end_date=@end_date, currency=@currency, budget_total=@budget_total, budget_daily=@budget_daily, exp_traffic=@exp_traffic, exp_flight=@exp_flight, exp_train=@exp_train,
    exp_hotel=@exp_hotel, exp_meal=@exp_meal, exp_ticket=@exp_ticket, exp_group=@exp_group, exp_shopping=@exp_shopping,
    exp_other=@exp_other, notes=@notes, updated_at=@updated_at WHERE id=@id AND owner_id=@owner_id`).run(p);
  return getRoute(id);
}

function getRoute(id) {
  const row = db.prepare(`SELECT ${ROUTE_COLS} FROM routes WHERE id = ?`).get(id);
  return row ? routeToJson(row) : null;
}

/* ---------- 只读分享 ---------- */
function getShareToken(id) {
  const r = db.prepare('SELECT share_token FROM routes WHERE id = ?').get(id);
  return (r && r.share_token) || null;
}
function setShareToken(id, token) {
  db.prepare('UPDATE routes SET share_token = ? WHERE id = ?').run(token, id);
}
function clearShareToken(id) {
  db.prepare('UPDATE routes SET share_token = NULL WHERE id = ?').run(id);
}
function findRouteByShareToken(token) {
  const row = db.prepare(`SELECT ${ROUTE_COLS} FROM routes WHERE share_token = ?`).get(token);
  return row ? routeToJson(row) : null;
}

module.exports = {
  initDb, get db() { return db; },
  EXP_KEYS, EXP_COL, num, scryptHash, uid,
  ROUTE_COLS,
  routeToJson, insertRoute, updateRoute, getRoute,
  getShareToken, setShareToken, clearShareToken, findRouteByShareToken
};