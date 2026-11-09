'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const prehook = fs.readFileSync(path.join(ROOT, 'prehook.js'), 'utf8');
const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const popupSource = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
const optionsSource = fs.readFileSync(path.join(ROOT, 'options.js'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8');


test('shared defaults are declared once and loaded before classic consumers', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const isolated = manifest.content_scripts.find(cs => (cs.js || []).includes('content.js'));
  assert.ok(isolated, 'isolated content script entry exists');
  assert.deepEqual(isolated.js, ['defaults.js', 'content.js']);

  assert.match(serviceWorker, /^importScripts\("defaults\.js"\);/m, 'worker imports shared defaults');
  assert.doesNotMatch(serviceWorker, /const DEFAULTS = \{/);
  assert.doesNotMatch(content, /const DEFAULTS = \{/);
});

function extractFunction(source, name) {
  const marker = new RegExp(`function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `function ${name} must exist in source`);
  const open = source.indexOf('{', match.index);
  assert.notEqual(open, -1, `function ${name} must have a body`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(match.index, i + 1);
    }
  }
  assert.fail(`function ${name} has unbalanced braces`);
}

function functionFrom(source, name, globals = {}) {
  const sandbox = { ...globals };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction(source, name)}\nthis.__exported = ${name};`, sandbox);
  return { fn: sandbox.__exported, sandbox };
}

function createDomHarness() {
  const observers = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const timerCallbacks = new Map();
  const cancelledTimers = new Set();
  let nextTimerId = 0;
  const baseURI = 'https://page.example/articles/';

  function dataName(name) {
    return String(name).replace(/[A-Z]/g, ch => '-' + ch.toLowerCase());
  }

  class Element {
    constructor(tagName = 'div') {
      this.tagName = String(tagName).toUpperCase();
      this.nodeName = this.tagName;
      this.nodeType = 1;
      this._attrs = new Map();
      this.children = [];
      this.style = { backgroundImage: '' };
      this.currentSrc = '';
      this._listeners = new Map();
      this.dataset = new Proxy({}, {
        get: (_t, prop) => this._attrs.get('data-' + dataName(prop)) ?? undefined,
        set: (_t, prop, value) => { this._attrs.set('data-' + dataName(prop), String(value)); return true; },
        deleteProperty: (_t, prop) => this._attrs.delete('data-' + dataName(prop))
      });
    }
    setAttribute(name, value) { this._attrs.set(String(name).toLowerCase(), String(value)); }
    getAttribute(name) { return this._attrs.has(String(name).toLowerCase()) ? this._attrs.get(String(name).toLowerCase()) : null; }
    hasAttribute(name) { return this._attrs.has(String(name).toLowerCase()); }
    removeAttribute(name) { this._attrs.delete(String(name).toLowerCase()); }
    addEventListener(type, fn, options = {}) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      const once = !!(options && typeof options === 'object' && options.once);
      this._listeners.get(type).push({ fn, once });
    }
    dispatchEvent(event) {
      this._dispatchedEvents ||= [];
      this._dispatchedEvents.push(event.type);
      const listeners = this._listeners.get(event.type) || [];
      for (const entry of [...listeners]) {
        entry.fn.call(this, event);
        if (entry.once) {
          const index = listeners.indexOf(entry);
          if (index !== -1) listeners.splice(index, 1);
        }
      }
      return true;
    }
    querySelectorAll(selector) {
      const tags = selector.split(',').map(s => s.trim().match(/^[a-z]+/i)?.[0]?.toUpperCase()).filter(Boolean);
      const out = [];
      const walk = el => {
        for (const child of el.children) {
          const linkPreload = child.tagName === 'LINK' && /(?:^|\s)preload(?:\s|$)/i.test(child.getAttribute('rel') || '');
          if (tags.includes(child.tagName) || (selector.includes('link[rel~="preload"]') && linkPreload)) out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    }
    appendChild(child) { this.children.push(child); return child; }
  }

  class HTMLImageElement extends Element {
    constructor() { super('img'); }
  }
  class HTMLSourceElement extends Element {
    constructor() { super('source'); }
  }
  class HTMLLinkElement extends Element {
    constructor() { super('link'); }
    get rel() { return this.getAttribute('rel') || ''; }
  }
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }

  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true, enumerable: true,
    get() { const v = this.getAttribute('src'); return v == null ? '' : new URL(v, baseURI).href; },
    set(v) { this._attrs.set('src', String(v)); }
  });
  Object.defineProperty(HTMLImageElement.prototype, 'srcset', {
    configurable: true, enumerable: true,
    get() { return this.getAttribute('srcset') || ''; },
    set(v) { this._attrs.set('srcset', String(v)); }
  });
  Object.defineProperty(HTMLImageElement.prototype, 'loading', {
    configurable: true, enumerable: true,
    get() { return this.getAttribute('loading') || 'auto'; },
    set(v) { this._attrs.set('loading', String(v)); }
  });
  Object.defineProperty(HTMLSourceElement.prototype, 'srcset', {
    configurable: true, enumerable: true,
    get() { return this.getAttribute('srcset') || ''; },
    set(v) { this._attrs.set('srcset', String(v)); }
  });
  Object.defineProperty(HTMLLinkElement.prototype, 'href', {
    configurable: true, enumerable: true,
    get() { const v = this.getAttribute('href'); return v == null ? '' : new URL(v, baseURI).href; },
    set(v) { this._attrs.set('href', String(v)); }
  });

  const documentElement = new Element('html');
  const document = {
    baseURI,
    documentElement,
    addEventListener(type, fn) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      documentListeners.set(type, (documentListeners.get(type) || []).filter(x => x !== fn));
    },
    dispatchEvent(event) {
      for (const fn of documentListeners.get(event.type) || []) fn(event);
      return true;
    },
    querySelectorAll() { return []; }
  };
  const window = {
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    }
  };
  const context = {
    document, window, location: { hostname: 'page.example' },
    Element, HTMLImageElement, HTMLSourceElement, HTMLLinkElement, MutationObserver,
    Event: class Event { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } },
    URL,
    setTimeout: (callback, delay = 0) => {
      const id = ++nextTimerId;
      timerCallbacks.set(id, { callback, delay });
      return id;
    },
    clearTimeout: id => { cancelledTimers.add(id); },
    console, Math, WeakRef
  };
  vm.createContext(context);
  vm.runInContext(prehook, context, { filename: 'prehook.js' });

  // redirect:false = the network redirect is NOT installed, so the DOM layer
  // proxies everything (the pre-0.1.9 behaviour). Default: redirect live.
  function publishSettings(overrides = {}) {
    const type = documentElement.dataset.bhSettingsEvent || 'bh-settings-update';
    document.dispatchEvent({
      type,
      detail: JSON.stringify({
        enabled: true,
        proxyBase: 'https://proxy.example/convert',
        quality: 60,
        grayscale: false,
        maxWidth: 768,
        excludeDomains: '',
        ...overrides
      })
    });
  }

  function notifyAdded(root) {
    const observer = observers.find(o => !o.disconnected);
    assert.ok(observer, 'prehook should register its parser/preload observer');
    observer.callback([{ type: 'childList', addedNodes: [root] }]);
  }

  return { context, document, documentElement, observers, Element, HTMLImageElement, HTMLSourceElement, HTMLLinkElement,
    timerCallbacks, cancelledTimers, publishSettings, notifyAdded };
}

function assertProxied(url, original) {
  assert.ok(url, `expected a proxy URL for ${original}`);
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://proxy.example');
  assert.equal(parsed.searchParams.get('url'), original);
}

test('every shipped script passes Node syntax checks', () => {
  const files = ['prehook.js', 'content.js', 'service-worker.js', 'options.js', 'popup.js', 'defaults.js'];
  for (const file of files) {
    const full = path.join(ROOT, file);
    // popup/options/defaults are ES modules: check them as .mjs content via stdin.
    const esm = ['options.js', 'popup.js'].includes(file);
    const result = esm
      ? spawnSync(process.execPath, ['--input-type=module', '--check'], { encoding: 'utf8', input: fs.readFileSync(full, 'utf8') })
      : spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr || result.stdout}`);
  }
});

test('popup exclusion removal normalizes separators without leaving empty tokens', () => {
  const helpers = ['parseDomains', 'removeDomainToken'].map(name => extractFunction(popupSource, name)).join('\n');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${helpers}\nthis.removeToken = removeDomainToken;`, sandbox);
  assert.equal(sandbox.removeToken(',example.com,, CDN.example.net  ', 'example.com'), 'cdn.example.net');
  assert.equal(sandbox.removeToken('https://example.com/path,other.example', 'example.com'), 'other.example');
});

test('srcset parser preserves descriptors and commas inside image URLs', () => {
  for (const [name, source] of [['prehook.js', prehook], ['content.js', content]]) {
    const { fn: parseSrcset } = functionFrom(source, 'parseSrcset');
    const input = 'https://cdn.example/a,w_400,h_300.webp 1x, https://cdn.example/b.jpg?fit=cover,center 2x';
    const actual = parseSrcset(input).map(({ url, desc }) => [url, desc]);
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), [
      ['https://cdn.example/a,w_400,h_300.webp', '1x'],
      ['https://cdn.example/b.jpg?fit=cover,center', '2x']
    ], `${name} parsed srcset incorrectly`);
  }
});

test('DOM-fallback mode (no network redirect): setters, setAttribute and srcset route URLs through the proxy', () => {
  const h = createDomHarness();
  h.publishSettings({ redirect: false });
  const img = new h.HTMLImageElement();
  const src = 'https://cdn.example/images/cover.jpg?size=large&v=2';
  img.src = src;
  assertProxied(img.getAttribute('src'), src);

  const byAttribute = new h.HTMLImageElement();
  const src2 = 'https://cdn.example/images/attribute.jpg';
  byAttribute.setAttribute('src', src2);
  assertProxied(byAttribute.getAttribute('src'), src2);

  const responsive = new h.HTMLImageElement();
  const a = 'https://cdn.example/a.webp?x=1&y=2';
  const b = 'https://cdn.example/b.webp?x=3&y=4';
  responsive.srcset = `${a} 1x, ${b} 2x`;
  const candidates = responsive.getAttribute('srcset').split(', ').map(part => part.split(' ')[0]);
  assert.equal(candidates.length, 2);
  assertProxied(candidates[0], a);
  assertProxied(candidates[1], b);
});

