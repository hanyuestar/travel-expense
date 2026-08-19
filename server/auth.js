/* 认证与授权：注册（邮箱/账户名）、登录（三方式）、会话、封禁、改密
 * 依赖 db.js / http.js / mailer.js / config.js */
'use strict';
const crypto = require('crypto');
const config = require('./config');
const { fail, ok, created, parseCookies } = require('./http');
const mailer = require('./mailer');
const dbModule = require('./db');

const db = () => dbModule.db;

/* ---------- 密码 ---------- */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const h = Buffer.from(hash, 'hex');
  const t = Buffer.from(hashPassword(password, salt), 'hex');
  return h.length === t.length && crypto.timingSafeEqual(h, t);
}

/* ---------- 工具 ---------- */
function genCode() {
  // 验证码必须用密码学安全随机源，杜绝 Math.random 可预测性
  return String(crypto.randomInt(0, Math.pow(10, config.CODE_DIGITS))).padStart(config.CODE_DIGITS, '0');
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(u) {
  return {
    id: u.id, username: u.username, email: u.email, role: u.role,
    status: u.status, email_verified: !!u.email_verified,
    force_reset: !!u.force_reset, created_at: u.created_at
  };
}

/* 简单内存限流：key -> {count, resetAt}（进程内即可，重启清零） */
const rateBuckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + windowMs }; rateBuckets.set(key, b); }
  b.count += 1;
  return b.count <= limit;
}

