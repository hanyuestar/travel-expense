/* app.js — 工作台（路线列表 + 年度统计 + 路线表单 + 个人中心） */
import { store, toast, api, navigate, esc, fmt, addYen, parseStart, fmtTime } from './api.js';
import { CATS, COLORS, totalOf, donut, trendBar } from './charts.js';

let routes = [];
let state = { filterYear: 'all', search: '', curId: null, detailId: null };

export function refreshRoutes() {
  const qs = new URLSearchParams();
  if (store.hideSeed) qs.set('hideSeed', '1');
  return api.get('/routes' + (qs.toString() ? '?' + qs.toString() : ''));
}

export async function loadRoutes() {
  try {
    routes = await refreshRoutes();
  } catch (e) {
    if (e.status === 401) { navigate('/login'); return; }
    toast(e.message);
    routes = [];
  }
}

export function getRoutes() { return routes; }

/* ---------- 工作台 ---------- */
export function renderWorkbench() {
  const siteName = store.site.site_name || '旅行经费工作台';
  const banner = store.site.announce_text;
  const curYear = new Date().getFullYear();
  document.getElementById('view').innerHTML = `
    ${banner ? `<div class="banner">${esc(banner)}</div>` : ''}
    <nav class="toolbar">
      <div class="chip-row" style="flex:1;min-width:100%">
        <div class="chip ${state.filterYear === 'all' ? 'active' : ''}" data-fy="all">全部</div>
        ${years().map(y => `<div class="chip ${state.filterYear === y ? 'active' : ''}" data-fy="${y}">${y}</div>`).join('')}
      </div>
    </nav>
    <div class="toolbar">
      <div class="grow"><input id="search" placeholder="搜索目的地 / 路线名…" value="${esc(state.search)}"></div>
      <label class="switch" style="font-size:13px;color:var(--muted)"><input type="checkbox" id="hideSeedCb" ${store.hideSeed ? 'checked' : ''}> 隐藏系统示例</label>
      <button class="btn btn-primary" id="newRouteBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>新增路线</button>
    </div>
    <div class="grid" id="routeGrid"></div>
    <div style="height:16px"></div>
    <div class="flex2">
      <div class="panel">
        <h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" stroke-linejoin="round"/></svg>花费分类占比</h3>
        <div id="catChart"></div>
        <div class="legend" id="catLegend"></div>
      </div>
      <div class="panel">
        <h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 9l-5 5-3-3-3 3"/></svg>逐年花费趋势</h3>
        <div id="trendChart"></div>
      </div>
    </div>
    <div class="panel">
      <h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M3 12h18M3 6h18M3 18h18"/></svg>各年明细</h3>
      <div id="yearTable"></div>
    </div>`;

  document.getElementById('search').oninput = e => { state.search = e.target.value; renderRoutes(); };
  document.getElementById('hideSeedCb').onchange = e => {
    store.hideSeed = e.target.checked;
    localStorage.setItem('te_hide_seed', store.hideSeed ? '1' : '0');
    loadRoutes().then(renderRoutes);
  };
  document.getElementById('newRouteBtn').onclick = () => openForm(null);
  document.querySelectorAll('[data-fy]').forEach(c => {
    c.onclick = () => { state.filterYear = c.dataset.fy; renderRoutes(); };
  });
  document.getElementById('routeGrid').onclick = onGridClick;
  renderRoutes();
  void curYear;
}

function years() {
  return [...new Set(routes.map(r => r.year))].filter(Boolean).sort((a, b) => b.localeCompare(a));
}

function visible() {
  let list = routes.filter(r => state.filterYear === 'all' || r.year === state.filterYear);
  const q = state.search.trim().toLowerCase();
  if (q) list = list.filter(r => (r.name + ' ' + (r.dest || '') + ' ' + (r.scenic || '')).toLowerCase().includes(q));
  return list;
}

function miniBar(r) {
  const t = totalOf(r);
  if (t <= 0) return '<div class="minibar"></div>';
  let s = '<div class="minibar">';
  CATS.forEach(c => {
    const v = parseFloat(r.exp[c]) || 0;
    if (v > 0) {
      const pct = (v / t * 100).toFixed(1);
      s += `<span style="width:${pct}%;background:${COLORS[c]}" title="${c} ${fmt(v)}"></span>`;
    }
  });
  return s + '</div>';
}

