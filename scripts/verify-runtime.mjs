import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { install, prepareBundle } = require('./plugin-access-hook.cjs');
const fixture = fs.readFileSync(new URL('../tests/fixtures/frontend.js', import.meta.url), 'utf8');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-runtime-tests-'));
const hash = source => crypto.createHash('sha256').update(source).digest('hex');

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? files(filename) : [filename];
  });
}

async function eventually(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Expected asynchronous alert did not arrive');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function harness({ directory, prepare, response = 1 } = {}) {
  const app = new EventEmitter();
  const alerts = [];
  const opened = [];
  app.isReady = () => true;
  app.whenReady = async () => {};
  app.getPath = () => directory;
  const electron = {
    app,
    dialog: { showMessageBox: async (...args) => {
      alerts.push(args.at(-1));
      return { response };
    } },
    shell: { openPath: async filename => { opened.push(filename); return ''; } },
  };
  install({ electron, directory, ...(prepare ? { prepare } : {}), alertDelayMs: 0 });
  let nextId = 0;
  function client({ source = fixture, base64Encoded = false, fail = [] } = {}) {
    const debuggerClient = new EventEmitter();
    const commands = [];
    debuggerClient.attach = () => {};
    debuggerClient.sendCommand = async (method, params) => {
      commands.push({ method, params });
      if (fail.includes(method)) throw new Error(`Injected ${method} failure`);
      if (method === 'Fetch.getResponseBody') return {
        body: base64Encoded ? Buffer.from(source).toString('base64')
          : typeof source === 'function' ? source(params.requestId) : source,
        base64Encoded,
      };
      return {};
    };
    const contents = Object.assign(new EventEmitter(), {
      id: ++nextId, debugger: debuggerClient, isDestroyed: () => false,
      getURL: () => 'https://www.figma.com/design/test/file',
    });
    app.emit('web-contents-created', {}, contents);
    return {
      commands,
      contents,
      async pause(overrides = {}) {
        const params = {
          requestId: `request-${contents.id}`,
          responseStatusCode: 200,
          responseHeaders: [],
          request: { url: 'https://www.figma.com/webpack-artifacts/assets/figma_app-test.min.js.br' },
          ...overrides,
        };
        // EventEmitter.emit does not await asynchronous listeners.
        await Promise.all(debuggerClient.listeners('message').map(listener =>
          listener({}, 'Fetch.requestPaused', params)));
      },
    };
  }
  return { alerts, opened, client };
}

