/* app.js — 工作台（路线列表 + 年度统计 + 路线表单 + 个人中心） */
import { store, toast, api, navigate, esc, fmt, fmtMoney, CATS, parseStart, fmtTime } from './api.js';
import { COLORS, totalOf, donut, trendBar } from './charts.js';

let routes = [];
let state = { filterYear: 'all', search: '', curId: null, detailId: null, page: 1, total: 0, pageSize: 50 };

export function refreshRoutes(page) {
  const qs = new URLSearchParams();
  if (store.hideSeed) qs.set('hideSeed', '1');
  if (state.filterYear && state.filterYear !== 'all') qs.set('year', state.filterYear);
  qs.set('page', String(page || state.page || 1));
  qs.set('pageSize', String(state.pageSize || 50));
  return api.get('/routes' + (qs.toString() ? '?' + qs.toString() : ''));
}

export async function loadRoutes() {
  try {
    const data = await refreshRoutes(state.page);
    routes = data.list || [];
    state.total = data.total || 0;
    state.pageSize = data.pageSize || state.pageSize;
  } catch (e) {
    if (e.status === 401) { navigate('/login'); return; }
    toast(e.message);
    routes = [];
    state.total = 0;
  }
}

/* 排序用起始时间：优先结构化 start_date，回退自由文本解析 */
function startMs(r) {
  if (r.start_date) { const t = new Date(r.start_date + 'T00:00:00'); if (!isNaN(t.getTime())) return t.getTime(); }
  const d = parseStart(r.daterange, r.year);
  return d ? d.getTime() : 0;
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
      <button class="btn btn-sm" id="exportBtn" title="导出本人路线为 CSV（Excel 可打开）">导出</button>
      <button class="btn btn-sm" id="importBtn" title="从 JSON 文件导入（需先导出 JSON）">导入</button>
      <input type="file" id="importFile" accept=".json,application/json" style="display:none">
      <button class="btn btn-primary" id="newRouteBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>新增路线</button>
    </div>
    <div class="grid" id="routeGrid"></div>
    <div class="pager" id="routePager" style="display:none;margin:12px 0 4px"></div>
    <div style="height:16px"></div>
    <div class="stat-cards" id="statCards"></div>
    <div class="flex2">
      <div class="panel">
        <h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" stroke-linejoin="round"/></svg>花费分类占比</h3>
        <div id="catChart"></div>
        <div class="legend" id="catLegend"></div>
      </div>
      <div class="panel">
        <h3 id="trendTitle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 9l-5 5-3-3-3 3"/></svg>逐年花费趋势</h3>
        <div id="trendChart"></div>
      </div>
    </div>
    <div class="panel">
      <h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M3 12h18M3 6h18M3 18h18"/></svg>各年明细</h3>
      <div id="yearTable"></div>
    </div>`;

  document.getElementById('search').oninput = e => { state.search = e.target.value; renderRoutes(); renderStats(); };
  document.getElementById('hideSeedCb').onchange = e => {
    store.hideSeed = e.target.checked;
    localStorage.setItem('te_hide_seed', store.hideSeed ? '1' : '0');
    state.page = 1;
    loadRoutes().then(() => { renderRoutes(); renderPager(); renderStats(); });
  };
  document.getElementById('newRouteBtn').onclick = () => openForm(null);
  document.getElementById('exportBtn').onclick = exportCsv;
  document.getElementById('importBtn').onclick = () => document.getElementById('importFile').click();
  document.getElementById('importFile').onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importJson(f);
    e.target.value = '';
  };
  document.querySelectorAll('[data-fy]').forEach(c => {
    c.onclick = () => {
      state.filterYear = c.dataset.fy;
      state.page = 1;
      /* 同步 chip 高亮：renderRoutes 只重绘路线网格，不重渲染 chip 行 */
      document.querySelectorAll('[data-fy]').forEach(x => x.classList.toggle('active', x === c));
      loadRoutes().then(() => { renderRoutes(); renderPager(); renderStats(); });
    };
  });
  document.getElementById('routeGrid').onclick = onGridClick;
  renderRoutes();
  renderPager();
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
    return startMs(b) - startMs(a);
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
      <div class="card-total"><span class="amt">${fmtMoney(t, r.currency)}</span>${per != null ? `<span class="per">人均 ${fmtMoney(per, r.currency)}</span>` : ''}</div>
      ${miniBar(r)}
      ${budgetBar(r)}
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

/* 分页控件：与管理端分页风格一致，仅当总数超过单页时显示 */
function renderPager() {
  const el = document.getElementById('routePager');
  if (!el) return;
  const total = state.total || 0;
  const ps = state.pageSize || 50;
  const totalPages = Math.max(1, Math.ceil(total / ps));
  if (total <= ps) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  el.style.gap = '10px';
  el.style.alignItems = 'center';
  el.style.justifyContent = 'center';
  el.innerHTML = `
    <button class="btn btn-sm" ${state.page <= 1 ? 'disabled' : ''} id="rpPrev">上一页</button>
    <span style="color:var(--muted);font-size:13px">${state.page} / ${totalPages}（共 ${total} 条）</span>
    <button class="btn btn-sm" ${state.page >= totalPages ? 'disabled' : ''} id="rpNext">下一页</button>`;
  const prev = document.getElementById('rpPrev');
  const next = document.getElementById('rpNext');
  if (prev) prev.onclick = () => { if (state.page > 1) { state.page--; loadRoutes().then(() => { renderRoutes(); renderPager(); renderStats(); }); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
  if (next) next.onclick = () => { if (state.page < totalPages) { state.page++; loadRoutes().then(() => { renderRoutes(); renderPager(); renderStats(); }); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
}

function budgetBar(r) {
  const b = parseFloat(r.budget_total) || 0;
  if (b <= 0) return '';
  const spent = totalOf(r);
  const pct = Math.min(100, Math.round(spent / b * 100));
  const over = spent > b;
  return `<div class="budget"><div class="budget-bar"><span style="width:${pct}%;background:${over ? 'var(--danger)' : 'var(--accent)'}"></span></div>
    <div class="budget-txt">预算 ${fmtMoney(b, r.currency)} · 已用 ${pct}%${over ? ' · 超支 ' + fmtMoney(spent - b, r.currency) : ''}</div></div>`;
}

function onGridClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  if (b.dataset.act === 'detail') openDetail(id);
  else if (b.dataset.act === 'edit') openForm(id);
}

/* ---------- 导出 / 导入 ---------- */
async function exportCsv() {
  try {
    const r = await fetch('/api/routes/export?fmt=csv', { credentials: 'same-origin' });
    if (!r.ok) {
      const j = await r.json().catch(() => null);
      throw new Error((j && j.msg) || '导出失败');
    }
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'travel-expense.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出 ' + routes.filter(x => !x.is_seed).length + ' 条路线（CSV）');
  } catch (e) { toast('导出失败：' + e.message); }
}

async function importJson(file) {
  try {
    const txt = await file.text();
    const j = JSON.parse(txt);
    const list = Array.isArray(j) ? j : (j.routes || null);
    if (!Array.isArray(list) || !list.length) throw new Error('文件中没有可导入的路线');
    const res = await api.post('/routes/import', { routes: list });
    if (res && res.created) {
      const dup = res.duplicates ? '，去重跳过 ' + res.duplicates + ' 条' : '';
      toast('导入完成：新增 ' + res.created + ' 条' + (res.skipped ? '，跳过 ' + res.skipped + ' 条' : '') + dup);
      await loadRoutes(); renderRoutes(); renderPager(); renderStats();
    } else throw new Error((res && res.msg) || '导入失败');
  } catch (e) { toast('导入失败：' + e.message); }
}

/* ---------- 统计（按本位币聚合多币种） ---------- */
function homeMoney(v) { return fmtMoney(v, store.site.home_currency); }
function card(k, v, color) {
  return `<div class="stat"><div class="v"${color ? ` style="color:${color}"` : ''}>${v}</div><div class="l">${k}</div></div>`;
}
/* 统计改为消费服务端 /api/routes/stats/summary 与 /stats/trend（按本位币聚合多币种），
 * 删除此前前端对已加载 routes 的重复聚合（原实现仅覆盖当前分页，与全量口径不一致）。 */
export async function renderStats() {
  const params = new URLSearchParams();
  if (store.hideSeed) params.set('hideSeed', '1');
  if (state.filterYear && state.filterYear !== 'all') params.set('year', state.filterYear);
  const q = state.search.trim();
  if (q) params.set('q', q);
  const qs = params.toString();

  let summary;
  try { summary = await api.get('/routes/stats/summary' + (qs ? '?' + qs : '')); }
  catch (e) { toast('统计加载失败：' + e.message); return; }
  if (!summary) return;

  const home = store.site.home_currency || 'CNY';
  const total = summary.grand;
  const count = summary.count;
  const days = summary.days;
  const avg = count ? Math.round(total / count) : 0;
  const budgetTotal = summary.budgetTotal;
  const remaining = summary.remaining;

  const cards = document.getElementById('statCards');
  if (cards) cards.innerHTML = card('总花费(' + home + ')', homeMoney(total))
    + card('出行次数', count + ' 次') + card('次均花费', homeMoney(avg)) + card('总天数', days + ' 天')
    + card('总预算', homeMoney(budgetTotal)) + card('结余', homeMoney(remaining), remaining < 0 ? 'var(--danger)' : '');

  const catTot = summary.totalByCat || {};
  const data = CATS.filter(c => (catTot[c] || 0) > 0).map(c => ({ label: c, value: catTot[c], color: COLORS[c] }));
  const chart = document.getElementById('catChart');
  const legend = document.getElementById('catLegend');
  if (chart) chart.innerHTML = donut(data, home);
  if (legend) {
    legend.innerHTML = data.map(d => {
      const pct = total > 0 ? Math.round(d.value / total * 100) : 0;
      return `<div class="legend-item"><span class="sw" style="background:${d.color}"></span>
        <span>${d.label}</span><span class="lp">${pct}%</span><span class="lv">${homeMoney(d.value)}</span></div>`;
    }).join('') || '<div class="empty">暂无花费数据</div>';
  }

  let trend = [];
  try { trend = await api.get('/routes/stats/trend' + (qs ? '?' + qs : '')) || []; } catch (e) { trend = []; }
  const trendEl = document.getElementById('trendChart');
  const trendTitle = document.getElementById('trendTitle');
  if (trendEl) {
    const points = (trend || []).map(p => ({ label: p.label != null ? p.label : p.period, value: p.total }));
    trendEl.innerHTML = trendBar(points, null, home);
  }
  if (trendTitle) trendTitle.textContent = state.filterYear && state.filterYear !== 'all'
    ? state.filterYear + ' 年每月花费趋势'
    : '逐年花费趋势';

  const byYear = summary.byYear || [];
  const table = document.getElementById('yearTable');
  if (table) {
    table.innerHTML = byYear.map(y => {
      return `<div class="detail-row"><span class="k">${esc(y.year)} 年（${y.count} 次 / ${y.days} 天）</span><span class="v">${homeMoney(y.total)}</span></div>`;
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
  const curSel = document.getElementById('f_currency');
  if (curSel) {
    const rates = store.site.fx_rates || { CNY: 1 };
    curSel.innerHTML = Object.keys(rates).sort().map(c => `<option value="${c}">${c}</option>`).join('');
    curSel.value = (r && r.currency) || store.site.home_currency || 'CNY';
  }
  document.getElementById('f_budget_total').value = r ? (r.budget_total || '') : '';
  document.getElementById('f_budget_daily').value = r ? (r.budget_daily || '') : '';
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
    currency: document.getElementById('f_currency').value || 'CNY',
    budget_total: parseFloat(document.getElementById('f_budget_total').value) || 0,
    budget_daily: parseFloat(document.getElementById('f_budget_daily').value) || 0,
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
    renderPager();
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
    renderPager();
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
  h += row('总花费', fmtMoney(t, r.currency) + (per != null ? '（人均 ' + fmtMoney(per, r.currency) + '）' : ''));
  if (r.budget_total > 0) {
    const over = t > r.budget_total;
    h += row('预算', fmtMoney(r.budget_total, r.currency) + (over ? ` · <span style="color:var(--danger)">超支 ${fmtMoney(t - r.budget_total, r.currency)}</span>` : ` · 剩余 ${fmtMoney(r.budget_total - t, r.currency)}`));
  }
  h += '<div class="detail-row"><span class="k">景点路线</span></div><div class="pre-wrap">' + (r.scenic ? esc(r.scenic) : '—') + '</div>';
  h += '<div style="height:10px"></div><div class="detail-row"><span class="k">9 类花费明细</span><span class="v">合计 ' + fmtMoney(t, r.currency) + '</span></div>';
  CATS.forEach(c => { const v = parseFloat(r.exp[c]) || 0; h += detailExp(c, v, t, r.currency); });
  if (r.notes) h += '<div style="height:10px"></div><div class="detail-row"><span class="k">备注</span></div><div class="pre-wrap">' + esc(r.notes) + '</div>';
  document.getElementById('d_body').innerHTML = h;
  const seedOnly = r.is_seed && store.user && store.user.role !== 'admin';
  document.getElementById('d_edit').style.display = seedOnly ? 'none' : '';
  /* 分享入口：仅本人路线或管理员（种子对普通用户只读，不展示） */
  if (!seedOnly) {
    const sb = document.createElement('div');
    sb.className = 'detail-row';
    sb.style.marginTop = '10px';
    sb.innerHTML = '<span class="k">分享</span><span class="v"><button class="btn btn-sm" id="shareBtn">生成只读链接</button></span>';
    document.getElementById('d_body').appendChild(sb);
    sb.querySelector('#shareBtn').onclick = async () => {
      try {
        const res = await api.post('/routes/' + encodeURIComponent(r.id) + '/share');
        if (!res || !res.token) throw new Error('生成失败');
        const url = location.origin + '/share/' + res.token;
        sb.innerHTML = '<span class="k">分享</span><span class="v" style="font-size:12px"><span class="mono" style="cursor:pointer;word-break:break-all" title="点击复制" id="shareUrl">' + esc(url) + '</span></span>';
        const su = sb.querySelector('#shareUrl');
        su.onclick = () => {
          navigator.clipboard.writeText(url).then(() => toast('链接已复制'), () => toast(url));
        };
        toast('已生成分享链接，点击链接复制');
      } catch (e) { toast('分享失败：' + e.message); }
    };
  }
}
function row(k, v) { return `<div class="detail-row"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`; }
function detailExp(c, v, t, cur) {
  const pct = t > 0 ? Math.round(v / t * 100) : 0;
  return `<div class="detail-row"><span class="k"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${COLORS[c]};margin-right:6px"></span>${c}</span>
    <span class="v">${fmtMoney(v, cur)} <span style="color:var(--muted);font-weight:400;font-size:12px">${pct}%</span></span></div>`;
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
