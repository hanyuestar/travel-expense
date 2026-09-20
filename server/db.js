/* 数据层：better-sqlite3 连接 + 建表（幂等）+ 种子数据
 * 启动时 initDb()：表 + 种子管理员(admin/123456, 首登强制改密) + 首次导入 routes.json 为全员可见示例 */
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

CREATE TABLE IF NOT EXISTS ai_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  api_base_url TEXT, api_key TEXT, model_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  skip_ssl_verify INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER, updated_by INTEGER
);

CREATE TABLE IF NOT EXISTS ai_enabled_users (
  user_id INTEGER PRIMARY KEY,
  enabled_at INTEGER NOT NULL,
  enabled_by INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

/* ---------- 逐笔消费流水 + AA 分账（v1.1.0） ----------
 * 设计要点：expenses 为明细真源；routes.exp_* 退化为**物化聚合**（由 recomputeRouteAgg 回写），
 * 因此统计 / 导出 / 分享 / 9 类明细等既有链路全部无需感知流水表。 */

/* 同行人（AA 结算主体） */
CREATE TABLE IF NOT EXISTS travelers (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  is_self INTEGER NOT NULL DEFAULT 0,
  sort_no INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_travelers_route ON travelers(route_id);

/* 消费流水 */
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  spent_on TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'CNY',
  title TEXT,
  note TEXT,
  payer_id TEXT,
  split_mode TEXT NOT NULL DEFAULT 'equal',
  is_opening INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (payer_id) REFERENCES travelers(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_route_day ON expenses(route_id, spent_on);
CREATE INDEX IF NOT EXISTS idx_expenses_route_cat ON expenses(route_id, category);

/* 分摊参与人（weight 为按份数分摊预留，当前恒为 1） */
CREATE TABLE IF NOT EXISTS expense_parts (
  expense_id TEXT NOT NULL,
  traveler_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (expense_id, traveler_id),
  FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE,
  FOREIGN KEY (traveler_id) REFERENCES travelers(id) ON DELETE CASCADE
);
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
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  /* 幂等迁移：为已存在的库补加新列（CREATE TABLE IF NOT EXISTS 不会改旧表） */
  addColumn('routes', 'start_date', 'TEXT');
  addColumn('routes', 'end_date', 'TEXT');
  addColumn('routes', 'currency', "TEXT DEFAULT 'CNY'");
  addColumn('routes', 'budget_total', 'REAL DEFAULT 0');
  addColumn('routes', 'budget_daily', 'REAL DEFAULT 0');
  addColumn('routes', 'share_token', 'TEXT');
  addColumn('site_settings', 'home_currency', "TEXT NOT NULL DEFAULT 'CNY'");
  addColumn('ai_config', 'skip_ssl_verify', "INTEGER NOT NULL DEFAULT 0");
  seedSingleton();
  seedAdmin();
  seedRoutes();
  migrateAggregatesToOpening();
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
  db.prepare('INSERT OR IGNORE INTO ai_config (id) VALUES (1)').run();
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

/* 首次运行（routes 表为空）时，把 data/routes.json 导入为全员可见示例（is_seed=1）
 * 复用 bind()（经 insertRoute）构造参数，避免与 routes_api 导入/更新各写一份字段映射 */
function seedRoutes() {
  const n = db.prepare('SELECT COUNT(*) AS c FROM routes').get().c;
  if (n > 0) return;
  const file = path.join(config.DATA_DIR, 'routes.json');
  if (!fs.existsSync(file)) return;
  let arr;
  try { arr = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return; }
  if (!Array.isArray(arr) || !arr.length) return;
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get(config.SEED_ADMIN.username);
  if (!admin) return;
  const tx = db.transaction(() => {
    for (const r of arr) insertRoute(admin.id, r, true);
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
  if (m && year) {
    const sm = +m[1], em = +m[3];
    const ey = em < sm ? +year + 1 : +year;
    return { start: isoDate(year, m[1], m[2]), end: isoDate(ey, m[3], m[4]) };
  }
  m = dr.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return { start: isoDate(m[1], m[2], m[3]), end: isoDate(m[1], m[2], m[3]) };
  m = dr.match(/(\d{1,2})[\/\-.](\d{1,2})/);
  if (m && year) return { start: isoDate(year, m[1], m[2]), end: isoDate(year, m[1], m[2]) };
  return { start: '', end: '' };
}

/* 由起止日期生成显示用 daterange 文本（如 2026/06/17 - 2026/06/24） */
function buildDateRangeText(start, end) {
  if (!start && !end) return '';
  const fmt = (s) => {
    if (!s) return '';
    const [y, m, d] = s.split('-');
    return y && m && d ? `${y}/${m}/${d}` : s;
  };
  if (start && end && start !== end) return `${fmt(start)} - ${fmt(end)}`;
  return fmt(start || end);
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
  /* 起止日期优先取前端传入的 start_date/end_date，否则从 daterange 文本解析 */
  const startDate = (data.start_date || '').trim();
  const endDate = (data.end_date || '').trim();
  const dr = parseDateRange(data.daterange, data.year);
  const start = startDate || dr.start || '';
  const end = endDate || dr.end || '';
  /* daterange 显示文本：优先用前端传入的，否则由起止日期生成，保持兼容 */
  const daterange = (data.daterange && data.daterange.trim()) || buildDateRangeText(start, end);
  return {
    id: id || data.id || uid('r'), owner_id: userId, is_seed: isSeed ? 1 : 0,
    year: data.year || '', name: data.name || '', daterange, type: data.type || '自由行',
    days: parseInt(data.days) || 0, people: parseInt(data.people) || 0,
    dest: data.dest || '', scenic: data.scenic || '', hotel: data.hotel || '',
    start_date: start, end_date: end,
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
  /* 9 类金额统一由流水派生：把传入的聚合值转成期初流水，再做一次聚合回写。
   * 这样「新建路线 / 导入」携带的 9 类金额不会丢，且后续增删流水能正确增量。 */
  if (createOpeningExpenses(getRouteRow(p.id))) recomputeRouteAgg(p.id);
  return getRoute(p.id);
}

/* 内部：取原始行（createOpeningExpenses 需要 exp_* 列） */
function getRouteRow(id) {
  return db.prepare(`SELECT ${ROUTE_COLS} FROM routes WHERE id = ?`).get(id) || null;
}

/* 更新路线。
 * 注意：**不再写入 exp_\* 列** —— 9 类金额自 v1.1.0 起统一由流水派生（物化聚合），
 * 仅由 recomputeRouteAgg() 维护。否则「编辑路线」会凭空覆盖掉流水聚合值。 */
function updateRoute(id, userId, data) {
  const now = Date.now();
  const p = bind(data, userId, false, now, id);
  db.prepare(`UPDATE routes SET year=@year, name=@name, daterange=@daterange, type=@type, days=@days, people=@people,
    dest=@dest, scenic=@scenic, hotel=@hotel, start_date=@start_date, end_date=@end_date, currency=@currency, budget_total=@budget_total, budget_daily=@budget_daily, notes=@notes, updated_at=@updated_at
    WHERE id=@id AND owner_id=@owner_id`).run(p);
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

/* ---------- AI 配置 ---------- */
function getAiConfig() {
  const c = db.prepare('SELECT * FROM ai_config WHERE id = 1').get() || {};
  return {
    api_base_url: c.api_base_url || '',
    api_key: c.api_key || '',
    model_id: c.model_id || '',
    enabled: !!c.enabled,
    skip_ssl_verify: !!c.skip_ssl_verify,
    updated_at: c.updated_at || null,
    updated_by: c.updated_by || null
  };
}
function saveAiConfig(data, adminId) {
  const cur = getAiConfig();
  const apiKey = data.api_key && data.api_key !== '******' ? String(data.api_key) : (cur.api_key || '');
  db.prepare(`UPDATE ai_config SET api_base_url=?, api_key=?, model_id=?, enabled=?, skip_ssl_verify=?, updated_at=?, updated_by=? WHERE id=1`)
    .run(
      String(data.api_base_url || '').trim(),
      apiKey,
      String(data.model_id || '').trim(),
      data.enabled ? 1 : 0,
      data.skip_ssl_verify ? 1 : 0,
      Date.now(),
      adminId
    );
  return getAiConfig();
}

/* ---------- AI 启用用户 ---------- */
function getAiEnabledUserIds() {
  return db.prepare('SELECT user_id FROM ai_enabled_users').all().map(r => r.user_id);
}
function isAiEnabledUser(userId) {
  return !!db.prepare('SELECT 1 FROM ai_enabled_users WHERE user_id = ?').get(userId);
}
function setAiEnabledUsers(userIds, adminId) {
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM ai_enabled_users').run();
    const stmt = db.prepare('INSERT OR IGNORE INTO ai_enabled_users (user_id, enabled_at, enabled_by) VALUES (?, ?, ?)');
    for (const uid of userIds) {
      const id = parseInt(uid, 10);
      if (id > 0) stmt.run(id, now, adminId);
    }
  });
  tx();
  return getAiEnabledUserIds();
}

/* 审计日志：auth 与 admin 共用的唯一实现（写入失败不阻塞主流程） */
function audit(actorId, action, targetType, targetId, detail, ip) {
  try {
    db.prepare('INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail, ip, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(actorId, action, targetType || null, targetId || null, detail || null, ip || null, Date.now());
  } catch (e) { /* 审计写入失败不阻塞主流程 */ }
}

/* ============================================================================
   逐笔消费流水 + AA 分账
   ============================================================================ */
const round2 = (v) => Math.round((num(v)) * 100) / 100;

/* ---------- 物化聚合：expenses 明细 → routes.exp_* ----------
 * 所有流水的增删改都必须在同一事务内调用本函数，保证 9 类聚合值与明细恒等；
 * 既有统计 / 导出 / 分享链路读的都是 exp_*，因此无需改动。 */
function recomputeRouteAgg(routeId) {
  const sums = {};
  EXP_KEYS.forEach(k => { sums[k] = 0; });
  const rows = db.prepare('SELECT category, SUM(amount) AS s FROM expenses WHERE route_id = ? GROUP BY category').all(routeId);
  for (const r of rows) if (EXP_KEYS.includes(r.category)) sums[r.category] = round2(r.s);

  const setCols = EXP_KEYS.map(k => `${EXP_COL[k]} = @${EXP_COL[k]}`).join(', ');
  const p = { id: routeId, updated_at: Date.now() };
  EXP_KEYS.forEach(k => { p[EXP_COL[k]] = sums[k]; });
  db.prepare(`UPDATE routes SET ${setCols}, updated_at = @updated_at WHERE id = @id`).run(p);
  return sums;
}

/* 把某条路线的 9 类聚合金额转为「期初」流水（仅当该路线尚无任何流水）。
 * 期初流水 payer_id 为空、split_mode='none' → 只记金额、不参与 AA 结算
 * （历史数据无从得知付款人与分摊人，不应伪造）。 */
function createOpeningExpenses(row) {
  if (!row) return 0;
  if (db.prepare('SELECT 1 FROM expenses WHERE route_id = ? LIMIT 1').get(row.id)) return 0;
  const ins = db.prepare(`INSERT INTO expenses
      (id, route_id, owner_id, spent_on, category, amount, currency, title, note, payer_id, split_mode, is_opening, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,NULL,'none',1,?,?)`);
  const now = Date.now();
  let created = 0;
  for (const k of EXP_KEYS) {
    const v = round2(row[EXP_COL[k]]);
    if (v <= 0) continue;
    ins.run(uid('e'), row.id, row.owner_id, row.start_date || '', k, v, row.currency || 'CNY', '期初（历史数据）', '', now, now);
    created++;
  }
  return created;
}

/* 历史数据迁移（幂等）：把已有路线的 9 类聚合金额一次性转成期初流水。
 * 统一为流水口径后，9 类金额恒由流水派生，老数据不迁移就会显示为 0。
 * 重复启动不会重复插入（createOpeningExpenses 内部会检查是否已有流水）。 */
function migrateAggregatesToOpening() {
  const cols = EXP_KEYS.map(k => EXP_COL[k]).join(', ');
  const routes = db.prepare(`SELECT id, owner_id, currency, start_date, ${cols} FROM routes`).all();
  const tx = db.transaction(() => {
    let created = 0;
    for (const r of routes) {
      created += createOpeningExpenses(r);
      recomputeRouteAgg(r.id);
    }
    if (created) console.log(`[db] 已把历史 9 类金额转为期初流水 ${created} 笔（统一为流水口径）`);
  });
  tx();
}

/* 批量取分摊人（避免 N+1 查询） */
function partsFor(expenseIds) {
  const out = {};
  if (!expenseIds.length) return out;
  const ph = expenseIds.map(() => '?').join(',');
  db.prepare(`SELECT expense_id, traveler_id FROM expense_parts WHERE expense_id IN (${ph})`).all(...expenseIds)
    .forEach(r => { (out[r.expense_id] || (out[r.expense_id] = [])).push(r.traveler_id); });
  return out;
}

function expenseToJson(row, partsMap) {
  return {
    id: row.id, route_id: row.route_id,
    spent_on: row.spent_on || '',
    category: row.category,
    amount: round2(row.amount),
    currency: row.currency || 'CNY',
    title: row.title || '',
    note: row.note || '',
    payer_id: row.payer_id || null,
    split_mode: row.split_mode || 'equal',
    is_opening: !!row.is_opening,
    parts: (partsMap && partsMap[row.id]) || [],
    created_at: row.created_at, updated_at: row.updated_at
  };
}

/* ---------- 同行人 ---------- */
function listTravelers(routeId) {
  return db.prepare('SELECT id, route_id, name, is_self, sort_no, created_at FROM travelers WHERE route_id = ? ORDER BY sort_no ASC, created_at ASC')
    .all(routeId)
    .map(t => ({ id: t.id, route_id: t.route_id, name: t.name, is_self: !!t.is_self, sort_no: t.sort_no }));
}
function findTraveler(id, routeId) {
  return db.prepare('SELECT * FROM travelers WHERE id = ? AND route_id = ?').get(id, routeId) || null;
}
/* 批量新增（按名称去重，同一路线内不允许重名）
 * 若名单中尚无「本人」标记，把第一位新成员标记为 is_self —— 结算与卡片需要「我」这个主体，
 * 可由前端「设为我」改到其他人身上（同一路线内至多一人）。 */
function addTravelers(routeId, ownerId, names) {
  const cur = listTravelers(routeId);
  const exist = new Set(cur.map(t => t.name));
  let hasSelf = cur.some(t => t.is_self);
  let sortNo = cur.length;
  const now = Date.now();
  const created = [];
  const tx = db.transaction(() => {
    for (const raw of names) {
      const name = String(raw || '').trim();
      if (!name || exist.has(name)) continue;
      exist.add(name);
      const id = uid('t');
      const selfFlag = hasSelf ? 0 : 1;
      hasSelf = true;
      db.prepare('INSERT INTO travelers (id, route_id, owner_id, name, is_self, sort_no, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, routeId, ownerId, name, selfFlag, sortNo++, now);
      created.push(id);
    }
  });
  tx();
  return { created: created.length, list: listTravelers(routeId) };
}
function updateTraveler(id, routeId, data) {
  const cur = findTraveler(id, routeId);
  if (!cur) return null;
  const name = data.name === undefined ? cur.name : String(data.name || '').trim();
  if (!name) { const e = new Error('姓名不能为空'); e.code = 'INVALID_NAME'; throw e; }
  const dup = db.prepare('SELECT id FROM travelers WHERE route_id = ? AND name = ? AND id <> ?').get(routeId, name, id);
  if (dup) { const e = new Error('同名同行人已存在'); e.code = 'DUPLICATE_NAME'; throw e; }
  const sortNo = data.sort_no === undefined ? cur.sort_no : (parseInt(data.sort_no, 10) || 0);
  const selfFlag = data.is_self === undefined ? cur.is_self : (data.is_self ? 1 : 0);
  const tx = db.transaction(() => {
    db.prepare('UPDATE travelers SET name = ?, sort_no = ?, is_self = ? WHERE id = ? AND route_id = ?')
      .run(name, sortNo, selfFlag, id, routeId);
    /* 「本人」在一条路线内唯一：标记新的即清掉其余 */
    if (selfFlag) db.prepare('UPDATE travelers SET is_self = 0 WHERE route_id = ? AND id <> ?').run(routeId, id);
  });
  tx();
  return listTravelers(routeId).find(t => t.id === id);
}
/* 统计某同行人被流水引用的次数（作为付款人或分摊人） */
function travelerUsage(id) {
  const asPayer = db.prepare('SELECT COUNT(*) AS c FROM expenses WHERE payer_id = ?').get(id).c;
  const asPart = db.prepare('SELECT COUNT(*) AS c FROM expense_parts WHERE traveler_id = ?').get(id).c;
  return asPayer + asPart;
}
/* 删除同行人：默认拒绝（前端二次确认后带 force=1 重试）
 * force 时：其作为付款人的流水改为「未指定付款人」；其分摊关系移除（该笔退化为按剩余分摊人均分） */
function deleteTraveler(id, routeId, force) {
  const cur = findTraveler(id, routeId);
  if (!cur) return { ok: false, code: 'NOT_FOUND' };
  const affected = travelerUsage(id);
  if (affected > 0 && !force) return { ok: false, code: 'IN_USE', affected };
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM expense_parts WHERE traveler_id = ?').run(id);
    db.prepare('UPDATE expenses SET payer_id = NULL, updated_at = ? WHERE payer_id = ?').run(Date.now(), id);
    db.prepare('DELETE FROM travelers WHERE id = ? AND route_id = ?').run(id, routeId);
  });
  tx();
  return { ok: true, affected };
}

/* ---------- 流水 ---------- */
/* 校验：类目必须在 9 类内；付款人 / 分摊人必须属于本路线 */
function validateExpenseInput(routeId, data) {
  const category = String(data.category || '').trim();
  if (!EXP_KEYS.includes(category)) { const e = new Error('消费类目不正确'); e.code = 'INVALID_CATEGORY'; throw e; }
  const amount = num(data.amount);
  if (!(amount > 0)) { const e = new Error('金额必须大于 0'); e.code = 'INVALID_AMOUNT'; throw e; }
  const ids = new Set(listTravelers(routeId).map(t => t.id));
  const payerId = data.payer_id ? String(data.payer_id) : null;
  if (payerId && !ids.has(payerId)) { const e = new Error('付款人不在本路线的同行人名单中'); e.code = 'INVALID_PAYER'; throw e; }
  const rawParts = Array.isArray(data.parts) ? data.parts.map(String) : [];
  const parts = [...new Set(rawParts)];
  const bad = parts.find(p => !ids.has(p));
  if (bad) { const e = new Error('分摊人不在本路线的同行人名单中'); e.code = 'INVALID_PARTICIPANT'; throw e; }
  /* split_mode：由「是否有分摊人」推导，不接受前端任意指定 */
  const splitMode = parts.length ? 'equal' : 'none';
  const spentOn = String(data.spent_on || '').trim();
  if (spentOn && !/^\d{4}-\d{2}-\d{2}$/.test(spentOn)) { const e = new Error('消费日期格式应为 YYYY-MM-DD'); e.code = 'INVALID_DATE'; throw e; }
  return {
    category, amount: round2(amount),
    spent_on: spentOn,
    title: String(data.title || '').trim().slice(0, 200),
    note: String(data.note || '').trim().slice(0, 500),
    payer_id: payerId, split_mode: splitMode, parts
  };
}

function insertExpense(routeId, ownerId, data) {
  const v = validateExpenseInput(routeId, data);
  const route = db.prepare('SELECT currency FROM routes WHERE id = ?').get(routeId);
  const id = uid('e');
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO expenses (id, route_id, owner_id, spent_on, category, amount, currency, title, note, payer_id, split_mode, is_opening, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)`)
      .run(id, routeId, ownerId, v.spent_on, v.category, v.amount, (route && route.currency) || 'CNY', v.title, v.note, v.payer_id, v.split_mode, now, now);
    const insPart = db.prepare('INSERT INTO expense_parts (expense_id, traveler_id, weight) VALUES (?,?,1)');
    v.parts.forEach(p => insPart.run(id, p));
    recomputeRouteAgg(routeId);
  });
  tx();
  return getExpense(id, routeId);
}

function getExpense(id, routeId) {
  const row = db.prepare('SELECT * FROM expenses WHERE id = ? AND route_id = ?').get(id, routeId);
  if (!row) return null;
  return expenseToJson(row, partsFor([id]));
}

function updateExpense(id, routeId, data) {
  const cur = db.prepare('SELECT * FROM expenses WHERE id = ? AND route_id = ?').get(id, routeId);
  if (!cur) return null;
  /* 局部更新：未提交字段沿用现值，避免「不传即清空」 */
  const merged = {
    category: data.category === undefined ? cur.category : data.category,
    amount: data.amount === undefined ? cur.amount : data.amount,
    spent_on: data.spent_on === undefined ? (cur.spent_on || '') : data.spent_on,
    title: data.title === undefined ? cur.title : data.title,
    note: data.note === undefined ? cur.note : data.note,
    payer_id: data.payer_id === undefined ? cur.payer_id : data.payer_id,
    parts: data.parts === undefined ? (partsFor([id])[id] || []) : data.parts
  };
  const v = validateExpenseInput(routeId, merged);
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE expenses SET spent_on=?, category=?, amount=?, title=?, note=?, payer_id=?, split_mode=?, updated_at=? WHERE id=? AND route_id=?`)
      .run(v.spent_on, v.category, v.amount, v.title, v.note, v.payer_id, v.split_mode, now, id, routeId);
    db.prepare('DELETE FROM expense_parts WHERE expense_id = ?').run(id);
    const insPart = db.prepare('INSERT INTO expense_parts (expense_id, traveler_id, weight) VALUES (?,?,1)');
    v.parts.forEach(p => insPart.run(id, p));
    recomputeRouteAgg(routeId);
  });
  tx();
  return getExpense(id, routeId);
}

function deleteExpense(id, routeId) {
  const cur = db.prepare('SELECT id FROM expenses WHERE id = ? AND route_id = ?').get(id, routeId);
  if (!cur) return false;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM expenses WHERE id = ? AND route_id = ?').run(id, routeId);
    recomputeRouteAgg(routeId);
  });
  tx();
  return true;
}

