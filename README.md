# 旅行路线 · 经费台（travel-expense）

一个**自托管的旅行路线 + 经费管理工作台（多用户版）**：管理历年出行路线，按 9 类花费拆分（交通 / 机票 / 高铁 / 住宿 / 餐饮 / 门票 / 团费 / 购物 / 其他），按年度做统计复盘。**数据存在你自己的设备上**，多用户数据互相隔离，手机/电脑自适应。

> 仓库内置若干**示例路线**供快速体验；支持邮箱 / 账户名注册登录，管理员可统一治理（用户管理、邮件配置、站点设置、统计、审计）。

---

## ✨ 功能能力

| 模块 | 能力 |
|---|---|
| **用户体系** | 邮箱注册（验证码）/ 账户名注册；登录支持「账号密码 / 邮箱验证码 / 邮箱密码」三种方式；服务端会话，封禁即时生效 |
| **路线管理** | 录入 / 查看所有路线；字段含年份、出行日期、类型、天数、同行人数、目的地、景点路线（按天）、住宿位置；按年份筛选（服务端传参）、关键字搜索；**列表分页加载**（上一页 / 下一页，显示共 N 条） |
| **花费明细** | 每条路线按 **9 类**拆分花费，自动算总额与人均；未填计 0，可随时补 |
| **多币种** | 每条路线可选币种（CNY/USD/EUR/JPY 等 20+），统计按**站点本位币**自动换算聚合（内置汇率表兜底，可配置实时汇率源）；首页统计卡/图表统一显示本位币 |
| **预算管控** | 每条路线可设总预算 / 日均预算，卡片显示进度条、超支红色高亮；首页统计卡显示总预算与结余 |
| **年度复盘** | 按年汇总总花费 / 次数 / 次均 / 总天数；分类占比环形图 + 逐年趋势柱状图（手写 SVG，零外链） |
| **数据导出导入** | 个人 CSV 导出（Excel 可开）/ JSON 导出导入（可往返备份还原）；**导入按「名称 + 年份 + 目的地」自动去重**（已存在跳过并计入 `duplicates`）；管理员全站 CSV 导出（含用户名，审计留痕） |
| **只读分享** | 本人路线可生成一次性只读链接（`/share/<token>`），无登录可看，随时可重置 / 撤销 |
| **数据隔离** | 每位用户仅见自己的路线；系统示例（`is_seed=1`）全员可见但普通用户只读 |
| **管理后台** | 平台总览、用户管理（在线/封禁/提权）、邮件服务器配置、站点设置（开放注册/站名/公告/本位币）、**数据库备份下载**、操作审计日志 |
| **自适应** | 手机单列、PC 多列；浏览器「添加到主屏幕」即伪原生 App |
| **强健性与安全** | 会话服务端 30 天滑动 TTL（过期自动失效）；登录限流（IP + 账户名，含 IP 全局限流 30 次 / 10 分钟）；实时汇率可配置 API 定时刷新（兜底静态表）；`/health` 含 DB 探活（DB 故障返 503）；访问日志 + 优雅关闭（SIGTERM/SIGINT）；CSP / X-Frame-Options / Referrer-Policy / HSTS 安全头；封禁用户时清除其分享令牌 |

技术特性：后端 Node 原生 `http`（零框架）+ `better-sqlite3`（唯一原生依赖）；前端原生 ES Modules 无构建，**由后端内置托管**（单容器部署，端口 3000 直出）；密码 `scrypt` 加盐哈希；验证码 CSPRNG 生成；写操作 CSRF 同源校验。

---

## 🎮 在线演示

不想部署也能体验功能？打开纯前端演示（无需后端、无需安装，数据临时保存在你的浏览器本地）：

