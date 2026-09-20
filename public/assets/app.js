/* app.js — 工作台（路线列表 + 年度统计 + 路线表单 + 个人中心） */
import { store, toast, api, navigate, esc, fmt, fmtMoney, CATS, parseStart, fmtTime } from './api.js';
import { COLORS, totalOf, donut, trendBar } from './charts.js';
import * as ledger from './ledger.js';

let routes = [];
let searchTimer = null;
let state = { filterYear: 'all', search: '', curId: null, detailId: null, detailTab: 'overview', page: 1, total: 0, pageSize: 50, years: [] };

/* 全量年份（由 GET /api/routes/years 下发），工作台年份胶囊据此渲染。
 * 注意：必须用 .catch 兜底而非 try/catch —— 接口异常是 Promise 拒绝，
 * 未捕获会连带中断调用方的 Promise.all，导致工作台整体渲染失败。 */
export function loadYears() {
  const qs = store.hideSeed ? '?hideSeed=1' : '';
  return api.get('/routes/years' + qs)
    .then(data => { state.years = (data && data.years) || []; })
    .catch(e => {
      if (e && e.status === 401) { navigate('/login'); return; }
      /* 年份接口失败不应阻断主体：降级为「仅全部」并保留既有列表能力 */
      state.years = [];
    });
}

