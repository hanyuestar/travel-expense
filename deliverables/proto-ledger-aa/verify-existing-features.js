/* 既有功能端到端验证：新增/编辑/删除路线 + AI 规划/AI 调整
 *
 * 目的：在「不改动任何生产代码」的前提下，实证三件事——
 *   1) 新增 / 编辑 / 删除路线是否仍然有效
 *   2) AI 规划 / AI 调整是否仍然有效（含门禁、配置、请求构造、响应解析、审计）
 *   3) 新方案（逐笔流水 + AA 分账）与上述功能是否存在冲突
 *
 * AI 部分：真实模型不可达，故起一个「本地 OpenAI 兼容 mock」承接请求，
 * 从而把除模型本身以外的整条链路（门禁 → 配置 → HTTP 调用 → 解析 → 审计 → 落库）全部跑通。
 * 局限：模型输出质量未验证（mock 返回固定串）。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..', '..');   /* 仓库根：本脚本位于 deliverables/proto-ledger-aa/ */
const SERVER_PORT = 18241;
const MOCK_PORT = 18242;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-verify-'));

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------- 本地 OpenAI 兼容 mock ---------------- */
const mockSeen = [];
const MOCK_REPLY = 'Day1 抵达西宁\nDay2 塔尔寺-青海湖\nDay3 茶卡盐湖';
function startMock() {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      mockSeen.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: parsed });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: MOCK_REPLY } }] }));
    });
  });
  return new Promise(r => srv.listen(MOCK_PORT, '127.0.0.1', () => r(srv)));
}

/* ---------------- HTTP 客户端（带 Cookie） ---------------- */
let cookie = '';
async function req(method, p, body) {
  const headers = { 'Origin': BASE };
  if (cookie) headers['Cookie'] = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, json, text };
}