test('redirect live: the DOM layer leaves ordinary URLs alone (no double proxying) and proxies only conflict URLs', () => {
  const h = createDomHarness();
  h.publishSettings();
  const plain = new h.HTMLImageElement();
  plain.src = 'https://cdn.example/a.jpg?x=1&y=2';
  assert.equal(plain.getAttribute('src'), 'https://cdn.example/a.jpg?x=1&y=2', 'network redirect owns it');
  const plainSet = new h.HTMLImageElement();
  plainSet.srcset = 'https://cdn.example/a.jpg 1x, https://cdn.example/b.jpg 2x';
  assert.equal(plainSet.getAttribute('srcset'), 'https://cdn.example/a.jpg 1x, https://cdn.example/b.jpg 2x');
  const conflict = new h.HTMLImageElement();
  const c = 'https://cdn.example/c.jpg?w=10&quality=80';
  conflict.src = c;
  assertProxied(conflict.getAttribute('src'), c);
  const mixed = new h.HTMLImageElement();
  mixed.setAttribute('srcset', `https://cdn.example/m.jpg 1x, ${c} 2x`);
  const parts = mixed.getAttribute('srcset').split(', ').map(x => x.split(' '));
  assert.equal(parts[0][0], 'https://cdn.example/m.jpg');
  assert.equal(parts[0][1], '1x');
  assertProxied(parts[1][0], c);
  assert.equal(parts[1][1], '2x', 'descriptor preserved');
  // Already-proxied URLs are never wrapped again.
  const again = new h.HTMLImageElement();
  again.src = conflict.getAttribute('src');
  assert.equal(again.getAttribute('src'), conflict.getAttribute('src'));
  // A URL whose proxy request already failed in this tab stays direct.
  h.publishSettings({ failed: [c] });
  const failed = new h.HTMLImageElement();
  failed.src = c;
  assert.equal(failed.getAttribute('src'), c);
});

test('before settings arrive only conflict URLs are held; ordinary URLs are never delayed', () => {
  const h = createDomHarness();
  const plain = new h.HTMLImageElement();
  plain.src = 'https://cdn.example/plain.jpg';
  assert.equal(plain.getAttribute('src'), 'https://cdn.example/plain.jpg');
  const root = new h.Element('div');
  const parserPlain = new h.HTMLImageElement();
  parserPlain._attrs.set('src', 'https://cdn.example/parser-plain.jpg');
  root.appendChild(parserPlain);
  h.notifyAdded(root);
  assert.equal(parserPlain.getAttribute('src'), 'https://cdn.example/parser-plain.jpg');
});

test('parser-created conflict images, picture sources, preload links, and 2,005 queued images recover after settings arrive', () => {
  const h = createDomHarness();
  const root = new h.Element('div');
  const allImages = [];
  for (let i = 0; i < 2005; i++) {
    const img = new h.HTMLImageElement();
    img._attrs.set('src', `https://cdn.example/parser/${i}.jpg?width=640&quality=90`); // parser bypasses JS setters
    root.appendChild(img);
    allImages.push(img);
  }

  const pictureSource = new h.HTMLSourceElement();
  const sourceA = 'https://cdn.example/picture/a.webp?x=1&bw=0';
  const sourceB = 'https://cdn.example/picture/b.webp?x=1&bw=0';
  pictureSource._attrs.set('srcset', `${sourceA} 1x, ${sourceB} 2x`);
  root.appendChild(pictureSource);

  const preload = new h.HTMLLinkElement();
  preload._attrs.set('rel', 'preload');
  preload._attrs.set('as', 'image');
  const preloadUrl = 'https://cdn.example/preload/cover.jpg?v=1&max_width=900';
  preload._attrs.set('href', preloadUrl);
  root.appendChild(preload);

  h.notifyAdded(root);
  assert.equal(allImages[0].getAttribute('src'), null, 'parser image URL should be held while options are pending');
  assert.equal(pictureSource.getAttribute('srcset'), null, 'picture source should be held while options are pending');
  assert.equal(preload.getAttribute('href'), null, 'preload href should be held while options are pending');

  h.publishSettings();
  for (let i = 0; i < allImages.length; i++) {
    assertProxied(allImages[i].getAttribute('src'), `https://cdn.example/parser/${i}.jpg?width=640&quality=90`);
  }
  const rewrittenSources = pictureSource.getAttribute('srcset').split(', ').map(part => part.split(' ')[0]);
  assertProxied(rewrittenSources[0], sourceA);
  assertProxied(rewrittenSources[1], sourceB);
  assertProxied(preload.getAttribute('href'), preloadUrl);
});

test('parser-created responsive preload without href holds conflicting imagesrcset until settings arrive', () => {
  const h = createDomHarness();
  const root = new h.Element('div');
  const preload = new h.HTMLLinkElement();
  preload._attrs.set('rel', 'preload');
  preload._attrs.set('as', 'image');
  const responsiveUrl = 'https://cdn.example/preload/responsive.jpg?width=800&quality=75';
  preload._attrs.set('imagesrcset', `${responsiveUrl} 800w, https://cdn.example/preload/full.jpg 1600w`);

  root.appendChild(preload);
  h.notifyAdded(root);

  assert.equal(preload.getAttribute('href'), null, 'imagesrcset-only preload has no href to hold');
  assert.equal(preload.getAttribute('imagesrcset'), null, 'conflicting imagesrcset should be held while options are pending');
  assert.equal(preload.dataset.bhPreloadSrcset, `${responsiveUrl} 800w, https://cdn.example/preload/full.jpg 1600w`);

  h.publishSettings();

  const rewritten = preload.getAttribute('imagesrcset');
  assert.ok(rewritten, 'imagesrcset should be restored after settings arrive');
  const candidates = rewritten.split(', ').map(part => part.split(' '));
  assertProxied(candidates[0][0], responsiveUrl);
  assert.equal(candidates[0][1], '800w');
  assert.equal(candidates[1][0], 'https://cdn.example/preload/full.jpg');
  assert.equal(candidates[1][1], '1600w');
});

test('content script rewrites URL references across inline CSS declarations', () => {
  const rewriteSource = extractFunction(content, 'rewriteInlineStyles');
  const sandbox = {
    doneStyle: new WeakSet(), active: true, failedEls: { has: () => false },
    shouldSkip(url) { try { return !/^https?:$/.test(new URL(url).protocol) || new URL(url).origin === 'https://proxy.example'; } catch { return true; } },
    resolveHttp(url) { try { const u = new URL(url, 'https://page.example/'); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } },
    buildProxyUrl(url) { return 'https://proxy.example/convert?url=' + encodeURIComponent(url); }
  };
  vm.createContext(sandbox);
  vm.runInContext(`${rewriteSource}\nthis.__rewrite = rewriteInlineStyles;`, sandbox);
  const originalStyle = 'background-image:linear-gradient(red, blue), url("https://cdn.example/a.jpg?x=1&y=2"); border-image-source:url(https://cdn.example/b.webp); mask-image:URL(https://cdn.example/c.png)';
  const el = {
    getAttribute(name) { return name === 'style' ? this._style : null; },
    setAttribute(name, value) { if (name === 'style') this._style = String(value); },
    _style: originalStyle
  };
  sandbox.__rewrite(el);
  assert.equal((el._style.match(/https:\/\/proxy\.example\/convert\?url=/g) || []).length, 3);
  for (const original of ['https://cdn.example/a.jpg?x=1&y=2', 'https://cdn.example/b.webp', 'https://cdn.example/c.png']) {
    assert.ok(el._style.includes(encodeURIComponent(original)), `rewritten style retains ${original}`);
  }
});

test('fallback load cleanup remains armed after an image element is reused', () => {
  const h = createDomHarness();
  h.publishSettings({ redirect: false });
  const image = new h.HTMLImageElement();

  image.src = 'https://cdn.example/first-success.png';
  image.dispatchEvent({ type: 'load' });

  const second = 'https://cdn.example/second-success.png';
  image.src = second;
  image.dispatchEvent({ type: 'error' });
  const timerEntry = [...h.timerCallbacks.entries()].filter(([, entry]) => entry.delay === 1500).at(-1);
  assert.ok(timerEntry, 'second proxy error schedules a fallback timer');

  image.dispatchEvent({ type: 'load' });
  assert.ok(h.cancelledTimers.has(timerEntry[0]), 'the second successful load cancels its fallback timer');
  timerEntry[1].callback();
  assert.equal(image.getAttribute('src'), image.src, 'a stale timer cannot restore the successfully loaded proxy URL');

  // Both execution worlds use the same one-per-element listener lifecycle.
  for (const source of [prehook, content]) {
    const arm = extractFunction(source, 'armProxyFallback');
    assert.doesNotMatch(arm, /capture:\s*true,\s*once:\s*true/);
  }
});

test('private host guards cover all IPv6 link-local space and private IPv4-mapped IPv6', () => {
  const h = createDomHarness();
  h.publishSettings({ redirect: false });
  const privateUrls = [
    'http://[fe80::1]/image.png',
    'http://[fe90::1]/image.png',
    'http://[fea0::1]/image.png',
    'http://[febf::1]/image.png',
    'http://[::ffff:127.0.0.1]/image.png',
    'http://[::ffff:10.0.0.1]/image.png',
    'http://[::ffff:192.168.1.1]/image.png',
    'http://[::ffff:172.16.0.1]/image.png',
    'http://[::ffff:172.31.255.255]/image.png',
    'http://[::ffff:169.254.1.1]/image.png'
  ];
  for (const url of privateUrls) {
    const image = new h.HTMLImageElement();
    image.src = url;
    assert.equal(image.getAttribute('src'), url, `${url} must stay direct`);
  }
});

