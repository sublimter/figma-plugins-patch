"use strict";

const acorn = require("../vendor/acorn.cjs");
const vm = require("node:vm");

const ADAPTER_VERSION = 5;
const functionTypes = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function visit(root, callback, skipFunctions = false) {
  const pending = [{ node: root, owner: null, parent: null }];
  while (pending.length) {
    const { node, owner, parent } = pending.pop();
    if (skipFunctions && functionTypes.has(node.type)) continue;
    callback(node, owner, parent);
    const nextOwner = functionTypes.has(node.type) ? node : owner;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === "string") pending.push({ node: child, owner: nextOwner, parent: node });
      } else if (value && typeof value.type === "string") pending.push({ node: value, owner: nextOwner, parent: node });
    }
  }
}

function key(node) {
  return node?.type === "Identifier" ? node.name : node?.type === "Literal" ? node.value : undefined;
}

function memberPath(node) {
  if (node?.type === "ChainExpression") return memberPath(node.expression);
  if (node?.type === "Identifier") return [node.name];
  if (node?.type !== "MemberExpression" || (node.computed && node.property.type !== "Literal")) return [];
  const parent = memberPath(node.object);
  const property = key(node.property);
  return parent.length && typeof property === "string" ? [...parent, property] : [];
}

function properties(node) {
  return new Map(node.properties.filter(property => property.type === "Property" && !property.computed)
    .map(property => [key(property.key), property.value]));
}

function normalDesign(parameter) {
  return `${parameter}.selectedView?.view==="fullscreen"&&${parameter}.selectedView?.editorType===1`;
}

function functionFacts(node, parameter) {
  const paths = new Set();
  const strings = new Set();
  let copyExport = false;
  let runPermissions = false;
  // Nested helpers have their own bindings and must not turn an enclosing module into a match.
  visit(node.body, child => {
    const path = memberPath(child);
    if (path[0] === parameter) paths.add(path.slice(1).join("."));
    if (child.type === "Literal" && typeof child.value === "string") strings.add(child.value);
    if (child.type === "Property" && !child.computed && key(child.key) === "copyExportRestrictedArgs"
        && memberPath(child.value).join(".") === `${parameter}.openFile`) copyExport = true;
    if (child.type === "VariableDeclarator" && child.id.type === "ObjectPattern"
        && memberPath(child.init).join(".") === `${parameter}.openFile`) {
      const fields = new Set(child.id.properties.filter(property => property.type === "Property")
        .map(property => key(property.key)));
      if (fields.has("canRunExtensions") && fields.has("canAccessFullDevMode")) runPermissions = true;
    }
  }, true);
  return { paths, strings, copyExport, runPermissions };
}

function bindingNames(node) {
  if (!node) return [];
  if (node.type === "Identifier") return [node.name];
  if (node.type === "RestElement") return bindingNames(node.argument);
  if (node.type === "AssignmentPattern") return bindingNames(node.left);
  if (node.type === "ArrayPattern") return node.elements.flatMap(bindingNames);
  if (node.type === "ObjectPattern") return node.properties.flatMap(property => bindingNames(property.type === "RestElement" ? property.argument : property.value));
  return [];
}

