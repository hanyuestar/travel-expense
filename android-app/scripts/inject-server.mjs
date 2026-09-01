// 将「内置服务器地址」注入安卓构建产物（android/app/src/main/assets/public/index.html）。
//
// 来源优先级：环境变量 TE_SERVER_URL  >  android-app/.te-server-url（gitignore，不入库）
//
// 关键点（隐私）：
//   真实的个人服务器地址只存在于 gitignore 的本地文件 / 环境变量 / 以及生成的 android/ 产物中，
//   三者均不进入公开仓库。public/ 源码与仓库提交里永远只有 window.TE_BUILTIN_SERVER 这个占位引用。
//   这样 APP 用户无需填写/查看服务器地址，同时个人域名不会泄露到开源仓库。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function readUrl() {
  if (process.env.TE_SERVER_URL) return process.env.TE_SERVER_URL.trim().replace(/\/+$/, '');
  const f = join(root, '.te-server-url');
  if (existsSync(f)) {
    const v = readFileSync(f, 'utf8').trim().replace(/\/+$/, '');
    if (v) return v;
  }
  return '';
}

const url = readUrl();
const indexPath = join(root, 'android', 'app', 'src', 'main', 'assets', 'public', 'index.html');

if (!url) {
  console.log('[inject-server] 未配置内置服务器地址（TE_SERVER_URL / .te-server-url 均空），跳过注入（APP 仍为通用自托管客户端）。');
  process.exit(0);
}
if (!existsSync(indexPath)) {
  console.warn('[inject-server] 未找到 ' + indexPath + '，请先运行 `npm run add` 与 `npm run sync`。跳过注入。');
  process.exit(0);
}

let html = readFileSync(indexPath, 'utf8');
// 先移除旧注入，避免重复
html = html.replace(/<script>\s*window\.TE_BUILTIN_SERVER\s*=[^<]*<\/script>/, '');

const injection = '<script>window.TE_BUILTIN_SERVER=' + JSON.stringify(url) + ';</script>';
const moduleIdx = html.indexOf('<script type="module"');
if (moduleIdx === -1) {
  html = html.replace('</head>', injection + '\n</head>');
} else {
  html = html.slice(0, moduleIdx) + injection + '\n' + html.slice(moduleIdx);
}
writeFileSync(indexPath, html);
console.log('[inject-server] 已注入内置服务器地址：' + url);
