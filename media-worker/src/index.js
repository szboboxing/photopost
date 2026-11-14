// 云端媒体存储 Worker：R2 桶 photopost-music（音频 + 视频），仅允许带内部令牌的请求（由 Pages Functions 调用）
//
// 成本相关开关（可随时通过 wrangler secret 调整，改完立即生效，无需改代码）：
//   MAX_UPLOAD_MB   单次上传上限（默认 100，取值范围 1~100；100 是 Cloudflare 单请求体的平台上限）
//   MAX_STORAGE_MB  云端媒体总容量上限（默认 8000 ≈ 8GB，取值范围 100~10000；R2 免费额度是 10GB·月）
// 读取路径：单次 R2 get 直接出流（不再 head + get 两次操作），并返回 ETag / 支持 If-None-Match → 304。
const INDEX_KEY = 'index.json';
const SETTINGS_KEY = 'settings.json';
const DEFAULT_SETTINGS = { charts: { enabled: true, updatedAt: 0 } };

// 允许的媒体类型 → 扩展名（均为浏览器可直接播放的格式）
const TYPE_TO_EXT = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/x-mp3': 'mp3',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'aac',
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/webm': 'weba',
  'video/mp4': 'mp4', 'video/x-m4v': 'm4v',
  'video/webm': 'webm', 'video/ogg': 'ogv', 'video/quicktime': 'mov'
};
// 扩展名 → 标准类型（老数据没有 type 字段时按 key 后缀推断）
const EXT_TO_TYPE = {
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', weba: 'audio/webm',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime'
};

function json(obj, status, extraHeaders) {
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, extraHeaders || {});
  return new Response(JSON.stringify(obj), { status: status || 200, headers: headers });
}

function authed(req, env) {
  const t = req.headers.get('X-Media-Token') || '';
  if (!t) return false;
  // 兼容多站点：photopost 用 MEDIA_TOKEN，musicplay 用 MEDIA_TOKEN_MUSIC
  if (env.MEDIA_TOKEN && t === env.MEDIA_TOKEN) return true;
  if (env.MEDIA_TOKEN_MUSIC && t === env.MEDIA_TOKEN_MUSIC) return true;
  return false;
}

// 读取可配上限（非法值回落到默认值）
function pickInt(raw, def, min, max) {
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
function limits(env) {
  const maxUploadMB = pickInt(env && env.MAX_UPLOAD_MB, 100, 1, 100);
  const maxStorageMB = pickInt(env && env.MAX_STORAGE_MB, 8000, 100, 10000);
  return {
    maxUploadMB: maxUploadMB,
    maxStorageMB: maxStorageMB,
    maxUploadBytes: maxUploadMB * 1024 * 1024,
    maxStorageBytes: maxStorageMB * 1024 * 1024
  };
}
function usedBytes(idx) {
  let sum = 0;
  (idx.tracks || []).forEach(function (t) { sum += Number(t.size) || 0; });
  return sum;
}
function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024 * 1024) return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}

// 归一化类型：白名单内直接用；否则按文件名后缀推断；再不行按二进制处理
function resolveType(rawType, nameOrKey) {
  const raw = String(rawType || '').split(';')[0].trim().toLowerCase();
  if (TYPE_TO_EXT[raw]) return { type: raw, ext: TYPE_TO_EXT[raw] };
  const m = /\.([a-z0-9]+)$/i.exec(String(nameOrKey || ''));
  const ext = m ? m[1].toLowerCase() : '';
  if (EXT_TO_TYPE[ext]) return { type: EXT_TO_TYPE[ext], ext: ext };
  return { type: 'application/octet-stream', ext: ext || 'bin' };
}

async function readIndex(env) {
  const obj = await env.MUSIC.get(INDEX_KEY);
  if (!obj) return { tracks: [] };
  try { return await obj.json(); } catch (e) { return { tracks: [] }; }
}

// 站点设置（目前只有「首页热播榜单」开关），后台可随时切换
async function readSettings(env) {
  const obj = await env.MUSIC.get(SETTINGS_KEY);
  let saved = {};
  if (obj) { try { saved = await obj.json(); } catch (e) { saved = {}; } }
  const charts = (saved && saved.charts) || {};
  return {
    charts: {
      enabled: charts.enabled === undefined ? DEFAULT_SETTINGS.charts.enabled : !!charts.enabled,
      updatedAt: Number(charts.updatedAt) || 0
    }
  };
}

