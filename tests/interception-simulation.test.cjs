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

test('build script permission and README invocation support source archives', () => {
  const buildScript = path.join(ROOT, 'build.sh');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yml'), 'utf8');
  if (process.platform !== 'win32') {
    // Source ZIPs may be extracted inside an unrelated Git worktree and do
    // not necessarily carry a Git index or Unix mode bits. Check the mode only
    // when this project directory is itself the checkout root.
    const gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const checkoutRoot = gitRoot.status === 0 ? path.resolve(gitRoot.stdout.trim()) : '';
    if (checkoutRoot === ROOT) {
      assert.notEqual(fs.statSync(buildScript).mode & 0o111, 0,
        'build.sh remains executable in POSIX checkouts');
    }
  }
  assert.match(readme, /## Build\s+```sh\s+bash \.\/build\.sh\s+```/,
    'the documented command works even when an archive drops executable metadata');
  assert.match(workflow,
    /^  test:[\s\S]*?^      - name: Checkout[\s\S]*?^      - name: Ensure build script is executable\n        run: chmod 755 \.\/build\.sh[\s\S]*?^      - name: Set up Node\.js/m,
    'the test job restores the executable bit after checkout');
  assert.match(workflow,
    /^  build:[\s\S]*?^      - name: Checkout[\s\S]*?^      - name: Ensure build script is executable\n        run: chmod 755 \.\/build\.sh[\s\S]*?^      - name: Read manifest version/m,
    'the build job restores the executable bit after checkout');
});

test('real-browser suite overrides Playwright default that disables extensions', () => {
  const browserSuite = fs.readFileSync(path.join(ROOT, 'tests', 'browser', 'interception.browser.test.cjs'), 'utf8');
  assert.match(browserSuite, /ignoreDefaultArgs:\s*\[\s*['"]--disable-extensions['"]\s*\]/,
    "the persistent context must remove Playwright's default extension-blocking switch");
  assert.match(browserSuite, /--disable-extensions-except=\$\{EXT\}/);
  assert.match(browserSuite, /--load-extension=\$\{EXT\}/);
});

test('content settings storage reads surface callback errors and synchronous throws', () => {
  const callbackError = new Error('local storage unavailable');
  const callbackChrome = {
    runtime: { lastError: callbackError },
    storage: { local: { get(_query, callback) { callback(undefined); } } }
  };
  const callbackHarness = functionFrom(content, 'readStorage', { chrome: callbackChrome });
  let callbackResult;
  callbackHarness.fn('local', { bhOpts: null }, (value, error) => { callbackResult = { value, error }; });
  assert.equal(callbackResult.value, null);
  assert.equal(callbackResult.error, callbackError);

  const thrownError = new Error('storage API unavailable');
  const throwingChrome = {
    runtime: { lastError: null },
    storage: { sync: { get() { throw thrownError; } } }
  };
  const throwingHarness = functionFrom(content, 'readStorage', { chrome: throwingChrome });
  let thrownResult;
  throwingHarness.fn('sync', {}, (value, error) => { thrownResult = { value, error }; });
  assert.equal(thrownResult.value, null);
  assert.equal(thrownResult.error, thrownError);

  const successChrome = {
    runtime: { lastError: null },
    storage: { local: { get(_query, callback) { callback({ bhOpts: { enabled: true } }); } } }
  };
  const successHarness = functionFrom(content, 'readStorage', { chrome: successChrome });
  let successResult;
  successHarness.fn('local', {}, (value, error) => { successResult = { value, error }; });
  assert.deepEqual(JSON.parse(JSON.stringify(successResult.value)), { bhOpts: { enabled: true } });
  assert.equal(successResult.error, null);
});

test('content sync changes during startup use guarded reads and normalized settings', () => {
  const defaults = {
    enabled: true, saveData: true, proxyBase: '', quality: 60,
    grayscale: true, maxWidth: 768, excludeDomains: ''
  };
  const makeHarness = get => {
    const applied = [];
    const runtime = { lastError: null };
    const sandbox = {
      DEFAULTS: defaults,
      destroyed: false,
      opts: null,
      settingsRevision: 0,
      runtimeRevision: 0,
      pendingSettingsReadRevision: -1,
      runtime: { redirect: true, suspended: false },
      chrome: { runtime, storage: { sync: { get: (query, callback) => get(query, callback, runtime) } } },
      sameOpts: (a, b) => !!a && !!b && Object.keys(defaults).every(key => a[key] === b[key]),
      applyOpts: value => { applied.push(value); sandbox.opts = value; }
    };
    vm.createContext(sandbox);
    vm.runInContext(
      `${extractFunction(content, 'readStorage')}\n${extractFunction(content, 'readCurrentSyncSettings')}\n${extractFunction(content, 'onStorageChanged')}\nthis.run = onStorageChanged;`,
      sandbox
    );
    sandbox.run({ proxyBase: { newValue: 'https://proxy.example/convert' } }, 'sync');
    return { sandbox, applied };
  };

  const valid = makeHarness((_query, callback) => callback({ proxyBase: 'https://proxy.example/convert' }));
  assert.equal(valid.applied.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(valid.applied[0])), {
    ...defaults, proxyBase: 'https://proxy.example/convert'
  }, 'partial storage results are normalized with the shared defaults');

  const callbackFailure = makeHarness((_query, callback, runtime) => {
    runtime.lastError = new Error('sync storage unavailable');
    callback(undefined);
  });
  assert.equal(callbackFailure.applied.length, 1,
    'a failed cold-start callback applies only the safe disabled fallback');
  assert.equal(callbackFailure.applied[0].enabled, false);
  assert.equal(callbackFailure.applied[0].proxyBase, '');

  const throwFailure = makeHarness(() => { throw new Error('sync storage API unavailable'); });
  assert.equal(throwFailure.applied.length, 1,
    'a synchronous cold-start API throw applies only the safe disabled fallback');
  assert.equal(throwFailure.applied[0].enabled, false);
  assert.equal(throwFailure.applied[0].proxyBase, '');
});

test('options restores shared boolean defaults when sync settings are removed', () => {
  const defaults = {
    enabled: true, grayscale: true, saveData: true, proxyBase: '',
    quality: 60, maxWidth: 768, excludeDomains: ''
  };
  const settingsRevision = Object.create(null);
  const sandbox = {
    DEFAULTS: defaults,
    settingsRevision,
    latestSyncSettings: { ...defaults, enabled: false, grayscale: false, saveData: false },
    markSettingsRevision(key) { settingsRevision[key] = (settingsRevision[key] || 0) + 1; },
    enabledEl: { checked: false },
    grayscaleEl: { checked: false },
    saveDataEl: { checked: false },
    dirty: { proxyBase: false, excludeDomains: false, quality: false, width: false }
  };
  const apply = functionFrom(optionsSource, 'applySyncSettingsChanges', sandbox);
  apply.fn({
    enabled: { oldValue: false, newValue: undefined },
    grayscale: { oldValue: false, newValue: undefined },
    saveData: { oldValue: false, newValue: undefined }
  });

  assert.equal(sandbox.enabledEl.checked, true, 'removed enabled key falls back to the shared true default');
  assert.equal(sandbox.grayscaleEl.checked, true, 'removed grayscale key falls back to the shared true default');
  assert.equal(sandbox.saveDataEl.checked, true, 'removed saveData key falls back to the shared true default');
  for (const key of ['enabled', 'grayscale', 'saveData']) {
    assert.equal(sandbox.latestSyncSettings[key], true);
    assert.equal(settingsRevision[key], 1);
  }
});

test('late startup snapshots cannot overwrite newer sync or runtime settings', () => {
  const defaults = {
    enabled: true, saveData: true, proxyBase: '', quality: 60,
    grayscale: true, maxWidth: 768, excludeDomains: ''
  };
  const reads = [];
  const writes = [];
  const applied = [];
  const sandbox = {
    DEFAULTS: defaults,
    destroyed: false,
    opts: null,
    settingsRevision: 0,
    runtimeRevision: 0,
    pendingSettingsReadRevision: -1,
    runtime: { redirect: true, suspended: false },
    readStorage(_area, _query, callback) { reads.push(callback); },
    chrome: {
      runtime: { lastError: null },
      storage: { local: { set(value, callback) { writes.push(value); callback(); } } }
    },
    sameOpts: (a, b) => !!a && !!b && Object.keys(defaults).every(key => a[key] === b[key]),
    applyOpts: value => { applied.push(value); sandbox.opts = value; }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${extractFunction(content, 'readCurrentSyncSettings')}\n${extractFunction(content, 'applyInitialStorage')}\n${extractFunction(content, 'onStorageChanged')}\nthis.loadInitial = applyInitialStorage; this.changed = onStorageChanged;`,
    sandbox
  );

  const staleLocal = {
    bhOpts: { ...defaults, proxyBase: 'https://old-proxy.example/convert' },
    bhRuntime: { redirect: true, suspended: false }
  };
  sandbox.changed({ proxyBase: { newValue: 'https://intermediate-proxy.example/convert' } }, 'sync');
  sandbox.changed({ proxyBase: { newValue: 'https://new-proxy.example/convert' } }, 'sync');
  assert.equal(reads.length, 2, 'each newer sync revision gets one read');
  // The old local snapshot returns while the newest sync read is pending.
  sandbox.loadInitial(staleLocal, 0, 0);
  assert.equal(reads.length, 2, 'the startup path coalesces with the newest in-flight read');
  reads[0]({ proxyBase: 'https://intermediate-proxy.example/convert' });
  assert.equal(sandbox.opts, null, 'an obsolete sync callback is ignored');
  reads[1]({ proxyBase: 'https://new-proxy.example/convert' });
  assert.equal(sandbox.opts.proxyBase, 'https://new-proxy.example/convert');
  assert.ok(applied.every(value => value.proxyBase === 'https://new-proxy.example/convert'),
    'no older proxy value is ever applied');

  sandbox.changed({ bhOpts: { newValue: { proxyBase: 'https://local-latest.example/convert' } } }, 'local');
  assert.equal(sandbox.opts.proxyBase, 'https://local-latest.example/convert');
  assert.equal(sandbox.opts.quality, defaults.quality,
    'partial local mirror updates are normalized with the shared defaults');
  sandbox.changed({ bhRuntime: { newValue: { suspended: true } } }, 'local');
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.runtime)), { redirect: true, suspended: true },
    'partial runtime mirror updates are normalized with runtime defaults');
  sandbox.loadInitial(staleLocal, 0, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.runtime)), { redirect: true, suspended: true },
    'a late local snapshot cannot roll runtime state back either');
  assert.equal(sandbox.opts.proxyBase, 'https://local-latest.example/convert',
    'a late local snapshot cannot roll settings back either');
  assert.equal(writes.length, 0, 'content-script cold-start reads never write the worker-owned local mirror');
});


test('popup and options startup snapshots cannot roll newer settings or stats back', async () => {
  const defaults = {
    enabled: true, grayscale: true, saveData: true, proxyBase: '',
    quality: 60, maxWidth: 768, excludeDomains: ''
  };

  let resolvePopupRead;
  const popupState = { ...defaults };
  const popupHarness = functionFrom(popupSource, 'load', {
    DEFAULTS: defaults,
    state: popupState,
    settingsRevision: Object.create(null),
    chrome: { storage: { sync: { get: () => new Promise(resolve => { resolvePopupRead = resolve; }) } } },
    applyUI() {},
    loadSiteUI() {}
  });
  const popupLoad = popupHarness.fn();
  popupHarness.sandbox.settingsRevision.proxyBase = 1;
  popupHarness.sandbox.state.proxyBase = 'https://new-proxy.example/convert';
  resolvePopupRead({ ...defaults, proxyBase: 'https://stale-proxy.example/convert' });
  await popupLoad;
  assert.equal(popupHarness.sandbox.state.proxyBase, 'https://new-proxy.example/convert');
  assert.equal(popupHarness.sandbox.state.quality, defaults.quality,
    'the initial snapshot still fills untouched settings');

  let resolveSyncRead;
  let resolveStatsRead;
  const calls = { quality: [], width: [], stats: [] };
  const optionsHarness = functionFrom(optionsSource, 'load', {
    DEFAULTS: defaults,
    settingsRevision: Object.create(null),
    latestSyncSettings: { ...defaults },
    statsRevision: 0,
    dirty: { proxyBase: false, excludeDomains: false, quality: false, width: false },
    enabledEl: { checked: false },
    grayscaleEl: { checked: false },
    saveDataEl: { checked: false },
    proxyBaseEl: { value: '', classList: { remove() {} } },
    excludeEl: { value: '' },
    savedQuality: defaults.quality,
    savedWidth: defaults.maxWidth,
    setQualityUI(value) { calls.quality.push(value); },
    setWidthUI(value) { calls.width.push(value); },
    renderStats(value) { calls.stats.push(value); },
    chrome: { storage: { sync: { get: () => new Promise(resolve => { resolveSyncRead = resolve; }) },
      local: { get: () => new Promise(resolve => { resolveStatsRead = resolve; }) } } }
  });
  const optionsLoad = optionsHarness.fn();
  await Promise.resolve(); // Flush the Promise-wrapped storage calls before resolving mocks.
  const ctx = optionsHarness.sandbox;
  ctx.settingsRevision.proxyBase = 1;
  ctx.dirty.proxyBase = true;
  ctx.proxyBaseEl.value = 'https://new-proxy.example/convert';
  ctx.settingsRevision.quality = 1;
  ctx.dirty.quality = true;
  ctx.statsRevision++;
  calls.stats.push({ filesProcessed: 99 }); // Simulate the newer live event.
  resolveSyncRead({ ...defaults, proxyBase: 'https://stale-proxy.example/convert', quality: 42, maxWidth: 960 });
  resolveStatsRead({ stats: { filesProcessed: 1 } });
  await optionsLoad;
  assert.equal(ctx.proxyBaseEl.value, 'https://new-proxy.example/convert');
  assert.equal(ctx.savedQuality, defaults.quality,
    'an old startup value cannot replace a newer quality baseline');
  assert.deepEqual(calls.width, [960], 'untouched controls still load from the snapshot');
  assert.deepEqual(calls.stats, [{ filesProcessed: 99 }],
    'an old stats read cannot overwrite a newer live stats event');
});

test('options save waits for a successful initial load before writing settings', async () => {
  let resolveInitialLoad;
  let baselineReads = 0;
  const writes = [];
  const toasts = [];
  const defaults = {
    enabled: true, grayscale: true, saveData: true,
    proxyBase: 'https://configured.example/convert', quality: 45,
    maxWidth: 1024, excludeDomains: 'saved.example'
  };
  const harness = functionFrom(optionsSource, 'save', {
    initialLoadPromise: new Promise(resolve => { resolveInitialLoad = resolve; }),
    customQualityEl: { value: '' }, customWidthEl: { value: '' },
    proxyBaseEl: { value: 'https://configured.example/convert', classList: { add() {}, remove() {} }, focus() {} },
    excludeEl: { value: 'saved.example' },
    saveBtn: { disabled: false }, resetAllBtn: { disabled: false },
    saveInProgress: false, resetInProgress: false,
    DEFAULTS: defaults,
    parseCustomWidth: value => /^\d+$/.test(value) ? Number(value) : null,
    isValidProxyBase: () => true,
    readQuality: () => 45, readWidth: () => 1024,
    editRevision: { proxyBase: 0, excludeDomains: 0, quality: 0, width: 0 },
    settingsRevision: Object.create(null), latestSyncSettings: { ...defaults },
    savedQuality: 45, savedWidth: 1024,
    setQualityUI() {}, setWidthUI() {},
    dirty: { proxyBase: false, excludeDomains: false, quality: false, width: false },
    reloadCurrentPage: async () => {},
    showToast(...args) { toasts.push(args); },
    chrome: { storage: { sync: {
      get: async () => { baselineReads++; return { ...defaults }; },
      set: async value => { writes.push(value); }
    } } }
  });

  const saving = harness.fn();
  await Promise.resolve();
  assert.equal(baselineReads, 0, 'the save cannot read/sample the form before startup completes');
  assert.equal(writes.length, 0);
  resolveInitialLoad(true);
  await saving;
  assert.equal(baselineReads, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].proxyBase, defaults.proxyBase);
  assert.equal(writes[0].quality, defaults.quality);
  assert.equal(writes[0].maxWidth, defaults.maxWidth);
  assert.equal(writes[0].excludeDomains, defaults.excludeDomains);

  let attemptedBaselineRead = false;
  const failed = functionFrom(optionsSource, 'save', {
    initialLoadPromise: Promise.resolve(false),
    saveInProgress: false, resetInProgress: false,
    saveBtn: { disabled: false }, resetAllBtn: { disabled: false },
    chrome: { storage: { sync: { get() { attemptedBaselineRead = true; }, set() { throw new Error('must not save'); } } } },
    showToast(...args) { toasts.push(args); }
  });
  await failed.fn();
  assert.equal(attemptedBaselineRead, false, 'failed startup reads block a destructive save');
  assert.deepEqual(toasts.at(-1), ['Could not save because settings failed to load', 'err']);
});

test('options save samples cross-page-updated controls after its async baseline read', async () => {
  const defaults = {
    enabled: true, grayscale: true, saveData: true, proxyBase: '',
    quality: 60, maxWidth: 768, excludeDomains: ''
  };
  let resolveRead;
  const saved = [];
  const customQualityEl = { value: '' };
  const customWidthEl = { value: '' };
  const proxyBaseEl = { value: '', classList: { add() {}, remove() {} }, focus() {} };
  const excludeEl = { value: 'old.example' };
  const harness = functionFrom(optionsSource, 'save', {
    customQualityEl, customWidthEl, proxyBaseEl, excludeEl,
    chrome: { storage: { sync: {
      get: () => new Promise(resolve => { resolveRead = resolve; }),
      set: async value => { saved.push(value); }
    } } },
    DEFAULTS: defaults,
    saveBtn: { disabled: false },
    resetAllBtn: { disabled: false },
    saveInProgress: false,
    resetInProgress: false,
    initialLoadPromise: Promise.resolve(true),
    parseCustomWidth: value => /^\d+$/.test(value) ? Number(value) : null,
    isValidProxyBase: () => true,
    readQuality: () => defaults.quality,
    readWidth: () => defaults.maxWidth,
    reloadCurrentPage: async () => {},
    savedQuality: defaults.quality,
    savedWidth: defaults.maxWidth,
    settingsRevision: Object.create(null),
    latestSyncSettings: { ...defaults },
    setQualityUI() {}, setWidthUI() {},
    dirty: { proxyBase: false, excludeDomains: false, quality: false, width: false },
    editRevision: { proxyBase: 0, excludeDomains: 0, quality: 0, width: 0 },
    showToast() {}
  });
  const savePromise = harness.fn();
  excludeEl.value = 'newer.example';
  await new Promise(resolve => setImmediate(resolve)); // Let the startup-read guard reach the baseline read.
  assert.equal(typeof resolveRead, 'function');
  resolveRead({ ...defaults });
  await savePromise;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].excludeDomains, 'newer.example');
});

test('options save preserves edits made while the storage write is pending', async () => {
  const defaults = {
    enabled: true, grayscale: true, saveData: true, proxyBase: '',
    quality: 60, maxWidth: 768, excludeDomains: ''
  };
  let resolveWrite;
  let signalWriteStarted;
  const writeStarted = new Promise(resolve => { signalWriteStarted = resolve; });
  const saved = [];
  const qualityUi = [];
  const widthUi = [];
  const toasts = [];
  const customQualityEl = { value: '45' };
  const customWidthEl = { value: '' };
  const proxyBaseEl = { value: 'https://first.example/convert', classList: { add() {}, remove() {} }, focus() {} };
  const excludeEl = { value: 'first.example' };
  const dirty = { proxyBase: true, excludeDomains: true, quality: true, width: false };
  const editRevision = { proxyBase: 1, excludeDomains: 1, quality: 1, width: 0 };
  const harness = functionFrom(optionsSource, 'save', {
    customQualityEl, customWidthEl, proxyBaseEl, excludeEl,
    chrome: { storage: { sync: {
      get: async () => ({ ...defaults }),
      set: value => {
        saved.push(value);
        signalWriteStarted();
        return new Promise(resolve => { resolveWrite = resolve; });
      }
    } } },
    DEFAULTS: defaults,
    saveBtn: { disabled: false },
    resetAllBtn: { disabled: false },
    saveInProgress: false,
    resetInProgress: false,
    initialLoadPromise: Promise.resolve(true),
    parseCustomWidth: value => /^\d+$/.test(value) ? Number(value) : null,
    isValidProxyBase: () => true,
    readQuality: () => 45,
    readWidth: () => defaults.maxWidth,
    reloadCurrentPage: async () => {},
    savedQuality: defaults.quality,
    savedWidth: defaults.maxWidth,
    settingsRevision: Object.create(null),
    latestSyncSettings: { ...defaults },
    editRevision,
    setQualityUI(value) { qualityUi.push(value); },
    setWidthUI(value) { widthUi.push(value); },
    dirty,
    showToast(...args) { toasts.push(args); }
  });

  const savePromise = harness.fn();
  await writeStarted;
  assert.equal(saved.length, 1, 'the settings snapshot is submitted before the write resolves');
  assert.equal(saved[0].proxyBase, 'https://first.example/convert');
  assert.equal(saved[0].quality, 45);
  assert.equal(saved[0].excludeDomains, 'first.example');

  // Simulate typing while storage.sync.set() is still pending.
  proxyBaseEl.value = 'https://later.example/convert';
  editRevision.proxyBase++;
  dirty.proxyBase = true;
  excludeEl.value = 'later.example';
  editRevision.excludeDomains++;
  dirty.excludeDomains = true;
  customQualityEl.value = '82';
  editRevision.quality++;
  dirty.quality = true;

  resolveWrite();
  await savePromise;

  assert.equal(proxyBaseEl.value, 'https://later.example/convert',
    'completion of the older write does not replace a newer proxy edit');
  assert.equal(excludeEl.value, 'later.example',
    'completion of the older write does not replace newer exclusions');
  assert.equal(customQualityEl.value, '82',
    'completion of the older write does not reset a newer custom quality');
  assert.equal(dirty.proxyBase, true);
  assert.equal(dirty.excludeDomains, true);
  assert.equal(dirty.quality, true);
  assert.equal(dirty.width, false,
    'fields untouched during the write are marked clean');
  assert.deepEqual(widthUi, [defaults.maxWidth],
    'the unchanged width control is normalized to the committed value');
  assert.deepEqual(qualityUi, [],
    'the newer quality edit is not overwritten by setQualityUI');
  assert.deepEqual(toasts.at(-1), ['Saved; newer edits remain unsaved', 'warn']);
});

test('options save keeps newer cross-page values received while its write is pending', async () => {
  const defaults = {
    enabled: true, grayscale: true, saveData: true, proxyBase: '',
    quality: 60, maxWidth: 768, excludeDomains: ''
  };
  let resolveWrite;
  let signalWriteStarted;
  const writeStarted = new Promise(resolve => { signalWriteStarted = resolve; });
  const writes = [];
  const qualityUi = [];
  const widthUi = [];
  const dirty = { proxyBase: true, excludeDomains: true, quality: true, width: true };
  const editRevision = { proxyBase: 1, excludeDomains: 1, quality: 1, width: 1 };
  const sandbox = {
    DEFAULTS: defaults,
    settingsRevision: Object.create(null),
    latestSyncSettings: { ...defaults },
    markSettingsRevision(key) { sandbox.settingsRevision[key] = (sandbox.settingsRevision[key] || 0) + 1; },
    enabledEl: { checked: true },
    grayscaleEl: { checked: true },
    saveDataEl: { checked: true },
    proxyBaseEl: { value: 'https://submitted.example/convert', classList: { add() {}, remove() {} }, focus() {} },
    excludeEl: { value: 'submitted.example' },
    customQualityEl: { value: '45' },
    customWidthEl: { value: '' },
    saveBtn: { disabled: false },
    resetAllBtn: { disabled: false },
    saveInProgress: false,
    resetInProgress: false,
    initialLoadPromise: Promise.resolve(true),
    parseCustomWidth: value => /^\d+$/.test(value) ? Number(value) : null,
    isValidProxyBase: () => true,
    readQuality: () => 45,
    readWidth: () => defaults.maxWidth,
    editRevision,
    dirty,
    savedQuality: defaults.quality,
    savedWidth: defaults.maxWidth,
    setQualityUI(value) { qualityUi.push(value); sandbox.customQualityEl.value = String(value); },
    setWidthUI(value) { widthUi.push(value); sandbox.customWidthEl.value = String(value); },
    reloadCurrentPage: async () => {},
    showToast() {},
    chrome: { storage: { sync: {
      get: async () => ({ ...defaults }),
      set(value) {
        writes.push(value);
        signalWriteStarted();
        return new Promise(resolve => { resolveWrite = resolve; });
      }
    } } }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${extractFunction(optionsSource, 'save')}\n${extractFunction(optionsSource, 'mergeIncomingSetting')}\n${extractFunction(optionsSource, 'applySyncSettingsChanges')}\n` +
    'this.runSave = save; this.applyChanges = applySyncSettingsChanges;', sandbox
  );

  const saving = sandbox.runSave();
  await writeStarted;
  sandbox.applyChanges({
    proxyBase: { newValue: 'https://external.example/convert' },
    quality: { newValue: 80 },
    maxWidth: { newValue: 1024 },
    excludeDomains: { newValue: 'external.example' }
  }, 'sync');
  resolveWrite();
  await saving;

  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0])), {
    proxyBase: 'https://submitted.example/convert', quality: 45,
    maxWidth: 768, excludeDomains: 'submitted.example'
  }, 'Save submits the values present at its own snapshot');
  assert.equal(sandbox.proxyBaseEl.value, 'https://external.example/convert',
    'a newer cross-page proxy value is not replaced by the older save completion');
  assert.equal(sandbox.excludeEl.value, 'external.example');
  assert.equal(sandbox.savedQuality, 80);
  assert.equal(sandbox.savedWidth, 1024);
  assert.deepEqual(qualityUi, [80]);
  assert.deepEqual(widthUi, [1024]);
  assert.ok(Object.values(dirty).every(value => value === false));
});