function bulkDeleteExpenses(routeId, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
  if (!list.length) return 0;
  const ph = list.map(() => '?').join(',');
  const tx = db.transaction(() => {
    const r = db.prepare(`DELETE FROM expenses WHERE route_id = ? AND id IN (${ph})`).run(routeId, ...list);
    recomputeRouteAgg(routeId);
    return r.changes;
  });
  return tx();
}

function listExpenses(routeId, opts = {}) {
  const where = ['route_id = ?'];
  const args = [routeId];
  if (opts.category) { where.push('category = ?'); args.push(String(opts.category)); }
  if (opts.payer) { where.push('payer_id = ?'); args.push(String(opts.payer)); }
  if (opts.from) { where.push('spent_on >= ?'); args.push(String(opts.from)); }
  if (opts.to) { where.push('spent_on <= ?'); args.push(String(opts.to)); }
  const w = where.join(' AND ');

  const agg = db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM expenses WHERE ${w}`).get(...args);
  const byCategory = {};
  EXP_KEYS.forEach(k => { byCategory[k] = 0; });
  db.prepare(`SELECT category, COALESCE(SUM(amount),0) AS s FROM expenses WHERE ${w} GROUP BY category`).all(...args)
    .forEach(r => { byCategory[r.category] = round2(r.s); });

  const pageSize = Math.min(Math.max(parseInt(opts.pageSize, 10) || 200, 1), 500);
  const page = Math.max(parseInt(opts.page, 10) || 1, 1);
  const rows = db.prepare(`SELECT * FROM expenses WHERE ${w} ORDER BY spent_on DESC, created_at DESC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize);
  const partsMap = partsFor(rows.map(r => r.id));
  return {
    list: rows.map(r => expenseToJson(r, partsMap)),
    total: agg.c, amount: round2(agg.s), byCategory, page, pageSize
  };
}