function verifySelectorLinks(trees, selectors, targets) {
  const parents = new Map();
  const bindings = new Map();
  const factories = new Map();
  const factoryNodes = new Set();
  const sourceIndexes = new Map();
  const writes = [];
  const lexicalScope = node => {
    for (let current = node; current; current = parents.get(current)) {
      if (functionTypes.has(current.type)) return current;
      if (current.type === "BlockStatement") {
        const parent = parents.get(current);
        return functionTypes.has(parent?.type) && parent.body === current ? parent : current;
      }
      if (["CatchClause", "ForStatement", "ForInStatement", "ForOfStatement", "WithStatement"].includes(current.type)) return current;
    }
    return null;
  };
  const addBinding = (scope, name, kind, node) => {
    if (!bindings.has(scope)) bindings.set(scope, new Map());
    const names = bindings.get(scope);
    if (!names.has(name)) names.set(name, []);
    names.get(name).push({ scope, kind, node, mutated: false });
  };
  trees.forEach((tree, sourceIndex) => visit(tree, (node, owner, parent) => {
    parents.set(node, parent);
    if (functionTypes.has(node.type)) {
      sourceIndexes.set(node, sourceIndex);
      if (node.id) addBinding(node.type === "FunctionDeclaration" ? lexicalScope(parent) : node, node.id.name, "function", node);
      for (const parameter of node.params) for (const name of bindingNames(parameter)) addBinding(node, name, "parameter", parameter);
    }
    if (node.type === "VariableDeclarator") for (const name of bindingNames(node.id)) addBinding(parent.kind === "var" ? owner : lexicalScope(parent), name, "variable", node);
    if (node.type === "ClassDeclaration" && node.id) addBinding(lexicalScope(parent), node.id.name, "class", node);
    if (node.type === "CatchClause") for (const name of bindingNames(node.param)) addBinding(node, name, "catch", node);
    if (node.type === "AssignmentExpression" || node.type === "UpdateExpression") writes.push({ node: node.left ?? node.argument, location: node });
    if (node.type !== "Property" || !functionTypes.has(node.value?.type) || node.computed) return;
    const id = key(node.key);
    const registry = parent;
    const registration = parents.get(registry);
    if (!(typeof id === "number" || (typeof id === "string" && /^\d+$/.test(id)))
        || registry?.type !== "ObjectExpression" || registration?.type !== "ArrayExpression"
        || registration.elements[1] !== registry || registration.elements[0]?.type !== "ArrayExpression"
        || node.value.params.length !== 3 || !node.value.params.every(parameter => parameter.type === "Identifier")) return;
    if (!factories.has(String(id))) factories.set(String(id), []);
    factories.get(String(id)).push(node.value);
    factoryNodes.add(node.value);
  }));
  const resolve = (name, scope) => {
    for (let current = scope; ; current = lexicalScope(parents.get(current))) {
      if (current?.type === "WithStatement") return null;
      const matches = bindings.get(current)?.get(name);
      if (matches) return matches.length === 1 ? matches[0] : null;
      if (current == null) return null;
    }
  };
  for (const write of writes) {
    const names = bindingNames(write.node);
    if (write.node.type === "MemberExpression") names.push(memberPath(write.node)[0]);
    for (const name of names) {
      const binding = resolve(name, lexicalScope(write.location));
      if (binding) binding.mutated = true;
    }
  }
  const functionNode = binding => !binding || binding.mutated ? null
    : binding.kind === "function" ? binding.node
      : binding.kind === "variable" && functionTypes.has(binding.node.init?.type) ? binding.node.init : null;
  const calleeNode = callee => callee.type === "SequenceExpression"
    ? callee.expressions.length === 2 && callee.expressions[0].type === "Literal" && callee.expressions[0].value === 0
      ? callee.expressions[1] : null : callee;
  const linkedFunction = (call, owner) => {
    const callee = calleeNode(call.callee);
    if (callee?.type === "Identifier") return functionNode(resolve(callee.name, owner));
    const path = memberPath(callee);
    if (path.length !== 2) return null;
    const imported = resolve(path[0], owner);
    if (!imported || imported.mutated || imported.kind !== "variable" || !factoryNodes.has(imported.scope)) return null;
    const declaration = imported.node;
    const module = imported.scope;
    const load = declaration.init;
    if (parents.get(parents.get(declaration)) !== module.body || load?.type !== "CallExpression"
        || load.callee.type !== "Identifier" || load.callee.name !== module.params[2].name
        || load.arguments.length !== 1 || load.arguments[0].type !== "Literal"
        || resolve(load.callee.name, module)?.kind !== "parameter" || resolve(load.callee.name, module)?.mutated) return null;
    const matches = factories.get(String(load.arguments[0].value));
    if (matches?.length !== 1) return null;
    const factory = matches[0];
    if (factory.params.slice(1).some(parameter => resolve(parameter.name, factory)?.kind !== "parameter"
        || resolve(parameter.name, factory)?.mutated)) return null;
    const exported = [];
    visit(factory.body, node => {
      if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression"
          || node.callee.object.type !== "Identifier" || node.callee.object.name !== factory.params[2].name
          || node.arguments[0]?.type !== "Identifier" || node.arguments[0].name !== factory.params[1].name
          || parents.get(parents.get(node)) !== factory.body) return;
      for (const argument of node.arguments.slice(1)) {
        if (argument.type !== "ObjectExpression") continue;
        const getter = properties(argument).get(path[1]);
        if (!getter || !functionTypes.has(getter.type) || getter.params.length) continue;
        const value = getter.body.type === "Identifier" ? getter.body
          : getter.body.type === "BlockStatement" && getter.body.body.length === 1
            && getter.body.body[0].type === "ReturnStatement" ? getter.body.body[0].argument : null;
        if (value?.type === "Identifier") exported.push(functionNode(resolve(value.name, getter)));
      }
    }, true);
    return exported.length === 1 ? exported[0] : null;
  };
  // Field names alone are insufficient: both selectors must call the functions we actually patch.
  for (const selector of selectors) {
    for (const [field, role] of [["userCanViewPlugins", "canViewPlugins"], ["userCanRunExtensions", "canRunExtensions"]]) {
      const linked = linkedFunction(selector.fields.get(field), lexicalScope(selector.node));
      const expected = targets.find(target => target.name === role);
      if (linked?.start !== expected.start || sourceIndexes.get(linked) !== expected.sourceIndex) {
        const error = new Error(`Unresolved frontend selector linkage: ${selector.name}.${field}`);
        error.code = "FRONTEND_UNSUPPORTED";
        throw error;
      }
    }
  }
}

