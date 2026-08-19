/* 补充深测：跨用户越权 404 + 邮箱验证码登录 + 在线状态 + 种子只读边界
 * 依赖主回归已建数据：admin(id1, adminnew123)、alice(id2)、carol(id3)
 * 运行：node regression.deep.test.js <BASE_URL> */
'use strict';
const BASE = process.argv[2] || 'http://127.0.0.1:3900';
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? ' got=' + JSON.stringify(extra) : '')); }
}
async function req(method, path, body, cookie) {
  const opt = { method, headers: {} };
  if (body !== undefined && body !== null) {
    if (typeof body === 'string') opt.body = body;
    else { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  }
  if (cookie) opt.headers.Cookie = cookie;
  const r = await fetch(BASE + path, opt);
  let json = null; try { json = await r.json(); } catch (e) {}
  return { status: r.status, json, setCookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
async function login(login, password) {
  const r = await req('POST', '/api/auth/login', { login, password });
  return r.status === 200 ? r.setCookie : null;
}

async function main() {
  const admin = await login('admin', 'adminnew123');
  const alice = await login('alice', 'alicepass123');
  check('前置：admin 登录', !!admin);
  check('前置：alice 登录', !!alice);

  /* ===== 跨用户越权（核心安全） ===== */
  console.log('\n■ 跨用户数据隔离（§7.2）');
  let r = await req('POST', '/api/routes', { name: 'alice的秘密行程', year: '2026', exp: { 交通: 999 } }, alice);
  const alicePrivate = r.json.data.id;
  check('alice 建私有路线', r.status === 201 && alicePrivate, r);

  r = await req('GET', '/api/routes/' + alicePrivate, null, admin);
  check('admin 访问 alice 私有路线 → 404（不暴露存在性，§4.3）', r.status === 404, r);
  r = await req('GET', '/api/routes', null, admin);
  check('admin 列表不含 alice 私有路线', !(r.json.data.list || []).some(x => x.id === alicePrivate), r);
  r = await req('GET', '/api/routes/' + alicePrivate);
  check('未登录访问他人路线 → 401', r.status === 401, r);

  r = await req('PUT', '/api/routes/' + alicePrivate, { name: '越权改名', exp: {} }, admin);
  check('admin 改 alice 私有路线 → 404（§4.3 不暴露存在性，仅种子可见）', r.status === 404, r);
  r = await req('DELETE', '/api/routes/' + alicePrivate, null, admin);
  check('admin 删 alice 私有路线 → 404（§4.3 不暴露存在性）', r.status === 404, r);

  /* admin 视角也受隔离：admin 新建路线，alice 不可见 */
  r = await req('POST', '/api/routes', { name: 'admin的后台之旅', year: '2026', exp: { 交通: 1 } }, admin);
  const adminPrivate = r.json.data.id;
  r = await req('GET', '/api/routes/' + adminPrivate, null, alice);
  check('alice 访问 admin 私有路线 → 404（双向隔离）', r.status === 404, r);

  /* ===== 在线状态 ===== */
  console.log('\n■ 在线状态（§5.2/§0.2 15min 阈值）');
  r = await req('GET', '/api/admin/users?q=alice', null, admin);
  const aliceRow = r.json.data.list[0];
  check('alice 刚登录 → 在线=true', aliceRow.online === true, aliceRow);
  check('alice 路线数 route_count ≥1', aliceRow.route_count >= 1, aliceRow);

  /* ===== 邮箱验证码登录 ===== */
  console.log('\n■ 邮箱验证码登录（§3.2 方式2）');
  const LOGIN_CODE = process.env.LOGIN_CODE || '';
  if (LOGIN_CODE) {
    r = await req('POST', '/api/auth/login', { login: 'carol@example.com', code: LOGIN_CODE });
    check('邮箱验证码登录成功 → 200 + Set-Cookie（§3.2 方式2）', r.status === 200 && r.json.ok && /^sid=/.test(r.setCookie || ''), r);
    r = await req('POST', '/api/auth/login', { login: 'carol@example.com', code: LOGIN_CODE });
    check('验证码一次性：复用登录 → 401', r.status === 401, r);
  } else {
    console.log('  ⏭  跳过邮箱验证码登录（未注入 LOGIN_CODE）');
  }

  /* ===== 前端静态资源 ===== */
  console.log('\n■ 静态资源（§1.2 nginx 由后端兜底）');
  const r2 = await fetch(BASE + '/');
  check('GET / 返回 index.html', r2.status === 200 && /<html/i.test(await r2.text()));
  const r3 = await fetch(BASE + '/assets/main.js');
  check('GET /assets/main.js 可访问（ES Module）', r3.status === 200 && (await r3.text()).includes('hash 路由'));
  const r4 = await fetch(BASE + '/styles.css');
  check('GET /styles.css 可访问', r4.status === 200);

  console.log(`\n══════════════════════════`);
  console.log(`补充用例：${pass + fail}  通过：${pass}  失败：${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('脚本异常', e); process.exit(2); });