/* ---------- AA 结算 ----------
 * 口径（保证 Σnet = 0，即「账恒平」）：
 *   · 无付款人的流水（期初历史数据 / 未指定付款人）→ 计入 unassigned，**整体不参与结算**
 *     （既不计实付、也不产生应分担），否则会出现负无穷的账目缺口
 *   · split_mode='none'（未选分摊人）→ 该笔由**付款人自己承担**（计入 self_borne），不产生债务
 *   · 其余按分摊人均分 → owed
 *   net = paid − (owed + self_borne)；>0 为应收（他人欠我），<0 为应付
 * 转账方案：按差额贪心配对，笔数 ≤ 人数 − 1
 * 精度：0.005 为冲抵阈值（半分），金额统一四舍五入到分 */
function settle(routeId) {
  const ts = listTravelers(routeId);
  const paid = {}, owed = {}, selfBorne = {};
  ts.forEach(t => { paid[t.id] = 0; owed[t.id] = 0; selfBorne[t.id] = 0; });

  const all = db.prepare('SELECT * FROM expenses WHERE route_id = ?').all(routeId);
  const partsMap = partsFor(all.map(e => e.id));
  let notSplit = 0, unassigned = 0;

  for (const e of all) {
    const a = num(e.amount);
    const byId = e.payer_id && paid[e.payer_id] !== undefined ? e.payer_id : null;
    /* 无付款人 → 无法归属，整体排除在结算之外 */
    if (!byId) { unassigned += a; continue; }
    paid[byId] += a;

    if (e.split_mode === 'none') { notSplit += a; selfBorne[byId] += a; continue; }
    const parts = (partsMap[e.id] || []).filter(id => owed[id] !== undefined);
    /* 分摊人为空（异常兜底）→ 视同自付，避免账目缺口 */
    const list = parts.length ? parts : null;
    if (!list) { notSplit += a; selfBorne[byId] += a; continue; }
    const per = a / list.length;
    list.forEach(id => { owed[id] += per; });
  }

  const rows = ts.map(t => {
    const burden = round2(owed[t.id] + selfBorne[t.id]);
    return {
      id: t.id, name: t.name, is_self: !!t.is_self,
      paid: round2(paid[t.id]),
      owed: burden,                    /* 该人实际负担（分摊份额 + 自付） */
      share: round2(owed[t.id]),       /* 其中：分摊份额 */
      self_borne: round2(selfBorne[t.id]),
      net: round2(paid[t.id] - burden)
    };
  });

  const creditors = rows.filter(r => r.net > 0.005).map(r => ({ id: r.id, name: r.name, v: r.net })).sort((a, b) => b.v - a.v);
  const debtors = rows.filter(r => r.net < -0.005).map(r => ({ id: r.id, name: r.name, v: -r.net })).sort((a, b) => b.v - a.v);
  const transfers = [];
  let i = 0, j = 0;
  while (i < creditors.length && j < debtors.length) {
    const m = Math.min(creditors[i].v, debtors[j].v);
    if (m > 0.005) {
      transfers.push({
        from: debtors[j].id, from_name: debtors[j].name,
        to: creditors[i].id, to_name: creditors[i].name,
        amount: round2(m)
      });
    }
    creditors[i].v -= m; debtors[j].v -= m;
    if (creditors[i].v < 0.005) i++;
    if (debtors[j].v < 0.005) j++;
  }

  return {
    rows, transfers,
    summary: {
      paid: round2(rows.reduce((s, r) => s + r.paid, 0)),
      owed: round2(rows.reduce((s, r) => s + r.owed, 0)),
      not_split: round2(notSplit),
      unassigned: round2(unassigned),
      expense_count: all.length,
      traveler_count: ts.length
    }
  };
}

/* 某路线的流水笔数与结算概览（列表页卡片用，避免逐条查询） */

module.exports = {
  initDb, get db() { return db; },
  EXP_KEYS, EXP_COL, num, scryptHash, uid,
  ROUTE_COLS,
  routeToJson, insertRoute, updateRoute, getRoute,
  getShareToken, setShareToken, clearShareToken, findRouteByShareToken,
  getAiConfig, saveAiConfig, getAiEnabledUserIds, isAiEnabledUser, setAiEnabledUsers,
  audit,
  /* 逐笔流水 + AA 分账 */
  recomputeRouteAgg, migrateAggregatesToOpening,
  listTravelers, findTraveler, addTravelers, updateTraveler, deleteTraveler, travelerUsage,
  insertExpense, updateExpense, deleteExpense, bulkDeleteExpenses, listExpenses, getExpense,
  settle,
  round2
};
