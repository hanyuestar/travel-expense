/* api.js — fetch 封装 + 全局状态 + toast + 路由工具（ES Module） */
export const store = {
  user: null,      // GET /api/auth/me 结果
  site: { site_name: '旅行经费工作台', allow_register: true, register_mode: 'all', announce_text: '', home_currency: 'CNY', fx_rates: { CNY: 1 } },
  hideSeed: localStorage.getItem('te_hide_seed') === '1'
};

/* 把金额从 cur 换算到本位币（用公开汇率表，离线可用） */
export function toHome(amount, cur) {
  const rates = store.site.fx_rates || { CNY: 1 };
  const home = store.site.home_currency || 'CNY';
  const rf = rates[(cur || 'CNY').toUpperCase()];
  const rt = rates[home.toUpperCase()];
  const v = parseFloat(amount) || 0;
  if (!rf || !rt) return v; // 未知币种不换算
  return v * rf / rt;
}

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

/* 客户端可连接任意自托管服务器：
 * - 优先用用户手动配置的地址（localStorage te_server_url，对应「切换服务器」）；
 * - 其次用打包时内置的服务器地址（window.TE_BUILTIN_SERVER，仅安卓 APK 注入）；
 * - 都为空且当前在浏览器（非 Capacitor/WebView）环境下，自动使用页面 origin 作为同源服务器地址；
 * - Capacitor/APK 环境下无前两项则保持为空，进入 setup 由用户输入。 */
const BUILTIN_SERVER_URL = (typeof window !== 'undefined' && window.TE_BUILTIN_SERVER)
  ? String(window.TE_BUILTIN_SERVER).replace(/\/+$/, '') : '';
export const HAS_BUILTIN_SERVER = !!BUILTIN_SERVER_URL;

function isBrowserOrigin() {
  if (typeof window === 'undefined' || !window.location) return false;
  if (window.Capacitor || window.CapacitorNative || window.__CAPACITOR__) return false;
  const proto = window.location.protocol;
  return proto === 'http:' || proto === 'https:';
}

function getDefaultServerUrl() {
  if (!isBrowserOrigin()) return '';
  return (window.location.origin || '').replace(/\/+$/, '');
}

export function getServerUrl() {
  return (localStorage.getItem('te_server_url') || BUILTIN_SERVER_URL || getDefaultServerUrl() || '').replace(/\/+$/, '');
}
export function setServerUrl(u) { if (u) localStorage.setItem('te_server_url', u.replace(/\/+$/, '')); else localStorage.removeItem('te_server_url'); }

async function request(method, path, body) {
  const opt = { method, credentials: 'include', mode: 'cors' };
  if (body !== undefined) {
    opt.headers = { 'Content-Type': 'application/json' };
    opt.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(getServerUrl() + '/api' + path, opt);
  } catch (e) {
    /* 移动网络/证书/代理异常时 fetch 抛 TypeError（消息常为 Failed to fetch），提示不友好 */
    const isNetwork = !e.status && (e.name === 'TypeError' || /failed to fetch|network|net::err/i.test(e.message));
    const msg = isNetwork
      ? '网络连接失败，请检查网络或该站点证书是否受信任'
      : (e.message || '请求失败');
    const err = new Error(msg);
    err.network = isNetwork;
    err.original = e;
    throw err;
  }
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
  if (!box) return;
  if (u) {
    box.classList.remove('hidden');
    const name = u.username || u.email || ('#' + u.id);
    document.getElementById('userName').textContent = name;
    const adminLink = document.getElementById('adminLink');
    if (adminLink) adminLink.style.display = u.role === 'admin' ? '' : 'none';
    /* 菜单头部：用户名 + 角色徽章 */
    const headName = document.getElementById('menuHeadName');
    if (headName) headName.textContent = name;
    const headRole = document.getElementById('menuHeadRole');
    if (headRole) headRole.textContent = u.role === 'admin' ? '管理员' : '用户';
  } else {
    box.classList.add('hidden');
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

/* 币种符号表（常用），JPY 用 JP¥ 区分 CNY 的 ¥；未知币种回退代码本身 */
const CUR_SYMBOLS = { CNY: '¥', HKD: 'HK$', MOP: 'MOP$', TWD: 'NT$', USD: '$', EUR: '€', GBP: '£', JPY: 'JP¥', KRW: '₩', THB: '฿', SGD: 'S$', AUD: 'A$', CAD: 'C$', NZD: 'NZ$', CHF: 'Fr', MYR: 'RM', IDR: 'Rp', PHP: '₱', VND: '₫', INR: '₹', RUB: '₽' };
export function curSymbol(c) { return CUR_SYMBOLS[(c || 'CNY').toUpperCase()] || (c || 'CNY'); }
export function fmtMoney(n, cur) { return curSymbol(cur) + fmt(n); }
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
