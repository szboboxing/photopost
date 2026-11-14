// 站点设置：GET 公开（只读必要字段）；POST 需后台会话
import { json, isAdmin, callMedia } from './_shared.js';

async function readSettings(env) {
  const res = await callMedia(env, '/settings');
  if (!res.ok) throw new Error('设置服务不可用');
  return await res.json();
}

export async function onRequestGet({ env }) {
  try {
    const s = await readSettings(env);
    return json({ charts: { enabled: !!(s.charts || {}).enabled } });
  } catch (e) {
    // 读取失败时按默认开启，避免首页整块消失
    return json({ charts: { enabled: true } });
  }
}

export async function onRequestPost({ request, env }) {
  if (!(await isAdmin(request, env))) return json({ error: { message: '需要先登录后台' } }, 401);
  try {
    const body = await request.json().catch(() => ({}));
    const charts = body.charts || {};
    const enabled = !!charts.enabled;
    const res = await callMedia(env, '/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ charts: { enabled: enabled } })
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return json({ error: { message: out.error || '保存失败' } }, res.status);
    return json({ charts: { enabled: !!(out.charts || {}).enabled } });
  } catch (e) {
    return json({ error: { message: e.message } }, 500);
  }
}
