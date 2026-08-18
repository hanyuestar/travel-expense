# 旅行路线 · 经费台（travel-expense）

一个**自托管的旅行路线 + 经费管理工作台**：管理历年出行路线，按 9 类花费拆分（交通 / 机票 / 高铁 / 住宿 / 餐饮 / 门票 / 团费 / 购物 / 其他），按年度做统计复盘。**数据存在你自己的设备上**，手机/电脑自适应。

> 当前仓库已预置来自 Excel《旅行计划》整理出的 **12 条路线**（2023–2026），已填金额合计约 **¥6,875.51**（原表大量历史行程未填金额，可在工作台内随时补填，统计实时更新）。

---

## ✨ 功能能力

| 模块 | 能力 |
|---|---|
| **路线管理** | 录入 / 查看所有路线；字段含年份、出行日期、类型、天数、同行人数、目的地、景点路线（按天）、住宿位置；按年份筛选、关键字搜索；「即将出行」自动置顶 |
| **花费明细** | 每条路线按 **9 类**拆分花费，自动算总额与人均；未填计 0，可随时补 |
| **年度复盘** | 按年汇总总花费 / 次数 / 次均 / 总天数；分类占比环形图 + 逐年趋势柱状图（手写 SVG，零外链） |
| **数据同步** | 每次增删改**自动落盘**到你的服务器，换设备登录同一地址即可，无需导入导出 |
| **自适应** | 手机单列、PC 多列；浏览器「添加到主屏幕」即伪原生 App |

技术特性：后端纯 Node 内置 `http`，**零 npm 依赖**，镜像约 50MB；前端单文件 HTML，全内联、无任何第三方请求；存储为单个标准 JSON。

---

## 🚀 部署方法

三种方式任选其一，数据都落在你自己的磁盘。

### 方式 A：Docker 自托管到群晖 NAS（推荐，无需新域名）

你已有 `survey.hanyueppy.synology.me` 的 DDNS + 反代，照同样方式加个子域（如 `travel.hanyueppy.synology.me`）即可。

```bash
# 1. 把整个 travel-expense/ 传到 NAS（如 /volume1/docker/travel-expense/）
# 2. 启动
cd /volume1/docker/travel-expense
docker compose up -d
# 3. 群晖反代：travel.hanyueppy.synology.me(HTTPS:443) -> localhost:3006(HTTP)
```

打开 `https://travel.hanyueppy.synology.me`。端口、反代细节见 [docs/wiki/部署指南.md](docs/wiki/部署指南.md)。

### 方式 B：使用预构建镜像（ghcr.io / Docker Hub）

```bash
# GitHub Container Registry
docker run -d --name travel-expense -p 3006:3000 -v /your/path/data:/data \
  ghcr.io/hanyuestar/travel-expense:latest

# Docker Hub
docker run -d --name travel-expense -p 3006:3000 -v /your/path/data:/data \
  kyson666/travel-expense:latest
```

### 方式 C：手动运行（无 Docker，需 Node 18+）

```bash
cd travel-expense
node server.js                 # 默认端口 3000
# PORT=8080 DATA_DIR=/path/to/data node server.js
```

---

## 🗂 使用方法

- **新增路线**：右上角「新增路线」→ 填名称 / 年份 / 日期 / 类型 / 天数 / 人数 / 目的地 / 景点路线 / 住宿 / 9 类花费。
- **编辑 / 删除**：路线卡片「查看 → 编辑 / 删除」，改动自动落盘。
- **年度复盘**：切到「年度复盘」标签页，按年查看占比与趋势。
- **备份 / 导入**：右上角「备份 → 导出 JSON」离线备份；「导入数据」批量合并。
- **直接改数据**：编辑 `data/routes.json`（标准 JSON），刷新即生效。

完整说明见 [docs/wiki/](docs/wiki/Home.md)：
- [功能能力](docs/wiki/功能能力.md)
- [部署指南](docs/wiki/部署指南.md)
- [数据与使用](docs/wiki/数据与使用.md)

---

## 🔒 数据存储与隐私

- 真实数据在你自己的服务器挂载卷 `data/routes.json`，不在任何第三方云。
- 容器每次保存/删除后**同步写盘**，重启、崩溃均不丢数据（卷已挂载）。
- **关于 IMA**：IMA 是文档知识库，无结构化读写 API，不适合做实时后端；可把仓库 `旅行手账_归档.md` 放进 IMA 作「只读旅行年鉴」，实时数据仍以本工作台为准。

---

## 🐳 镜像发布方式（维护者参考）

代码推送到 GitHub 后，镜像通过 **GitHub Actions 自动双注册表发布**（即 `docker-image-publish` 流程）：

1. 仓库已配置 Actions Secret：`DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN`（ghcr 用自动注入的 `GITHUB_TOKEN`，无需配置）。
2. 打版本 tag 并推送即触发构建：
   ```bash
   git tag -a v1.0.0 -m "v1.0.0"
   git push origin main --tags
   ```
3. Actions 把镜像推到 `ghcr.io/hanyuestar/travel-expense` 与 `kyson666/travel-expense`，`latest` 始终指向最新。
4. 也可在仓库 Actions 页面手动 `workflow_dispatch` 触发。

工作流文件见 [`.github/workflows/docker-image.yml`](.github/workflows/docker-image.yml)。

> 本地改代码后：`docker compose build && docker compose up -d`；或等 CI 出新 tag 镜像后，把 `docker-compose.yml` 的 `image:` 指向新版本（见文件内注释）。

---

## 📁 项目结构

```
travel-expense/
├── .github/workflows/docker-image.yml   # 双注册表自动构建发布
├── docker-compose.yml                   # 编排（端口、挂载卷、镜像引用）
├── Dockerfile                           # node:20-alpine 镜像
├── package.json
├── server.js                            # 后端：托管页面 + /api/routes CRUD + 持久化
├── public/index.html                    # 前端工作台（响应式）
├── data/routes.json                     # ★ 你的全部路线数据（挂载到容器 /data）
├── docs/wiki/                           # Wiki 内容（GitHub Wiki 需手动复制这些 md）
├── 旅行手账_归档.md                      # 供放入 IMA 的归档年鉴
└── README.md
```

---

## ❓ 常见问题

- **页面打不开**：先 `curl http://localhost:3006/api/routes` 看后端是否起；查 `docker logs travel-expense`。
- **数据没更新**：确认 `docker-compose.yml` 里 `./data:/data` 挂载正确。
- **想换端口**：改 `docker-compose.yml` 的 `3006:3000` 左侧。
- **迁移到新机器**：把整个 `travel-expense/`（含 `data/`）拷过去，`docker compose up -d`。
