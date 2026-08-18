# 旅行路线 · 经费台（travel-expense）

一个**自托管的旅行路线 + 经费管理工作台（多用户版）**：管理历年出行路线，按 9 类花费拆分（交通 / 机票 / 高铁 / 住宿 / 餐饮 / 门票 / 团费 / 购物 / 其他），按年度做统计复盘。**数据存在你自己的设备上**，多用户数据互相隔离，手机/电脑自适应。

> 仓库内置若干**示例路线**供快速体验；支持邮箱 / 账户名注册登录，管理员可统一治理（用户管理、邮件配置、站点设置、统计、审计）。

---

## ✨ 功能能力

| 模块 | 能力 |
|---|---|
| **用户体系** | 邮箱注册（验证码）/ 账户名注册；登录支持「账号密码 / 邮箱验证码 / 邮箱密码」三种方式；服务端会话，封禁即时生效 |
| **路线管理** | 录入 / 查看所有路线；字段含年份、出行日期、类型、天数、同行人数、目的地、景点路线（按天）、住宿位置；按年份筛选、关键字搜索 |
| **花费明细** | 每条路线按 **9 类**拆分花费，自动算总额与人均；未填计 0，可随时补 |
| **年度复盘** | 按年汇总总花费 / 次数 / 次均 / 总天数；分类占比环形图 + 逐年趋势柱状图（手写 SVG，零外链） |
| **数据隔离** | 每位用户仅见自己的路线；系统示例（`is_seed=1`）全员可见但普通用户只读 |
| **管理后台** | 平台总览、用户管理（在线/封禁/提权）、邮件服务器配置、站点设置（开放注册/站名/公告）、操作审计日志 |
| **自适应** | 手机单列、PC 多列；浏览器「添加到主屏幕」即伪原生 App |

技术特性：后端 Node 原生 `http`（零框架）+ `better-sqlite3`（唯一原生依赖）；前端原生 ES Modules 无构建；nginx 静态托管 + `/api` 反向代理；密码 `scrypt` 加盐哈希。

---

## 🎮 在线演示

不想部署也能体验功能？打开纯前端演示（无需后端、无需安装，数据临时保存在你的浏览器本地）：