test('options save reloads the page when a newer cross-page value wins the pending write', async () => {
  const current = {
    enabled: true, grayscale: true, saveData: true,
    proxyBase: 'https://old.example/convert', quality: 60,
    maxWidth: 768, excludeDomains: 'old.example'
  };
  let resolveWrite;
  let signalWriteStarted;
  const writeStarted = new Promise(resolve => { signalWriteStarted = resolve; });
  let reloads = 0;
  const dirty = { proxyBase: false, excludeDomains: false, quality: false, width: false };
  const sandbox = {
    DEFAULTS: current,
    settingsRevision: Object.create(null),
    latestSyncSettings: { ...current },
    markSettingsRevision(key) { sandbox.settingsRevision[key] = (sandbox.settingsRevision[key] || 0) + 1; },
    customQualityEl: { value: '' }, customWidthEl: { value: '' },
    proxyBaseEl: { value: current.proxyBase, classList: { add() {}, remove() {} }, focus() {} },
    excludeEl: { value: current.excludeDomains },
    saveBtn: { disabled: false }, resetAllBtn: { disabled: false },
    saveInProgress: false, resetInProgress: false,
    initialLoadPromise: Promise.resolve(true),
    parseCustomWidth: value => /^\d+$/.test(value) ? Number(value) : null,
    isValidProxyBase: () => true,
    readQuality: () => current.quality, readWidth: () => current.maxWidth,
    editRevision: { proxyBase: 0, excludeDomains: 0, quality: 0, width: 0 },
    dirty,
    savedQuality: current.quality, savedWidth: current.maxWidth,
    setQualityUI() {}, setWidthUI() {},
    reloadCurrentPage: async () => { reloads++; },
    showToast() {},
    chrome: { storage: { sync: {
      get: async () => ({ ...current }),
      set() {
        signalWriteStarted();
        return new Promise(resolve => { resolveWrite = resolve; });
      }
    } } }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${extractFunction(optionsSource, 'save')}\n${extractFunction(optionsSource, 'mergeIncomingSetting')}\n${extractFunction(optionsSource, 'applySyncSettingsChanges')}\n` +
    'this.runSave = save; this.applyChanges = applySyncSettingsChanges;', sandbox
  );

  const saving = sandbox.runSave();
  await writeStarted;
  sandbox.applyChanges({ proxyBase: { newValue: 'https://new.example/convert' } }, 'sync');
  resolveWrite();
  await saving;

  assert.equal(reloads, 1,
    'a winning cross-page value that differs from the initial baseline requires a page reload');
  assert.equal(sandbox.proxyBaseEl.value, 'https://new.example/convert');
  assert.equal(dirty.proxyBase, false);
});

test('options save serializes submissions and reports storage write failures', async () => {
  const defaults = {
    enabled: true, grayscale: true, saveData: true, proxyBase: '',
    quality: 60, maxWidth: 768, excludeDomains: ''
  };
  let rejectWrite;
  let signalWriteStarted;
  const writeStarted = new Promise(resolve => { signalWriteStarted = resolve; });
  const saved = [];
  const toasts = [];
  const dirty = { proxyBase: true, excludeDomains: false, quality: false, width: false };
  const harness = functionFrom(optionsSource, 'save', {
    customQualityEl: { value: '' },
    customWidthEl: { value: '' },
    proxyBaseEl: { value: 'https://proxy.example/convert', classList: { add() {}, remove() {} }, focus() {} },
    excludeEl: { value: '' },
    saveBtn: { disabled: false },
    resetAllBtn: { disabled: false },
    saveInProgress: false,
    resetInProgress: false,
    initialLoadPromise: Promise.resolve(true),
    chrome: { storage: { sync: {
      get: async () => ({ ...defaults }),
      set: value => {
        saved.push(value);
        signalWriteStarted();
        return new Promise((_resolve, reject) => { rejectWrite = reject; });
      }
    } } },
    DEFAULTS: defaults,
    parseCustomWidth: value => /^\d+$/.test(value) ? Number(value) : null,
    isValidProxyBase: () => true,
    readQuality: () => defaults.quality,
    readWidth: () => defaults.maxWidth,
    reloadCurrentPage: async () => {},
    savedQuality: defaults.quality,
    savedWidth: defaults.maxWidth,
    settingsRevision: Object.create(null),
    latestSyncSettings: { ...defaults },
    editRevision: { proxyBase: 1, excludeDomains: 0, quality: 0, width: 0 },
    setQualityUI() {}, setWidthUI() {},
    dirty,
    showToast(...args) { toasts.push(args); }
  });

  const firstSave = harness.fn();
  await writeStarted;
  await harness.fn(); // A second click/Enter while the first write is pending.
  assert.equal(saved.length, 1, 'only one storage write may be active');
  assert.equal(harness.sandbox.saveBtn.disabled, true);
  rejectWrite(new Error('sync quota exceeded'));
  await firstSave;
  assert.equal(dirty.proxyBase, true,
    'a failed write does not clear the unsaved setting');
  assert.deepEqual(toasts.at(-1), ['Could not save settings', 'err']);
  assert.equal(harness.sandbox.saveBtn.disabled, false,
    'the save control is restored after a failed write');
  assert.equal(harness.sandbox.saveInProgress, false);
});

test('options auto-save writes are serialized and failed writes restore the latest value', async () => {
  let resolveFirst;
  let resolveSecond;
  let signalFirst;
  let signalSecond;
  const firstStarted = new Promise(resolve => { signalFirst = resolve; });
  const secondStarted = new Promise(resolve => { signalSecond = resolve; });
  const writes = [];
  const queueHarness = functionFrom(optionsSource, 'queueAutoSave', {
    pendingAutoSaveWrites: Promise.resolve(),
    chrome: { storage: { sync: { set(value) {
      writes.push(value);
      if (writes.length === 1) { signalFirst(); return new Promise(resolve => { resolveFirst = resolve; }); }
      signalSecond();
      return new Promise(resolve => { resolveSecond = resolve; });
    } } } }
  });

  const first = queueHarness.fn({ enabled: false });
  const second = queueHarness.fn({ grayscale: false });
  await firstStarted;
  assert.deepEqual(writes, [{ enabled: false }], 'the second write waits for the first');
  resolveFirst();
  await secondStarted;
  assert.deepEqual(writes, [{ enabled: false }, { grayscale: false }]);
  resolveSecond();
  await Promise.all([first, second]);

  const toasts = [];
  const element = { checked: false };
  const failureHarness = functionFrom(optionsSource, 'persistAutoSetting', {
    autoSaveRevision: { enabled: 0 },
    markSettingsRevision() {},
    queueAutoSave: async () => { throw new Error('sync quota exceeded'); },
    chrome: { storage: { sync: { get: async () => ({ enabled: true }) } } },
    DEFAULTS: { enabled: true },
    showToast(...args) { toasts.push(args); }
  });
  await failureHarness.fn('enabled', element, () => 'Saved');
  assert.equal(element.checked, true, 'a failed optimistic toggle reverts to the last stored value');
  assert.deepEqual(toasts.at(-1), ['Could not save setting', 'err']);
});

test('options proxy test remains locked while Reset defaults is active', async () => {
  let resolveFetch;
  let fetchCalls = 0;
  const button = { textContent: 'Test', disabled: false };
  const harness = functionFrom(optionsSource, 'testProxy', {
    proxyBaseEl: { value: 'https://proxy.example/convert' },
    isValidProxyBase: () => true,
    testProxyBtn: button,
    testProxyInProgress: false,
    resetInProgress: false,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: () => {
      fetchCalls++;
      return new Promise(resolve => { resolveFetch = resolve; });
    },
    showToast() {}
  });

  const checking = harness.fn();
  assert.equal(button.disabled, true, 'the button is disabled during the proxy request');
  harness.sandbox.resetInProgress = true;
  resolveFetch({ ok: true, status: 200, text: async () => 'bandwidth-hero-proxy' });
  await checking;
  assert.equal(button.disabled, true,
    'the test completion cannot re-enable its button during Reset defaults');
  await harness.fn();
  assert.equal(fetchCalls, 1, 'a second test cannot start while Reset defaults is active');
  harness.sandbox.resetInProgress = false;
  button.disabled = false;
});

test('options reset invalidates a late auto-save recovery read', async () => {
  let resolveRecoveryRead;
  let signalRecoveryRead;
  const recoveryReadStarted = new Promise(resolve => { signalRecoveryRead = resolve; });
  const toasts = [];
  const element = { checked: false };
  const defaults = { enabled: true, grayscale: true, saveData: true };
  const autoSaveRevision = { enabled: 0, grayscale: 0, saveData: 0 };
  const sandbox = {
    element,
    autoSaveRevision,
    queueAutoSave: async () => { throw new Error('write failed'); },
    markSettingsRevision() {},
    DEFAULTS: defaults,
    chrome: { storage: { sync: {
      get: () => {
        signalRecoveryRead();
        return new Promise(resolve => { resolveRecoveryRead = resolve; });
      },
      set: async () => {}
    } } },
    showToast(...args) { toasts.push(args); },
    pendingAutoSaveWrites: Promise.resolve(),
    dirty: { proxyBase: true, excludeDomains: false, quality: false, width: false },
    saveInProgress: false,
    resetInProgress: false,
    saveBtn: { disabled: false },
    resetAllBtn: { disabled: false },
    setSettingsControlsDisabled() {},
    load: async () => { element.checked = true; return true; },
    reloadCurrentPage: async () => {}
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${extractFunction(optionsSource, 'persistAutoSetting')}\n${extractFunction(optionsSource, 'resetAll')}\n` +
    'this.startToggle = () => persistAutoSetting("enabled", element, value => value ? "On" : "Off");\n' +
    'this.reset = resetAll;',
    sandbox
  );

  const failedToggle = sandbox.startToggle();
  await recoveryReadStarted;
  await sandbox.reset();
  assert.equal(element.checked, true, 'the reset refresh installs the defaults');
  resolveRecoveryRead({ enabled: false });
  await failedToggle;
  assert.equal(element.checked, true,
    'a stale failed-toggle recovery read cannot overwrite reset defaults');
  assert.deepEqual(toasts, [['Reset to defaults', 'ok']],
    'the obsolete failed-toggle callback does not show a stale error after reset');
  assert.ok(Object.values(autoSaveRevision).every(value => value > 0));
});