function scanBundle(source, sourceIndex) {
  const tree = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script" });
  const names = ["canViewPlugins", "canRunExtensions", "publishedSelector", "editorSelector", "pluginMenu"];
  const found = Object.fromEntries(names.map(name => [name, []]));
  const selectors = [];
  const nativeConsumers = [];
  visit(tree, (node, owner, parent) => {
    if (functionTypes.has(node.type) && node.body.type === "BlockStatement" && node.params[0]?.type === "Identifier") {
      const parameter = node.params[0].name;
      const facts = functionFacts(node, parameter);
      // Insert after directives so adding the guard cannot disable a function's strict mode.
      let bodyStart = node.body.start + 1;
      for (const statement of node.body.body) {
        if (!statement.directive) break;
        bodyStart = statement.end;
      }
      const target = { start: node.start, end: node.end, parameter, bodyStart, sourceIndex };
      if (facts.copyExport && ["selectedView", "openFile", "mirror.appModel.isReadOnly"].every(path => facts.paths.has(path))) {
        found.canViewPlugins.push(target);
      }
      if (facts.runPermissions && ["user", "selectedView"].every(path => facts.paths.has(path))) {
        found.canRunExtensions.push(target);
      }
      if (["plugins-menu-view-only", "plugins-menu-dev-import-from-manifest", "widgets.development"].every(value => facts.strings.has(value))
          && ["isReadOnly", "editorType"].every(path => facts.paths.has(path))) found.pluginMenu.push(target);
    }
    if (node.type !== "ObjectExpression") return;
    const fields = properties(node);
    const permissionCalls = [fields.get("userCanViewPlugins"), fields.get("userCanRunExtensions")];
    if (!fields.has("isReadOnly") && fields.size === node.properties.length
        && ["openFile", "allSavedPlugins", "localExtensions", "publishedPlugins"].every(name => fields.has(name))
        && permissionCalls.every(call => call?.type === "CallExpression" && call.arguments.length === 1 && call.arguments[0].type === "Identifier")
        && permissionCalls[0].arguments[0].name === permissionCalls[1].arguments[0].name
        && parent?.type === "CallExpression" && parent.arguments[0] === node
        && parent.arguments[1]?.type === "Literal" && parent.arguments[1].value === "osmenu"
        && memberPath(parent.arguments[2]).at(-1) === "pluginMenuAction") {
      nativeConsumers.push({ name: "nativeMenuConsumer", owner, fields, node });
    }
    const readOnly = fields.get("isReadOnly");
    const path = memberPath(readOnly);
    if (path.length !== 4 || path.slice(1).join(".") !== "mirror.appModel.isReadOnly") return;
    if (fields.size !== node.properties.length || node.properties.some(property => property.kind !== "init")) return;
    const parameter = path[0];
    if (owner?.params[0]?.type !== "Identifier" || owner.params[0].name !== parameter) return;
    if (!["userCanViewPlugins", "userCanRunExtensions"].every(name => {
      const call = fields.get(name);
      return call?.type === "CallExpression" && call.arguments.length === 1
        && call.arguments[0].type === "Identifier" && call.arguments[0].name === parameter;
    })) return;
    if (!fields.has("publishedPlugins")) return;
    const name = fields.has("editorType") ? "editorSelector" : "publishedSelector";
    selectors.push({ name, owner, fields, node });
    found[name].push({
      start: node.start, end: node.end, parameter, valueStart: readOnly.start, valueEnd: readOnly.end, sourceIndex,
    });
  });
  const counts = Object.fromEntries(names.map(name => [name, found[name].length]));
  return { tree, found, counts, selectors, nativeConsumers };
}