test('DOM fallback preserves private/intranet exemptions and normalizes proxy URLs', () => {
  const h = createDomHarness();
  h.publishSettings({ redirect: false, proxyBase: 'https://proxy.example/convert#discard-me' });
  const privateUrls = [
    'http://localhost:3000/image.png',
    'http://app.localhost/image.png',
    'http://nas/image.png',
    'http://printer.local/image.png',
    'http://127.0.0.1/image.png',
    'http://10.1.2.3/image.png',
    'http://192.168.1.5/image.png',
    'http://172.16.0.1/image.png',
    'http://169.254.10.20/image.png',
    'http://[::1]/image.png',
    'http://[fd00::1]/image.png',
    'http://[fe80::1]/image.png'
  ];
  for (const url of privateUrls) {
    const image = new h.HTMLImageElement();
    image.src = url;
    assert.equal(image.getAttribute('src'), url, `${url} must stay direct`);
  }

  const publicUrl = 'https://cdn.example/image.png?x=1&y=2';
  const publicImage = new h.HTMLImageElement();
  publicImage.src = publicUrl;
  const proxyUrl = new URL(publicImage.getAttribute('src'));
  assert.equal(proxyUrl.origin, 'https://proxy.example');
  assert.equal(proxyUrl.hash, '', 'fragments are removed before proxy parameters are appended');
  assert.equal(proxyUrl.searchParams.get('url'), publicUrl);

  h.publishSettings({ redirect: false, proxyBase: 'ftp://proxy.example/convert' });
  const invalidProxyImage = new h.HTMLImageElement();
  invalidProxyImage.src = publicUrl;
  assert.equal(invalidProxyImage.getAttribute('src'), publicUrl, 'invalid proxy values do not activate rewriting');
});

test('a reused image element is re-armed for a new URL but keeps known failures direct', () => {
  const h = createDomHarness();
  const failed = 'https://cdn.example/known-failure.png';
  h.publishSettings({ redirect: false, failed: [failed] });

  const propertyImage = new h.HTMLImageElement();
  propertyImage.setAttribute('data-bh-failed', '');
  propertyImage.setAttribute('data-bh-restored', '');
  propertyImage.setAttribute('data-bh-pending-original', failed);
  propertyImage.src = failed;
  assert.equal(propertyImage.getAttribute('src'), failed, 'the same failed URL remains direct');
  assert.ok(propertyImage.hasAttribute('data-bh-failed'), 'same failed URL keeps its one-shot guard');
  const fresh = 'https://cdn.example/reused-node-new.png';
  propertyImage.src = fresh;
  assertProxied(propertyImage.getAttribute('src'), fresh);
  for (const marker of ['data-bh-failed', 'data-bh-restored', 'data-bh-pending-original']) {
    assert.equal(propertyImage.hasAttribute(marker), false, `${marker} clears for a new URL`);
  }

  const attributeImage = new h.HTMLImageElement();
  attributeImage.setAttribute('data-bh-failed', '');
  attributeImage.setAttribute('data-bh-pending-original', failed);
  const freshAttribute = 'https://cdn.example/reused-node-attribute.png';
  attributeImage.setAttribute('src', freshAttribute);
  assertProxied(attributeImage.getAttribute('src'), freshAttribute);

  const srcsetImage = new h.HTMLImageElement();
  srcsetImage.setAttribute('data-bh-failed', '');
  srcsetImage.setAttribute('data-bh-restored', '');
  srcsetImage.setAttribute('data-bh-pending-original', failed);
  const freshSrcset = 'https://cdn.example/reused-node-srcset.png';
  srcsetImage.srcset = `${failed} 1x, ${freshSrcset} 2x`;
  const candidates = srcsetImage.getAttribute('srcset').split(', ').map(part => part.split(' ')[0]);
  assert.equal(candidates[0], failed, 'known failed srcset candidate remains direct');
  assertProxied(candidates[1], freshSrcset);
  assert.equal(srcsetImage.hasAttribute('data-bh-failed'), false, 'new srcset clears stale element marker');
  assert.equal(srcsetImage.hasAttribute('data-bh-restored'), false, 'new srcset clears stale restore marker');

  // Before bypass confirmation, RESTORED/PENDING are present but FAILED is
  // not yet set. Reusing the node in this window must still disarm old state.
  const pendingImage = new h.HTMLImageElement();
  pendingImage.setAttribute('data-bh-restored', '');
  pendingImage.setAttribute('data-bh-pending-original', failed);
  const pendingReplacement = 'https://cdn.example/pending-replacement.png';
  pendingImage.src = pendingReplacement;
  assertProxied(pendingImage.getAttribute('src'), pendingReplacement);
  assert.equal(pendingImage.hasAttribute('data-bh-restored'), false);
  assert.equal(pendingImage.hasAttribute('data-bh-pending-original'), false);
  assert.ok(pendingImage._dispatchedEvents.includes('bh-image-rearmed'),
    'MAIN-world rearm notification lets the isolated world clear its separate fallback state');
});

test('a cancelled fallback timeout cannot restore a newer source on a recycled element', () => {
  const h = createDomHarness();
  h.publishSettings({ redirect: false });
  const image = new h.HTMLImageElement();
  const first = 'https://cdn.example/first-failure.png';
  image.src = first;
  image.dispatchEvent({ type: 'error' });
  const firstTimer = [...h.timerCallbacks.entries()].filter(([, entry]) => entry.delay === 1500).at(-1)?.[0];
  assert.ok(firstTimer, 'first proxy error schedules a fallback timeout');

  const second = 'https://cdn.example/second-failure.png';
  image.src = second;
  image.dispatchEvent({ type: 'error' });
  const secondTimer = [...h.timerCallbacks.entries()].filter(([, entry]) => entry.delay === 1500).at(-1)?.[0];
  assert.ok(secondTimer && secondTimer !== firstTimer, 'new failure owns a distinct timeout');
  assert.ok(h.cancelledTimers.has(firstTimer), 'rearm cancels the old timeout');
  assert.equal(image.getAttribute('data-bh-pending-original'), new URL(second).href);

  // Simulate a cancelled callback that had already entered the task queue.
  h.timerCallbacks.get(firstTimer).callback();
  assert.equal(image.getAttribute('src'), image.src, 'stale callback must not replace the current proxy URL');
  assert.equal(image.getAttribute('data-bh-pending-original'), new URL(second).href,
    'stale callback leaves the newer restore claim intact');

  h.timerCallbacks.get(secondTimer).callback();
  assert.equal(image.getAttribute('src'), new URL(second).href, 'the current timeout restores its own original URL');
});

test('duplicated patterns stay in sync across prehook, content script and service worker', () => {
  const grab = (src, name) => {
    const m = new RegExp(`const ${name} = (\/.*\/)([a-z]*);`).exec(src);
    assert.ok(m, `${name} present`);
    return new RegExp(m[1].slice(1, -1), m[2]);
  };
  for (const name of ['SKIP_URL_RE', 'CONFLICT_RE']) {
    assert.equal(grab(prehook, name).source, grab(content, name).source, `${name} prehook vs content`);
  }
  const sb = {};
  vm.createContext(sb);
  const consts = serviceWorker.slice(serviceWorker.indexOf('const SKIP_PATTERN'), serviceWorker.indexOf('const ALL_RULE_IDS'));
  vm.runInContext(consts.replace(/^const /gm, 'var '), sb);
  assert.equal(sb.SKIP_PATTERN, grab(prehook, 'SKIP_URL_RE').source);
  assert.equal(sb.CONFLICT_PATTERN, grab(prehook, 'CONFLICT_RE').source);
  const extractArray = (source, name) => {
    const m = new RegExp(`const ${name} = (\\[[\\s\\S]*?\\n\\s*\\]);`).exec(source);
    assert.ok(m, `${name} present`);
    const arrayContext = {};
    vm.createContext(arrayContext);
    vm.runInContext(`this.value = ${m[1]}`, arrayContext);
    return JSON.stringify(arrayContext.value);
  };
  assert.equal(extractArray(prehook, 'PRIVATE_HOST_PATTERNS'), extractArray(content, 'PRIVATE_HOST_PATTERNS'));
  assert.equal(extractArray(prehook, 'PRIVATE_HOST_PATTERNS'), JSON.stringify(sb.PRIVATE_HOST_PATTERNS));
});

