'use strict';
// Real-browser interception suite.
//
//   npm i --no-save playwright-core          # once
//   CHROME_PATH=/path/to/chrome-for-testing node --test tests/browser/
//
// Chrome for Testing (or Chromium) is required: branded Chrome ignores
// --load-extension. Set BHP2_DIR to a bandwidth-hero-proxy2 checkout to make
// the mock proxy parse `url` with the proxy's real getImageUrl().
//
// Every assertion is about the network: which URLs reached which host, how
// many times, and whether the element finally rendered.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('./server.cjs');

let chromium;
try { ({ chromium } = require('playwright-core')); } catch {}
const CHROME = process.env.CHROME_PATH || '';
const SKIP = !chromium || !CHROME || !fs.existsSync(CHROME)
  ? 'needs playwright-core and CHROME_PATH (Chrome for Testing / Chromium)' : false;

const EXT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.BH_TEST_PORT || 8089);
const C = `http://cdn.test:${PORT}`;
const PAGE = `http://page.test:${PORT}/pages`;
const PROXY_BASE = `http://proxy.test:${PORT}/api/index`;

let srv, ctx, sw;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 50) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(step); }
  return last;
}

// ── Log helpers ───────────────────────────────────────────────────────────────
const isProxy = e => e.host === 'proxy.test';
const log = () => srv.browserLog();
function direct(prefix) { return log().filter(e => !isProxy(e) && e.path.startsWith(prefix)); }
function proxied(prefix) { return log().filter(e => isProxy(e) && (e.original || '').includes(prefix)); }
function directUrl(url) { return log().filter(e => !isProxy(e) && e.url === url); }
function proxiedUrl(url) { return log().filter(e => isProxy(e) && e.original === url); }
function assertNoDuplicates(prefix) {
  const counts = new Map();
  for (const e of proxied(prefix)) counts.set(e.original, (counts.get(e.original) || 0) + 1);
  const dups = [...counts].filter(([, n]) => n > 1);
  assert.deepEqual(dups, [], `duplicate proxy requests under ${prefix}`);
}
function assertNoProxyLoops() {
  // The proxy must never be asked to fetch the proxy.
  const nested = log().filter(e => isProxy(e) && /^https?:\/\/proxy\.test/i.test(e.original || ''));
  assert.deepEqual(nested.map(e => e.url), [], 'proxy-of-proxy request');
}
async function imgState(page, sel) {
  return page.$$eval(sel, els => els.map(i => ({ id: i.id, complete: i.complete, w: i.naturalWidth, cur: i.currentSrc, src: i.getAttribute('src'), srcset: i.getAttribute('srcset') })));
}

// Statistics are flushed in batches (≈0.75 s); wait until the counter has been
// stable for a while so a test never sees another test's late flush.
async function settledStats() {
  const read = () => sw.evaluate(async () => ((await chrome.storage.local.get('stats')).stats || { filesProcessed: 0 }).filesProcessed);
  let last = await read(), stableSince = Date.now();
  while (Date.now() - stableSince < 2000) {
    await sleep(250);
    const cur = await read();
    if (cur !== last) { last = cur; stableSince = Date.now(); }
  }
  return last;
}

async function setSettings(s) {
  // onInstalled writes missing defaults asynchronously; settings written in
  // the first milliseconds after install could be overwritten by it.
  await until(() => sw.evaluate(async () => 'maxWidth' in await chrome.storage.sync.get(null)), 8000);
  await sw.evaluate(async s => { await chrome.storage.sync.set(s); }, s);
  // Wait until the service worker has rebuilt the DNR rules and published bhRuntime.
  await until(async () => sw.evaluate(async s => {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const red = rules.find(r => r.id === 10);
    const { bhOpts, bhRuntime } = await chrome.storage.local.get(['bhOpts', 'bhRuntime']);
    const wantRedirect = !!(s.enabled !== false && s.proxyBase);
    const mirror = bhOpts && bhOpts.proxyBase === s.proxyBase && bhOpts.excludeDomains === (s.excludeDomains || '') && bhOpts.enabled === (s.enabled !== false);
    return mirror && !!bhRuntime && (!!red === wantRedirect) && bhRuntime.redirect === wantRedirect;
  }, s), 8000);
  const applied = await sw.evaluate(async s => {
    const cur = await chrome.storage.sync.get(Object.keys(s));
    return Object.keys(s).every(k => cur[k] === s[k]);
  }, s);
  assert.ok(applied, 'settings applied');
}