async function writeSettings(env, settings) {
  await env.MUSIC.put(SETTINGS_KEY, JSON.stringify(settings), {
    httpMetadata: { contentType: 'application/json' }
  });
}

async function writeIndex(env, idx) {
  await env.MUSIC.put(INDEX_KEY, JSON.stringify(idx), {
    httpMetadata: { contentType: 'application/json' }
  });
}

// 解析 Range 头：返回 R2 需要的 range 参数；不合法时返回 { bad:true }
function rangeSpec(header) {
  const raw = String(header || '').trim();
  if (!raw) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!m || (!m[1] && !m[2])) return { bad: true };
  if (!m[1]) {
    const suffix = parseInt(m[2], 10);
    return suffix > 0 ? { range: { suffix: suffix } } : { bad: true };
  }
  const start = parseInt(m[1], 10);
  if (m[2]) {
    const end = parseInt(m[2], 10);
    if (end < start) return { bad: true };
    return { range: { offset: start, length: end - start + 1 } };
  }
  return { range: { offset: start } };   // bytes=N- ：R2 会一直读到末尾
}

// ---------- AI 出图辅助 ----------
const AI_RANK_KEY = 'ai-rank.json';
const AI_TIMEOUT_MS = 45000;
const AI_MODEL_RE = /^@cf\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,120}$/;