function renderRoutes() {
  const grid = document.getElementById('routeGrid');
  const list = visible();
  if (!list.length) {
    grid.innerHTML = '<div class="empty">暂无路线，点「新增路线」开始记录吧 ✈</div>';
    return;
  }
  list.sort((a, b) => {
    const da = parseStart(a.daterange, a.year), db = parseStart(b.daterange, b.year);
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  });
  grid.innerHTML = list.map(r => {
    const t = totalOf(r);
    const per = perOf(r);
    const seed = r.is_seed ? '<span class="badge b-seed">示例</span>' : '';
    return `<div class="card">
      <div class="card-top"><div><div class="card-name">${esc(r.name)}</div>
        <div class="badges"><span class="badge b-year">${esc(r.year || '')}</span>
        <span class="badge b-type">${esc(r.type || '')}</span>
        ${r.days ? `<span class="badge b-days">${r.days}天</span>` : ''}${seed}</div></div></div>
      <div class="card-meta">📅 ${esc(r.daterange || '')}${r.dest ? ' · ' + esc(r.dest) : ''}</div>
      <div class="card-total"><span class="amt">${addYen(t)}</span>${per != null ? `<span class="per">人均 ${addYen(per)}</span>` : ''}</div>
      ${miniBar(r)}
      <div class="card-actions">
        <button class="btn btn-sm" data-act="detail" data-id="${r.id}">查看</button>
        ${r.is_seed && store.user && store.user.role !== 'admin' ? '' : `<button class="btn btn-sm" data-act="edit" data-id="${r.id}">编辑</button>`}
      </div>
    </div>`;
  }).join('');
}

function perOf(r) {
  const t = totalOf(r);
  const p = parseFloat(r.people) || 0;
  return p > 0 ? Math.round(t / p) : null;
}

function onGridClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  if (b.dataset.act === 'detail') openDetail(id);
  else if (b.dataset.act === 'edit') openForm(id);
}

/* ---------- 统计 ---------- */
export function renderStats() {
  const scope = visible();
  const total = scope.reduce((s, r) => s + totalOf(r), 0);
  const count = scope.length;
  const days = scope.reduce((s, r) => s + (parseInt(r.days) || 0), 0);
  const avg = count ? Math.round(total / count) : 0;
  const cards = document.getElementById('statCards');
  if (cards) cards.innerHTML = card('总花费', addYen(total)) + card('出行次数', count + ' 次') + card('次均花费', addYen(avg)) + card('总天数', days + ' 天');

  const catTot = {};
  CATS.forEach(c => (catTot[c] = 0));
  scope.forEach(r => CATS.forEach(c => (catTot[c] += parseFloat(r.exp[c]) || 0)));
  const data = CATS.filter(c => catTot[c] > 0).map(c => ({ label: c, value: catTot[c], color: COLORS[c] }));
  const chart = document.getElementById('catChart');
  const legend = document.getElementById('catLegend');
  if (chart) chart.innerHTML = donut(data);
  if (legend) {
    legend.innerHTML = data.map(d => {
      const pct = total > 0 ? Math.round(d.value / total * 100) : 0;
      return `<div class="legend-item"><span class="sw" style="background:${d.color}"></span>
        <span>${d.label}</span><span class="lp">${pct}%</span><span class="lv">${addYen(d.value)}</span></div>`;
    }).join('') || '<div class="empty">暂无花费数据</div>';
  }
  const ys = years();
  const trendEl = document.getElementById('trendChart');
  if (trendEl) {
    const points = ys.map(y => ({
      label: y,
      value: routes.filter(r => r.year === y).reduce((s, r) => s + totalOf(r), 0)
    }));
    trendEl.innerHTML = trendBar(points);
  }
  const table = document.getElementById('yearTable');
  if (table) {
    table.innerHTML = ys.map(y => {
      const rs = routes.filter(r => r.year === y);
      const tot = rs.reduce((s, r) => s + totalOf(r), 0);
      const dy = rs.reduce((s, r) => s + (parseInt(r.days) || 0), 0);
      return `<div class="detail-row"><span class="k">${y} 年（${rs.length} 次 / ${dy} 天）</span><span class="v">${addYen(tot)}</span></div>`;
    }).join('') || '<div class="empty">暂无数据</div>';
  }
}

