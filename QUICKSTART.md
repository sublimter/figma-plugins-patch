# figma-plugins-patch 快速入门

通过 Plumb，让 Codex 读取 Figma 选中图层的样式、间距、截图和图片资源。

已验证组合：Figma 126.11.8 arm64、Plumb 0.13.3，验证记录截至 2026-11-10。设计文件保持只读，补丁不提供服务端编辑权限。

## 1. 准备环境

安装 Figma 桌面版并放入“应用程序”目录，同时准备 Python 3、Node.js 20+（含 npm）和 Codex CLI。

选择一个长期保留的工作目录。后续命令均在包含 `figma-plugins-patch/` 的上一级目录执行；已有源码时，直接进入该上一级目录。Plumb 安装完成后，其运行目录会被 MCP 和插件引用，需保留在原位置。

## 2. 获取源码并开启 Plugins 入口

从仓库获取源码：

```bash
git clone https://github.com/sublimter/figma-plugins-patch.git
```

使用资料包时，可以改为解压其中的源码包：

```bash
unzip figma-plugins-patch-source.zip
```

在目标设计文件中，**Plugins → Development** 已能正常导入并运行插件时，可跳过构建步骤。缺少入口或菜单不可用时，先正常退出 Figma，再检查兼容性：

```bash
python3 figma-plugins-patch/scripts/patch-figma.py --check
```

确认输出 `"compatible": true` 后构建副本：

```bash
python3 figma-plugins-patch/scripts/patch-figma.py
```

副本位于 `figma-plugins-patch/.local/Figma Plugin Experiment.app`，应用名为 **Figma Plugin Experiment**。兼容性检查只覆盖桌面程序，网页编辑器与插件功能需要运行后验证。

## 3. 安装 Plumb 并接入 Codex

使用仓库内置的 Plumb 0.13.3 安装包，其中包含 MCP 服务和已编译的 Figma 插件：

```bash
npm install --prefix ./figma-plugins-patch/.local/plumb-runtime ./figma-plugins-patch/vendor/plumb-mcp-0.13.3.tgz
```

安装包随源码提供；npm 仍会安装其声明的运行依赖。

注册 MCP 服务，并输出插件 manifest 的位置：

```bash
codex mcp add plumb -- "$(node -p 'process.execPath')" "$PWD/figma-plugins-patch/.local/plumb-runtime/node_modules/plumb-mcp/dist/index.js"
codex mcp list
echo "$PWD/figma-plugins-patch/.local/plumb-runtime/node_modules/plumb-mcp/figma-plugin/manifest.json"
```

保留最后输出的路径。重新打开 Codex 会话，请 Codex 调用 `plumb_status`，记下 `plugin.bridgePort`，用于辨认要配对的服务。

## 4. 导入并使用插件

1. 使用补丁副本时，正常退出当前 Figma，再运行以下命令。若提示登录，正常完成登录。

   ```bash
   bash figma-plugins-patch/scripts/launch-experiment.sh
   ```

2. 打开目标设计文件，进入 **左上角 Figma 主菜单 → Plugins → Development → Import plugin from manifest…**。在文件选择框按 `⌘⇧G`，粘贴上一步输出的 manifest 路径并导入。只需导入一次。
3. 从 **Plugins → Development → Plumb** 运行插件，在与 `bridgePort` 对应的服务旁点击 **Pair**；已自动配对时无需重复点击。使用期间保持插件运行。
4. 请 Codex 再调用 `plumb_status`，确认 `plugin.connected: true`，且 `plugin.fileName` 是目标文件。
5. 选中目标图层，告诉 Codex：**“读取当前选中图层的样式、间距和图片资源，并导出截图。”** 实际读出目标图层并生成导出文件后，验证才算完成。文件位置以工具返回的路径为准。

后续使用时，启动 Figma、运行 Plumb 并配对，选中图层后告诉 Codex 需求即可。

## 5. 更新与排查

使用 Git 时更新源码：

```bash
git -C figma-plugins-patch pull --ff-only
```

使用资料包时，将新版源码包放入原工作目录，保留现有 `figma-plugins-patch/.local/`，再解压覆盖源码：

```bash
unzip -o figma-plugins-patch-source.zip
```

原版 Figma 版本未变、仅更新补丁源码时，正常退出副本后重新构建并启动：

```bash
python3 figma-plugins-patch/scripts/patch-figma.py --refresh
bash figma-plugins-patch/scripts/launch-experiment.sh
```

原版 Figma 升级后，副本需完整重建。正常退出副本，执行以下命令；只有兼容性检查通过，才会删除生成的应用副本并重新复制：

```bash
python3 figma-plugins-patch/scripts/patch-figma.py --check &&
rm -rf "figma-plugins-patch/.local/Figma Plugin Experiment.app" &&
python3 figma-plugins-patch/scripts/patch-figma.py &&
bash figma-plugins-patch/scripts/launch-experiment.sh
```

更新后按第 4 节重新确认插件运行及选区读取。重建报错时保留错误信息，不要删除 `.local/` 后重试。从其他目录迁移时，旧构建报告不能直接用于新路径的 `--refresh`；可保留旧目录，在新目录按第 2 节首次构建。

网页更新后无法适配时，应用会提示“当前 Figma 网页版本暂未适配”，每次启动只提示一次。点击 **打开诊断文件夹**，将整个目录（含 `repair-request.md`）交给维护者或 Codex，修复后重新构建。无法适配的脚本会原样加载，插件入口可能不完整。

入口消失但没有提示时，先确认启动的是工作目录中的副本，再保留启动脚本的终端输出用于排查。Figma 桌面程序与网页分别更新，关闭桌面自动更新不能固定网页版本。
