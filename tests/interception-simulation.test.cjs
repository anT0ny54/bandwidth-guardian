'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const prehook = fs.readFileSync(path.join(ROOT, 'prehook.js'), 'utf8');
const contentPath = path.join(ROOT, 'content.js');
const content = fs.existsSync(contentPath) ? fs.readFileSync(contentPath, 'utf8') : null;

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
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
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
    URL, setTimeout: () => 1, clearTimeout() {}, console, Math
  };
  vm.createContext(context);
  vm.runInContext(prehook, context, { filename: 'prehook.js' });

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

  return { context, document, documentElement, observers, Element, HTMLImageElement, HTMLSourceElement, HTMLLinkElement, publishSettings, notifyAdded };
}

function assertProxied(url, original) {
  assert.ok(url, `expected a proxy URL for ${original}`);
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://proxy.example');
  assert.equal(parsed.searchParams.get('url'), original);
}

test('prehook and available extension scripts pass Node syntax checks', () => {
  const files = ['prehook.js', 'content.js', 'service-worker.js', 'options.js', 'popup.js', 'defaults.js'];
  for (const file of files) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) continue; // patch ZIP intentionally contains only changed files
    const result = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr || result.stdout}`);
  }
});

test('srcset parser preserves descriptors and commas inside image URLs', () => {
  const sources = [['prehook.js', prehook]];
  if (content) sources.push(['content.js', content]);
  for (const [name, source] of sources) {
    const { fn: parseSrcset } = functionFrom(source, 'parseSrcset');
    const input = 'https://cdn.example/a,w_400,h_300.webp 1x, https://cdn.example/b.jpg?fit=cover,center 2x';
    const actual = parseSrcset(input).map(({ url, desc }) => [url, desc]);
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), [
      ['https://cdn.example/a,w_400,h_300.webp', '1x'],
      ['https://cdn.example/b.jpg?fit=cover,center', '2x']
    ], `${name} parsed srcset incorrectly`);
  }
});

test('prehook property setters, setAttribute, and srcset route URLs through the configured proxy', () => {
  const h = createDomHarness();
  h.publishSettings();
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

test('parser-created images, picture sources, preload links, and 2,005 queued images recover after settings arrive', () => {
  const h = createDomHarness();
  const root = new h.Element('div');
  const allImages = [];
  for (let i = 0; i < 2005; i++) {
    const img = new h.HTMLImageElement();
    img._attrs.set('src', `https://cdn.example/parser/${i}.jpg?width=640`); // parser bypasses JS setters
    root.appendChild(img);
    allImages.push(img);
  }

  const pictureSource = new h.HTMLSourceElement();
  const sourceA = 'https://cdn.example/picture/a.webp';
  const sourceB = 'https://cdn.example/picture/b.webp';
  pictureSource._attrs.set('srcset', `${sourceA} 1x, ${sourceB} 2x`);
  root.appendChild(pictureSource);

  const preload = new h.HTMLLinkElement();
  preload._attrs.set('rel', 'preload');
  preload._attrs.set('as', 'image');
  const preloadUrl = 'https://cdn.example/preload/cover.jpg';
  preload._attrs.set('href', preloadUrl);
  root.appendChild(preload);

  h.notifyAdded(root);
  assert.equal(allImages[0].getAttribute('src'), null, 'parser image URL should be held while options are pending');
  assert.equal(pictureSource.getAttribute('srcset'), null, 'picture source should be held while options are pending');
  assert.equal(preload.getAttribute('href'), null, 'preload href should be held while options are pending');

  h.publishSettings();
  for (let i = 0; i < allImages.length; i++) {
    assertProxied(allImages[i].getAttribute('src'), `https://cdn.example/parser/${i}.jpg?width=640`);
  }
  const rewrittenSources = pictureSource.getAttribute('srcset').split(', ').map(part => part.split(' ')[0]);
  assertProxied(rewrittenSources[0], sourceA);
  assertProxied(rewrittenSources[1], sourceB);
  assertProxied(preload.getAttribute('href'), preloadUrl);
});

test('content script rewrites URLs in inline CSS background-image', { skip: !content }, () => {
  const rewriteBgSource = extractFunction(content, 'rewriteBg');
  const sandbox = {
    doneBg: new WeakSet(), active: true,
    shouldSkip(url) { try { return !/^https?:$/.test(new URL(url).protocol) || new URL(url).origin === 'https://proxy.example'; } catch { return true; } },
    resolveHttp(url) { try { const u = new URL(url, 'https://page.example/'); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } },
    buildProxyUrl(url) { return 'https://proxy.example/convert?url=' + encodeURIComponent(url); }
  };
  vm.createContext(sandbox);
  vm.runInContext(`${rewriteBgSource}\nthis.__rewriteBg = rewriteBg;`, sandbox);
  const el = { style: { backgroundImage: 'linear-gradient(red, blue), url("https://cdn.example/a.jpg?x=1&y=2"), url(https://cdn.example/b.webp)' } };
  sandbox.__rewriteBg(el);
  assert.match(el.style.backgroundImage, /https:\/\/proxy\.example\/convert\?url=/);
  assert.equal((el.style.backgroundImage.match(/https:\/\/proxy\.example\/convert/g) || []).length, 2);
});

test('coverage report documents known boundaries rather than claiming universal interception', () => {
  assert.match(prehook, /processParserImage/);
  assert.match(prehook, /processPreloadLink/);
  assert.match(prehook, /Object\.defineProperty\(imgProto, "src"/);
  assert.match(prehook, /Object\.defineProperty\(imgProto, "srcset"/);
  if (content) {
    assert.match(content, /function rewriteImg\(/);
    assert.match(content, /function rewriteBg\(/);
    assert.match(content, /attributeFilter:\s*\["src",\s*"srcset",\s*"style"\]/);
    assert.doesNotMatch(content, /SVGImageElement|HTMLVideoElement|CSS\.escape\(/);
  }
});
                   
