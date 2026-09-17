/* v1.0.7 新增能力冒烟：AI 对话式调整 + 分享页导出图片
 * 运行：node deliverables/smoke-v107-new.js
 * 覆盖：AI 配置掩码、测试连接、按用户授权 403、ai-plan、ai-chat（含多轮历史）、
 *       分享页独立 CSP / 导出按钮 / html2canvas 可访问、主应用 CSP 仍无 unsafe-inline
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER = path.join(__dirname, '..', 'server', 'app.js');
const APP_PORT = 3909;
const AI_PORT = 3911;
const BASE = 'http://127.0.0.1:' + APP_PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'te-v107-'));
fs.copyFileSync(path.join(__dirname, '..', 'data', 'routes.json'), path.join(DATA_DIR, 'routes.json'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; const m = extra !== undefined ? ' got=' + JSON.stringify(extra) : ''; failures.push(name + m); console.log('  ❌ ' + name + m); }
}
function section(t) { console.log('\n■ ' + t); }

async function req(method, p, body, cookie) {
  const opt = { method, headers: {} };
  if (body !== undefined && body !== null) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  if (cookie) opt.headers.Cookie = cookie;
  const r = await fetch(BASE + p, opt);
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch (e) { /* non-json */ }
  return { status: r.status, json, text: txt, headers: r.headers, setCookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

/* ---------- Mock OpenAI 兼容服务 ---------- */
const aiCalls = [];
const aiServer = http.createServer((req, res) => {
  let buf = '';
  req.on('data', c => { buf += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(buf || '{}'); } catch (e) { /* ignore */ }
    aiCalls.push({ url: req.url, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock', object: 'chat.completion', created: Date.now(), model: body.model || 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Day1 上午抵达；下午市区；晚上夜市（西宁）' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    }));
  });
});

