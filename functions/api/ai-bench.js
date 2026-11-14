// 单模型测速：后台「一键测速」逐个调用，避免一次请求跑 8 个模型超时
import { findModel, readRank, writeRank, applyResult, callModel } from './_ai.js';
import { json, isAdmin } from './_shared.js';

const BENCH_PROMPT = 'Warm editorial poster illustration, soft paper texture, minimal composition, warm terracotta and teal palette, no text';
const BENCH_TIMEOUT_MS = 55000;

// 256×256 米色底 + 陶土色圆形，作为图生图测速参考图（固定图，避免每次生成）
const BENCH_IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAEAAQADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9KKKKK886wooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKK8/8AiL8bPD3w7kls53fUNYVAwsLYcrlSV8xzwgOB6sAwO0g18weOPi94m8f7otRvvIsDj/QLMGOD+HqM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';

function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error(msg || '模型响应超时')); }, ms);
    })
  ]);
}

export async function onRequestPost({ request, env, waitUntil }) {
  if (!(await isAdmin(request, env))) return json({ error: { message: '需要先登录后台' } }, 401);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: { message: '请求格式错误' } }, 400); }
  const model = findModel(body && body.model);
  if (!model) return json({ error: { message: '未知模型' } }, 400);

  const rank = await readRank(env);
  const t0 = Date.now();
  let ok = true;
  let err = '';
  let out = '';
  try {
    const images = model.caps.indexOf('img') >= 0 ? [BENCH_IMG] : [];
    out = await withTimeout(
      callModel(env, model, BENCH_PROMPT, images, '768x1024'),
      BENCH_TIMEOUT_MS
    );
    if (!out) throw new Error('模型没有返回图片');
  } catch (e) {
    ok = false;
    err = String((e && e.message) || e).slice(0, 200);
  }
  const ms = Date.now() - t0;
  applyResult(rank, model.id, ok, ms, err);
  const save = writeRank(env, rank);
  if (waitUntil) waitUntil(save); else await save;

  return json({
    ok: ok,
    model: model.id,
    label: model.label,
    platform: model.platform,
    caps: model.caps,
    ms: ms,
    error: err
  });
}
