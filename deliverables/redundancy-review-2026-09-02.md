# travel-expense 代码冗余审查清单

> 审查日期：2026-09-02
> 范围：`server/`（10 个模块）+ `public/assets/`（6 个前端模块）
> 结论：代码整体结构清晰、分层合理；但存在 **8 处明确重复实现**、**2 处字段映射重复**、**3 处设计层冗余（含死代码）**，以及由重复衍生的 **4 处分叉/不一致风险**。逐项列出如下。

---

## 一、明确的重复实现（同逻辑多份副本）

### 1. 日期区间解析 `parseDateRange` / `parseDate` / `parseStart` — 3 处
- `server/db.js:186` `parseDateRange(dr, year)` → 解析为 ISO `start/end`
- `server/routes_api.js:278` `parseDate(dr, year)` → 仅解析为 `{year, month}`
- `public/assets/api.js:163` `parseStart(dr, year)` → 解析为 `Date` 对象
- **原因**：同一段「`YYYY/M/D` / `M/D` 正则匹配」逻辑写了三遍，输出形态略不同。
- **风险**：规则改动要改三处；`routes_api` 的 `statsTrend` 与前端 `startMs` 都依赖重解析，而 `routes` 表其实已存 `start_date/end_date` 列（`bind()` 每次写入都会算），统计接口却绕回重算 daterange，浪费且易与存储列漂移。
- **建议**：抽一个共享解析器（如 `db.parseDateRange` 导出），前端若需也可复用同一规则；`statsTrend` 直接读 `start_date` 列。

### 2. HTML 转义 `esc()` — 4 处
- `server/app.js:257` `esc()`
- `public/assets/api.js:150` `esc()`（导出）
- `public/assets/charts.js:53` `esc()`（局部）
- `public/assets/main.js:7` `const esc = ...`（局部）
- **原因**：每个模块各自拷贝了一份转义函数，且转义字符集不一致（见第四节）。
- **建议**：前端统一从 `api.js` 导入，删除 `charts.js` / `main.js` 的私有副本；服务端保留一份即可。

### 3. 密码哈希 `scryptHash` / `hashPassword` — 2 处完全相同
- `server/db.js:92` `scryptHash(pw, salt)` = `crypto.scryptSync(String(pw), salt, 64).toString('hex')`
- `server/auth.js:13` `hashPassword(password, salt)` = 同一行
- **原因**：种子管理员用 `db.scryptHash`，普通注册/改密用 `auth.hashPassword`，函数体一字不差。
- **建议**：`auth.js` 直接 `require('./db').scryptHash`（已导出），删掉 `hashPassword`；或在 `db` 中统一暴露。

### 4. LIKE 通配符转义 `escapeLike` — 定义 1 处 + 内联重复 1 处
- `server/routes_api.js:27` 已定义 `escapeLike(s)`
- `server/admin_api.js:68` 又内联写了一遍 `q.replace(/\\/g,'\\\\').replace(/%/g,'\\%').replace(/_/g,'\\_')`
- **原因**：admin 用户搜索未复用 routes 的 `escapeLike`。
- **建议**：把 `escapeLike` 提到 `db.js` 或 `http.js` 导出，两处共用。

### 5. 9 类支出分类清单 `EXP_KEYS`（服务端）/ `CATS`（前端）— 2 处
- `server/db.js:11` `EXP_KEYS = ['交通','机票','高铁','住宿','餐饮','门票','团费','购物','其他']`
- `public/assets/charts.js:4` `CATS = [...]` 完全相同
- **原因**：分类枚举写死在两处，新增/改名类目需同步改两端，否则统计与图表错位。
- **建议**：分类清单作为「单一数据源」下放到前端（或经接口下发），前端不再硬编码。

### 6. 币种符号表 `SYM`（服务端分享页）/ `CUR_SYMBOLS`（前端）— 2 处且已分叉
- `server/app.js:264` `money()` 内 `SYM` 表
- `public/assets/api.js:160` `CUR_SYMBOLS` 表
- **原因**：两份符号表，且已不一致——前端含 `IDR/PHP/VND/INR/RUB`，服务端没有；服务端 `money()` 对未知币种回退为代码本身，前端 `curSymbol` 同样回退。
- **风险**：同一货币在不同界面显示符号不同（如 IDR 前端是 `Rp`，分享页会退化成 `IDR`）。
- **建议**：统一为一份（如 `fx.js` 导出符号表，前后端共用）。

### 7. 金额格式化 `money` / `fmtMoney` — server + frontend charts 各一份
- `server/app.js:263` `money(n, cur)`
- `public/assets/api.js:162` `fmtMoney(n, cur)` = `curSymbol(cur) + fmt(n)`
- `public/assets/charts.js:51` 局部 `money(n, cur)` = 又抄了一遍 `curSymbol+fmt`
- **原因**：格式化的「符号 + 千分位 + 小数位」逻辑在三层各写一次。
- **建议**：前端只保留 `api.js` 的 `fmtMoney`，charts.js 复用之；服务端分享页因是 SSR 可保留一份。

### 8. 审计日志写入 `auditAuth` / `audit` — 2 处且错误处理不一致
- `server/auth.js:128` `auditAuth(...)` 包了 `try/catch`（写入失败不阻塞主流程）
- `server/admin_api.js:17` `audit(...)` **没有** try/catch
- **原因**：同样的 `INSERT INTO audit_logs` 写了两份；admin 侧若审计表异常会抛出 500。
- **建议**：合并为一个共享 `audit()`（带 try/catch），`auth.js` 与 `admin_api.js` 共用。

---

## 二、字段映射重复（可合并）

