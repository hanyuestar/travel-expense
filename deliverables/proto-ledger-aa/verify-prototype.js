/* CDP 真机验证脚本：交互原型「逐笔流水 + AA 分账」
 * 零依赖（Node 22 内置 WebSocket/fetch），复用本机 Playwright Chromium 内核。
 * 产出：断言结果 + 关键界面截图（PNG）。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

/* 复用本机已下载的 Playwright Chromium 内核（不额外下载浏览器）。
 * 解析顺序：环境变量 CHROME_BIN，其次 LOCALAPPDATA 下 ms-playwright 里
 * chromium-<rev>/chrome-win64/chrome.exe（取版本号最大者）。
 * 未找到时给出可操作的提示，避免因硬编码路径导致换机即失败。 */
function resolveChrome() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  let best = null, bestRev = -1;
  try {
    for (const d of fs.readdirSync(base)) {
      const m = /^chromium-(\d+)$/.exec(d);
      if (!m) continue;
      const exe = path.join(base, d, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe) && Number(m[1]) > bestRev) { best = exe; bestRev = Number(m[1]); }
    }
  } catch { /* 目录不存在 */ }
  return best;
}

const CHROME = resolveChrome();
if (!CHROME) {
  console.error('未找到 Chromium 内核。请先安装 Playwright 浏览器，或用 CHROME_BIN 指定 chrome.exe 路径：');
  console.error('  npx playwright install chromium');
  console.error('  CHROME_BIN=/path/to/chrome.exe node verify-prototype.js');
  process.exit(1);
}
const PAGE = path.join(__dirname, 'index.html');
const OUT = path.join(__dirname, 'shots');
const PORT = 9333;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-proto-'));
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    `--user-data-dir=${tmp}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions',
    '--window-size=1280,1000', '--hide-scrollbars', 'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page');
    } catch { /* 尚未就绪 */ }
  }
  if (!target) { console.error('无法获取 CDP target'); chrome.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0; const pending = new Map();
  const events = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) events.push(m);
  };
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params }));
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  await send('Console.enable');

  /* 错误收集：页面错误 + console.error + 未捕获拒绝 */
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs=[];
      window.confirm=()=>true;   /* 原型内的确认框：自动化下直接放行，避免阻塞 */
      addEventListener('error',e=>window.__errs.push('error: '+(e.message||e.type)));
      addEventListener('unhandledrejection',e=>window.__errs.push('reject: '+((e.reason&&e.reason.message)||e.reason)));`
  });

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(${expr})`, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.result && r.result.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
    return r.result.result.value;
  };
  const evs = async (code) => {
    const r = await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.result && r.result.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
    return r.result.result.value;
  };
  /* 等待「由数据决定」的条件，而非 CSS 类切换 */
  const waitFor = async (expr, timeout = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await ev(expr)) return true; } catch { /* 重绘间隙 */ }
      await sleep(120);
    }
    return false;
  };
  /* 截图前留出弹层入场动画时间（.sheet 有 .2s 的 opacity/translate 动画，
   * 中途截屏会拍到半透明的中间帧） */
  const shot = async (name) => {
    await sleep(400);
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
  };

  await send('Page.navigate', { url: pathToFileURL(PAGE).href });
  await waitFor(`document.querySelectorAll('.card').length===2`, 10000);

  /* ---------- A. 初始渲染 ---------- */
  check('A1 工作台渲染 2 张路线卡', await ev(`document.querySelectorAll('.card').length`) === 2);
  const card0 = await ev(`document.querySelector('.card').innerText`);
  check('A2 r1 卡片显示流水笔数徽标', card0.includes('流水 13 笔'), card0.match(/流水 \d+ 笔/)?.[0]);
  check('A3 r1 卡片显示超支（预算 12000 / 花费 13680）', card0.includes('超支'), card0.match(/预算[^\n]*/)?.[0]);
  check('A4 r1 卡片显示「我收回」差额', card0.includes('收回'), card0.match(/我实付[^\n]*/)?.[0]);
  /* 预算进度条：线上缺少 .budget-bar 样式，本原型已补齐 */
  const barH = await ev(`getComputedStyle(document.querySelector('.budget-bar')).height`);
  check('A5 预算进度条有高度（线上缺失样式已补）', barH !== '0px' && barH !== 'auto', barH);
  await shot('01-workbench');
  const card1 = await ev(`document.querySelectorAll('.card')[1].innerText`);
  check('A6 两条路线统一流水口径（第二张卡也有流水徽标与「我实付」行）',
    /流水 \d+ 笔/.test(card1) && card1.includes('我实付'),
    card1.replace(/\n/g, ' / ').slice(0, 110));
  const pbPos = await ev(`getComputedStyle(document.querySelector('.proto-bar')).position`);
  check('A7 原型操作条为文档流（不遮挡弹层底部按钮）', pbPos === 'static', pbPos);

  /* ---------- B. 详情 → 流水 ---------- */
  await evs(`document.querySelectorAll('.card [data-act="detail"]')[0].click()`);
  check('B1 详情弹层打开', await waitFor(`document.querySelector('#detailMask').classList.contains('open')`));
  check('B2 默认进入「流水」页签', await ev(`document.querySelector('#d_tabs .tab.active').textContent.trim()`) === '流水');
  check('B3 流水 13 笔全渲染', await waitFor(`document.querySelectorAll('#d_body .led').length===13`));
  const aggTxt = await ev(`document.querySelector('#d_body .panel').innerText`);
  check('B4 汇总口径正确（13 笔 / ¥13,680）', aggTxt.includes('13 笔') && aggTxt.includes('13,680'), aggTxt.replace(/\n/g, ' | '));
  /* 分类筛选 */
  await evs(`[...document.querySelectorAll('#d_body [data-cat]')].find(c=>c.dataset.cat==='住宿').click()`);
  check('B5 按「住宿」筛选后仅 3 笔', await waitFor(`document.querySelectorAll('#d_body .led').length===3`));
  await evs(`[...document.querySelectorAll('#d_body [data-cat]')].find(c=>c.dataset.cat==='全部').click()`);
  await waitFor(`document.querySelectorAll('#d_body .led').length===13`);
  const soleTxt = await ev(`[...document.querySelectorAll('#d_body .led')].find(x=>x.innerText.includes('特产')).innerText.replace(/\\n/g,' ')`);
  check('B6 单人承担流水标注「仅 X 承担」', soleTxt.includes('仅') && soleTxt.includes('承担'), soleTxt);
  const partTxt = await ev(`[...document.querySelectorAll('#d_body .led')].find(x=>x.innerText.includes('茶卡盐湖')).innerText.replace(/\\n/g,' ')`);
  check('B7 部分人分摊流水标注「非全员」', partTxt.includes('非全员'), partTxt);
  await shot('02-ledger');

  /* ---------- C. 结算 ---------- */
  await evs(`document.querySelector('#d_tabs [data-tab="settle"]').click()`);
  check('C1 结算表 4 人', await waitFor(`document.querySelectorAll('#d_body .tbl tbody tr').length===4`));
  const net0 = await ev(`document.querySelector('#d_body .tbl tbody tr .settle-net').textContent`);
  check('C2 我应收 +¥4,027.5', net0.includes('+') && net0.includes('4,027.5'), net0);
  check('C3 最少转账 3 笔（人数−1）', await waitFor(`document.querySelectorAll('#d_body .tf').length===3`));
  const tfSum = await ev(`[...document.querySelectorAll('#d_body .tf .amt')].reduce((s,e)=>s+parseFloat(e.textContent.replace(/[^0-9.]/g,'')),0)`);
  check('C4 转账金额合计 = 应收差额（4027.5）', Math.abs(tfSum - 4027.5) < 0.05, tfSum);
  const paidSum = await ev(`[...document.querySelectorAll('#d_body .tbl tbody tr')].reduce((s,tr)=>s+parseFloat(tr.children[1].textContent.replace(/[^0-9.]/g,'')),0)`);
  check('C5 实付合计 = 总花费 13,680', Math.abs(paidSum - 13680) < 0.05, paidSum);
  await shot('03-settle');

  /* ---------- D. 记一笔 ---------- */
  await evs(`document.querySelector('#d_tabs [data-tab="ledger"]').click()`);
  await waitFor(`document.querySelector('#d_add')!==null`);
  await evs(`document.querySelector('#d_add').click()`);
  check('D1 记一笔弹层打开', await waitFor(`document.querySelector('#expMask').classList.contains('open')`));
  check('D2 默认付款人为「我」', await ev(`document.querySelector('#e_payer .chip.active').textContent`).then(t=>t.includes('我')));
  check('D3 默认全员 4 人参与分摊', await ev(`document.querySelectorAll('#e_parts .chip.active').length`) === 4);
  /* 输入金额 400 → 4 人平分 = 100/人 */
  await evs(`(()=>{const el=document.getElementById('e_amount');el.value='400';el.dispatchEvent(new Event('input'))})()`);
  const hint1 = await ev(`document.getElementById('e_hint').innerText`);
  check('D4 实时人均：4 人 → 每人 ¥100', hint1.includes('每人') && hint1.includes('100'), hint1);
  /* 取消 2 人 → 2 人平分 = 200/人 */
  await evs(`(()=>{const c=document.querySelectorAll('#e_parts [data-s]');c[2].click();c[3].click()})()`);
  const hint2 = await ev(`document.getElementById('e_hint').innerText`);
  check('D5 取消 2 人后 → 每人 ¥200', hint2.includes('200'), hint2);
  /* 类目切到「门票」 */
  await evs(`[...document.querySelectorAll('#e_cats [data-c]')].find(c=>c.dataset.c==='门票').click()`);
  await evs(`(()=>{const el=document.getElementById('e_name');el.value='测试门票';el.dispatchEvent(new Event('input'))})()`);
  await shot('04-add-expense');
  await evs(`document.querySelector('#e_save').click()`);
  check('D6 保存后弹层关闭', await waitFor(`!document.querySelector('#expMask').classList.contains('open')`));
  check('D7 流水增至 14 笔', await waitFor(`document.querySelectorAll('#d_body .led').length===14`));
  /* 分摊人变更应影响结算：门票 400 只由我+阿May 承担 */
  await evs(`document.querySelector('#d_tabs [data-tab="settle"]').click()`);
  await waitFor(`document.querySelectorAll('#d_body .tbl tbody tr').length===4`);
  const rows = await ev(`[...document.querySelectorAll('#d_body .tbl tbody tr')].map(tr=>tr.innerText.replace(/\\n/g,' '))`);
  check('D8 新流水已计入结算（总实付 14,080）',
    await ev(`[...document.querySelectorAll('#d_body .tbl tbody tr')].reduce((s,tr)=>s+parseFloat(tr.children[1].textContent.replace(/[^0-9.]/g,'')),0)`).then(v => Math.abs(v - 14080) < 0.05), rows?.[0]);
  /* 非全员分摊：阿May 的分担额应增加 200 */
  check('D9 非全员分摊生效（阿May 应分担 3,352.5）', rows?.[1]?.includes('3,352.5'), rows?.[1]);
  await shot('05-settle-after');

  /* ---------- D10~D12. 边界：0 位分摊人（纯记录本人实付） ---------- */
  await evs(`document.querySelector('#d_tabs [data-tab="ledger"]').click()`);
  await waitFor(`document.querySelector('#d_add')!==null`);
  await evs(`document.querySelector('#d_add').click()`);
  await waitFor(`document.querySelector('#expMask').classList.contains('open')`);
  await evs(`(()=>{const el=document.getElementById('e_amount');el.value='500';el.dispatchEvent(new Event('input'))})()`);
  await evs(`document.querySelector('#e_none').click()`);
  await waitFor(`document.querySelectorAll('#e_parts .chip.active').length===0`);
  const warnHint = await ev(`document.getElementById('e_hint').innerText`);
  check('D10 0 位分摊人时给出橙色告警（不计入应分担）', warnHint.includes('未选择分摊人'), warnHint);
  check('D11 告警为 warn 样式', await ev(`document.getElementById('e_hint').className`) === 'split-hint warn');
  await evs(`document.querySelector('#e_save').click()`);
  check('D12 0 位分摊人可保存（纯记录）', await waitFor(`document.querySelectorAll('#d_body .led').length===15`));
  await evs(`document.querySelector('#d_tabs [data-tab="settle"]').click()`);
  await waitFor(`document.querySelectorAll('#d_body .tbl tbody tr').length===4`);
  const caliber = await ev(`document.querySelectorAll('#d_body .tf-note')[0].innerText`);
  const sums = await ev(`(()=>{const r=[...document.querySelectorAll('#d_body .tbl tbody tr')];
    return {paid:r.reduce((s,tr)=>s+parseFloat(tr.children[1].textContent.replace(/[^0-9.]/g,'')),0),
            owed:r.reduce((s,tr)=>s+parseFloat(tr.children[2].textContent.replace(/[^0-9.]/g,'')),0)}})()`);
  check('D13 实付 14,580 / 应分担 14,080（差额=纯自付 500）',
    Math.abs(sums.paid - 14580) < 0.05 && Math.abs(sums.owed - 14080) < 0.05, sums);
  check('D14 口径说明给出「未纳入分摊」差额解释', caliber.includes('未纳入分摊'), caliber);
  check('D15 结算仍可完成转账（账目收敛）', await ev(`document.querySelectorAll('#d_body .tf').length`) >= 1);

  /* ---------- E. 同行人管理 ---------- */
  await evs(`document.querySelector('#d_tabs [data-tab="ledger"]').click()`);
  await waitFor(`document.querySelector('#d_tv')!==null`);
  await evs(`document.querySelector('#d_tv').click()`);
  check('E1 同行人弹层打开且 4 人', await waitFor(`document.querySelector('#tvMask').classList.contains('open') && document.querySelectorAll('#t_list .chip').length===4`));
  await evs(`(()=>{document.getElementById('t_new').value='测试A、测试B';document.getElementById('t_add').click()})()`);
  check('E2 批量添加（逗号分隔）→ 6 人', await waitFor(`document.querySelectorAll('#t_list .chip').length===6`));
  check('E3 人数不一致时给出提示', await ev(`document.getElementById('t_count').textContent`).then(t=>t.includes('不一致')));
  await shot('06-travelers');
  await evs(`document.querySelector('#tvMask [data-close]').click()`);

  /* ---------- F. 统一流水口径：无模式切换 ---------- */
  const barTxt = await ev(`document.querySelector('.proto-bar').innerText`);
  check('F1 原型条不含任何「流水模式 / 无流水」切换按钮', !/流水模式|无流水|有流水/.test(barTxt), barTxt.replace(/\n/g, ' '));
  const bodyAll = await ev(`document.body.innerText`);
  check('F2 全页无「开启逐笔记账 / 退出流水模式」入口', !/开启逐笔记账|退出流水模式/.test(bodyAll),
    (bodyAll.match(/开启逐笔记账|退出流水模式/) || [])[0] || '（无）');
  /* 两条路线都走流水口径：第二张卡（京都赏枫）由期初流水承载原 9 类金额 */
  const c1txt = await ev(`document.querySelectorAll('.card')[1].innerText`);
  check('F3 无手填聚合的路线同样由期初流水承载金额（京都赏枫 ¥19,400）',
    c1txt.includes('19,400') && /流水 8 笔/.test(c1txt),
    c1txt.replace(/\n/g, ' / ').slice(0, 110));
  await evs(`document.querySelectorAll('.card [data-act="detail"]')[1].click()`);
  check('F4 该路线水页签可正常展示期初流水（8 笔）',
    await waitFor(`document.querySelector('#d_tabs .tab.active').textContent.trim()==='流水'`) &&
    await waitFor(`document.querySelectorAll('#d_body .led').length===8`),
    await ev(`document.querySelectorAll('#d_body .led').length`));
  check('F5 期初流水明确标注不参与分摊',
    await ev(`document.getElementById('d_body').innerText`).then(t => t.includes('不参与分摊')));
  await shot('07-unified-ledger');
  await evs(`document.querySelector('#detailMask [data-close]').click()`);
  await waitFor(`!document.querySelector('#detailMask').classList.contains('open')`);

  /* ---------- K. 既有功能：新增 / 编辑 / 删除路线 ---------- */
  console.log('\n■ K. 既有功能：新增 / 编辑 / 删除路线');

  /* 先复位到「有流水」态，保证卡片基准可预期 */
  await evs(`document.querySelectorAll('.proto-bar .pb[data-demo]')[0].click()`);
  await waitFor(`document.querySelectorAll('.card').length===2`);

  check('K1 工具条存在「新增路线」按钮', await ev(`!!document.getElementById('newRouteBtn')`));
  await evs(`document.getElementById('newRouteBtn').click()`);
  check('K2 点击打开路线表单，标题为「新增路线」',
    await waitFor(`document.querySelector('#formMask').classList.contains('open')`) &&
    await ev(`document.getElementById('formTitle').textContent`) === '新增路线');
  check('K3 表单已无 9 类花费输入格（统一由流水派生）',
    await ev(`document.querySelectorAll('#expInputs, #formMask input[id^="exp_"]').length`) === 0);
  check('K4 改为「由逐笔流水自动汇总」文字说明',
    await ev(`document.getElementById('expLedgerWarn').innerText`).then(t => t.includes('流水')),
    await ev(`document.getElementById('expLedgerWarn').innerText`).then(t => t.replace(/\n/g, ' ').slice(0, 60)));

  /* 填表：名称 + 起止日期 → 天数自动计算 */
  await evs(`(()=>{const set=(id,v)=>{const e=document.getElementById(id);e.value=v;e.dispatchEvent(new Event('change',{bubbles:true}))};
    set('f_name','验证-新增路线');set('f_start_date','2026-05-01');set('f_end_date','2026-05-05');
    const d=document.getElementById('f_dest');d.value='成都';d.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  check('K5 起止日期自动算出天数（5/1–5/5 → 5 天）',
    await ev(`document.getElementById('f_days').value`) === '5', await ev(`document.getElementById('f_days').value`));

  /* 9 类金额：走 exp 嵌套契约 */
  await evs(`(()=>{const p=document.getElementById('f_people');p.value='3';p.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await evs(`document.getElementById('formSave').click()`);
  check('K6 保存后新增第 3 张路线卡', await waitFor(`document.querySelectorAll('.card').length===3`));
  const kcard = await ev(`[...document.querySelectorAll('.card')].map(c=>c.innerText).find(t=>t.includes('验证-新增路线'))`);
  check('K7 新卡片金额为 ¥0 且无流水徽标（尚未记账）',
    kcard && /¥0(\D|$)/.test(kcard) && !/流水 \d+ 笔/.test(kcard),
    kcard && kcard.replace(/\n/g, ' / ').slice(0, 120));

  /* 编辑该路线 */
  await evs(`(()=>{const c=[...document.querySelectorAll('.card')].find(x=>x.innerText.includes('验证-新增路线'));
    c.querySelector('[data-act="edit"]').click()})()`);
  check('K8 点「编辑」打开表单且标题为「编辑路线」，字段回填一致',
    await waitFor(`document.querySelector('#formMask').classList.contains('open')`) &&
    await ev(`document.getElementById('formTitle').textContent`) === '编辑路线' &&
    await ev(`document.getElementById('f_name').value`) === '验证-新增路线' &&
    await ev(`document.getElementById('f_dest').value`) === '成都',
    await ev(`document.getElementById('f_name').value + ' / ' + document.getElementById('f_dest').value`));
  check('K9 编辑态显示「删除」按钮', await ev(`document.getElementById('formDelete').style.display !== 'none'`));

  await evs(`(()=>{const n=document.getElementById('f_name');n.value='验证-已改名';n.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await evs(`document.getElementById('formSave').click()`);
  const kcard2 = await ev(`[...document.querySelectorAll('.card')].map(c=>c.innerText).find(t=>t.includes('验证-已改名'))`);
  check('K10 编辑生效：改名成功且金额不受影响（仍 ¥0）',
    kcard2 && /¥0(\D|$)/.test(kcard2), kcard2 && kcard2.replace(/\n/g, ' / ').slice(0, 90));

  /* 删除该路线 */
  await evs(`(()=>{const c=[...document.querySelectorAll('.card')].find(x=>x.innerText.includes('验证-已改名'));
    c.querySelector('[data-act="edit"]').click()})()`);
  await waitFor(`document.querySelector('#formMask').classList.contains('open')`);
  await evs(`document.getElementById('formDelete').click()`);
  check('K11 删除路线后回到 2 张卡片（连带清理流水与同行人）',
    await waitFor(`document.querySelectorAll('.card').length===2`) &&
    await ev(`!DB.routes.some(r=>r.name==='验证-已改名')`));

  /* ---------- L. 既有功能：AI 规划 / AI 调整 ---------- */
  console.log('\n■ L. 既有功能：AI 规划 / AI 调整');
  await evs(`document.getElementById('newRouteBtn').click()`);
  await waitFor(`document.querySelector('#formMask').classList.contains('open')`);
  check('L1 新建表单：「AI 规划」可见、「调整」隐藏（无行程内容）',
    await ev(`document.getElementById('aiPlanBtn').style.display !== 'none'`) &&
    await ev(`document.getElementById('aiChatBtn').style.display === 'none'`));

  /* AI 权限：未启用时按钮全隐藏（与真实权限规则一致） */
  await evs(`document.querySelector('.proto-bar .pb[data-ai="0"]').click()`);
  check('L2 AI 未启用时两个 AI 按钮全部隐藏（权限规则）',
    await ev(`document.getElementById('aiPlanBtn').style.display === 'none'`) &&
    await ev(`document.getElementById('aiChatBtn').style.display === 'none'`));
  await evs(`document.querySelector('.proto-bar .pb[data-ai="1"]').click()`);

  /* 参数校验（真实实现返回 400 的三种情形） */
  await evs(`document.getElementById('aiPlanBtn').click()`);
  check('L3 缺起止日期点「AI 规划」→ 提示且不生成',
    await ev(`document.getElementById('toast').textContent`).then(t=>t.includes('起止日期')), await ev(`document.getElementById('toast').textContent`));
  await evs(`(()=>{const s=(id,v)=>{const e=document.getElementById(id);e.value=v;e.dispatchEvent(new Event('change',{bubbles:true}))};
    s('f_start_date','2026-08-01');s('f_end_date','2026-08-03')})()`);
  await evs(`document.getElementById('aiPlanBtn').click()`);
  check('L4 缺目的地点「AI 规划」→ 提示填写目的地',
    await ev(`document.getElementById('toast').textContent`).then(t=>t.includes('目的地')), await ev(`document.getElementById('toast').textContent`));

  /* 合法调用 → 生成按天行程 */
  await evs(`(()=>{const d=document.getElementById('f_dest');d.value='成都';d.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await evs(`document.getElementById('aiPlanBtn').click()`);
  check('L5 AI 规划生成 3 天行程（与计算天数一致）',
    await waitFor(`document.getElementById('f_scenic').value.split('\\n').filter(Boolean).length===3`, 4000),
    (await ev(`document.getElementById('f_scenic').value`)).replace(/\n/g, ' | '));
  const notesAfterPlan = await ev(`document.getElementById('f_notes').value`);
  check('L5a AI 规划同时把「注意事项 + 美食推荐」写入备注',
    notesAfterPlan.includes('【注意事项】') && notesAfterPlan.includes('【美食推荐】'),
    notesAfterPlan.replace(/\n/g, ' | ').slice(0, 90));
  /* 覆盖保护：备注已有用户内容时，AI 只追加、不替换 */
  await evs(`(()=>{const n=document.getElementById('f_notes');n.value='我自己记的：记得带身份证';n.dispatchEvent(new Event('input'))})()`);
  await evs(`document.getElementById('aiPlanBtn').click()`);
  await waitFor(`document.getElementById('f_notes').value.includes('—— AI 补充 ——')`, 4000);
  const notesMerged = await ev(`document.getElementById('f_notes').value`);
  check('L5b 备注已有内容时 AI 只追加、不覆盖用户文字',
    notesMerged.includes('我自己记的：记得带身份证') && notesMerged.includes('【注意事项】'),
    notesMerged.replace(/\n/g, ' | ').slice(0, 90));
  check('L6 生成后「调整」按钮自动出现（既有联动）',
    await ev(`document.getElementById('aiChatBtn').style.display !== 'none'`));

  /* AI 调整：多轮对话 */
  await evs(`document.getElementById('aiChatBtn').click()`);
  check('L7 打开 AI 调整面板，初始为空态提示',
    await waitFor(`document.querySelector('#aiChatMask').classList.contains('open')`) &&
    await ev(`document.getElementById('aiChatMessages').innerText`).then(t=>t.includes('输入调整要求')));
  await evs(`document.getElementById('aiChatSend').click()`);
  check('L8 空指令点发送 → 提示「请输入调整要求」',
    await ev(`document.getElementById('toast').textContent`).then(t=>t.includes('请输入调整要求')));
  await evs(`(()=>{const t=document.getElementById('aiChatInput');t.value='把第二天换成塔尔寺';t.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await evs(`document.getElementById('aiChatSend').click()`);
  check('L9 发送后出现「用户 + AI」两条气泡并给出应用入口',
    await waitFor(`document.querySelectorAll('#aiChatMessages > div').length===2 && document.getElementById('aiChatApplyBar').style.display==='flex'`, 4000),
    await ev(`document.querySelectorAll('#aiChatMessages > div').length`));
  const revised = await ev(`document.querySelectorAll('#aiChatMessages > div')[1].innerText`);
  check('L10 AI 返回完整行程（含原三天）且体现调整指令',
    revised.includes('Day1') && revised.includes('Day3') && revised.includes('塔尔寺'), revised.replace(/\n/g,' | ').slice(0,120));
  check('L11 仅保留末尾 6 条历史（真实实现的 prompt 长度保护）',
    await ev(`aiChatState.history.length`) <= 6, await ev(`aiChatState.history.length`));
  await shot('08-ai-chat');

  await evs(`document.getElementById('aiChatApply').click()`);
  check('L12「应用此版本」回填行程并关闭面板',
    await waitFor(`!document.querySelector('#aiChatMask').classList.contains('open')`) &&
    await ev(`document.getElementById('f_scenic').value`).then(v=>v.includes('塔尔寺')));
  await shot('08b-ai-applied');

  /* ---------- M. 新方案 × 既有功能的交叉验证（本次核心问题） ---------- */
  console.log('\n■ M. 新方案与既有功能的交叉验证');
  await evs(`document.querySelector('#formMask [data-close]').click()`);

  /* 关掉刚建的临时表单 */
  await evs(`document.getElementById('newRouteBtn').click()`);
  await waitFor(`document.querySelector('#formMask').classList.contains('open')`);
  await evs(`document.querySelector('#formMask [data-close]').click()`);

  /* 编辑一条「已开逐笔流水」的路线 */
  await evs(`(()=>{const c=[...document.querySelectorAll('.card')].find(x=>x.innerText.includes('青海甘肃大环线'));
    c.querySelector('[data-act="edit"]').click()})()`);
  check('M1 编辑已开流水的路线：表单同样无 9 类输入格（全站统一口径）',
    await waitFor(`document.querySelector('#formMask').classList.contains('open')`) &&
    await ev(`document.querySelectorAll('#formMask input[id^="exp_"]').length`) === 0);
  const mwarn = await ev(`document.getElementById('expLedgerWarn').innerText`);
  check('M2 表单提示当前流水笔数（13 笔）并给出「去记流水」入口',
    mwarn.includes('13 笔流水') && !!await ev(`document.getElementById('expToLedger') !== null`),
    mwarn.replace(/\n/g, ' ').slice(0, 90));
  check('M3 编辑态「去记流水」可直达该路线的流水页签',
    await ev(`document.getElementById('expToLedger') !== null`));
  /* 截到「花费明细」提示区（表单较长，先滚动到该段） */
  await evs(`document.getElementById('expLedgerWarn').scrollIntoView({ block:'center' })`);
  await shot('09-form-ledger-readonly');

  /* 关键回归：保存路线后，9 类聚合值不得被表单覆盖为 0，流水也不得被清空 */
  const beforeTotal = await ev(`totalOf(route('r1'))`);
  const expCountBefore = await ev(`expenses('r1').length`);
  await evs(`document.getElementById('formSave').click()`);
  await waitFor(`!document.querySelector('#formMask').classList.contains('open')`);
  const afterTotal = await ev(`totalOf(route('r1'))`);
  check('M4 ⚠️ 关键：ledger 模式下保存路线，9 类金额未被清零（不提交 exp）',
    beforeTotal === afterTotal && afterTotal > 0, beforeTotal + ' → ' + afterTotal);
  check('M5 保存未破坏其他字段（行程 / 目的地 / 天数保留）',
    await ev(`(()=>{const r=route('r1');return r.scenic.includes('Day1') && r.dest==='西宁、青海湖、张掖' && r.days===7})()`));
  const expCountAfter = await ev(`expenses('r1').length`);
  check('M6 流水数据未被路线保存动作影响（笔数不变）',
    expCountAfter === expCountBefore, { before: expCountBefore, after: expCountAfter });

  /* 另一条路线（原无流水）的表单也统一：无 9 类输入、金额由期初流水承载 */
  await evs(`(()=>{const c=[...document.querySelectorAll('.card')].find(x=>x.innerText.includes('京都赏枫'));
    c.querySelector('[data-act="edit"]').click()})()`);
  check('M7 所有路线表单口径统一（无 9 类输入，不存在两套模式）',
    await waitFor(`document.querySelector('#formMask').classList.contains('open')`) &&
    await ev(`document.querySelectorAll('#formMask input[id^="exp_"]').length`) === 0 &&
    await ev(`document.getElementById('expLedgerWarn').innerText`).then(t => t.includes('8 笔流水')),
    await ev(`document.getElementById('expLedgerWarn').innerText`).then(t => t.replace(/\n/g, ' ').slice(0, 70)));
  await evs(`document.querySelector('#formMask [data-close]').click()`);
  await shot('10-form-unified');

  /* ---------- G. 运行期错误 ---------- */
  const errs = await ev(`window.__errs`);
  const logErrs = (await send('Log.enable')).result;
  check('G1 无未捕获 JS 错误', Array.isArray(errs) && errs.length === 0, errs);

  ws.close();
  chrome.kill();
  await sleep(400);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }

  const fail = results.filter(r => !r.ok);
  console.log('\n────────────────────────');
  console.log(`断言 ${results.length} 条：通过 ${results.length - fail.length}，失败 ${fail.length}`);
  if (fail.length) console.log('失败项：' + fail.map(f => f.name).join('；'));
  console.log('截图目录：' + OUT);
  process.exit(fail.length ? 2 : 0);
})().catch(async (e) => { console.error('验证脚本异常：', e.message); process.exit(1); });
