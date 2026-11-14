// 8 个出图大模型的统一池：轮换调度、成绩单读写、两种上游调用
// 数据来源：freellmapi.co/models 的 image 模型目录（按目录 speedRank 取值），
// 速度与可用性以本站实测成绩单为准（存 R2 的 ai-rank.json）。
import { callMedia } from './_shared.js';

const AGNES_BASE = 'https://apihub.agnes-ai.cn/v1';

// caps: img = 可直接用用户照片做图生图；txt = 纯文生图（不吃照片）
export const AI_POOL = [
  { id: 'agnes/agnes-image-2.1-flash', label: 'Agnes Image 2.1 Flash', platform: 'Agnes', kind: 'agnes', caps: ['img', 'txt'], catalogRank: 215 },
  { id: 'agnes/agnes-image-2.0-flash', label: 'Agnes Image 2.0 Flash', platform: 'Agnes', kind: 'agnes', caps: ['img', 'txt'], catalogRank: 214 },
  { id: '@cf/black-forest-labs/flux-1-schnell', label: 'FLUX.1 schnell', platform: 'Cloudflare', kind: 'cf', caps: ['txt'], catalogRank: 203 },
  { id: '@cf/stabilityai/stable-diffusion-xl-base-1.0', label: 'SDXL Base 1.0', platform: 'Cloudflare', kind: 'cf', caps: ['txt'], catalogRank: 204 },
  { id: '@cf/bytedance/stable-diffusion-xl-lightning', label: 'SDXL Lightning', platform: 'Cloudflare', kind: 'cf', caps: ['txt'], catalogRank: 207 },
  { id: '@cf/lykon/dreamshaper-8-lcm', label: 'DreamShaper 8 LCM', platform: 'Cloudflare', kind: 'cf', caps: ['txt'], catalogRank: 208 },
  { id: '@cf/leonardo/lucid-origin', label: 'Leonardo Lucid Origin', platform: 'Cloudflare', kind: 'cf', caps: ['txt'], catalogRank: 210 },
  { id: '@cf/leonardo/phoenix-1.0', label: 'Leonardo Phoenix 1.0', platform: 'Cloudflare', kind: 'cf', caps: ['txt'], catalogRank: 211 }
];

export function findModel(id) {
  return AI_POOL.find(function (m) { return m.id === id; }) || null;
}

export function emptyRank() {
  return { updatedAt: 0, turn: 0, models: {} };
}

function normalizeRank(j) {
  const out = emptyRank();
  if (!j || typeof j !== 'object') return out;
  out.turn = Number(j.turn) || 0;
  out.updatedAt = Number(j.updatedAt) || 0;
  const models = (j.models && typeof j.models === 'object') ? j.models : {};
  AI_POOL.forEach(function (m) {
    const st = models[m.id];
    if (!st || typeof st !== 'object') return;
    out.models[m.id] = {
      ok: Number(st.ok) || 0,
      fail: Number(st.fail) || 0,
      avgMs: Number(st.avgMs) || 0,
      lastMs: Number(st.lastMs) || 0,
      lastAt: Number(st.lastAt) || 0,
      lastError: String(st.lastError || '').slice(0, 200)
    };
  });
  return out;
}

export async function readRank(env) {
  try {
    const res = await callMedia(env, '/ai/rank');
    if (!res.ok) return emptyRank();
    return normalizeRank(await res.json());
  } catch (e) {
    return emptyRank();
  }
}

export async function writeRank(env, rank) {
  rank.updatedAt = Date.now();
  const res = await callMedia(env, '/ai/rank', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rank)
  });
  return res.ok;
}

// 综合得分 = 成功率(%) × 10 ÷ 平均耗时(秒)；没测过的返回 null
export function scoreOf(st) {
  if (!st) return null;
  const ok = Number(st.ok) || 0;
  const fail = Number(st.fail) || 0;
  const total = ok + fail;
  if (!total) return null;
  const sr = ok / total;
  const avgSec = Math.max(0.4, (Number(st.avgMs) || 0) / 1000);
  return Math.round(sr * 100 * 10 / avgSec * 10) / 10;
}