export function refreshRoutes(page) {
  const qs = new URLSearchParams();
  if (store.hideSeed) qs.set('hideSeed', '1');
  if (state.filterYear && state.filterYear !== 'all') qs.set('year', state.filterYear);
  /* 搜索改为服务端过滤，与统计口径一致（列表/年份/搜索/统计同源） */
  if (state.search.trim()) qs.set('q', state.search.trim());
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

/* 增删改导入后统一刷新：列表 + 全量年份胶囊 + 分页 + 统计。
 * 年份可能因新增/删除/导入而变化，故必须重新拉取 /routes/years 而非复用旧 state.years。 */
async function reloadAfterMutation() {
  await Promise.all([loadRoutes(), loadYears()]);
  renderYearChips();
  renderRoutes();
  renderPager();
  renderStats();
  /* 详情弹层若开着，同步刷新当前页签：
   * 流水变化会改写 9 类聚合值，概览页的金额/占比必须跟着更新 */
  if (document.getElementById('detailMask') &&
      document.getElementById('detailMask').classList.contains('open') &&
      state.detailId) {
    const still = routes.find(x => x.id === state.detailId);
    if (still) {
      document.getElementById('d_name').textContent = still.name;
      if (state.detailTab === 'overview') renderDetailTab();
    }
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
  document.getElementById('view').innerHTML = `
    ${banner ? `<div class="banner">${esc(banner)}</div>` : ''}
    <nav class="toolbar">
      <div class="chip-row" id="chipRow" style="flex:1;min-width:100%"></div>
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

  document.getElementById('search').oninput = e => {
    state.search = e.target.value;
    state.page = 1;
    /* 防抖：避免每次按键都打统计/列表接口（搜索已改为服务端过滤） */
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      loadRoutes().then(() => { renderRoutes(); renderPager(); renderStats(); });
    }, 300);
  };
  document.getElementById('hideSeedCb').onchange = e => {
    store.hideSeed = e.target.checked;
    localStorage.setItem('te_hide_seed', store.hideSeed ? '1' : '0');
    state.page = 1;
    Promise.all([loadRoutes(), loadYears()]).then(() => { renderYearChips(); renderRoutes(); renderPager(); renderStats(); });
  };
  document.getElementById('newRouteBtn').onclick = () => openForm(null);
  document.getElementById('exportBtn').onclick = exportCsv;
  document.getElementById('importBtn').onclick = () => document.getElementById('importFile').click();
  document.getElementById('importFile').onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importJson(f);
    e.target.value = '';
  };
  document.getElementById('routeGrid').onclick = onGridClick;
  renderYearChips();
  renderRoutes();
  renderPager();
}

/* 年份筛选胶囊：基于 state.years（GET /api/routes/years 全量去重），不受分页与 year 过滤影响 */
function renderYearChips() {
  const row = document.getElementById('chipRow');
  if (!row) return;
  row.innerHTML = `<div class="chip ${state.filterYear === 'all' ? 'active' : ''}" data-fy="all">全部</div>` +
    years().map(y => `<div class="chip ${state.filterYear === y ? 'active' : ''}" data-fy="${y}">${y}</div>`).join('');
  row.querySelectorAll('[data-fy]').forEach(c => {
    c.onclick = () => {
      state.filterYear = c.dataset.fy;
      state.page = 1;
      row.querySelectorAll('[data-fy]').forEach(x => x.classList.toggle('active', x === c));
      loadRoutes().then(() => { renderRoutes(); renderPager(); renderStats(); });
    };
  });
}

function years() {
  return state.years || [];
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
  /* 列表已由服务端按 year+q 过滤并分页，直接渲染返回结果（与统计口径一致） */
  const list = routes;
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
    const nExp = parseInt(r.expense_count, 10) || 0;
    return `<div class="card">
      <div class="card-top"><div><div class="card-name">${esc(r.name)}</div>
        <div class="badges"><span class="badge b-year">${esc(r.year || '')}</span>
        <span class="badge b-type">${esc(r.type || '')}</span>
        ${r.days ? `<span class="badge b-days">${r.days}天</span>` : ''}
        ${nExp ? `<span class="pill pill-ok">流水 ${nExp} 笔</span>` : ''}${seed}</div></div></div>
      <div class="card-meta">📅 ${esc(r.daterange || '')}${r.dest ? ' · ' + esc(r.dest) : ''}</div>
      <div class="card-total"><span class="amt">${fmtMoney(t, r.currency)}</span>${per != null ? `<span class="per">人均 ${fmtMoney(per, r.currency)}</span>` : ''}</div>
      ${miniBar(r)}
      ${budgetBar(r)}
      <div class="card-actions">
        <button class="btn btn-sm" data-act="detail" data-id="${r.id}">查看</button>
        ${r.is_seed && store.user && store.user.role !== 'admin' ? '' : `<button class="btn btn-sm" data-act="edit" data-id="${r.id}">编辑</button>`}
        ${r.is_seed && store.user && store.user.role !== 'admin' ? '' : `<button class="btn btn-sm btn-line" data-act="add" data-id="${r.id}">＋ 记一笔</button>`}
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
  const act = b.dataset.act;
  if (act === 'detail') openDetail(id);
  else if (act === 'edit') openForm(id);
  /* 卡片上的「记一笔」：直接进入该路线详情的流水页签并打开记账表单 */
  else if (act === 'add') {
    const r = routes.find(x => x.id === id);
    if (!r) return;
    state.detailId = id;
    state.detailTab = 'ledger';
    openMask('detailMask');
    ledger.openExpenseSheet(r, null, reloadAfterMutation);
  }
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
      await reloadAfterMutation();
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
  if (cards) {
    /* 未设置总预算时，「总预算 / 结余」无意义：显示 — 而不是把全部花费算成负结余 */
    const hasBudget = (parseFloat(budgetTotal) || 0) > 0;
    cards.innerHTML = card('总花费(' + home + ')', homeMoney(total))
      + card('出行次数', count + ' 次') + card('次均花费', homeMoney(avg)) + card('总天数', days + ' 天')
      + (hasBudget
        ? card('总预算', homeMoney(budgetTotal)) + card('结余', homeMoney(remaining), remaining < 0 ? 'var(--danger)' : '')
        : card('总预算', '未设置') + card('结余', '—'));
  }

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

/* ---------- 日期工具 ---------- */
/* 由起止日期计算天数：结束日期 - 开始日期 + 1 */
function calcDays(start, end) {
  if (!start || !end) return 0;
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return 0;
  const diff = Math.round((e - s) / 86400000);
  return diff >= 0 ? diff + 1 : 0;
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
/* 从旧的 daterange 文本解析出起止日期（兼容老数据） */
function parseDatesFromRange(dr, year) {
  if (!dr) return { start: '', end: '' };
  let m = dr.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\s*[-—~]\s*(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return {
    start: `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`,
    end: `${m[4]}-${String(m[5]).padStart(2,'0')}-${String(m[6]).padStart(2,'0')}`
  };
  m = dr.match(/(\d{1,2})[\/\-.](\d{1,2})\s*[-—~]\s*(\d{1,2})[\/\-.](\d{1,2})/);
  if (m && year) {
    const sm = +m[1], em = +m[3];
    const ey = em < sm ? +year + 1 : +year;
    return {
      start: `${year}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`,
      end: `${ey}-${String(m[3]).padStart(2,'0')}-${String(m[4]).padStart(2,'0')}`
    };
  }
  m = dr.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) {
    const d = `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
    return { start: d, end: d };
  }
  m = dr.match(/(\d{1,2})[\/\-.](\d{1,2})/);
  if (m && year) {
    const d = `${year}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
    return { start: d, end: d };
  }
  return { start: '', end: '' };
}

/* ---------- 表单 ---------- */
/* 日期变化时自动计算天数并更新 daterange 隐藏字段 */
function onDateChange() {
  const start = document.getElementById('f_start_date').value;
  const end = document.getElementById('f_end_date').value;
  const days = calcDays(start, end);
  document.getElementById('f_days').value = days > 0 ? days : '';
  document.getElementById('f_daterange').value = buildDateRangeText(start, end);
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

  /* 起止日期：优先用结构化字段，否则从旧 daterange 文本解析 */
  let startDate = '', endDate = '';
  if (r) {
    if (r.start_date) startDate = r.start_date;
    if (r.end_date) endDate = r.end_date;
    if (!startDate && !endDate && r.daterange) {
      const parsed = parseDatesFromRange(r.daterange, r.year);
      startDate = parsed.start;
      endDate = parsed.end;
    }
  }
  document.getElementById('f_start_date').value = startDate;
  document.getElementById('f_end_date').value = endDate;
  document.getElementById('f_daterange').value = buildDateRangeText(startDate, endDate);

  document.getElementById('f_type').value = r ? (r.type || '自由行') : '自由行';
  /* 天数：优先用已存值，否则由起止日期自动计算 */
  const autoDays = calcDays(startDate, endDate);
  document.getElementById('f_days').value = r && r.days ? r.days : (autoDays > 0 ? autoDays : '');

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

  /* 花费明细统一由流水派生：编辑态提供「去记流水」直达；新增态提示保存后再记 */
  const hintText = document.getElementById('expLedgerHintText');
  const goBtn = document.getElementById('gotoLedgerBtn');
  if (hintText) {
    hintText.textContent = r
      ? `9 类花费由逐笔流水自动汇总（当前 ${parseInt(r.expense_count, 10) || 0} 笔），本表单不再手工填写。`
      : '9 类花费改由「逐笔流水」自动汇总：保存路线后打开「查看 → 流水」记录每一笔消费，总额、人均与结算都会自动算好。';
  }
  if (goBtn) {
    goBtn.style.display = r ? '' : 'none';
    goBtn.onclick = () => {
      if (!r) return;
      closeMask('formMask');
      state.detailId = r.id;
      state.detailTab = 'ledger';
      openMask('detailMask');
      paintDetailTabs();
      renderDetailTab();
    };
  }

  /* AI 按钮：仅当当前用户被启用 AI 功能时显示
   * 启用方式：管理后台 → AI 配置 → 勾选对应用户 → 保存启用用户 */
  const aiBtn = document.getElementById('aiPlanBtn');
  const showAi = !!(store.user && store.user.ai_enabled);
  if (aiBtn) {
    aiBtn.style.display = showAi ? 'inline-flex' : 'none';
    aiBtn.style.visibility = showAi ? 'visible' : 'hidden';
  }
  /* 「调整」按钮：需已启用 AI 且表单已有行程内容，统一由 syncAiChatBtn 判定 */
  syncAiChatBtn();
}

/* AI 行程规划：校验必填项 → 调用接口 → 回填景点路线 */
/* AI 生成的「注意事项 / 美食推荐」写入备注。
 * 备注已有内容时追加而非覆盖（用户自己的备注不能丢），并做幂等判断避免重复追加。
 * 返回是否真的写入了内容。 */
function fillAiNotes(notes) {
  const text = String(notes || '').trim();
  if (!text) return false;
  const box = document.getElementById('f_notes');
  if (!box) return false;
  const cur = box.value.trim();
  if (!cur) { box.value = text; return true; }
  if (cur.includes(text)) return true;              /* 已写入过，跳过 */
  box.value = cur + '\n\n—— AI 补充 ——\n' + text;
  return true;
}

/* 回填 AI 结果到表单：行程 → 景点路线；注意事项/美食推荐 → 备注 */
function applyAiResult(res) {
  if (!res) return false;
  if (res.scenic) document.getElementById('f_scenic').value = res.scenic;
  fillAiNotes(res.notes);
  syncAiChatBtn();
  return !!res.scenic;
}

async function aiPlanRoute() {
  const startDate = document.getElementById('f_start_date').value;
  const endDate = document.getElementById('f_end_date').value;
  const dest = document.getElementById('f_dest').value.trim();
  const days = parseInt(document.getElementById('f_days').value) || 0;

  if (!startDate) { toast('请先选择出行开始日期'); return; }
  if (!endDate) { toast('请先选择出行结束日期'); return; }
  if (!dest) { toast('请先填写主要目的地'); return; }
  if (days <= 0) { toast('天数无效，请检查起止日期'); return; }

  const btn = document.getElementById('aiPlanBtn');
  const originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span style="vertical-align:middle">规划中…</span>';
  try {
    const res = await api.post('/routes/ai-plan', {
      start_date: startDate,
      end_date: endDate,
      dest,
      days
    });
    if (res && res.scenic) {
      document.getElementById('f_scenic').value = res.scenic;
      /* 注意事项 + 美食推荐 → 备注（已有内容时追加，不覆盖用户自己的备注） */
      const filled = fillAiNotes(res.notes);
      /* 回填后表单已有行程内容，立即同步「调整」按钮可见，无需先保存再重开表单 */
      syncAiChatBtn();
      toast(filled
        ? 'AI 规划完成：行程已回填，注意事项与美食推荐已写入备注'
        : 'AI 行程规划完成，已回填到景点路线');
    } else {
      toast('AI 返回内容为空');
    }
  } catch (e) {
    toast(e.message || 'AI 规划失败');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHTML;
  }
}

/* ========== AI 行程对话式调整 ========== */

/* 对话状态。会话按「路线 id」暂存（未保存的新路线归入 __new__），
 * 使关闭面板再打开时可续接上下文；一旦基准行程变化则自动作废重建，避免上下文错位。 */
const aiChatState = {
  session: null,     // 当前会话 { baseScenic, history:[{role,content}], lastResult }
  loading: false
};
const aiChatSessions = new Map();
const AI_CHAT_SESSION_MAX = 20;

/* 会话键：已保存路线用其 id，未保存的新路线统一归入 __new__ */
function aiChatKey() { return state.curId || '__new__'; }

/* 取出（或按当前基准行程新建）会话对象 */
function getAiChatSession(baseScenic) {
  const key = aiChatKey();
  let s = aiChatSessions.get(key);
  if (!s || s.baseScenic !== baseScenic) {
    s = { baseScenic, history: [], lastResult: '' };
    /* 简单容量控制：超出上限时淘汰最早建立的会话，避免长会话下内存无界增长 */
    if (aiChatSessions.size >= AI_CHAT_SESSION_MAX) {
      const first = aiChatSessions.keys().next();
      if (!first.done) aiChatSessions.delete(first.value);
    }
    aiChatSessions.set(key, s);
  }
  return s;
}

/* 「调整」按钮显隐：需已启用 AI 且当前表单已有行程内容。
 * 抽为独立函数，供表单渲染、AI 规划回填、应用调整结果三处复用，避免显隐状态不一致。 */
function syncAiChatBtn() {
  const btn = document.getElementById('aiChatBtn');
  if (!btn) return;
  const scenicEl = document.getElementById('f_scenic');
  const hasScenic = !!(scenicEl && scenicEl.value.trim());
  const show = !!(store.user && store.user.ai_enabled) && hasScenic;
  btn.style.display = show ? 'inline-flex' : 'none';
  btn.style.visibility = show ? 'visible' : 'hidden';
}

/* 打开 AI 对话调整面板 */
function openAiChat() {
  const scenic = document.getElementById('f_scenic').value.trim();
  if (!scenic) { toast('请先生成或填写行程内容，再进行调整'); return; }
  const dest = document.getElementById('f_dest').value.trim();
  if (!dest) { toast('请先填写主要目的地'); return; }

  /* 复用同一路线且基准行程未变的会话，实现关闭后重开续接 */
  const session = getAiChatSession(scenic);
  aiChatState.session = session;
  aiChatState.loading = false;

  /* 显示当前行程 */
  document.getElementById('aiChatCurrentContent').textContent = scenic;
  document.getElementById('aiChatCurrentContent').style.display = 'none';

  /* 恢复历史对话；无历史时展示占位提示 */
  const msgs = document.getElementById('aiChatMessages');
  msgs.innerHTML = '';
  if (session.history.length) {
    session.history.forEach(m => renderAiChatMessage(m.role, m.content));
  } else {
    msgs.innerHTML =
      '<div style="text-align:center;color:#999;font-size:13px;padding:20px 0">' +
      '输入调整要求，AI 会基于当前行程进行修改<br>' +
      '<span style="font-size:12px">例如：把第二天的故宫换成颐和园、增加美食推荐、第一天太赶了精简一下</span>' +
      '</div>';
  }

  /* 有历史结果时同步恢复应用栏，保证续接后可继续落地 */
  document.getElementById('aiChatApplyBar').style.display = session.lastResult ? 'flex' : 'none';
  document.getElementById('aiChatInput').value = '';

  openMask('aiChatMask');
  setTimeout(() => document.getElementById('aiChatInput').focus(), 100);
}

/* 当前行程展开/收起 */
function toggleAiChatCurrent() {
  const el = document.getElementById('aiChatCurrentContent');
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

/* 渲染一条对话消息 */
function renderAiChatMessage(role, content) {
  const container = document.getElementById('aiChatMessages');
  /* 如果是第一条消息，清空占位提示 */
  if (container.querySelector('div[style*="text-align:center"]')) {
    container.innerHTML = '';
  }
  const isUser = role === 'user';
  const div = document.createElement('div');
  div.style.cssText = `margin-bottom:12px;display:flex;${isUser ? 'justify-content:flex-end' : 'justify-content:flex-start'}`;
  const bubble = document.createElement('div');
  bubble.style.cssText = `max-width:85%;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;${isUser ? 'background:#4a90d9;color:#fff;border-bottom-right-radius:4px' : 'background:#fff;border:1px solid #e0e0e0;border-bottom-left-radius:4px'}`;
  bubble.textContent = content;
  div.appendChild(bubble);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

/* 发送调整指令 */
async function sendAiChatMessage() {
  if (aiChatState.loading) return;
  const input = document.getElementById('aiChatInput');
  const message = input.value.trim();
  if (!message) { toast('请输入调整要求'); return; }

  const startDate = document.getElementById('f_start_date').value;
  const endDate = document.getElementById('f_end_date').value;
  const dest = document.getElementById('f_dest').value.trim();
  const days = parseInt(document.getElementById('f_days').value) || 0;
  /* 当前行程：优先用本会话最近一次 AI 调整结果，否则用会话基准行程 */
  const session = aiChatState.session;
  const currentScenic = (session && session.lastResult) || document.getElementById('f_scenic').value.trim();

  if (!startDate || !endDate) { toast('请先选择出行起止日期'); return; }
  if (!dest) { toast('请先填写主要目的地'); return; }
  if (days <= 0) { toast('天数无效，请检查起止日期'); return; }
  if (!currentScenic) { toast('当前行程为空，请先生成或填写行程'); return; }
  if (!session) { toast('对话未就绪，请重新打开调整面板'); return; }

  /* 渲染用户消息 */
  renderAiChatMessage('user', message);
  input.value = '';
  aiChatState.loading = true;

  /* 显示加载中 */
  const loadingDiv = document.createElement('div');
  loadingDiv.style.cssText = 'margin-bottom:12px;display:flex;justify-content:flex-start';
  loadingDiv.innerHTML = '<div style="background:#fff;border:1px solid #e0e0e0;border-radius:12px;border-bottom-left-radius:4px;padding:10px 14px;font-size:14px;color:#999">AI 正在思考调整方案…</div>';
  document.getElementById('aiChatMessages').appendChild(loadingDiv);
  document.getElementById('aiChatMessages').scrollTop = document.getElementById('aiChatMessages').scrollHeight;

  const sendBtn = document.getElementById('aiChatSend');
  sendBtn.disabled = true;
  sendBtn.textContent = '发送中…';

  try {
    const res = await api.post('/routes/ai-chat', {
      current_scenic: currentScenic,
      /* 当前备注（含上次生成的注意事项/美食推荐）→ 让模型做增量更新而不是从零重写 */
      current_notes: (document.getElementById('f_notes') || {}).value || '',
      message,
      dest,
      start_date: startDate,
      end_date: endDate,
      days,
      history: session.history
    });

    /* 移除加载中 */
    loadingDiv.remove();

    if (res && res.scenic) {
      /* 记录对话历史（写入会话，关闭面板后重开可续接） */
      session.history.push({ role: 'user', content: message });
      session.history.push({ role: 'assistant', content: res.scenic });
      session.lastResult = res.scenic;
      /* 备注若本次被更新，同样在「应用此版本」时一并回填 */
      session.lastNotes = res.notes || '';

      /* 渲染 AI 回复 */
      renderAiChatMessage('assistant', res.scenic);

      /* 显示应用栏 */
      document.getElementById('aiChatApplyBar').style.display = 'flex';
    } else {
      toast('AI 返回内容为空');
    }
  } catch (e) {
    loadingDiv.remove();
    renderAiChatMessage('assistant', '❌ ' + (e.message || '调整失败'));
  } finally {
    aiChatState.loading = false;
    sendBtn.disabled = false;
    sendBtn.textContent = '发送';
  }
}

/* 应用调整后的行程到表单 */
function applyAiChatResult() {
  const session = aiChatState.session;
  if (!session || !session.lastResult) { toast('没有可应用的行程'); return; }
  document.getElementById('f_scenic').value = session.lastResult;
  /* 若本次调整同时更新了注意事项/美食推荐，一并写入备注 */
  const notesFilled = fillAiNotes(session.lastNotes);
  /* 表单内容已成为新的基准行程：同步会话基准，避免下次打开被视为「基准变化」而丢弃历史 */
  session.baseScenic = session.lastResult;
  closeMask('aiChatMask');
  toast(notesFilled ? '已应用调整后的行程，备注同步更新' : '已应用调整后的行程');
  /* 应用后表单已有行程内容，同步「调整」按钮为可见 */
  syncAiChatBtn();
}

/* ========== AI 行程对话式调整 END ========== */

async function saveForm() {
  const name = document.getElementById('f_name').value.trim();
  if (!name) { toast('请填写路线名称'); return; }
  const startDate = document.getElementById('f_start_date').value;
  const endDate = document.getElementById('f_end_date').value;
  const days = calcDays(startDate, endDate);
  /* 注意：不再提交 exp —— 9 类花费统一由服务端按逐笔流水汇总（提交反而会覆盖聚合值） */
  const obj = {
    name, year: document.getElementById('f_year').value.trim(),
    daterange: document.getElementById('f_daterange').value || buildDateRangeText(startDate, endDate),
    start_date: startDate,
    end_date: endDate,
    type: document.getElementById('f_type').value,
    days: days > 0 ? days : (parseInt(document.getElementById('f_days').value) || 0),
    people: parseInt(document.getElementById('f_people').value) || 0,
    currency: document.getElementById('f_currency').value || 'CNY',
    budget_total: parseFloat(document.getElementById('f_budget_total').value) || 0,
    budget_daily: parseFloat(document.getElementById('f_budget_daily').value) || 0,
    dest: document.getElementById('f_dest').value.trim(),
    scenic: document.getElementById('f_scenic').value,
    hotel: document.getElementById('f_hotel').value,
    notes: document.getElementById('f_notes').value
  };
  try {
    if (state.curId) { await api.put('/routes/' + encodeURIComponent(state.curId), obj); toast('已保存'); }
    else {
      const rec = await api.post('/routes', obj);
      toast('已新增路线，接下来可以逐笔记录花费');
      closeMask('formMask');
      await reloadAfterMutation();
      /* 新增后直接引导到流水页签，省掉「再点一次查看」 */
      if (rec && rec.id) {
        state.detailId = rec.id;
        state.detailTab = 'ledger';
        openMask('detailMask');
        paintDetailTabs();
        renderDetailTab();
      }
      return;
    }
    closeMask('formMask');
    await reloadAfterMutation();
  } catch (e) { toast(e.message); }
}

async function deleteRoute(id) {
  if (!confirm('确定删除这条路线？此操作不可撤销')) return;
  try {
    await api.del('/routes/' + encodeURIComponent(id));
    toast('已删除');
    closeMask('formMask');
    await reloadAfterMutation();
  } catch (e) { toast(e.message); }
}

/* ---------- 详情（三页签：概览 / 流水 / 结算） ---------- */
export function openDetail(id) {
  const r = routes.find(x => x.id === id);
  if (!r) { toast('路线不存在'); return; }
  state.detailId = id;
  if (!state.detailTab) state.detailTab = 'overview';
  openMask('detailMask');
  document.getElementById('d_name').textContent = r.name;
  paintDetailTabs();
  renderDetailTab();
}

function paintDetailTabs() {
  const box = document.getElementById('d_tabs');
  if (!box) return;
  const tabs = [['overview', '概览'], ['ledger', '流水'], ['settle', '结算']];
  box.innerHTML = tabs.map(([k, label]) =>
    `<div class="tab${state.detailTab === k ? ' active' : ''}" data-tab="${k}">${label}</div>`).join('');
  box.querySelectorAll('[data-tab]').forEach(t => {
    t.onclick = () => {
      if (state.detailTab === t.dataset.tab) return;
      state.detailTab = t.dataset.tab;
      paintDetailTabs();
      renderDetailTab();
    };
  });
}

function renderDetailTab() {
  const r = routes.find(x => x.id === state.detailId);
  const body = document.getElementById('d_body');
  const acts = document.getElementById('d_actions');
  if (!r || !body) return;

  /* 底部操作区随页签切换 */
  const seedOnly = r.is_seed && store.user && store.user.role !== 'admin';
  if (state.detailTab === 'overview') {
    acts.innerHTML = `<button class="btn" id="d_edit">编辑</button><button class="btn btn-primary" data-close="detailMask">关闭</button>`;
    const eb = document.getElementById('d_edit');
    if (eb) {
      eb.style.display = seedOnly ? 'none' : '';
      eb.onclick = () => openForm(r.id);
    }
    acts.querySelectorAll('[data-close]').forEach(b => { b.onclick = () => closeMask(b.dataset.close); });
    renderOverview(r, body, seedOnly);
    return;
  }

  acts.innerHTML = `<button class="btn" id="d_ledgerTv">同行人</button>
    ${seedOnly ? '' : '<button class="btn btn-primary" id="d_ledgerAdd">＋ 记一笔</button>'}`;
  const tv = document.getElementById('d_ledgerTv');
  if (tv) tv.onclick = () => ledger.openTravelersSheet(r, reloadAfterMutation);
  const ad = document.getElementById('d_ledgerAdd');
  if (ad) ad.onclick = () => ledger.openExpenseSheet(r, null, reloadAfterMutation);

  if (state.detailTab === 'ledger') {
    ledger.renderLedgerTab(body, r, reloadAfterMutation);
  } else {
    body.innerHTML = '<div class="empty">加载结算…</div>';
    ledger.renderSettleTab(body, r, reloadAfterMutation).then(() => {
      /* 结算页的「去记流水」：切回流水页签 */
      body.querySelectorAll('.toolbar #stGoLedger').forEach(b => {
        b.onclick = () => { state.detailTab = 'ledger'; paintDetailTabs(); renderDetailTab(); };
      });
    });
  }
}

function renderOverview(r, body, seedOnly) {
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
  h += `<div class="banner" style="margin-top:12px">以上 9 类金额由<b>逐笔流水</b>自动汇总（共 ${parseInt(r.expense_count, 10) || 0} 笔）。
    <div style="margin-top:8px"><button class="btn btn-sm btn-line" id="d_gotoLedger">查看 / 记录流水</button></div></div>`;
  body.innerHTML = h;
  const g = document.getElementById('d_gotoLedger');
  if (g) g.onclick = () => { state.detailTab = 'ledger'; paintDetailTabs(); renderDetailTab(); };

  /* 分享入口：仅本人路线或管理员（示例对普通用户只读，不展示） */
  if (!seedOnly) {
    const sb = document.createElement('div');
    sb.className = 'detail-row';
    sb.style.marginTop = '10px';
    sb.innerHTML = '<span class="k">分享</span><span class="v"><button class="btn btn-sm" id="shareBtn">生成只读链接</button></span>';
    body.appendChild(sb);
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
  /* 详情的三个页签与底部按钮由 renderDetailTab() 动态生成，编辑入口在开放时绑定 */
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => closeMask(b.dataset.close));
  document.querySelectorAll('.mask').forEach(m => m.onclick = e => { if (e.target === m) closeMask(m.id); });
  /* 流水 / 同行人弹层的静态事件（模块内部一次性绑定） */
  ledger.initLedgerModule();
  /* 日期变化自动计算天数 */
  document.getElementById('f_start_date').addEventListener('change', onDateChange);
  document.getElementById('f_end_date').addEventListener('change', onDateChange);
  /* 行程内容手动编辑时同步「调整」按钮显隐（有内容才可调整） */
  const scenicInput = document.getElementById('f_scenic');
  if (scenicInput) scenicInput.addEventListener('input', syncAiChatBtn);
  /* AI 规划按钮 */
  const aiBtn = document.getElementById('aiPlanBtn');
  if (aiBtn) aiBtn.onclick = aiPlanRoute;
  /* AI 对话调整按钮 */
  const aiChatBtnEl = document.getElementById('aiChatBtn');
  if (aiChatBtnEl) aiChatBtnEl.onclick = openAiChat;
  /* AI 对话面板事件 */
  const aiChatSend = document.getElementById('aiChatSend');
  if (aiChatSend) aiChatSend.onclick = sendAiChatMessage;
  const aiChatInput = document.getElementById('aiChatInput');
  if (aiChatInput) aiChatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendAiChatMessage(); }
  });
  const aiChatApply = document.getElementById('aiChatApply');
  if (aiChatApply) aiChatApply.onclick = applyAiChatResult;
  const aiChatToggle = document.getElementById('aiChatCurrentToggle');
  if (aiChatToggle) aiChatToggle.onclick = toggleAiChatCurrent;
}
