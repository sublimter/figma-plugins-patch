# figma-plugins-patch 快速入门

通过 **Figma Console MCP + 本地 Desktop Bridge**，让 Codex 读取 Figma 选中图层的节点、布局、颜色、文字和图片资源。

**无需添加 Figma key，无需配置个人访问令牌（PAT / `FIGMA_ACCESS_TOKEN`）。** 本文使用本地插件通道；REST API 功能另行需要 Token。

已验证 Console MCP 1.46.0 与其随包插件 1.41.5 的本地读取、PNG/SVG 导出，验证记录截至 2026-11-10。设计文件保持只读，补丁不提供服务端编辑权限。

## 1. 准备环境

安装 Figma 桌面版并放入“应用程序”目录，同时准备 Python 3、Node.js 22.x（至少 22.13.0，已验证 22.22.2）或 24+（含 npm），以及 Codex CLI。Console MCP 的运行依赖要求高于主包声明，不能仅按其 Node 18+ 声明安装。

选择一个长期保留的工作目录。后续命令均在包含 `figma-plugins-patch/` 的上一级目录执行；已有源码时，直接进入该上一级目录。MCP 安装完成后，其运行目录会被 Codex 和插件引用，需保留在原位置。

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

## 3. 安装 Console MCP 并接入 Codex

安装已验证的固定版本，安装包包含 MCP 服务和 Desktop Bridge 插件，需要访问 npm registry：

```bash
npm install --prefix ./figma-plugins-patch/.local/figma-console-runtime --save-exact figma-console-mcp@1.46.0
```

注册 MCP 服务，并输出插件 manifest 的位置：

```bash
codex mcp add figma-console -- "$(node -p 'process.execPath')" "$PWD/figma-plugins-patch/.local/figma-console-runtime/node_modules/figma-console-mcp/dist/local.js"
codex mcp list
echo "$PWD/figma-plugins-patch/.local/figma-console-runtime/node_modules/figma-console-mcp/figma-desktop-bridge/manifest.json"
```

保留最后输出的路径。在 `~/.codex/config.toml` 已有的 `[mcp_servers.figma-console]` 表内、`command` 和 `args` 后补充两项；已有同名项时修改其值，不要重复添加表或键：

```toml
startup_timeout_sec = 120.0
tool_timeout_sec = 300.0
```

重新打开 Codex 会话，通过 `/mcp` 确认出现 `figma-console`。该配置直接启动已安装的 Console MCP 服务，不需要另外编写 JS 调用脚本，也不需要执行 `codex mcp login`。

## 4. 导入并使用插件

1. 使用补丁副本时，正常退出当前 Figma，再运行以下命令，打开仓库生成的 **Figma Plugin Experiment**。若提示登录，正常完成登录。已在使用该副本，或已确认原版可以运行插件时，可直接进入下一步。

   ```bash
   bash figma-plugins-patch/scripts/launch-experiment.sh
   ```

2. 打开目标设计文件，点击编辑器**左上角的 Figma 图标**，依次选择 **Plugins → Development → Import plugin from manifest…**。也可从 macOS 屏幕顶部的 **Plugins → Development** 进入导入菜单。
3. 插件文件相对于仓库根目录的位置是 `.local/figma-console-runtime/node_modules/figma-console-mcp/figma-desktop-bridge/manifest.json`。在弹出的文件选择窗口按 `⌘⇧G`，粘贴第 3 节命令输出的路径，按回车，再点击 **Open / 打开** 完成导入；该命令会根据读者的安装位置生成路径，无需手写用户名或固定安装目录。同一路径只需导入一次，迁移目录后需重新导入。
4. 再次打开 **Plugins → Development**，点击新增的 **Figma Desktop Bridge** 运行插件。插件会扫描本地 9223–9232 端口并自动连接，无需填写 Figma key/PAT。使用期间保持插件窗口打开；以后重新打开设计文件时，仍需运行插件。
5. 请 Codex 调用 `figma_diagnose` 和 `figma_get_status({"probe": true})`，确认 `plugin.connected: true`、文件名正确且主动探测成功。`token.hasToken: false` 不影响本文的本地读取和 PNG/SVG 导出。返回的 `fileKey` 是自动获取的文件标识，不是需要填写的密钥。
6. 选中目标图层，告诉 Codex：**“通过 figma-console 读取当前全部选中图层的节点 ID、布局边距、圆角、颜色样式名称和字体，导出 PNG 截图及 SVG 图标，并保存到仓库的 .local/figma-exports/。”** 实际读出目标图层并检查导出文件后，验证才算完成。工具可能直接返回图片内容，需要将其保存为文件。

后续使用时，打开 Codex 会话、启动 Figma 并运行 Desktop Bridge，选中图层后告诉 Codex 需求即可。详细检查步骤、C37 等颜色标号的来源及已知限制见 [验证说明](docs/FIGMA-CONSOLE-VERIFICATION.md)。

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

Console MCP 运行目录独立于应用副本，重建副本时保留它。升级 MCP 时应明确安装目标版本，再重开 Codex 会话、重新运行插件并按第 4 节验证；上游要求重新导入插件时，使用该运行目录中的 manifest。

移动仓库或从旧安装目录迁移后，重新执行第 3 节的注册命令并确认超时配置，再按第 4 节重新导入新位置的 manifest 并运行插件。确认连接和选区读取成功后，再清理旧目录。仅更换 Node 安装位置时，重新注册 MCP 并确认超时配置即可。

连接成功但选区为空时，先重新选择图层；重连初期选区缓存可能未初始化，可请 Codex 通过 `figma_execute` 实时读取 `figma.currentPage.selection`。多文件同时打开时，先核对诊断返回的文件名。

网页更新后无法适配时，应用会提示“当前 Figma 网页版本暂未适配”，每次启动只提示一次。点击 **打开诊断文件夹**，将整个目录（含 `repair-request.md`）交给维护者或 Codex，修复后重新构建。无法适配的脚本会原样加载，插件入口可能不完整。

入口消失但没有提示时，先确认启动的是工作目录中的副本，再保留启动脚本的终端输出用于排查。Figma 桌面程序与网页分别更新，关闭桌面自动更新不能固定网页版本。