👉 **[点此体验在线 Demo](https://htmlpreview.github.io/?https://github.com/hanyuestar/travel-expense/blob/main/demo/index.html)**

演示版为**单用户 localStorage 版**，内置示例数据，可随意新增 / 编辑 / 删除路线、查看年度统计；所有改动仅存于当前浏览器，不会上传任何服务器。

---

## 📌 版本变更记录

### v1.0.5（2026-09-01）
新增安卓客户端 + 跨域直连能力（向后兼容 v1.0.4 数据，无需迁移）：
- **安卓客户端（Capacitor 原生壳）**：新增 `android-app/` 工程，将网页 SPA 打包为原生 APP，手机桌面常驻、离线可开 UI；详见下方「📱 安卓客户端」。
- **内置服务器地址**：APP 安装包可烧录服务器地址（Web 端经 `window.TE_BUILTIN_SERVER` 读取），用户免填写、免在小屏手输长链接；未内置时仍保留「切换服务器」入口。
- **账号归属校验**：新增 `GET /api/public/server-check`；登录时校验账号是否归属当前服务器，非本服务器账号返回 `404 ACCOUNT_NOT_FOUND`（区分「密码错」与「账号不在此服务器」）。
- **跨域直连支撑**：新增 `ALLOWED_ORIGINS` 环境变量与 CORS 预检放行；`COOKIE_SECURE=true` 时跨域会话 Cookie 带 `Secure; SameSite=None`，配合 WebView 第三方 Cookie 开关，APP 内登录态可持久化。
- **CSP 自适应**：仅在开启 `ALLOWED_ORIGINS` 时放宽 `connect-src` 至 `https:`，避免浏览器内跨域客户端被安全策略拦截。
- 验证：全量回归 6 脚本 181 用例通过；模拟 WebView 跨域端到端（server-check / 预检 / 登录态 Cookie / 带会话取数）全绿。

### v1.0.4（2026-08-24）
缺陷修复（无功能删减，向后兼容 v1.0.3 数据）：
- **彻底移除顶部 header 的「登录 / 注册」按钮**：此前顶部按钮与登录页表单重复，且在登录页点击顶部「登录」执行 `navigate('/login')` 时因当前 hash 已是 `#/login`、`hashchange` 不触发而「无任何反应」，用户误以为登录功能损坏。现删除 header 中的 `guestArea`，登录 / 注册入口统一收敛到登录页表单（`#/login` / `#/register` 由路由守卫自动跳转）。header 右侧在未登录时为空，已登录时仅显示用户菜单。
- **配套改动**：`renderHeader()` 不再依赖已删除的 `guestArea`（改为仅处理 `userArea`，避免已登录用户菜单不显示）；`main.js` 移除顶部按钮的点击事件绑定。
- 验证：无头浏览器 E2E 确认未登录时顶部无任何「登录 / 注册」按钮、已登录用户菜单正常；下方登录表单可正常登录并跳转；全量回归 6 脚本 181 用例通过。

### v1.0.3（2026-08-24）
缺陷修复（无功能删减，向后兼容 v1.0.2 数据）：
- **修复顶部「登录 / 注册」按钮无响应**：根因为上版新增的 CSP 安全头 `script-src 'self'` 拦截了首页内联 `onclick`，已将按钮改为 `id` 并在 JS 中绑定跳转事件。登录框内的按钮本就由 JS 绑定，故不受影响。
- **优化移动端注册网络错误提示**：部分手机浏览器注册时仅显示「Failed to fetch」（这是 `fetch` 网络层抛出的 `TypeError`，非业务错误，常因移动网络 / 代理不稳定或站点证书不被该浏览器信任）。现已捕获该错误并提示「网络连接失败，请检查网络或该站点证书是否受信任」，同时设置 `fetch` 的 `mode: 'same-origin'` 提升兼容性。
- 测试：6 脚本 / 181 用例全部通过。

---

## 🚀 部署方法

### 方式 A：Docker Compose 自托管（单容器，推荐）

镜像为**全栈单容器**（后端内置托管前端页面，端口 3000 直出），复制下面文件即可安装：

```bash
# 1. 建数据目录并放入 compose 文件（以群晖为例）
mkdir -p /volume1/docker/travel
cd /volume1/docker/travel
curl -O https://raw.githubusercontent.com/hanyuestar/travel-expense/main/docker-compose.yml

# 2. 启动（自动拉取 ghcr.io/hanyuestar/travel-expense:v1.0.5）
docker compose up -d

# 3. 浏览器打开 http://<你的NAS>:8108 ，管理员 admin / 123456（首登强制改密）
```

`docker-compose.yml`（也可直接复制粘贴保存）：

```yaml
services:
  travel-expense:
    image: ghcr.io/hanyuestar/travel-expense:v1.0.5
    container_name: travel-expense
    restart: unless-stopped
    ports:
      - "8108:3000"   # 想换端口只改左侧
    volumes:
      - /volume1/docker/travel:/data   # 数据持久化（app.db + 种子 routes.json + logs/）
    environment:
      - PORT=3000
      - DATA_DIR=/data
      # ↓↓↓ 安卓 APP 直连所需（否则 APP 内登录态无法持久化 / 跨域被拒）↓↓↓
      - COOKIE_SECURE=true        # 服务器处于 HTTPS 反代之后必须置 true
      - ALLOWED_ORIGINS=*         # 允许安卓 WebView 跨域调用 API 并携带凭证（* 表示允许任意来源）
```

> 首次启动会自动写入示例路线数据；数据只存在你的磁盘上（`/volume1/docker/travel/app.db`）。
> 如需 HTTPS 域名访问，反代示例：`https://your-domain.example.com -> 127.0.0.1:8108`。

> **📋 容器日志查看**（无需单独挂载 logs 目录，entrypoint 自动在数据卷内部创建 logs/ 子目录）：
>
> | 用途 | 命令 | 备注 |
> |---|---|---|
> | 实时容器 stdout | `docker compose logs -f` | `docker logs` 默认不留历史，重启即清空 |
> | 持久化历史日志 | `tail -F /volume1/docker/travel/logs/app.log` | 容器每次启动 tee 追加；含 `[entrypoint]` boot/exit 标记行便于定位 |
> | 看本周日志末尾 500 行 | `tail -n 500 .../logs/app.log` | 排查已退出容器的报错最有用 |
>
> 日志文件由容器 entrypoint 自动落盘到 `$DATA_DIR/logs/app.log`（即挂载卷下的 `logs/app.log`），随数据目录一起持久化迁移，无需额外配置。

### 方式 B：直接 docker run（不装 compose）

```bash
docker run -d --name travel-expense \
  -p 8108:3000 \
  -v /your/path/data:/data \
  --restart unless-stopped \
  ghcr.io/hanyuestar/travel-expense:v1.0.5
```

### 方式 C：手动运行（无 Docker，需 Node 18+）

```bash
cd travel-expense/server
npm install            # 编译 better-sqlite3
node app.js            # 默认端口 3000；后端自动托管 public/ 前端，数据在 ../data/app.db
```

---

## 📱 安卓客户端（Android APP）

把网页版打包成手机原生 APP：桌面常驻图标、离线可开 UI、登录后像原生应用一样使用。APP 通过 `fetch` **直连你自托管的服务器**，数据仍全在你自己的服务器上，APP 本身不另存数据。

### 快速使用（已发布 APK）
- **下载**：[`app-debug.apk`（v1.0.5）](https://github.com/hanyuestar/travel-expense/releases/download/v1.0.5/app-debug.apk)
- 备用地址：<https://github.com/hanyuestar/travel-expense/releases/tag/v1.0.5>
- 手机允许「未知来源」安装后打开即可——**服务器地址已内置，打开即用，无需填写**。

> 该发布包已内置作者服务器地址；若你用自己的服务器，请按下面「自己构建」重新打包。

### 自己构建
前置：Node 18+、**JDK 17**、Android SDK（cmdline-tools + `platforms;android-34` + `build-tools;34.0.0`）。

```bash
cd android-app
npm install                                       # 安装 Capacitor CLI
cp .te-server-url.example .te-server-url         # 填入你的服务器地址（如 https://your-domain.example.com:8108）
npm run sync                                     # 拷贝 public/ 进安卓资源 + 注入内置服务器地址
npm run build                                    # 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

> - 内置地址写入 `android/app/src/main/assets/public/index.html`（`<script>window.TE_BUILTIN_SERVER="..."</script>`），**不会进入公开仓库**（`.te-server-url` 已被 gitignore）。
> - 详细构建与「WebView 第三方 Cookie」必改项见 `android-app/README.md`。

### 服务端配合（关键）
安卓 APP 跨域直连需要服务端开启：在 `docker-compose.yml` 中设置 `COOKIE_SECURE=true` 与 `ALLOWED_ORIGINS=*`（v1.0.5 示例 compose 已默认写入）。否则会出现「登录成功但刷新又退出」「API 被 CORS 拒绝」。

---

## ⚙️ 环境变量（可选）

除 `PORT` / `DATA_DIR` 外，其余均有安全默认值，无需配置即可运行：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `DATA_DIR` | `../data` | 数据目录（`app.db` + 种子 `routes.json` + `logs/`） |
| `DB_FILE` | `app.db` | SQLite 文件名 |
| `COOKIE_SECURE` | `false` | 设 `true`（HTTPS 反代场景）后 Cookie 带 `Secure`，并启用 HSTS |
| `ALLOWED_ORIGINS` | 空 | 逗号分隔的允许跨域来源（如 `http://localhost`）；设 `*` 允许任意来源。**安卓 APP 直连需开启**（否则跨域 API 被 CORS 拒绝、登录态无法持久） |
| `FX_API_URL` | 空 | 实时汇率 API 地址（返回 `{rates:{USD:7.15}}` 或扁平 `{USD:7.15}`）；配置后启用定时刷新，未配置则用内置静态兜底汇率 |
| `FX_REFRESH_INTERVAL_MS` | `21600000`（6h） | 汇率刷新间隔 |
| `TRUSTED_HOSTS` | 空 | 可信主机名逗号分隔；配置后 CSRF 严格校验 `Host`（防 Host 头伪造） |
| `ACCESS_LOG` | `true` | 访问日志开关，设 `false` 关闭 |
| `HSTS_MAX_AGE` | `31536000` | HSTS `max-age`（仅 `COOKIE_SECURE=true` 时生效） |

> **健康检查**：`GET /health` 返回 `{ok, ts, db}`，**DB 不可用时返回 503**（原先始终返回 200），便于容器编排探活与故障切换。

---

## 🗂 使用方法

- **首次登录**：管理员 `admin / 123456`，登录后**强制修改密码**。
- **注册**：登录页「去注册」→ 邮箱注册（需验证码，需先在后台配置 SMTP）或账户名注册。
- **新增路线**：工作台右上角「新增路线」→ 填名称 / 年份 / 日期 / 类型 / 天数 / 人数 / **币种** / **预算** / 目的地 / 景点路线 / 住宿 / 9 类花费。
- **多币种**：路线币种选非本位币（如 USD），首页统计自动按本位币折算；管理员在「管理后台 → 站点设置」切换本位币。
- **预算超支**：路线卡片上进度条变红即超支；首页统计卡可看总预算与结余。
- **导出 / 导入**：工作台右上角「导出」下载 CSV；「导入」选择之前 JSON 导出的文件即可还原（每人仅操作自己的数据）。
- **分享路线**：打开路线详情 → 「生成只读链接」→ 点击链接复制；再次生成会作废旧链接。
- **年度复盘**：滚动到工作台下方，按年查看占比与趋势。
- **管理后台**：管理员右上角「管理后台」→ 用户管理（封禁 / 提权）、邮件配置、站点设置、**全站 CSV 导出**、**数据库备份下载**、审计日志。
- **示例数据**：系统示例全员可见、普通用户只读；可在个人视图勾选「隐藏系统示例」。

---

## 🔒 数据存储与隐私

- 所有路线与花费数据仅保存在你自己的服务器挂载卷 `data/app.db`（SQLite），不在任何第三方云。
- 每位用户数据互相隔离（`owner_id`）；非本人且非示例的路线返回 404，不泄露存在性。
- 密码 `scrypt` 加盐哈希存储；会话 `HttpOnly + SameSite=Lax` Cookie；管理员可即时封禁（删除全部会话）。

---

## 🧪 开发与测试

```bash
cd travel-expense/server && npm install   # 安装依赖（better-sqlite3）
node tests/run-all.js                     # 一条命令跑全部测试（主回归 84 例 + 深测 16 例 + 4 组功能冒烟）
```

- `tests/regression.test.js` / `regression.deep.test.js`：规格书全量回归（auth / routes / admin / 隔离 / 封禁 / 限流 / 邮件码）
- `tests/smoke-*.test.js`：功能冒烟（多币种预算 / CSV 导出导入 / 只读分享 / 数据库备份），各自起隔离实例
- CI（GitHub Actions，`.github/workflows/ci.yml`）：Node 18/20/22 三版本跑全部测试

[![CI](https://github.com/hanyuestar/travel-expense/actions/workflows/ci.yml/badge.svg)](https://github.com/hanyuestar/travel-expense/actions/workflows/ci.yml)

---

## 🐳 镜像发布方式（维护者参考）

代码推送到 GitHub 后，**全栈单镜像**通过 GitHub Actions 自动发布到双注册表：

1. ghcr 发布无需配置（自动注入 `GITHUB_TOKEN`）；Docker Hub 需配置 Secrets `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`（未配置则自动跳过 Docker Hub，不影响 ghcr）。
2. 打版本 tag 并推送即触发构建（linux/amd64 + arm64 双架构）：
   ```bash
   git tag -a v1.0.5 -m "v1.0.5 single-image"
   git push origin main --tags
   ```
3. 镜像推送到：
   - `ghcr.io/hanyuestar/travel-expense`（必推）
   - `kyson666/travel-expense`（Docker Hub，可选）
4. 也可在仓库 Actions 页面手动 `workflow_dispatch` 触发，调试场景可临时把 `push.tag` 改 `branches`/`pull_request` 等自由触发。

工作流文件见 [`.github/workflows/docker-image.yml`](.github/workflows/docker-image.yml)。

---

## 📁 项目结构

```
travel-expense/
├── .github/workflows/
│   ├── docker-image.yml               # 单镜像双注册表自动发布（amd64+arm64）
│   └── ci.yml                         # 测试 CI（Node 18/20/22）
├── Dockerfile                         # 全栈单镜像（node 后端 + 内置前端静态）
├── docker-entrypoint.sh               # 容器入口（种子兜底 + 启动后端）
├── docker-compose.yml                 # 单服务编排（复制即可用）
├── server/                            # 后端（Node 原生 http，同时托管 public/）
│   ├── app.js                         # 入口、路由分发、静态托管、只读分享页
│   ├── config.js                      # 环境变量配置
│   ├── db.js                          # better-sqlite3 建表 + 幂等迁移 + seed
│   ├── http.js                        # JSON 响应 / Cookie / 请求体工具
│   ├── auth.js                        # 注册/登录/会话/封禁/改密（CSPRNG 验证码）
│   ├── routes_api.js                  # 路线 CRUD（owner 隔离）+ 统计 + 导出导入 + 分享令牌
│   ├── admin_api.js                   # 管理后台接口（含全站导出 / 数据库备份）
│   ├── mailer.js                      # nodemailer SMTP 发码/测试邮件
│   ├── fx.js                          # 多币种换算（静态汇率兜底 + 可选实时源）
│   ├── csv.js                         # 轻量 CSV 序列化（零依赖）
│   └── package.json
├── public/                            # 前端（后端内置托管，ES Modules 无构建）
│   ├── index.html                     # 应用外壳（hash 路由）
│   ├── styles.css
│   └── assets/
│       ├── main.js                    # 路由守卫 + 启动
│       ├── api.js                     # fetch 封装 + 全局状态 + 汇率换算
│       ├── auth.js                    # 登录/注册页
│       ├── app.js                     # 工作台（列表/统计/表单/个人中心/分享）
│       ├── admin.js                   # 管理后台 6 页
│       └── charts.js                  # 手写 SVG 环形图/柱状图（本位币）
├── android-app/                       # 安卓客户端工程（Capacitor 原生壳，webDir→public/）
│   ├── capacitor.config.js            # 打包配置（appId / appName / webDir）
│   ├── scripts/inject-server.mjs      # 构建时注入内置服务器地址（读取 .te-server-url，不入库）
│   ├── .te-server-url.example         # 服务器地址模板（复制为 .te-server-url 填入你的地址）
│   └── README.md                      # 构建与「WebView 第三方 Cookie」必改项说明
├── tests/                             # 回归 + 冒烟测试（run-all.js 一键全跑）
├── demo/index.html                    # 纯前端演示（单用户，数据存浏览器）
├── data/                              # 运行时卷：app.db + 种子 routes.json（gitignore）
└── README.md
```

---

## ❓ 常见问题

- **页面打不开 / 容器启动失败**：`docker compose ps` 看容器状态；`docker compose logs` 看实时输出（容器 stdout）；`tail -F /volume1/docker/travel/logs/app.log` 看历史日志（持久化，包含上次崩溃退出前一刻）。
- **登录提示「禁止用户登录」**：该账号被管理员封禁，请联系管理员解封。
- **邮箱验证码收不到**：先到「管理后台 → 邮件配置」填好 SMTP 并「发送测试邮件」验证。
- **数据没更新**：确认 `docker-compose.yml` 里 `/volume1/docker/travel:/data` 挂载正确。
- **想换端口**：改 `docker-compose.yml` 的 `8108:3000` 左侧。
- **迁移到新机器**：把数据目录（含 `app.db`）拷到新机器并改 compose 挂载路径，`docker compose up -d`。

---

## 📄 版权与署名

Copyright © Kyson. 本仓库为开源示例项目，仅供学习与交流使用。
