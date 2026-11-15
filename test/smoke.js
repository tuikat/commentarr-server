// End-to-end smoke test against a running server: node test/smoke.js [baseUrl]
'use strict';
const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8790';
const ADMIN = process.env.ADMIN_TOKEN || '';
let n = 0;
const ok = (c, m) => { n++; if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok', m); };
async function call(method, p, body, auth) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}
(async () => {
  ok((await call('GET', '/healthz')).j.ok, 'health');
  const reg = async (name) => (await call('POST', '/api/v1/servers', { name })).j;
  const a = (await call('POST', '/api/v1/servers', { name: 'Smoke A' })).j;
  const b = (await call('POST', '/api/v1/servers', { name: 'Smoke B' })).j;
  ok(a.serverId && a.serverKey, 'register');
  const tok = async (s, uid, name, admin) => (await call('POST', '/api/v1/token', { userId: uid, name, admin }, `Server ${s.serverId}:${s.serverKey}`)).j.token;
  const ta = await tok(a, 'u1', 'Alice', true), ta2 = await tok(a, 'u2', 'Andy'), tb = await tok(b, 'u9', 'Bob'), tb2 = await tok(b, 'u8', 'Bea'), tc = await tok(b, 'u7', 'Cy');
  ok(ta && tb, 'tokens');
  ok((await call('POST', '/api/v1/token', { userId: 'x' }, `Server ${a.serverId}:wrongwrongwrongwrongwrong`)).status === 401, 'bad server key rejected');
  // Server A knows the episode by TVDB, server B by TMDB: one thread once both ids are seen together.
  const idsA = ['tv/tvdb/81189/s1e3'], idsB = ['tv/tmdb/1396/s1e3'], both = ['tv/tvdb/81189/s1e3', 'tv/tmdb/1396/s1e3'];
  const c1 = await call('POST', '/api/v1/comments', { ids: both, title: 'Breaking Bad S01E03', body: 'That scene at 18:32 though', posMs: 1112000, runtimeMs: 2900000 }, 'Bearer ' + ta);
  ok(c1.status === 200 && c1.j.posMs === 1112000, 'post pinned comment');
  const c2 = await call('POST', '/api/v1/comments', { ids: idsB, body: 'Whole episode was great' }, 'Bearer ' + tb);
  ok(c2.status === 200, 'post general comment');
  const r1 = await call('POST', '/api/v1/comments', { ids: idsA, body: 'agreed', parentId: c1.j.id }, 'Bearer ' + tb);
  ok(r1.j.parentId === c1.j.id, 'reply');
  const listA = (await call('GET', '/api/v1/comments?ids=' + idsA.join(','), null, 'Bearer ' + ta)).j;
  ok(listA.comments.length === 3, 'one thread across tvdb/tmdb ids (' + listA.comments.length + ')');
  ok((await call('POST', `/api/v1/comments/${c2.j.id}/like`, null, 'Bearer ' + ta)).j.likes === 1, 'like');
  await call('POST', '/api/v1/comments', { ids: ['tv/tvdb/81189/s1e4'], body: 'Episode four is the best one' }, 'Bearer ' + tb2);
  const rel = (await call('GET', '/api/v1/related?ids=tv/tvdb/81189/s1e3', null, 'Bearer ' + ta)).j.comments;
  ok(rel.length === 1 && rel[0].fromEpisode === 'S01E04', 'related comments from other episodes');
  ok((await call('POST', '/api/v1/comments', { ids: idsA, body: 'agreed', parentId: c1.j.id }, 'Bearer ' + tb)).status === 409, 'duplicate blocked');
  // banned words: server A bans "spoon"; A's users can't post it, and A's viewers don't see B's post with it
  await call('PUT', '/api/v1/server/words', { words: ['spoon'] }, 'Bearer ' + ta);
  ok((await call('POST', '/api/v1/comments', { ids: idsA, body: 'there is no spoon' }, 'Bearer ' + ta2)).status === 422, 'server banned word blocks own users');
  const sp = await call('POST', '/api/v1/comments', { ids: idsB, body: 'spoon spoon' }, 'Bearer ' + tb);
  ok(sp.status === 200, 'other server can post it');
  ok(!(await call('GET', '/api/v1/comments?ids=' + idsA, null, 'Bearer ' + ta)).j.comments.some((c) => c.id === sp.j.id), 'hidden from server A viewers');
  ok((await call('PUT', '/api/v1/server/words', { words: ['x1'] }, 'Bearer ' + tb)).status === 403, 'non-admin cannot set words');
  // reports: 1 from A auto-hides? needs 3 distinct servers -> stays
  await call('POST', `/api/v1/comments/${c2.j.id}/report`, { reason: 'test' }, 'Bearer ' + ta);
  const rep = (await call('GET', '/api/v1/server/reports', null, 'Bearer ' + ta)).j;
  ok(rep.some((r) => r.id === c2.j.id), 'server admin sees report');
  ok((await call('POST', `/api/v1/server/comments/${c2.j.id}/delete`, null, 'Bearer ' + ta)).status === 403, 'cannot delete other server\'s comment');
  await call('POST', `/api/v1/server/comments/${c2.j.id}/hide`, null, 'Bearer ' + ta);
  ok(!(await call('GET', '/api/v1/comments?ids=' + idsA, null, 'Bearer ' + ta)).j.comments.some((c) => c.id === c2.j.id), 'hide for own server');
  ok((await call('GET', '/api/v1/comments?ids=' + idsB, null, 'Bearer ' + tb)).j.comments.some((c) => c.id === c2.j.id), 'still visible elsewhere');
  ok((await call('PUT', '/api/v1/me', { name: 'Alice W' }, 'Bearer ' + ta)).j.name === 'Alice W', 'rename');
  ok((await call('DELETE', `/api/v1/comments/${c2.j.id}`, null, 'Bearer ' + ta2)).status === 403, 'cannot delete others');
  ok((await call('DELETE', `/api/v1/comments/${r1.j.id}`, null, 'Bearer ' + tb)).j.deleted, 'delete own');
  ok((await call('POST', '/api/v1/comments', { ids: idsA, body: 'agreed', parentId: c1.j.id }, 'Bearer ' + tb)).status === 200, 'repost after deleting is allowed');
  // SSE: open a stream as B, post as A, receive it
  const ctrl = new AbortController();
  const got = new Promise(async (resolve) => {
    const res = await fetch(BASE + '/api/v1/stream?ids=' + idsB + '&token=' + encodeURIComponent(tb), { signal: ctrl.signal });
    const rd = res.body.getReader(); let buf = '';
    for (;;) { const { value, done } = await rd.read(); if (done) break; buf += Buffer.from(value).toString(); if (buf.includes('event: comment')) { resolve(buf); break; } }
  });
  await new Promise((r) => setTimeout(r, 300));
  await call('POST', '/api/v1/comments', { ids: idsA, body: 'live one' }, 'Bearer ' + ta);
  const ev = await Promise.race([got, new Promise((r) => setTimeout(() => r(''), 3000))]);
  ctrl.abort();
  ok(ev.includes('live one'), 'live stream delivers new comment');
  // three brand-new servers reporting a comment must not be able to hide it
  for (const [n, s] of [['x1', await reg('X1')], ['x2', await reg('X2')], ['x3', await reg('X3')]]) await call('POST', `/api/v1/comments/\${c1.j.id}/report`, { reason: 'brigade' }, 'Bearer ' + await tok(s, n, n));
  ok((await call('GET', '/api/v1/comments?ids=' + idsA, null, 'Bearer ' + ta)).j.comments.some((c) => c.id === c1.j.id), 'fresh servers cannot auto-hide');
  // watching a title nobody has commented on creates nothing
  const before = (await call('GET', '/api/v1/info')).j.stats.titles;
  const sc = new AbortController(); fetch(BASE + '/api/v1/stream?ids=movie/tmdb/999999&token=' + encodeURIComponent(ta), { signal: sc.signal }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300)); sc.abort();
  ok((await call('GET', '/api/v1/comments?ids=movie/tmdb/999999', null, 'Bearer ' + ta)).j.thread === null, 'stream creates no thread');
  if (ADMIN) {
    ok((await call('GET', '/api/v1/admin/overview', null, 'Admin ' + ADMIN)).status === 200, 'global admin');
    ok((await call('GET', '/api/v1/admin/overview', null, 'Admin nope')).status === 401, 'bad admin token rejected');
    for (let i = 0; i < 10; i++) await call('GET', '/api/v1/admin/overview', null, 'Admin nope');
    ok((await call('GET', '/api/v1/admin/overview', null, 'Admin ' + ADMIN)).status === 429, 'locked out after repeated wrong tokens, even with the right one');
  }
  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