test('options reset is serialized with save and disables edits until defaults are restored', async () => {
  const defaults = {
    enabled: true, grayscale: true, saveData: true, proxyBase: '',
    quality: 60, maxWidth: 768, excludeDomains: ''
  };
  let resolveWrite;
  let resolvePendingAutoSave;
  let signalResetWrite;
  const pendingAutoSaveWrites = new Promise(resolve => { resolvePendingAutoSave = resolve; });
  const resetWriteStarted = new Promise(resolve => { signalResetWrite = resolve; });
  const writes = [];
  const busyStates = [];
  const toasts = [];
  const dirty = { proxyBase: true, excludeDomains: true, quality: true, width: false };
  const settingsRevision = Object.create(null);
  const harness = functionFrom(optionsSource, 'resetAll', {
    DEFAULTS: defaults,
    dirty,
    settingsRevision,
    markSettingsRevision(key) { settingsRevision[key] = (settingsRevision[key] || 0) + 1; },
    autoSaveRevision: { enabled: 0, grayscale: 0, saveData: 0 },
    saveInProgress: false,
    resetInProgress: false,
    pendingAutoSaveWrites,
    saveBtn: { disabled: false },
    resetAllBtn: { disabled: false },
    setSettingsControlsDisabled(value) { busyStates.push(value); },
    chrome: { storage: { sync: { set(value) {
      writes.push(value);
      signalResetWrite();
      return new Promise(resolve => { resolveWrite = resolve; });
    } } } },
    load: async () => true,
    reloadCurrentPage: async () => {},
    showToast(...args) { toasts.push(args); }
  });

  const resetPromise = harness.fn();
  assert.equal(harness.sandbox.resetInProgress, true);
  assert.equal(harness.sandbox.saveBtn.disabled, true);
  assert.equal(harness.sandbox.resetAllBtn.disabled, true);
  assert.deepEqual(busyStates, [true], 'editable controls are frozen during the full reset');
  await harness.fn();
  assert.equal(writes.length, 0, 'reset waits for an auto-save that was already in flight');
  resolvePendingAutoSave();
  await resetWriteStarted;
  assert.equal(writes.length, 1, 'a duplicate reset cannot start another write');

  resolveWrite();
  await resetPromise;
  assert.equal(harness.sandbox.resetInProgress, false);
  assert.equal(harness.sandbox.saveBtn.disabled, false);
  assert.equal(harness.sandbox.resetAllBtn.disabled, false);
  assert.deepEqual(busyStates, [true, false]);
  assert.ok(Object.values(dirty).every(value => value === false));
  assert.deepEqual(toasts.at(-1), ['Reset to defaults', 'ok']);

  let readCalls = 0;
  const saveWhileReset = functionFrom(optionsSource, 'save', {
    saveInProgress: false,
    resetInProgress: true,
    chrome: { storage: { sync: { get() { readCalls++; } } } }
  });
  await saveWhileReset.fn();
  assert.equal(readCalls, 0, 'Save is ignored while Reset defaults is active');
});

test('options reset invalidates a delayed initial settings snapshot', async () => {
  const defaults = {
    enabled: true, grayscale: true, saveData: true, proxyBase: '',
    quality: 60, maxWidth: 768, excludeDomains: ''
  };
  const settingsRevision = Object.create(null);
  let resolveInitialRead;
  const initialRead = new Promise(resolve => { resolveInitialRead = resolve; });
  const elements = {
    enabledEl: { checked: false }, grayscaleEl: { checked: false }, saveDataEl: { checked: false },
    proxyBaseEl: { value: 'old proxy', classList: { remove() {} } },
    excludeEl: { value: 'old.example' }
  };
  const initialLoad = functionFrom(optionsSource, 'load', {
    DEFAULTS: defaults,
    settingsRevision,
    statsRevision: 0,
    chrome: { storage: {
      sync: { get: () => initialRead },
      local: { get: async () => ({ stats: null }) }
    } },
    ...elements,
    dirty: { proxyBase: false, excludeDomains: false, quality: false, width: false },
    savedQuality: defaults.quality,
    savedWidth: defaults.maxWidth,
    setQualityUI() {}, setWidthUI() {}, renderStats() {}, showToast() {}
  });
  const startup = initialLoad.fn();
  const resetHarness = functionFrom(optionsSource, 'resetAll', {
    DEFAULTS: defaults,
    dirty: { proxyBase: true, excludeDomains: true, quality: true, width: true },
    settingsRevision,
    markSettingsRevision(key) { settingsRevision[key] = (settingsRevision[key] || 0) + 1; },
    autoSaveRevision: { enabled: 0, grayscale: 0, saveData: 0 },
    saveInProgress: false, resetInProgress: false,
    pendingAutoSaveWrites: Promise.resolve(),
    saveBtn: { disabled: false }, resetAllBtn: { disabled: false },
    setSettingsControlsDisabled() {},
    chrome: { storage: { sync: { set: async () => {} } } },
    load: async () => {
      elements.enabledEl.checked = true;
      elements.grayscaleEl.checked = true;
      elements.saveDataEl.checked = true;
      elements.proxyBaseEl.value = '';
      elements.excludeEl.value = '';
      return true;
    },
    reloadCurrentPage: async () => {}, showToast() {}
  });

  const reset = resetHarness.fn();
  assert.ok(Object.keys(defaults).every(key => settingsRevision[key] > 0),
    'reset invalidates all startup settings revisions synchronously');
  await reset;
  resolveInitialRead({ ...defaults, enabled: false, proxyBase: 'https://stale.example', excludeDomains: 'stale.example' });
  await startup;
  assert.equal(elements.enabledEl.checked, true, 'the delayed initial read cannot overwrite reset enabled state');
  assert.equal(elements.proxyBaseEl.value, '', 'the delayed initial read cannot restore an old proxy');
  assert.equal(elements.excludeEl.value, '', 'the delayed initial read cannot restore old exclusions');
});

test('options reset reports a failed storage write without clearing edits', async () => {
  const toasts = [];
  const dirty = { proxyBase: true, excludeDomains: true, quality: true, width: false };
  const busyStates = [];
  let refreshedAfterFailure = false;
  const settingsRevision = Object.create(null);
  const harness = functionFrom(optionsSource, 'resetAll', {
    DEFAULTS: { enabled: true },
    dirty,
    settingsRevision,
    markSettingsRevision(key) { settingsRevision[key] = (settingsRevision[key] || 0) + 1; },
    autoSaveRevision: { enabled: 0, grayscale: 0, saveData: 0 },
    saveInProgress: false,
    resetInProgress: false,
    pendingAutoSaveWrites: Promise.resolve(),
    saveBtn: { disabled: false },
    resetAllBtn: { disabled: false },
    setSettingsControlsDisabled(value) { busyStates.push(value); },
    chrome: { storage: { sync: { set: async () => { throw new Error('storage unavailable'); } } } },
    load: async () => { refreshedAfterFailure = true; return true; },
    reloadCurrentPage: async () => {},
    showToast(...args) { toasts.push(args); }
  });

  await harness.fn();
  assert.deepEqual(dirty, { proxyBase: true, excludeDomains: true, quality: true, width: false });
  assert.deepEqual(busyStates, [true, false]);
  assert.equal(harness.sandbox.resetInProgress, false);
  assert.equal(harness.sandbox.saveBtn.disabled, false);
  assert.equal(refreshedAfterFailure, true);
  assert.deepEqual(toasts.at(-1), ['Could not reset settings', 'err']);
});

test('options initial settings read failure is reported without blocking stats reads', async () => {
  const toasts = [];
  let statsRead = false;
  const harness = functionFrom(optionsSource, 'load', {
    DEFAULTS: { enabled: true },
    settingsRevision: Object.create(null),
    statsRevision: 0,
    chrome: { storage: {
      sync: { get: async () => { throw new Error('sync unavailable'); } },
      local: { get: async () => { statsRead = true; return { stats: null }; } }
    } },
    showToast(...args) { toasts.push(args); }
  });

  assert.equal(await harness.fn(), false);
  assert.equal(statsRead, true, 'local stats retrieval is settled independently');
  assert.deepEqual(toasts.at(-1), ['Could not load saved settings', 'err']);
});

test('popup storage lock keeps exclusion disabled for invalid hostnames', () => {
  const controls = { enabled: { disabled: false }, grayscale: { disabled: false } };
  const presetBtns = [{ disabled: false }, { disabled: false }];
  const excludeBtn = { disabled: true };
  const harness = functionFrom(popupSource, 'setPopupStorageBusy', {
    enabledEl: controls.enabled,
    grayscaleEl: controls.grayscale,
    presetBtns,
    excludeBtn,
    currentIsWeb: true,
    currentHost: 'invalid_host.example',
    EXCLUDE_HOST_RE: constRegex(popupSource, 'EXCLUDE_HOST_RE'),
    popupStorageWriteInProgress: false
  });

  harness.fn(true);
  assert.equal(excludeBtn.disabled, true, 'all writable controls are disabled during a write');
  harness.fn(false);
  assert.equal(excludeBtn.disabled, true,
    'finishing an unrelated setting write must not enable exclusion for an invalid hostname');
  assert.equal(controls.enabled.disabled, false);
  assert.equal(controls.grayscale.disabled, false);
  assert.deepEqual(presetBtns.map(button => button.disabled), [false, false]);

  harness.sandbox.currentHost = 'valid.example';
  harness.fn(false);
  assert.equal(excludeBtn.disabled, false, 'a valid web hostname remains actionable');
  harness.sandbox.currentIsWeb = false;
  harness.fn(false);
  assert.equal(excludeBtn.disabled, true, 'non-web tabs remain unavailable');
});

test('popup site card ignores stale asynchronous tab lookups', async () => {
  const tabReads = [];
  const harness = functionFrom(popupSource, 'loadSiteUI', {
    URL,
    siteUiRevision: 0,
    currentTabId: null,
    currentHost: '',
    currentIsWeb: false,
    popupStorageWriteInProgress: false,
    EXCLUDE_HOST_RE: constRegex(popupSource, 'EXCLUDE_HOST_RE'),
    chrome: { tabs: { query: () => new Promise(resolve => { tabReads.push(resolve); }) } },
    siteNameEl: { textContent: '' },
    excludeBtn: { disabled: false, textContent: '' },
    sitePillEl: { style: { display: '' }, className: '', textContent: '' },
    parseDomains(text) {
      return String(text || '').split(/[,\s]+/).map(x => x.toLowerCase()).filter(Boolean);
    },
    findExcludedDomain(host, domains) {
      return domains.find(domain => host === domain || host.endsWith(`.${domain}`)) || '';
    }
  });
  const stale = harness.fn({ excludeDomains: '' });
  const latest = harness.fn({ excludeDomains: 'example.com' });
  tabReads[1]([{ id: 2, url: 'https://example.com/path' }]);
  await latest;
  assert.equal(harness.sandbox.excludeBtn.textContent, '✕ Remove exclusion');
  tabReads[0]([{ id: 1, url: 'https://old.example/path' }]);
  await stale;
  assert.equal(harness.sandbox.currentTabId, 2);
  assert.equal(harness.sandbox.currentHost, 'example.com');
  assert.equal(harness.sandbox.excludeBtn.textContent, '✕ Remove exclusion',
    'the older tab query cannot replace the current site state');
  const empty = harness.fn({ excludeDomains: '' });
  tabReads[2]([]);
  await empty;
  assert.equal(harness.sandbox.currentTabId, null,
    'an empty active-tab result clears the previous tab context');
  assert.equal(harness.sandbox.currentIsWeb, false);
});

test('popup site card clears stale UI when the active-tab query fails or returns an invalid URL', async () => {
  const pending = [];
  const makeHarness = () => functionFrom(popupSource, 'loadSiteUI', {
    URL,
    siteUiRevision: 0,
    currentTabId: 7,
    currentHost: 'old.example',
    currentIsWeb: true,
    EXCLUDE_HOST_RE: constRegex(popupSource, 'EXCLUDE_HOST_RE'),
    chrome: { tabs: { query: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) } },
    siteNameEl: { textContent: 'old.example' },
    excludeBtn: { disabled: false, textContent: 'Remove exclusion' },
    sitePillEl: { style: { display: '' }, className: 'site-pill excluded', textContent: 'Excluded' },
    parseDomains(text) {
      return String(text || '').split(/[\s,]+/).map(x => x.toLowerCase()).filter(Boolean);
    },
    findExcludedDomain(host, domains) {
      return domains.find(domain => host === domain || host.endsWith(`.${domain}`)) || '';
    }
  });

  const failedHarness = makeHarness();
  const failed = failedHarness.fn({ excludeDomains: 'old.example' });
  assert.equal(failedHarness.sandbox.excludeBtn.disabled, true,
    'actions are disabled while a new tab lookup is pending');
  pending[0].reject(new Error('tabs API unavailable'));
  await failed;
  assert.equal(failedHarness.sandbox.currentTabId, null);
  assert.equal(failedHarness.sandbox.currentHost, '');
  assert.equal(failedHarness.sandbox.currentIsWeb, false);
  assert.equal(failedHarness.sandbox.siteNameEl.textContent, 'Tab unavailable');
  assert.equal(failedHarness.sandbox.sitePillEl.style.display, 'none');
  assert.equal(failedHarness.sandbox.sitePillEl.textContent, '');
  assert.equal(failedHarness.sandbox.excludeBtn.textContent, 'Not available');
  assert.equal(failedHarness.sandbox.excludeBtn.disabled, true);

  const invalidHarness = makeHarness();
  const invalid = invalidHarness.fn({ excludeDomains: 'old.example' });
  pending[1].resolve([{ id: 8, url: 'not a valid absolute URL' }]);
  await invalid;
  assert.equal(invalidHarness.sandbox.siteNameEl.textContent, 'Unknown');
  assert.equal(invalidHarness.sandbox.sitePillEl.style.display, 'none');
  assert.equal(invalidHarness.sandbox.excludeBtn.disabled, true);
});

