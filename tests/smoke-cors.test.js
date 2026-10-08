/* 冒烟测试：CORS 预检与写方法白名单
 * 运行：node tests/smoke-cors.test.js
 * 背景：APP（Capacitor WebView，源 http://localhost）以跨域方式访问自托管服务器。
 *      前端「修改流水 / 同行人」走 PATCH —— 若 Access-Control-Allow-Methods 未包含 PATCH，
 *      预检失败 → fetch 抛 TypeError → 用户看到「网络连接失败/证书不受信任」（浏览器同源无预检，故不受影响）。
 * 覆盖：预检返回的方法是否覆盖前端实际用到的全部写方法；允许来源回显；未允许来源不下发 CORS 头。
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER = path.join(__dirname, '..', 'server', 'app.js');
const PORT = 3909;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'te-cors-'));
const ALLOW_ORIGIN = 'http://localhost';
/* 前端实际使用的写方法（见 public/assets/api.js 的 api 对象） */
const REQUIRED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; const m = (extra !== undefined ? ' got=' + JSON.stringify(extra) : ''); failures.push(name + m); console.log('  ❌ ' + name + m); }
}
function section(t) { console.log('\n■ ' + t); }

async function main() {
  const srv = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR, ALLOWED_ORIGINS: ALLOW_ORIGIN }, stdio: 'ignore'
  });
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/health')).status === 200) { up = true; break; } } catch (e) { /* retry */ }
    await new Promise(res => setTimeout(res, 200));
  }
  check('服务启动（ALLOWED_ORIGINS=' + ALLOW_ORIGIN + '）', up);
  if (!up) { srv.kill(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); process.exit(1); }

  try {
    section('预检（Access-Control-Allow-Methods 必须覆盖前端全部写方法）');
    const pre = await fetch(BASE + '/api/routes/x/expenses/y', {
      method: 'OPTIONS',
      headers: { Origin: ALLOW_ORIGIN, 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'content-type' }
    });
    const acam = (pre.headers.get('access-control-allow-methods') || '').toUpperCase();
    const acao = pre.headers.get('access-control-allow-origin');
    const acac = pre.headers.get('access-control-allow-credentials');
    check('OPTIONS 预检 204', pre.status === 204, pre.status);
    check('回显 Origin', acao === ALLOW_ORIGIN, acao);
    check('允许携带凭证', acac === 'true', acac);
    for (const m of REQUIRED_METHODS) check('Allow-Methods 含 ' + m, acam.split(',').map(s => s.trim()).includes(m), acam);

    section('未在允许列表的来源');
    const bad = await fetch(BASE + '/api/public/site', { headers: { Origin: 'http://evil.example' } });
    check('不下发 Access-Control-Allow-Origin', !bad.headers.get('access-control-allow-origin'), bad.headers.get('access-control-allow-origin'));

    section('允许来源的写请求不被同源校验拦截');
    const w = await fetch(BASE + '/api/routes/nonexistent/expenses/none', {
      method: 'PATCH', headers: { Origin: ALLOW_ORIGIN, 'Content-Type': 'application/json' }, body: '{}'
    });
    const body = await w.json().catch(() => null);
    check('非 403 BAD_ORIGIN（放行到鉴权层）', !(w.status === 403 && body && body.code === 'BAD_ORIGIN'), { status: w.status, code: body && body.code });

    section('未允许来源的写请求应被拒绝');
    const w2 = await fetch(BASE + '/api/routes/nonexistent/expenses/none', {
      method: 'PATCH', headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' }, body: '{}'
    });
    const b2 = await w2.json().catch(() => null);
    check('返回 403 BAD_ORIGIN', w2.status === 403 && b2 && b2.code === 'BAD_ORIGIN', { status: w2.status, code: b2 && b2.code });
  } finally {
    srv.kill();
    setTimeout(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }), 300);
  }

  console.log('\n===== CORS 冒烟结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  if (failures.length) { console.log('失败项：\n- ' + failures.join('\n- ')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
