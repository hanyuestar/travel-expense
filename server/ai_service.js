/* AI 服务：OpenAI 兼容接口调用（文本模型）
 * - testConnection：发送最简 chat completion 验证连通性与密钥
 * - planItinerary：根据起止日期、目的地、天数生成行程路线文本
 * 使用 Node 18+ 内置全局 fetch，无额外依赖。
 * 支持 skip_ssl_verify：内网/自签名证书场景跳过 SSL 验证（Synology NAS 等常见）。 */
'use strict';

/* undici 是 Node.js 18+ 内置的 fetch 底层实现，用于自定义 dispatcher 跳过 SSL 验证 */
let undiciAgent = null;
function getInsecureDispatcher() {
  if (!undiciAgent) {
    try {
      const { Agent } = require('undici');
      undiciAgent = new Agent({ connect: { rejectUnauthorized: false } });
    } catch (e) {
      /* 极少数环境 undici 不可用，回退到环境变量方式 */
      undiciAgent = null;
    }
  }
  return undiciAgent;
}

/* 规范化 base URL：确保以 /v1 结尾且无多余斜杠，兼容用户填裸域名或带 path */
function normalizeBaseUrl(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  /* 如果用户没填 /v1，自动补上（OpenAI 兼容规范） */
  if (!/\/v\d+$/.test(u)) u += '/v1';
  return u;
}

/* 提取 fetch 失败的底层原因（证书错误、DNS 错误等），给用户可操作的提示 */
function extractFetchError(e) {
  const cause = e && e.cause;
  const code = cause && cause.code;
  /* 常见 SSL/证书错误 */
  if (code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'CERT_HAS_EXPIRED' ||
      code === 'CERT_NOT_YET_VALID' || /cert/i.test(code || '')) {
    return 'SSL 证书验证失败（' + code + '）。如果是内网/自签名证书（如 Synology NAS），请在 AI 配置中开启「跳过 SSL 证书验证」。';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'DNS 解析失败（' + code + '），请检查 API 地址是否正确、服务器是否能访问该域名。';
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT') {
    return '网络连接失败（' + code + '），请检查端口是否开放、防火墙是否放行、服务是否正常运行。';
  }
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return 'SSL 证书域名不匹配（' + code + '），证书中的域名与请求地址不一致。可开启「跳过 SSL 证书验证」临时解决。';
  }
  /* 其他错误，尽量返回有意义的信息 */
  const msg = (cause && cause.message) || e.message || '未知错误';
  return '网络请求失败：' + msg + (code ? '（错误码：' + code + '）' : '');
}

/* 调用 OpenAI 兼容 /chat/completions，返回 assistant 文本内容 */
async function chatCompletion(config, messages, opts = {}) {
  const base = normalizeBaseUrl(config.api_base_url);
  if (!base) throw new Error('未配置 API 地址');
  if (!config.api_key) throw new Error('未配置 API 密钥');
  if (!config.model_id) throw new Error('未配置模型 ID');

  const url = base + '/chat/completions';
  const body = {
    model: config.model_id,
    messages,
    temperature: opts.temperature != null ? opts.temperature : 0.7,
    max_tokens: opts.max_tokens || 2048,
    stream: false
  };

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs || 30000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  /* 构建 fetch 选项：跳过 SSL 验证时注入 insecure dispatcher */
  const fetchOpts = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + config.api_key
    },
    body: JSON.stringify(body),
    signal: controller.signal
  };
  if (config.skip_ssl_verify) {
    const dispatcher = getInsecureDispatcher();
    if (dispatcher) fetchOpts.dispatcher = dispatcher;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // 兜底
  }

  let resp;
  try {
    resp = await fetch(url, fetchOpts);
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('请求超时（' + (timeoutMs / 1000) + '秒），请检查网络或 API 地址');
    throw new Error(extractFetchError(e));
  }
  clearTimeout(timer);

  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error('接口返回非 JSON（HTTP ' + resp.status + '）：' + text.slice(0, 200));
  }
  if (!resp.ok) {
    const msg = (data && data.error && (data.error.message || data.error.code)) || JSON.stringify(data).slice(0, 200);
    throw new Error('接口错误（HTTP ' + resp.status + '）：' + msg);
  }
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    && data.choices[0].message.content;
  if (content == null) throw new Error('接口返回中没有 choices[0].message.content：' + JSON.stringify(data).slice(0, 200));
  return String(content).trim();
}

/* 测试连通性：发一条极简消息，能正常返回即视为配置可用 */
async function testConnection(config) {
  const content = await chatCompletion(
    config,
    [
      { role: 'system', content: '你是一个连通性测试助手。' },
      { role: 'user', content: '请只回复两个字：正常' }
    ],
    { temperature: 0, max_tokens: 16, timeoutMs: 15000 }
  );
  return { ok: true, reply: content };
}

/* 行程规划：根据起止日期、目的地、天数生成按天景点路线
 * 返回纯文本，直接回填到景点路线框。 */
async function planItinerary(config, { startDate, endDate, dest, days }) {
  if (!startDate || !endDate) throw new Error('缺少出行起止日期');
  if (!dest) throw new Error('缺少主要目的地');
  const d = parseInt(days, 10) || 0;
  if (d <= 0) throw new Error('天数无效');

  const system = '你是一位资深旅行规划师，擅长根据目的地和出行天数生成合理、紧凑且可执行的每日行程。';
  const user = `请为我规划一次旅行行程：
- 主要目的地：${dest}
- 出行日期：${startDate} 至 ${endDate}（共 ${d} 天）
- 输出要求：
  1. 按天输出，每天以 "Day1"、"Day2"……开头；
  2. 每天包含上午、下午、晚上的主要景点/活动安排，用简短分号分隔；
  3. 每天的住宿城市写在当天末尾，用括号标注；
  4. 只输出行程正文，不要任何开场白、总结或额外说明；
  5. 路线安排要考虑地理顺序，避免来回折返。`;

  const content = await chatCompletion(
    config,
    [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    { temperature: 0.7, max_tokens: 4096, timeoutMs: 120000 }
  );
  return content;
}

module.exports = { testConnection, planItinerary, normalizeBaseUrl };