test('popup exclusion toggle aborts when the active site changes during its storage read', async () => {
  let resolveRead;
  const writes = [];
  const settingsRevision = {};
  const state = { excludeDomains: '' };
  let refreshed = 0;
  let nudges = 0;
  const harness = functionFrom(popupSource, 'toggleSiteExclusion', {
    EXCLUDE_HOST_RE: constRegex(popupSource, 'EXCLUDE_HOST_RE'),
    currentIsWeb: true,
    currentHost: 'old.example',
    siteUiRevision: 4,
    settingsRevision,
    state,
    popupStorageWriteInProgress: false,
    setPopupStorageBusy() {},
    DEFAULTS: { excludeDomains: '' },
    chrome: { storage: { sync: {
      get: () => new Promise(resolve => { resolveRead = resolve; }),
      set: async value => { writes.push(value); }
    } } },
    markSettingsRevision(key) { settingsRevision[key] = (settingsRevision[key] || 0) + 1; },
    parseDomains(text) { return String(text || '').split(/[\s,]+/).filter(Boolean); },
    findExcludedDomain(host, domains) { return domains.find(domain => host === domain) || ''; },
    removeDomainToken(text, domain) { return text.split(/[\s,]+/).filter(token => token && token !== domain).join('\n'); },
    loadSiteUI() { refreshed++; },
    showNudge() { nudges++; }
  });

  const toggle = harness.fn();
  harness.sandbox.siteUiRevision = 5;
  harness.sandbox.currentHost = 'new.example';
  resolveRead({ excludeDomains: '' });
  await toggle;
  assert.deepEqual(writes, [], 'the stale click must not exclude the newly active site');
  assert.equal(harness.sandbox.state.excludeDomains, '');
  assert.equal(refreshed, 0);
  assert.equal(nudges, 0);
});

test('popup settings reads and writes report storage errors without retaining failed optimistic state', async () => {
  const defaults = { enabled: true, grayscale: true, saveData: true, proxyBase: '', quality: 60, maxWidth: 768, excludeDomains: '' };
  const readErrors = [];
  const readLoad = functionFrom(popupSource, 'load', {
    DEFAULTS: defaults,
    state: { ...defaults },
    settingsRevision: Object.create(null),
    chrome: { storage: { sync: { get: async () => { throw new Error('sync read failed'); } } } },
    applyUI() {},
    showStorageError(message) { readErrors.push(message); },
    loadSiteUI() {}
  });
  assert.equal(await readLoad.fn(), false);
  assert.deepEqual(readErrors, ['Could not load settings']);

  const writeErrors = [];
  const state = { ...defaults, enabled: false };
  const settingsRevision = Object.create(null);
  const failedWrite = functionFrom(popupSource, 'savePopupSetting', {
    state,
    settingsRevision,
    popupStorageWriteInProgress: false,
    setPopupStorageBusy() {},
    markSettingsRevision(key) { settingsRevision[key] = (settingsRevision[key] || 0) + 1; },
    chrome: { storage: { sync: { set: async () => { throw new Error('sync write failed'); } } } },
    applyUI() {},
    showStorageError(message) { writeErrors.push(message); }
  });
  assert.equal(await failedWrite.fn('enabled', true), false);
  assert.equal(state.enabled, false, 'failed optimistic write restores the previous value');
  assert.deepEqual(writeErrors, ['Could not save settings']);
});

test('popup serializes setting writes and blocks other storage controls while saving', async () => {
  const writes = [];
  let resolveWrite;
  const busyStates = [];
  let harness;
  harness = functionFrom(popupSource, 'savePopupSetting', {
    state: { enabled: false, grayscale: false },
    settingsRevision: Object.create(null),
    popupStorageWriteInProgress: false,
    setPopupStorageBusy(value) {
      busyStates.push(value);
      harness.sandbox.popupStorageWriteInProgress = value;
    },
    markSettingsRevision(key) {
      harness.sandbox.settingsRevision[key] = (harness.sandbox.settingsRevision[key] || 0) + 1;
    },
    chrome: { storage: { sync: { set(value) {
      writes.push(value);
      return new Promise(resolve => { resolveWrite = resolve; });
    } } } },
    applyUI() {}, showStorageError() {}
  });
  const first = harness.fn('enabled', true);
  assert.equal(harness.sandbox.popupStorageWriteInProgress, true);
  const second = await harness.fn('grayscale', true);
  assert.equal(second, false, 'a second settings change is ignored while the first write is pending');
  assert.equal(writes.length, 1, 'only one storage write is issued at a time');
  resolveWrite();
  assert.equal(await first, true);
  assert.equal(harness.sandbox.popupStorageWriteInProgress, false);
  assert.deepEqual(busyStates, [true, false]);
});

test('popup exclusion writes are blocked while another setting save is in flight', async () => {
  let reads = 0;
  const harness = functionFrom(popupSource, 'toggleSiteExclusion', {
    currentIsWeb: true, currentHost: 'example.com', popupStorageWriteInProgress: true,
    chrome: { storage: { sync: { get() { reads++; } } } },
    setPopupStorageBusy() {}
  });
  await harness.fn();
  assert.equal(reads, 0);
});

test('popup failed write does not roll back a newer cross-page settings event', async () => {
  let rejectWrite;
  const state = { enabled: false };
  const settingsRevision = Object.create(null);
  const writeErrors = [];
  const harness = functionFrom(popupSource, 'savePopupSetting', {
    state,
    settingsRevision,
    popupStorageWriteInProgress: false,
    setPopupStorageBusy() {},
    markSettingsRevision(key) { settingsRevision[key] = (settingsRevision[key] || 0) + 1; },
    chrome: { storage: { sync: { set: () => new Promise((_resolve, reject) => { rejectWrite = reject; }) } } },
    applyUI() {},
    showStorageError(message) { writeErrors.push(message); }
  });
  const save = harness.fn('enabled', true);
  harness.sandbox.markSettingsRevision('enabled');
  state.enabled = true; // newer cross-page value arrived while this write was pending
  rejectWrite(new Error('write failed'));
  assert.equal(await save, false);
  assert.equal(state.enabled, true, 'the newer observed value wins over the failed optimistic write');
  assert.deepEqual(writeErrors, ['Could not save settings']);
});

test('popup exclusion read and write failures are reported', async () => {
  const run = async ({ get, set }) => {
    const errors = [];
    const settingsRevision = {};
    const host = functionFrom(popupSource, 'toggleSiteExclusion', {
      EXCLUDE_HOST_RE: constRegex(popupSource, 'EXCLUDE_HOST_RE'),
      currentIsWeb: true,
      currentHost: 'example.com',
      siteUiRevision: 1,
      settingsRevision,
      state: { excludeDomains: '' },
      popupStorageWriteInProgress: false,
      setPopupStorageBusy() {},
      DEFAULTS: { excludeDomains: '' },
      chrome: { storage: { sync: { get, set } } },
      markSettingsRevision(key) { settingsRevision[key] = (settingsRevision[key] || 0) + 1; },
      parseDomains(text) { return String(text || '').split(/[\s,]+/).filter(Boolean); },
      findExcludedDomain(host, domains) { return domains.find(domain => host === domain) || ''; },
      removeDomainToken(text, domain) { return text.split(/[\s,]+/).filter(token => token && token !== domain).join('\n'); },
      loadSiteUI() {},
      showNudge() {},
      showStorageError(message) { errors.push(message); }
    });
    await host.fn();
    return errors;
  };
  assert.deepEqual(await run({ get: async () => { throw new Error('read failed'); }, set: async () => {} }),
    ['Could not load site exclusions']);
  assert.deepEqual(await run({ get: async () => ({ excludeDomains: '' }), set: async () => { throw new Error('write failed'); } }),
    ['Could not save site exclusion']);
});

test('service worker does not treat failed sync reads as missing settings', () => {
  const storageError = new Error('sync storage unavailable');
  let retries = 0;
  let localReads = 0;
  const mirrorChrome = {
    runtime: { lastError: storageError },
    storage: {
      sync: { get(_query, callback) { callback(undefined); } },
      local: { get() { localReads++; } }
    }
  };
  const mirror = functionFrom(serviceWorker, 'mirrorToLocal', {
    chrome: mirrorChrome,
    mirrorReadRevision: 0,
    mirrorRevision: 0,
    mirrorWriteInFlight: false,
    pendingMirrorWrite: null,
    proxyObserverReady: false,
    restoreProxyObserverFromLocalMirror() {},
    scheduleSettingsReadRetry() { retries++; }
  });
  mirror.fn();
  assert.equal(localReads, 0, 'failed sync read must not replace the last good local mirror');
  assert.equal(retries, 1, 'settings recovery is scheduled');

  let ruleUpdates = 0;
  let finished = 0;
  const rules = functionFrom(serviceWorker, 'doRefreshRules', {
    chrome: {
      runtime: { lastError: storageError },
      declarativeNetRequest: { updateDynamicRules() { ruleUpdates++; } },
      storage: { sync: { get(_query, callback) { callback(undefined); } } }
    },
    scheduleSettingsReadRetry() { retries++; }
  });
  rules.fn(() => { finished++; });
  assert.equal(ruleUpdates, 0, 'failed settings must not rebuild or remove the active DNR rules');
  assert.equal(finished, 1, 'the refresh lock is released');
  assert.equal(retries, 2);

  let writes = 0;
  const initialize = functionFrom(serviceWorker, 'initializeMissingSettings', {
    chrome: {
      runtime: { lastError: storageError },
      storage: { sync: { get(_query, callback) { callback(undefined); }, set() { writes++; } } }
    },
    scheduleSettingsReadRetry() { retries++; }
  });
  initialize.fn();
  assert.equal(writes, 0, 'failed reads must never overwrite existing user settings with defaults');
  assert.equal(retries, 3);
});

test('service worker ignores stale sync snapshots and serializes local settings mirror writes', () => {
  const defaults = {
    enabled: true, saveData: true, proxyBase: '', quality: 60,
    grayscale: true, maxWidth: 768, excludeDomains: ''
  };
  const syncReads = [];
  const localReads = [];
  const localWrites = [];
  const localWriteCallbacks = [];
  let localMirror = null;
  const chrome = {
    runtime: { lastError: null },
    storage: {
      sync: { get(_query, callback) { syncReads.push(callback); } },
      local: {
        get(_query, callback) { localReads.push(callback); },
        set(value, callback) {
          localWrites.push(value.bhOpts);
          localMirror = value.bhOpts;
          localWriteCallbacks.push(callback);
        }
      }
    }
  };
  const sandbox = {
    DEFAULTS: defaults, chrome, mirrorReadRevision: 0, mirrorRevision: 0, proxyObserverRevision: 0,
    mirrorWriteInFlight: false, pendingMirrorWrite: null, proxyObserverReady: false,
    configuredProxyOrigin: '', earlyStatsEvents: [],
    sameOpts: (a, b) => !!a && !!b && Object.keys(defaults).every(key => a[key] === b[key]),
    setProxyOrigin(base) { sandbox.configuredProxyOrigin = base; },
    updateWebRequestListener() {}, handleProxyCompleted() {},
    scheduleSettingsReadRetry() {}
  };
  const mirror = functionFrom(serviceWorker, ['applyProxyObserverOrigin', 'mirrorToLocal'], sandbox);
  const oldOpts = { ...defaults, proxyBase: 'https://old.example/convert' };
  const newOpts = { ...defaults, proxyBase: 'https://new.example/convert' };

  mirror.fn();
  syncReads[0](oldOpts);
  localReads.shift()({ bhOpts: null });
  assert.equal(localWrites.length, 1, 'the first snapshot starts one local write');

  mirror.fn();
  syncReads[1](newOpts);
  assert.equal(localReads.length, 0,
    'a newer snapshot waits while an older local write is in flight');
  localWriteCallbacks.shift()();
  assert.equal(localReads.length, 1,
    'the queued newest snapshot reads the mirror after the older write completes');
  localReads.shift()({ bhOpts: oldOpts });
  assert.equal(localWrites.length, 2);
  assert.equal(localWrites[1].proxyBase, newOpts.proxyBase);
  localWriteCallbacks.shift()();
  assert.equal(localMirror.proxyBase, newOpts.proxyBase,
    'the last confirmed local mirror is always the newest sync snapshot');

  mirror.fn();
  mirror.fn();
  const beforeStaleCallback = localReads.length;
  syncReads[2]({ ...defaults, proxyBase: 'https://obsolete.example/convert' });
  assert.equal(localReads.length, beforeStaleCallback,
    'an obsolete sync callback cannot start a local mirror read');
  const latestOpts = { ...defaults, proxyBase: 'https://latest.example/convert' };
  syncReads[3](latestOpts);
  assert.equal(localReads.length, beforeStaleCallback + 1,
    'the newest sync callback is the only one allowed to publish');
  localReads.shift()({ bhOpts: newOpts });
  localWriteCallbacks.shift()();
  assert.equal(localMirror.proxyBase, latestOpts.proxyBase,
    'the latest snapshot finishes the serialized mirror queue');
});

test('service worker icon updates ignore stale sync callbacks', () => {
  const reads = [];
  const icons = [];
  const sandbox = {
    DEFAULTS: { enabled: true },
    ICONS_ON: { 16: 'on.png' },
    ICONS_OFF: { 16: 'off.png' },
    iconRevision: 0,
    chrome: {
      runtime: { lastError: null },
      storage: { sync: { get(_query, callback) { reads.push(callback); } } },
      action: { setIcon(value) { icons.push(value.path); } }
    },
    scheduleSettingsReadRetry() {}
  };
  const update = functionFrom(serviceWorker, 'updateIcon', sandbox);
  update.fn();
  update.fn();
  reads[0]({ enabled: false });
  assert.equal(icons.length, 0, 'an old disabled snapshot is discarded');
  reads[1]({ enabled: true });
  assert.equal(icons.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(icons[0])), { 16: 'on.png' });
});

test('proxy observers register synchronously and recover their filter from the local settings mirror', () => {
  const bootstrapCall = serviceWorker.indexOf('updateWebRequestListener("*");');
  const bootstrapRun = serviceWorker.lastIndexOf('\nmirrorToLocal();');
  assert.ok(bootstrapCall >= 0 && bootstrapCall < bootstrapRun,
    'the broad bootstrap listener must be registered at top level before async settings reads');

  const registrations = [];
  const makeEvent = name => ({
    addListener(_listener, filter, extra) { registrations.push([name, 'add', filter, extra || null]); },
    removeListener() { registrations.push([name, 'remove']); }
  });
  const listenerSandbox = {
    chrome: { webRequest: { onCompleted: makeEvent('completed'), onErrorOccurred: makeEvent('error') } },
    PROXY_REQUEST_TYPES: ['image', 'object'],
    onProxyCompleted() {}, onProxyError() {},
    webRequestRegistered: false, webRequestOrigin: null
  };
  vm.createContext(listenerSandbox);
  vm.runInContext(`${extractFunction(serviceWorker, 'updateWebRequestListener')}\nthis.update = updateWebRequestListener;`, listenerSandbox);
  listenerSandbox.update('*');
  assert.deepEqual(registrations.filter(x => x[1] === 'add').map(x => Array.from(x[2].urls)), [['<all_urls>'], ['<all_urls>']]);
  listenerSandbox.update('https://proxy.example');
  assert.deepEqual(registrations.filter(x => x[1] === 'add').slice(2).map(x => Array.from(x[2].urls)), [
    ['https://proxy.example/*'], ['https://proxy.example/*']
  ]);
  listenerSandbox.update('');
  assert.equal(registrations.filter(x => x[1] === 'add').length, 4,
    'clearing the proxy removes the targeted observer instead of re-registering it');

  const event = { url: 'https://proxy.example/api?url=https://cdn.example/a.png', statusCode: 200 };
  const mirrorSandbox = {
    URL,
    chrome: { runtime: { lastError: null }, storage: { local: { get(_query, callback) {
      callback({ bhOpts: { proxyBase: 'https://proxy.example/api' } });
    } } } }
  };
  vm.createContext(mirrorSandbox);
  vm.runInContext(`
    let configuredProxyOrigin = '';
    let proxyObserverRevision = 0;
    let proxyObserverReady = false;
    let restoringProxyObserver = false;
    const earlyStatsEvents = [${JSON.stringify(event)}];
    const handled = [];
    let selectedOrigin = '';
    let retries = 0;
    function setProxyOrigin(base) { configuredProxyOrigin = new URL(base).origin; }
    function updateWebRequestListener(origin) { selectedOrigin = origin; }
    function handleProxyCompleted(item) { handled.push(item.url); }
    function scheduleSettingsReadRetry() { retries++; }
    ${extractFunction(serviceWorker, 'applyProxyObserverOrigin')}
    ${extractFunction(serviceWorker, 'restoreProxyObserverFromLocalMirror')}
    restoreProxyObserverFromLocalMirror();
    this.result = () => ({ configuredProxyOrigin, selectedOrigin, remaining: earlyStatsEvents.length, handled, retries, proxyObserverRevision, proxyObserverReady, restoringProxyObserver });
  `, mirrorSandbox);
  const result = mirrorSandbox.result();
  assert.equal(result.configuredProxyOrigin, 'https://proxy.example');
  assert.equal(result.selectedOrigin, 'https://proxy.example');
  assert.equal(result.remaining, 0, 'queued startup events are replayed after the origin is restored');
  assert.deepEqual(Array.from(result.handled), [event.url]);
  assert.equal(result.retries, 0);
  assert.equal(result.proxyObserverRevision, 1);
  assert.equal(result.proxyObserverReady, true);
  assert.equal(result.restoringProxyObserver, false);

  const failedRead = new Error('local settings mirror unavailable');
  const failureSandbox = {
    URL,
    chrome: {
      runtime: { lastError: failedRead },
      storage: { local: { get(_query, callback) { callback(undefined); } } }
    }
  };
  vm.createContext(failureSandbox);
  vm.runInContext(`
    let configuredProxyOrigin = '';
    let proxyObserverRevision = 0;
    let proxyObserverReady = false;
    let restoringProxyObserver = false;
    const earlyStatsEvents = [];
    let selectedOrigin = '*';
    let retries = 0;
    function setProxyOrigin(base) { configuredProxyOrigin = new URL(base).origin; }
    function updateWebRequestListener(origin) { selectedOrigin = origin; }
    function handleProxyCompleted() {}
    function scheduleSettingsReadRetry() { retries++; }
    ${extractFunction(serviceWorker, 'applyProxyObserverOrigin')}
    ${extractFunction(serviceWorker, 'restoreProxyObserverFromLocalMirror')}
    restoreProxyObserverFromLocalMirror();
    this.result = () => ({ selectedOrigin, retries, proxyObserverRevision, proxyObserverReady, restoringProxyObserver });
  `, failureSandbox);
  const failed = failureSandbox.result();
  assert.equal(failed.selectedOrigin, '*', 'a failed local read must leave the synchronous startup observer active');
  assert.equal(failed.retries, 1);
  assert.equal(failed.proxyObserverRevision, 1);
  assert.equal(failed.restoringProxyObserver, false);
});

