// Pages Functions：图生图代理 + 8 模型轮换调度
// 密钥只存在服务端环境变量里；模型成绩单存 R2（ai-rank.json），由 media-worker 读写。
import { buildOrder, readRank, writeRank, applyResult, callModel } from './_ai.js';

const ALLOWED_ORIGIN = 'https://photopost.pages.dev';
const MAX_IMAGE_CHARS = 9 * 1024 * 1024;
const MAX_PROMPT = 8000;
const MODEL_TIMEOUT_MS = 50000;

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }, headers || {})
  });
}

function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error(msg || '模型响应超时')); }, ms);
    })
  ]);
}

const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) { b = { start: now, n: 0 }; buckets.set(key, b); }
  b.n += 1;
  if (buckets.size > 4000) { for (const [k, v] of buckets) { if (now - v.start > windowMs) buckets.delete(k); } }
  return b.n > max;
}

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;
  const origin = request.headers.get('Origin') || '';
  if (origin && origin !== ALLOWED_ORIGIN) {
    return json({ error: { message: '来源不被允许' } }, 403);
  }

  if (!env.AGNES_KEY) return json({ error: { message: '服务端未配置密钥' } }, 500);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (limited('gen:' + ip, 20, 60 * 1000)) {
    return json({ error: { message: '请求过于频繁，请稍后再试' } }, 429);
  }

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: { message: '请求格式错误' } }, 400); }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const images = Array.isArray(body.image) ? body.image : [];
  const size = ['768x1024', '1024x768', '1024x1024'].includes(body.size) ? body.size : '768x1024';

  if (!prompt) return json({ error: { message: '提示词不能为空' } }, 400);
  if (prompt.length > MAX_PROMPT) return json({ error: { message: '提示词过长' } }, 400);
  if (images.length > 1) return json({ error: { message: '最多只能带一张参考图' } }, 400);

  let img = '';
  if (images.length === 1) {
    img = images[0];
    if (typeof img !== 'string' || !/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(img)) {
      return json({ error: { message: '图片格式不支持' } }, 400);
    }
    if (img.length > MAX_IMAGE_CHARS) {
      return json({ error: { message: '图片过大，请压缩后再试' } }, 413);
    }
  }

  // 有照片 → 只有「图生图」模型能接；没有照片 → 全部文生图模型可轮换
  const need = images.length === 1 ? 'img' : 'txt';
  const rank = await readRank(env);
  const order = buildOrder(rank, need);
  if (!order.length) return json({ error: { message: '没有可用于该能力的模型' } }, 503);

  const maxTries = Math.min(order.length, 2);
  let lastErr = '';
  const BUSY_RE = /繁忙|队列|排队|429|rate limit/i;

  for (let i = 0; i < maxTries; i++) {
    const m = order[i].m;
    let url = '';
    let ms = 0;
    let err = '';

    for (let attempt = 0; attempt < 2; attempt++) {
      const t0 = Date.now();
      try {
        url = await withTimeout(
          callModel(env, m, prompt, img ? [img] : [], size),
          MODEL_TIMEOUT_MS
        );
        ms = Date.now() - t0;
        err = '';
        break;
      } catch (e) {
        err = String((e && e.message) || e);
        url = '';
        // 上游排队时给一次极短等待重试，仍失败再降级到下一个模型
        if (attempt === 0 && BUSY_RE.test(err)) {
          await new Promise(function (resolve) { setTimeout(resolve, 1500); });
        } else {
          break;
        }
      }
    }

    if (url) {
      applyResult(rank, m.id, true, ms);
      const save = writeRank(env, rank).catch(function () {});
      if (waitUntil) waitUntil(save); else await save;
      return json({
        created: Math.floor(Date.now() / 1000),
        model: m.id,
        modelLabel: m.label,
        platform: m.platform,
        capability: need,
        ms: ms,
        fallback: i,
        data: [{ url: url }]
      }, 200, { 'X-AI-Model': m.id });
    }

    lastErr = err;
    applyResult(rank, m.id, false, 0, lastErr);
  }

  const save = writeRank(env, rank).catch(function () {});
  if (waitUntil) waitUntil(save); else await save;
  return json({ error: { message: '全部模型暂时不可用（最后错误：' + lastErr + '），请稍后重试' } }, 502);
}
