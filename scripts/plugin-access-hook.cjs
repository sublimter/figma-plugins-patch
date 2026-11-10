"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { patchBundle, adaptBundle, analyzeBundle, ADAPTER_VERSION } = require("./frontend-adapter.cjs");
// The builder fingerprints parser/adapter code so older caches cannot mask an update.
const ADAPTER_BUILD = "development";
const digest = value => crypto.createHash("sha256").update(value).digest("hex");

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function assetUrl(value) {
  try {
    const url = new URL(value);
    return url.origin + url.pathname;
  } catch { return "unknown"; }
}

function prepareBundle(original, { directory, url = "unknown", references = [] }) {
  const sourceHash = digest(original);
  const referenceHashes = references.map(digest);
  const key = `${ADAPTER_VERSION}-${ADAPTER_BUILD}-${digest(referenceHashes.join(":"))}-${sourceHash}`;
  const cachedFile = path.join(directory, "cache", `${key}.js`);
  try {
    const record = JSON.parse(fs.readFileSync(`${cachedFile}.json`, "utf8"));
    const source = fs.readFileSync(cachedFile, "utf8");
    if (["legacy", "permissions", "split"].includes(record.profile)
        && (record.profile === "split") === (references.length > 0)
        && record.sourceHash === sourceHash && record.patchedHash === digest(source)) {
      new vm.Script(source);
      return { source, sourceHash, profile: record.profile, cached: true };
    }
  } catch { /* Missing or damaged caches are rebuilt from this exact response. */ }

  let source;
  let profile;
  try { ({ source, profile } = adaptBundle(original, { references })); }
  catch (error) {
    const failure = path.join(directory, "failures", key);
    try {
      writeAtomic(path.join(failure, "source.js"), original);
      references.forEach((reference, index) => writeAtomic(path.join(failure, `reference-${index}.js`), reference));
      writeAtomic(path.join(failure, "report.json"), JSON.stringify({
        adapterVersion: ADAPTER_VERSION, adapterBuild: ADAPTER_BUILD, sourceHash,
        referenceHashes, url: assetUrl(url), error: error.message, counts: error.counts,
      }, null, 2));
      writeAtomic(path.join(failure, "repair-request.md"),
        "# Figma 网页兼容修复\n\n" +
        "请基于 source.js 和 report.json 修复 scripts/frontend-adapter.cjs。\n" +
        "保持目标唯一匹配、局部状态副本、匿名限制和其他编辑器行为；添加回归用例。\n" +
        "运行 node scripts/verify-frontend-patch.mjs <本目录/source.js>；若有 reference-0.js，将其路径追加在命令后，并对旧版脚本回归。\n" +
        "自动测试后仍需验证实际只读文件的 Plugins、Console MCP 选区读取和资源导出。\n");
      error.diagnosticDirectory = failure;
    } catch (storageError) {
      console.error("[plugin-experiment] cannot save diagnostics:", storageError.message);
    }
    throw error;
  }
  try {
    writeAtomic(cachedFile, source);
    writeAtomic(`${cachedFile}.json`, JSON.stringify({ sourceHash, profile, patchedHash: digest(source) }));
  } catch (error) {
    // Cache write permissions must not prevent a verified adaptation.
    console.error("[plugin-experiment] cannot cache frontend:", error.message);
  }
  return { source, sourceHash, profile, cached: false };
}