/* ---------- 会话 ---------- */
function createSession(userId, ip, ua) {
  const now = Date.now();
  const sid = crypto.randomBytes(32).toString('hex');
  db().prepare('INSERT INTO sessions (id, user_id, created_at, last_active_at, ip, ua) VALUES (?,?,?,?,?,?)')
    .run(sid, userId, now, now, ip || null, ua || null);
  return sid;
}
function deleteSession(sid) {
  if (sid) db().prepare('DELETE FROM sessions WHERE id = ?').run(sid);
}
function touchSession(sid) {
  if (sid) db().prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(Date.now(), sid);
}
function setCookie(res, sid, maxAgeMs) {
  const secure = config.COOKIE_SECURE ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.round(maxAgeMs / 1000)}${secure}`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

/* 读取会话并返回用户；失败返回 null（不抛错） */
function authFromReq(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const s = db().prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  if (!s) return null;
  const u = db().prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  if (!u || u.status !== 'active') return null;
  touchSession(sid);
  req._sid = sid;
  req.user = u;
  return u;
}

/* ---------- 校验码 ---------- */
function issueCode(email, purpose) {
  const now = Date.now();
  // 清理该邮箱旧码（未消费的作废）
  db().prepare('UPDATE verification_codes SET consumed = 1 WHERE email = ? AND purpose = ? AND consumed = 0').run(email, purpose);
  const code = genCode();
  db().prepare('INSERT INTO verification_codes (email, purpose, code, expires_at, consumed, created_at) VALUES (?,?,?,?,0,?)')
    .run(email, purpose, code, now + config.CODE_TTL_MS, now);
  return code;
}
function consumeCode(email, purpose, code) {
  const row = db().prepare(
    'SELECT * FROM verification_codes WHERE email = ? AND purpose = ? AND code = ? AND consumed = 0 ORDER BY id DESC LIMIT 1')
    .get(email, purpose, String(code).trim());
  if (!row) return false;
  if (row.expires_at < Date.now()) return false;
  db().prepare('UPDATE verification_codes SET consumed = 1 WHERE id = ?').run(row.id);
  return true;
}

/* ---------- 路由 ---------- */
async function handle(req, res, url, body) {
  const { pathname, query } = url;
  const p = pathname.slice('/api/auth/'.length);

  switch (p) {
    /* 发送验证码 */
    case 'send-code': {
      if (req.method !== 'POST') return fail(res, 405, '方法不允许');
      const email = String((body.email || '').trim());
      if (!EMAIL_RE.test(email)) return fail(res, 400, '邮箱格式不正确');
      const purpose = body.purpose === 'login' ? 'login' : 'register';
      if (purpose === 'register') {
        const dup = db().prepare('SELECT id FROM users WHERE email = ?').get(email);
        if (dup) return fail(res, 409, '该邮箱已被使用', { code: 'EMAIL_TAKEN' });
      } else {
        const u = db().prepare('SELECT id FROM users WHERE email = ?').get(email);
        if (!u) return fail(res, 400, '该邮箱未注册');
      }
      const ip = req.socket.remoteAddress || '';
      if (!rateLimit('sendcode:' + ip, config.RATE_LIMIT.sendCode, config.RATE_LIMIT.windowMs)) {
        return fail(res, 429, '发送过于频繁，请稍后再试');
      }
      const mailCfg = db().prepare('SELECT * FROM email_config WHERE id = 1').get() || {};
      if (!mailCfg.enabled || !mailCfg.smtp_host) {
        return fail(res, 400, '邮件服务未配置', { code: 'MAIL_DISABLED' });
      }
      const code = issueCode(email, purpose);
      try {
        await mailer.sendVerificationCode(email, code, purpose);
      } catch (e) {
        return fail(res, 400, '邮件发送失败：' + e.message, { code: 'MAIL_ERROR' });
      }
      return ok(res, { sent: true, ttl: Math.round(config.CODE_TTL_MS / 60000) });
    }

    /* 防呆查重 */
    case 'check-exists': {
      const out = {};
      const email = String((body.email || '').trim());
      if (email) {
        if (!EMAIL_RE.test(email)) return fail(res, 400, '邮箱格式不正确');
        out.email = !!db().prepare('SELECT id FROM users WHERE email = ?').get(email);
      }
      const username = String((body.username || '').trim());
      if (username) out.username = !!db().prepare('SELECT id FROM users WHERE username = ?').get(username);
      return ok(res, out);
    }

    /* 注册 */
    case 'register': {
      if (req.method !== 'POST') return fail(res, 405, '方法不允许');
      const email = String((body.email || '').trim());
      const username = String((body.username || '').trim());
      const password = String(body.password || '');
      const code = String((body.code || '').trim());

      const settings = db().prepare('SELECT * FROM site_settings WHERE id = 1').get();
      if (settings && !settings.allow_register) return fail(res, 403, '注册已关闭，请联系管理员');
      const mode = (settings && settings.register_mode) || 'all';
      if (mode === 'email_only' && !email) return fail(res, 400, '当前仅支持邮箱注册');
      if (mode === 'username_only' && !username) return fail(res, 400, '当前仅支持账户名注册');
      if (!email && !username) return fail(res, 400, '邮箱或账户名至少填一个');
      if (!password) return fail(res, 400, '请设置密码');

      if (email) {
        if (!EMAIL_RE.test(email)) return fail(res, 400, '邮箱格式不正确');
        if (db().prepare('SELECT id FROM users WHERE email = ?').get(email)) {
          return fail(res, 409, '该邮箱已被使用', { code: 'EMAIL_TAKEN' });
        }
        if (!consumeCode(email, 'register', code)) {
          return fail(res, 400, '验证码错误或已过期', { code: 'CODE_INVALID' });
        }
      }
      let finalName = username;
      if (!finalName && email) {
        finalName = email.split('@')[0].replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '') || 'user';
        if (db().prepare('SELECT id FROM users WHERE username = ?').get(finalName)) {
          finalName = finalName + '_' + crypto.randomBytes(2).toString('hex');
        }
      }
      if (finalName && db().prepare('SELECT id FROM users WHERE username = ?').get(finalName)) {
        return fail(res, 409, '该账户名已被使用', { code: 'USERNAME_TAKEN' });
      }

      const now = Date.now();
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(password, salt);
      const info = db().prepare(
        'INSERT INTO users (username, email, password_hash, password_salt, role, status, email_verified, force_reset, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)')
        .run(finalName || null, email || null, hash, salt, 'user', 'active', email ? 1 : 0, now, now);
      const userId = info.lastInsertRowid;
      const sid = createSession(userId, req.socket.remoteAddress, req.headers['user-agent']);
      setCookie(res, sid, config.SESSION_TTL_MS);
      const u = db().prepare('SELECT * FROM users WHERE id = ?').get(userId);
      return created(res, publicUser(u));
    }

    /* 登录：{login, password?|code?} */
    case 'login': {
      if (req.method !== 'POST') return fail(res, 405, '方法不允许');
      const login = String((body.login || '').trim());
      const password = String(body.password || '');
      const code = String((body.code || '').trim());
      if (!login) return fail(res, 400, '请输入登录名');
      const ip = req.socket.remoteAddress || '';
      if (!rateLimit('login:' + ip + ':' + login, config.RATE_LIMIT.login, config.RATE_LIMIT.windowMs)) {
        return fail(res, 429, '尝试次数过多，请 10 分钟后再试');
      }

      let user = db().prepare('SELECT * FROM users WHERE username = ?').get(login)
        || db().prepare('SELECT * FROM users WHERE email = ?').get(login);
      if (!user) return fail(res, 401, '账号或密码错误', { code: 'INVALID_CREDENTIAL' });
      if (user.status === 'banned') return fail(res, 403, '禁止用户登录', { code: 'BANNED' });

      let credentialOk = false;
      if (code) {
        credentialOk = consumeCode(user.email || '', 'login', code);
      } else {
        credentialOk = verifyPassword(password, user.password_salt, user.password_hash);
      }
      if (!credentialOk) return fail(res, 401, '账号或密码错误', { code: 'INVALID_CREDENTIAL' });

      const sid = createSession(user.id, ip, req.headers['user-agent']);
      setCookie(res, sid, config.SESSION_TTL_MS);
      if (user.role === 'admin') {
        db().prepare('INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail, ip, created_at) VALUES (?,?,?,?,?,?,?)')
          .run(user.id, 'admin_login', 'user', String(user.id), user.username, ip, Date.now());
      }
      return ok(res, publicUser(user));
    }

    /* 登出 */
    case 'logout': {
      const sid = parseCookies(req).sid;
      deleteSession(sid);
      clearCookie(res);
      return ok(res, true);
    }

    /* 当前用户 */
    case 'me': {
      const u = authFromReq(req);
      if (!u) return fail(res, 401, '请先登录', { code: 'UNAUTHORIZED' });
      return ok(res, publicUser(u));
    }

    /* 改密 */
    case 'password': {
      if (req.method !== 'POST') return fail(res, 405, '方法不允许');
      const u = authFromReq(req);
      if (!u) return fail(res, 401, '请先登录', { code: 'UNAUTHORIZED' });
      const oldPassword = String(body.oldPassword || '');
      const newPassword = String(body.newPassword || '');
      if (newPassword.length < 8) return fail(res, 400, '新密码至少 8 位');
      if (!verifyPassword(oldPassword, u.password_salt, u.password_hash)) {
        return fail(res, 400, '原密码不正确');
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(newPassword, salt);
      db().prepare('UPDATE users SET password_hash = ?, password_salt = ?, force_reset = 0, updated_at = ? WHERE id = ?')
        .run(hash, salt, Date.now(), u.id);
      return ok(res, true);
    }

    default:
      return fail(res, 404, '接口不存在');
  }
}

module.exports = { handle, authFromReq, publicUser, hashPassword, verifyPassword, createSession, deleteSession, clearCookie };
