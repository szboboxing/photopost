// AI 模型排行榜：GET 公开只读（首页/后台都看），POST 需后台会话（目前只支持重置成绩）
import { AI_POOL, readRank, emptyRank, writeRank, scoreOf, successRateOf } from './_ai.js';
import { json, isAdmin } from './_shared.js';

function statusOf(st, score, isPrimary) {
  if (score == null) return '待测';
  const total = (Number(st.ok) || 0) + (Number(st.fail) || 0);
  const sr = total ? (Number(st.ok) || 0) / total : 0;
  if (sr < 0.5) return '异常';
  if (isPrimary) return '在岗';
  return '可用';
}

function buildView(rank) {
  const rows = AI_POOL.map(function (m) {
    const st = rank.models[m.id] || null;
    return {
      id: m.id,
      label: m.label,
      platform: m.platform,
      caps: m.caps,
      catalogRank: m.catalogRank,
      ok: st ? st.ok : 0,
      fail: st ? st.fail : 0,
      total: st ? (st.ok + st.fail) : 0,
      avgMs: st ? st.avgMs : 0,
      lastMs: st ? st.lastMs : 0,
      lastError: st ? st.lastError : '',
      successRate: successRateOf(st),
      score: scoreOf(st)
    };
  });

  rows.sort(function (a, b) {
    if (a.score == null && b.score == null) return a.catalogRank - b.catalogRank;
    if (a.score == null) return 1;
    if (b.score == null) return -1;
    return b.score - a.score;
  });

  rows.forEach(function (r, i) {
    r.rank = i + 1;
  });

  const primary = { img: null, txt: null };
  ['img', 'txt'].forEach(function (cap) {
    const group = rows.filter(function (r) { return r.caps.indexOf(cap) >= 0; });
    const measured = group.filter(function (r) {
      if (r.score == null) return false;
      const total = r.ok + r.fail;
      return total > 0 && (r.ok / total) >= 0.5;
    });
    const fallback = group.slice().sort(function (a, b) { return a.catalogRank - b.catalogRank; })[0];
    const hit = measured[0] || fallback;
    primary[cap] = hit ? hit.id : null;
  });

  rows.forEach(function (r) {
    const isPrimary = (r.id === primary.img) || (r.id === primary.txt);
    r.status = statusOf(rank.models[r.id] || {}, r.score, isPrimary);
  });

  return {
    updatedAt: rank.updatedAt || 0,
    turn: rank.turn || 0,
    primary: primary,
    models: rows
  };
}

export async function onRequestGet({ env }) {
  const rank = await readRank(env);
  return json(buildView(rank));
}

export async function onRequestPost({ request, env }) {
  if (!(await isAdmin(request, env))) return json({ error: { message: '需要先登录后台' } }, 401);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: { message: '请求格式错误' } }, 400); }

  if (body && body.action === 'reset') {
    // 带 models 数组时只清指定模型的成绩，否则整体重置
    if (Array.isArray(body.models) && body.models.length) {
      const cur = await readRank(env);
      body.models.forEach(function (id) { delete cur.models[id]; });
      await writeRank(env, cur);
      return json(buildView(cur));
    }
    const blank = emptyRank();
    await writeRank(env, blank);
    return json(buildView(blank));
  }
  return json({ error: { message: '未知操作' } }, 400);
}
