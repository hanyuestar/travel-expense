/* api.js — fetch 封装 + 全局状态 + toast + 路由工具（ES Module） */
export const store = {
  user: null,      // GET /api/auth/me 结果
  site: { site_name: '旅行经费工作台', allow_register: true, register_mode: 'all', announce_text: '' },
  hideSeed: localStorage.getItem('te_hide_seed') === '1'
};

export function toast(msg, ms = 2200) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

async function request(method, path, body) {
  const opt = { method, credentials: 'same-origin' };
  if (body !== undefined) {
    opt.headers = { 'Content-Type': 'application/json' };
    opt.body = JSON.stringify(body);
  }
  const r = await fetch('/api' + path, opt);
  let data = null;
  try { data = await r.json(); } catch (e) { /* empty */ }
  if (!r.ok) {
    const err = new Error((data && data.msg) || ('请求失败 (' + r.status + ')'));
    err.status = r.status;
    err.code = data && data.code;
    throw err;
  }
  return data ? data.data : null;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  del: (p) => request('DELETE', p)
};

/* 站点信息（公开接口，未登录也可拉；失败静默） */
export async function loadSite() {
  try {
    const s = await api.get('/public/site') || {};
    Object.assign(store.site, s);
  } catch (e) { /* ignore */ }
}

/* 拉取当前用户；失败返回 null */
export async function fetchMe() {
  try {
    store.user = await api.get('/auth/me');
    return store.user;
  } catch (e) {
    store.user = null;
    return null;
  }
}

/* 登录 / 登出后的状态同步 */
export function applyAuth(user) {
  store.user = user;
  renderHeader();
}

export function renderHeader() {
  const u = store.user;
  const box = document.getElementById('userArea');
  const guest = document.getElementById('guestArea');
  if (!box || !guest) return;
  if (u) {
    box.classList.remove('hidden');
    guest.classList.add('hidden');
    const name = u.username || u.email || ('#' + u.id);
    document.getElementById('userName').textContent = name;
    const adminLink = document.getElementById('adminLink');
    if (adminLink) adminLink.style.display = u.role === 'admin' ? '' : 'none';
  } else {
    box.classList.add('hidden');
    guest.classList.remove('hidden');
  }
}

/* ---------- 路由 ---------- */
export function navigate(hash) {
  location.hash = hash;
}
export function currentRoute() {
  const h = (location.hash || '#/workbench').slice(1);
  return h || '/workbench';
}
export function esc(s) {
  return (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
export function fmt(n) {
  n = Math.round((n || 0) * 100) / 100;
  return n.toLocaleString('zh-CN');
}
export function addYen(n) { return '¥' + fmt(n); }
export function parseStart(dr, year) {
  if (!dr) return null;
  let m = dr.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = dr.match(/(\d{1,2})[\/\-.](\d{1,2})/);
  if (m && year) return new Date(+year, +m[1] - 1, +m[2]);
  return null;
}
export function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