test('proxy observer origin is applied through one helper on both the sync and local-mirror paths', () => {
  // One definition plus the two recovery call sites; the raw steps live only in the helper.
  assert.equal(serviceWorker.split('applyProxyObserverOrigin(').length - 1, 3,
    'the helper is defined once and called from the sync and local-mirror paths');
  assert.equal(serviceWorker.split('updateWebRequestListener(configuredProxyOrigin)').length - 1, 1,
    'only the shared helper re-targets the webRequest observer');
  assert.equal(serviceWorker.split('setProxyOrigin(opts.proxyBase)').length - 1, 0,
    'callers never set the origin directly');
});

test('a successful sync snapshot invalidates an older local proxy-observer restore', () => {
  const defaults = {
    enabled: true, saveData: true, proxyBase: '', quality: 60,
    grayscale: true, maxWidth: 768, excludeDomains: ''
  };
  const syncReads = [];
  const localReads = [];
  const selectedOrigins = [];
  const sandbox = {
    URL, DEFAULTS: defaults, mirrorReadRevision: 0, mirrorRevision: 0, mirrorWriteInFlight: false,
    pendingMirrorWrite: null, proxyObserverRevision: 0, proxyObserverReady: false,
    earlyStatsEvents: [], selectedOrigins, restoringProxyObserver: false,
    chrome: {
      runtime: { lastError: null },
      storage: {
        sync: { get(_query, callback) { syncReads.push(callback); } },
        local: {
          get(_query, callback) { localReads.push(callback); },
          set(_value, callback) { callback?.(); }
        }
      }
    },
    sameOpts: (a, b) => !!a && !!b && Object.keys(defaults).every(key => a[key] === b[key]),
    handleProxyCompleted() {},
    scheduleSettingsReadRetry() {}
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    let configuredProxyOrigin = '';
    function setProxyOrigin(base) { configuredProxyOrigin = base ? new URL(base).origin : ''; }
    function updateWebRequestListener(origin) { selectedOrigins.push(origin); }
    ${extractFunction(serviceWorker, 'applyProxyObserverOrigin')}
    ${extractFunction(serviceWorker, 'restoreProxyObserverFromLocalMirror')}
    ${extractFunction(serviceWorker, 'mirrorToLocal')}
    this.restore = restoreProxyObserverFromLocalMirror;
    this.mirror = mirrorToLocal;
    this.origin = () => configuredProxyOrigin;
  `, sandbox);

  const oldOpts = { ...defaults, proxyBase: 'https://old-proxy.example/convert' };
  const newOpts = { ...defaults, proxyBase: 'https://new-proxy.example/convert' };
  sandbox.restore();
  sandbox.restore();
  assert.equal(localReads.length, 1, 'overlapping recovery requests share one local-mirror read');

  sandbox.mirror();
  syncReads[0](newOpts);
  assert.equal(sandbox.origin(), 'https://new-proxy.example', 'the successful sync snapshot becomes current');
  assert.equal(sandbox.proxyObserverReady, true, 'a trusted sync snapshot becomes the observer recovery baseline');
  assert.equal(localReads.length, 2, 'the mirror writer separately checks whether the local copy needs updating');
  localReads[1]({ bhOpts: newOpts });
  localReads[0]({ bhOpts: oldOpts });

  assert.equal(sandbox.origin(), 'https://new-proxy.example',
    'a late local restore cannot roll the observer back to the older proxy');
  assert.deepEqual(Array.from(sandbox.selectedOrigins), ['https://new-proxy.example']);
});

test('a failed newer sync read cannot roll the proxy observer back or cancel a confirmed mirror write', () => {
  const defaults = {
    enabled: true, saveData: true, proxyBase: '', quality: 60,
    grayscale: true, maxWidth: 768, excludeDomains: ''
  };
  const syncReads = [];
  const localReads = [];
  const localWrites = [];
  const selectedOrigins = [];
  let configuredProxyOrigin = '';
  const storageError = new Error('temporary sync read failure');
  const sandbox = {
    URL, DEFAULTS: defaults,
    mirrorReadRevision: 0, mirrorRevision: 0,
    mirrorWriteInFlight: false, pendingMirrorWrite: null,
    proxyObserverRevision: 0, proxyObserverReady: false,
    restoringProxyObserver: false, earlyStatsEvents: [], selectedOrigins,
    chrome: {
      runtime: { lastError: null },
      storage: {
        sync: { get(_query, callback) { syncReads.push(callback); } },
        local: {
          get(_query, callback) { localReads.push(callback); },
          set(value, callback) { localWrites.push(value.bhOpts); callback?.(); }
        }
      }
    },
    sameOpts: (a, b) => !!a && !!b && Object.keys(defaults).every(key => a[key] === b[key]),
    scheduleSettingsReadRetry() {},
    handleProxyCompleted() {}
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    function setProxyOrigin(base) { configuredProxyOrigin = base ? new URL(base).origin : ''; }
    function updateWebRequestListener(origin) { selectedOrigins.push(origin); }
    ${extractFunction(serviceWorker, 'applyProxyObserverOrigin')}
    ${extractFunction(serviceWorker, 'restoreProxyObserverFromLocalMirror')}
    ${extractFunction(serviceWorker, 'mirrorToLocal')}
    this.mirror = mirrorToLocal;
    this.restore = restoreProxyObserverFromLocalMirror;
    this.origin = () => configuredProxyOrigin;
  `, sandbox);

  const latest = { ...defaults, proxyBase: 'https://latest-proxy.example/convert' };
  const staleLocal = { ...defaults, proxyBase: 'https://old-proxy.example/convert' };
  sandbox.mirror();
  syncReads[0](latest);
  assert.equal(sandbox.origin(), 'https://latest-proxy.example');
  assert.equal(sandbox.mirrorRevision, 1);
  assert.equal(localReads.length, 1, 'the confirmed snapshot has begun its mirror read');

  // A later storage-change notification triggers a fresh sync read that fails.
  // It must neither use an old local mirror to reset the observer nor invalidate
  // the already-confirmed snapshot whose local mirror write is still pending.
  sandbox.mirror();
  sandbox.chrome.runtime.lastError = storageError;
  syncReads[1](undefined);
  assert.equal(sandbox.mirrorRevision, 1,
    'failed newer reads do not supersede the latest successful snapshot revision');
  assert.equal(sandbox.proxyObserverReady, true);
  assert.equal(localReads.length, 1,
    'a ready observer does not launch a stale local-mirror recovery read');
  assert.equal(sandbox.origin(), 'https://latest-proxy.example');

  sandbox.chrome.runtime.lastError = null;
  localReads[0]({ bhOpts: staleLocal });
  assert.equal(localWrites.length, 1,
    'the successful snapshot still completes its queued mirror write');
  assert.equal(localWrites[0].proxyBase, latest.proxyBase);
  assert.deepEqual(Array.from(selectedOrigins), ['https://latest-proxy.example']);
});

