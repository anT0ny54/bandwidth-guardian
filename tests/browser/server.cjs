'use strict';
// Test origin server for the real-browser suite.
//
// One HTTP server answers for several hostnames (Chrome maps them to 127.0.0.1
// with --host-resolver-rules):
//   page.test      test pages + same-origin images/stylesheets
//   cdn.test       cross-origin images, stylesheets, SVG sprites
//   excluded.test  a host listed in excludeDomains
//   proxy.test     mock bandwidth-hero-proxy2 (/api/index)
//
// Every request that reaches the server is logged, so tests assert on the
// URLs the browser ACTUALLY requested on the network (a request redirected by
// declarativeNetRequest never reaches the original host and is not logged).
//
// The mock proxy parses `url` with getImageUrl() copied verbatim, at runtime,
// from the bandwidth-hero-proxy2 source when it is available (BHP2_DIR), so
// raw/encoded URL handling is tested against the real contract.

const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const pngCache = new Map();
function png(w, h, rgb = [40, 140, 200]) {
  const key = `${w}x${h}:${rgb}`;
  if (pngCache.has(key)) return pngCache.get(key);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const out = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
  pngCache.set(key, out);
  return out;
}

// getImageUrl from bandwidth-hero-proxy2 (functions/index.js).
function loadGetImageUrl() {
  const dir = process.env.BHP2_DIR;
  const file = dir && path.join(dir, 'functions', 'index.js');
  if (file && fs.existsSync(file)) {
    const src = fs.readFileSync(file, 'utf8');
    const pp = src.match(/const PROXY_PARAMETER = (\/.*\/);/);
    const fnStart = src.indexOf('export function getImageUrl');
    if (pp && fnStart >= 0) {
      // Body starts after the parameter list (which contains a `{}` default).
      let depth = 0, i = src.indexOf(') {', fnStart) + 2;
      for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
      const body = src.slice(fnStart, i + 1).replace('export ', '');
      // eslint-disable-next-line no-new-func
      return { fn: new Function(`const PROXY_PARAMETER = ${pp[1]};\n${body}\nreturn getImageUrl;`)(), source: 'bhp2' };
    }
  }
  // Fallback: same algorithm as bhp2 2.2.24.
  const PROXY_PARAMETER = /&(?:quality|l|bw|jpeg|max_width)=/;
  return { source: 'builtin', fn(event = {}) {
    const raw = String(event.rawQuery ?? '').replace(/^\?/, '');
    const match = /(?:^|&)url=/.exec(raw);
    if (!match) return { url: '', legacy: false };
    let value = raw.slice(match.index + match[0].length);
    if (/^https?:\/\//i.test(value)) {
      const end = value.search(PROXY_PARAMETER);
      if (end >= 0) value = value.slice(0, end);
      return { url: value, legacy: value.includes('&') };
    }
    const end = value.indexOf('&');
    if (end >= 0) value = value.slice(0, end);
    try { return { url: decodeURIComponent(value.replace(/\+/g, ' ')), legacy: false }; }
    catch { return { url: value, legacy: false }; }
  } };
}
const getImageUrl = loadGetImageUrl();

