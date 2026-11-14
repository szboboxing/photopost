// Pages Functions 共用小工具：JSON 响应、后台会话校验、转发到媒体 Worker
const COOKIE_NAME = 'pp_admin';
const enc = new TextEncoder();

export function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }, extraHeaders || {})
  });
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function readCookie(req, name) {
  const raw = req.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

export async function isAdmin(req, env) {
  const tok = readCookie(req, COOKIE_NAME);
  if (!tok || !env.SESSION_SECRET) return false;
  const dot = tok.lastIndexOf('.');
  if (dot <= 0) return false;
  const exp = tok.slice(0, dot);
  if (!Number(exp) || Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(exp));
  return safeEqual(tok.slice(dot + 1), b64url(new Uint8Array(sig)));
}

export async function callMedia(env, pathAndQuery, init) {
  if (!env.MEDIA_URL || !env.MEDIA_TOKEN) throw new Error('未配置云端媒体（MEDIA_URL / MEDIA_TOKEN）');
  const opts = Object.assign({}, init || {});
  opts.headers = Object.assign({ 'X-Media-Token': env.MEDIA_TOKEN }, (init && init.headers) || {});
  return await fetch(env.MEDIA_URL + pathAndQuery, opts);
}