### 9. 路线字段映射 `bind` / `seedRoutes` / `import.clean` — 3 处重建同一套 9 字段映射
- `server/db.js:215` `bind()` 用 `EXP_COL` 映射 9 个 `exp_*`
- `server/db.js:152` `seedRoutes` 内联 `exp_traffic: num(e['交通']) ...`（硬编码，未用 `EXP_COL`）
- `server/routes_api.js:142` `import` 的 `clean` 对象再次手列 9 字段
- **原因**：「对象 ↔ 数据库列」的映射写了三遍，风格还不同（bind 用 EXP_COL，seed 硬编码）。
- **风险**：新增支出类目时 `bind`/`seedRoutes`/`import` 三处要同步；seed 因未用 `EXP_COL` 最容易漏改。
- **建议**：`bind(data)` 作为唯一入口，seed 与 import 都先构造标准对象再调用 `bind`/`insertRoute`。

### 10. 汇率换算公式 `fx.convert` / 前端 `toHome` — 公式重复
- `server/fx.js:22` `convert(amount, from, to)` = `v * ratesToCny[from] / ratesToCny[to]`
- `public/assets/api.js:9` `toHome(amount, cur)` = `v * rf / rt`（用 `store.site.fx_rates`）
- **原因**：转换数学完全一样，前端另存一份汇率表。
- **说明**：前端离线聚合确实需要本地算，属于「必要副本」；但汇率表本身应与服务端同源（见第 6 点），避免两表数值漂移。

---

## 三、设计层冗余（死代码 / 重复计算）

### 11. `/api/routes/stats/summary` 与 `/stats/trend` 服务端统计接口 — 实质死代码
- `server/routes_api.js:69-70, 217-275` 两个统计接口已实现完整。
- **但前端从未调用**：`public/` 全局搜索 `stats/summary`、`stats/trend` 零引用。`app.js` 的 `renderStats()` 用客户端已加载的 `routes` 数组 + `toHome` 自己重新聚合出分类占比、逐年趋势、年度表。
- **原因**：统计能力在「服务端接口」和「前端 client-side 聚合」两套实现并存，前端实际只走后者。
- **影响**：服务端 `statsSummary`/`statsTrend` 是死代码（增加维护面、却无人消费）；且两端聚合口径若不同会出现差异。
- **建议**：二选一——要么前端改为调用 `/stats` 接口（更准、跨多币种一致、数据量大时省前端计算），要么删除服务端这两个接口。当前前端方案在「全量已加载」前提下可用，故优先删除服务端死接口，或标注 `@deprecated` 留待后台复用。

### 12. `statsSummary` 内对每行重复调用 `routeToJson(r).exp`
- `server/routes_api.js:229` `const e = dbModule.routeToJson(r).exp;` 在循环里对每一行都重建一次 JSON 对象，只为读 `exp`。
- **原因**：可直读 `r[dbModule.EXP_COL[c]]`，不必整行序列化。属性能级冗余（非致命）。
- **建议**：循环内直接 `dbModule.num(r[dbModule.EXP_COL[c]])`。

### 13. `/api/public/site` 与 `/api/public/server-check` — 重复查 site_settings 且字段重叠
- `app.js:139` `/api/public/site` 与 `app.js:157` `/api/public/server-check` 都 `SELECT * FROM site_settings WHERE id=1`。
- **原因**：server-check 是给独立客户端做连通性探测（`isTravelExpense:true`），但它返回了 `site_name/allow_register/register_mode`，与 site 大量重叠。
- **建议**：server-check 可只返回 `{ ok, isTravelExpense }` 或内部复用同一个 `getSiteSettings()` 函数（现两处各写一遍查询）。

---

## 四、由重复衍生的「分叉 / 不一致」风险（副作用，需警惕）

| 维度 | 服务端 | 前端 | 后果 |
|---|---|---|---|
| 币种符号表（第 6 点） | 缺 IDR/PHP/VND/INR/RUB | 含 | 同一货币分享页与 SPA 显示不同 |
| `esc` 单引号转义（第 2 点） | `app.js` 转义 `'` | `api.js` 不转义 `'` | 若数据含单引号，两处 XSS 防护力度不同 |
| 审计封装（第 8 点） | auth 包 try/catch | admin 不包 | admin 审计表异常会 500 |
| JPY/KRW 小数位 | 0 位（`JPY_ZERO_DECIMAL`） | `fmt` 始终 2 位 | 日元在分享页与 SPA 小数位不同 |

这些都源于「同一逻辑多份副本」，只要合并单一数据源即可根治。

---

## 五、次要（非阻断，可顺手优化）

- `fx.js:5-6` 离线模式也 `require('http')`+`require('https')`，`http` 几乎用不到，可改为按需。
- `mailer.js:12` `transporter()` 每次发送新建 transport，可缓存复用。
- `routes_api.js:46` `listForUser` 全量 `SELECT` 后在内存分页（`queryRoutes` 无 `LIMIT`）；当前数据量小可接受，量大时需改为 SQL 分页。
- `server/app.js:262` `JPY_ZERO_DECIMAL` 与 `fx.js` 的币种集合无关联，币种扩展时两套要同步。

---

## 优先级建议

1. **高（死代码，直接删/合并）**：#11 服务端 stats 接口、#8 审计合并、#3 密码哈希合并。
2. **中（单一数据源，防分叉）**：#6 币种符号表、#5 分类清单、#2 esc、#9 字段映射 `bind` 统一、#4 escapeLike。
3. **低（去重提质）**：#1 日期解析、#7 金额格式化、#10/#12/#13 收尾优化、#五 顺手项。

> 注：以上均为「冗余/重复」视角审查，未改动任何代码。如需我直接动手合并其中某几项（建议从 #3/#8/#11 高危项开始），告诉我即可。
