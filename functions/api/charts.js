// 首页「热播榜单」：抓取公开榜单并缓存
// 榜单数据（全部公开、无需密钥，服务端抓取 + 缓存）：
//   原创 / AI 热播  → Audius 周榜（可完整播放）
//   华语 / 飙升热播 → 网易云音乐「热歌榜 / 飙升榜」（批量取播放地址，过滤掉无版权的）
// 开关存于 R2 的 settings.json（后台「云端媒体中心」里可切换）
import { json, callMedia } from './_shared.js';

const CACHE_URL = '/api/charts-cache-v8';
const SERVER_TTL = 1200;        // 服务端缓存 20 分钟，减少上游请求
const CLIENT_TTL = 300;         // 浏览器缓存 5 分钟
const BOARD_LIMIT = 20;
const APP_NAME = 'photopost';

function cleanName(s) {
  return String(s || '').replace(/^@/, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function audiusItem(t) {
  const art = t.artwork || {};
  const cover = art['480x480'] || art['150x150'] || art['1000x1000'] || '';
  if (!t.id || !t.title || t.is_streamable === false) return null;
  return {
    id: 'au-' + t.id,
    title: String(t.title).slice(0, 80),
    artist: cleanName(t.user && t.user.name),
    cover: cover,
    duration: Number(t.duration) || 0,
    genre: cleanName(t.genre),
    tags: ['原创 / AI'],
    source: 'audius',
    full: true,
    url: 'https://api.audius.co/v1/tracks/' + encodeURIComponent(t.id) + '/stream?app_name=' + APP_NAME
  };
}

async function fetchAudius() {
  const res = await fetch('https://api.audius.co/v1/tracks/trending?time=week&limit=' + BOARD_LIMIT + '&app_name=' + APP_NAME, {
    headers: { Accept: 'application/json' }
  });
  if (!res.ok) throw new Error('Audius ' + res.status);
  const data = await res.json();
  return (data.data || []).map(audiusItem).filter(Boolean).slice(0, BOARD_LIMIT);
}

// 国内免费平台：网易云音乐的公开榜单接口（不需要登录 / 密钥）
// 注意：网易云按「请求方 IP 的版权区」判定，从海外出口只能拿到华语曲目的播放地址，
// 欧美/日韩榜实测全部为空，所以这里的两个榜都选华语曲目为主的榜单。
const NE_BOARDS = {
  cn: [{ id: 3778678, list: '热歌榜', scan: 80 }],
  rising: [{ id: 19723756, list: '飙升榜', scan: 100 }]
};
const NE_HEADERS = {
  Referer: 'https://music.163.com/',
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
};

// 网易云给的播放地址是 http，页面是 https，必须换成 https（CDN 本身支持，且带 ACAO/Range）
function httpsUrl(u) {
  return String(u || '').replace(/^http:\/\//i, 'https://');
}

// 批量取播放地址：一次最多 50 首；没有地址的多是 VIP / 地区版权限制，直接跳过
async function nePlayUrls(ids) {
  const map = {};
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const res = await fetch('https://music.163.com/api/song/enhance/player/url?ids=[' + chunk.join(',') + ']&br=128000', {
        headers: NE_HEADERS
      });
      if (!res.ok) continue;
      const data = await res.json();
      (data.data || []).forEach((d) => {
        if (d && d.url) map[String(d.id)] = httpsUrl(d.url);
      });
    } catch (e) { /* 单个分片失败不影响其他 */ }
  }
  return map;
}

async function neBoardItems(board, key) {
  const res = await fetch('https://music.163.com/api/playlist/detail?id=' + board.id, { headers: NE_HEADERS });
  if (!res.ok) throw new Error('网易云榜单 ' + res.status);
  const data = await res.json();
  if (Number(data.code) !== 200) throw new Error('网易云 code ' + data.code);
  const tracks = ((data.result || {}).tracks || []).slice(0, board.scan);
  if (!tracks.length) throw new Error('网易云榜单为空');

  // 榜单里常有 VIP / 无版权歌，先批量拿地址，只保留能播的
  const urls = await nePlayUrls(tracks.map((t) => t.id));
  const items = [];
  for (const t of tracks) {
    const url = urls[String(t.id)];
    if (!url) continue;
    const album = t.album || {};
    items.push({
      id: 'ne-' + t.id,
      title: String(t.name || '').trim().slice(0, 80),
      artist: cleanName((t.artists || []).map((a) => a.name).filter(Boolean).join(' / ')) || '未知歌手',
      cover: httpsUrl(album.picUrl || album.blurPicUrl || ''),
      duration: Math.round((Number(t.duration) || 0) / 1000),
      genre: board.list,
      tags: [key === 'cn' ? '华语' : '飙升'],
      source: 'netease',
      full: true,
      url: url
    });
    if (items.length >= BOARD_LIMIT) break;
  }
  return { items: items, list: board.list, candidates: tracks.length, usable: Object.keys(urls).length };
}

async function fetchNetEase(key) {
  const boards = NE_BOARDS[key] || [];
  const tried = [];
  for (const board of boards) {
    try {
      const r = await neBoardItems(board, key);
      if (r.items.length >= 5) return r;
      tried.push(board.list + ' ' + r.usable + '/' + r.candidates);
    } catch (e) {
      tried.push(board.list + ' ' + ((e && e.message) || e));
    }
  }
  throw new Error('网易云无可用曲目（' + tried.join('，') + '）');
}

async function safe(p) {
  try { return { v: await p, e: '' }; }
  catch (err) { return { v: null, e: String((err && err.message) || err).slice(0, 160) }; }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function gather() {
  const originalP = safe(fetchAudius());
  // 两个榜单串行抓（同一出口并发容易被判 5xx）
  const cnR = await safe(fetchNetEase('cn'));
  await delay(300);
  const risingR = await safe(fetchNetEase('rising'));
  const originalR = await originalP;
  const cnV = cnR.v || {};
  const risingV = risingR.v || {};
  return {
    original: {
      key: 'original', title: '原创 & AI 热播', sub: 'Audius 周榜 · 可完整播放',
      ok: !!(originalR.v && originalR.v.length), err: originalR.e, items: originalR.v || []
    },
    cn: {
      key: 'cn', title: '华语热播', sub: '网易云音乐 · ' + (cnV.list || '热歌榜') + ' · 可完整播放',
      ok: !!((cnV.items || []).length), err: cnR.e, items: cnV.items || []
    },
    rising: {
      key: 'rising', title: '飙升热播', sub: '网易云音乐 · ' + (risingV.list || '飙升榜') + ' · 可完整播放',
      ok: !!((risingV.items || []).length), err: risingR.e, items: risingV.items || []
    }
  };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  // 后台开关：关闭时直接返回，不抓取上游
  let enabled = true;
  try {
    const res = await callMedia(env, '/settings');
    if (res.ok) {
      const s = await res.json();
      enabled = !!(s.charts || {}).enabled;
    }
  } catch (e) { /* 读不到设置时按开启处理 */ }

  if (!enabled) return json({ enabled: false, boards: {} }, 200, { 'Cache-Control': 'public, max-age=60' });

  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const cacheKey = new Request(url.origin + CACHE_URL, { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) {
        return new Response(await hit.text(), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=' + CLIENT_TTL,
            'X-Charts': 'hit'
          }
        });
      }
    } catch (e) {}
  }

  try {
    const boards = await gather();
    // 某个榜单抓取失败时缩短缓存，等上游恢复后能很快补上
    const allOk = Object.keys(boards).every((k) => boards[k].ok);
    const serverTtl = allOk ? SERVER_TTL : 120;
    const clientTtl = allOk ? CLIENT_TTL : 60;
    const payload = JSON.stringify({ enabled: true, updatedAt: Date.now(), boards });
    if (cache) {
      try {
        await cache.put(cacheKey, new Response(payload, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + serverTtl }
        }));
      } catch (e) {}
    }
    return new Response(payload, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=' + clientTtl,
        'X-Charts': 'fresh'
      }
    });
  } catch (e) {
    return json({ enabled: true, boards: {}, error: '榜单抓取失败：' + e.message }, 502);
  }
}
