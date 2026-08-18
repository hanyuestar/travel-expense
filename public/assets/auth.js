/* auth.js — 登录 / 注册页（hash 路由 #/login #/register） */
import { store, toast, api, navigate, applyAuth, esc, loadSite } from './api.js';

let mode = 'password';   // 登录：password | code
let regMode = 'email';   // 注册：email | username
let countdown = 0;

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg>';

export function renderLogin() {
  const siteName = store.site.site_name || '旅行经费工作台';
  const allowReg = store.site.allow_register !== false;
  document.getElementById('view').innerHTML = `
  <div class="auth-wrap">
    <div class="auth-card">
      <div class="auth-logo">${ICON}${esc(siteName)}</div>
      <div class="auth-sub">管理历年出行路线与花费 · 数据存于你自己的服务器</div>
      <div class="tabs">
        <div class="tab ${mode === 'password' ? 'active' : ''}" data-login-mode="password">账号密码</div>
        <div class="tab ${mode === 'code' ? 'active' : ''}" data-login-mode="code">邮箱验证码</div>
      </div>
      <div class="field"><label>${mode === 'code' ? '邮箱' : '登录名（用户名或邮箱）'}</label>
        <input id="lg_login" placeholder="${mode === 'code' ? 'you@example.com' : '用户名 / 邮箱'}"></div>
      <div id="lgCodeRow" class="field ${mode === 'code' ? '' : 'hidden'}">
        <label>验证码</label>
        <div class="code-row">
          <input class="grow" id="lg_code" placeholder="6 位数字" inputmode="numeric" maxlength="6">
          <button class="btn btn-line" id="lg_send" type="button">获取验证码</button>
        </div>
      </div>
      <div id="lgPwRow" class="field ${mode === 'password' ? '' : 'hidden'}"><label>密码</label>
        <input id="lg_password" type="password" placeholder="请输入密码"></div>
      <div class="auth-actions">
        <button class="btn btn-primary btn-block" id="lg_submit">登 录</button>
      </div>
      <div class="auth-foot">${allowReg ? '<a href="#/register">还没有账号？去注册</a>' : '注册已关闭，请联系管理员'}</div>
      <div class="auth-copy">© Kyson · 开源自托管</div>
    </div>
  </div>`;

  document.querySelectorAll('[data-login-mode]').forEach(t => {
    t.onclick = () => { mode = t.dataset.loginMode; renderLogin(); };
  });
  document.getElementById('lg_send').onclick = () => sendCode('login');
  document.getElementById('lg_submit').onclick = doLogin;
  bindEnter(['lg_login', 'lg_password', 'lg_code'], doLogin);
}

export function renderRegister() {
  const siteName = store.site.site_name || '旅行经费工作台';
  const mode2 = store.site.register_mode || 'all';
  document.getElementById('view').innerHTML = `
  <div class="auth-wrap">
    <div class="auth-card">
      <div class="auth-logo">${ICON}${esc(siteName)}</div>
      <div class="auth-sub">创建账号 · 你的数据仅自己可见</div>
      <div class="tabs">
        <div class="tab ${regMode === 'email' ? 'active' : ''}" data-reg-mode="email">邮箱注册</div>
        <div class="tab ${regMode === 'username' ? 'active' : ''}" data-reg-mode="username">账户名注册</div>
      </div>
      <div id="regEmailRow" class="field ${regMode === 'email' ? '' : 'hidden'}">
        <label>邮箱</label>
        <input id="rg_email" placeholder="you@example.com">
        <div class="hint" id="rg_email_hint"></div>
      </div>
      <div id="regNameRow" class="field">
        <label>${regMode === 'email' ? '用户名（选填）' : '用户名'}</label>
        <input id="rg_username" placeholder="${regMode === 'email' ? '留空将用邮箱前缀自动生成' : '登录用的账户名'}">
        <div class="hint" id="rg_name_hint"></div>
      </div>
      <div id="regCodeRow" class="field ${regMode === 'email' ? '' : 'hidden'}">
        <label>邮箱验证码</label>
        <div class="code-row">
          <input class="grow" id="rg_code" placeholder="6 位数字" inputmode="numeric" maxlength="6">
          <button class="btn btn-line" id="rg_send" type="button">获取验证码</button>
        </div>
      </div>
      <div class="field"><label>密码（至少 8 位）</label>
        <input id="rg_password" type="password" placeholder="设置登录密码"></div>
      <div class="auth-actions">
        <button class="btn btn-primary btn-block" id="rg_submit">注 册</button>
      </div>
      <div class="auth-foot"><a href="#/login">已有账号？去登录</a></div>
      <div class="auth-copy">© Kyson · 开源自托管</div>
    </div>
  </div>`;

  document.querySelectorAll('[data-reg-mode]').forEach(t => {
    t.onclick = () => {
      regMode = t.dataset.regMode;
      if (mode2 === 'email_only') regMode = 'email';
      if (mode2 === 'username_only') regMode = 'username';
      renderRegister();
    };
  });
  document.getElementById('rg_send').onclick = () => sendCode('register');
  document.getElementById('rg_submit').onclick = doRegister;
  bindEnter(['rg_email', 'rg_username', 'rg_code', 'rg_password'], doRegister);

  /* 失焦防呆查重 */
  const email = document.getElementById('rg_email');
  const username = document.getElementById('rg_username');
  const emailHint = document.getElementById('rg_email_hint');
  const nameHint = document.getElementById('rg_name_hint');
  if (email) email.onblur = async () => {
    const v = email.value.trim();
    if (!v) return;
    try { const r = await api.post('/auth/check-exists', { email: v }); emailHint.textContent = r.email ? '该邮箱已被使用' : ''; } catch (e) { /* ignore */ }
  };
  username.onblur = async () => {
    const v = username.value.trim();
    if (!v) return;
    try { const r = await api.post('/auth/check-exists', { username: v }); nameHint.textContent = r.username ? '该账户名已被使用' : ''; } catch (e) { /* ignore */ }
  };
}