function createServer({ pagesDir }) {
  const log = [];
  const state = { proxyDown: false };

  const server = http.createServer(async (req, res) => {
    const host = String(req.headers.host || '').split(':')[0];
    const u = new URL(req.url, `http://${req.headers.host}`);
    const entry = { host, path: u.pathname, url: `http://${req.headers.host}${req.url}`, dest: req.headers['sec-fetch-dest'] || '' };
    if (u.pathname !== '/favicon.ico') log.push(entry);

    try {
      if (host === 'proxy.test') return proxy(req, res, u, entry);
      return origin(req, res, u, host);
    } catch (e) {
      res.statusCode = 500; res.end(String(e));
    }
  });

  function origin(req, res, u, host) {
    const p = u.pathname;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('access-control-allow-origin', '*');
    if (p === '/favicon.ico') { res.statusCode = 404; return res.end(); }
    if (p.startsWith('/pages/')) {
      const file = path.join(pagesDir, path.basename(p));
      if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('no page'); }
      res.setHeader('content-type', file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
      if (u.searchParams.get('csp')) res.setHeader('content-security-policy', u.searchParams.get('csp'));
      return res.end(fs.readFileSync(file, 'utf8').replace(/__PORT__/g, String(server.address().port)));
    }
    if (p.startsWith('/css/')) {
      // /css/<name>.css?bg=<url>[&bg2=<url>] → a stylesheet with url() rules
      res.setHeader('content-type', 'text/css');
      const bg = u.searchParams.get('bg'); const bg2 = u.searchParams.get('bg2');
      const sel = u.searchParams.get('sel') || '.xbg';
      return res.end(`${sel}{width:40px;height:30px;background-image:url("${bg}")${bg2 ? `, url(${bg2})` : ''}}`);
    }
    if (p.endsWith('.svg')) {
      res.setHeader('content-type', 'image/svg+xml');
      return res.end('<svg xmlns="http://www.w3.org/2000/svg"><symbol id="icon" viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></symbol><rect id="r" width="10" height="10"/></svg>');
    }
    if (p.endsWith('.pdf')) { res.setHeader('content-type', 'application/pdf'); return res.end('%PDF-1.4\n%%EOF'); }
    if (p.endsWith('.html')) { res.setHeader('content-type', 'text/html'); return res.end('<p>doc</p>'); }
    if (p.startsWith('/img/')) {
      if (p.includes('originfail')) { res.statusCode = 404; return res.end('nope'); }
      const w = Number(u.searchParams.get('w')) || 40;
      res.setHeader('content-type', 'image/png');
      return res.end(png(Math.min(w, 400), 30));
    }
    res.statusCode = 404; res.end('not found');
  }

  async function proxy(req, res, u, entry) {
    if (state.proxyDown) { req.socket.destroy(); return; }
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-expose-headers', 'X-BH-Original-Size, X-BH-Compressed-Size, X-BH-Bytes-Saved');
    // no-store: every duplicate proxied request must reach the server log.
    res.setHeader('cache-control', 'no-store');
    const raw = u.search.replace(/^\?/, '');
    const { url } = getImageUrl.fn({ rawQuery: raw, queryStringParameters: Object.fromEntries(u.searchParams) });
    entry.original = url || '';
    if (!url) { res.setHeader('content-type', 'text/plain'); return res.end('bandwidth-hero-proxy'); }
    if (url.includes('proxyfail')) { res.statusCode = 500; res.setHeader('content-type', 'text/plain'); return res.end('Processing failure'); }
    if (url.includes('proxy403')) { res.statusCode = 403; res.setHeader('content-type', 'text/plain'); return res.end('Forbidden'); }
    if (url.includes('proxy503')) { res.statusCode = 503; res.setHeader('content-type', 'text/plain'); return res.end('Sharp unavailable'); }
    let target;
    try { target = new URL(url); } catch { res.statusCode = 400; return res.end('bad url'); }
    // Fetch the upstream image through this same server (Host header routing).
    const upstream = await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: server.address().port, path: target.pathname + target.search,
        headers: { host: target.host, 'x-from-proxy': '1' } }, resolve);
      r.on('error', reject); r.end();
    });
    const chunks = []; for await (const c of upstream) chunks.push(c);
    const body = Buffer.concat(chunks);
    res.statusCode = upstream.statusCode;
    const ct = u.searchParams.get('force_type') || (target.searchParams.get('as') === 'avif' ? 'image/avif' : upstream.headers['content-type'] || 'application/octet-stream');
    res.setHeader('content-type', ct);
    res.setHeader('x-bh-original-size', String(body.length * 2));
    res.setHeader('x-bh-compressed-size', String(body.length));
    res.setHeader('x-bh-bytes-saved', String(body.length));
    res.end(body);
  }

  // Requests made by the mock proxy itself are not browser requests.
  const browserLog = () => log.filter(e => !e.fromProxy);
  server.on('request', req => { if (req.headers['x-from-proxy']) { const last = log[log.length - 1]; if (last) last.fromProxy = true; } });

  return { server, log, browserLog, state, getImageUrlSource: getImageUrl.source };
}

module.exports = { createServer };