try {
  assert.equal(typeof prepareBundle, 'function', 'Runtime must expose the validated preparation path');
  const cacheDirectory = path.join(temporary, 'cache');
  const first = prepareBundle(fixture, { directory: cacheDirectory });
  assert.equal(first.cached, false);
  assert.equal(first.sourceHash, hash(fixture));
  assert.notEqual(first.source, fixture);
  const second = prepareBundle(fixture, { directory: cacheDirectory });
  assert.equal(second.cached, true);
  assert.equal(second.source, first.source);
  const cachedSources = files(cacheDirectory).filter(filename =>
    filename.endsWith('.js') && fs.readFileSync(filename, 'utf8') === first.source);
  assert.equal(cachedSources.length, 1, 'A cached result must have one identifiable JavaScript payload');
  fs.writeFileSync(cachedSources[0], 'globalThis.corruptedCache = true;');
  const repaired = prepareBundle(fixture, { directory: cacheDirectory });
  assert.equal(repaired.cached, false, 'Corrupt cache must be rejected and recomputed');
  assert.equal(repaired.source, first.source);
  assert.equal(prepareBundle(fixture, { directory: cacheDirectory }).cached, true);
  assert.equal(prepareBundle(fixture + '\n', { directory: cacheDirectory }).cached, false,
    'An unrelated source edit must not reuse another source hash');

  const sharedFixture = fs.readFileSync(new URL('../tests/fixtures/frontend-permissions.js', import.meta.url), 'utf8');
  const mainFixture = fs.readFileSync(new URL('../tests/fixtures/frontend-main.js', import.meta.url), 'utf8');
  const core = prepareBundle(sharedFixture, { directory: cacheDirectory });
  assert.equal(core.profile, 'permissions');
  const page = prepareBundle(mainFixture, { directory: cacheDirectory, references: [sharedFixture] });
  assert.equal(page.profile, 'split');
  assert.equal(prepareBundle(mainFixture, { directory: cacheDirectory, references: [sharedFixture] }).cached, true);
  assert.equal(prepareBundle(mainFixture, { directory: cacheDirectory, references: [sharedFixture + '\n'] }).cached, false,
    'Changed dependency bytes must invalidate the main script cache');
  assert.throws(() => prepareBundle(mainFixture, { directory: cacheDirectory }),
    'Main script must not reuse a cache entry without its verified dependency');

  const delivered = [];
  const split = harness({ directory: path.join(temporary, 'split'), prepare: (source, options) => {
    if (source === sharedFixture) {
      delivered.push('permissions');
      return { source: core.source, profile: 'permissions', sourceHash: hash(source), cached: false };
    }
    assert.deepEqual(options.references, [sharedFixture]);
    delivered.push('split');
    return { source: page.source, profile: 'split', sourceHash: hash(source), cached: false };
  } });
  const splitClient = split.client({ source: id => id === 'permissions' ? sharedFixture : mainFixture });
  const mainPaused = splitClient.pause({ requestId: 'main' });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(delivered, [], 'Main response must wait for the permissions chunk');
  await splitClient.pause({ requestId: 'permissions', request: {
    url: 'https://www.figma.com/webpack-artifacts/assets/random-shared-hash.min.js.br',
  } });
  await mainPaused;
  assert.deepEqual(delivered, ['permissions', 'split']);
  assert.equal(split.alerts.length, 0);
  const unrelated = harness({ directory: path.join(temporary, 'unrelated'), prepare: source => {
    if (source === sharedFixture) return { source: core.source, profile: 'permissions', sourceHash: hash(source) };
    const error = new Error('No semantic targets in translated settings');
    error.counts = { canViewPlugins: 0, canRunExtensions: 0, publishedSelector: 0, editorSelector: 0, pluginMenu: 0 };
    throw error;
  } });
  const settings = unrelated.client({ source: id => id === 'permissions' ? sharedFixture : mainFixture });
  await settings.pause({ requestId: 'permissions', request: {
    url: 'https://www.figma.com/webpack-artifacts/assets/shared-random-hash.js',
  } });
  // Settings may arrive after the real scripts; they must neither apply nor warn.
  await settings.pause({ requestId: 'settings', request: {
    url: 'https://www.figma.com/webpack-artifacts/assets/settings-random-hash.js',
  } });
  assert.equal(unrelated.alerts.length, 0);
  assert.equal(settings.commands.filter(command => command.method === 'Fetch.continueRequest').length, 1);
  const earlySettings = harness({ directory: path.join(temporary, 'early-settings') });
  const earlyClient = earlySettings.client({ source: 'const labels = ' + JSON.stringify([
    'plugins-menu-dev-import-from-manifest', 'plugins-menu-view-only', 'widgets.development',
    'userCanViewPlugins', 'userCanRunExtensions',
  ]) + ';' });
  await earlyClient.pause({ request: {
    url: 'https://www.figma.com/webpack-artifacts/assets/settings-before-permissions.js',
  } });
  assert.equal(earlySettings.alerts.length, 0, 'Unrelated early resources must not wait for permissions');
  assert.equal(earlyClient.commands.filter(command => command.method === 'Fetch.continueRequest').length, 1);

  const unsupported = 'globalThis.unsupportedFrontend = true;';
  const failuresDirectory = path.join(temporary, 'diagnostics');
  const privateUrl = 'https://private-account:private-password@www.figma.com/webpack-artifacts/assets/' +
    'figma_app-unknown.min.js.br?access_token=private-token#session=private-session';
  let failure;
  assert.throws(() => prepareBundle(unsupported, { directory: failuresDirectory, url: privateUrl }), error => {
    failure = error.diagnosticDirectory;
    return true;
  });
  assert.equal(path.dirname(failure), path.join(failuresDirectory, 'failures'));
  assert.ok(path.basename(failure).endsWith(hash(unsupported)));
  assert.equal(fs.readFileSync(path.join(failure, 'source.js'), 'utf8'), unsupported);
  const report = fs.readFileSync(path.join(failure, 'report.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(report));
  for (const secret of ['private-account', 'private-password', 'private-token', 'private-session', 'access_token=']) {
    assert.ok(!report.includes(secret), `Diagnostic report leaked ${secret}`);
  }
  assert.ok(fs.readFileSync(path.join(failure, 'repair-request.md'), 'utf8').trim().length > 0);

  const original = 'globalThis.unicode = "原始";';
  const patched = '// 已验证\nglobalThis.unicode = "修改";';
  let receivedSource;
  const success = harness({ directory: path.join(temporary, 'success'), prepare: source => {
    receivedSource = source;
    return { source: patched, sourceHash: hash(source), cached: false };
  } });
  const working = success.client({ source: original, base64Encoded: true });
  const retainedHeaders = [
    { name: 'Content-Type', value: 'application/javascript' },
    { name: 'X-Original', value: 'preserve-me' },
    { name: 'Content-Security-Policy', value: "default-src 'self'" },
  ];
  await working.pause({ responseHeaders: [
    ...retainedHeaders,
    { name: 'content-encoding', value: 'br' },
    { name: 'CONTENT-LENGTH', value: '123' },
    { name: 'Transfer-Encoding', value: 'chunked' },
  ] });
  assert.equal(receivedSource, original);
  const fulfilled = working.commands.filter(command => command.method === 'Fetch.fulfillRequest');
  assert.equal(fulfilled.length, 1);
  assert.equal(fulfilled[0].params.responseCode, 200);
  assert.equal(Buffer.from(fulfilled[0].params.body, 'base64').toString(), patched);
  assert.deepEqual(fulfilled[0].params.responseHeaders, [
    ...retainedHeaders, { name: 'Content-Length', value: String(Buffer.byteLength(patched)) },
  ]);
  assert.equal(working.commands.filter(command => command.method === 'Fetch.continueRequest').length, 0);
  const enabled = working.commands.find(command => command.method === 'Fetch.enable');
  assert.ok(enabled.params.patterns.every(pattern =>
    pattern.resourceType === 'Script' && pattern.requestStage === 'Response'));
  assert.equal(success.alerts.length, 0);

  for (const method of ['Fetch.getResponseBody', 'Fetch.fulfillRequest']) {
    const failed = harness({ directory: path.join(temporary, method), prepare: () => ({
      source: patched, sourceHash: hash(original), cached: false,
    }) });
    const broken = failed.client({ source: original, fail: [method] });
    await broken.pause();
    assert.equal(broken.commands.filter(command => command.method === 'Fetch.continueRequest').length, 1,
      `${method} failure must release the intercepted request`);
    await eventually(() => failed.alerts.length === 1);
  }

  const rejected = harness({ directory: failuresDirectory, response: 1 });
  const rejectOne = rejected.client({ source: unsupported });
  const rejectTwo = rejected.client({ source: unsupported, fail: ['Fetch.continueRequest'] });
  await rejectOne.pause();
  await rejectTwo.pause();
  await eventually(() => rejected.alerts.length > 0);
  await rejectOne.pause();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(rejected.alerts.length, 1, 'Repeated failures across windows should show one alert');
  assert.equal(rejectOne.commands.filter(command => command.method === 'Fetch.continueRequest').length, 2);
  assert.equal(rejectTwo.commands.filter(command => command.method === 'Fetch.continueRequest').length, 1);
  await eventually(() => rejected.opened.length > 0);

  const skipped = harness({ directory: path.join(temporary, 'non-200'), prepare: () => {
    assert.fail('Non-200 responses must not be patched');
  } });
  const missing = skipped.client();
  await missing.pause({ responseStatusCode: 404 });
  assert.equal(missing.commands.filter(command => command.method === 'Fetch.getResponseBody').length, 0);
  assert.equal(missing.commands.filter(command => command.method === 'Fetch.continueRequest').length, 1);
  await eventually(() => skipped.alerts.length === 1);

  const changedUrl = harness({ directory: path.join(temporary, 'changed-url') });
  const unintercepted = changedUrl.client();
  unintercepted.contents.emit('did-finish-load');
  await eventually(() => changedUrl.alerts.length === 1);
  working.contents.emit('did-finish-load');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(success.alerts.length, 0, 'An adapted document must not trigger the missing-script watchdog');
  working.contents.emit('did-start-navigation', {}, working.contents.getURL(), true, true);
  working.contents.emit('did-finish-load');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(success.alerts.length, 0, 'Same-document navigation must preserve the loaded adapter');
  working.contents.emit('did-start-navigation', {}, working.contents.getURL(), false, true);
  working.contents.emit('did-finish-load');
  await eventually(() => success.alerts.length === 1);

  const cancelled = harness({ directory: path.join(temporary, 'cancelled-navigation') });
  const stale = cancelled.client();
  stale.contents.emit('did-finish-load');
  stale.contents.emit('did-start-navigation', {}, stale.contents.getURL(), false, true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cancelled.alerts.length, 0, 'An old navigation watchdog must be cancelled');
  stale.contents.emit('did-navigate-in-page', {}, stale.contents.getURL(), true);
  await eventually(() => cancelled.alerts.length === 1);

  // A failed diagnostic write must never keep a network request paused or hide the failure.
  const blockedDirectory = path.join(temporary, 'not-a-directory');
  fs.writeFileSync(blockedDirectory, 'occupied');
  assert.equal(prepareBundle(fixture, { directory: blockedDirectory }).source, first.source,
    'Cache write failure must not prevent a verified adaptation');
  const unwritable = harness({ directory: blockedDirectory });
  const blocked = unwritable.client({ source: unsupported });
  await blocked.pause();
  assert.equal(blocked.commands.filter(command => command.method === 'Fetch.continueRequest').length, 1);
  await eventually(() => unwritable.alerts.length === 1);

  if (process.argv[2]) {
    const capture = path.resolve(process.argv[2]);
    const manifest = JSON.parse(fs.readFileSync(path.join(capture, 'manifest.json'), 'utf8'));
    const profiles = [];
    const replay = harness({ directory: path.join(temporary, 'real-assets'), prepare: (source, options) => {
      const result = prepareBundle(source, options);
      profiles.push(result.profile);
      return result;
    } });
    const sources = new Map();
    const replayClient = replay.client({ source: id => sources.get(id) });
    for (const [index, asset] of manifest.entries()) {
      const requestId = String(index);
      sources.set(requestId, fs.readFileSync(path.join(capture, path.basename(new URL(asset.url).pathname).replace(/\.br$/, '')), 'utf8'));
      await replayClient.pause({ requestId, request: { url: asset.url } });
      sources.delete(requestId);
    }
    replayClient.contents.emit('did-finish-load');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(profiles, ['permissions', 'split']);
    assert.equal(replay.alerts.length, 0, 'Captured real resources must not produce an incompatibility warning');
    assert.equal(replayClient.commands.filter(command => command.method === 'Fetch.fulfillRequest').length, 2);
    assert.equal(replayClient.commands.filter(command => command.method === 'Fetch.continueRequest').length, manifest.length - 2);
    console.log(`Real asset replay passed: ${manifest.length} resources, permissions then main, no false alerts.`);
  }
  console.log('Runtime verification passed: cache integrity, private diagnostics, response headers, release on failure, and one-time alerts.');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