function targetEdit(target, source) {
    const p = target.parameter;
    if (target.name.endsWith("Selector")) return {
      name: target.name, start: target.valueStart, end: target.valueEnd,
      replacement: `(${normalDesign(p)})?false:(${source.slice(target.valueStart, target.valueEnd)})`,
    };
    let guard;
    // Clone the selector's local input, never the shared Redux document state.
    if (target.name === "canViewPlugins") guard = `if(${normalDesign(p)})${p}={...${p},mirror:{...${p}.mirror,appModel:{...${p}.mirror.appModel,isReadOnly:false}}};`;
    if (target.name === "canRunExtensions") guard = `if(${normalDesign(p)}&&${p}.openFile)${p}={...${p},openFile:{...${p}.openFile,canRunExtensions:true}};`;
    if (target.name === "pluginMenu") guard = `if(${p}.editorType===1)${p}={...${p},isReadOnly:false};`;
    return { name: target.name, start: target.bodyStart, end: target.bodyStart, replacement: `;${guard}` };
}

function analyzeBundle(source, { references = [] } = {}) {
  const main = scanBundle(source, 0);
  const names = Object.keys(main.found);
  const counts = main.counts;
  const permissionNames = ["canViewPlugins", "canRunExtensions"];
  const shape = expected => names.every(name => counts[name] === (expected.includes(name) ? 1 : 0));
  let profile;
  let active;
  let reference;
  let consumers;
  if (shape(names)) {
    profile = "legacy"; active = names; consumers = main.selectors;
  } else if (shape(permissionNames) && main.nativeConsumers.length === 1) {
    profile = "permissions"; active = permissionNames; consumers = main.nativeConsumers;
  } else if (shape(["publishedSelector", "pluginMenu"]) && references.length === 1) {
    reference = scanBundle(references[0], 1);
    const validReference = names.every(name => reference.counts[name] === (permissionNames.includes(name) ? 1 : 0));
    if (validReference && reference.nativeConsumers.length === 1) {
      profile = "split"; active = ["publishedSelector", "pluginMenu"];
      consumers = [...main.selectors, ...reference.nativeConsumers];
    }
  }
  if (!profile) {
    const error = new Error(`Missing or ambiguous frontend targets: ${names.map(name => `${name}=${counts[name]}`).join(", ")}; nativeMenuConsumer=${main.nativeConsumers.length}`);
    error.code = "FRONTEND_UNSUPPORTED";
    error.counts = counts;
    error.referenceRequired = shape(["publishedSelector", "pluginMenu"]) && !references.length;
    throw error;
  }
  const targets = active.map(name => ({ name, ...main.found[name][0] }));
  if (reference) for (const name of permissionNames) targets.push({ name, ...reference.found[name][0] });
  if (new Set(targets.map(target => `${target.sourceIndex}:${target.start}`)).size !== targets.length) {
    const error = new Error("Overlapping frontend semantic targets");
    error.code = "FRONTEND_UNSUPPORTED";
    error.counts = counts;
    throw error;
  }
  verifySelectorLinks(reference ? [main.tree, reference.tree] : [main.tree], consumers, targets);
  const edits = targets.filter(target => target.sourceIndex === 0).map(target => targetEdit(target, source));
  const referenceEdits = targets.filter(target => target.sourceIndex > 0).map(target => targetEdit(target, references[target.sourceIndex - 1]));
  return { version: ADAPTER_VERSION, profile, counts, targets, edits, referenceEdits };
}

function editedFragment(source, target, edits) {
  let fragment = source.slice(target.start, target.end);
  for (const edit of edits.filter(edit => edit.start >= target.start && edit.end <= target.end)
    .sort((a, b) => b.start - a.start)) {
    fragment = fragment.slice(0, edit.start - target.start) + edit.replacement + fragment.slice(edit.end - target.start);
  }
  return fragment;
}

function state(editorType = 1, view = "fullscreen") {
  return {
    user: { id: "local-adapter-probe" }, selectedView: { editorType, view },
    openFile: { teamId: "local-team", canRunExtensions: false, canAccessFullDevMode: false, canExport: true },
    mirror: { appModel: { isReadOnly: true } },
  };
}

