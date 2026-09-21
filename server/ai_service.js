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

/* 以下状态码值得重试：限流(429)、超时(408)、上游故障(5xx)，
 * 部分 one-api/new-api 聚合网关会把「后端渠道鉴权/额度抖动」误报为 401/403（实测同一请求会随机 401） */
function isRetriableStatus(status) {
  return status === 401 || status === 403 || status === 408 || status === 429 ||
    status === 500 || status === 502 || status === 503 || status === 504;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 调用 OpenAI 兼容 /chat/completions，返回 assistant 文本内容。
 * opts.retries：失败重试次数（规划/调整等幂等请求建议 3，测试连接建议 1），指数退避 + 随机抖动。 */
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

  /* 跳过 SSL 验证时的 dispatcher 只构建一次，重试复用 */
  let dispatcher;
  if (config.skip_ssl_verify) {
    dispatcher = getInsecureDispatcher();
    if (!dispatcher) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // 兜底
  }

  const maxRetries = Math.max(0, opts.retries || 0);
  const timeoutMs = opts.timeoutMs || 30000;
  let lastErr;

  for (let attemptIdx = 0; attemptIdx <= maxRetries; attemptIdx++) {
    /* 每次尝试使用独立超时控制器，避免一次 abort 后后续请求也被取消 */
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const fetchOpts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + config.api_key
      },
      body: JSON.stringify(body),
      signal: controller.signal
    };
    if (dispatcher) fetchOpts.dispatcher = dispatcher;

    let resp = null, text = '';
    try {
      resp = await fetch(url, fetchOpts);
      text = await resp.text();
    } catch (e) {
      clearTimeout(timer);
      const netMsg = e.name === 'AbortError'
        ? '请求超时（' + (timeoutMs / 1000) + '秒），请检查网络或 API 地址'
        : extractFetchError(e);
      lastErr = new Error(netMsg);
      lastErr.retriable = true;   // 网络抖动 / 超时均可重试
    }

    if (resp) {
      clearTimeout(timer);
      let data = null;
      try { data = JSON.parse(text); } catch (e) { data = null; }
      if (resp.ok) {
        const content = data && data.choices && data.choices[0] && data.choices[0].message
          && data.choices[0].message.content;
        if (content == null) {
          lastErr = new Error('接口返回中没有 choices[0].message.content：' + (text || '').slice(0, 200));
          lastErr.retriable = true;   // 空响应多为上游瞬时问题
        } else {
          return String(content).trim();
        }
      } else {
        const msg = (data && data.error && (data.error.message || data.error.code)) || (text || '').slice(0, 200);
        lastErr = new Error('接口错误（HTTP ' + resp.status + '）：' + msg);
        lastErr.httpStatus = resp.status;
        lastErr.retriable = isRetriableStatus(resp.status);
      }
    }

    /* 确定性错误（如 400 模型不存在 / 请求体非法）或已到最后一次，则停止重试 */
    if (!lastErr.retriable || attemptIdx === maxRetries) break;
    const backoff = Math.round(800 * Math.pow(2, attemptIdx) * (0.8 + Math.random() * 0.4));
    await sleep(backoff);
  }

  /* 重试用尽仍 401/403，区分「密钥/权限问题」与「网关渠道抖动」，给出可操作提示 */
  if (lastErr.httpStatus === 401 || lastErr.httpStatus === 403) {
    throw new Error(lastErr.message +
      '（已自动重试 ' + maxRetries + ' 次仍失败：请确认密钥正确、已开通该模型且有额度；若测试连接正常，则多为 API 网关后端渠道临时故障，稍后再试即可）');
  }
  throw lastErr;
}

/* 测试连通性：发一条极简消息，能正常返回即视为配置可用 */
async function testConnection(config) {
  const content = await chatCompletion(
    config,
    [
      { role: 'system', content: '你是一个连通性测试助手。' },
      { role: 'user', content: '请只回复两个字：正常' }
    ],
    { temperature: 0, max_tokens: 16, timeoutMs: 15000, retries: 1 }
  );
  return { ok: true, reply: content };
}

/* ---------- AI 输出解析 ----------
 * 约定模型按三节输出：行程 / 注意事项 / 美食推荐。
 * 解析后：scenic → 景点路线，tips + food → 备注（notes）。
 * 兼容性：模型若未按约定输出（无任何小节标题），则整段视为行程、notes 为空，
 * 保证旧行为不回归。 */