test('service worker: raw redirect target round-trips through the proxy contract; recovery mirrors getImageUrl', () => {
  const sb = { URL, decodeURIComponent };
  vm.createContext(sb);
  const consts = serviceWorker.slice(serviceWorker.indexOf('const SKIP_PATTERN'), serviceWorker.indexOf('const ALL_RULE_IDS'));
  vm.runInContext(consts.replace(/^const /gm, 'var ') + '\nvar configuredProxyOrigin = "https://proxy.example";\nvar PROXY_PARAMETER_RE = new RegExp(CONFLICT_PATTERN);\n' +
    extractFunction(serviceWorker, 'redirectSubstitution') + '\n' + extractFunction(serviceWorker, 'originalFromProxyUrl') +
    '\nthis.rs = redirectSubstitution; this.orig = originalFromProxyUrl;', sb);
  const sub = sb.rs({ quality: 55, grayscale: true, maxWidth: 1024 }, 'https://proxy.example/api/index');
  assert.equal(sub, 'https://proxy.example/api/index?jpeg=0&bw=1&quality=55&max_width=1024&url=\\0');
  assert.equal(sb.rs({ quality: 60, grayscale: false, maxWidth: 0 }, 'https://proxy.example/x?key=k'), 'https://proxy.example/x?key=k&jpeg=0&bw=0&quality=60&url=\\0');
  const conflict = new RegExp(sb.CONFLICT_PATTERN);
  const samples = [
    'https://cdn.example/a.jpg',
    'https://cdn.example/a.jpg?x=1&y=2',
    'https://cdn.example/a%20b+c.jpg?q=%26%3D&z=a+b',
    'https://cdn.example/a,w_400,h_300/b.webp?url=nested&u=1',
    'http://cdn.example:8080/p/?a=1&quality_x=2&ql=3'
  ];
  for (const original of samples) {
    assert.ok(!conflict.test(original), `${original} must be raw-safe`);
    const redirected = sub.replace('\\0', original); // what Chrome builds
    assert.equal(sb.orig(redirected), original, 'raw form');
    assert.equal(sb.orig('https://proxy.example/api/index?url=' + encodeURIComponent(original) + '&jpeg=0&bw=0&quality=60'), original, 'encoded form');
  }
  for (const bad of ['https://cdn.example/a.jpg?w=1&quality=80', 'https://cdn.example/a.jpg?x&l=2', 'https://cdn.example/a?x=1&bw=1', 'https://cdn.example/a?x=1&jpeg=1', 'https://cdn.example/a?x=1&max_width=5']) {
    assert.ok(conflict.test(bad), `${bad} must be exempted from the raw redirect`);
  }
  assert.equal(sb.orig('https://other.example/api/index?url=https://cdn.example/a.jpg'), null, 'foreign origin ignored');
  const privRes = sb.PRIVATE_HOST_PATTERNS.map(p => new RegExp(p, 'i'));
  const priv = { test: u => privRes.some(r => r.test(u)) };
  for (const u of ['http://localhost/a.png', 'http://localhost:3000/a.png', 'http://app.localhost/a', 'http://nas/photo.jpg', 'http://nas:8080/x', 'http://printer.local/x.png',
    'http://127.0.0.1/a', 'http://10.1.2.3:81/a', 'http://192.168.0.5/a', 'http://172.16.0.1/a', 'http://172.31.9.9/a', 'http://169.254.1.1/a', 'http://[::1]/a', 'http://[fd00::1]:8080/a', 'http://[fe80::1]/a']) {
    assert.ok(priv.test(u), `${u} is private`);
  }
  for (const u of ['https://cdn.example/a.png', 'https://172.32.0.1/a', 'https://11.0.0.1/a', 'https://example.com/localhost/a.png', 'https://local.example.com/a', 'https://[2001:db8::1]/a', 'https://a.b/10.0.0.1']) {
    assert.ok(!priv.test(u), `${u} is public`);
  }
});

test('service worker never broadens CSP removal when response-header matching is unavailable', () => {
  const constantsStart = serviceWorker.indexOf('const RULE_ID_CSP');
  const constantsEnd = serviceWorker.indexOf('const ALL_RULE_IDS');
  const constantSource = serviceWorker.slice(constantsStart, constantsEnd);
  const helpers = ['parseExcluded', 'usableProxyBase', 'redirectSubstitution', 'buildRules']
    .map(name => extractFunction(serviceWorker, name)).join('\n');
  const sandbox = { URL, Math, Set, PROXY_REQUEST_TYPES: ['image', 'object'] };
  vm.createContext(sandbox);
  vm.runInContext(`${constantSource}\n${helpers}\nthis.__buildRules = buildRules;`, sandbox);
  const opts = { enabled: true, proxyBase: 'https://proxy.example/convert', saveData: true,
    quality: 60, grayscale: false, maxWidth: 768, excludeDomains: '' };
  const fallbackRules = sandbox.__buildRules(opts, true, false);
  assert.equal(fallbackRules.some(rule => rule.id === 2), false, 'unsupported header matching must preserve CSP');
  assert.ok(fallbackRules.some(rule => rule.id === 10), 'image redirect remains installed without CSP matching');
  const normalRules = sandbox.__buildRules(opts, false, false);
  const csp = normalRules.find(rule => rule.id === 2);
  assert.deepEqual(JSON.parse(JSON.stringify(csp.condition.responseHeaders)), [
    { header: 'content-security-policy', values: ['*img-src*', '*default-src*'] }
  ]);
  const suspendedRules = sandbox.__buildRules(opts, false, true);
  assert.equal(suspendedRules.some(rule => rule.id === 2), false, 'suspension must preserve page CSP');
  assert.equal(suspendedRules.some(rule => rule.id === 10), false, 'suspension disables redirects');
});

test('CSS fallback retries uppercase URL() references in stylesheet rules', () => {
  const safeURL = (value, base) => { try { return new URL(value, base); } catch { return null; } };
  const stripHash = value => { const url = new URL(value); url.hash = ''; return url.href; };
  const sandbox = {
    URL, Set, CSS_URL_RE: /url\(\s*(?:(['\"])(.*?)\1|([^)]*?))\s*\)/gi,
    document: { baseURI: 'https://page.example/' },
    safeURL, stripHash
  };
  vm.createContext(sandbox);
  const helpers = [extractFunction(prehook, 'cssUrls'), extractFunction(prehook, 'retryRules')].join('\n');
  vm.runInContext(`${helpers}\nthis.retry = retryRules;`, sandbox);

  const original = 'https://cdn.example/failed-background.png';
  const cssText = '.hero { background-image: URL("https://cdn.example/failed-background.png"); }';
  const rules = [{ constructor: { name: 'CSSStyleRule' }, cssText }];
  const inserted = [];
  const sheet = {
    get cssRules() { return rules; },
    deleteRule(index) { rules.splice(index, 1); },
    insertRule(text, index) {
      inserted.push(text);
      rules.splice(index, 0, { constructor: { name: 'CSSStyleRule' }, cssText: text });
    }
  };
  const hit = sandbox.retry(sheet, 'https://page.example/', url => url === original, new Set());
  assert.equal(hit, true, 'uppercase URL() still identifies the failed image URL');
  assert.deepEqual(inserted, [cssText], 'the matching stylesheet rule is reinserted to retry it');
});

test('picture fallback restores a failed conflict-proxy source candidate to its original URL', () => {
  const sandbox = {
    URL,
    safeURL(value, base) { try { return new URL(value, base); } catch { return null; } }
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction(prehook, 'parseSrcset'),
    extractFunction(prehook, 'retryPictureSources')
  ].join('\n') + '\nthis.retry = retryPictureSources;', sandbox);

  const original = 'https://cdn.example/picture-conflict.png?w=40&quality=80';
  const proxy = `https://proxy.example/convert?url=${encodeURIComponent(original)}&jpeg=0&bw=0&quality=60`;
  const source = {
    baseURI: 'https://page.example/',
    value: `${proxy} 2x, https://cdn.example/other.png 3x`,
    getAttribute(name) { return name === 'srcset' ? this.value : null; }
  };
  const picture = { querySelectorAll(selector) { return selector === 'source' ? [source] : []; } };
  const proxyToOriginal = new Map([[proxy, original]]);
  const matched = [];
  const has = value => { if (value === original) matched.push(value); return value === original; };
  const setAttribute = function (name, value) { if (name === 'srcset') this.value = String(value); };

  assert.equal(sandbox.retry(picture, 'https://page.example/', has, proxyToOriginal, setAttribute), true);
  assert.deepEqual(matched, [original], 'the proxy candidate is checked against its original failed URL');
  assert.equal(source.value, `${original} 2x, https://cdn.example/other.png 3x`, 'only the failed candidate is restored and descriptors are preserved');
});

test('picture fallback retries a raw DNR source candidate without changing other candidates', () => {
  const sandbox = {
    URL,
    safeURL(value, base) { try { return new URL(value, base); } catch { return null; } }
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction(prehook, 'parseSrcset'),
    extractFunction(prehook, 'retryPictureSources')
  ].join('\n') + '\nthis.retry = retryPictureSources;', sandbox);

  const original = 'https://cdn.example/picture-raw.png?token=one';
  const other = 'https://cdn.example/picture-other.png';
  const source = {
    baseURI: 'https://page.example/',
    value: `${other} 1x, ${original} 2x`,
    getAttribute(name) { return name === 'srcset' ? this.value : null; }
  };
  const picture = { querySelectorAll(selector) { return selector === 'source' ? [source] : []; } };
  const matched = [];
  const setAttribute = function (name, value) { if (name === 'srcset') this.value = String(value); };

  assert.equal(sandbox.retry(picture, 'https://page.example/', value => {
    if (value === original) matched.push(value);
    return value === original;
  }, new Map(), setAttribute), true);
  assert.deepEqual(matched, [original], 'the raw DNR URL matches the failed original');
  assert.equal(source.value, `${other} 1x, ${original} 2x`, 'other candidates and descriptors remain intact');
});

test('a changed picture source clears stale fallback state on its parent image', () => {
  const image = {};
  const received = [];
  const sandbox = {
    clearFailedForReplacement(target, values) { received.push({ target, values }); }
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction(prehook, 'clearPictureImageFailure')}\nthis.clear = clearPictureImageFailure;`, sandbox);

  const picture = { querySelector(selector) { return selector === 'img' ? image : null; } };
  const source = { closest(selector) { return selector === 'picture' ? picture : null; } };
  const candidates = ['https://cdn.example/new-source.png'];
  sandbox.clear(source, candidates);
  assert.equal(received.length, 1);
  assert.equal(received[0].target, image);
  assert.equal(received[0].values, candidates);
});

test('incoming quality and width changes update reset baselines without clobbering dirty inputs', () => {
  const sandbox = { dirty: { quality: true, width: true } };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction(optionsSource, 'mergeIncomingSetting')}\nthis.merge = mergeIncomingSetting;`, sandbox);

  const applied = [];
  assert.equal(sandbox.merge({ newValue: 45 }, 'quality', 60, value => applied.push(value)), 45);
  assert.equal(sandbox.merge({ newValue: 720 }, 'width', 1280, value => applied.push(value)), 720);
  assert.deepEqual(applied, [], 'dirty controls keep their current edits');

  sandbox.dirty.quality = false;
  sandbox.dirty.width = false;
  assert.equal(sandbox.merge({ newValue: 45 }, 'quality', 60, value => applied.push(value)), 45);
  assert.equal(sandbox.merge({ newValue: 720 }, 'width', 1280, value => applied.push(value)), 720);
  assert.deepEqual(applied, [45, 720], 'clean controls apply the newest stored values');
});

test('service worker builds exact bypass matches for URLs containing DNR filter metacharacters', () => {
  const helper = extractFunction(serviceWorker, 'bypassCondition');
  const decode = extractFunction(serviceWorker, 'bypassUrlFromRule');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`const MAX_BYPASS_REGEX_LENGTH = 1900;\n${helper}\n${decode}\nthis.makeCondition = bypassCondition; this.decodeRule = bypassUrlFromRule;`, sandbox);
  const url = 'https://cdn.example/a*.png?x=1^2&next=|ok';
  const condition = sandbox.makeCondition(url);
  assert.ok(condition.regexFilter, 'special URLs use regex rather than urlFilter');
  assert.equal(condition.isUrlFilterCaseSensitive, true);
  assert.ok(new RegExp(condition.regexFilter).test(url), 'the exact URL matches');
  assert.equal(sandbox.decodeRule({ condition }), url, 'regex bypass survives service-worker restarts');
  assert.equal(new RegExp(condition.regexFilter).test('https://cdn.example/anything.png?x=1^2&next=|ok'), false,
    'wildcards in a failed URL must not widen the bypass');
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.makeCondition('https://cdn.example/a.png?x=1'))),
    { urlFilter: '|https://cdn.example/a.png?x=1|', isUrlFilterCaseSensitive: true });
});