async function main() {
  await new Promise(r => aiServer.listen(AI_PORT, '127.0.0.1', r));
  const srv = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(APP_PORT), DATA_DIR }, stdio: 'ignore'
  });
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/health')).status === 200) { up = true; break; } } catch (e) { /* retry */ }
    await new Promise(res => setTimeout(res, 200));
  }
  check('服务启动', up);
  if (!up) { srv.kill(); aiServer.close(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); process.exit(1); }

  try {
    /* ---------- 登录 ---------- */
    let r = await req('POST', '/api/auth/login', { login: 'admin', password: '123456' });
    const admin = r.setCookie;
    check('admin 登录', r.status === 200, r.status);
    r = await req('POST', '/api/auth/register', { username: 'frank', password: 'frankpass123' });
    const frank = r.setCookie;
    check('普通用户注册', r.status === 200 || r.status === 201, r.status);

    /* ---------- AI 配置 ---------- */
    section('AI 配置');
    r = await req('PUT', '/api/admin/ai-config', {
      api_base_url: 'http://127.0.0.1:' + AI_PORT + '/v1', api_key: 'sk-test-key',
      model_id: 'mock-model', enabled: true, skip_ssl_verify: false
    }, admin);
    check('保存 AI 配置 200', r.status === 200, r.json || r.text);

    r = await req('GET', '/api/admin/ai-config', null, admin);
    const cfg = (r.json && r.json.data) || {};
    check('读取返回 api_key 已掩码', cfg.api_key === '******', cfg.api_key);
    check('读取返回 model_id 正确', cfg.model_id === 'mock-model', cfg.model_id);
    check('读取返回 skip_ssl_verify 字段', cfg.skip_ssl_verify === 0 || cfg.skip_ssl_verify === false || cfg.skip_ssl_verify === 1, cfg.skip_ssl_verify);

    r = await req('POST', '/api/admin/ai-config/test', {
      api_base_url: 'http://127.0.0.1:' + AI_PORT + '/v1', api_key: 'sk-test-key',
      model_id: 'mock-model', skip_ssl_verify: false
    }, admin);
    check('测试连接成功', r.status === 200 && r.json && r.json.ok === true, r.json || r.text);

    /* ---------- 按用户授权 ---------- */
    section('AI 按用户授权');
    const usersRes = await req('GET', '/api/admin/ai-config/users', null, admin);
    const users = (usersRes.json && usersRes.json.data) || {};
    const list = users.list || users.users || users;
    check('可读取用户授权列表', Array.isArray(list) || typeof users === 'object', Object.keys(users));
    const adminUser = (Array.isArray(list) ? list : []).find(u => u.username === 'admin' || u.is_admin === 1);
    const ids = adminUser ? [adminUser.id] : [];
    r = await req('PUT', '/api/admin/ai-config/users', { user_ids: ids }, admin);
    check('设置授权用户', r.status === 200, r.json || r.text);

    /* ---------- ai-plan / ai-chat ---------- */
    section('AI 规划与对话调整');
    const planBody = {
      dest: '青海湖', start_date: '2026-08-01', end_date: '2026-08-05', days: 5
    };
    r = await req('POST', '/api/routes/ai-plan', planBody, admin);
    check('ai-plan 200 返回景点路线', r.status === 200 && r.json && r.json.data && r.json.data.scenic, r.json || r.text);

    r = await req('POST', '/api/routes/ai-plan', { dest: '青海湖', start_date: '2026-08-01', end_date: '2026-08-05', days: 5 }, frank);
    check('未授权用户 ai-plan → 403 AI_NOT_ENABLED', r.status === 403 && JSON.stringify(r.json || {}).includes('AI_NOT_ENABLED'), r.json || r.text);

    aiCalls.length = 0;
    r = await req('POST', '/api/routes/ai-chat', {
      current_scenic: 'Day1 西宁', message: '把第二天换成塔尔寺',
      dest: '青海湖', start_date: '2026-08-01', end_date: '2026-08-05', days: 5, history: []
    }, admin);
    check('ai-chat 首轮 200 返回行程', r.status === 200 && r.json && r.json.data && r.json.data.scenic, r.json || r.text);
    const firstCall = aiCalls[aiCalls.length - 1];
    check('首轮 messages = system + user（2 条）', firstCall && firstCall.body.messages.length === 2, firstCall && firstCall.body.messages.length);

    r = await req('POST', '/api/routes/ai-chat', {
      current_scenic: 'Day1 西宁', message: '再把第三天精简',
      dest: '青海湖', start_date: '2026-08-01', end_date: '2026-08-05', days: 5,
      history: [{ role: 'user', content: '把第二天换成塔尔寺' }, { role: 'assistant', content: 'Day1 西宁-塔尔寺' }]
    }, admin);
    check('ai-chat 多轮 200', r.status === 200 && r.json && r.json.data && r.json.data.scenic, r.json || r.text);
    const secondCall = aiCalls[aiCalls.length - 1];
    check('多轮 messages = system + 2 历史 + user（4 条）', secondCall && secondCall.body.messages.length === 4, secondCall && secondCall.body.messages.length);
    check('历史 role 透传正确', secondCall && secondCall.body.messages[1].role === 'user' && secondCall.body.messages[2].role === 'assistant', secondCall && secondCall.body.messages.slice(1, 3));

    r = await req('POST', '/api/routes/ai-chat', {
      current_scenic: 'Day1 西宁', message: '', dest: '青海湖',
      start_date: '2026-08-01', end_date: '2026-08-05', days: 5, history: []
    }, admin);
    check('空指令 → 400', r.status === 400, r.json || r.text);

    r = await req('POST', '/api/routes/ai-chat', {
      current_scenic: '', message: '改一下', dest: '青海湖',
      start_date: '2026-08-01', end_date: '2026-08-05', days: 5, history: []
    }, admin);
    check('空行程 → 400', r.status === 400, r.json || r.text);

    r = await req('POST', '/api/routes/ai-chat', {
      current_scenic: 'Day1 西宁', message: '改一下', dest: '青海湖',
      start_date: '2026-08-01', end_date: '2026-08-05', days: 5, history: []
    }, frank);
    check('未授权用户 ai-chat → 403 AI_NOT_ENABLED', r.status === 403 && JSON.stringify(r.json || {}).includes('AI_NOT_ENABLED'), r.json || r.text);

    /* ---------- 审计 ---------- */
    section('审计日志');
    r = await req('GET', '/api/admin/audit-logs?limit=50', null, admin);
    const auditTxt = JSON.stringify(r.json || {});
    check('审计含 update_ai_config', auditTxt.includes('update_ai_config'), r.status);
    check('审计含 test_ai_config', auditTxt.includes('test_ai_config'));
    check('审计含 ai_plan_route', auditTxt.includes('ai_plan_route'));
    check('审计含 ai_chat_route', auditTxt.includes('ai_chat_route'));

    /* ---------- 分享页导出图片 ---------- */
    section('分享页导出图片');
    r = await req('POST', '/api/routes', {
      name: '西北大环线', year: '2026', start_date: '2026-08-01', end_date: '2026-08-05',
      days: 5, people: 2, dest: '青海甘肃', currency: 'CNY', budget_total: 8000,
      scenic: 'Day1 西宁；Day2 塔尔寺', hotel: '全程准四', notes: '注意高反'
    }, admin);
    check('建路线 201', r.status === 201, r.json || r.text);
    const rid = r.json.data.id;
    r = await req('POST', '/api/routes/' + rid + '/share', null, admin);
    const token = r.json.data.token;
    check('生成分享令牌', !!token, r.json || r.text);

    r = await req('GET', '/share/' + token);
    check('分享页 200', r.status === 200, r.status);
    const csp = r.headers.get('content-security-policy') || '';
    check('分享页 CSP script-src 含 unsafe-inline', /script-src[^;]*'unsafe-inline'/.test(csp), csp);
    check('分享页含导出按钮', r.text.includes('exportAsImage') && r.text.includes('导出为图片'));
    check('分享页引用 html2canvas', r.text.includes('/assets/html2canvas.min.js'));
    check('分享卡片带 id="shareCard"', r.text.includes('id="shareCard"'));
    check('分享页仍转义 XSS', !r.text.includes('<script>alert'));

    r = await req('GET', '/assets/html2canvas.min.js');
    const ct = r.headers.get('content-type') || '';
    check('html2canvas 可访问 200', r.status === 200, r.status);
    check('html2canvas MIME 为 javascript', /javascript/.test(ct), ct);
    check('html2canvas 内容完整（>150KB）', r.text.length > 150000, r.text.length);

    const idx = await req('GET', '/');
    const idxCsp = idx.headers.get('content-security-policy') || '';
    check('主应用 CSP script-src 仍不含 unsafe-inline', !/script-src[^;]*'unsafe-inline'/.test(idxCsp), idxCsp);
  } catch (e) {
    fail++; failures.push('异常：' + e.message); console.log('  ❌ 异常：' + e.stack);
  } finally {
    srv.kill(); aiServer.close();
    setTimeout(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }), 300);
  }

  console.log('\n===== v1.0.7 新能力冒烟：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  if (fail) { failures.forEach(f => console.log(' - ' + f)); process.exit(1); }
}

main();