const AI_SECTIONS = [
  { key: 'scenic', labels: ['行程', '行程安排', '每日行程', '路线安排', '路线'] },
  { key: 'tips', labels: ['注意事项', '出行提示', '温馨提示', '旅行提示'] },
  { key: 'food', labels: ['美食推荐', '当地美食', '美食'] }
];
const AI_LABELS = AI_SECTIONS.reduce((a, s) => a.concat(s.labels), []);

/* 判断某一行是否为小节标题（容忍 markdown 前缀、方括号、尾部冒号） */
function sectionKey(line) {
  let t = String(line || '').trim();
  t = t.replace(/^[#>*\-\s]+/, '').replace(/[#*\s]+$/, '');
  t = t.replace(/^[【\[]/, '').replace(/[】\]]$/, '');
  t = t.replace(/[:：]\s*$/, '').trim();
  for (const sec of AI_SECTIONS) if (sec.labels.includes(t)) return sec.key;
  return null;
}

function parseAiItinerary(text) {
  const raw = String(text || '').trim();
  if (!raw) return { scenic: '', notes: '' };

  /* 把行内出现的小节标记规范成独占一行，兼容「一行到底」的输出 */
  const inlineRe = new RegExp('[【\\[]\\s*(' + AI_LABELS.join('|') + ')\\s*[】\\]]', 'g');
  const norm = raw.replace(inlineRe, '\n【$1】\n');

  const buckets = { scenic: [], tips: [], food: [] };
  const other = [];
  let cur = null, matched = false;
  for (const line of norm.split(/\r?\n/)) {
    const k = sectionKey(line);
    if (k) { cur = k; matched = true; continue; }
    (cur ? buckets[cur] : other).push(line);
  }

  /* 未按约定输出 → 整段当作行程（保持旧行为） */
  if (!matched) return { scenic: raw, notes: '' };

  const join = (arr) => arr.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  let scenic = join(buckets.scenic);
  /* 模型只给了注意事项/美食、漏了行程标题时，把标题前的内容并入行程 */
  if (!scenic) scenic = join(other);

  const notesParts = [];
  const tips = join(buckets.tips);
  const food = join(buckets.food);
  if (tips) notesParts.push('【注意事项】\n' + tips);
  if (food) notesParts.push('【美食推荐】\n' + food);

  return { scenic, notes: notesParts.join('\n\n') };
}

/* ---------- 可编辑预置提示词 ----------
 * 管理员可在后台修改这些提示词以获得不同的规划结果；数据库为空时使用下列内置默认。
 * user 模板支持占位符（renderTemplate 替换）：
 *   行程规划：{dest} {startDate} {endDate} {days}
 *   行程调整：{currentScenic} {currentNotes} {message} {dest} {startDate} {endDate} {days} */
const DEFAULT_PROMPTS = {
  plan_system_prompt: '你是一位资深旅行规划师，擅长根据目的地和出行天数生成合理、紧凑且可执行的每日行程，并熟悉当地的实用注意事项与特色美食。',
  plan_user_prompt: `请为我规划一次旅行：
- 主要目的地：{dest}
- 出行日期：{startDate} 至 {endDate}（共 {days} 天）

请严格按照以下三个小节输出，小节标题必须独占一行、使用【】包裹，不要输出任何开场白、总结或额外说明：

【行程】
按天输出，每天以 "Day1"、"Day2"……开头；每天包含上午、下午、晚上的主要景点/活动安排，用简短分号分隔；每天的住宿城市写在当天末尾，用括号标注；路线安排要考虑地理顺序，避免来回折返。

【注意事项】
列出 4-6 条当地实用注意事项（如天气与穿着、高原反应、门票预约、防晒、交通与安全、风俗禁忌等），每条一行，以 "- " 开头，尽量具体可执行。

【美食推荐】
列出 4-6 条当地特色美食或值得一试的餐馆类型，每条一行，以 "- " 开头，可注明大致价位或推荐理由。`,
  chat_system_prompt: '你是一位资深旅行规划师，擅长根据用户的具体要求对已有行程进行精准调整。调整时只修改用户要求的部分，保持其余内容不变，输出完整的调整后行程。',
  chat_user_prompt: `当前已有行程：
{currentScenic}

当前备注（注意事项/美食推荐，可能为空）：
{currentNotes}

旅行基本信息：
- 主要目的地：{dest}
- 出行日期：{startDate} 至 {endDate}（共 {days} 天）

用户的调整要求：{message}

请根据用户的要求调整，并严格按照下面的格式输出，小节标题必须独占一行、使用【】包裹，不要输出任何开场白、总结或额外说明：

【行程】
输出调整后的完整行程：按天输出，每天以 "Day1"、"Day2"……开头；每天包含上午、下午、晚上的主要景点/活动安排，用简短分号分隔；每天的住宿城市写在当天末尾，用括号标注；保持原有的天数和整体结构，只修改用户要求调整的部分；路线安排要考虑地理顺序，避免来回折返。

【注意事项】
若本次调整涉及注意事项，输出更新后的完整列表（每条一行，以 "- " 开头）；若不涉及，本节留空。

【美食推荐】
若本次调整涉及美食推荐，输出更新后的完整列表（每条一行，以 "- " 开头）；若不涉及，本节留空。`
};

/* 替换模板中的 {key} 占位符；未提供的变量替换为空串 */
function renderTemplate(tpl, vars) {
  return String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, (m, key) => {
    return (vars && vars[key] !== undefined && vars[key] !== null) ? String(vars[key]) : '';
  });
}

/* 取生效提示词：数据库有自定义值用自定义，否则用内置默认 */
function resolvePrompt(configVal, defaultVal) {
  return (configVal && String(configVal).trim()) ? String(configVal) : defaultVal;
}

/* 行程规划：根据起止日期、目的地、天数生成按天景点路线，
 * 同时产出「注意事项」与「美食推荐」（由调用方回填到备注）。
 * 返回 { scenic, notes }。 */
async function planItinerary(config, { startDate, endDate, dest, days }) {
  if (!startDate || !endDate) throw new Error('缺少出行起止日期');
  if (!dest) throw new Error('缺少主要目的地');
  const d = parseInt(days, 10) || 0;
  if (d <= 0) throw new Error('天数无效');

  const system = resolvePrompt(config.plan_system_prompt, DEFAULT_PROMPTS.plan_system_prompt);
  const userTpl = resolvePrompt(config.plan_user_prompt, DEFAULT_PROMPTS.plan_user_prompt);
  const user = renderTemplate(userTpl, { dest, startDate, endDate, days: d });

  const content = await chatCompletion(
    config,
    [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    { temperature: 0.7, max_tokens: 4096, timeoutMs: 120000, retries: 3 }
  );
  return parseAiItinerary(content);
}

/* 行程对话式调整：基于当前已有行程，根据用户指令修改后返回完整行程
 * 支持多轮对话历史，用户可连续调整。
 * currentScenic：当前景点路线文本；currentNotes：当前备注（含上次生成的注意事项/美食推荐）
 * message：用户本轮调整指令；history：历史对话数组 [{role, content}]
 * 返回 { scenic, notes }；notes 仅在模型本次输出了相关小节时非空。 */
async function adjustItinerary(config, { currentScenic, currentNotes, message, dest, startDate, endDate, days, history }) {
  if (!currentScenic || !String(currentScenic).trim()) throw new Error('缺少当前行程内容，请先生成或填写行程');
  if (!message || !String(message).trim()) throw new Error('缺少调整指令');
  if (!dest) throw new Error('缺少主要目的地');
  const d = parseInt(days, 10) || 0;
  if (d <= 0) throw new Error('天数无效');

  const system = resolvePrompt(config.chat_system_prompt, DEFAULT_PROMPTS.chat_system_prompt);
  const userTpl = resolvePrompt(config.chat_user_prompt, DEFAULT_PROMPTS.chat_user_prompt);
  const user = renderTemplate(userTpl, {
    currentScenic: currentScenic,
    currentNotes: currentNotes && String(currentNotes).trim() ? String(currentNotes).trim() : '（无）',
    message, dest, startDate, endDate, days: d
  });

  /* 构造 messages：system + 历史对话 + 当前 user 请求 */
  const messages = [{ role: 'system', content: system }];
  if (Array.isArray(history) && history.length > 0) {
    for (const h of history) {
      if (h && h.role && h.content) {
        messages.push({ role: String(h.role), content: String(h.content) });
      }
    }
  }
  messages.push({ role: 'user', content: user });

  const content = await chatCompletion(
    config,
    messages,
    { temperature: 0.7, max_tokens: 4096, timeoutMs: 120000, retries: 3 }
  );
  return parseAiItinerary(content);
}

module.exports = { testConnection, planItinerary, adjustItinerary, normalizeBaseUrl, parseAiItinerary, DEFAULT_PROMPTS, renderTemplate };