test('fallback retry is not consumed when the DNR bypass update fails', async () => {
  const sources = ['bypassCondition', 'bypassUrlFromRule', 'originalFromProxyUrl', 'addBypass', 'scheduleFallback', 'markFallbackSeen', 'flushFallbacks']
    .map(name => extractFunction(serviceWorker, name));
  const messages = [];
  const installedUpdates = [];
  let timer = null;
  const sandbox = {
    Promise, Number, JSON, Error, Set, Map, RegExp, URL, decodeURIComponent,
    setImmediate,
    chrome: {
      declarativeNetRequest: {
        updateSessionRules: async update => {
          if (sandbox.__dnrFail) throw new Error('DNR update failed');
          if (sandbox.__dnrGate) await new Promise(resolve => { sandbox.__releaseDnr = resolve; });
          installedUpdates.push(update);
        }
      },
      tabs: {
        sendMessage: (...args) => { messages.push(args); return Promise.resolve(); }
      }
    },
    __dnrFail: true,
    __dnrGate: false,
    __releaseDnr: null,
    setTimeout: callback => { timer = callback; return callback; },
    clearTimeout: () => {}
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    const PROXY_REQUEST_TYPES = ["image", "object"];
    const PRIORITY_BYPASS = 4;
    const BYPASS_BASE_ID = 100000;
    const BYPASS_LIMIT = 3000;
    const BYPASS_REGEX_LIMIT = 900;
    const BYPASSABLE_URL_RE = new RegExp("^https?://[\\x21-\\x7e]+$");
    const MAX_BYPASS_REGEX_LENGTH = 1900;
    let bypassRules = new Map();
    let bypassRegexRules = new Set();
    let bypassNextId = BYPASS_BASE_ID;
    let bypassChain = null;
    let configuredProxyOrigin = "https://proxy.example";
    const CONFLICT_PATTERN = "&(?:quality|l|bw|jpeg|max_width)=";
    const PROXY_PARAMETER_RE = new RegExp(CONFLICT_PATTERN);
    function bypassReady() { return Promise.resolve(); }
    ${sources[0]}
    ${sources[1]}
    ${sources[2]}
    ${sources[3]}
    let fallbackSeen = new Set();
    let fallbackPending = new Set();
    let fallbackBatch = new Map();
    let fallbackTimer = null;
    ${sources[4]}
    ${sources[5]}
    ${sources[6]}
    this.api = {
      fail(details) { scheduleFallback(details); },
      flush() {
        const callback = fallbackTimer;
        fallbackTimer = null;
        if (callback) callback();
        return new Promise(resolve => setImmediate(() => setImmediate(resolve)));
      },
      seenCount: () => fallbackSeen.size,
      messageCount: () => messages.length,
      addBypass: (tabId, urls) => addBypass(tabId, urls)
    };
  `, sandbox);
  sandbox.api.messageCount = () => messages.length;

  const original = 'https://cdn.example/fallback.png';
  const proxyUrl = 'https://proxy.example/api?url=' + encodeURIComponent(original);
  sandbox.api.fail({ url: proxyUrl, tabId: 7, frameId: 0 });
  await sandbox.api.flush();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sandbox.api.messageCount(), 0, 'failed DNR update must not ask the page to retry');
  assert.equal(sandbox.api.seenCount(), 0, 'failed DNR update must not consume the retry');

  sandbox.__dnrFail = false;
  sandbox.api.fail({ url: proxyUrl, tabId: 7, frameId: 0 });
  const secondOriginal = 'https://cdn.example/frame-two.png';
  const secondProxy = 'https://proxy.example/api?url=' + encodeURIComponent(secondOriginal);
  sandbox.api.fail({ url: secondProxy, tabId: 7, frameId: 4 });
  await sandbox.api.flush();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sandbox.api.seenCount(), 2, 'successful DNR update consumes each retry once');
  assert.equal(sandbox.api.messageCount(), 1, 'same-tab failures from different frames are batched');
  assert.equal(messages[0].length, 2, 'retry notification is broadcast to all frames, not frame-scoped');
  assert.equal(messages[0][0], 7);
  assert.equal(messages[0][1].items.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(installedUpdates[0].addRules[0].condition.tabIds)), [7],
    'bypass rule is limited to the failing tab');

  // Keep one DNR operation in flight while the same URL fails again. A second
  // flush must not send a duplicate retry after it observes the installed rule.
  const overlappingOriginal = 'https://cdn.example/overlapping.png';
  const overlappingProxy = 'https://proxy.example/api?url=' + encodeURIComponent(overlappingOriginal);
  sandbox.__dnrGate = true;
  sandbox.api.fail({ url: overlappingProxy, tabId: 7, frameId: 0 });
  const firstFlush = sandbox.api.flush();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof sandbox.__releaseDnr, 'function', 'first bypass update is held in flight');
  sandbox.api.fail({ url: overlappingProxy, tabId: 7, frameId: 2 });
  await sandbox.api.flush();
  sandbox.__dnrGate = false;
  sandbox.__releaseDnr();
  await firstFlush;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sandbox.api.messageCount(), 2, 'an overlapping failure emits only one retry message');
  assert.equal(sandbox.api.seenCount(), 3, 'the overlapping URL is consumed exactly once');

  const updatesBeforeUnknownTab = installedUpdates.length;
  const seenBeforeUnknownTab = sandbox.api.seenCount();
  const messagesBeforeUnknownTab = sandbox.api.messageCount();
  const unknownOriginal = 'https://cdn.example/no-tab.png';
  await sandbox.api.addBypass(-1, [unknownOriginal]);
  sandbox.api.fail({ url: 'https://proxy.example/api?url=' + encodeURIComponent(unknownOriginal), tabId: -1, frameId: 0 });
  await sandbox.api.flush();
  assert.equal(installedUpdates.length, updatesBeforeUnknownTab, 'unknown tab must never install a global DNR allow rule');
  assert.equal(sandbox.api.seenCount(), seenBeforeUnknownTab, 'unknown-tab failure is not consumed as a successful retry');
  assert.equal(sandbox.api.messageCount(), messagesBeforeUnknownTab, 'unknown-tab failure is not sent to a page');
});

test('closing a tab removes queued fallback work without cancelling other tabs', () => {
  const clearedTimers = [];
  const sandbox = { clearTimeout: id => clearedTimers.push(id) };
  vm.createContext(sandbox);
  vm.runInContext(`
    const fallbackSeen = new Set([
      '7 https://cdn.example/old.png',
      '8 https://cdn.example/keep.png'
    ]);
    const fallbackPending = new Set([
      '7 https://cdn.example/queued.png',
      '8 https://cdn.example/keep.png'
    ]);
    const fallbackBatch = new Map([
      [7, { tabId: 7, items: new Map([['https://cdn.example/queued.png', 'proxy7']]) }],
      [8, { tabId: 8, items: new Map([['https://cdn.example/keep.png', 'proxy8']]) }]
    ]);
    let fallbackTimer = 123;
    ${extractFunction(serviceWorker, 'clearQueuedFallbacks')}
    this.clearQueuedFallbacks = clearQueuedFallbacks;
    this.snapshot = () => ({
      seen: Array.from(fallbackSeen),
      pending: Array.from(fallbackPending),
      batchTabs: Array.from(fallbackBatch.keys()),
      timer: fallbackTimer
    });
  `, sandbox);

  sandbox.clearQueuedFallbacks(7);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.snapshot())), {
    seen: ['8 https://cdn.example/keep.png'],
    pending: ['8 https://cdn.example/keep.png'],
    batchTabs: [8],
    timer: 123
  }, 'closing one tab drops only its retry state and preserves the shared timer');
  assert.deepEqual(clearedTimers, [], 'the shared timer stays active while another tab has queued work');

  sandbox.clearQueuedFallbacks(8);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.snapshot())), {
    seen: [], pending: [], batchTabs: [], timer: null
  }, 'closing the final queued tab empties all retry state');
  assert.deepEqual(clearedTimers, [123], 'the timer is cancelled when no queued batches remain');
});

test('runtime-state storage writes stay ordered when publications overlap', async () => {
  const reads = [];
  const writes = [];
  const sandbox = {
    Promise,
    chrome: { storage: { local: {
      get: (_defaults, callback) => reads.push(callback),
      set: (value, callback) => writes.push({ value, callback })
    } } }
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    let lastRuntime = null;
    let runtimePublishRevision = 0;
    let runtimeWriteQueue = Promise.resolve();
    ${extractFunction(serviceWorker, 'publishRuntime')}
    this.api = { publishRuntime };
  `, sandbox);

  const first = { redirect: true, suspended: false };
  const latest = { redirect: false, suspended: true };
  sandbox.api.publishRuntime(first);
  sandbox.api.publishRuntime(latest);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 1, 'the first queued read starts before the newer one');
  reads[0]({ bhRuntime: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 2, 'the newer publication is processed after the stale read');
  reads[1]({ bhRuntime: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 1, 'the stale revision is never written');
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].value)), { bhRuntime: latest });
  writes[0].callback();

  const next = { redirect: true, suspended: true };
  const final = { redirect: false, suspended: false };
  sandbox.api.publishRuntime(next);
  await new Promise(resolve => setImmediate(resolve));
  reads[2]({ bhRuntime: latest });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 2, 'the next state write is held open');
  sandbox.api.publishRuntime(final);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 3, 'later publications wait for the outstanding write');
  writes[1].callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 4, 'the final state is read only after the previous write completes');
  reads[3]({ bhRuntime: next });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[2].value)), { bhRuntime: final });
  writes[2].callback();
});

