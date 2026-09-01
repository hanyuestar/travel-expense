// 在 `cap sync` 生成的安卓原生工程之上，注入本项目所需的原生定制：
//   1) 允许 WebView 接受第三方 Cookie（跨域直连自托管服务器时保持登录态）
//   2) 按主机放行的 SSL 错误处理（仅对内置服务器地址忽略证书信任错误，不盲目放行）
//
// 为什么需要它：android/ 是 Capacitor 生成的产物、被 .gitignore 忽略，不入库。
// 若只改本地 android/ 下的 MainActivity.java，新版 clone 执行 `cap add android` 后会丢失定制。
// 本脚本幂等：每次 `npm run sync` 后重跑即可；已定制则跳过。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = join(
  __dirname, '..', 'android', 'app', 'src', 'main', 'java',
  'com', 'hanyuestar', 'travelexpense', 'MainActivity.java'
);

const MARKER = '// TE_NATIVE_PATCHED';

const content = `// TE_NATIVE_PATCHED
package com.hanyuestar.travelexpense;

import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.net.http.SslError;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends BridgeActivity {
  // 仅在 SSL 证书「不被系统信任」时仍继续加载的服务器主机集合。
  //
  // 适用场景：用户自托管服务器使用了合法但 WebView 默认不信任的证书，例如
  // Let's Encrypt 证书的 SAN 未覆盖所用子域名（如 hanyueppy.synology.me 签发的
  // 证书不包含 travel.hanyueppy.synology.me），导致 APP 内请求报「证书不被信任」。
  //
  // 安全边界：主机集合由构建时注入的 window.TE_BUILTIN_SERVER 自动推导，绝不硬编码
  // 任何具体域名到源码；且只对「命中本机已知服务器主机」的 SSL 错误放行，其余一律
  // 走系统默认（取消加载），避免对任意主机盲目信任。若服务器证书可被正确签发
  // （SAN 覆盖子域名 / 完整证书链），本逻辑不会触发，行为与系统默认一致。
  private static final String TAG = "TE.MainActivity";
  private final Set<String> trustedHosts = new HashSet<>();

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    // 允许 WebView 接受跨站（第三方）Cookie：APP 页面运行在 http(s)://localhost，
    // 而会话 Cookie 由用户自托管服务器域名种下，属跨站 Cookie。若不开启，
    // WebView 默认拦截，导致 APP 内每次请求都「未登录」。
    CookieManager cm = CookieManager.getInstance();
    cm.setAcceptCookie(true);
    if (getBridge() != null && getBridge().getWebView() != null) {
      cm.setAcceptThirdPartyCookies(getBridge().getWebView(), true);
    }
    loadTrustedHosts();
    installSslErrorHandler();
  }

  // 从注入后的 index.html 解析内置服务器地址，提取 host 作为可信主机。
  // 该文件位于 APK assets（构建产物），不进入公开仓库，故不会泄露个人域名。
  private void loadTrustedHosts() {
    try {
      InputStream is = getAssets().open("public/index.html");
      BufferedReader r = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
      StringBuilder sb = new StringBuilder();
      String line;
      while ((line = r.readLine()) != null) {
        sb.append(line);
      }
      r.close();
      Matcher m = Pattern.compile("TE_BUILTIN_SERVER=\\\"([^\\\"]+)\\\"").matcher(sb.toString());
      if (m.find()) {
        String host = new URL(m.group(1)).getHost();
        if (host != null && !host.isEmpty()) {
          trustedHosts.add(host.toLowerCase());
          Log.i(TAG, "trusted SSL host loaded: " + host);
        }
      }
    } catch (Exception e) {
      Log.w(TAG, "loadTrustedHosts failed (no built-in server / asset missing): " + e.getMessage());
    }
  }

  // 在 Capacitor 原生的 BridgeWebViewClient 之上，仅覆写 onReceivedSslError，
  // 保留桥接消息等全部默认行为。
  private void installSslErrorHandler() {
    if (getBridge() == null || getBridge().getWebView() == null) {
      return;
    }
    WebView wv = getBridge().getWebView();
    wv.setWebViewClient(new BridgeWebViewClient(getBridge()) {
      @Override
      public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        String url = error.getUrl();
        String host = (url != null) ? Uri.parse(url).getHost() : null;
        if (host != null && trustedHosts.contains(host.toLowerCase())) {
          Log.w(TAG, "proceeding on SSL error for trusted host: " + host + " (" + error.getPrimaryError() + ")");
          handler.proceed();
        } else {
          Log.w(TAG, "SSL error for untrusted host, cancelling: " + host);
          handler.cancel();
        }
      }
    });
  }
}
`;

if (!existsSync(target)) {
  console.warn('[patch-native] 未找到 MainActivity.java，请先运行 `npm run add` 与 `npm run sync`。跳过注入。');
  process.exit(0);
}
const cur = readFileSync(target, 'utf8');
if (cur.includes(MARKER)) {
  console.log('[patch-native] MainActivity.java 已定制，跳过。');
  process.exit(0);
}
writeFileSync(target, content);
console.log('[patch-native] 已注入原生定制（第三方 Cookie + 按主机放行 SSL）。');
