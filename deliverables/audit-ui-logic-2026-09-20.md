# 前端与项目逻辑审查报告（v1.1.0）

- 日期：2026-09-20
- 范围：`public/`（index.html、styles.css、assets/*.js）、`server/` 接口契约、两端数据流
- 方法：全量通读 + 静态交叉核对（引用计数、口径比对、绑定链追踪）+ 已有真机测试输出复核
- 状态：**仅审查与设计，未进开发**

---

## 一、逻辑错误（按严重度排序）

### A1. 跨路线打开流水页签时「同行人名单串线」— 高
- **证据**：`ledger.js` 的 `st.travelers` 是模块级全局缓存，`renderLedgerTab` 只在 `st.travelers.length === 0` 时才 `loadTravelers(route)`（ledger.js:72）；`openExpenseSheet` 完全不加载、直接使用 `st.travelers`（ledger.js:67-69 附近）。
- **后果**：先后打开路线 A（有同行人）和路线 B 的流水页签时，B 的页面上显示的是 **A 的同行人名单**（列表行的付款人/分摊人姓名、头像色、「同行人（N）」计数全部串线）。在 B 记一笔时选了 A 的人，服务端会拒绝（`INVALID_PAYER`），用户看到的是「明明加了同行人却说不在名单」。
- **旁证**：既有测试输出里已有显现 —— 全新路线「v110 新增验证」（0 同行人）的流水页签显示「同行人（4）」，正是串自前一路线（verify-v110 I4 输出）。
- **注**：`renderSettleTab` 无条件加载（ledger.js:178 附近），故结算页不受影响 —— 同属一个模块、行为不一致，本身就是信号。

### A2. 详情弹窗的流水/结算页签数据不随变更刷新 — 中
- **证据**：`app.js reloadAfterMutation` 仅在 `state.detailTab === 'overview'` 时 `renderDetailTab()`（app.js:65）；流水/结算页签开着时发生任何变更（记一笔、改同行人、删流水）都不会重渲染。
- **后果**：在结算页签点「管理同行人」加人后，结算表仍是旧的；在流水页签内保存流水后，上方汇总面板的「路线总花费」用 `st.route.exp` 快照（ledger.js `routeTotal(st.route)`），金额滞后，需切换页签才更新。
- **注**：演示版 `demo/index.html` 的同行人操作后会调 `renderDetailTab()`，比正式版处理得好 —— 两版行为又不一致。

### A3. 示例路线的「同行人」弹层未按只读处理 — 中
- **证据**：`renderDetailTab` 对示例路线（seedOnly）隐藏了「记一笔」，但「同行人」按钮照常打开 `openTravelersSheet`（app.js:894-895）；弹层内的添加/改名/设为我/移除按钮无 seed 概念，普通用户点击全部 403。
- **后果**：示例数据场景下普通用户面对一堆必然失败的按钮。

### A4. 流水汇总面板「路线总花费」口径快照陈旧 — 低（与 A2 同根）
- `paintLedger` 的「路线总花费 / 人均」读取 `st.route.exp`（打开页签那一刻的对象），页签存续期间后端聚合已变化也不更新。

---

## 二、逻辑冗余

| # | 项 | 证据 |
|---|---|---|
| B1 | 日期区间解析 **4 份**实现 | `api.js parseStart`（排序）、`app.js parseDatesFromRange`（表单回填）、`db.js parseDateRange`（导入）、`routes_api.js parseDate`（趋势聚合）；另有 `buildDateRangeText` 前后端各一份（职责分端，可接受） |
| B2 | **人均口径两套** | `app.js perOf` = 总额 ÷ `route.people`（卡片/概览）；`ledger.js headcount` = 同行人名单优先、人数兜底（流水页）。同一路线登记 2 人但名单 4 人时，**卡片人均 = 总额÷2，流水页人均 = 总额÷4**，同屏两个数 |
| B3 | `ledger.js routeTotal` 与 `charts.js totalOf` 完全重复 | 同一 reduce 逻辑两份 |
| B4 | 死代码 | `api.js addYen`（0 引用）；`ledger.js expHeadcount`、`emptyDays`（无实际价值）；`ledger.js stGoLedger` 的 `te:goto-ledger` CustomEvent 处理器（无人监听，被 app.js:905 事后覆盖）；`server/db.js ledgerStat`（导出后无任何调用方，routes_api 用自写 `expenseCounts`） |
| B5 | expMask/tvMask 关闭绑定重复 | 通用绑定（bindFormEvents）与 `initLedgerModule` 各绑一次，后者覆盖前者（行为相同，属噪音） |
| B6 | demo 整体重复 | 已知并接受（单文件约束），仅登记 |

## 三、UI 不一致

| # | 项 | 现状 |
|---|---|---|
| C1 | 弹窗宽度四种 | formMask 560（默认）/ detailMask 620 / aiChatMask 680 / tvMask 480 |
| C2 | 流水/结算页签底部无「关闭」 | 概览页签有「编辑/关闭」，流水/结算只有「同行人/记一笔」，只能靠 × 或点遮罩关闭 |
| C3 | 同行人配色两套并存 | JS 侧 `TV_COLORS` 与 CSS 侧 `--c0…--c8`（死变量，0 引用） |
| C4 | 详情页签记忆 | 打开另一条路线的详情时停留在上次用过的页签（可能直接落在「结算」） |
| C5 | 文档与实现不一致 | wiki 称「日元/韩元金额无小数」，实现中 `fmt` 恒为两位小数（JPY 显示 `JP¥1,500.00`） |
| C6 | 卡片 miniBar 的 tooltip 无币种 | `title="餐饮 1,500"`（细节） |

## 四、确认无问题项（避免误伤）

- 转义统一且完备（`api.esc` 含单引号，admin 用户数据全部走 esc）；无 XSS 遗漏点。
- 搜索/年份/隐藏示例均正确重置 `state.page = 1`（分页无空页 bug）。
- 登录/注册/详情三处页签复用同一 `.tabs .tab` 组件，样式一致。
- 结算不变量（Σnet=0、笔数≤n−1）有测试守护；示例路线只读矩阵（详情/流水/结算 GET 放行、写 403）已有覆盖。
- 分享页为服务端渲染（`server/app.js`），不在 SPA 路由内，非缺失。

---

## 五、修复设计方案（分期，未开发）

### P0 — 正确性（建议本次就做）
1. **修 A1**：`renderLedgerTab` / `openExpenseSheet` / `renderSettleTab` 三个入口**统一无条件 `await loadTravelers(route)`**（名单数据极小，一次请求无感）；删除 `if (!st.travelers.length)` 条件。根治串线。
2. **修 A2+A4**：`reloadAfterMutation` 中详情开着时**按 `state.detailTab` 无条件 `renderDetailTab()`**（概览/流水/结算一视同仁）；同时 `paintLedger` 的「路线总花费」改由 app.js 传最新 `route` 对象（或页签重渲染时自然拿到新对象）。
3. **修 A3**：`openTravelersSheet(route, onChanged, readOnly)` 增加只读参数（`route.is_seed && 当前用户非 admin` 时隐藏输入框与全部操作按钮，名单保留可看）；入口按钮文案随状态显示「同行人 / 查看同行人」。

### P1 — 口径统一与清理（可随 P0 一并或下一迭代）
4. **修 B2（推荐方案）**：人均分母唯一规则 = 「同行人名单优先，名单为空回退登记人数」。列表接口 `GET /api/routes` 的 SQL 增加 `traveler_count` 分组字段（一次 `GROUP BY`），卡片人均改为 `总额 ÷ max(traveler_count, people)` 的同名规则 —— 一处口径、全端一致。备选：不动接口，卡片保留人数口径但在 UI 文案上区分（「按登记人数」vs「按名单」），成本低但口径仍两套。
5. **收敛 B1**：前端 `parseStart` 与 `parseDatesFromRange` 合并为一个返回 `{start, end, startMs}` 的实现；服务端 `db.parseDateRange` 保留（导入唯一入口），`routes_api.parseDate` 因语义不同（年/月聚合）保留 —— 4 份 → 3 份且前端只剩 1 份。
6. **清理 B3/B4/B5**：删 `addYen`、`expHeadcount`、`emptyDays`、`stGoLedger` 死处理器、`db.ledgerStat`；`initLedgerModule` 的重复绑定删除，统一走通用绑定（initLedgerModule 只保留真正独有的逻辑——目前没有，整个函数可删）。
7. **C1/C2**：弹窗宽度统一 560（tvMask 480 属窄表单，保留并注释）；流水/结算页签底部补「关闭」按钮。
8. **C3**：删 `--c0…--c8` 死变量；`TV_COLORS` 作为名单配色唯一来源并补注释。

### P2 — 体验与文档（可排期）
9. **C4**：`openDetail(id)`（从卡片进入）统一 `state.detailTab = 'overview'`；「去记流水」等内部跳转仍显式指定（现有行为保留）。
10. **C5**：`fmtMoney` 增加零小数币种表（JPY/KRW/VND/IDR 等）按币种取 decimals —— 补实现以兑现 wiki 承诺；改动面 = `api.js` 一处。
11. **C6**：miniBar tooltip 加币种符号。

### 不修/接受项
- demo 整体逻辑重复（单文件 localStorage 版约束，接受）。
- AI 备注幂等采用「已包含即跳过」保守策略（用户手改后不再覆盖，符合预期）。
- 结算转账方案的展示顺序（贪心结果不唯一但合法）。

## 五点五、实施记录（2026-09-20，已按用户确认全部落地）

用户决策：人均口径统一为流水页标准（名单优先、人数兜底），其余按本报告方案修复（P0+P1+P2 全部）。

| 项 | 落地情况 |
|---|---|
| A1 串线 | `renderLedgerTab`/`openExpenseSheet`/`renderSettleTab` 三入口统一强制 `loadTravelers(route)`；`openExpenseSheet` 改异步 |
| A2/A4 页签刷新 | `reloadAfterMutation` 按 `state.detailTab` 无条件 `renderDetailTab()`；`refreshAfterChange` 移除手动 paintLedger（交由外层全量重渲染） |
| A3 只读 | `openTravelersSheet` 内判 `is_seed && 非 admin` → `st.tvReadOnly`：隐藏添加区/操作按钮，空态文案区分；入口按钮未改名（弹层内已足够表达） |
| B2 人均 | 列表接口新增 `travelerCounts(ids)`（与 expenseCounts 同模式）；`perOf` = traveler_count 优先、人数兜底、**不再取整**（显示交给 fmtMoney，与流水页完全一致） |
| B1 日期解析 | `parseDatesFromRange` 移入 api.js 为唯一实现；`parseStart` 改为其薄封装（同源） |
| B3/B4/B5 | 删 `routeTotal`（用 charts.totalOf）、`addYen`、`expHeadcount`、`emptyDays`、`stGoLedger` 死处理器、`db.ledgerStat`、`initLedgerModule`（与通用绑定重复） |
| C1/C2 | 详情/AI 弹窗宽 620/680 → 560（tvMask 480 保留）；流水/结算页签底部补「关闭」 |
| C3 | 删 `--c0…--c8` 死变量；TV_COLORS 为名单配色唯一来源 |
| C4 | `openDetail` 无条件回「概览」（demo 同步） |
| C5 | `fmt(n, dec)` + `ZERO_DECIMAL_CUR`（JPY/KRW/VND/IDR），`fmtMoney` 按币种取小数位 |
| C6 | miniBar tooltip 改用 fmtMoney（含币种） |

验证：verify-v110 **53/53**（新增 A0 只读、F6b 汇总即时刷新、F6c/d 人均一致、I5 不串线、N2b 名单归属、N3b/c 关闭按钮）；verify-demo **23/23**；run-all **9/9**。
⚠️ 教训：CDP eval 内嵌正则会多层转义——**浏览器只取原始文本、解析放 Node 侧**。

## 六、验证计划（开发阶段执行）
- A1 新增专项断言：路线 A 加同行人 → 打开路线 B 流水页签 → 「同行人（N）」计数与名单必须属于 B（利用既有 I4 的「同行人（4）」错误输出转正为正确断言）。
- A2/A3 各 1-2 条真机断言；B2 修正后补「卡片人均 == 流水页人均」一致性断言。
- 全量：`run-all.js` 9 脚本 + `verify-v110.js` + `verify-demo.js` 全绿后，按发版流程走（README/wiki 仅在有行为变化处同步）。