/* ---------- 表单 ---------- */
function buildExpInputs() {
  const box = document.getElementById('expInputs');
  if (!box) return;
  box.innerHTML = CATS.map(c =>
    `<div class="exp-cell"><div class="el"><span class="sw" style="background:${COLORS[c]}"></span>${c}</div>
     <input type="number" min="0" step="0.01" id="exp_${c}" placeholder="0"></div>`).join('');
}

export function openForm(id) {
  state.curId = id || null;
  const r = id ? routes.find(x => x.id === id) : null;
  if (id && r && r.is_seed && store.user && store.user.role !== 'admin') { toast('示例路线为系统数据，仅可查看'); return; }
  openMask('formMask');
  document.getElementById('formDelete').style.display = id ? 'inline-flex' : 'none';
  document.getElementById('formTitle').textContent = id ? '编辑路线' : '新增路线';
  document.getElementById('f_name').value = r ? r.name : '';
  document.getElementById('f_year').value = r ? r.year : String(new Date().getFullYear());
  document.getElementById('f_daterange').value = r ? r.daterange : '';
  document.getElementById('f_type').value = r ? (r.type || '自由行') : '自由行';
  document.getElementById('f_days').value = r ? r.days : '';
  document.getElementById('f_people').value = r ? r.people : '2';
  document.getElementById('f_dest').value = r ? (r.dest || '') : '';
  document.getElementById('f_scenic').value = r ? (r.scenic || '') : '';
  document.getElementById('f_hotel').value = r ? (r.hotel || '') : '';
  document.getElementById('f_notes').value = r ? (r.notes || '') : '';
  CATS.forEach(c => { document.getElementById('exp_' + c).value = r && r.exp && r.exp[c] != null ? r.exp[c] : ''; });
}

async function saveForm() {
  const name = document.getElementById('f_name').value.trim();
  if (!name) { toast('请填写路线名称'); return; }
  const exp = {};
  CATS.forEach(c => (exp[c] = parseFloat(document.getElementById('exp_' + c).value) || 0));
  const obj = {
    name, year: document.getElementById('f_year').value.trim(),
    daterange: document.getElementById('f_daterange').value.trim(),
    type: document.getElementById('f_type').value,
    days: parseInt(document.getElementById('f_days').value) || 0,
    people: parseInt(document.getElementById('f_people').value) || 0,
    dest: document.getElementById('f_dest').value.trim(),
    scenic: document.getElementById('f_scenic').value,
    hotel: document.getElementById('f_hotel').value,
    notes: document.getElementById('f_notes').value,
    exp
  };
  try {
    if (state.curId) { await api.put('/routes/' + encodeURIComponent(state.curId), obj); toast('已保存'); }
    else { await api.post('/routes', obj); toast('已新增路线'); }
    closeMask('formMask');
    await loadRoutes();
    renderRoutes();
    renderStats();
  } catch (e) { toast(e.message); }
}

async function deleteRoute(id) {
  if (!confirm('确定删除这条路线？此操作不可撤销')) return;
  try {
    await api.del('/routes/' + encodeURIComponent(id));
    toast('已删除');
    closeMask('formMask');
    await loadRoutes();
    renderRoutes();
    renderStats();
  } catch (e) { toast(e.message); }
}

