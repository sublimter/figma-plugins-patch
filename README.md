# figma-plugins-patch

为 macOS 版 Figma 的只读设计文件恢复 Plugins 菜单和本地开发插件入口。

项目从已安装的 Figma 创建独立应用副本，修补桌面菜单与网页编辑器中的插件权限判断，使只读文件可以显示 **Plugins → Development → Import plugin from manifest…** 等入口，便于运行 Plumb 等读取设计信息的插件。文档本身仍为只读，服务端编辑权限和付费功能不在补丁范围内。

需要通过 Plumb 接入 Codex 时，参见 [快速入门](QUICKSTART.md)。

## 环境要求

- macOS，已安装 Figma 桌面客户端。
- Python 3、Node.js 20+，以及系统提供的 `ditto`、`codesign`。
- Acorn 8.16.0 已包含在 `vendor/` 中，无需运行 `npm install`。

## 快速开始

获取源码：

```bash
git clone https://github.com/sublimter/figma-plugins-patch.git
cd figma-plugins-patch
```

检查本机 Figma 的桌面代码是否匹配补丁规则：

```bash
python3 scripts/patch-figma.py --check
```

确认输出中 `compatible` 为 `true` 后，通过 **Figma → Quit** 正常退出 Figma，再构建并启动副本：

```bash
python3 scripts/patch-figma.py
bash scripts/launch-experiment.sh
```

默认读取“应用程序”目录中的 `Figma.app`，生成 `.local/Figma Plugin Experiment.app`。副本使用独立的应用标识和本地临时签名，沿用现有 Figma 本地配置；启动脚本会检查原版是否仍在运行。临时签名可能触发系统权限或登录提示。

打开只读设计文件，在 **Main menu → Plugins → Development** 中导入插件的 `manifest.json`，然后运行插件。也可以从 macOS 屏幕顶部的 **Plugins** 菜单进入。

恢复日常使用时，退出副本并打开“应用程序”目录中的 `Figma.app` 即可。

## 兼容范围

补丁面向普通 **Design 编辑器**。桌面客户端与网页编辑器分别检查兼容性：

- **桌面部分**：每条补丁规则必须恰好匹配一次，不依赖固定版本号或主脚本哈希。`--check` 仅读取安装包；规则不匹配时输出 `compatible: false`，退出码为 `2`。
- **网页部分**：运行时通过语法树和属性关系定位权限函数、选择器及菜单判断，支持旧版单脚本与新版共享权限脚本、主脚本分包结构。目标不唯一或行为检查失败时，原样加载该脚本并提示未适配，每次启动只提示一次。

已有验证记录（截至 2026-11-10）：

| Figma 版本 | 桌面规则、菜单测试、打包、签名与启动 | 实际只读文件中的插件验证 |
| --- | --- | --- |
| 126.10.13 | 已通过 | 待验证 |
| 126.11.7 arm64 | 已通过 | Development 入口、Plumb 配对、选区样式读取、PNG 截图和 SVG 导出已验证 |

`--check` 通过仅说明桌面规则匹配。网页资源可以独立更新，其他构建、文件和插件仍需实际验证。

## 重建与自定义路径

更新补丁代码或 Figma 后，退出副本并重建：

```bash
python3 scripts/patch-figma.py --refresh
```

`--refresh` 会核对现有副本与上次构建报告，拒绝覆盖不匹配的应用。

可指定其他源应用和输出位置，将示例中的相对路径替换为实际位置：

```bash
python3 scripts/patch-figma.py --source "./apps/Figma.app" --check
python3 scripts/patch-figma.py --source "./apps/Figma.app" --output "./patched/Figma Patched.app"
```

再次构建相同的自定义输出时，使用相同参数并追加 `--refresh`。`launch-experiment.sh` 只启动默认位置的副本；自定义输出需自行启动。

每个输出路径在 `.local/builds/<output-id>/` 中保存独立的原始主脚本、修改后主脚本和 `patch-report.json`。构建结果会打印 `artifactDirectory`；默认输出另外保留 `.local/patch-report.json`，报告记录版本、源路径和文件哈希。

## 接入 Plumb