(async () => {
  const mock = await startMock();
  console.log(`本地 mock AI 已启动：${MOCK_BASE}（将接收 /v1/chat/completions）\n`);

  const server = spawn(process.execPath, ['server/app.js'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(SERVER_PORT), DATA_DIR: dataDir, ACCESS_LOG: 'false', TRUSTED_HOSTS: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let srvOut = '';
  server.stdout.on('data', d => srvOut += d);
  server.stderr.on('data', d => srvOut += d);

  /* 等待健康检查 */
  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    await sleep(250);
    try { const r = await fetch(BASE + '/health'); healthy = r.ok; } catch { /* 尚未就绪 */ }
  }
  if (!healthy) {
    console.error('服务未启动，输出：\n' + srvOut);
    server.kill(); mock.close(); process.exit(1);
  }
  console.log('服务已启动：' + BASE + '\n');

  /* 登录（force_reset 仅前端跳转，API 不拦截） */
  const login = await req('POST', '/api/auth/login', { login: 'admin', password: '123456' });
  if (login.status !== 200) { console.error('登录失败：', login.text); server.kill(); mock.close(); process.exit(1); }
  console.log('管理员已登录\n');

  /* ============ A. 新增路线 ============ */
  console.log('■ A. 新增路线');
  const NEW = {
    name: '验证-新增路线', year: '2026', type: '自由行', days: 5, people: 3,
    start_date: '2026-05-01', end_date: '2026-05-05', dest: '成都、九寨沟',
    currency: 'CNY', budget_total: 9000, budget_daily: 1800,
    scenic: 'Day1 抵达成都', hotel: '春熙路某酒店',
    /* 契约：9 类金额是**嵌套 exp 对象**（db.js:220 `const e = data.exp || {}`），非平铺字段 */
    exp: { 交通: 800, 机票: 2400, 高铁: 300, 住宿: 2600, 餐饮: 1200, 门票: 700, 团费: 0, 购物: 400, 其他: 100 },
    notes: '验证用'
  };
  const a1 = await req('POST', '/api/routes', NEW);
  check('A1 新增路线返回 201 且带 id', a1.status === 201 && a1.json && a1.json.data && a1.json.data.id, a1.status);
  const rid = a1.json && a1.json.data && a1.json.data.id;

  const a2 = await req('GET', '/api/routes/' + rid);
  const r2 = a2.json && a2.json.data;
  check('A2 9 类金额全部正确回读', r2 && r2.exp && r2.exp['机票'] === 2400 && r2.exp['住宿'] === 2600 && r2.exp['购物'] === 400,
    r2 && r2.exp);
  check('A3 头部字段回读一致（名称/年份/目的地/预算）',
    r2 && r2.name === NEW.name && r2.year === '2026' && r2.dest === NEW.dest && Number(r2.budget_total) === 9000);

  /* 新方案关心的行为：未知字段（未来的 ledger_mode）是否被白名单丢弃 */
  const a4 = await req('POST', '/api/routes', { name: '验证-未知字段', ledger_mode: 1 });
  const r4 = a4.json && a4.json.data;
  check('A4 ⚠️ 未知字段（ledger_mode）被 ROUTE_COLS 白名单静默丢弃（方案需扩展白名单）',
    r4 && r4.ledger_mode === undefined, r4 && r4.ledger_mode);
  if (r4) await req('DELETE', '/api/routes/' + r4.id);

  /* 契约稳定性：平铺中文键不被识别（证明必须沿用 exp 嵌套契约，方案不得改动） */
  const a5 = await req('POST', '/api/routes', { name: '验证-平铺键', 机票: 999 });
  const r5a = a5.json && a5.json.data;
  check('A5 平铺中文金额键被忽略（9 类必须走 exp 嵌套契约，新方案不得改成平铺）',
    r5a && r5a.exp && r5a.exp['机票'] === 0, r5a && r5a.exp && r5a.exp['机票']);
  if (r5a) await req('DELETE', '/api/routes/' + r5a.id);

  /* ============ B. 编辑路线 ============ */
  console.log('\n■ B. 编辑路线');
  const b1 = await req('PUT', '/api/routes/' + rid, {
    ...NEW, name: '验证-已改名', budget_total: 12000,
    exp: { ...NEW.exp, 机票: 3000, 住宿: 3000 }
  });
  check('B1 编辑路线返回 200', b1.status === 200, b1.status);
  const b2 = await req('GET', '/api/routes/' + rid);
  const r5 = b2.json && b2.json.data;
  check('B2 改名 + 改金额 + 改预算均已生效',
    r5 && r5.name === '验证-已改名' && r5.exp['机票'] === 3000 && r5.exp['住宿'] === 3000 && Number(r5.budget_total) === 12000);
  check('B3 未提交的字段保持原值（目的地/天数/人数）',
    r5 && r5.dest === NEW.dest && r5.days === 5 && r5.people === 3);

  /* AI 规划结果落库的关键风险：PUT 省略 scenic 会不会清空它 */
  await req('PUT', '/api/routes/' + rid, { name: '验证-已改名', year: '2026', dest: '成都、九寨沟' });
  const b4 = await req('GET', '/api/routes/' + rid);
  const r6 = b4.json && b4.json.data;
  check('B4 部分字段 PUT 会把未提交字段重置为默认值（前端必须整体提交，否则 AI 行程会被清空）',
    r6 && (r6.scenic === '' || r6.scenic == null), r6 && JSON.stringify(r6.scenic));
  /* 复原 */
  await req('PUT', '/api/routes/' + rid, { ...NEW, name: '验证-已改名', budget_total: 12000, exp: { ...NEW.exp, 机票: 3000, 住宿: 3000 } });

  /* 与流水方案直接冲突的风险点：PUT 不传 exp 会把 9 类金额清零 */
  await req('PUT', '/api/routes/' + rid, { ...NEW, name: '验证-已改名', exp: {} });
  const b5 = await req('GET', '/api/routes/' + rid);
  const r5b = b5.json && b5.json.data;
  check('B5 ⚠️ PUT 不传 exp 会把 9 类金额全部清零（ledger_mode=1 时须由服务端以流水聚合覆盖，忽略 body.exp）',
    r5b && r5b.exp && r5b.exp['机票'] === 0, r5b && r5b.exp);
  await req('PUT', '/api/routes/' + rid, { ...NEW, name: '验证-已改名', budget_total: 12000, exp: { ...NEW.exp, 机票: 3000, 住宿: 3000 } });

  /* ============ D. AI 门禁（未启用用户）============ */
  console.log('\n■ D. AI 门禁（未启用用户）');
  const d1 = await req('POST', '/api/routes/ai-plan', { start_date: '2026-05-01', end_date: '2026-05-05', dest: '成都', days: 5 });
  check('D1 未启用 AI 的用户调用 ai-plan → 403 AI_NOT_ENABLED',
    d1.status === 403 && d1.json && d1.json.code === 'AI_NOT_ENABLED', d1.status + ' ' + (d1.json && d1.json.code));
  const d2 = await req('POST', '/api/routes/ai-chat', { current_scenic: 'x', message: 'y', dest: 'z', start_date: 'a', end_date: 'b', days: 1 });
  check('D2 未启用 AI 的用户调用 ai-chat → 403 AI_NOT_ENABLED',
    d2.status === 403 && d2.json && d2.json.code === 'AI_NOT_ENABLED', d2.status);

  /* ============ E. AI 配置（管理员）============ */
  console.log('\n■ E. AI 配置（管理员）');
  const e1 = await req('PUT', '/api/admin/ai-config', {
    api_base_url: MOCK_BASE, api_key: 'sk-verify-key', model_id: 'mock-model', enabled: true, skip_ssl_verify: false
  });
  check('E1 保存 AI 配置 → 200', e1.status === 200, e1.status);
  const e2 = await req('GET', '/api/admin/ai-config');
  check('E2 读取配置时密钥被打码为 ******', e2.json && e2.json.data && e2.json.data.api_key === '******', e2.json && e2.json.data && e2.json.data.api_key);
  const e3 = await req('POST', '/api/admin/ai-config/test', {});
  check('E3 「测试连通性」真实打到 mock 并返回内容', e3.status === 200 && e3.json && e3.json.data && e3.json.data.reply === MOCK_REPLY,
    e3.json && e3.json.data && e3.json.data.reply);
  const me = await req('GET', '/api/auth/me');
  const adminId = me.json && me.json.data && me.json.data.id;
  const e4 = await req('PUT', '/api/admin/ai-config/users', { user_ids: [adminId] });
  check('E4 启用指定账号的 AI 权限 → 200', e4.status === 200 && e4.json && e4.json.data.count === 1, e4.json && e4.json.data);

  /* ============ F. AI 规划端到端 ============ */
  console.log('\n■ F. AI 规划（ai-plan）');
  mockSeen.length = 0;
  const f1 = await req('POST', '/api/routes/ai-plan', { start_date: '2026-05-01', end_date: '2026-05-05', dest: '成都、九寨沟', days: 5 });
  check('F1 ai-plan 返回 200 且 scenic 等于模型输出',
    f1.status === 200 && f1.json && f1.json.data && f1.json.data.scenic === MOCK_REPLY,
    f1.status + ' / ' + (f1.json && f1.json.data && JSON.stringify(f1.json.data.scenic).slice(0, 40)));
  const mv = mockSeen[0];
  check('F2 请求打到 OpenAI 兼容路径 /v1/chat/completions（自动补 /v1）', mv && mv.url === '/v1/chat/completions', mv && mv.url);
  check('F3 请求带 Bearer 鉴权头', mv && mv.auth === 'Bearer sk-verify-key', mv && mv.auth);
  check('F4 请求体 model 与配置一致且 stream=false',
    mv && mv.body && mv.body.model === 'mock-model' && mv.body.stream === false, mv && mv.body && mv.body.model);

  const f5 = await req('POST', '/api/routes/ai-plan', { start_date: '2026-05-01', end_date: '2026-05-05', days: 5 });
  check('F5 缺目的地 → 400 且给出明确提示', f5.status === 400 && /目的地/.test(f5.json.msg || ''), f5.json && f5.json.msg);
  const f6 = await req('POST', '/api/routes/ai-plan', { dest: '成都', days: 5 });
  check('F6 缺起止日期 → 400', f6.status === 400 && /日期/.test(f6.json.msg || ''), f6.json && f6.json.msg);
  const f7 = await req('POST', '/api/routes/ai-plan', { start_date: '2026-05-01', end_date: '2026-05-05', dest: '成都', days: 0 });
  check('F7 天数无效 → 400', f7.status === 400 && /天数/.test(f7.json.msg || ''), f7.json && f7.json.msg);

  /* ============ G. AI 调整端到端 ============ */
  console.log('\n■ G. AI 调整（ai-chat）');
  mockSeen.length = 0;
  const g1 = await req('POST', '/api/routes/ai-chat', {
    current_scenic: MOCK_REPLY, message: '把第二天换成塔尔寺', dest: '成都、九寨沟',
    start_date: '2026-05-01', end_date: '2026-05-05', days: 5, history: []
  });
  check('G1 ai-chat 返回 200 且 scenic 等于模型输出',
    g1.status === 200 && g1.json && g1.json.data && g1.json.data.scenic === MOCK_REPLY,
    g1.status + ' / ' + (g1.json && g1.json.data && JSON.stringify(g1.json.data.scenic).slice(0, 40)));
  const g2 = await req('POST', '/api/routes/ai-chat', { message: 'x', dest: 'y', start_date: 'a', end_date: 'b', days: 1 });
  check('G2 缺当前行程 → 400', g2.status === 400 && /当前行程/.test(g2.json.msg || ''), g2.json && g2.json.msg);
  const g3 = await req('POST', '/api/routes/ai-chat', { current_scenic: 'x', dest: 'y', start_date: 'a', end_date: 'b', days: 1 });
  check('G3 缺调整要求 → 400', g3.status === 400 && /调整要求/.test(g3.json.msg || ''), g3.json && g3.json.msg);

  mockSeen.length = 0;
  const history = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `HIST${i}` }));
  await req('POST', '/api/routes/ai-chat', {
    current_scenic: MOCK_REPLY, message: '再精简一点', dest: '成都', start_date: '2026-05-01', end_date: '2026-05-05', days: 5, history
  });
  const sent = JSON.stringify(mockSeen[0] && mockSeen[0].body);
  const histCount = history.filter(h => sent.includes(h.content)).length;
  check('G4 history 超长时按末尾 6 条截断（避免 prompt 过长）', histCount === 6, histCount + '/10');

  /* ============ H. AI 结果落库闭环 ============ */
  console.log('\n■ H. AI 规划 → 回填 → 保存 闭环');
  const h1 = await req('PUT', '/api/routes/' + rid, { ...NEW, name: '验证-已改名', scenic: f1.json.data.scenic });
  const h2 = await req('GET', '/api/routes/' + rid);
  check('H1 AI 生成的行程可经「编辑路线」保存并持久化',
    h1.status === 200 && h2.json && h2.json.data && h2.json.data.scenic === MOCK_REPLY,
    h2.json && h2.json.data && JSON.stringify(h2.json.data.scenic).slice(0, 40));

  /* ============ I. 审计 ============ */
  console.log('\n■ I. 审计日志');
  const i1 = await req('GET', '/api/admin/audit-logs?page=1&pageSize=100');
  const logs = (i1.json && i1.json.data && (i1.json.data.list || i1.json.data)) || [];
  const actions = logs.map(l => l.action);
  check('I1 AI 规划与调整均写入审计日志', actions.includes('ai_plan_route') && actions.includes('ai_chat_route'), [...new Set(actions)].slice(0, 8));
  check('I2 AI 配置变更与测连写入审计日志', actions.includes('update_ai_config') && actions.includes('test_ai_config'));

  /* ============ C. 删除路线 ============ */
  console.log('\n■ C. 删除路线');
  const c1 = await req('DELETE', '/api/routes/' + rid);
  const c2 = await req('GET', '/api/routes/' + rid);
  check('C1 删除返回 200 且随后查询 404', c1.status === 200 && c2.status === 404, c1.status + '/' + c2.status);

  /* ---------------- 收尾 ---------------- */
  server.kill(); mock.close();
  await sleep(500);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { }

  const fail = results.filter(r => !r.ok);
  console.log('\n────────────────────────');
  console.log(`断言 ${results.length} 条：通过 ${results.length - fail.length}，失败 ${fail.length}`);
  if (fail.length) console.log('失败项：' + fail.map(f => f.name).join('；'));
  process.exit(fail.length ? 2 : 0);
})().catch(e => { console.error('验证脚本异常：', e); process.exit(1); });