/* ---------- 详情 ---------- */
export function openDetail(id) {
  const r = routes.find(x => x.id === id);
  if (!r) { toast('路线不存在'); return; }
  state.detailId = id;
  openMask('detailMask');
  document.getElementById('d_name').textContent = r.name;
  const t = totalOf(r);
  const per = perOf(r);
  let h = '';
  h += row('年份 / 类型', (r.year || '') + ' · ' + (r.type || ''));
  h += row('出行日期', (r.daterange || '') + (r.days ? '（' + r.days + '天）' : ''));
  h += row('目的地', r.dest || '—');
  h += row('住宿', r.hotel || '—');
  h += row('总花费', addYen(t) + (per != null ? '（人均 ' + addYen(per) + '）' : ''));
  h += '<div class="detail-row"><span class="k">景点路线</span></div><div class="pre-wrap">' + (r.scenic ? esc(r.scenic) : '—') + '</div>';
  h += '<div style="height:10px"></div><div class="detail-row"><span class="k">9 类花费明细</span><span class="v">合计 ' + addYen(t) + '</span></div>';
  CATS.forEach(c => { const v = parseFloat(r.exp[c]) || 0; h += detailExp(c, v, t); });
  if (r.notes) h += '<div style="height:10px"></div><div class="detail-row"><span class="k">备注</span></div><div class="pre-wrap">' + esc(r.notes) + '</div>';
  document.getElementById('d_body').innerHTML = h;
  const seedOnly = r.is_seed && store.user && store.user.role !== 'admin';
  document.getElementById('d_edit').style.display = seedOnly ? 'none' : '';
}
function row(k, v) { return `<div class="detail-row"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`; }
function detailExp(c, v, t) {
  const pct = t > 0 ? Math.round(v / t * 100) : 0;
  return `<div class="detail-row"><span class="k"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${COLORS[c]};margin-right:6px"></span>${c}</span>
    <span class="v">${addYen(v)} <span style="color:var(--muted);font-weight:400;font-size:12px">${pct}%</span></span></div>`;
}

/* ---------- 个人中心 ---------- */
export function renderProfile() {
  const u = store.user;
  if (!u) { navigate('/login'); return; }
  const forced = location.hash.includes('reset=1') && u.force_reset;
  document.getElementById('view').innerHTML = `
    <div class="wrap" style="max-width:560px">
      <div class="panel">
        <h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>个人中心</h3>
        ${forced ? '<div class="banner" style="margin-top:0">首次登录请先修改初始密码，修改后方可继续使用。</div>' : ''}
        <div class="kv"><span class="k">用户名</span><span class="v">${esc(u.username || '—')}</span></div>
        <div class="kv"><span class="k">邮箱</span><span class="v">${esc(u.email || '—')}</span></div>
        <div class="kv"><span class="k">角色</span><span class="v">${u.role === 'admin' ? '管理员' : '普通用户'}</span></div>
        <div class="kv"><span class="k">注册时间</span><span class="v">${fmtTime(u.created_at)}</span></div>
        <div style="height:14px"></div>
        <div class="field"><label>原密码</label><input type="password" id="pf_old"></div>
        <div class="field"><label>新密码（至少 8 位）</label><input type="password" id="pf_new"></div>
        <div class="auth-actions">
          <button class="btn btn-primary btn-block" id="pf_save">${forced ? '设置新密码并继续' : '修改密码'}</button>
          ${forced ? '' : '<button class="btn btn-line btn-block" data-goto="workbench">返回工作台</button>'}
        </div>
      </div>
    </div>`;
  document.getElementById('pf_save').onclick = async () => {
    const oldPassword = document.getElementById('pf_old').value;
    const newPassword = document.getElementById('pf_new').value;
    if (newPassword.length < 8) { toast('新密码至少 8 位'); return; }
    try {
      await api.post('/auth/password', { oldPassword, newPassword });
      store.user.force_reset = false;
      toast('密码已修改');
      navigate('/workbench');
    } catch (e) { toast(e.message); }
  };
  const back = document.querySelector('[data-goto="workbench"]');
  if (back) back.onclick = () => navigate('/workbench');
}

/* ---------- 遮罩 ---------- */
export function openMask(id) { document.getElementById(id).classList.add('open'); }
export function closeMask(id) { document.getElementById(id).classList.remove('open'); }

export function bindFormEvents() {
  document.getElementById('formSave').onclick = saveForm;
  document.getElementById('formDelete').onclick = () => deleteRoute(state.curId);
  document.getElementById('d_edit').onclick = () => { closeMask('detailMask'); openForm(state.detailId); };
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => closeMask(b.dataset.close));
  document.querySelectorAll('.mask').forEach(m => m.onclick = e => { if (e.target === m) closeMask(m.id); });
  buildExpInputs();
}
