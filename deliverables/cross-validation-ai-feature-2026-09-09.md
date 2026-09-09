# 交叉验证报告：AI 行程规划功能（travel-expense）

- 验证日期：2026-09-09
- 验证方式：以源码为准逐条核对（非仅信任开发总结），覆盖 `server/` 5 文件 + `public/` 3 文件 + `index.html`
- 工作区状态：7 文件修改 + `server/ai_service.js` 新增，均未提交（HEAD = `32127d2`）

## 结论
AI 功能的 **10 项交叉验证点全部通过**，无阻断性缺陷。后端 5 个文件 `node --check` 语法全过。
另发现**一笔范围外改动（预算功能）未包含在你提供的总结中**，见文末「待办」。

## 逐条核对（证据：文件:行号）

| # | 验证点 | 结果 | 证据 |
|---|---|---|---|
| 1 | 天数边界：同日=1、结束早于开始=0 | ✅ | `public/assets/app.js:315-322` `calcDays` 返回 `diff>=0?diff+1:0` |
| 2 | 未启用 AI 用户：编辑表单 AI 按钮 `display:none` | ✅ | `app.js:430`；`login`/`me` 返回 `ai_enabled`（`auth.js:273,292`） |
| 3 | 未启用用户直接调 API → 403 `AI_NOT_ENABLED` | ✅ | `routes_api.js:74-76` |
| 4 | GET 配置密钥掩码 `******` | ✅ | `admin_api.js:188` `api_key: c.api_key ? '******' : ''` |
| 5 | 测试接口用请求体配置、未保存也可测 | ✅ | `admin_api.js:205-228`（body 有值则用 body）；前端 `admin.js:256-263` 带表单值 |
| 6 | 旧数据仅 `daterange` → 编辑时日期选择器正确回填 | ✅ | `app.js:392-405` 优先 `start_date`，否则 `parseDatesFromRange`；前后端解析正则一致 |
| 7 | 安卓端：共用 `public/`，`cap copy` 后生效 | ⚠️ 未在本次验证（无安卓构建环境） | 架构上 `webDir:'../public'` 共用，逻辑成立；需实机构建 APK 复核 |
| 8 | 审计：配置修改/测试/规划均写 `audit_logs` | ✅ | `update_ai_config`(`admin_api.js:202`)、`test_ai_config`(`:223`)、`update_ai_enabled_users`(`:255`)、`ai_plan_route`(`routes_api.js:94`) |
| 9 | 删用户级联清 `ai_enabled_users` | ✅ | `db.js:99` `ON DELETE CASCADE`；封禁路径亦靠 FK 级联 |
| 10 | CSP 合规：前端不直接连大模型，全走后端代理 | ✅ | `server/app.js:38-51` 设 `connect-src 'self'`；前端仅 `api.post('/routes/ai-plan')`(`app.js:451`) |

## 逻辑正确性补充核对
- `ai_service.js`：URL 自动补 `/v1`（`normalizeBaseUrl`）、测试 15s/规划 60s 超时、非 JSON/HTTP 错误/缺 `content` 均有明确报错——与总结一致。
- `saveAiConfig`：`api_key === '******'` 表示不修改（`db.js:298`）——密钥更新安全。
- `ai-plan` 双重门禁：`isAiEnabledUser` + 全局 `cfg.enabled`（`routes_api.js:74,79`）——纵深防御正确。
- `setAiEnabledUsers`：先 `DELETE` 全量再 `INSERT`，并校验所有 `user_ids` 存在（`admin_api.js:248-254`）——防脏数据。
- `ai_config` 单例 `id=1` + `seedSingleton` 幂等建行（`db.js:139-143`）。

## 轻微观察（非阻断，建议后续优化）
- **点 1 的「前端不允许保存」表述略有出入**：`calcDays` 结束早于开始时返回 0，`saveForm` 以 0 天写入（`app.js:478,485`），并未硬拦截保存，仅天数置 0。功能可接受，但总结措辞需修正。
- **全局开关与按用户开关分离**：即使用户在 `ai_enabled_users` 中，若全局 `enabled=0`，按钮仍显示、点击返回 400「AI 功能未启用」。可考虑按钮显隐同时参考全局开关，体验更顺。
- **密钥无法清空**：`saveAiConfig` 对空 `api_key` 视为「不修改」，UI 无清空入口（符合密钥字段常规做法，仅提示）。

## 待办（重要）
- **预算功能未审查**：工作区同时存在 `总预算/日均预算` 表单（`index.html:73-74`）、`saveForm` 读写（`app.js:488-489`）、路线详情「超支/剩余」（`app.js:535-537`）、`statsSummary` 的 `budgetTotal/remaining/overBudget`（`routes_api.js:271-283`）、`db.js` 的 `budget_total/budget_daily` 列与 `addColumn` 迁移。该部分**不在你提供的 AI 功能总结中**，属于同批次未提交改动但未经交叉验证。建议另行安排一次预算功能的专项交叉验证后再统一提交。