function probeFunction(text, parameter, input) {
  const tree = acorn.parse(`(${text})`, { ecmaVersion: "latest" });
  const identifiers = new Set();
  const devCalls = [];
  const allowCalls = [];
  visit(tree, node => {
    // Permission probes must finish synchronously; async work would outlive the VM timeout.
    if (node.type === "ImportExpression" || node.async || node.generator) {
      throw new Error("Unsupported asynchronous frontend permission function");
    }
    if (node.type === "Identifier") identifiers.add(node.name);
    if (node.type !== "ConditionalExpression" || node.test.type !== "CallExpression"
        || node.test.arguments.length !== 1
        || memberPath(node.test.arguments[0]).join(".") !== `${parameter}.selectedView`) return;
    const callee = node.test.callee.type === "SequenceExpression" ? node.test.callee.expressions.at(-1) : node.test.callee;
    devCalls.push(memberPath(callee));
    visit(node.consequent, child => {
      if (child.type !== "CallExpression" || child.arguments.length !== 1
          || child.arguments[0].type !== "Identifier" || child.arguments[0].name !== parameter) return;
      const selected = child.callee.type === "SequenceExpression" ? child.callee.expressions.at(-1) : child.callee;
      allowCalls.push(memberPath(selected));
    }, true);
  });
  const setCall = (path, body) => path.length ? `${path.map(part => `[${JSON.stringify(part)}]`).reduce((a, b) => a + b, "globalThis")}=${body};` : "";
  // Build probe data and mocks inside the realm; downloaded code receives no host objects/functions.
  const script = `
    function __figmaProbeStub() {
      const children = new Map();
      return new Proxy(function (arg) {
        if (arg && Object.prototype.hasOwnProperty.call(arg, "copyExportRestrictedArgs"))
          return !arg.copyExportRestrictedArgs || !!arg.copyExportRestrictedArgs.canExport;
        return false;
      }, { get(target, property) {
        if (!children.has(property)) children.set(property, __figmaProbeStub());
        return children.get(property);
      }, set(target, property, value) { children.set(property, value); return true; } });
    }
    ${[...identifiers].filter(name => !["undefined", "NaN", "Infinity", "globalThis", "Object"].includes(name))
      .map(name => `globalThis[${JSON.stringify(name)}]=__figmaProbeStub();`).join("\n")}
    ${devCalls.map(path => setCall(path, "view=>view?.editorType===2")).join("\n")}
    ${allowCalls.map(path => setCall(path, "()=>true")).join("\n")}
    const __figmaProbeInput=${JSON.stringify(input)};
    const __figmaProbeValue=(${text})(__figmaProbeInput);
    JSON.stringify({value:__figmaProbeValue,input:__figmaProbeInput});
  `;
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  return JSON.parse(new vm.Script(script).runInContext(context, { timeout: 100 }));
}

function validateBundle(source, analysis = analyzeBundle(source), { references = [] } = {}) {
  // shortcut: private dependencies are modeled; changed contracts still need live UI validation.
  for (const name of ["canViewPlugins", "canRunExtensions"]) {
    const target = analysis.targets.find(target => target.name === name);
    const targetSource = target.sourceIndex === 0 ? source : references[target.sourceIndex - 1];
    const original = targetSource.slice(target.start, target.end);
    const changed = editedFragment(targetSource, target, target.sourceIndex === 0 ? analysis.edits : analysis.referenceEdits);
    const cases = [state(), ...[2, 3, 4, 5, 6, 7].map(type => state(type)), state(1, "fileBrowser")];
    const restricted = state(2); restricted.openFile.canExport = false; cases.push(restricted);
    if (name === "canRunExtensions") {
      const anonymous = state(); anonymous.user = null; cases.push(anonymous);
      const noFile = state(); noFile.openFile = null; cases.push(noFile);
    }
    for (let index = 0; index < cases.length; index++) {
      const input = cases[index];
      const before = probeFunction(original, target.parameter, input);
      const after = probeFunction(changed, target.parameter, input);
      const expected = index === 0 ? true : before.value;
      if (JSON.stringify(before.input) !== JSON.stringify(input) || JSON.stringify(after.input) !== JSON.stringify(input)
          || after.value !== expected || (index === 0 && before.value !== false)
          || (name === "canRunExtensions" && index >= cases.length - 2 && after.value !== false)
          || (name === "canViewPlugins" && index === 8 && after.value !== false)) {
        throw new Error(`Frontend behavior validation failed: ${name}, case ${index}`);
      }
    }
  }
}

function adaptBundle(source, options = {}) {
  const analysis = analyzeBundle(source, options);
  const { edits } = analysis;
  let patched = source;
  // Validate all roles before editing; a partial patch can expose a menu that cannot run.
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    patched = patched.slice(0, edit.start) + edit.replacement + patched.slice(edit.end);
  }
  patched = `globalThis.__figmaPluginAccessExperiment={version:${ADAPTER_VERSION},pluginSelectorsPatched:true};\n` + patched;
  new vm.Script(patched);
  validateBundle(source, analysis, options);
  return { source: patched, profile: analysis.profile };
}

function patchBundle(source, options = {}) {
  return adaptBundle(source, options).source;
}

module.exports = { ADAPTER_VERSION, analyzeBundle, patchBundle, adaptBundle, validateBundle };