test('service worker waits for startup recovery, serializes concurrent stats resets, and preserves later activity', () => {
  const helpers = ['finishStatsResetIfReady', 'resetStatsCounters'].map(name => extractFunction(serviceWorker, name)).join('\n');
  const writes = [];
  const sandbox = { clearTimeout: () => {}, writes, chrome: {
    runtime: { lastError: null },
    storage: { local: { set: (value, callback) => writes.push({ value, callback }) } }
  } };
  vm.createContext(sandbox);
  vm.runInContext(`
    const ZERO_STATS = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
    let pendingStats = { ...ZERO_STATS };
    let statsFlushTimer = null, statsMirrorTimer = null;
    let statsFlushInProgress = false, statsMirrorWriteInProgress = false;
    let statsStartupWriteInProgress = true;
    let statsResetPending = false, statsResetInProgress = false;
    const statsResetResponders = [];
    let mirrored = 0, flushed = 0;
    const hasPendingStats = () => !!(pendingStats.filesProcessed || pendingStats.bytesProcessed || pendingStats.bytesSaved);
    const mirrorPendingStats = () => { mirrored++; };
    const scheduleStatsFlush = () => { flushed++; };
    ${helpers}
    this.api = { resetStatsCounters, startupDone: () => { statsStartupWriteInProgress = false; finishStatsResetIfReady(); }, addActivity: () => { pendingStats.filesProcessed++; }, state: () => ({
      pendingStats: { ...pendingStats }, statsResetPending, statsResetInProgress, responders: statsResetResponders.length, mirrored, flushed
    }) };
  `, sandbox);

  const responses = [];
  sandbox.api.resetStatsCounters(response => responses.push(['first', response]));
  assert.equal(sandbox.writes.length, 0, 'reset waits for startup recovery');
  sandbox.api.startupDone();
  assert.equal(sandbox.writes.length, 1, 'first reset begins after startup recovery');
  sandbox.api.resetStatsCounters(response => responses.push(['second', response]));
  assert.equal(sandbox.writes.length, 1, 'second reset waits for the first write');
  sandbox.api.addActivity();

  sandbox.writes[0].callback();
  assert.equal(sandbox.writes.length, 2, 'second reset starts after first callback');
  assert.deepEqual(responses, [], 'waiters are not acknowledged before the last reset commits');
  sandbox.writes[1].callback();
  assert.deepEqual(JSON.parse(JSON.stringify(responses)), [['first', { ok: true }], ['second', { ok: true }]]);
  const state = sandbox.api.state();
  assert.equal(state.pendingStats.filesProcessed, 1, 'activity after reset request is retained');
  assert.equal(state.mirrored, 1, 'new activity is mirrored after the reset');
  assert.equal(state.flushed, 1, 'new activity is flushed after the reset');
});

test('service worker gates stats mirrors and flushes until startup recovery finishes', () => {
  const helpers = ['flushStats', 'scheduleStatsFlush', 'mirrorPendingStats', 'finishStatsStartup']
    .map(name => extractFunction(serviceWorker, name)).join('\n');
  const scheduled = [];
  const writes = [];
  let reads = 0;
  const sandbox = {
    setTimeout: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; },
    clearTimeout: () => {},
    chrome: { storage: { local: {
      get: () => { reads++; },
      set: value => { writes.push(value); }
    } } }
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    const ZERO_STATS = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
    let pendingStats = { filesProcessed: 1, bytesProcessed: 128, bytesSaved: 64 };
    let statsFlushTimer = null, statsMirrorTimer = null;
    let statsFlushInProgress = false, statsMirrorWriteInProgress = false;
    let statsStartupWriteInProgress = true;
    let statsResetPending = false, statsResetInProgress = false;
    const hasPendingStats = () => !!(pendingStats.filesProcessed || pendingStats.bytesProcessed || pendingStats.bytesSaved);
    ${helpers}
    this.api = { begin: () => { mirrorPendingStats(); flushStats(); }, finish: finishStatsStartup };
  `, sandbox);

  sandbox.api.begin();
  assert.equal(scheduled.length, 0, 'startup recovery should defer timers and writes');
  assert.equal(reads, 0, 'flush must not read stale totals during recovery');
  assert.equal(writes.length, 0, 'mirror must not overwrite the recovery snapshot');
  sandbox.api.finish();
  assert.deepEqual(scheduled.map(item => item.delay).sort((a, b) => a - b), [750, 1000],
    'pending activity is mirrored and scheduled for a normal flush after startup');
});

test('service worker publishes the actual runtime after every DNR update is rejected', async () => {
  const runScenario = async ({ failures, currentRules, inspectFails = false }) => {
    const published = [];
    let updateCount = 0;
    let finished = 0;
    const chrome = {
      runtime: { lastError: null },
      declarativeNetRequest: {
        updateDynamicRules(_update, callback) {
          updateCount++;
          setImmediate(() => {
            chrome.runtime.lastError = updateCount <= failures ? { message: 'update rejected' } : null;
            callback();
            chrome.runtime.lastError = null;
          });
        },
        getDynamicRules(callback) {
          setImmediate(() => {
            chrome.runtime.lastError = inspectFails ? { message: 'read rejected' } : null;
            callback(currentRules);
            chrome.runtime.lastError = null;
          });
        }
      },
      storage: { sync: { get(_defaults, callback) { callback({ enabled: true, proxyBase: 'https://proxy.example' }); } } }
    };
    const sandbox = {
      chrome, RULE_ID_REDIRECT_IMAGE: 10, ALL_RULE_IDS: [1, 2, 10], DEFAULTS: {}, setImmediate,
      readSuspended(callback) { callback(false); },
      buildRules(_opts, _noHeaderMatch, suspended) { return suspended ? [{ id: 2 }] : [{ id: 10 }]; },
      publishRuntime(value) { published.push(value); }
    };
    vm.createContext(sandbox);
    vm.runInContext(`${extractFunction(serviceWorker, 'doRefreshRules')}\nthis.run = doRefreshRules;`, sandbox);
    await new Promise(resolve => sandbox.run(() => { finished++; resolve(); }));
    return { published, updateCount, finished };
  };

  const retainedRedirect = await runScenario({ failures: 3, currentRules: [{ id: 10 }] });
  assert.deepEqual(JSON.parse(JSON.stringify(retainedRedirect.published)), [{ redirect: true, suspended: false }],
    'a rejected update must not tell content scripts that the retained redirect disappeared');
  assert.equal(retainedRedirect.updateCount, 3);
  assert.equal(retainedRedirect.finished, 1);

  const noRedirect = await runScenario({ failures: 3, currentRules: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(noRedirect.published)), [{ redirect: false, suspended: false }],
    'when no redirect rule exists, the DOM fallback may safely take ownership');

  const headerOnlyAccepted = await runScenario({ failures: 2, currentRules: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(headerOnlyAccepted.published)), [{ redirect: false, suspended: false }],
    'a successfully installed header-only fallback leaves DOM interception available');

  const inspectionFailed = await runScenario({ failures: 3, currentRules: [{ id: 10 }], inspectFails: true });
  assert.deepEqual(inspectionFailed.published, [], 'failed inspection preserves the last known runtime instead of inventing one');
  assert.equal(inspectionFailed.finished, 1, 'all error paths release the refresh lock');
});

test('service worker activates DOM fallback when the DNR API is unavailable', () => {
  const published = [];
  let finished = 0;
  const sandbox = {
    chrome: {},
    readSuspended(callback) { callback(true); },
    publishRuntime(value) { published.push(value); }
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction(serviceWorker, 'doRefreshRules')}\nthis.run = doRefreshRules;`, sandbox);
  sandbox.run(() => { finished++; });
  assert.deepEqual(JSON.parse(JSON.stringify(published)), [{ redirect: false, suspended: true }]);
  assert.equal(finished, 1, 'missing DNR API still releases the refresh lifecycle');
});