// 分块转 base64，避免超大数组触发 String.fromCharCode 参数上限
function bytesToBase64(bytes) {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);

    if (path === '/health') return json({ ok: true, service: 'photopost-media' });

    if (path === '/settings') {
      if (req.method === 'GET') return json(await readSettings(env));
      if (req.method === 'POST') {
        let body;
        try { body = await req.json(); } catch (e) { return json({ error: '格式错误' }, 400); }
        const cur = await readSettings(env);
        const incoming = (body && body.charts) || {};
        const next = {
          charts: {
            enabled: incoming.enabled === undefined ? cur.charts.enabled : !!incoming.enabled,
            updatedAt: Date.now()
          }
        };
        await writeSettings(env, next);
        return json(next);
      }
      return json({ error: 'method not allowed' }, 405);
    }

    // ---------- AI 出图（Workers AI 绑定，Pages Functions 用内部令牌调用） ----------
    // GET/POST /ai/rank：模型成绩单（成功率 / 平均耗时），持久化到 R2
    if (path === '/ai/rank') {
      if (req.method === 'GET') {
        const obj = await env.MUSIC.get(AI_RANK_KEY);
        if (!obj) return json({ updatedAt: 0, turn: 0, models: {} });
        const text = await obj.text();
        return new Response(text, {
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
        });
      }
      if (req.method === 'POST') {
        let raw = '';
        try { raw = await req.text(); } catch (e) { return json({ error: '格式错误' }, 400); }
        if (raw.length > 64 * 1024) return json({ error: '数据过大' }, 413);
        let body;
        try { body = JSON.parse(raw); } catch (e) { return json({ error: '格式错误' }, 400); }
        if (!body || typeof body !== 'object' || !body.models || typeof body.models !== 'object') {
          return json({ error: '缺少 models' }, 400);
        }
        await env.MUSIC.put(AI_RANK_KEY, JSON.stringify(body), {
          httpMetadata: { contentType: 'application/json' }
        });
        return json({ ok: true, updatedAt: body.updatedAt || Date.now() });
      }
      return json({ error: 'method not allowed' }, 405);
    }

    // POST /ai/run {model, prompt} → {ok, ms, dataUrl}
    if (path === '/ai/run' && req.method === 'POST') {
      if (!env.AI) return json({ error: 'Worker 未绑定 Workers AI（请在 wrangler.toml 加 [ai] 后重新部署）' }, 501);
      let body;
      try { body = await req.json(); } catch (e) { return json({ error: '格式错误' }, 400); }
      const model = String(body && body.model || '');
      const prompt = String(body && body.prompt || '').trim();
      if (!AI_MODEL_RE.test(model)) return json({ error: '不支持的模型标识' }, 400);
      if (!prompt) return json({ error: '提示词不能为空' }, 400);
      if (prompt.length > 4000) return json({ error: '提示词过长' }, 400);

      const input = { prompt: prompt };
      const t0 = Date.now();
      let out;
      try {
        out = await Promise.race([
          env.AI.run(model, input),
          new Promise(function (_, reject) {
            setTimeout(function () { reject(new Error('模型响应超时')); }, AI_TIMEOUT_MS);
          })
        ]);
      } catch (e) {
        return json({ ok: false, model: model, ms: Date.now() - t0, error: String((e && e.message) || e) }, 502);
      }

      try {
        let dataUrl = '';
        if (out && typeof out === 'object' && typeof out.image === 'string') {
          dataUrl = /^data:image\//.test(out.image) ? out.image : 'data:image/png;base64,' + out.image;
        } else {
          const buf = await new Response(out).arrayBuffer();
          if (!buf || buf.byteLength === 0) throw new Error('模型没有返回图片数据');
          const u8 = new Uint8Array(buf);
          const isJpeg = u8[0] === 0xFF && u8[1] === 0xD8;
          dataUrl = 'data:image/' + (isJpeg ? 'jpeg' : 'png') + ';base64,' + bytesToBase64(u8);
        }
        if (!dataUrl) throw new Error('模型没有返回图片数据');
        return json({ ok: true, model: model, ms: Date.now() - t0, bytes: dataUrl.length, dataUrl: dataUrl });
      } catch (e) {
        return json({ ok: false, model: model, ms: Date.now() - t0, error: '结果解析失败：' + String((e && e.message) || e) }, 502);
      }
    }

    if (path === '/list' && req.method === 'GET') {
      const idx = await readIndex(env);
      const lim = limits(env);
      return json({
        tracks: idx.tracks || [],
        usage: {
          count: (idx.tracks || []).length,
          bytes: usedBytes(idx),
          maxUploadMB: lim.maxUploadMB,
          maxStorageMB: lim.maxStorageMB,
          maxUploadBytes: lim.maxUploadBytes,
          maxStorageBytes: lim.maxStorageBytes
        }
      });
    }

    if (path === '/upload' && req.method === 'POST') {
      if (!req.body) return json({ error: '空文件' }, 400);

      const lim = limits(env);
      const declared = Number(req.headers.get('Content-Length')) || 0;
      if (declared > lim.maxUploadBytes) {
        return json({ error: '文件 ' + fmtBytes(declared) + ' 超过单次上传上限 ' + lim.maxUploadMB + ' MB，请先压缩或裁剪' }, 413);
      }

      const name = String(url.searchParams.get('name') || '未命名').slice(0, 80);
      const duration = Number(url.searchParams.get('duration')) || 0;
      const picked = resolveType(url.searchParams.get('type') || req.headers.get('Content-Type'), name);
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const key = `music/${id}.${picked.ext}`;

      const idx = await readIndex(env);
      const used = usedBytes(idx);
      if (declared && used + declared > lim.maxStorageBytes) {
        return json({ error: '云端存储余量不足（已用 ' + fmtBytes(used) + ' / 上限 ' + lim.maxStorageMB + ' MB），请先删除一些媒体' }, 507);
      }

      // 流式写入 R2：不缓存整份文件
      await env.MUSIC.put(key, req.body, {
        httpMetadata: {
          contentType: picked.type,
          cacheControl: 'public, max-age=31536000, immutable'
        }
      });

      const head = await env.MUSIC.head(key);
      const size = head ? head.size : 0;
      if (!size) {
        await env.MUSIC.delete(key);
        return json({ error: '空文件' }, 400);
      }
      // 没有 Content-Length（分块上传）时，落盘后再校验一次上限
      if (size > lim.maxUploadBytes) {
        await env.MUSIC.delete(key);
        return json({ error: '文件 ' + fmtBytes(size) + ' 超过单次上传上限 ' + lim.maxUploadMB + ' MB，请先压缩或裁剪' }, 413);
      }
      if (used + size > lim.maxStorageBytes) {
        await env.MUSIC.delete(key);
        return json({ error: '云端存储已满（已用 ' + fmtBytes(used) + ' / 上限 ' + lim.maxStorageMB + ' MB），请先删除一些媒体' }, 507);
      }

      const track = {
        id, name, key, size, duration,
        type: picked.type,
        enabled: true,
        createdAt: Date.now()
      };
      idx.tracks.push(track);
      await writeIndex(env, idx);
      return json({
        ok: true,
        track,
        usage: {
          count: idx.tracks.length,
          bytes: used + size,
          maxUploadBytes: lim.maxUploadBytes,
          maxStorageBytes: lim.maxStorageBytes
        }
      });
    }

    if (path === '/update' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch (e) { return json({ error: '格式错误' }, 400); }
      const tracks = Array.isArray(body && body.tracks) ? body.tracks : null;
      if (!tracks) return json({ error: '缺少 tracks' }, 400);
      const clean = tracks.slice(0, 50).map(function (t) {
        const picked = resolveType(t.type, t.key);
        return {
          id: String(t.id || ''),
          name: String(t.name || '未命名').slice(0, 80),
          key: String(t.key || ''),
          size: Number(t.size) || 0,
          duration: Number(t.duration) || 0,
          type: picked.type,
          createdAt: Number(t.createdAt) || 0,
          enabled: !!t.enabled
        };
      }).filter(function (t) { return t.id && t.key.indexOf('music/') === 0; });
      await writeIndex(env, { tracks: clean });
      return json({ ok: true, count: clean.length });
    }

    if (path === '/delete' && req.method === 'POST') {
      const key = url.searchParams.get('key') || '';
      if (key.indexOf('music/') !== 0) return json({ error: '非法 key' }, 400);
      await env.MUSIC.delete(key);
      const idx = await readIndex(env);
      idx.tracks = idx.tracks.filter(function (t) { return t.key !== key; });
      await writeIndex(env, idx);
      return json({ ok: true, usage: { count: idx.tracks.length, bytes: usedBytes(idx) } });
    }

    // 媒体读取（音频 / 视频共用）：支持 Range、ETag 与 304，便于拖动进度条与边下边播
    if ((path === '/audio' || path === '/file') && req.method === 'GET') {
      const key = url.searchParams.get('key') || '';
      if (key.indexOf('music/') !== 0) return json({ error: '非法 key' }, 400);

      const parsed = rangeSpec(req.headers.get('Range'));
      const baseHeaders = {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000, immutable'
      };
      if (parsed && parsed.bad) return new Response(null, { status: 416, headers: baseHeaders });

      let obj = null;
      try {
        // 单次 get 出流（Range 由 R2 裁剪），比 head + get 少一次 R2 操作
        obj = parsed ? await env.MUSIC.get(key, { range: parsed.range }) : await env.MUSIC.get(key);
      } catch (e) {
        return new Response(null, { status: 416, headers: baseHeaders });
      }
      if (!obj) return json({ error: '找不到媒体文件' }, 404);

      const size = Number(obj.size) || 0;
      const stored = (obj.httpMetadata && obj.httpMetadata.contentType) ||
        resolveType('', key).type;
      const headers = Object.assign({
        'Content-Type': stored,
        'ETag': '"' + (obj.etag || (String(size) + '-' + key)) + '"'
      }, baseHeaders);

      // 命中协商缓存：不读 body，直接 304
      const inm = req.headers.get('If-None-Match') || '';
      if (inm && (inm.trim() === '*' || inm.split(',').map(function (s) { return s.trim(); }).indexOf(headers['ETag']) >= 0)) {
        try { if (obj.body && obj.body.cancel) await obj.body.cancel(); } catch (e) {}
        return new Response(null, { status: 304, headers: headers });
      }

      if (!parsed) {
        headers['Content-Length'] = String(size);
        return new Response(obj.body, { status: 200, headers: headers });
      }

      const served = obj.range;
      if (!served) {
        // bytes=N- 越过文件末尾：R2 没有返回片段
        if (parsed.range.offset && parsed.range.offset >= size) {
          try { if (obj.body && obj.body.cancel) await obj.body.cancel(); } catch (e) {}
          return new Response(null, { status: 416, headers: headers });
        }
        // 范围覆盖整个文件（如 bytes=0- / suffix 超出长度）
        headers['Content-Length'] = String(size);
        headers['Content-Range'] = 'bytes 0-' + (size - 1) + '/' + size;
        return new Response(obj.body, { status: 206, headers: headers });
      }

      headers['Content-Length'] = String(served.length);
      headers['Content-Range'] = 'bytes ' + served.offset + '-' + (served.offset + served.length - 1) + '/' + size;
      return new Response(obj.body, { status: 206, headers: headers });
    }

    return json({ error: 'not found' }, 404);
  }
};