👉 **[点此体验在线 Demo](https://htmlpreview.github.io/?https://github.com/hanyuestar/travel-expense/blob/main/demo/index.html)**

演示版为**单用户 localStorage 版**，内置示例数据，可随意新增 / 编辑 / 删除路线、查看年度统计；所有改动仅存于当前浏览器，不会上传任何服务器。

---

## 🚀 部署方法

三种方式任选其一，数据都落在你自己的磁盘。

### 方式 A：Docker Compose 自托管（双容器）

```bash
# 1. 把整个 travel-expense/ 传到部署机（如 /volume1/docker/travel-expense/）
# 2. 启动（前端 nginx :80 + 后端 node :3000）
cd /volume1/docker/travel-expense
docker compose up -d --build
# 3. 反向代理（示例）：your-domain.example.com(HTTPS:443) -> localhost:3006(HTTP)
```

打开 `https://your-domain.example.com`。端口、反代细节见 [部署指南（Wiki）](https://github.com/hanyuestar/travel-expense/wiki/部署指南)。域名与反代请按你自己的环境配置。

### 方式 B：使用预构建镜像（ghcr.io / Docker Hub）

```bash
# 前端
docker run -d --name travel-expense-frontend -p 3006:80 \
  ghcr.io/hanyuestar/travel-expense-frontend:latest   # 或 kyson666/travel-expense-frontend:latest
# 后端
docker run -d --name travel-expense-backend -p 3000:3000 -v /your/path/data:/data \
  ghcr.io/hanyuestar/travel-expense-backend:latest    # 或 kyson666/travel-expense-backend:latest
```

> 注意：前端 nginx 反代 `/api` 到 `backend:3000`，使用 docker compose 时服务名 `backend` 已配好；手动分别运行时需在 nginx 配置中调整 `proxy_pass`。

### 方式 C：手动运行（无 Docker，需 Node 18+）

```bash
cd travel-expense/server
npm install            # 编译 better-sqlite3
node app.js            # 默认端口 3000，数据在 ../data/app.db
# 前端：把 public/ 交给任意静态服务器，并反代 /api 到 :3000
```

---

## 🗂 使用方法

- **首次登录**：管理员 `admin / 123456`，登录后**强制修改密码**。
- **注册**：登录页「去注册」→ 邮箱注册（需验证码，需先在后台配置 SMTP）或账户名注册。
- **新增路线**：工作台右上角「新增路线」→ 填名称 / 年份 / 日期 / 类型 / 天数 / 人数 / 目的地 / 景点路线 / 住宿 / 9 类花费。
- **年度复盘**：滚动到工作台下方，按年查看占比与趋势。
- **管理后台**：管理员右上角「管理后台」→ 用户管理（封禁 / 提权）、邮件配置、站点设置、审计日志。
- **示例数据**：系统示例全员可见、普通用户只读；可在个人视图勾选「隐藏系统示例」。

---

## 🔒 数据存储与隐私

- 所有路线与花费数据仅保存在你自己的服务器挂载卷 `data/app.db`（SQLite），不在任何第三方云。
- 每位用户数据互相隔离（`owner_id`）；非本人且非示例的路线返回 404，不泄露存在性。
- 密码 `scrypt` 加盐哈希存储；会话 `HttpOnly + SameSite=Lax` Cookie；管理员可即时封禁（删除全部会话）。

---

## 🐳 镜像发布方式（维护者参考）

代码推送到 GitHub 后，镜像通过 **GitHub Actions 自动双注册表发布**：

1. 仓库已配置 Actions Secret：`DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN`（ghcr 用自动注入的 `GITHUB_TOKEN`，无需配置）。
2. 打版本 tag 并推送即触发构建（后端 + 前端两个镜像）：
   ```bash
   git tag -a v2.0.0 -m "v2.0.0 multi-user"
   git push origin main --tags
   ```
3. Actions 把镜像推到：
   - `ghcr.io/hanyuestar/travel-expense-frontend` / `kyson666/travel-expense-frontend`
   - `ghcr.io/hanyuestar/travel-expense-backend` / `kyson666/travel-expense-backend`
4. 也可在仓库 Actions 页面手动 `workflow_dispatch` 触发。

工作流文件见 [`.github/workflows/docker-image.yml`](.github/workflows/docker-image.yml)。

---

## 📁 项目结构

```
travel-expense/
├── .github/workflows/docker-image.yml   # 双注册表自动构建发布（frontend + backend）
├── docker-compose.yml                   # 双容器编排（nginx 前端 + node 后端）
├── Dockerfile.frontend                  # nginx 静态托管 + /api 反代
├── Dockerfile.backend                   # node + better-sqlite3
├── nginx.conf                           # 前端反代配置
├── server/                              # 后端（Node 原生 http）
│   ├── app.js                           # 入口、路由分发、静态兜底
│   ├── config.js                        # 环境变量配置
│   ├── db.js                            # better-sqlite3 建表 + seed（管理员/示例路线）
│   ├── http.js                          # JSON 响应 / Cookie / 请求体工具
│   ├── auth.js                          # 注册/登录/会话/封禁/改密
│   ├── routes_api.js                    # 路线 CRUD（owner 隔离）+ 统计
│   ├── admin_api.js                     # 管理后台接口
│   ├── mailer.js                        # nodemailer SMTP 发码/测试邮件
│   └── package.json
├── public/                              # 前端（nginx 托管，ES Modules 无构建）
│   ├── index.html                       # 应用外壳（hash 路由）
│   ├── styles.css
│   └── assets/
│       ├── main.js                      # 路由守卫 + 启动
│       ├── api.js                       # fetch 封装 + 全局状态
│       ├── auth.js                      # 登录/注册页
│       ├── app.js                       # 工作台（列表/统计/表单/个人中心）
│       ├── admin.js                     # 管理后台 6 页
│       └── charts.js                    # 手写 SVG 环形图/柱状图
├── demo/index.html                      # 纯前端演示（单用户，数据存浏览器）
├── data/                                # 运行时卷：app.db（gitignore）
└── README.md
```

---

## ❓ 常见问题

- **页面打不开**：`docker compose ps` 看容器状态；`curl http://localhost:3006/api/public/site` 看后端连通性。
- **登录提示「禁止用户登录」**：该账号被管理员封禁，请联系管理员解封。
- **邮箱验证码收不到**：先到「管理后台 → 邮件配置」填好 SMTP 并「发送测试邮件」验证。
- **数据没更新**：确认 `docker-compose.yml` 里 `./data:/data` 挂载正确。
- **想换端口**：改 `docker-compose.yml` 的 `3006:80` 左侧。
- **迁移到新机器**：把整个 `travel-expense/`（含 `data/`）拷过去，`docker compose up -d --build`。

---

## 📄 版权与署名

Copyright © Kyson. 本仓库为开源示例项目，仅供学习与交流使用。
