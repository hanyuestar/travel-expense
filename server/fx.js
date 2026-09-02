/* 汇率换算：静态兜底表（1 外币单位 = X 人民币 CNY）+ 可选实时 API
 * 自托管场景默认离线（静态表），若配置 FX_API_URL 且有网络则尝试刷新并内存缓存。
 * 任何失败都回退静态表，绝不阻断主流程。 */
'use strict';
const https = require('https');
const http = require('http');

/* 静态表：1 单位外币 = 多少 CNY（约等于 2026 年常用值，仅作兜底） */
const STATIC_RATES_TO_CNY = {
  CNY: 1, HKD: 0.92, MOP: 0.89, TWD: 0.225, USD: 7.15, EUR: 7.75, GBP: 9.1,
  JPY: 0.047, KRW: 0.0053, THB: 0.20, SGD: 5.3, AUD: 4.7, CAD: 5.2, NZD: 4.3,
  CHF: 8.0, MYR: 1.6, IDR: 0.00045, PHP: 0.125, VND: 0.00028, INR: 0.086, RUB: 0.075
};

/* 币种符号表：服务端分享页 + 前端经 /api/public/site 下发的唯一来源（删除各端私有副本，避免分叉） */
const CURRENCY_SYMBOLS = {
  CNY: '¥', HKD: 'HK$', MOP: 'MOP$', TWD: 'NT$', USD: '$', EUR: '€', GBP: '£',
  JPY: 'JP¥', KRW: '₩', THB: '฿', SGD: 'S$', AUD: 'A$', CAD: 'C$', NZD: 'NZ$',
  CHF: 'Fr', MYR: 'RM', IDR: 'Rp', PHP: '₱', VND: '₫', INR: '₹', RUB: '₽'
};

let ratesToCny = Object.assign({}, STATIC_RATES_TO_CNY);
let cacheAt = 0;
const CACHE_TTL_MS = 6 * 3600 * 1000;

function known(c) { return c in ratesToCny; }

/* 把 amount（货币 from）换算为货币 to，返回 { value, rate, from, to }；未知货币原样返回 */
function convert(amount, from, to) {
  from = (from || 'CNY').toUpperCase();
  to = (to || 'CNY').toUpperCase();
  const v = parseFloat(amount);
  if (!isFinite(v)) return { value: 0, rate: 1, from, to };
  if (from === to) return { value: v, rate: 1, from, to };
  const rf = ratesToCny[from], rt = ratesToCny[to];
  if (!rf || !rt) return { value: v, rate: 1, from, to, unknown: true };
  const inCny = v * rf;
  return { value: inCny / rt, rate: rf / rt, from, to };
}

/* 可选：从 FX_API_URL 拉取以 CNY 为基准的汇率并刷新缓存
 * 期望返回 JSON 形如 { rates: { USD: 7.15, ... } }（对 CNY 的倍数）或 { CNY: 1, USD: 7.15 } */
function refreshFromApi(apiUrl, timeoutMs) {
  return new Promise((resolve) => {
    if (!apiUrl) return resolve(false);
    const t0 = Date.now();
    if (t0 - cacheAt < CACHE_TTL_MS) return resolve(false); // 缓存期内不刷新
    const lib = apiUrl.startsWith('https') ? https : http;
    const req = lib.get(apiUrl, { timeout: timeoutMs || 4000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(false); }
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          const rates = j.rates || j;
          if (rates && typeof rates === 'object') {
            const next = Object.assign({}, STATIC_RATES_TO_CNY);
            for (const k of Object.keys(rates)) {
              const val = parseFloat(rates[k]);
              if (isFinite(val) && val > 0) next[k.toUpperCase()] = val;
            }
            if (next.CNY) next.CNY = 1;
            ratesToCny = next;
            cacheAt = Date.now();
            return resolve(true);
          }
        } catch (e) { /* ignore */ }
        resolve(false);
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

module.exports = { convert, known, refreshFromApi, STATIC_RATES_TO_CNY, CURRENCY_SYMBOLS, get ratesToCny() { return ratesToCny; } };
