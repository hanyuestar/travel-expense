/* main.js — 入口：hash 路由 + 守卫 + 全局事件（ES Module） */
import { store, toast, api, navigate, fetchMe, applyAuth, renderHeader } from './api.js';
import { initAuth, renderLogin, renderRegister } from './auth.js';
import { loadRoutes, renderWorkbench, renderStats, renderProfile, bindFormEvents } from './app.js';
import { renderAdmin, bindAdminEvents } from './admin.js';

async function guard() {
  const route = location.hash || '#/workbench';
  const u = store.user;

  if (route.startsWith('#/login') || route.startsWith('#/register')) {
    if (u) { navigate('/workbench'); return false; }
    return true;
  }
  if (!u) { navigate('/login'); return false; }
  if (route.startsWith('#/admin') && u.role !== 'admin') { toast('无权限'); navigate('/workbench'); return false; }
  return true;
}

async function render() {
  if (!(await guard())) return;
  const route = location.hash || '#/workbench';
  renderHeader();   // 同步顶部用户区（已登录显示菜单，未登录隐藏）

  if (route.startsWith('#/login')) { renderLogin(); return; }
  if (route.startsWith('#/register')) { renderRegister(); return; }
  if (route.startsWith('#/profile')) { renderProfile(); return; }
  if (route.startsWith('#/admin')) { renderAdmin(); return; }

  /* 默认工作台 */
  await loadRoutes();
  renderWorkbench();
  renderStats();
}

async function init() {
  /* 顶部固定骨架在 index.html 中；先拉站点信息与登录态 */
  await initAuth();
  await fetchMe();
  renderHeader();
  bindHeaderEvents();
  bindFormEvents();
  bindAdminEvents();

  window.addEventListener('hashchange', render);
  await render();

  /* 心跳：每 5 分钟刷新在线状态 */
  setInterval(async () => {
    if (store.user) { await fetchMe(); }
  }, 5 * 60 * 1000);
}

function bindHeaderEvents() {
  document.getElementById('logoutBtn').onclick = async () => {
    try { await api.post('/auth/logout'); } catch (e) { /* ignore */ }
    store.user = null;
    renderHeader();
    navigate('/login');
  };
  document.getElementById('userMenuBtn').onclick = (e) => {
    e.stopPropagation();
    document.getElementById('userMenu').classList.toggle('open');
  };
  document.getElementById('profileLink').onclick = () => { document.getElementById('userMenu').classList.remove('open'); navigate('/profile'); };
  document.getElementById('adminLink').onclick = () => { document.getElementById('userMenu').classList.remove('open'); navigate('/admin/overview'); };
  document.getElementById('homeLink').onclick = () => navigate('/workbench');
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu')) document.getElementById('userMenu').classList.remove('open');
  });
}

init();