test('extension and browser HTML pages use unique DOM ids and resolve static UI selectors', () => {
  const pagesDir = path.join(ROOT, 'tests', 'browser', 'pages');
  const fixturePages = fs.readdirSync(pagesDir).filter(file => file.endsWith('.html'))
    .map(file => path.join('tests', 'browser', 'pages', file));
  const pages = ['popup.html', 'options.html', ...fixturePages].sort();
  assert.ok(fixturePages.length > 0, 'browser fixture pages exist');

  for (const file of pages) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const ids = [...html.matchAll(/\bid\s*=\s*(["'])(.*?)\1/gi)].map(match => match[2]);
    const seen = new Set();
    const duplicates = new Set();
    for (const id of ids) {
      if (seen.has(id)) duplicates.add(id);
      seen.add(id);
    }
    assert.deepEqual([...duplicates], [], `${file}: duplicate DOM id(s)`);

    const appScript = file === 'popup.html' ? 'popup.js' : file === 'options.html' ? 'options.js' : null;
    if (!appScript) continue;

    const source = fs.readFileSync(path.join(ROOT, appScript), 'utf8');
    const staticRefs = [
      ...[...source.matchAll(/\$\(\s*["']([^"']+)["']\s*\)/g)].map(match => match[1]),
      ...[...source.matchAll(/\.getElementById\(\s*["']([^"']+)["']\s*\)/g)].map(match => match[1]),
      ...[...source.matchAll(/\.querySelector(?:All)?\(\s*["'][^"']*#([A-Za-z][\w:-]*)/g)].map(match => match[1])
    ];
    const missing = [...new Set(staticRefs)].filter(id => !seen.has(id));
    assert.deepEqual(missing, [], `${appScript}: static selector(s) must exist in ${file}`);
  }
});

test('exclusion hostname rule is identical in every layer; network rules, DOM layer and popup agree', () => {
  const reference = constRegex(serviceWorker, 'EXCLUDE_HOST_RE').source;
  for (const [file, src] of [['prehook.js', prehook], ['content.js', content], ['popup.js', popupSource]]) {
    assert.equal(constRegex(src, 'EXCLUDE_HOST_RE').source, reference, `${file}: EXCLUDE_HOST_RE differs from service-worker.js`);
  }

  const swParse = functionFrom(serviceWorker, 'parseExcluded', { EXCLUDE_HOST_RE: constRegex(serviceWorker, 'EXCLUDE_HOST_RE') });
  const domSet = functionFrom(content, 'domainSet', { EXCLUDE_HOST_RE: constRegex(content, 'EXCLUDE_HOST_RE') });
  const popupFind = functionFrom(popupSource, 'findExcludedDomain', { EXCLUDE_HOST_RE: constRegex(popupSource, 'EXCLUDE_HOST_RE') });
  const popupParse = functionFrom(popupSource, 'parseDomains');

  // Underscores, ports, wildcards and malformed labels are not plain hostnames.
  const input = 'good.example, foo_bar.example\u00a0sub.good.example,\tBAD..x,https://port.example:8443/path, *.wild.example';
  const honored = JSON.parse(JSON.stringify(swParse.fn(input))).sort();
  assert.deepEqual(honored, ['good.example', 'sub.good.example']);

  assert.deepEqual(JSON.parse(JSON.stringify([...domSet.fn(input)])).sort(), honored,
    'the content-script layer keeps exactly the entries the network rules keep');

  const candidates = ['good.example', 'sub.good.example', 'foo_bar.example', 'x.foo_bar.example', 'other.example', 'port.example'];
  const h = createDomHarness();
  h.publishSettings({ redirect: false, excludeDomains: input });
  for (const host of candidates) {
    const expected = honored.some(d => host === d || host.endsWith(`.${d}`));
    assert.equal(popupFind.fn(host, popupParse.fn(input)) !== '', expected,
      `popup must report ${host} as excluded only when the network rule honors it`);
    const url = `https://${host}/x.png`;
    const img = new h.HTMLImageElement();
    img.src = url;
    assert.equal(img.getAttribute('src') === url, expected,
      `DOM layer must agree with the network rule for ${host}`);
  }
});

test('popup shows a site that cannot be excluded as not available, never as excluded', async () => {
  const harness = functionFrom(popupSource, 'loadSiteUI', {
    URL,
    EXCLUDE_HOST_RE: constRegex(popupSource, 'EXCLUDE_HOST_RE'),
    siteUiRevision: 0,
    currentTabId: null,
    currentHost: '',
    currentIsWeb: false,
    popupStorageWriteInProgress: false,
    chrome: { tabs: { query: async () => [{ id: 3, url: 'https://foo_bar.example/page' }] } },
    siteNameEl: { textContent: '' },
    excludeBtn: { disabled: false, textContent: '' },
    sitePillEl: { style: { display: '' }, className: '', textContent: '' },
    parseDomains(text) { return String(text || '').split(/[,\s]+/).map(x => x.toLowerCase()).filter(Boolean); },
    findExcludedDomain(host, domains) { return domains.find(d => host === d) || ''; }
  });
  await harness.fn({ excludeDomains: 'foo_bar.example' });
  assert.equal(harness.sandbox.excludeBtn.disabled, true);
  assert.equal(harness.sandbox.excludeBtn.textContent, 'Not available');
  assert.equal(harness.sandbox.sitePillEl.style.display, 'none',
    'no "Excluded" pill for a site the network layer cannot exclude');
});

// Reads a top-level `const NAME = /.../flags;` regex literal from a source file,
// so sandboxes use exactly the pattern the shipped code declares.
function constRegex(source, name) {
  const m = new RegExp(`const ${name} = (\\/.*\\/)([a-z]*);`).exec(source);
  assert.ok(m, `${name} must be declared`);
  return new RegExp(m[1].slice(1, -1), m[2]);
}

function extractFunction(source, name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
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

// `name` may be a list: the listed functions share one sandbox, and the last
// one is the exported function (earlier ones are helpers it calls).
function functionFrom(source, name, globals = {}) {
  const names = Array.isArray(name) ? name : [name];
  const sandbox = { ...globals };
  vm.createContext(sandbox);
  const exported = names[names.length - 1];
  vm.runInContext(`${names.map(n => extractFunction(source, n)).join('\n')}\nthis.__exported = ${exported};`, sandbox);
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

test('MAIN-world inline-style interception handles conflict URLs and preserves DNR-owned URLs', () => {
  const sandbox = {
    URL,
    destroyed: false,
    active: true,
    redirectLive: true,
    CSS_URL_RE: constRegex(prehook, 'CSS_URL_RE'),
    CONFLICT_RE: constRegex(prehook, 'CONFLICT_RE'),
    document: { baseURI: 'https://page.example/articles/' },
    isLocalFragmentReference: value => String(value || '').trim().startsWith('#'),
    safeURL(value, base) { try { return new URL(value, base); } catch { return null; } },
    domHandles(value) { return !sandbox.redirectLive || sandbox.CONFLICT_RE.test(value); },
    skipAbsolute(value) {
      try {
        const url = new URL(value);
        return url.origin === 'https://proxy.example' || url.hostname === 'private.test';
      } catch { return true; }
    },
    buildProxyUrl(value) { return 'https://proxy.example/convert?url=' + encodeURIComponent(value); },
    setAttr: { call(el, name, value) { if (name === 'style') { el._style = String(value); el.writes++; } } }
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction(prehook, 'processInlineStyle')}\nthis.rewrite = processInlineStyle;`, sandbox);

  const makeElement = style => ({
    nodeType: 1, baseURI: 'https://page.example/articles/', _style: style, writes: 0,
    getAttribute(name) { return name === 'style' ? this._style : null; }
  });
  const conflict = 'https://cdn.example/image.png?w=40&QUALITY=80';
  const ordinary = 'https://cdn.example/ordinary.png';
  const el = makeElement(`background:url("${conflict}");border-image:url(${ordinary});mask:url(#mask);`);
  sandbox.rewrite(el);
  assert.equal(el.writes, 1);
  assert.ok(el._style.includes(encodeURIComponent(conflict)), 'case-insensitive conflict URL is proxied');
  assert.ok(el._style.includes(ordinary), 'ordinary image URL remains with the DNR redirect');
  assert.ok(el._style.includes('url(#mask)'), 'same-document fragment remains local');

  sandbox.redirectLive = false;
  const fallback = makeElement(`background:url(${ordinary});border:url(https://private.test/image.png);`);
  sandbox.rewrite(fallback);
  assert.equal(fallback.writes, 1);
  assert.ok(fallback._style.includes(encodeURIComponent(ordinary)), 'DOM fallback proxies ordinary public URLs');
  assert.ok(fallback._style.includes('https://private.test/image.png'), 'private hosts remain direct');
});

test('MAIN-world style observer covers attribute changes and already-populated shadow roots', () => {
  assert.match(prehook, /attributeFilter: \["style"\]/,
    'style attribute changes are observed');
  assert.match(prehook, /preloadObserver\.observe\(root, DOM_OBSERVER_OPTIONS\)/,
    'open and closed attached roots share the style-aware observer');
  assert.match(prehook, /observeNestedShadowRoots\(n\)/,
    'inserted hosts register open declarative shadow roots');
  assert.match(prehook, /scanKnownShadowInlineStyles\(\);/,
    'settings arrival scans inline styles already present in known roots');
});

test('content script rewrites URL references across inline CSS declarations', () => {
  const rewriteSource = [extractFunction(content, 'isLocalFragmentReference'), extractFunction(content, 'rewriteInlineStyles')].join('\n');
  const sandbox = {
    CSS_URL_RE: constRegex(content, 'CSS_URL_RE'),
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

test('same-document fragment references stay local in DOM fallback and CSS retry scanning', () => {
  const fragment = '#paint-server';
  const external = 'https://cdn.example/background.png';
  const proxy = original => `https://proxy.example/convert?url=${encodeURIComponent(original)}`;

  // Isolated-world inline styles must leave SVG masks/gradients intact while
  // still proxying actual remote image URLs when DNR is unavailable.
  const contentStyleSandbox = {
    CSS_URL_RE: constRegex(content, 'CSS_URL_RE'),
    doneStyle: new WeakSet(), active: true, failedEls: { has: () => false },
    shouldSkip(url) { return new URL(url).origin === 'https://proxy.example'; },
    resolveHttp(url) { try { const u = new URL(url, 'https://page.example/'); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } },
    buildProxyUrl: proxy
  };
  vm.createContext(contentStyleSandbox);
  vm.runInContext(`${extractFunction(content, 'isLocalFragmentReference')}\n${extractFunction(content, 'rewriteInlineStyles')}\nthis.rewrite = rewriteInlineStyles;`, contentStyleSandbox);
  const styleEl = {
    _style: `mask: url(${fragment}); background-image: url("${external}")`,
    getAttribute(name) { return name === 'style' ? this._style : null; },
    setAttribute(name, value) { if (name === 'style') this._style = String(value); }
  };
  contentStyleSandbox.rewrite(styleEl);
  assert.ok(styleEl._style.includes(`url(${fragment})`), 'fragment-only CSS reference remains unchanged');
  assert.ok(styleEl._style.includes(encodeURIComponent(external)), 'remote CSS image is still proxied');

  // Parser-created images use a separate path from srcset rewriting; their
  // fragment-only src must also remain on the native direct path.
  const contentImageSandbox = {
    doneImg: new WeakSet(), failedEls: { has: () => false }, active: true,
    hasCustomLazySource: () => false, hasDeferredLazySource: () => false,
    resolveHttp(url) { try { return new URL(url, 'https://page.example/').href; } catch { return null; } },
    shouldSkip: () => false,
    nativeImgSrcSetter: { call(el, value) { el.setAttribute('src', value); } },
    armProxyFallback() {}, buildProxyUrl: proxy,
    rewriteSrcsetValue: value => value
  };
  vm.createContext(contentImageSandbox);
  vm.runInContext(`${extractFunction(content, 'isLocalFragmentReference')}\n${extractFunction(content, 'rewriteImg')}\nthis.rewrite = rewriteImg;`, contentImageSandbox);
  const imageEl = {
    tagName: 'IMG', attrs: new Map([['src', fragment]]),
    getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; },
    hasAttribute(name) { return this.attrs.has(name); },
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
  };
  contentImageSandbox.rewrite(imageEl);
  assert.equal(imageEl.getAttribute('src'), fragment, 'isolated-world parser handling preserves fragment-only src');

  // Both srcset interceptors must preserve fragment candidates independently.
  const contentSrcsetSandbox = {
    WeakMap, srcsetCache: new WeakMap(),
    shouldSkip(url) { return new URL(url).origin === 'https://proxy.example'; },
    resolveHttp(url) { try { return new URL(url, 'https://page.example/').href; } catch { return null; } },
    buildProxyUrl: proxy
  };
  vm.createContext(contentSrcsetSandbox);
  vm.runInContext(`${extractFunction(content, 'isLocalFragmentReference')}\n${extractFunction(content, 'parseSrcset')}\n${extractFunction(content, 'rewriteSrcsetValue')}\nthis.rewrite = rewriteSrcsetValue;`, contentSrcsetSandbox);
  const contentSrcset = contentSrcsetSandbox.rewrite(`${fragment} 1x, ${external} 2x`, {});
  assert.ok(contentSrcset.startsWith(`${fragment} 1x, `));
  assert.ok(contentSrcset.includes(encodeURIComponent(external)));

  const prehookSandbox = {
    URL, ready: true, opts: {}, active: true,
    resolveHttp(url) { try { return new URL(url, 'https://page.example/').href; } catch { return null; } },
    isConfiguredProxyUrl: () => false,
    domHandles: () => true,
    skipAbsolute: () => false,
    buildProxyUrl: proxy,
    srcsetCache: new WeakMap(),
    document: { baseURI: 'https://page.example/' },
    CSS_URL_RE: /url\(\s*(?:(['\"])(.*?)\1|([^)]*?))\s*\)/gi,
    safeURL(value, base) { try { return new URL(value, base); } catch { return null; } },
    stripHash(value) { const u = new URL(value); u.hash = ''; return u.href; }
  };
  vm.createContext(prehookSandbox);
  vm.runInContext([
    extractFunction(prehook, 'isLocalFragmentReference'),
    extractFunction(prehook, 'parseSrcset'),
    extractFunction(prehook, 'decideSrc'),
    extractFunction(prehook, 'rewriteSrcset'),
    extractFunction(prehook, 'cssUrls')
  ].join('\n') + '\nthis.decide = decideSrc; this.rewrite = rewriteSrcset; this.css = cssUrls;', prehookSandbox);
  assert.equal(prehookSandbox.decide(fragment), fragment, 'MAIN-world src setter preserves fragment-only references');
  const prehookSrcset = prehookSandbox.rewrite(`${fragment} 1x, ${external} 2x`, {});
  assert.ok(prehookSrcset.startsWith(`${fragment} 1x, `));
  assert.ok(prehookSrcset.includes(encodeURIComponent(external)));
  assert.deepEqual(JSON.parse(JSON.stringify(prehookSandbox.css(`mask: url(${fragment}); background: url(${external})`, 'https://page.example/'))), [external]);
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
  const regexRules = normalRules.filter(rule => typeof rule.condition.regexFilter === 'string');
  assert.ok(regexRules.length > 0, 'the network rules include regex-based matches');
  for (const rule of regexRules) {
    assert.equal(rule.condition.isUrlFilterCaseSensitive, false,
      `regex rule ${rule.id} explicitly keeps case-insensitive URL matching`);
  }
  const csp = normalRules.find(rule => rule.id === 2);
  assert.deepEqual(JSON.parse(JSON.stringify(csp.condition.responseHeaders)), [
    { header: 'content-security-policy', values: ['*img-src*', '*default-src*'] }
  ]);
  const suspendedRules = sandbox.__buildRules(opts, false, true);
  assert.equal(suspendedRules.some(rule => rule.id === 2), false, 'suspension must preserve page CSP');
  assert.equal(suspendedRules.some(rule => rule.id === 10), false, 'suspension disables redirects');

  const excludedRules = sandbox.__buildRules({ ...opts, excludeDomains: 'excluded.example' }, false, false);
  const excludedCsp = excludedRules.find(rule => rule.id === 2);
  assert.deepEqual(JSON.parse(JSON.stringify(excludedCsp.condition.excludedRequestDomains)), ['excluded.example']);
  assert.deepEqual(JSON.parse(JSON.stringify(excludedCsp.condition.excludedInitiatorDomains)), ['excluded.example'],
    'a page on an excluded host must also keep CSP when it embeds a different host');
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
  const helpers = [extractFunction(prehook, 'isLocalFragmentReference'), extractFunction(prehook, 'cssUrls'), extractFunction(prehook, 'retryRules')].join('\n');
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

test('custom max width accepts only non-negative safe whole-pixel values', () => {
  const { fn: parseWidth } = functionFrom(optionsSource, 'parseCustomWidth');
  assert.equal(parseWidth('0'), 0);
  assert.equal(parseWidth('768'), 768);
  assert.equal(parseWidth('9007199254740991'), Number.MAX_SAFE_INTEGER);
  for (const invalid of ['', '  ', '-1', '1.5', '1e3', '9007199254740992', '999999999999999999999999999999']) {
    assert.equal(parseWidth(invalid), null, `${JSON.stringify(invalid)} must be rejected`);
  }
  assert.match(extractFunction(optionsSource, 'save'), /parseCustomWidth\(cw\) === null/,
    'save rejects values that cannot be represented exactly');
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

test('service worker retries session-bypass initialization after a transient rules read failure', async () => {
  let reads = 0;
  const existingRule = {
    id: 100010,
    condition: { urlFilter: '|https://cdn.example/existing.png|', tabIds: [7] }
  };
  const harness = functionFrom(serviceWorker, 'bypassReady', {
    BYPASS_BASE_ID: 100000,
    bypassInitialized: false,
    bypassInitPromise: null,
    bypassRules: new Map(),
    bypassRegexRules: new Set(),
    bypassNextId: 100000,
    bypassUrlFromRule(rule) { return String(rule.condition.urlFilter).replace(/^\||\|$/g, ''); },
    chrome: { declarativeNetRequest: { getSessionRules: async () => {
      reads++;
      if (reads === 1) throw new Error('temporary DNR failure');
      return [existingRule];
    } } }
  });

  const queue = functionFrom(serviceWorker, 'queueBypassOperation', {
    bypassChain: Promise.resolve(),
    bypassReady: harness.fn
  });
  let installed = 0;
  assert.equal(await queue.fn(() => { installed++; }, 'not-ready'), 'not-ready',
    'a failed rules read prevents a DNR update with unverified IDs');
  assert.equal(installed, 0);
  assert.equal(harness.sandbox.bypassInitPromise, null, 'the failed promise is not cached');
  assert.equal(await queue.fn(() => { installed++; return 'installed'; }, 'not-ready'), 'installed',
    'the next queued operation retries initialization and proceeds');
  assert.equal(installed, 1);
  assert.equal(reads, 2);
  assert.equal(harness.sandbox.bypassRules.get('7 https://cdn.example/existing.png'), 100010);
  assert.equal(harness.sandbox.bypassNextId, 100011, 'the next ID starts above recovered session rules');
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
  const sources = ['bypassCondition', 'bypassUrlFromRule', 'originalFromProxyUrl', 'queueBypassOperation', 'addBypass', 'scheduleFallback', 'markFallbackSeen', 'flushFallbacks']
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
    let bypassChain = Promise.resolve();
    let configuredProxyOrigin = "https://proxy.example";
    const CONFLICT_PATTERN = "&(?:quality|l|bw|jpeg|max_width)=";
    const PROXY_PARAMETER_RE = new RegExp(CONFLICT_PATTERN);
    function bypassReady() { return Promise.resolve(true); }
    ${sources[0]}
    ${sources[1]}
    ${sources[2]}
    ${sources[3]}
    ${sources[4]}
    let fallbackSeen = new Set();
    let fallbackPending = new Set();
    let fallbackBatch = new Map();
    let fallbackTimer = null;
    ${sources[5]}
    ${sources[6]}
    ${sources[7]}
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
  const runtimeHelpers = ['clearRuntimePublishRetry', 'scheduleRuntimePublishRetry', 'enqueueRuntimePublication', 'retryPendingRuntimePublication', 'publishRuntime']
    .map(name => extractFunction(serviceWorker, name)).join('\n');
  const sandbox = {
    Promise,
    chrome: {
      storage: { local: {
        get: (_defaults, callback) => reads.push(callback),
        set: (value, callback) => writes.push({ value, callback })
      } },
      alarms: { clear: () => Promise.resolve(true), create: () => Promise.resolve() }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    const RUNTIME_PUBLISH_RETRY_ALARM = "bh-runtime-publish-retry";
    const RUNTIME_PUBLISH_RETRY_INITIAL_DELAY_MS = 30000;
    const RUNTIME_PUBLISH_RETRY_MAX_DELAY_MS = 600000;
    let runtimePublishRetryDelay = RUNTIME_PUBLISH_RETRY_INITIAL_DELAY_MS;
    let lastRuntime = null;
    let pendingRuntime = null;
    let runtimePublishRevision = 0;
    let runtimeWriteQueue = Promise.resolve();
    ${runtimeHelpers}
    this.api = { publishRuntime, state: () => ({ lastRuntime, pendingRuntime }) };
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

test('runtime publication retries storage errors with an alarm and preserves pending transitions', async () => {
  const reads = [];
  const writes = [];
  const alarms = [];
  const clearedAlarms = [];
  let now = 100_000;
  const runtimeHelpers = ['clearRuntimePublishRetry', 'scheduleRuntimePublishRetry', 'enqueueRuntimePublication', 'retryPendingRuntimePublication', 'publishRuntime']
    .map(name => extractFunction(serviceWorker, name)).join('\n');
  const alarmListenerSource = serviceWorker.slice(
    serviceWorker.indexOf('chrome.alarms?.onAlarm?.addListener'),
    serviceWorker.indexOf('\n\nfunction readSuspended')
  );
  const sandbox = {
    Promise,
    Date: { now: () => now },
    chrome: {
      runtime: { lastError: null },
      storage: { local: {
        get: (_defaults, callback) => reads.push(callback),
        set: (value, callback) => writes.push({ value, callback })
      } },
      alarms: {
        create: (name, info) => { alarms.push({ name, ...info }); return Promise.resolve(); },
        clear: name => { clearedAlarms.push(name); return Promise.resolve(true); },
        onAlarm: { addListener: () => {} }
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    const SETTINGS_READ_RETRY_ALARM = 'bh-settings-read-retry';
    const BREAKER_ALARM = 'bh-breaker-resume';
    const BREAKER_READ_RETRY_ALARM = 'bh-breaker-read-retry';
    const RUNTIME_PUBLISH_RETRY_ALARM = 'bh-runtime-publish-retry';
    const RUNTIME_PUBLISH_RETRY_INITIAL_DELAY_MS = 30000;
    const RUNTIME_PUBLISH_RETRY_MAX_DELAY_MS = 600000;
    let runtimePublishRetryDelay = RUNTIME_PUBLISH_RETRY_INITIAL_DELAY_MS;
    let lastRuntime = null;
    let pendingRuntime = null;
    let runtimePublishRevision = 0;
    let runtimeWriteQueue = Promise.resolve();
    let alarmListener = null;
    chrome.alarms.onAlarm.addListener = callback => { alarmListener = callback; };
    function refreshRules() {}
    function resumeBreakerIfExpired() {}
    ${runtimeHelpers}
    ${alarmListenerSource}
    this.api = { publishRuntime, state: () => ({ lastRuntime, pendingRuntime }), retryDelay: () => runtimePublishRetryDelay,
      fireRetry: () => alarmListener({ name: RUNTIME_PUBLISH_RETRY_ALARM }) };
  `, sandbox);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const snapshot = () => JSON.parse(JSON.stringify(sandbox.api.state()));
  const original = { redirect: true, suspended: false };

  // A failed storage read retains the requested state and schedules a durable alarm.
  sandbox.api.publishRuntime(original);
  await tick();
  assert.equal(reads.length, 1);
  sandbox.chrome.runtime.lastError = { message: 'temporary read failure' };
  reads[0]({ bhRuntime: null });
  sandbox.chrome.runtime.lastError = null;
  await tick();
  assert.deepEqual(snapshot(), { lastRuntime: null, pendingRuntime: original });
  assert.deepEqual(alarms.at(-1), { name: 'bh-runtime-publish-retry', when: now + 30_000 });
  assert.equal(sandbox.api.retryDelay(), 60_000, 'the next retry delay grows exponentially');

  // The actual alarm listener must retry the latest pending state.
  sandbox.api.fireRetry();
  await tick();
  assert.equal(reads.length, 2, 'the retry alarm performs another storage read');
  reads[1]({ bhRuntime: null });
  await tick();
  assert.equal(writes.length, 1);
  sandbox.chrome.runtime.lastError = { message: 'temporary write failure' };
  writes[0].callback();
  sandbox.chrome.runtime.lastError = null;
  await tick();
  assert.deepEqual(snapshot(), { lastRuntime: null, pendingRuntime: original });
  assert.deepEqual(alarms.at(-1), { name: 'bh-runtime-publish-retry', when: now + 60_000 });
  assert.equal(sandbox.api.retryDelay(), 120_000);

  // A successful retry confirms the state, clears the alarm and resets backoff.
  sandbox.api.fireRetry();
  await tick();
  assert.equal(reads.length, 3);
  reads[2]({ bhRuntime: null });
  await tick();
  assert.equal(writes.length, 2);
  writes[1].callback();
  await tick();
  assert.deepEqual(snapshot(), { lastRuntime: original, pendingRuntime: null });
  assert.equal(sandbox.api.retryDelay(), 30_000);
  assert.ok(clearedAlarms.includes('bh-runtime-publish-retry'), 'confirmed publication clears the pending retry alarm');

  // If B is in flight, a request to return to confirmed A must queue behind B.
  const changed = { redirect: false, suspended: true };
  sandbox.api.publishRuntime(changed);
  await tick();
  assert.equal(reads.length, 4);
  reads[3]({ bhRuntime: original });
  await tick();
  assert.equal(writes.length, 3);
  sandbox.api.publishRuntime(original);
  await tick();
  assert.equal(reads.length, 4, 'return-to-A waits for the outstanding B write');
  writes[2].callback();
  await tick();
  assert.equal(reads.length, 5, 'return-to-A is read after B completes');
  reads[4]({ bhRuntime: changed });
  await tick();
  assert.equal(writes.length, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[3].value)), { bhRuntime: original });
  writes[3].callback();
  await tick();
  assert.deepEqual(snapshot(), { lastRuntime: original, pendingRuntime: null });
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
    let statsStartupRetryTimer = null;
    let statsMirrorRetryDelay = 1000;
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
    let statsStartupRetryTimer = null;
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
  assert.deepEqual(scheduled.map(item => item.delay).sort((a, b) => a - b), [250, 750],
    'the crash journal is scheduled before the normal flush after startup');
});

test('service worker retries failed startup reads without overwriting the old journal', () => {
  const helpers = ['finishStatsStartup', 'retryStatsStartup', 'recoverStatsStartup', 'restorePendingStats']
    .map(name => extractFunction(serviceWorker, name)).join('\n');
  const scheduled = [];
  const reads = [];
  const writes = [];
  const mirrored = [];
  const flushed = [];
  const sandbox = {
    setTimeout: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; },
    clearTimeout: () => {},
    chrome: {
      runtime: { lastError: null },
      storage: { local: {
        get: (defaults, callback) => reads.push({ defaults, callback }),
        set: (value, callback) => writes.push({ value, callback }),
        remove: (_key, callback) => callback()
      } }
    },
    mirrored, flushed
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    const ZERO_STATS = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
    let pendingStats = { filesProcessed: 1, bytesProcessed: 10, bytesSaved: 2 };
    let statsStartupWriteInProgress = true;
    let statsStartupRetryTimer = null, statsStartupRetryDelay = 1000;
    let statsResetPending = false, statsResetInProgress = false;
    let statsFlushTimer = null, statsMirrorTimer = null;
    let statsFlushInProgress = false, statsMirrorWriteInProgress = false;
    let statsRevision = 0;
    const startupStatsRevision = statsRevision;
    const hasPendingStats = () => !!(pendingStats.filesProcessed || pendingStats.bytesProcessed || pendingStats.bytesSaved);
    const mirrorPendingStats = () => { if (!statsStartupWriteInProgress) mirrored.push({ ...pendingStats }); };
    const scheduleStatsFlush = () => { if (!statsStartupWriteInProgress) flushed.push({ ...pendingStats }); };
    const finishStatsResetIfReady = () => {};
    ${helpers}
    this.api = {
      recoverStatsStartup,
      state: () => ({ startup: statsStartupWriteInProgress, pending: { ...pendingStats }, retryTimer: statsStartupRetryTimer })
    };
  `, sandbox);

  sandbox.api.recoverStatsStartup();
  assert.equal(reads.length, 1);
  sandbox.chrome.runtime.lastError = { message: 'startup read failed' };
  reads[0].callback(undefined);
  sandbox.chrome.runtime.lastError = null;
  assert.equal(sandbox.api.state().startup, true, 'startup remains gated while an older journal may exist');
  assert.equal(writes.length, 0, 'no new journal can overwrite the unread recovery journal');
  assert.deepEqual(scheduled.map(item => item.delay), [1000], 'a bounded retry is scheduled');

  scheduled[0].callback();
  assert.equal(reads.length, 2, 'the startup read is retried');
  reads[1].callback({
    stats: { filesProcessed: 5, bytesProcessed: 50, bytesSaved: 25 },
    statsPending: { filesProcessed: 3, bytesProcessed: 30, bytesSaved: 15 }
  });
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].value)), {
    stats: { filesProcessed: 8, bytesProcessed: 80, bytesSaved: 40 },
    statsPending: { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 }
  }, 'the retry merges the older journal before enabling new writes');
  writes[0].callback();
  assert.equal(sandbox.api.state().startup, false);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.api.state().pending)), {
    filesProcessed: 1, bytesProcessed: 10, bytesSaved: 2
  }, 'activity collected during recovery remains pending');
  assert.equal(sandbox.mirrored.length, 1);
  assert.equal(sandbox.flushed.length, 1);
});

test('service worker writes the stats crash journal before flushing and catches activity added during the journal write', () => {
  const helpers = ['flushStats', 'scheduleStatsFlush', 'mirrorPendingStats', 'recordStats']
    .map(name => extractFunction(serviceWorker, name)).join('\n');
  const scheduled = [];
  const writes = [];
  const reads = [];
  const sandbox = {
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
    chrome: { storage: { local: {
      get: (defaults, callback) => reads.push({ defaults, callback }),
      set: (value, callback) => writes.push({ value, callback })
    } } }
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    const ZERO_STATS = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
    let pendingStats = { ...ZERO_STATS };
    let statsFlushTimer = null, statsMirrorTimer = null;
    let statsFlushInProgress = false, statsMirrorWriteInProgress = false;
    let statsStartupWriteInProgress = false;
    let statsResetPending = false, statsResetInProgress = false;
    const hasPendingStats = () => !!(pendingStats.filesProcessed || pendingStats.bytesProcessed || pendingStats.bytesSaved);
    const finishStatsResetIfReady = () => {};
    ${helpers}
    this.api = { recordStats, state: () => ({ ...pendingStats }) };
  `, sandbox);

  const runTimer = delay => {
    const timer = scheduled.find(item => !item.cleared && item.delay === delay);
    assert.ok(timer, `expected a scheduled ${delay}ms timer`);
    timer.cleared = true;
    timer.callback();
  };

  sandbox.api.recordStats(128, 64);
  assert.deepEqual(scheduled.filter(item => !item.cleared).map(item => item.delay).sort((a, b) => a - b), [250, 750],
    'the crash journal is scheduled before the batched flush');
  runTimer(250);
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].value.statsPending)), {
    filesProcessed: 1, bytesProcessed: 128, bytesSaved: 64
  });

  // A second event arrives while the first journal write is still pending.
  sandbox.api.recordStats(256, 128);
  runTimer(750);
  assert.equal(reads.length, 0, 'the stats flush waits for the in-flight journal write');
  writes[0].callback();
  runTimer(250);
  assert.equal(writes.length, 2, 'the newer activity receives an updated journal snapshot');
  assert.deepEqual(JSON.parse(JSON.stringify(writes[1].value.statsPending)), {
    filesProcessed: 2, bytesProcessed: 384, bytesSaved: 192
  });
  writes[1].callback();

  runTimer(750);
  assert.equal(reads.length, 1, 'the flush starts only after the latest journal commit');
  reads[0].callback({ stats: { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 } });
  assert.equal(writes.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[2].value)), {
    stats: { filesProcessed: 2, bytesProcessed: 384, bytesSaved: 192 },
    statsPending: { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 }
  }, 'the final batch is committed while its recovery journal is cleared atomically');
  writes[2].callback();
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.api.state())), {
    filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0
  });
});

test('service worker retries failed stats journal writes with bounded backoff', () => {
  const helper = extractFunction(serviceWorker, 'mirrorPendingStats');
  const scheduled = [];
  const writes = [];
  const sandbox = {
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
    chrome: {
      runtime: { lastError: null },
      storage: { local: { set: (value, callback) => writes.push({ value, callback }) } }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    let pendingStats = { filesProcessed: 2, bytesProcessed: 256, bytesSaved: 128 };
    let statsMirrorTimer = null, statsMirrorWriteInProgress = false;
    let statsFlushInProgress = false, statsStartupWriteInProgress = false;
    let statsResetPending = false, statsResetInProgress = false;
    let statsMirrorRetryDelay = 1000;
    const hasPendingStats = () => !!(pendingStats.filesProcessed || pendingStats.bytesProcessed || pendingStats.bytesSaved);
    const finishStatsResetIfReady = () => {};
    const scheduleStatsFlush = () => {};
    ${helper}
    this.api = { mirrorPendingStats, state: () => ({
      pending: { ...pendingStats }, writing: statsMirrorWriteInProgress,
      retryDelay: statsMirrorRetryDelay
    }) };
  `, sandbox);

  const runNextTimer = expectedDelay => {
    const timer = scheduled.find(item => !item.cleared);
    assert.ok(timer, `expected a pending ${expectedDelay}ms retry`);
    assert.equal(timer.delay, expectedDelay);
    timer.cleared = true;
    timer.callback();
  };

  sandbox.api.mirrorPendingStats();
  runNextTimer(250);
  assert.equal(writes.length, 1);
  sandbox.chrome.runtime.lastError = { message: 'journal write failed' };
  writes[0].callback();
  sandbox.chrome.runtime.lastError = null;
  assert.equal(sandbox.api.state().writing, false);
  assert.equal(sandbox.api.state().retryDelay, 2000);
  runNextTimer(1000);
  assert.equal(writes.length, 2, 'the journal write is retried');

  sandbox.chrome.runtime.lastError = { message: 'journal write still failing' };
  writes[1].callback();
  sandbox.chrome.runtime.lastError = null;
  assert.equal(sandbox.api.state().retryDelay, 4000);
  runNextTimer(2000);
  assert.equal(writes.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[2].value.statsPending)), {
    filesProcessed: 2, bytesProcessed: 256, bytesSaved: 128
  });
  writes[2].callback();
  assert.equal(sandbox.api.state().retryDelay, 1000, 'successful journaling resets the backoff');
  assert.equal(sandbox.api.state().writing, false);
  assert.equal(scheduled.filter(item => !item.cleared).length, 0);
});

test('stats flush waits for journal completion without polling', () => {
  const helpers = ['flushStats', 'scheduleStatsFlush', 'mirrorPendingStats']
    .map(name => extractFunction(serviceWorker, name)).join('\n');
  const scheduled = [];
  const writes = [];
  const reads = [];
  const sandbox = {
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
    chrome: {
      runtime: { lastError: null },
      storage: { local: {
        get: (...args) => reads.push(args),
        set: (value, callback) => writes.push({ value, callback })
      } }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    const ZERO_STATS = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
    let pendingStats = { filesProcessed: 1, bytesProcessed: 128, bytesSaved: 64 };
    let statsFlushTimer = null, statsFlushInProgress = false;
    let statsMirrorTimer = null, statsMirrorWriteInProgress = false;
    let statsMirrorRetryDelay = 1000, statsStartupWriteInProgress = false;
    let statsResetPending = false, statsResetInProgress = false;
    const hasPendingStats = () => !!(pendingStats.filesProcessed || pendingStats.bytesProcessed || pendingStats.bytesSaved);
    const restorePendingStats = () => {};
    const finishStatsResetIfReady = () => {};
    ${helpers}
    this.api = { flushStats, mirrorPendingStats };
  `, sandbox);

  const runNextTimer = expectedDelay => {
    const timer = scheduled.find(item => !item.cleared);
    assert.ok(timer, `expected a pending ${expectedDelay}ms timer`);
    assert.equal(timer.delay, expectedDelay);
    timer.cleared = true;
    timer.callback();
  };

  sandbox.api.mirrorPendingStats();
  runNextTimer(250);
  assert.equal(writes.length, 1);
  sandbox.api.flushStats();
  assert.equal(reads.length, 0, 'flush does not race the in-flight journal write');
  assert.equal(scheduled.filter(item => !item.cleared).length, 0,
    'flush does not create a repeating polling timer');

  writes[0].callback();
  assert.equal(reads.length, 0, 'the journal callback wakes the normal flush timer, not storage immediately');
  const pendingTimers = scheduled.filter(item => !item.cleared);
  assert.equal(pendingTimers.length, 1);
  assert.equal(pendingTimers[0].delay, 750);
});

test('service worker restores stats batches when storage reads or commits fail', () => {
  const helpers = ['restorePendingStats', 'flushStats', 'scheduleStatsFlush', 'mirrorPendingStats']
    .map(name => extractFunction(serviceWorker, name)).join('\n');

  const runScenario = failAt => {
    const scheduled = [];
    const reads = [];
    const writes = [];
    const sandbox = {
      setTimeout: (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        scheduled.push(timer);
        return timer;
      },
      clearTimeout: timer => { if (timer) timer.cleared = true; },
      chrome: {
        runtime: { lastError: null },
        storage: { local: {
          get: (_defaults, callback) => reads.push(callback),
          set: (value, callback) => writes.push({ value, callback })
        } }
      }
    };
    vm.createContext(sandbox);
    vm.runInContext(`
      const ZERO_STATS = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
      let pendingStats = { filesProcessed: 1, bytesProcessed: 128, bytesSaved: 64 };
      let statsFlushTimer = null, statsMirrorTimer = null;
      let statsFlushInProgress = false, statsMirrorWriteInProgress = false;
      let statsStartupWriteInProgress = false;
      let statsResetPending = false, statsResetInProgress = false;
      const hasPendingStats = () => !!(pendingStats.filesProcessed || pendingStats.bytesProcessed || pendingStats.bytesSaved);
      const finishStatsResetIfReady = () => {};
      ${helpers}
      this.api = {
        flushStats,
        state: () => ({ ...pendingStats })
      };
    `, sandbox);

    const runTimer = delay => {
      const timer = scheduled.find(item => !item.cleared && item.delay === delay);
      assert.ok(timer, `expected a pending ${delay}ms timer`);
      timer.cleared = true;
      timer.callback();
    };

    sandbox.api.flushStats();
    assert.equal(reads.length, 1);
    if (failAt === 'read') {
      sandbox.chrome.runtime.lastError = { message: 'read failed' };
      reads[0]({ stats: { filesProcessed: 5, bytesProcessed: 10, bytesSaved: 5 } });
      sandbox.chrome.runtime.lastError = null;
    } else {
      reads[0]({ stats: { filesProcessed: 5, bytesProcessed: 10, bytesSaved: 5 } });
      assert.equal(writes.length, 1);
      sandbox.chrome.runtime.lastError = { message: 'write failed' };
      writes[0].callback();
      sandbox.chrome.runtime.lastError = null;
    }

    assert.deepEqual(JSON.parse(JSON.stringify(sandbox.api.state())), {
      filesProcessed: 1, bytesProcessed: 128, bytesSaved: 64
    }, `${failAt} failure must restore the uncommitted batch`);
    runTimer(250);
    assert.equal(writes.length, failAt === 'read' ? 1 : 2, 'the restored batch is journaled');
    const journal = writes.at(-1);
    assert.deepEqual(JSON.parse(JSON.stringify(journal.value.statsPending)), {
      filesProcessed: 1, bytesProcessed: 128, bytesSaved: 64
    });
    journal.callback();

    runTimer(750);
    assert.equal(reads.length, 2, 'the batch is retried after the journal write');
    reads[1]({ stats: { filesProcessed: 5, bytesProcessed: 10, bytesSaved: 5 } });
    const commit = writes.at(-1);
    assert.deepEqual(JSON.parse(JSON.stringify(commit.value)), {
      stats: { filesProcessed: 6, bytesProcessed: 138, bytesSaved: 69 },
      statsPending: { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 }
    });
    commit.callback();
    assert.deepEqual(JSON.parse(JSON.stringify(sandbox.api.state())), {
      filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0
    });
  };

  runScenario('read');
  runScenario('write');
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

test('a successful proxy response without Content-Type is not counted or redundantly retried', () => {
  const calls = [];
  const sandbox = {
    isGuardianProxyUrl(url) { return String(url).startsWith('https://proxy.example/'); },
    headerMap(headers) {
      return new Map((headers || []).map(header => [String(header.name).toLowerCase(), header.value]));
    },
    noteGlobalProxyFailure() { calls.push('breaker'); },
    noteProxyResponse() { calls.push('response'); },
    scheduleFallback() { calls.push('fallback'); },
    IMAGE_CONTENT_TYPES: new Set(['image/jpeg']),
    getProxyResponseStats() { return { received: 100, saved: 20 }; },
    recordStats() { calls.push('stats'); }
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction(serviceWorker, 'handleProxyCompleted')}\nthis.run = handleProxyCompleted;`, sandbox);

  sandbox.run({
    url: 'https://proxy.example/convert?url=https://origin.example/photo.jpg',
    statusCode: 200,
    responseHeaders: []
  });
  assert.deepEqual(calls, ['response'],
    'an unknown MIME type confirms proxy reachability but is neither counted nor treated as an explicit non-image response');
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
  vm.runInContext(`const SETTINGS_READ_RETRY_ALARM = 'bh-settings-read-retry';\n${constants}\nlet breakerFailures = [];\nlet breakerFallbackUntil = 0;\n${extractFunction(serviceWorker, 'noteProxyResponse')}\n${extractFunction(serviceWorker, 'scheduleBreakerResume')}\n${extractFunction(serviceWorker, 'noteGlobalProxyFailure')}\n${extractFunction(serviceWorker, 'handleProxyCompleted')}\nthis.api = { fail: noteGlobalProxyFailure, completed: handleProxyCompleted };`, sandbox);

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
  vm.runInContext(`const SETTINGS_READ_RETRY_ALARM = 'bh-settings-read-retry';\n${constants}\nlet breakerFailures = [];\nlet breakerFallbackUntil = 0;\n${extractFunction(serviceWorker, 'noteProxyResponse')}\n${extractFunction(serviceWorker, 'noteGlobalProxyFailure')}\n${extractFunction(serviceWorker, 'scheduleBreakerResume')}\n${extractFunction(serviceWorker, 'resumeBreakerIfExpired')}\n${alarmListener}\nthis.api = { fail: noteGlobalProxyFailure, response: noteProxyResponse };`, sandbox);

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

test('an unreadable breaker state disables proxying and retries rule refresh with backoff', () => {
  const constantsStart = serviceWorker.indexOf('const BREAKER_THRESHOLD');
  const constantsEnd = serviceWorker.indexOf('let breakerFailures', constantsStart);
  assert.ok(constantsStart >= 0 && constantsEnd > constantsStart, 'breaker constants exist');
  const constants = serviceWorker.slice(constantsStart, constantsEnd);
  const retryFunction = extractFunction(serviceWorker, 'scheduleBreakerReadRetry');
  const readFunction = extractFunction(serviceWorker, 'readSuspended');
  const listenerStart = serviceWorker.indexOf('chrome.alarms?.onAlarm?.addListener');
  const listenerEnd = serviceWorker.indexOf('\n\nfunction readSuspended', listenerStart);
  assert.ok(listenerStart >= 0 && listenerEnd > listenerStart, 'breaker alarm listener exists');
  const listener = serviceWorker.slice(listenerStart, listenerEnd);

  let now = 5000;
  let readFails = true;
  let listenerCallback = null;
  let refreshes = 0;
  const alarms = [];
  const clears = [];
  const sandbox = {
    Date: { now: () => now },
    chrome: {
      runtime: { lastError: { message: 'temporary storage failure' } },
      storage: { session: { get(_defaults, callback) {
        callback(readFails ? undefined : { bhSuspendedUntil: 0 });
      } } },
      alarms: {
        create(name, info) { alarms.push({ name, ...info }); },
        clear(name) { clears.push(name); },
        onAlarm: { addListener(callback) { listenerCallback = callback; } }
      }
    },
    refreshRules() { refreshes++; }
  };
  vm.createContext(sandbox);
  vm.runInContext(`const SETTINGS_READ_RETRY_ALARM = 'bh-settings-read-retry';\n${constants}\nlet breakerFailures = [];\nlet breakerFallbackUntil = 0;\nlet breakerReadRetryDelay = 1000;\n${retryFunction}\n${readFunction}\n${listener}\nthis.read = readSuspended;`, sandbox);

  let suspended = false;
  sandbox.read(value => { suspended = value; });
  assert.equal(suspended, true, 'a failed session-storage read fails safe and keeps proxy redirects off');
  assert.deepEqual(alarms, [{ name: 'bh-breaker-read-retry', when: now + 1000 }]);

  // Repeated failures back off instead of polling storage every second forever.
  now += 1000;
  sandbox.read(() => {});
  assert.deepEqual(alarms.at(-1), { name: 'bh-breaker-read-retry', when: now + 2000 });

  // Once storage recovers, the dedicated retry alarm rebuilds rules and a
  // successful read clears the retry alarm and resets its backoff.
  readFails = false;
  sandbox.chrome.runtime.lastError = null;
  listenerCallback({ name: 'bh-breaker-read-retry' });
  assert.equal(refreshes, 1, 'the read-retry alarm refreshes DNR rules');
  suspended = true;
  sandbox.read(value => { suspended = value; });
  assert.equal(suspended, false, 'a successful read restores the stored active/inactive state');
  assert.deepEqual(clears, ['bh-breaker-read-retry']);
  now += 1000;
  sandbox.read(() => {});
  assert.deepEqual(alarms.at(-1), { name: 'bh-breaker-read-retry', when: now + 1000 }, 'success resets the retry delay');

  // A synchronous API throw uses the same fail-safe retry path.
  sandbox.chrome.storage.session.get = () => { throw new Error('storage API unavailable'); };
  suspended = false;
  sandbox.read(value => { suspended = value; });
  assert.equal(suspended, true);
  assert.deepEqual(alarms.at(-1), { name: 'bh-breaker-read-retry', when: now + 1000 });
});

test('a failed session-storage breaker write still suspends redirects until the cooldown expires', () => {
  const constantsStart = serviceWorker.indexOf('const BREAKER_THRESHOLD');
  const constantsEnd = serviceWorker.indexOf('let breakerFailures', constantsStart);
  assert.ok(constantsStart >= 0 && constantsEnd > constantsStart, 'breaker constants exist');
  const constants = serviceWorker.slice(constantsStart, constantsEnd);
  const retryFunction = extractFunction(serviceWorker, 'scheduleBreakerReadRetry');
  const readFunction = extractFunction(serviceWorker, 'readSuspended');
  const alarmStart = serviceWorker.indexOf('chrome.alarms?.onAlarm?.addListener');
  const alarmEnd = serviceWorker.indexOf('\n\nfunction readSuspended', alarmStart);
  assert.ok(alarmStart >= 0 && alarmEnd > alarmStart, 'breaker alarm listener exists');
  const alarmListener = serviceWorker.slice(alarmStart, alarmEnd);

  let now = 90_000;
  const alarms = [];
  const stored = {};
  const states = [];
  const removed = [];
  const pendingSetCallbacks = [];
  let onAlarm = null;
  const chrome = {
    runtime: { lastError: null },
    storage: { session: {
      set(_value, callback) { pendingSetCallbacks.push(callback); },
      get(_defaults, callback) { callback({ bhSuspendedUntil: stored.bhSuspendedUntil || 0 }); },
      remove(key, callback) { delete stored[key]; removed.push(key); callback(); }
    } },
    alarms: {
      create(name, info) { alarms.push({ name, ...info }); },
      clear() {},
      onAlarm: { addListener(callback) { onAlarm = callback; } }
    }
  };
  const sandbox = {
    Date: { now: () => now }, chrome,
    refreshRules() { sandbox.read(value => states.push(value)); }
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    const SETTINGS_READ_RETRY_ALARM = 'bh-settings-read-retry';
    ${constants}
    let breakerFailures = [];
    let breakerFallbackUntil = 0;
    let breakerReadRetryDelay = 1000;
    ${retryFunction}
    ${readFunction}
    ${extractFunction(serviceWorker, 'scheduleBreakerResume')}
    ${extractFunction(serviceWorker, 'noteGlobalProxyFailure')}
    ${extractFunction(serviceWorker, 'resumeBreakerIfExpired')}
    ${alarmListener}
    this.fail = noteGlobalProxyFailure;
    this.read = readSuspended;
    this.snapshot = () => breakerFallbackUntil;
  `, sandbox);

  sandbox.fail();
  now += 1000;
  sandbox.fail();
  const deadline = now + 40_000;
  assert.equal(sandbox.snapshot(), deadline, 'the in-memory suspension floor is established before the async write settles');
  assert.equal(stored.bhSuspendedUntil, undefined, 'the simulated storage write has not persisted');
  assert.equal(pendingSetCallbacks.length, 1, 'the session write remains pending');
  let suspendedDuringWrite = false;
  sandbox.read(value => { suspendedDuringWrite = value; });
  assert.equal(suspendedDuringWrite, true, 'a concurrent rule refresh cannot re-enable redirects while storage is pending');
  chrome.runtime.lastError = { message: 'session storage write failed' };
  pendingSetCallbacks.shift()();
  chrome.runtime.lastError = null;
  assert.deepEqual(states, [true], 'the failed-write callback refresh keeps redirects disabled');
  assert.deepEqual(alarms.filter(a => a.name === 'bh-breaker-resume'), [
    { name: 'bh-breaker-resume', when: deadline + 50 }
  ]);

  now = deadline + 50;
  onAlarm({ name: 'bh-breaker-resume' });
  assert.equal(sandbox.snapshot(), 0, 'the volatile fail-safe clears after its cooldown');
  assert.deepEqual(states, [true, false], 'normal redirects may return only after the cooldown expires');
  assert.deepEqual(removed, [], 'no storage key is removed when the failed write created none');

  // If the worker was restarted before this alarm fired, its in-memory floor
  // is gone. The alarm must still refresh the rules instead of leaving them
  // permanently suspended because session storage has no key.
  onAlarm({ name: 'bh-breaker-resume' });
  assert.deepEqual(states, [true, false, false], 'a no-state expiry alarm still rebuilds current rules after worker restart');
});

test('breaker resume scheduling consumes rejected Promise results from the alarms API', () => {
  let handled = false;
  let created = null;
  const harness = functionFrom(serviceWorker, 'scheduleBreakerResume', {
    BREAKER_ALARM: 'bh-breaker-resume',
    chrome: { alarms: { create(name, info) {
      created = { name, ...info };
      return { catch(onRejected) {
        handled = true;
        onRejected(new Error('alarm creation rejected'));
      } };
    } } }
  });

  harness.fn(123456);
  assert.deepEqual(created, { name: 'bh-breaker-resume', when: 123456 });
  assert.equal(handled, true, 'a Promise-based alarm failure is handled instead of becoming unhandled');
});

test('a src assigned after a rewritten srcset restores the original candidates, not proxy URLs', () => {
  const h = createDomHarness();
  h.publishSettings({ redirect: false });
  const img = new h.HTMLImageElement();
  const candidate = 'https://cdn.example/lazy/a.jpg?w=40&quality=80';
  img.srcset = `${candidate} 1x`;
  assertProxied(img.getAttribute('srcset').split(' ')[0], candidate);

  // A lazy loader commonly assigns srcset first and src second.
  img.src = 'https://cdn.example/lazy/main.jpg';
  img.currentSrc = img.getAttribute('src');
  img.dispatchEvent({ type: 'error' });
  const [, timer] = [...h.timerCallbacks.entries()].filter(([, entry]) => entry.delay === 1500).at(-1);
  timer.callback();

  assert.equal(img.getAttribute('srcset'), `${candidate} 1x`,
    'the restore must use the original candidate, never the proxy URL the page already received');
});

test('bypass eviction only starts when the live bypass table is actually full', async () => {
  const sources = ['bypassCondition', 'bypassUrlFromRule', 'queueBypassOperation', 'addBypass'].map(name => extractFunction(serviceWorker, name));
  const removed = [];
  const sandbox = {
    Promise, Number, JSON, Error, Set, Map, RegExp, URL, decodeURIComponent,
    chrome: { declarativeNetRequest: { updateSessionRules: async update => {
      removed.push(...(update.removeRuleIds || []));
    } } }
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    const PROXY_REQUEST_TYPES = ["image", "object"];
    const PRIORITY_BYPASS = 4;
    const BYPASS_BASE_ID = 100000;
    const BYPASS_LIMIT = 3000;
    const BYPASS_REGEX_LIMIT = 900;
    const BYPASSABLE_URL_RE = /^https?:\\/\\/[\\x21-\\x7e]+$/;
    const MAX_BYPASS_REGEX_LENGTH = 1900;
    let bypassRules = new Map();
    let bypassRegexRules = new Set();
    let bypassNextId = BYPASS_BASE_ID;
    let bypassChain = Promise.resolve();
    const bypassReady = () => Promise.resolve(true);
    ${sources.join('\n')}
    this.add = addBypass;
    this.size = () => bypassRules.size;
    this.keys = () => Array.from(bypassRules.keys());
  `, sandbox);

  // The cap is global even though each installed rule is tab-scoped.
  const firstTab = Array.from({ length: 1500 }, (_, i) => `https://cdn.example/tab-7/${i}.png`);
  const secondTab = Array.from({ length: 1500 }, (_, i) => `https://cdn.example/tab-8/${i}.png`);
  assert.equal((await sandbox.add(7, firstTab)).length, 1500);
  assert.equal((await sandbox.add(8, secondTab)).length, 1500);
  assert.equal(sandbox.size(), 3000, 'the extension-wide live table reaches its global cap');
  assert.deepEqual(removed, [], 'no bypass is evicted while global capacity remains');

  await sandbox.add(9, ['https://cdn.example/tab-9/new.png']);
  assert.equal(sandbox.size(), 3000, 'adding another tab cannot exceed the global table cap');
  assert.deepEqual(removed, [100000], 'the oldest rule is evicted globally only when the table is full');
  assert.equal(sandbox.keys()[0], `7 https://cdn.example/tab-7/1.png`, 'the next-oldest tab-scoped bypass remains installed');
});

test('custom badges are static siblings of the preset grids, never appended grid children', () => {
  // Returns the markup inside the <div id="..."> element, matching nested divs.
  const innerOf = (html, id) => {
    const open = html.indexOf(`id="${id}"`);
    assert.ok(open >= 0, `#${id} exists`);
    const start = html.indexOf('>', open) + 1;
    let depth = 1;
    const re = /<\/?div\b/g;
    re.lastIndex = start;
    let m;
    while ((m = re.exec(html))) {
      depth += m[0] === '</div' ? -1 : 1;
      if (depth === 0) return html.slice(start, m.index);
    }
    assert.fail(`#${id} is not closed`);
  };
  for (const file of ['popup.html', 'options.html']) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(innerOf(html, 'qualityPresets'), /custom-badge/, `${file}: quality badge is outside its grid`);
    assert.match(html, /class="[^"]*custom-badge[^"]*" id="qualityCustom" hidden>Custom</, `${file}: quality badge is static and hidden by default`);
  }
  const optionsHtml = fs.readFileSync(path.join(ROOT, 'options.html'), 'utf8');
  assert.doesNotMatch(innerOf(optionsHtml, 'widthPresets'), /custom-badge/, 'width badge is outside its grid');
  assert.match(optionsHtml, /id="widthCustom" hidden>Custom</);
  for (const source of [popupSource, optionsSource]) {
    assert.doesNotMatch(source, /appendChild\(badge\)|createElement\("span"\)/, 'badges are no longer created at runtime');
  }
});

test('retry re-requests the original URL when an img attribute still holds a proxy URL', () => {
  const sandbox = {
    URL,
    safeURL(value, base) { try { return new URL(value, base); } catch { return null; } }
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction(prehook, 'parseSrcset'),
    extractFunction(prehook, 'directUrlFor'),
    extractFunction(prehook, 'directSrcset')
  ].join('\n') + '\nthis.direct = directUrlFor; this.directSet = directSrcset;', sandbox);

  const original = 'https://cdn.example/retry/a.png?w=40&quality=80';
  const proxy = `https://proxy.example/convert?url=${encodeURIComponent(original)}&jpeg=0&bw=0&quality=60`;
  const map = new Map([[proxy, original]]);
  assert.equal(sandbox.direct(proxy, 'https://page.example/', map), original, 'a proxy src maps back to its original');
  assert.equal(sandbox.direct('https://cdn.example/other.png', 'https://page.example/', map), 'https://cdn.example/other.png',
    'unrelated URLs are untouched');
  assert.equal(sandbox.directSet(`${proxy} 1x, https://cdn.example/other.png 2x`, 'https://page.example/', map),
    `${original} 1x, https://cdn.example/other.png 2x`, 'only proxy candidates are restored and descriptors kept');
});

test('CI repository write permission is limited to the release job', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/build.yml'), 'utf8');
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s*read\s*$/m,
    'workflow defaults to read-only repository access');
  assert.doesNotMatch(workflow, /^permissions:\s*\n\s+contents:\s*write\s*$/m,
    'write access must not be granted at workflow scope');
  const releaseJob = workflow.match(/^  release:\s*\n([\s\S]*)$/m)?.[1] || '';
  assert.match(releaseJob, /^    permissions:\s*\n\s+contents:\s*write\s*$/m,
    'only the publishing job receives permission to upload a release');
  const testAndBuildJobs = workflow.match(/^  test:[\s\S]*?^  release:/m)?.[0] || '';
  assert.doesNotMatch(testAndBuildJobs, /contents:\s*write/,
    'test/build jobs cannot mutate repository contents');
});


test('Keep-Fork-Alive repository write permission is limited to its commit job', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/Keep-Alive.yml'), 'utf8');
  assert.doesNotMatch(workflow, /^permissions:\s*\n\s+contents:\s*write\s*$/m,
    'write access must not be granted at workflow scope');
  const keepAliveJob = workflow.match(/^  keep-alive:\s*\n([\s\S]*)$/m)?.[1] || '';
  assert.match(keepAliveJob, /^    permissions:\s*\n\s+contents:\s*write\s*$/m,
    'the commit job alone receives permission to push the keep-alive update');
});
