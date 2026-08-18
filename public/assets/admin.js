/* admin.js — 管理后台（总览/用户/邮件/站点/审计） */
import { store, toast, api, esc, fmt, fmtTime, addYen } from './api.js';

const NAV = [
  ['overview', '平台总览', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg>'],
  ['users', '用户管理', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>'],
  ['email', '邮件配置', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="M22 6l-10 7L2 6"/></svg>'],
  ['site', '站点设置', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'],
  ['audit', '审计日志', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>']
];

export function renderAdmin() {
  const seg = currentAdminSeg();
  const main = document.getElementById('view');
  main.innerHTML = `
    <div class="wrap">
      <div class="admin-layout">
        <div class="admin-nav">
          ${NAV.map(n => `<div class="anav ${seg === n[0] ? 'active' : ''}" data-aseg="${n[0]}">${n[1]}</div>`).join('')}
          <div class="anav" data-aseg="back" style="color:var(--muted)">← 返回工作台</div>
        </div>
        <div class="admin-content" id="adminContent"></div>
      </div>
    </div>`;
  document.querySelectorAll('[data-aseg]').forEach(el => {
    el.onclick = () => {
      if (el.dataset.aseg === 'back') { location.hash = '#/workbench'; return; }
      location.hash = '#/admin/' + el.dataset.aseg;
    };
  });
  loadAdminPage(seg);
}

function currentAdminSeg() {
  const m = location.hash.match(/#\/admin\/([a-z]+)/);
  return m ? m[1] : 'overview';
}

function loadAdminPage(seg) {
  const box = document.getElementById('adminContent');
  if (!box) return;
  if (seg === 'overview') renderOverview(box);
  else if (seg === 'users') renderUsers(box);
  else if (seg === 'email') renderEmail(box);
  else if (seg === 'site') renderSite(box);
  else if (seg === 'audit') renderAudit(box);
  else box.innerHTML = '<div class="empty">页面不存在</div>';
}

/* ---------- 总览 ---------- */
async function renderOverview(box) {
  box.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const d = await api.get('/admin/overview');
    const cards = [
      ['用户总数', d.userTotal], ['在线用户', d.onlineUsers], ['路线总数', d.routeTotal],
      ['近 7 日新增用户', '+' + d.user7], ['近 7 日新增路线', '+' + d.route7],
      ['近 30 日新增用户', '+' + d.user30], ['近 30 日新增路线', '+' + d.route30],
      ['数据库大小', (d.dbBytes / 1024).toFixed(1) + ' KB']
    ];
    box.innerHTML = `
      <h2>平台总览</h2>
      <div class="stat-cards">${cards.map(c => `<div class="stat"><div class="v">${c[1]}</div><div class="l">${c[0]}</div></div>`).join('')}</div>
      <div class="panel">
        <h3>快捷入口</h3>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-line" data-goto="users">用户管理</button>
          <button class="btn btn-line" data-goto="email">邮件配置</button>
          <button class="btn btn-line" data-goto="site">站点设置</button>
          <button class="btn btn-line" data-goto="audit">审计日志</button>
        </div>
      </div>`;
    box.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => { location.hash = '#/admin/' + b.dataset.goto; });
  } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

/* ---------- 用户管理 ---------- */
let userPage = 1;
async function renderUsers(box) {
  box.innerHTML = `<h2>用户管理</h2>
    <div class="toolbar">
      <div class="grow"><input id="u_q" placeholder="搜索用户名 / 邮箱"></div>
      <select id="u_status" style="width:auto"><option value="">全部状态</option><option value="active">正常</option><option value="banned">已封禁</option></select>
      <select id="u_role" style="width:auto"><option value="">全部角色</option><option value="admin">管理员</option><option value="user">普通用户</option></select>
      <button class="btn btn-line" id="u_search">查询</button>
    </div>
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>用户名</th><th>邮箱</th><th>角色</th><th>注册时间</th><th>在线</th><th>状态</th><th>路线数</th><th>操作</th></tr></thead>
      <tbody id="u_body"><tr><td colspan="8" class="empty">加载中…</td></tr></tbody>
    </table></div>
    <div class="pager" id="u_pager"></div>`;

  const search = async () => {
    const q = document.getElementById('u_q').value.trim();
    const status = document.getElementById('u_status').value;
    const role = document.getElementById('u_role').value;
    await loadUserPage(box, { q, status, role });
  };
  document.getElementById('u_search').onclick = () => { userPage = 1; search(); };
  document.getElementById('u_q').addEventListener('keydown', e => { if (e.key === 'Enter') { userPage = 1; search(); } });
  await search();
}

async function loadUserPage(box, filter) {
  const me = store.user;
  const qs = new URLSearchParams({ page: userPage, pageSize: 20 });
  if (filter.q) qs.set('q', filter.q);
  if (filter.status) qs.set('status', filter.status);
  if (filter.role) qs.set('role', filter.role);
  const body = document.getElementById('u_body');
  try {
    const d = await api.get('/admin/users?' + qs.toString());
    const totalPages = Math.max(1, Math.ceil(d.total / 20));
    if (!d.list.length) {
      body.innerHTML = '<tr><td colspan="8" class="empty">暂无用户</td></tr>';
    } else {
      body.innerHTML = d.list.map(u => `<tr>
        <td><strong>${esc(u.username || '—')}</strong>${u.id === me.id ? ' <span class="pill pill-ok">我</span>' : ''}</td>
        <td>${esc(u.email || '—')}</td>
        <td>${u.role === 'admin' ? '<span class="pill pill-admin">管理员</span>' : '<span class="pill pill-user">用户</span>'}</td>
        <td style="white-space:nowrap">${fmtTime(u.created_at).slice(0, 10)}</td>
        <td><span class="dot ${u.online ? 'on' : 'off'}"></span>${u.online ? '在线' : '离线'}</td>
        <td>${u.status === 'banned' ? '<span class="pill pill-ban">已封禁</span>' : '<span class="pill pill-ok">正常</span>'}</td>
        <td>${u.route_count}</td>
        <td><div class="ops">
          ${u.status === 'banned'
            ? `<button class="btn btn-sm btn-line" data-act="unban" data-id="${u.id}" data-name="${esc(u.username || u.email)}">解封</button>`
            : (u.id !== me.id && u.role !== 'admin' ? `<button class="btn btn-sm btn-danger" data-act="ban" data-id="${u.id}" data-name="${esc(u.username || u.email)}">禁止</button>` : '')}
          ${u.id !== me.id
            ? (u.role === 'admin'
              ? `<button class="btn btn-sm btn-line" data-act="degrade" data-id="${u.id}" data-name="${esc(u.username || u.email)}">取消管理员</button>`
              : `<button class="btn btn-sm btn-line" data-act="promote" data-id="${u.id}" data-name="${esc(u.username || u.email)}">设为管理员</button>`)
            : ''}
        </div></td></tr>`).join('');
    }
    const pager = document.getElementById('u_pager');
    pager.innerHTML = `<button class="btn btn-sm" ${userPage <= 1 ? 'disabled' : ''} id="u_prev">上一页</button>
      <span>${userPage} / ${totalPages}（共 ${d.total} 人）</span>
      <button class="btn btn-sm" ${userPage >= totalPages ? 'disabled' : ''} id="u_next">下一页</button>`;
    const pv = document.getElementById('u_prev');
    const nx = document.getElementById('u_next');
    if (pv) pv.onclick = () => { if (userPage > 1) { userPage--; loadUserPage(box, filter); } };
    if (nx) nx.onclick = () => { if (userPage < totalPages) { userPage++; loadUserPage(box, filter); } };
  } catch (e) {
    body.innerHTML = `<tr><td colspan="8" class="empty">${esc(e.message)}</td></tr>`;
  }
}

export async function handleUserAction(btn) {
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  const name = btn.dataset.name;
  const ip = '/admin/users/' + id + '/' + (act === 'ban' ? 'ban' : act === 'unban' ? 'unban' : 'role');
  if (act === 'ban') {
    if (!confirm(`确定禁止用户「${name}」？该用户将立即掉线且无法登录。`)) return;
  } else if (act === 'promote') {
    if (!confirm(`确定将「${name}」设为管理员？其将获得后台全部权限。`)) return;
  } else if (act === 'degrade') {
    if (!confirm(`确定取消「${name}」的管理员身份？`)) return;
  }
  try {
    await api.post(ip, act === 'promote' ? { role: 'admin' } : act === 'degrade' ? { role: 'user' } : undefined);
    toast(act === 'ban' ? '已封禁' : act === 'unban' ? '已解封' : act === 'promote' ? '已设为管理员' : '已取消管理员');
    renderAdmin();
  } catch (e) { toast(e.message); }
}

/* ---------- 邮件配置 ---------- */
async function renderEmail(box) {
  box.innerHTML = '<div class="empty">加载中…</div>';
  let cfg;
  try { cfg = await api.get('/admin/email-config'); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  box.innerHTML = `<h2>邮件服务器配置</h2>
    <div class="admin-form">
      <div class="form-row">
        <div class="field"><label>SMTP 主机</label><input id="m_host" value="${esc(cfg.smtp_host)}" placeholder="smtp.example.com"></div>
        <div class="field" style="flex:0 0 110px"><label>端口</label><input id="m_port" value="${cfg.smtp_port}" inputmode="numeric"></div>
      </div>
      <div class="field"><label>加密方式</label>
        <select id="m_secure">
          <option value="1" ${cfg.smtp_secure ? 'selected' : ''}>SSL/TLS（465）</option>
          <option value="0" ${!cfg.smtp_secure ? 'selected' : ''}>STARTTLS（587）</option>
        </select></div>
      <div class="form-row">
        <div class="field"><label>账号</label><input id="m_user" value="${esc(cfg.smtp_user)}"></div>
        <div class="field"><label>密码 <span class="hint">${cfg.smtp_pass ? '已设置，留空保持不变' : ''}</span></label>
          <input id="m_pass" type="password" placeholder="${cfg.smtp_pass ? '******' : 'SMTP 密码'}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>发件人名称</label><input id="m_from_name" value="${esc(cfg.from_name)}" placeholder="旅行经费工作台"></div>
        <div class="field"><label>发件人地址</label><input id="m_from_addr" value="${esc(cfg.from_address)}" placeholder="noreply@example.com"></div>
      </div>
      <div class="field"><label class="switch"><input type="checkbox" id="m_enabled" ${cfg.enabled ? 'checked' : ''}> 启用邮件发送（发送验证码）</label></div>
      <div class="auth-actions" style="flex-direction:row">
        <button class="btn btn-line" id="m_test">发送测试邮件</button>
        <button class="btn btn-primary" id="m_save">保存配置</button>
      </div>
    </div>`;
  document.getElementById('m_save').onclick = async () => {
    const body = {
      smtp_host: document.getElementById('m_host').value.trim(),
      smtp_port: parseInt(document.getElementById('m_port').value) || 465,
      smtp_secure: document.getElementById('m_secure').value === '1',
      smtp_user: document.getElementById('m_user').value.trim(),
      smtp_pass: document.getElementById('m_pass').value,
      from_name: document.getElementById('m_from_name').value.trim(),
      from_address: document.getElementById('m_from_addr').value.trim(),
      enabled: document.getElementById('m_enabled').checked
    };
    try { await api.put('/admin/email-config', body); toast('配置已保存'); } catch (e) { toast(e.message); }
  };
  document.getElementById('m_test').onclick = async () => {
    const btn = document.getElementById('m_test');
    btn.disabled = true;
    btn.textContent = '发送中…';
    try { await api.post('/admin/email-config/test'); toast('测试邮件发送成功'); }
    catch (e) { toast(e.message); }
    btn.disabled = false;
    btn.textContent = '发送测试邮件';
  };
}

/* ---------- 站点设置 ---------- */
async function renderSite(box) {
  box.innerHTML = '<div class="empty">加载中…</div>';
  let s;
  try { s = await api.get('/admin/site-settings'); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  box.innerHTML = `<h2>站点设置</h2>
    <div class="admin-form">
      <div class="field"><label>站点名称</label><input id="s_name" value="${esc(s.site_name)}"></div>
      <div class="field"><label class="switch"><input type="checkbox" id="s_reg" ${s.allow_register ? 'checked' : ''}> 开放注册</label>
        <div class="hint">关闭后注册入口隐藏，仅管理员可在后台处理</div></div>
      <div class="field"><label>注册方式</label>
        <select id="s_mode">
          <option value="all" ${s.register_mode === 'all' ? 'selected' : ''}>全部（邮箱 + 账户名）</option>
          <option value="email_only" ${s.register_mode === 'email_only' ? 'selected' : ''}>仅邮箱</option>
          <option value="username_only" ${s.register_mode === 'username_only' ? 'selected' : ''}>仅账户名</option>
        </select></div>
      <div class="field"><label>首页公告横幅 <span class="hint">留空不显示</span></label>
        <textarea id="s_announce" placeholder="欢迎使用…">${esc(s.announce_text)}</textarea></div>
      <div class="auth-actions">
        <button class="btn btn-primary btn-block" id="s_save">保存设置</button>
      </div>
    </div>`;
  document.getElementById('s_save').onclick = async () => {
    const body = {
      site_name: document.getElementById('s_name').value.trim() || '旅行经费工作台',
      allow_register: document.getElementById('s_reg').checked,
      register_mode: document.getElementById('s_mode').value,
      announce_text: document.getElementById('s_announce').value
    };
    try {
      await api.put('/admin/site-settings', body);
      Object.assign(store.site, body);
      toast('设置已保存');
    } catch (e) { toast(e.message); }
  };
}

/* ---------- 审计日志 ---------- */
let auditPage = 1;
async function renderAudit(box) {
  box.innerHTML = `<h2>操作审计日志</h2>
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>目标</th><th>详情</th><th>IP</th></tr></thead>
      <tbody id="a_body"><tr><td colspan="6" class="empty">加载中…</td></tr></tbody>
    </table></div>
    <div class="pager" id="a_pager"></div>`;
  await loadAuditPage();
}

async function loadAuditPage() {
  const body = document.getElementById('a_body');
  try {
    const d = await api.get('/admin/audit-logs?page=' + auditPage + '&pageSize=20');
    const totalPages = Math.max(1, Math.ceil(d.total / 20));
    if (!d.list.length) {
      body.innerHTML = '<tr><td colspan="6" class="empty">暂无审计记录</td></tr>';
    } else {
      body.innerHTML = d.list.map(l => `<tr>
        <td style="white-space:nowrap">${fmtTime(l.created_at)}</td>
        <td>${esc(l.actor)}</td>
        <td><span class="pill pill-admin">${esc(l.action)}</span></td>
        <td>${esc(l.target_type || '—')}</td>
        <td>${esc(l.detail || '—')}</td>
        <td class="mono">${esc(l.ip || '—')}</td></tr>`).join('');
    }
    const pager = document.getElementById('a_pager');
    pager.innerHTML = `<button class="btn btn-sm" ${auditPage <= 1 ? 'disabled' : ''} id="a_prev">上一页</button>
      <span>${auditPage} / ${totalPages}（共 ${d.total} 条）</span>
      <button class="btn btn-sm" ${auditPage >= totalPages ? 'disabled' : ''} id="a_next">下一页</button>`;
    const pv = document.getElementById('a_prev');
    const nx = document.getElementById('a_next');
    if (pv) pv.onclick = () => { if (auditPage > 1) { auditPage--; loadAuditPage(); } };
    if (nx) nx.onclick = () => { if (auditPage < totalPages) { auditPage++; loadAuditPage(); } };
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" class="empty">${esc(e.message)}</td></tr>`;
  }
}

/* 页面级事件委托（用户管理表格操作按钮） */
export function bindAdminEvents() {
  const view = document.getElementById('view');
  view.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn && ['ban', 'unban', 'promote', 'degrade'].includes(btn.dataset.act)) {
      handleUserAction(btn);
    }
  });
}