function install(options = {}) {
  const { app, dialog, shell } = options.electron ?? require("electron");
  const prepare = options.prepare ?? prepareBundle;
  let warned = false;
  function warn(error) {
    console.error("[plugin-experiment] frontend unchanged:", error.message);
    // Multiple windows may load one unsupported bundle; warn only once per launch.
    if (warned) return;
    warned = true;
    const folder = error.diagnosticDirectory;
    void app.whenReady().then(async () => {
      const result = await dialog.showMessageBox({
        type: "warning", title: "Figma 插件兼容性提示",
        message: "当前 Figma 网页版本暂未适配",
        detail: "插件入口可能不完整。无法适配的脚本将按原样加载。\n\n" +
          (folder ? `诊断文件：${folder}\n\n` : "诊断文件未能保存，请查看启动终端日志。\n\n") +
          `原因：${error.message}`,
        buttons: folder ? ["知道了", "打开诊断文件夹"] : ["知道了"],
        defaultId: 0, cancelId: 0, noLink: true,
      });
      if (folder && result.response === 1) await shell.openPath(folder);
    }).catch(alertError => console.error("[plugin-experiment] cannot show alert:", alertError.message));
  }

  app.on("web-contents-created", (_event, contents) => {
    // Figma configures userData after this hook is installed (including isolated test profiles).
    const directory = options.directory ?? path.join(app.getPath("userData"), "plugin-access-experiment");
    const debuggerClient = contents.debugger;
    let adapted = false;
    let generation = 0;
    let watchdog;
    let references = [];
    const waiting = new Set();
    function waitForPermissions() {
      if (references.length) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const item = { resolve: () => { clearTimeout(item.timer); waiting.delete(item); resolve(); },
          reject: error => { clearTimeout(item.timer); waiting.delete(item); reject(error); } };
        item.timer = setTimeout(() => item.reject(new Error("未找到已验证的插件权限脚本。")), 15000);
        waiting.add(item);
      });
    }
    contents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) {
        generation++;
        adapted = false;
        references = [];
        for (const item of waiting) item.reject(new Error("页面已重新导航。"));
        clearTimeout(watchdog);
      }
    });
    contents.on("destroyed", () => {
      clearTimeout(watchdog);
      for (const item of waiting) item.reject(new Error("页面已关闭。"));
    });
    try { debuggerClient.attach("1.3"); }
    catch (error) { warn(error); return; }
    debuggerClient.on("message", async (_event, method, params) => {
      if (method !== "Fetch.requestPaused") return;
      const { requestId } = params;
      const requestGeneration = generation;
      let completed = false;
      try {
        const mainAsset = /\/figma_app-[^/]+\.js/.test(params.request?.url ?? "");
        if (params.responseStatusCode !== 200) {
          if (mainAsset) throw new Error(`Frontend HTTP ${params.responseStatusCode}`);
          return;
        }
        const response = await debuggerClient.sendCommand("Fetch.getResponseBody", { requestId });
        const original = response.base64Encoded ? Buffer.from(response.body, "base64").toString("utf8") : response.body;
        const menu = ["plugins-menu-dev-import-from-manifest", "plugins-menu-view-only", "widgets.development",
          "userCanViewPlugins", "userCanRunExtensions"].every(marker => original.includes(marker));
        const permissions = original.includes("canRunExtensions") && original.includes("copyExportRestrictedArgs");
        // Most assets are unrelated; never rewrite or alert for SVG/vendor bundles.
        if (!mainAsset && !menu && !permissions) return;
        if (!mainAsset && menu && !permissions && !references.length) {
          // Translations can precede the permissions chunk; exclude them before waiting.
          try { analyzeBundle(original); }
          catch (error) {
            if (error.counts && Object.values(error.counts).every(count => count === 0)) return;
          }
        }
        if (menu && !permissions) await waitForPermissions();
        if (requestGeneration !== generation || contents.isDestroyed()) return;
        let result;
        try {
          result = prepare(original, { directory, url: params.request?.url,
            references: menu && !permissions ? references : [] });
        } catch (error) {
          // Settings/translations can mention every marker without implementing a target.
          if (!mainAsset && error.counts && Object.values(error.counts).every(count => count === 0)) return;
          throw error;
        }
        const modified = Buffer.from(result.source, "utf8");
        const responseHeaders = (params.responseHeaders ?? []).filter(header =>
          !["content-encoding", "content-length", "transfer-encoding"].includes(header.name.toLowerCase()),
        );
        responseHeaders.push({ name: "Content-Length", value: String(modified.length) });
        await debuggerClient.sendCommand("Fetch.fulfillRequest", {
          requestId, responseCode: 200, responseHeaders, body: modified.toString("base64"),
        });
        completed = true;
        if (requestGeneration === generation) {
          if (result.profile === "permissions") {
            // Publish the original dependency only after its validated replacement was delivered.
            references = [original];
            for (const item of waiting) item.resolve();
          } else adapted = true;
        }
        console.error(`[plugin-experiment] frontend ${result.cached ? "cache hit" : "adapted"} (${result.profile}): ${result.sourceHash}`);
      } catch (error) {
        if (requestGeneration === generation && !contents.isDestroyed()) warn(error);
      }
      finally {
        if (!completed) {
          try { await debuggerClient.sendCommand("Fetch.continueRequest", { requestId }); }
          catch (error) { console.error("[plugin-experiment] cannot continue frontend:", error.message); }
        }
      }
    });
    // Changed loading URLs must produce a warning rather than silently missing interception.
    function scheduleWatchdog() {
      clearTimeout(watchdog);
      if (adapted || !/^https:\/\/www\.figma\.com\/(design|file)\//.test(contents.getURL())) return;
      const loadedGeneration = generation;
      watchdog = setTimeout(() => {
        if (generation === loadedGeneration && !adapted && !contents.isDestroyed()) {
          warn(new Error("未能识别已加载的网页脚本，请检查加载方式或兼容规则。"));
        }
      }, options.alertDelayMs ?? 15000);
      watchdog.unref?.();
    }
    contents.on("did-finish-load", scheduleWatchdog);
    contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame) scheduleWatchdog();
    });
    debuggerClient.sendCommand("Fetch.enable", {
      patterns: [{
        urlPattern: "https://www.figma.com/webpack-artifacts/assets/*.js*",
        resourceType: "Script", requestStage: "Response",
      }],
    }).catch(warn);
  });
}

module.exports = { patchBundle, prepareBundle, install };