/* ---------- 验证码 ---------- */
async function sendCode(purpose) {
  const email = (document.getElementById(purpose === 'login' ? 'lg_login' : 'rg_email').value || '').trim();
  if (!email) { toast('请先填写邮箱'); return; }
  const btn = document.getElementById(purpose === 'login' ? 'lg_send' : 'rg_send');
  try {
    await api.post('/auth/send-code', { email, purpose });
    toast('验证码已发送，5 分钟内有效');
    countdown = 60;
    btn.disabled = true;
    const t = setInterval(() => {
      countdown -= 1;
      btn.textContent = countdown > 0 ? countdown + 's 后重发' : '获取验证码';
      if (countdown <= 0) { btn.disabled = false; clearInterval(t); }
    }, 1000);
  } catch (e) {
    toast(e.message);
  }
}

/* ---------- 登录 ---------- */
async function doLogin() {
  const login = document.getElementById('lg_login').value.trim();
  if (!login) { toast('请输入登录名'); return; }
  const code = document.getElementById('lg_code').value.trim();
  const password = document.getElementById('lg_password').value;
  if (mode === 'code' && !code) { toast('请输入验证码'); return; }
  if (mode === 'password' && !password) { toast('请输入密码'); return; }
  const body = mode === 'code' ? { login, code } : { login, password };
  try {
    const u = await api.post('/auth/login', body);
    applyAuth(u);
    toast('登录成功');
    if (u.force_reset) navigate('/profile?reset=1');
    else navigate('/workbench');
  } catch (e) {
    toast(e.message);
  }
}

/* ---------- 注册 ---------- */
async function doRegister() {
  const email = (document.getElementById('rg_email').value || '').trim();
  const username = (document.getElementById('rg_username').value || '').trim();
  const password = document.getElementById('rg_password').value;
  const code = (document.getElementById('rg_code').value || '').trim();
  if (password.length < 8) { toast('密码至少 8 位'); return; }
  const mode2 = store.site.register_mode || 'all';
  const body = { password };
  if (regMode === 'email' || mode2 === 'email_only') {
    if (!email) { toast('请填写邮箱'); return; }
    body.email = email;
    if (!code) { toast('请输入邮箱验证码'); return; }
    body.code = code;
    if (username) body.username = username;
  } else {
    if (!username) { toast('请填写用户名'); return; }
    body.username = username;
    if (email) body.email = email;
  }
  try {
    const u = await api.post('/auth/register', body);
    applyAuth(u);
    toast('注册成功，欢迎使用！');
    navigate('/workbench');
  } catch (e) {
    toast(e.message);
  }
}

function bindEnter(ids, fn) {
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') fn(); });
  });
}

export async function initAuth() {
  await loadSite();
}