const BASE_SETTINGS = { enabled: true, saveData: true, proxyBase: PROXY_BASE, quality: 60, grayscale: false, maxWidth: 768, excludeDomains: 'excluded.test' };

async function open(name, { width = 1280, height = 800 } = {}) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width, height });
  await page.goto(`${PAGE}/${name}`, { waitUntil: 'load' });
  return page;
}

test.describe('Bandwidth Guardian in Chrome', { skip: SKIP }, () => {
  test.before(async () => {
    srv = createServer({ pagesDir: path.join(__dirname, 'pages') });
    await new Promise(r => srv.server.listen(PORT, '127.0.0.1', r));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-profile-'));
    ctx = await chromium.launchPersistentContext(profile, {
      executablePath: CHROME,
      headless: true,
      args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
        '--host-resolver-rules=MAP *.test 127.0.0.1, MAP intranet 127.0.0.1, MAP *.local 127.0.0.1', '--no-first-run', '--no-default-browser-check']
    });
    sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
    await setSettings(BASE_SETTINGS);
    process.stderr.write(`# mock proxy url parser: ${srv.getImageUrlSource}\n`);
  });
  test.after(async () => {
    try { assertNoProxyLoops(); } finally {
      await ctx?.close();
      await new Promise(r => srv?.server.close(r));
    }
  });

  test('network rules: redirect, loop guard and exemptions are installed and valid', async () => {
    const rules = await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
    const byId = new Map(rules.map(r => [r.id, r]));
    const red = byId.get(10);
    assert.ok(red, 'image redirect rule');
    assert.equal(red.action.redirect.regexSubstitution, `${PROXY_BASE}?jpeg=0&bw=0&quality=60&max_width=768&url=\\0`);
    assert.deepEqual(red.condition.resourceTypes, ['image']);
    assert.ok(byId.get(20) && byId.get(20).condition.urlFilter === `|http://proxy.test:${PORT}/`, 'proxy allow rule');
    assert.ok(byId.get(21) && byId.get(22), 'skip and conflict exemptions');
    const bad = [];
    for (const r of rules) {
      if (!r.condition.regexFilter) continue;
      const res = await sw.evaluate(rx => chrome.declarativeNetRequest.isRegexSupported({ regex: rx }), r.condition.regexFilter);
      if (!res.isSupported) bad.push([r.id, res.reason]);
    }
    assert.deepEqual(bad, []);
  });

  test('<img src> parser, JS-assigned, setAttribute, innerHTML, URL changes and a 2,500-image mutation burst', async () => {
    const page = await open('img.html');
    await page.waitForFunction(() => window.__burstInserted && Array.from(document.images).every(i => i.complete), null, { timeout: 30000 });
    await sleep(300);
    const imgs = await imgState(page, 'img');
    assert.equal(imgs.length, 2505);
    const broken = imgs.filter(i => i.w === 0);
    assert.deepEqual(broken.map(i => i.cur), [], 'every image rendered');
    assert.deepEqual(direct('/img/img/').map(e => e.url), [], 'no request reached an original host');
    for (const u of ['parser1.png', 'js-src.png', 'js-setattr.png', 'innerhtml.png', 'js-src-changed.png', 'burst/0.png', 'burst/2499.png'])
      assert.equal(proxiedUrl(`${C}/img/img/${u}`).length, 1, u);
    // Relative URL with its own query string, %-escapes and "+" arrives byte-exact.
    assert.equal(proxiedUrl(`http://page.test:${PORT}/img/img/parser-relative.png?x=1&y=2&z=%20a+b`).length, 1);
    assert.equal(proxied('/img/img/burst/').length, 2500);
    // The page still sees its own URLs (no DOM rewrite → no duplicate path).
    assert.equal(imgs.find(i => i.id === 'p1').src, `${C}/img/img/parser1.png`);
    assertNoDuplicates('/img/img/');
    await page.close();
  });

  test('srcset, sizes and <picture>/<source>: every selected candidate, across viewport changes', async () => {
    // Start narrow, then grow: Chrome never downgrades to a smaller srcset
    // candidate once a larger one is loaded, but it does upgrade.
    const page = await open('responsive.html', { width: 500, height: 800 });
    await page.waitForFunction(() => Array.from(document.images).every(i => i.complete && i.naturalWidth > 0), null, { timeout: 10000 });
    let s = await imgState(page, 'img');
    assert.match(s.find(i => i.id === 'r1').cur, /\/img\/resp\/a,w_100\.png\?w=100$/);
    assert.match(s.find(i => i.id === 'pic').cur, /pic-small\.png/);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForFunction(() => /b\.png\?w=300/.test(document.getElementById('r1').currentSrc) && /pic-large/.test(document.getElementById('pic').currentSrc), null, { timeout: 10000 });
    await page.waitForFunction(() => Array.from(document.images).every(i => i.complete && i.naturalWidth > 0));
    s = await imgState(page, 'img');
    // Commas inside a candidate URL survive (Cloudinary-style a,w_100).
    assert.equal(proxiedUrl(`${C}/img/resp/a,w_100.png?w=100`).length, 1);
    assert.equal(proxiedUrl(`${C}/img/resp/b.png?w=300`).length, 1);
    assert.equal(proxiedUrl(`${C}/img/resp/pic-large.png?w=200`).length, 1);
    assert.equal(proxiedUrl(`${C}/img/resp/pic-small.png?w=50`).length, 1);
    // Untouched attributes: descriptors and sizes preserved byte-for-byte.
    assert.equal(s.find(i => i.id === 'r1').srcset, `${C}/img/resp/a,w_100.png?w=100 100w, ${C}/img/resp/b.png?w=300 300w, ${C}/img/resp/c.png?w=600 600w`);
    // Conflict candidates (&quality=) are rewritten in the DOM, descriptors kept.
    const q = s.find(i => i.id === 'q1').srcset.split(', ').map(c => c.split(' '));
    assert.deepEqual(q.map(c => c[1]), ['1x', '2x']);
    for (const [u] of q) assert.ok(u.startsWith(PROXY_BASE + '?url='), u);
    assert.equal(proxiedUrl(`${C}/img/resp/q1.png?w=100&quality=80`).length, 1, 'full original incl. &quality= reached the proxy');
    assert.deepEqual(direct('/img/resp/').filter(e => !e.path.startsWith('/img/resp/q')).map(e => e.url), []);
    assertNoDuplicates('/img/resp/');
    await page.close();
  });

  test('<link rel=preload as=image>, imagesrcset and attribute changes; preload + <img> share one proxied request', async () => {
    const page = await open('preload.html');
    await page.waitForFunction(() => document.getElementById('hero').complete);
    await until(() => proxied('/img/preload/dyn2.png').length && proxied('/img/preload/late-as.png').length, 4000);
    assert.equal(proxiedUrl(`${C}/img/preload/hero.png`).length, 1, 'preloaded hero proxied exactly once');
    assert.equal(proxiedUrl(`${C}/img/preload/r300.png?w=300`).length, 1);
    assert.equal(proxied('/img/preload/dyn1.png').length, 1);
    assert.equal(proxied('/img/preload/dyn2.png').length, 1, 'href change');
    assert.equal(proxied('/img/preload/late-as.png').length, 1, 'as=image set after insertion');
    assert.deepEqual(direct('/img/preload/').map(e => e.url), []);
    assertNoDuplicates('/img/preload/');
    await page.close();
  });

  test('lazy loading: nothing is requested early; the resolved URL is proxied when the loader activates', async () => {
    const page = await open('lazy.html');
    await sleep(500);
    assert.deepEqual([...direct('/img/lazy/'), ...proxied('/img/lazy/')].map(e => e.url), [], 'no early fetch');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await until(() => proxied('/img/lazy/').length >= 4, 6000);
    await sleep(200);
    for (const u of ['one.png', 't-300.png', 'native.png', 'bg.png']) assert.equal(proxiedUrl(`${C}/img/lazy/${u}`).length, 1, u);
    assert.equal(log().filter(e => /%7Bwidth%7D|\{width\}/i.test(e.url + (e.original || ''))).length, 0, 'template never requested');
    assert.deepEqual(direct('/img/lazy/').map(e => e.url), []);
    const st = await imgState(page, 'img');
    assert.ok(st.every(i => i.w > 0));
    await page.close();
  });

  test('CSS: inline, same-origin and cross-origin stylesheets, @import, @media, image-set, multiple backgrounds, pseudo-elements', async () => {
    const page = await open('css.html');
    const expected = ['css/sheet-a.png', 'css/media.png', 'css/set1x.png', 'css/border.png', 'css/list.png', 'css/inline1.png',
      'css/samelink.png', 'xcss/bg.png', 'xcss/rel.png', 'xcss/import.png', 'pseudo/before.png', 'pseudo/after.png', 'css/js-style.png', 'css/cssom.png'];
    await until(() => expected.every(u => proxied('/img/' + u).length), 8000);
    for (const u of expected) assert.equal(proxied('/img/' + u).length, 1, u);
    // Relative URLs resolve against their stylesheet / document.
    assert.equal(proxiedUrl(`http://page.test:${PORT}/img/css/sheet-b.png`).length, 1);
    assert.equal(proxiedUrl(`http://page.test:${PORT}/img/css/inline2.png`).length, 1);
    assert.equal(proxiedUrl(`http://page.test:${PORT}/img/css/samelink-rel.png`).length, 1);
    assert.equal(proxiedUrl(`${C}/img/xcss/rel.png`).length, 1, 'relative url() inside a cross-origin sheet');
    assert.equal(proxied('/img/css/set2x.png').length, 0, 'image-set picks one candidate');
    assert.deepEqual([...direct('/img/css/'), ...direct('/img/xcss/'), ...direct('/img/pseudo/')].map(e => e.url), []);
    assertNoDuplicates('/img/');
    await page.close();
  });

  test('open, closed and declarative shadow roots', async () => {
    const page = await open('shadow.html');
    const expected = ['open.png', 'open-bg.png', 'closed.png', 'closed-bg.png', 'closed-late.png', 'dsd.png'];
    await until(() => expected.every(u => proxied('/img/shadow/' + u).length), 6000);
    for (const u of expected) assert.equal(proxied('/img/shadow/' + u).length, 1, u);
    assert.deepEqual(direct('/img/shadow/').map(e => e.url), []);
    const closed = await page.evaluate(() => window.__closedImgs());
    assert.ok(closed.every(([, c, w]) => c && w > 0), JSON.stringify(closed));
    await page.close();
  });

  test('SVG <image href>/<image xlink:href> proxied; <use> sprites and .svg images untouched, fragments intact', async () => {
    const page = await open('svg.html');
    await until(() => proxied('/img/svg/pic.png').length && proxied('/img/svg/xlink.png').length, 5000);
    assert.equal(proxiedUrl(`${C}/img/svg/pic.png`).length, 1);
    assert.equal(proxiedUrl(`${C}/img/svg/xlink.png`).length, 1, 'fragment is not sent on the wire and not baked into url=');
    await until(() => direct('/sprite.svg').length, 3000);
    assert.equal(direct('/sprite.svg').length, 1, '<use> sprite fetched directly');
    assert.equal(proxied('/sprite.svg').length, 0);
    assert.equal(direct('/img/svg/logo.svg').length, 1);
    assert.equal(proxied('.svg').length, 0);
    const attrs = await page.evaluate(() => [document.getElementById('si2').getAttribute('xlink:href'), document.getElementById('u1').getAttribute('href')]);
    assert.deepEqual(attrs, [`${C}/img/svg/xlink.png#frag`, '/sprite.svg#icon']);
    await page.close();
  });

  test('video poster, <object>/<embed> images, canvas; documents in <object> and fetch() untouched', async () => {
    const page = await open('media.html');
    const canvas = await page.evaluate(() => window.__canvas);
    assert.ok(canvas.ok, `canvas readable (not tainted): ${canvas.err || ''}`);
    await until(() => proxied('/img/video/poster.png').length && proxied('/img/obj/o.png').length && proxied('/img/obj/e.png').length, 5000);
    assert.equal(proxied('/img/video/poster.png').length, 1);
    assert.equal(proxied('/img/obj/o.png').length, 1, '<object data=*.png>');
    assert.equal(proxied('/img/obj/e.png').length, 1, '<embed src=*.png>');
    assert.equal(proxied('/img/obj/canvas.png').length, 1, 'new Image() drawn to canvas');
    assert.equal(await page.evaluate(() => window.__fetch), 200);
    assert.equal(direct('/img/obj/fetch.png').length, 1, 'fetch() is not an image request: documented, not rewritten');
    await sleep(300);
    assert.equal(proxied('/doc.pdf').length + proxied('/doc.html').length, 0, 'non-image objects never proxied');
    assert.deepEqual([...direct('/img/video/'), ...direct('/img/obj/o.png'), ...direct('/img/obj/e.png'), ...direct('/img/obj/canvas.png')].map(e => e.url), []);
    await page.close();
  });

  test('URLs the raw contract cannot carry (&quality= …) are proxied once, encoded, by the DOM layer', async () => {
    const page = await open('conflict.html');
    await page.waitForFunction(() => Array.from(document.images).every(i => i.complete && i.naturalWidth > 0), null, { timeout: 8000 });
    await until(() => proxied('/img/conflict/bg.png').length, 4000);
    const js = `${C}/img/conflict/js.png?w=50&quality=80&l=1`;
    assert.equal(proxiedUrl(js).length, 1, 'full URL incl. &quality=&l= reached the proxy');
    assert.equal(directUrl(js).length, 0, 'JS-assigned conflict URL never fetched directly');
    assert.equal(proxiedUrl(`${C}/img/conflict/parser.png?w=50&quality=80`).length, 1);
    assert.equal(proxiedUrl(`${C}/img/conflict/bg.png?w=40&bw=1`).length, 1);
    const enc = log().filter(e => isProxy(e) && e.original === js)[0];
    assert.ok(/[?&]url=http%3A%2F%2F/.test(enc.url), 'encoded form');
    assertNoDuplicates('/img/conflict/');
    // Parser-created conflict URLs may race once (documented); never more.
    assert.ok(directUrl(`${C}/img/conflict/parser.png?w=50&quality=80`).length <= 1);
    await page.close();
  });

  test('fallback: a failed proxy response is retried ONCE directly, renders, and never loops', async () => {
    const statsBefore = await settledStats();
    const page = await open('fallback.html');
    await page.waitForFunction(() => ['f1', 'f2', 'f3'].every(id => { const i = document.getElementById(id); return i.complete && i.naturalWidth > 0; }), null, { timeout: 8000 });
    await until(() => ['inline', 'upper', 'sheet', 'xorigin', 'pseudo', 'poster', 'svg', 'closed'].every(k => direct(`/img/fallback/proxyfail-${k}`).length), 8000);
    await sleep(1500); // give any loop a chance to show up
    const names = ['proxyfail-1.png', 'proxyfail-ss.png', 'proxy403.png', 'proxyfail-originfail.png', 'proxyfail-inline.png', 'proxyfail-upper.png', 'proxyfail-sheet.png',
      'proxyfail-xorigin.png', 'proxyfail-pseudo.png', 'proxyfail-poster.png', 'proxyfail-svg.png', 'proxyfail-closed.png'];
    for (const n of names) {
      assert.equal(proxied('/img/fallback/' + n).length, 1, `${n}: one proxy attempt`);
      assert.equal(direct('/img/fallback/' + n).length, 1, `${n}: one direct retry`);
    }
    const conflict = `${C}/img/fallback/proxyfail-conflict.png?w=40&quality=80`;
    assert.equal(proxiedUrl(conflict).length, 1);
    assert.equal(directUrl(conflict).length, 1, 'DOM-layer element fallback');
    const st = await imgState(page, 'img');
    for (const id of ['f1', 'f2', 'f3', 'fc']) assert.ok(st.find(i => i.id === id).w > 0, id + ' rendered after fallback');
    assert.equal(st.find(i => i.id === 'f4').w, 0, 'origin also broken: stays broken, no retry storm');
    assert.ok((await page.evaluate(() => window.__closed())).every(([c, w]) => c && w > 0), 'closed shadow root image recovered');
    // Reload: bypass rules are per tab, so the same URLs now go direct immediately.
    const before = proxied('/img/fallback/').length;
    await page.reload({ waitUntil: 'load' });
    await sleep(800);
    assert.deepEqual(proxied('/img/fallback/').slice(before).map(e => e.original), [], 'no new proxy attempts for known-bad URLs in this tab');
    await page.close();
    assert.equal(await settledStats(), statsBefore, 'failed responses are not counted');
  });

  test('statistics count only strict image types', async () => {
    const before = { filesProcessed: await settledStats() };
    const page = await ctx.newPage();
    await page.goto(`${PAGE}/many.html?n=3&tag=stats`, { waitUntil: 'load' });
    await page.evaluate(C => new Promise(r => { const i = new Image(); i.onload = i.onerror = r; i.src = C + '/img/stats/avif.png?as=avif'; document.body.append(i); }), C);
    const after = { filesProcessed: await settledStats() };
    assert.equal(proxied('/img/stats/').length, 4);
    assert.equal(after.filesProcessed - before.filesProcessed, 3, 'image/avif response proxied but not counted');
    await page.close();
  });

  test('exclusions, private-network hosts, favicons and data: URLs are never proxied', async () => {
    const page = await open('skip.html');
    await page.waitForFunction(() => Array.from(document.images).every(i => i.complete));
    await sleep(200);
    assert.equal(direct('/img/skip/favicon-32.png').length, 1);
    assert.equal(proxied('/track/pixel.gif').length, 1, 'tracking-pixel-shaped URLs are proxied like any image');
    assert.equal(direct('/img/skip/excluded-host.png').length, 1);
    assert.equal(direct('/img/skip/excluded-sub.png').length, 1);
    assert.equal(proxied('/img/skip/normal.png').length, 1);
    for (const p of ['loopback.png', 'single-label.png', 'mdns.png']) assert.equal(direct('/img/skip/' + p).length, 1, `private host ${p} stays direct`);
    assert.equal(proxied('/img/skip/').length, 1);
    assert.equal(direct('/track/').length, 0);
    await page.close();
    // A page on an excluded host keeps all its images direct.
    const ex = await ctx.newPage();
    await ex.goto(`http://excluded.test:${PORT}/pages/many.html?n=3&tag=exclpage`, { waitUntil: 'load' });
    await ex.waitForFunction(() => Array.from(document.images).every(i => i.complete && i.naturalWidth > 0));
    assert.equal(direct('/img/exclpage/').length, 3);
    assert.equal(proxied('/img/exclpage/').length, 0);
    await ex.close();
  });

  test('page CSP img-src does not block the proxy redirect', async () => {
    const page = await ctx.newPage();
    await page.goto(`${PAGE}/csp.html?csp=${encodeURIComponent("img-src 'self'")}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('cs1').complete);
    const st = await imgState(page, '#cs1');
    assert.ok(st[0].w > 0, 'rendered');
    assert.equal(proxied('/img/csp/one.png').length, 1);
    assert.equal(direct('/img/csp/').length, 0);
    await page.close();
  });

  test('image-heavy page: 600 responsive lazy images, infinite scroll and viewport changes', async () => {
    const page = await open('heavy.html', { width: 1280, height: 900 });
    for (let y = 0; y < 20; y++) { await page.mouse.wheel(0, 4000); await sleep(120); }
    await page.setViewportSize({ width: 420, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    for (let y = 0; y < 20; y++) { await page.mouse.wheel(0, 4000); await sleep(120); }
    await page.waitForFunction(() => Array.from(document.images).filter(i => i.getBoundingClientRect().bottom > 0 && i.getBoundingClientRect().top < innerHeight).every(i => i.complete), null, { timeout: 15000 });
    await sleep(500);
    assert.ok(proxied('/img/heavy/').length > 600, `proxied ${proxied('/img/heavy/').length}`);
    assert.ok(proxied('/img/heavy/more-').length >= 50, 'dynamically appended page proxied');
    assert.deepEqual(direct('/img/heavy/').map(e => e.url), [], 'zero direct image requests');
    assertNoDuplicates('/img/heavy/');
    const broken = await page.$$eval('img', els => els.filter(i => i.complete && i.currentSrc && i.naturalWidth === 0).length);
    assert.equal(broken, 0);
    await page.close();
  });

  test('disabling the extension removes the redirect; settings changes rebuild it', async () => {
    await setSettings({ ...BASE_SETTINGS, enabled: false });
    let page = await ctx.newPage();
    await page.goto(`${PAGE}/many.html?n=3&tag=disabled`, { waitUntil: 'load' });
    await page.waitForFunction(() => Array.from(document.images).every(i => i.complete && i.naturalWidth > 0));
    assert.equal(direct('/img/disabled/').length, 3);
    assert.equal(proxied('/img/disabled/').length, 0);
    await page.close();
    await setSettings({ ...BASE_SETTINGS, quality: 45, grayscale: true });
    const red = (await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).find(r => r.id === 10);
    assert.match(red.action.redirect.regexSubstitution, /bw=1&quality=45&/);
    page = await ctx.newPage();
    await page.goto(`${PAGE}/many.html?n=2&tag=requality`, { waitUntil: 'load' });
    await page.waitForFunction(() => Array.from(document.images).every(i => i.complete && i.naturalWidth > 0));
    assert.ok(proxied('/img/requality/').every(e => /bw=1&quality=45/.test(e.url)));
    await page.close();
    await setSettings(BASE_SETTINGS);
  });

  test('circuit breaker: an unreachable proxy stops being used, pages keep working, then it recovers', async () => {
    srv.state.proxyDown = true;
    let page = await ctx.newPage();
    await page.goto(`${PAGE}/many.html?n=12&tag=down`, { waitUntil: 'load' });
    await page.waitForFunction(() => Array.from(document.images).every(i => i.complete && i.naturalWidth > 0), null, { timeout: 15000 });
    const runtime = await until(async () => {
      const r = (await sw.evaluate(() => chrome.storage.local.get('bhRuntime'))).bhRuntime;
      return r && r.suspended ? r : null;
    }, 5000);
    assert.ok(runtime && runtime.suspended, 'breaker open');
    assert.equal(direct('/img/down/').length, 12, 'every image recovered directly');
    await page.close();
    page = await ctx.newPage();
    await page.goto(`${PAGE}/many.html?n=4&tag=down2`, { waitUntil: 'load' });
    await page.waitForFunction(() => Array.from(document.images).every(i => i.complete && i.naturalWidth > 0));
    assert.equal(proxied('/img/down2/').length, 0, 'no attempts while open');
    await page.close();
    // Cool-down elapsed (simulated: fire the breaker alarm's work directly).
    srv.state.proxyDown = false;
    await sw.evaluate(() => new Promise(r => chrome.storage.session.remove('bhSuspendedUntil', () => { refreshRules(); r(); })));
    await until(async () => { const r = (await sw.evaluate(() => chrome.storage.local.get('bhRuntime'))).bhRuntime; return r && !r.suspended && r.redirect; }, 5000);
    page = await ctx.newPage();
    await page.goto(`${PAGE}/many.html?n=3&tag=up`, { waitUntil: 'load' });
    await page.waitForFunction(() => Array.from(document.images).every(i => i.complete && i.naturalWidth > 0));
    assert.equal(proxied('/img/up/').length, 3, 'proxying resumed');
    assert.equal(direct('/img/up/').length, 0);
    await page.close();
  });
});
