// 旅行经费工作台 — 安卓客户端（Capacitor 原生壳）配置
// 该 SPA 无需构建：webDir 直接指向仓库根目录的 public/，由 `cap sync` 拷贝进安卓资源。
const { CapacitorConfig } = require('@capacitor/cli');

/** @type {CapacitorConfig} */
const config = {
  // 应用 ID（安卓包名），发布到商店前请改为你自己的反向域名
  appId: 'com.hanyuestar.travelexpense',
  // 安装后桌面显示的名称
  appName: '旅行经费工作台',
  // SPA 静态资源目录：相对本配置文件所在目录（android-app/）上一级的 public/
  webDir: '../public',
  server: {
    // 安卓 WebView 本地服务方案：默认 http://localhost。
    // 应用内 SPA 通过 fetch 直连用户自托管服务器（见 public/assets/api.js 的 getServerUrl）。
    androidScheme: 'http'
  }
};

module.exports = config;