按照 [Plumb MCP](https://github.com/tathagat22/plumb-mcp) 的文档安装或构建 Figma 插件，在 **Development → Import plugin from manifest…** 中选择它的 `figma-plugin/manifest.json`。

运行插件并完成本地服务器配对后，分别确认插件 UI 可打开、`plumb_status` 已连接、选中节点可读取，再验证所需的截图和资源导出操作。

## 实现与目录

桌面补丁使用 `patches/desktop-rules.json` 中的正则规则启用插件菜单，并在转发插件操作时移除 `showError` 标记。构建时重新计算 ASAR 偏移与完整性信息，再对副本签名；原生库加载需要副本启用 `disable-library-validation` entitlement。

网页补丁通过 Electron 内部调试接口拦截资源，由 Acorn 解析脚本后完成适配。只读标记在插件选择器的局部副本中处理，不修改全局文档状态。解析器、适配器和运行钩子一同嵌入应用，构建后的副本运行时无需读取仓库源码或安装 npm 依赖。

缓存按原始网页内容、引用的共享脚本和适配器构建指纹隔离，并校验缓存内容哈希。缓存损坏时重新适配，缓存不可写时仍可使用已验证的修改结果。

调试时可通过 `FIGMA_PLUGIN_EXPERIMENT_PROFILE` 指定独立配置目录，通过 `FIGMA_PLUGIN_EXPERIMENT_DEBUG=1` 启用 `127.0.0.1:19322` 调试端口。默认不开放远程调试端口。

```text
patches/desktop-rules.json          桌面补丁规则
scripts/patch-figma.py              兼容性检查、应用复制、ASAR 重打包与签名
scripts/launch-experiment.sh        默认副本启动脚本
scripts/frontend-adapter.cjs        网页脚本分析与适配
scripts/plugin-access-hook.cjs      资源拦截、缓存与失败诊断
scripts/verify-*.mjs                菜单、前端及运行钩子验证
tests/                             Python 测试与前端夹具
vendor/                            随源码提供的 Acorn 解析器及许可证
```

## 验证

在仓库根目录运行回归检查，无需启动 Figma：

```bash
python3 -m unittest discover -s tests -v
node scripts/verify-frontend-patch.mjs
node scripts/verify-runtime.mjs
```

构建默认副本后，验证桌面菜单与应用签名：

```bash
node scripts/verify-menu-patch.mjs
codesign --verify --deep --strict ".local/Figma Plugin Experiment.app"
```

自定义输出可将其 `patch-report.json` 路径传给 `verify-menu-patch.mjs`。

验证实际网页脚本时，向前端验证脚本传入本地 bundle；分包版本在主脚本后追加权限共享脚本路径：

```bash
node scripts/verify-frontend-patch.mjs ./bundles/main.js ./bundles/permissions.js
```

旧版单脚本只需传入一个路径。`fetch-frontend.mjs` 可以下载其源码中固定地址的已适配 bundle，保存到 `.local/frontend/figma_app-current.js`；它不会自动查找最新网页版本。该文件存在时，无参数的前端验证脚本也会检查它。

测试覆盖目标缺失或重复、压缩名称与格式变化、文档状态不变、其他编辑器模式、未登录状态、缓存损坏、分包响应顺序、失败放行和一次性提示。`verify-runtime.mjs` 还可接收含 `manifest.json` 的捕获资源目录，重放实际加载顺序。自动检查通过后，仍需在实际只读文件中确认插件运行和 MCP 读取结果。

## 网页更新后无法适配

应用会提示“当前 Figma 网页版本暂未适配”，可点击 **打开诊断文件夹**。材料保存在 Figma 配置目录的 `plugin-access-experiment/failures/` 下，包括：

- `source.js`：无法适配的网页脚本。
- `reference-*.js`：适配时引用的共享脚本（如有）。
- `report.json`：适配器版本、哈希与失败原因，资源 URL 移除查询参数。
- `repair-request.md`：供 Codex 等工具修复适配器的说明。

根据诊断材料修复 `frontend-adapter.cjs`，补充回归并检查新旧网页脚本，再退出副本执行 `--refresh`。桌面规则失配时则需先更新 `desktop-rules.json`，重新检查打包、签名和菜单行为。

生成的应用、下载资源和调试材料保存在 Git 忽略的 `.local/` 中。仓库包含补丁源码、测试和 Acorn，不包含 Figma 安装包、应用副本或 Plumb 插件。

## 许可证

项目采用 [MIT License](LICENSE)。Acorn 的许可证见 [vendor/ACORN-LICENSE](vendor/ACORN-LICENSE)。