test('architecture markers: network redirect is the primary layer, DOM layers defer to it', () => {
  assert.match(serviceWorker, /type: "redirect", redirect: \{ regexSubstitution: substitution \}/);
  assert.match(serviceWorker, /RULE_ID_ALLOW_PROXY/);
  assert.match(serviceWorker, /updateSessionRules/);
  assert.match(serviceWorker, /header: "content-security-policy", values:/, 'HeaderInfo uses `header`, not `name`');
  assert.match(prehook, /const domHandles = absolute => !redirectLive \|\| CONFLICT_RE\.test\(absolute\)/);
  assert.match(content, /runtime\.redirect !== false && !CONFLICT_RE\.test\(absolute\)/);
  assert.match(prehook, /function retryFailed\(/);
  assert.ok(prehook.includes('/\\burl\\(/i.test(style)'),
    'inline-style fallback retry is case-insensitive');
});

test('late failed-list responses merge into content state and republish to prehook', () => {
  assert.match(content, /for \(const url of res\.urls\) if \(typeof url === "string"\) failedUrls\.add\(stripHash\(url\)\)/);
  assert.match(content, /if \(opts\) publishPrehookSettings\(opts\)/);
  assert.doesNotMatch(content, /failedUrls = new Set\(res\.urls/);
  assert.match(prehook, /el\.getAttribute\(PENDING_ORIGINAL_ATTR\) !== token/);
  assert.match(content, /el\.getAttribute\(PENDING_ORIGINAL_ATTR\) !== token/);
  assert.match(prehook, /bh-image-rearmed/);
  assert.match(content, /document\.addEventListener\(FALLBACK_REARM_EVENT, onFallbackRearm, true\)/);
  assert.match(prehook, /fallbackTimers\.get\(el\) !== timer/);
  assert.match(content, /fallbackTimers\.get\(el\) !== timer/);
  assert.doesNotMatch(prehook, /setAttribute\(FAILED_ATTR \+ "-style"/,
    'style fallback must not permanently blacklist its entire element');
});

test('prehook excludes domains with the same tokenizer as the other layers (any whitespace, commas, URLs)', () => {
  const h = createDomHarness();
  // Non-breaking space / tab / comma separators, a URL-shaped entry and a trailing dot.
  h.publishSettings({ redirect: false, excludeDomains: 'a.example\u00a0b.example,\tc.example\nhttps://d.example/path e.example.' });
  for (const host of ['a.example', 'b.example', 'c.example', 'd.example', 'sub.e.example']) {
    const img = new h.HTMLImageElement();
    const url = `https://${host}/x.png`;
    img.src = url;
    assert.equal(img.getAttribute('src'), url, `${host} must stay direct`);
  }
  const other = new h.HTMLImageElement();
  other.src = 'https://f.example/x.png';
  assertProxied(other.getAttribute('src'), 'https://f.example/x.png');
});

test('proxy bases cannot predefine the reserved url query parameter', () => {
  const sb = { URL };
  vm.createContext(sb);
  vm.runInContext(['usableProxyBase', 'setProxyOrigin'].map(n => extractFunction(serviceWorker, n)).join('\n') +
    '\nvar configuredProxyOrigin = "";\nthis.set = v => { setProxyOrigin(v); return configuredProxyOrigin; };', sb);
  assert.equal(sb.set('https://proxy.example/convert?token=abc'), 'https://proxy.example');
  assert.equal(sb.set('https://proxy.example/convert?url=stale'), '');
  assert.equal(sb.set('https://proxy.example/convert?token=abc&url=stale'), '');

  const h = createDomHarness();
  h.publishSettings({ redirect: false, proxyBase: 'https://proxy.example/convert?url=stale' });
  const img = new h.HTMLImageElement();
  const original = 'https://cdn.example/image.png';
  img.src = original;
  assert.equal(img.getAttribute('src'), original, 'DOM fallback must not build an ambiguous proxy URL');

  const contentSandbox = {
    URL,
    opts: { proxyBase: 'https://proxy.example/convert?url=stale', quality: 60, maxWidth: 768, grayscale: false },
    proxyConfig: null, proxyOrigin: '', proxyHost: ''
  };
  vm.createContext(contentSandbox);
  vm.runInContext(`${extractFunction(content, 'updateProxyConfig')}\nthis.apply = updateProxyConfig;`, contentSandbox);
  contentSandbox.apply(contentSandbox.opts);
  assert.equal(contentSandbox.proxyConfig.base, '', 'isolated-world fallback uses the same validation');

  const optionsSandbox = { URL };
  vm.createContext(optionsSandbox);
  vm.runInContext(`${extractFunction(fs.readFileSync(path.join(ROOT, 'options.js'), 'utf8'), 'isValidProxyBase')}\nthis.validate = isValidProxyBase;`, optionsSandbox);
  assert.equal(optionsSandbox.validate('https://proxy.example/convert?token=abc'), true);
  assert.equal(optionsSandbox.validate('https://proxy.example/convert?url=stale'), false);
});

test('service worker only derives a proxy origin from http(s) proxy URLs', () => {
  const sb = { URL };
  vm.createContext(sb);
  vm.runInContext(['usableProxyBase', 'setProxyOrigin'].map(n => extractFunction(serviceWorker, n)).join('\n') +
    '\nvar configuredProxyOrigin = "";\nthis.set = v => { setProxyOrigin(v); return configuredProxyOrigin; };', sb);
  assert.equal(sb.set('https://proxy.example/convert?k=1#frag'), 'https://proxy.example');
  assert.equal(sb.set('http://localhost:3000/api'), 'http://localhost:3000');
  for (const bad of ['', '   ', 'not a url', 'ftp://proxy.example/x', 'javascript:alert(1)', 'data:text/plain,hi', 'https://proxy.example/convert?url=stale']) {
    assert.equal(sb.set(bad), '', `${JSON.stringify(bad)} must not produce an origin`);
  }
});

test('service worker reads proxy stats headers case-insensitively from one pass', () => {
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(['headerMap', 'headerInt', 'getProxyResponseStats'].map(n => extractFunction(serviceWorker, n)).join('\n') +
    '\nthis.stats = (h) => getProxyResponseStats(headerMap(h));', sb);
  const run = headers => JSON.parse(JSON.stringify(sb.stats(headers)));
  assert.deepEqual(run([{ name: 'X-BH-Compressed-Size', value: '100' }, { name: 'X-BH-Original-Size', value: '300' }]), { received: 100, saved: 200 });
  assert.deepEqual(run([{ name: 'x-bh-original-size', value: '300' }, { name: 'x-bh-bytes-saved', value: '120' }]), { received: 180, saved: 120 });
  assert.deepEqual(run([{ name: 'Content-Length', value: '42' }]), { received: 42, saved: 0 });
  assert.deepEqual(run([{ name: 'x-bh-compressed-size', value: 'junk' }, { name: 'content-length', value: '7' }]), { received: 7, saved: 0 });
  assert.deepEqual(run(undefined), { received: 0, saved: 0 });
});

test('conflict detection matches DNR casing and srcset restore normalizes proxy host', () => {
  const grabConflict = source => {
    const m = /const CONFLICT_RE = \/([^/]+)\/([a-z]*);/.exec(source);
    assert.ok(m, 'CONFLICT_RE declaration present');
    return { source: m[1], flags: m[2], re: new RegExp(m[1], m[2]) };
  };
  for (const source of [prehook, content]) {
    const conflict = grabConflict(source);
    assert.ok(conflict.flags.includes('i'), 'DOM conflict regex is case-insensitive like DNR regexFilter');
    for (const parameter of ['quality', 'l', 'bw', 'jpeg', 'max_width']) {
      assert.ok(
        conflict.re.test(`https://cdn.example/image.jpg?x=1&${parameter.toUpperCase()}=50`),
        `${parameter} conflict is detected case-insensitively`
      );
    }
  }

  const uppercaseProxy = new URL('https://PROXY.example:8443/convert');
  assert.equal(uppercaseProxy.host.toLowerCase(), 'proxy.example:8443');
  assert.match(
    content,
    /proxyHost = parsed \? parsed\.host\.toLowerCase\(\) : "";\n/,
    'content.js normalizes proxy host casing before srcset restore matching'
  );
});



test('HTTP errors use per-image fallback but do not count as connection failures', () => {
  const calls = [];
  const sandbox = {
    isGuardianProxyUrl(url) { return String(url).startsWith('https://proxy.example/'); },
    headerMap(headers) {
      return new Map((headers || []).map(header => [String(header.name).toLowerCase(), header.value]));
    },
    noteGlobalProxyFailure() { calls.push('breaker'); },
    noteProxyResponse() { calls.push('response'); },
    scheduleFallback(details) { calls.push(`fallback:${details.statusCode}`); },
    IMAGE_CONTENT_TYPES: new Set(['image/jpeg']),
    getProxyResponseStats() { return { received: 100, saved: 20 }; },
    recordStats() { calls.push('stats'); }
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction(serviceWorker, 'handleProxyCompleted')}\nthis.run = handleProxyCompleted;`, sandbox);

  for (const statusCode of [403, 429, 503, 520, 530]) {
    calls.length = 0;
    sandbox.run({
      url: 'https://proxy.example/convert?url=https://origin.example/photo.jpg',
      statusCode,
      responseHeaders: [{ name: 'content-type', value: 'text/html' }]
    });
    assert.deepEqual(calls, ['response', `fallback:${statusCode}`],
      `HTTP ${statusCode} must retry this image directly without opening the connection breaker`);
  }

  calls.length = 0;
  sandbox.run({
    url: 'https://proxy.example/convert?url=https://origin.example/photo.jpg',
    statusCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'text/html' }]
  });
  assert.deepEqual(calls, ['response', 'fallback:200'],
    'a reachable proxy that returns a non-image 2xx confirms connectivity and still retries the image directly');
});

test('an HTTP error response resets earlier connection failures without opening the breaker', () => {
  const constantsStart = serviceWorker.indexOf('const BREAKER_THRESHOLD');
  const constantsEnd = serviceWorker.indexOf('let breakerFailures', constantsStart);
  assert.ok(constantsStart >= 0 && constantsEnd > constantsStart, 'breaker constants exist');
  const constants = serviceWorker.slice(constantsStart, constantsEnd);
  let now = 50_000;
  const stored = {};
  const alarms = [];
  let refreshes = 0;
  const sandbox = {
    Date: { now: () => now },
    chrome: {
      storage: { session: {
        set(value, callback) { Object.assign(stored, value); callback(); }
      } },
      alarms: { create(name, info) { alarms.push({ name, ...info }); } }
    },
    isGuardianProxyUrl(url) { return String(url).startsWith('https://proxy.example/'); },
    headerMap(headers) {
      return new Map((headers || []).map(header => [String(header.name).toLowerCase(), header.value]));
    },
    noteProxyResponse() { breakerFailures = []; },
    scheduleFallback() {},
    IMAGE_CONTENT_TYPES: new Set(['image/jpeg']),
    getProxyResponseStats() { return { received: 100, saved: 20 }; },
    recordStats() {},
    refreshRules() { refreshes++; }
  };
  vm.createContext(sandbox);
  vm.runInContext(`${constants}\nlet breakerFailures = [];\n${extractFunction(serviceWorker, 'noteProxyResponse')}\n${extractFunction(serviceWorker, 'noteGlobalProxyFailure')}\n${extractFunction(serviceWorker, 'handleProxyCompleted')}\nthis.api = { fail: noteGlobalProxyFailure, completed: handleProxyCompleted };`, sandbox);

  sandbox.api.fail();
  now += 1_000;
  sandbox.api.completed({
    url: 'https://proxy.example/convert?url=https://origin.example/photo.jpg',
    statusCode: 503,
    responseHeaders: [{ name: 'content-type', value: 'text/html' }]
  });
  now += 1_000;
  sandbox.api.fail();

  assert.equal(stored.bhSuspendedUntil, undefined,
    'a completed HTTP 503 resets the prior transport failure, so the next failure is only the first');
  assert.deepEqual(alarms, [], 'an HTTP response between transport errors must not trip the breaker');
  assert.equal(refreshes, 0, 'the redirect rules remain active');
});

test('only recognized transport and DNS proxy errors count toward the breaker', () => {
  const calls = [];
  const constantsStart = serviceWorker.indexOf('const IGNORED_NET_ERRORS');
  const constantsEnd = serviceWorker.indexOf('\nfunction onProxyError', constantsStart);
  assert.ok(constantsStart >= 0 && constantsEnd > constantsStart, 'network error classifications exist');
  const constants = serviceWorker.slice(constantsStart, constantsEnd);
  const sandbox = {
    isGuardianProxyUrl(url) { return String(url).startsWith('https://proxy.example/'); },
    noteGlobalProxyFailure() { calls.push('breaker'); },
    scheduleFallback() { calls.push('fallback'); }
  };
  vm.createContext(sandbox);
  vm.runInContext(`${constants}\n${extractFunction(serviceWorker, 'handleProxyError')}\nthis.run = handleProxyError;`, sandbox);
  const url = 'https://proxy.example/convert?url=https://origin.example/photo.jpg';

  const connectionErrors = [
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_CONNECTION_RESET',
    'net::ERR_CONNECTION_REFUSED',
    'net::ERR_CONNECTION_ABORTED',
    'net::ERR_CONNECTION_FAILED',
    'net::ERR_CONNECTION_TIMED_OUT',
    'net::ERR_PROXY_CONNECTION_FAILED',
    'net::ERR_SOCKS_CONNECTION_FAILED',
    'net::ERR_SOCKS_CONNECTION_HOST_UNREACHABLE',
    'net::ERR_NAME_NOT_RESOLVED',
    'net::ERR_NAME_RESOLUTION_FAILED',
    'net::ERR_DNS_TIMED_OUT',
    'net::ERR_DNS_MALFORMED_RESPONSE',
    'net::ERR_DNS_SERVER_FAILED',
    'net::ERR_INTERNET_DISCONNECTED',
    'net::ERR_ADDRESS_UNREACHABLE'
  ];
  for (const error of connectionErrors) {
    calls.length = 0;
    sandbox.run({ url, error });
    assert.deepEqual(calls, ['breaker', 'fallback'], `${error} is a proxy reachability failure`);
  }

  const otherFailures = [
    'net::ERR_BLOCKED_BY_RESPONSE',
    'net::ERR_BLOCKED_BY_ORB',
    'net::ERR_CERT_AUTHORITY_INVALID',
    'net::ERR_PROXY_CERTIFICATE_INVALID',
    'net::ERR_SSL_PROTOCOL_ERROR',
    'net::ERR_BLOCKED_BY_CSP',
    'net::ERR_NETWORK_ACCESS_DENIED',
    'net::ERR_TUNNEL_CONNECTION_FAILED',
    'net::ERR_EMPTY_RESPONSE',
    'net::ERR_TIMED_OUT',
    'net::ERR_FAILED'
  ];
  for (const error of otherFailures) {
    calls.length = 0;
    sandbox.run({ url, error });
    assert.deepEqual(calls, ['fallback'], `${error} must recover the image without opening the global breaker`);
  }

  for (const error of ['net::ERR_ABORTED', 'net::ERR_BLOCKED_BY_CLIENT', 'net::ERR_BLOCKED_BY_ADMINISTRATOR',
    'net::ERR_CACHE_MISS', 'net::ERR_NETWORK_CHANGED']) {
    calls.length = 0;
    sandbox.run({ url, error });
    assert.deepEqual(calls, [], `${error} remains ignored without fallback or breaker accounting`);
  }

  calls.length = 0;
  sandbox.run({ url: 'https://other.example/convert', error: 'net::ERR_CONNECTION_REFUSED' });
  assert.deepEqual(calls, [], 'errors from other origins are ignored');
});

test('service worker opens the breaker after two failures inside 10 seconds and auto-resumes after 40 seconds', () => {
  const constantsStart = serviceWorker.indexOf('const BREAKER_THRESHOLD');
  const constantsEnd = serviceWorker.indexOf('let breakerFailures', constantsStart);
  assert.ok(constantsStart >= 0 && constantsEnd > constantsStart, 'breaker constants exist');
  const constants = serviceWorker.slice(constantsStart, constantsEnd);
  const alarmStart = serviceWorker.indexOf('chrome.alarms?.onAlarm?.addListener');
  const alarmEnd = serviceWorker.indexOf('\n\nfunction readSuspended', alarmStart);
  assert.ok(alarmStart >= 0 && alarmEnd > alarmStart, 'breaker resume alarm listener exists');
  const alarmListener = serviceWorker.slice(alarmStart, alarmEnd);

  let now = 1_000_000;
  const stored = {};
  const alarms = [];
  const removed = [];
  let registeredAlarmListener = null;
  let refreshes = 0;
  const sandbox = {
    Date: { now: () => now },
    chrome: {
      runtime: { lastError: null },
      storage: { session: {
        set(value, callback) { Object.assign(stored, value); callback(); },
        get(_defaults, callback) { callback({ bhSuspendedUntil: stored.bhSuspendedUntil || 0 }); },
        remove(key, callback) { delete stored[key]; removed.push(key); callback(); }
      } },
      alarms: {
        create(name, info) { alarms.push({ name, ...info }); },
        onAlarm: { addListener(callback) { registeredAlarmListener = callback; } }
      }
    },
    refreshRules() { refreshes++; }
  };
  vm.createContext(sandbox);
  vm.runInContext(`${constants}\nlet breakerFailures = [];\n${extractFunction(serviceWorker, 'noteProxyResponse')}\n${extractFunction(serviceWorker, 'noteGlobalProxyFailure')}\n${extractFunction(serviceWorker, 'scheduleBreakerResume')}\n${extractFunction(serviceWorker, 'resumeBreakerIfExpired')}\n${alarmListener}\nthis.api = { fail: noteGlobalProxyFailure, response: noteProxyResponse };`, sandbox);

  sandbox.api.fail();
  assert.equal(Object.keys(stored).length, 0, 'one failure does not open the breaker');

  now += 10_000;
  sandbox.api.fail();
  assert.equal(Object.keys(stored).length, 0, 'failures exactly 10 seconds apart are outside the rolling window');

  sandbox.api.response(); // Any completed HTTP response resets the failure count.
  sandbox.api.fail();
  assert.equal(Object.keys(stored).length, 0, 'one failure after success is insufficient');
  now += 9_999;
  sandbox.api.fail();

  const firstUntil = stored.bhSuspendedUntil;
  const firstAlarm = alarms[0];
  assert.equal(firstUntil, now + 40_000, 'the suspension lasts exactly 40 seconds');
  assert.equal(refreshes, 1, 'opening the breaker immediately removes redirect rules');
  assert.deepEqual(firstAlarm, { name: 'bh-breaker-resume', when: firstUntil + 50 },
    'the automatic resume alarm is scheduled just after the cooldown expires');
  assert.equal(typeof registeredAlarmListener, 'function', 'the service worker registers the resume alarm handler');

  registeredAlarmListener({ name: 'unrelated-alarm' });
  assert.deepEqual(removed, [], 'unrelated alarms do not affect the breaker');

  // Requests already in flight can still fail after the first open transition.
  // A second pair extends the stored deadline while the first alarm is pending.
  now += 30_000;
  sandbox.api.fail();
  now += 5_000;
  sandbox.api.fail();
  const extendedUntil = stored.bhSuspendedUntil;
  assert.equal(extendedUntil, now + 40_000, 'new failures extend the current suspension');
  assert.equal(refreshes, 2, 'the extended suspension also refreshes the redirect rules');

  // Deliver the old alarm at its original deadline. It must reschedule instead
  // of clearing the newer stored deadline and re-enabling redirects early.
  now = firstAlarm.when;
  registeredAlarmListener({ name: 'bh-breaker-resume' });
  assert.equal(stored.bhSuspendedUntil, extendedUntil, 'a stale alarm preserves the newer suspension');
  assert.deepEqual(removed, [], 'a stale alarm never removes the active suspension');
  assert.deepEqual(alarms.at(-1), { name: 'bh-breaker-resume', when: extendedUntil + 50 },
    'a stale alarm is moved to the current expiry');
  assert.equal(refreshes, 2, 'a stale alarm does not reinstall redirect rules');

  now = extendedUntil + 50;
  registeredAlarmListener({ name: 'bh-breaker-resume' });
  assert.deepEqual(removed, ['bhSuspendedUntil'], 'the current alarm clears the expired suspension');
  assert.equal(refreshes, 3, 'clearing suspension reinstalls the normal redirect rules');
});
