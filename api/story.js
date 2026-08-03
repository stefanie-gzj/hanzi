/**
 * 识字绘本工坊 · 故事生成中转接口
 *
 * 为什么需要这个文件：
 * 网页是公开的，任何人都能看到里面的代码。如果把 API 密钥写进网页，
 * 别人打开就能偷走，拿你的额度刷，账单算你的。
 * 所以密钥只放在这里（服务器端环境变量），浏览器永远看不到。
 *
 * 在 Vercel 的 Settings → Environment Variables 里配置：
 *   AI_API_KEY   （必填）平台控制台里创建的 API Key
 *   AI_MODEL     （必填）模型名，例如 glm-4-flash
 *   AI_BASE_URL  （选填）不填则默认用智谱
 *
 * 下面这些平台都兼容同一套接口格式，换厂商只改环境变量，不用动代码：
 *   智谱 GLM      https://open.bigmodel.cn/api/paas/v4/chat/completions   模型 glm-4-flash（永久免费）
 *   火山方舟豆包   https://ark.cn-beijing.volces.com/api/v3/chat/completions
 *   硅基流动      https://api.siliconflow.cn/v1/chat/completions
 *   阿里百炼通义   https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
 *   DeepSeek     https://api.deepseek.com/chat/completions
 */

const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const DEFAULT_MODEL = 'glm-4-flash';
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

  const apiKey  = process.env.AI_API_KEY;
  const model   = process.env.AI_MODEL || DEFAULT_MODEL;
  const baseUrl = process.env.AI_BASE_URL || DEFAULT_BASE_URL;

  if (!apiKey) {
    res.status(500).json({
      error: '还没配置密钥。请到 Vercel 项目的 Settings → Environment Variables，添加 AI_API_KEY（和 AI_MODEL），保存后重新部署一次。',
    });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const prompt = body && typeof body.prompt === 'string' ? body.prompt.trim() : '';

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

  try {
    const upstream = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 1.0,   // 让每次故事都不一样
        max_tokens: 2000,
      }),
      signal: controller.signal,
    });

    const data = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      const detail =
        (data && data.error && (data.error.message || data.error.code)) ||
        (data && data.message) ||
        `HTTP ${upstream.status}`;
      let friendly = `AI 接口报错：${detail}`;
      if (upstream.status === 401 || upstream.status === 403) {
        friendly = '密钥无效或没有权限。请检查 Vercel 里的 AI_API_KEY 有没有填对（前后不要有空格），以及这个模型在控制台里是否已开通。';
      } else if (upstream.status === 404) {
        friendly = '找不到这个模型或接口地址。请检查 AI_MODEL 和 AI_BASE_URL 是否和你选的平台对得上。';
      } else if (upstream.status === 429) {
        friendly = '请求太频繁，或额度已用完。等一会儿再试，或去控制台看看余额。';
      }
      res.status(502).json({ error: friendly });
      return;
    }

    const text =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content;

    if (!text || !String(text).trim()) {
      res.status(502).json({ error: 'AI 返回了空内容，请再试一次。' });
      return;
    }

    res.status(200).json({ text: String(text).trim() });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      res.status(504).json({ error: 'AI 响应超时（超过 60 秒）。请再试一次，或把故事字数调小一点。' });
      return;
    }
    res.status(500).json({ error: '中转接口出错：' + (err && err.message ? err.message : '未知错误') });
  } finally {
    clearTimeout(timer);
  }
};
