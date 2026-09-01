# 旅行经费工作台 · 安卓客户端（Capacitor 原生壳）

把「旅行经费工作台」打包成安卓 APP。APP 本身只是一个 **WebView 壳**，内置的 SPA 通过 `fetch` 直连**用户自己的自托管服务器**——即「服务器即云端」，APP 不存任何本地副本，登录后所有路线数据实时读写云端。

> 架构类比：类似 Jellyfin / Home Assistant 的官方移动端——客户端可连接任意你部署的服务器实例。

---

## 工作原理

1. 首次打开 APP → 进入「连接你的服务器」页（`#/setup`），输入你部署的服务器地址（如 `https://travel.example.com`）。
2. 前端调用 `GET /api/public/server-check` 校验该地址确为旅行经费服务，并取回站点名/注册开关。
3. 登录时调用 `POST /api/auth/login`：
   - 账号**不存在于该服务器** → 返回 `404 ACCOUNT_NOT_FOUND`，APP 提示「该服务器无此账号」。
   - 账号存在、密码正确 → 服务器在响应里种下跨域会话 Cookie（`SameSite=None; Secure`），后续请求自动带上，登录态即「云端同步」。
4. 之后所有路线增删改查都直连该服务器，数据始终在云端，多设备一致。

服务器地址持久化在 WebView 的 `localStorage`（`te_server_url`）；用户菜单「切换服务器」可清空并重新连接。

---

## 内置服务器地址（用户免输入，可选）

如果不希望最终用户自己填写服务器地址，可在**本地构建时**把一个固定服务器地址「烧录」进 APP：

1. 在 `android-app/` 新建 `.te-server-url` 文件，内容为你的服务器地址（含协议与端口），例如：

   ```
   https://travel.example.com
   ```

   该文件已写入 `.gitignore`，**不会进入公开仓库**；也可改用环境变量 `TE_SERVER_URL` 传入（优先级更高）。
2. 照常 `npm run sync` / `npm run build`。构建脚本 `scripts/inject-server.mjs` 会把
   `window.TE_BUILTIN_SERVER="你的地址"` 注入到 `android/app/src/main/assets/public/index.html`
   （即生成的原生工程资源，**同样不入库**）。
3. APP 检测到内置地址后：
   - 首次启动**跳过「连接你的服务器」页**，直接进入登录；
   - 用户菜单中的「切换服务器」自动隐藏；
   - 所有请求直连该内置地址。

> ⚠️ **隐私**：真实的服务器域名只存在于你本机的 `.te-server-url` / 环境变量 / 以及生成的 `android/` 产物中，
> 三者均不入库。仓库源码（`public/`）里只有 `window.TE_BUILTIN_SERVER` 这个占位引用，个人域名不会泄露到开源仓库。

> 后端仍需满足「服务器端需开启的开关」一节：HTTPS + `COOKIE_SECURE=true` + `ALLOWED_ORIGINS=*`。

---

## 前置条件

- Node.js ≥ 18（本机为 v22）
- **Java 17**（Capacitor 6 Android 要求）
- **Android SDK**（API 33+）、Android Studio 或仅命令行 + `ANDROID_HOME` 环境变量
- 一台已开启「未知来源」安装权限的安卓设备 / 模拟器

---

## 服务器端需开启的开关（重要）

APP 以跨域方式访问你的服务器，因此**自托管服务器**必须配置（docker-compose 或环境变量）：

| 变量 | 取值 | 作用 |
|------|------|------|
| `COOKIE_SECURE` | `true` | 服务器在 HTTPS 反向代理后，Cookie 才带 `Secure`，跨域会话才能被 WebView 接受 |
| `ALLOWED_ORIGINS` | `*` 或 `http://localhost` | 允许 APP 的 WebView 来源跨域调用 API 并携带凭证；`*` 表示允许任意来源（自托管场景可接受） |

示例（docker-compose.yml）：

```yaml
environment:
  - COOKIE_SECURE=true
  - ALLOWED_ORIGINS=*
```

> 服务器必须经由 **HTTPS**（nginx / Caddy 等终结 TLS）对外提供，否则 `Secure` Cookie 无法落地，APP 无法保持登录。

---

## 构建步骤

```bash
cd android-app

# 1. 安装 Capacitor 依赖
npm install

# 2. 生成原生安卓工程（仅需一次，生成 android/ 目录）
npm run add

# 3. 把 public/ 的 SPA 拷贝进安卓资源（每次前端改动后执行）
npm run sync

# 4. 生成 APK / AAB
npm run build        # 等价于 cap build android，产物在 android/app/build/outputs/
# 或用 Android Studio 打开 android/ 目录手动构建：npm run open
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`（调试包，可直接安装）。

---

## ⚠️ 必做：启用 WebView 第三方 Cookie（否则登录态不持久）

安卓 WebView 默认**拦截第三方 Cookie**。APP 页面运行在 `http(s)://localhost`，而会话 Cookie 来自你的服务器域名，属于跨站 Cookie，默认不会被存储，导致每次请求都「未登录」。

`npm run add` 生成原生工程后，需在 `android/app/src/main/java/com/hanyuestar/travelexpense/MainActivity.java` 中开启：

```java
package com.hanyuestar.travelexpense;

import android.os.Bundle;
import android.webkit.CookieManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    // 允许 WebView 接受跨站（第三方）Cookie，使自托管服务器种下的会话 Cookie 可被持久化
    CookieManager.getInstance().setAcceptThirdPartyCookies(getBridge().getWebView(), true);
  }
}
```

> 若 `getBridge().getWebView()` 在 `onCreate` 阶段尚未就绪，可改为在 `onStart()` 中调用，或升级到 `onResume()` 时确保 bridge 已初始化后再设置。

---

## 已知限制 / 注意事项

- **真机验证**：本仓库的自动化测试覆盖了服务端 CORS / 账号校验 / 跨域登录返回值，但「WebView 内跨域 Cookie 持久化 + 登录态保持」必须在真实安卓设备 / 模拟器上验证（本机无 Android SDK，无法代为构建 APK）。请按上方步骤在本机完成首次真机冒烟。
- 若第三方 Cookie 在部分安卓版本仍受限，可后续改为 **Token 鉴权**（登录返回 Bearer Token，前端存入 localStorage 并在 `Authorization` 头携带）。当前版本沿用 Cookie 方案（用户已确认）。
- `android/` 原生工程不入库（见 `.gitignore`），通过 `cap add` + `cap sync` 重建。
- 包名 `com.hanyuestar.travelexpense` 仅为默认占位，正式发布前请替换为你的反向域名并在 `capacitor.config.js` 同步修改。
