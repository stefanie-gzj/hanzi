/**
 * 识字绘本工坊 · 故事生成中转接口
 *
 * 为什么需要这个文件：
 * 网页是公开的，任何人都能看到里面的代码。如果把 API 密钥写进网页，
 * 别人打开就能偷走，拿你的额度刷，账单算你的。
 * 所以密钥只放在这里（服务器端环境变量），浏览器永远看不到。
 *
 * 现在支持两家 AI，网页上可以手动切换（见 index.html 里的"这次用哪家 AI"）：
 *
 *   DeepSeek（默认）：
 *     DEEPSEEK_API_KEY   （必填，也兼容旧的 AI_API_KEY）
 *     DEEPSEEK_MODEL     （选填，默认 deepseek-chat，也兼容旧的 AI_MODEL）
 *     DEEPSEEK_BASE_URL  （选填，默认 https://api.deepseek.com/chat/completions，也兼容旧的 AI_BASE_URL）
 *
 *   Google Gemini：
 *     GEMINI_API_KEY     （必填，去 aistudio.google.com/apikey 免费申请）
 *     GEMINI_MODEL       （选填，默认 gemini-flash-latest，即 Google 当前最新的免费 flash 模型，
 *                          用这个别名可以避免以后模型改名/下线导致又要来改这里）
 *     GEMINI_BASE_URL    （选填，默认走 Gemini 的 OpenAI 兼容接口）
 *
 * 这两家的接口格式是兼容的（都是 OpenAI 的 chat/completions 格式），
 * 所以这份代码不用为每家写一套逻辑，只是"密钥、模型名、网址"这三样按 provider 换一套。
 * 以后要加第三家，只要它也兼容这套格式，加一段 PROVIDERS 配置就行，不用改下面的逻辑。
 */

const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    key: () => process.env.DEEPSEEK_API_KEY || process.env.AI_API_KEY,
    model: () => process.env.DEEPSEEK_MODEL || process.env.AI_MODEL || 'deepseek-chat',
    baseUrl: () => process.env.DEEPSEEK_BASE_URL || process.env.AI_BASE_URL || 'https://api.deepseek.com/chat/completions',
  },
  gemini: {
    label: 'Google Gemini',
    key: () => process.env.GEMINI_API_KEY,
    model: () => process.env.GEMINI_MODEL || 'gemini-flash-latest',
    baseUrl: () => process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  },
};
const DEFAULT_PROVIDER = 'deepseek';

const MAX_PROMPT = 20000;   // 防止被人当免费通用 AI 刷额度
const TIMEOUT_MS = 60000;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST');
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: '这个接口只接受 POST 请求。' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const prompt = body && typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const providerName = (body && typeof body.provider === 'string' && PROVIDERS[body.provider])
    ? body.provider
    : DEFAULT_PROVIDER;
  const provider = PROVIDERS[providerName];

  const apiKey  = provider.key();
  const model   = provider.model();
  const baseUrl = provider.baseUrl();

  if (!apiKey) {
    res.status(500).json({
      error: `还没配置 ${provider.label} 的密钥。请到 Vercel 项目的 Settings → Environment Variables 添加对应的 API_KEY，保存后重新部署一次。`,
    });
    return;
  }

  if (!prompt) {
    res.status(400).json({ error: '没有收到指令内容。' });
    return;
  }
  if (prompt.length > MAX_PROMPT) {
    res.status(400).json({ error: '指令太长了。' });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // 有些新模型（如 GLM-4.7-Flash）默认会先"思考"再回答，思考过程会吃掉 token 上限，
  // 导致正文还没写完就被截断，返回空内容。所以默认关掉思考模式。
  // 万一某个平台不认这个参数，下面会自动去掉它重试一次。
  const buildBody = (withThinking) => {
    const b = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 1.0,   // 让每次故事都不一样
      max_tokens: 8000,   // 给足空间，避免被截断
    };
    if (withThinking) b.thinking = { type: 'disabled' };
    return JSON.stringify(b);
  };

  const call = (withThinking) => fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: buildBody(withThinking),
    signal: controller.signal,
  });

  try {
    let upstream = await call(true);
    let data = await upstream.json().catch(() => null);

    // 平台不认识 thinking 参数 → 去掉它再试一次
    if (!upstream.ok && upstream.status === 400) {
      upstream = await call(false);
      data = await upstream.json().catch(() => null);
    }

    if (!upstream.ok) {
      const detail =
        (data && data.error && (data.error.message || data.error.code)) ||
        (data && data.message) ||
        `HTTP ${upstream.status}`;
      let friendly = `[${provider.label}] AI 接口报错：${detail}`;
      if (upstream.status === 401 || upstream.status === 403) {
        friendly = `[${provider.label}] 密钥无效或没有权限。请检查 Vercel 里对应的 API_KEY 有没有填对（前后不要有空格），以及这个模型是否已开通。`;
      } else if (upstream.status === 404) {
        friendly = `[${provider.label}] 找不到这个模型或接口地址。请检查对应的 MODEL 和 BASE_URL 设置。`;
      } else if (upstream.status === 429) {
        friendly = `[${provider.label}] 请求太频繁，或额度/余额已用完。等一会儿再试，或去控制台看看余额。`;
      }
      res.status(502).json({ error: friendly });
      return;
    }

    const msg =
      (data && data.choices && data.choices[0] && data.choices[0].message) || null;
    const finish =
      (data && data.choices && data.choices[0] && data.choices[0].finish_reason) || '';
    const text = msg && msg.content;

    if (!text || !String(text).trim()) {
      // 思考型模型有时只产出思考过程；或者被 token 上限截断
      if (msg && msg.reasoning_content) {
        res.status(502).json({
          error: `[${provider.label}] 这个模型把额度花在"思考"上，正文没写出来。建议换一个不带思考的模型，或把故事字数调小。`,
        });
        return;
      }
      if (finish === 'length') {
        res.status(502).json({ error: `[${provider.label}] 内容被长度限制截断了。把故事字数调小一点再试。` });
        return;
      }
      res.status(502).json({ error: `[${provider.label}] AI 返回了空内容，请再试一次。` });
      return;
    }

    res.status(200).json({ text: String(text).trim(), provider: providerName });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      res.status(504).json({ error: `[${provider.label}] AI 响应超时（超过 60 秒）。请再试一次，或把故事字数调小一点。` });
      return;
    }
    res.status(500).json({ error: `[${provider.label}] 中转接口出错：` + (err && err.message ? err.message : '未知错误') });
  } finally {
    clearTimeout(timer);
  }
};
