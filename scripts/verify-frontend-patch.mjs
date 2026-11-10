import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const acorn = require('../vendor/acorn.cjs');
const { patchBundle, adaptBundle, analyzeBundle, ADAPTER_VERSION } = require('./frontend-adapter.cjs');
const fixture = fs.readFileSync(new URL('../tests/fixtures/frontend.js', import.meta.url), 'utf8');

function state(editorType = 1, view = 'fullscreen') {
  return {
    user: { id: 'local-test-user' }, selectedView: { editorType, view },
    openFile: { teamId: 'local-team', canRunExtensions: false, canAccessFullDevMode: false, canExport: true },
    mirror: { appModel: { isReadOnly: true } }, publishedPlugins: ['untouched'],
  };
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function executeFixture(text) {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  new vm.Script(text).runInContext(context, { timeout: 1000 });
  return Object.values(context.fixture);
}

function verifyFixture(text) {
  const [originalView, originalRun, originalMenu, originalPublished, originalEditor] = executeFixture(text);
  const [view, run, menu, published, editor] = executeFixture(patchBundle(text));
  const current = freeze(state());
  const snapshot = JSON.stringify(current);
  assert.equal(originalView(current), false);
  assert.equal(originalRun(current), false);
  assert.equal(view(current), true);
  assert.equal(run(current), true);
  for (const selector of [published, editor]) {
    const result = selector(current);
    assert.equal(result.isReadOnly, false);
    assert.equal(result.userCanViewPlugins, true);
    assert.equal(result.userCanRunExtensions, true);
    assert.equal(result.publishedPlugins, current.publishedPlugins);
  }
  const descriptor = freeze({ isReadOnly: true, editorType: 1 });
  assert.equal(originalMenu(descriptor, current).isReadOnly, true);
  assert.equal(menu(descriptor, current).isReadOnly, false);
  assert.equal(menu(descriptor, current).canView, true);
  assert.equal(descriptor.isReadOnly, true);
  assert.equal(JSON.stringify(current), snapshot);
  for (const input of [...[2, 3, 4, 5, 6, 7].map(type => state(type)), state(1, 'fileBrowser')]) {
    assert.equal(view(input), originalView(input));
    assert.equal(run(input), originalRun(input));
    assert.equal(published(input).isReadOnly, originalPublished(input).isReadOnly);
    assert.equal(editor(input).isReadOnly, originalEditor(input).isReadOnly);
  }
  for (const editorType of [2, 3, 4, 5, 6, 7]) {
    const other = { isReadOnly: true, editorType };
    assert.equal(menu(other, state(editorType)).isReadOnly, originalMenu(other, state(editorType)).isReadOnly);
  }
  const anonymous = state(); anonymous.user = null;
  assert.equal(run(anonymous), false);
  const noFile = state(); noFile.openFile = null;
  assert.equal(run(noFile), false);
  const restricted = state(2); restricted.openFile.canExport = false;
  assert.equal(view(restricted), false);
}

verifyFixture(fixture);
const privateNames = new Set(['state', 'properties', 'detection', 'visible', 'runnable', 'menu', 'published', 'editor', 'isDev', 'hasDevAccess']);
let renamed = fixture;
for (const token of [...acorn.tokenizer(fixture, { ecmaVersion: 'latest' })].reverse()) {
  if (token.type.label === 'name' && privateNames.has(token.value)) {
    renamed = renamed.slice(0, token.start) + `renamed_${token.value}` + renamed.slice(token.end);
  }
}
verifyFixture(renamed);
// Token-preserving whitespace changes exercise formatting without changing string contents or bindings.
verifyFixture([...acorn.tokenizer(renamed, { ecmaVersion: 'latest' })]
  .map(token => renamed.slice(token.start, token.end)).join(' '));

const plan = analyzeBundle(fixture);
assert.equal(plan.version, ADAPTER_VERSION);
assert.equal(plan.targets.length, 5);
assert.ok(Object.values(plan.counts).every(count => count === 1));
for (const target of plan.targets) {
  const replacement = target.bodyStart === undefined ? '{}' : (() => {
    const text = fixture.slice(target.start, target.end);
    const body = text.indexOf('{');
    return text.slice(0, body) + '{}';
  })();
  const missing = fixture.slice(0, target.start) + replacement + fixture.slice(target.end);
  assert.throws(() => patchBundle(missing), error => error.counts?.[target.name] === 0, `Missing ${target.name} must stop all patching`);
  const text = fixture.slice(target.start, target.end);
  const duplicate = target.bodyStart === undefined ? `\nvoid (${target.parameter}=>(${text}));` : `\n(${text});`;
  assert.throws(() => patchBundle(fixture + duplicate), error => error.counts?.[target.name] === 2,
    `Duplicate ${target.name} must not be patched by guessing`);
}
assert.throws(() => patchBundle('function incomplete('), SyntaxError);
assert.throws(() => patchBundle(patchBundle(fixture)), /Missing or ambiguous/);
const incompatible = fixture.replace('return detection.isDev(state.selectedView) ? dev : run;',
  'if (state.selectedView.editorType === 1) return false; return detection.isDev(state.selectedView) ? dev : run;');
assert.throws(() => patchBundle(incompatible), /behavior validation failed/,
  'Matching field names cannot authorize a semantically incompatible permission function');
const mutating = fixture.replace('"use strict";', '"use strict"; state.mirror.appModel.isReadOnly = false;');
assert.throws(() => patchBundle(mutating), /behavior validation failed/);
const hanging = fixture.replace('const { canRunExtensions:', 'while (true) {} const { canRunExtensions:');
assert.throws(() => patchBundle(hanging), /timed out/);
const dynamicCode = fixture.replace('const { canRunExtensions:', 'state.constructor.constructor("return process")(); const { canRunExtensions:');
assert.throws(() => patchBundle(dynamicCode), /Code generation/);
const asynchronous = fixture.replace('const { canRunExtensions:', 'import("node:fs"); const { canRunExtensions:');
assert.throws(() => patchBundle(asynchronous), /Unsupported asynchronous/);

const blocked = fixture.replace('userCanViewPlugins: visible(state)', 'userCanViewPlugins: blocked(state)')
  + '\nfunction blocked(state) { return false; }';
assert.throws(() => patchBundle(blocked), /selector linkage/);
const shadowed = fixture.replace('function published(state) {', 'function published(state, visible) {');
assert.throws(() => patchBundle(shadowed), /selector linkage/);
assert.throws(() => patchBundle(fixture + '\nvisible = () => false;'), /selector linkage/);
const spread = fixture.replace('isReadOnly: state.mirror.appModel.isReadOnly,', 'isReadOnly: state.mirror.appModel.isReadOnly, ...state.overrides,');
assert.throws(() => patchBundle(spread), /Missing or ambiguous/);

const boundary = fixture.indexOf('function menu(');
const permissionModule = fixture.slice(0, boundary);
const selectorModule = fixture.slice(boundary, fixture.indexOf('globalThis.fixture'))
  .replace(/\bvisible\(/g, 'privateExports.alpha(').replace(/\brunnable\(/g, 'privateExports.beta(');
const moduleFixture = `globalThis.chunks=[]; globalThis.chunks.push([[7],{
  111(module,exports,load){${permissionModule} load.register(exports,{alpha:()=>visible,beta:()=>runnable});},
  222(module,exports,load){const privateExports=load(111);${selectorModule}}
}]);`;
patchBundle(moduleFixture);
assert.throws(() => patchBundle(moduleFixture.replace('alpha:()=>visible', 'alpha:()=>blocked')
  .replace('load.register(exports', 'function blocked(state){return false;} load.register(exports')), /selector linkage/);
assert.throws(() => patchBundle(moduleFixture.replace('alpha:()=>visible', 'alpha:()=>state=>visible(state)')), /selector linkage/);
assert.throws(() => patchBundle(moduleFixture.replace('privateExports=load(111)', 'privateExports=load(999)')), /selector linkage/);
assert.throws(() => patchBundle(moduleFixture.replace('function published(state) {', 'function published(state, privateExports) {')), /selector linkage/);
assert.throws(() => patchBundle(moduleFixture.replace('const privateExports=load(111);', 'const privateExports=load(111);privateExports.alpha=()=>false;')), /selector linkage/);
assert.throws(() => patchBundle(moduleFixture.replace('const privateExports=load(111);', 'load=()=>({alpha:()=>false,beta:()=>false});const privateExports=load(111);')), /selector linkage/);
assert.throws(() => patchBundle(moduleFixture.replace('alpha:()=>visible', 'alpha:function visible(){return visible}')), /selector linkage/);

const sharedFixture = fs.readFileSync(new URL('../tests/fixtures/frontend-permissions.js', import.meta.url), 'utf8');
const mainFixture = fs.readFileSync(new URL('../tests/fixtures/frontend-main.js', import.meta.url), 'utf8');
const sharedAdapted = adaptBundle(sharedFixture);
const mainAdapted = adaptBundle(mainFixture, { references: [sharedFixture] });
assert.equal(sharedAdapted.profile, 'permissions');
assert.equal(mainAdapted.profile, 'split');
assert.throws(() => patchBundle(mainFixture), error => error.referenceRequired === true);
assert.throws(() => patchBundle(mainFixture, { references: [fixture] }), /Missing or ambiguous/);
assert.throws(() => patchBundle(mainFixture.replace('userCanViewPlugins: privateExports.alpha(state)', 'userCanViewPlugins: privateExports.beta(state)'),
  { references: [sharedFixture] }), /selector linkage/);
assert.throws(() => patchBundle(sharedFixture.replace('userCanViewPlugins: privateExports.alpha(state)', 'userCanViewPlugins: blocked(state)')
  + '\nfunction blocked(state){return false;}'), /selector linkage/);
const legacyWithoutEditor = fixture.slice(0, fixture.indexOf('function editor('));
assert.throws(() => patchBundle(legacyWithoutEditor, { references: [sharedFixture] }), /Missing or ambiguous/);
const blockShadow = moduleFixture.replace('const privateExports=load(111);', '{let load=()=>false;}const privateExports=load(111);');
patchBundle(blockShadow);
const realShadow = moduleFixture.replace('function published(state) {', 'function published(state) {let privateExports={alpha:()=>false,beta:()=>false};');
assert.throws(() => patchBundle(realShadow), /selector linkage/);

const chunksContext = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
new vm.Script(sharedAdapted.source + '\n' + mainAdapted.source + `
  const modules=Object.fromEntries(splitChunks.flatMap(chunk=>Object.entries(chunk[1]))), cache={};
  function load(id){if(cache[id])return cache[id].exports;const module={exports:{}};cache[id]=module;modules[id](module,module.exports,load);return module.exports;}
  load.register=(exports,getters)=>{for(const [name,getter] of Object.entries(getters))Object.defineProperty(exports,name,{get:getter});};
  globalThis.send=properties=>globalThis.nativeProperties=properties;
  globalThis.mainModule=load(222);globalThis.nativeModule=load(333);
`).runInContext(chunksContext, { timeout: 1000 });
const splitState = freeze(state());
const splitProps = chunksContext.mainModule.published(splitState);
assert.equal(splitProps.isReadOnly, false);
assert.equal(splitProps.userCanViewPlugins, true);
assert.equal(splitProps.userCanRunExtensions, true);
chunksContext.nativeModule.nativeMenu(splitState, { pluginMenuAction: {} });
assert.equal(chunksContext.nativeProperties.userCanViewPlugins, true);
assert.equal(chunksContext.nativeProperties.userCanRunExtensions, true);
assert.equal(splitState.mirror.appModel.isReadOnly, true);

const sourcePath = process.argv[2] ?? new URL('../.local/frontend/figma_app-current.js', import.meta.url);
if (process.argv[2] || fs.existsSync(sourcePath)) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const references = process.argv.slice(3).map(path => fs.readFileSync(path, 'utf8'));
  for (const reference of references) assert.equal(adaptBundle(reference).profile, 'permissions');
  const result = adaptBundle(source, { references });
  console.log(`Real frontend verified: ${String(sourcePath)} (${result.profile}, unique linked targets, compilation and isolated permission probes).`);
}
console.log('Frontend regression passed: renamed bindings/exports, whitespace, unchanged state, menus/selectors, other modes, missing/ambiguous targets, incompatible behavior and bounded probes.');