export function successRateOf(st) {
  if (!st) return null;
  const total = (Number(st.ok) || 0) + (Number(st.fail) || 0);
  if (!total) return null;
  return Math.round((Number(st.ok) || 0) / total * 1000) / 10;
}

// 轮换上岗：同能力组内按得分从高到低排队；每第 6 次请求把「最后一名 / 未测过的」
// 提到最前面复检一次，保证榜单不会一直沿用旧成绩。
export function buildOrder(rank, need) {
  const list = AI_POOL.filter(function (m) { return m.caps.indexOf(need) >= 0; })
    .map(function (m) { return { m: m, score: scoreOf(rank.models[m.id]) }; });

  list.sort(function (a, b) {
    if (a.score == null && b.score == null) return a.m.catalogRank - b.m.catalogRank;
    if (a.score == null) return 1;
    if (b.score == null) return -1;
    return b.score - a.score;
  });

  if (list.length > 1 && (rank.turn || 0) % 6 === 0) {
    const unprobed = list.filter(function (x) { return x.score == null; });
    const pick = unprobed.length ? unprobed[0] : list[list.length - 1];
    return [pick].concat(list.filter(function (x) { return x !== pick; }));
  }
  return list;
}

export function applyResult(rank, id, ok, ms, err) {
  const st = rank.models[id] || (rank.models[id] = {
    ok: 0, fail: 0, avgMs: 0, lastMs: 0, lastAt: 0, lastError: ''
  });
  if (ok) {
    st.ok += 1;
    st.avgMs = st.avgMs ? Math.round(st.avgMs * 0.7 + ms * 0.3) : Math.round(ms);
    st.lastMs = Math.round(ms);
    st.lastError = '';
  } else {
    st.fail += 1;
    st.lastError = String(err || '').slice(0, 200);
  }
  st.lastAt = Date.now();
  rank.turn = (Number(rank.turn) || 0) + 1;
}

function errText(status, text) {
  if (status === 429) return '上游繁忙（队列排队中）';
  let msg = text || '';
  try {
    const j = JSON.parse(text);
    if (j && j.error) msg = (j.error.message || j.error) + '';
  } catch (e) {}
  return (msg || ('上游 HTTP ' + status)).slice(0, 200);
}

// Agnes（支持图生图）：直接带上参考图
export async function callAgnes(env, id, prompt, images, size) {
  if (!env.AGNES_KEY) throw new Error('服务端未配置 AGNES_KEY');
  const model = String(id).replace(/^agnes\//, '');
  const payload = { model: model, prompt: prompt, size: size || '768x1024' };
  if (images && images.length) payload.image = images;

  let upstream;
  try {
    upstream = await fetch(AGNES_BASE + '/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.AGNES_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    throw new Error('上游连接失败');
  }

  const text = await upstream.text();
  if (!upstream.ok) throw new Error(errText(upstream.status, text));

  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error('上游返回格式异常'); }
  const first = j && j.data && j.data[0];
  if (!first) throw new Error('上游未返回图片');
  const url = first.url || (first.b64_json ? 'data:image/png;base64,' + first.b64_json : '');
  if (!url) throw new Error('上游未返回图片地址');
  return url;
}

// Cloudflare Workers AI（纯文生图）：由 media-worker 的 AI 绑定转发，免 API Token
export async function callCf(env, id, prompt) {
  const res = await callMedia(env, '/ai/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: id, prompt: prompt })
  });
  const j = await res.json().catch(function () { return {}; });
  if (!res.ok || !j.ok) throw new Error((j && j.error) || ('Cloudflare HTTP ' + res.status));
  return j.dataUrl;
}

export async function callModel(env, model, prompt, images, size) {
  if (model.kind === 'agnes') return await callAgnes(env, model.id, prompt, images, size);
  return await callCf(env, model.id, prompt);
}
