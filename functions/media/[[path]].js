// 云端媒体转发：/media/music/xxx.mp3|mp4 → 内部 Worker → R2（透传 Range，支持拖动进度条 / 视频边下边播）
// 缓存策略：一年 immutable（文件 key 含随机 id，内容不会变），并透传 ETag / If-None-Match → 304
export async function onRequestGet({ request, env, params }) {
  if (!env.MEDIA_URL || !env.MEDIA_TOKEN) return new Response('云端媒体服务未配置', { status: 501 });
  const key = (params.path || []).join('/');
  if (key.indexOf('music/') !== 0) return new Response('Not Found', { status: 404 });

  const headers = { 'X-Media-Token': env.MEDIA_TOKEN };
  const range = request.headers.get('Range');
  if (range) headers['Range'] = range;
  const inm = request.headers.get('If-None-Match');
  if (inm) headers['If-None-Match'] = inm;

  const upstream = await fetch(env.MEDIA_URL + '/audio?key=' + encodeURIComponent(key), { headers });

  const out = new Headers();
  ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']
    .forEach(function (h) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    });
  out.set('Cache-Control', 'public, max-age=31536000, immutable');

  if (upstream.status === 304) return new Response(null, { status: 304, headers: out });
  if (!upstream.ok) return new Response('Not Found', { status: upstream.status });
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
