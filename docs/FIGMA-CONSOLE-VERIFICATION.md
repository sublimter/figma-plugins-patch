# Console MCP 本地读取验证

适用于 Console MCP 1.46.0 与其随包的 Desktop Bridge 插件 1.41.5，验证日期为 2026-11-10。安装步骤见 [快速入门](../QUICKSTART.md)。此方案通过本地插件读取，不需要添加 Figma key、PAT 或 `FIGMA_ACCESS_TOKEN`；`fileKey` 由插件自动提供，只是文件标识。

## 验证步骤

以下是交给 Codex 执行的 MCP 调用，直接使用 `figma-console` 服务，无需另写调用脚本。读取过程中保持 Desktop Bridge 运行，不修改设计内容。

| 检查 | 调用与通过条件 |
| --- | --- |
| 连接 | `figma_diagnose({"verbose": true})`：插件已连接，文件名和页面正确；`token.hasToken: false` 可以正常使用本地通道 |
| 响应 | `figma_get_status({"probe": true})`：主动探测成功，而不仅是端口已打开 |
| 选区 | `figma_get_selection({"verbose": true})`：数量、节点 ID、名称、类型和尺寸与实际选择一致；同名节点按 ID 区分 |
| 子节点 | 对选区内每个根节点调用 `figma_get_component_for_development_deep({"nodeId": "实际节点 ID", "depth": 0})`；需要隐藏分支时用原始 Plugin API 补齐 |
| 布局 | 通过 `figma_execute` 逐节点读取原始 `x/y/width/height/rotation/relativeTransform/absoluteTransform`，再核对 Auto Layout、四边 padding、itemSpacing、对齐、圆角、描边与可见性，保留原始小数 |
| 文字 | 核对文本、字体、字号、行高、字间距、对齐及文字样式；同一文本包含多种样式时读取分段数据 |
| 颜色 | 核对 fills/strokes、透明度、渐变以及绑定的颜色样式名称；颜色变量和样式分别处理 |
| 资源 | 对实际节点分别调用 `figma_take_screenshot({"nodeId": "实际节点 ID", "format": "png", "scale": 1})` 或 `format: "svg"`，核对返回的 `source: "desktop_bridge"` |

首次重连后，选区工具的缓存可能为空。可重新选择图层，或直接通过 `figma_execute` 实时查询：

```javascript
return {
  page: figma.currentPage.name,
  selection: figma.currentPage.selection.map(node => ({
    id: node.id, name: node.name, type: node.type,
    width: node.width, height: node.height
  }))
};
```

不要把空缓存当成用户没有选择图层。多文件连接时核对目标文件，`figma_execute` 可传入该文件的 `fileKey`。节点 ID 应从本次实时选区获取。

## 布局与颜色来源

深度工具用于读取结构和样式；当前版本不返回 `x/y/rotation`，且对 `width/height` 取整。即使节点可见，精确布局也必须通过 `figma_execute` 从原始 Plugin API 补读，不能仅依赖深度工具。

节点的 `x/y` 相对于父节点。核对跨容器间距时应统一坐标系；有旋转时结合变换矩阵计算。普通、未旋转兄弟节点的垂直间距可用 `下方.y - (上方.y + 上方.height)` 计算。`itemSpacing` 是 Auto Layout 设置，应与实际位置结合核对，不能把它当作任意两元素之间的距离。

C37 等标号来自设计团队命名的颜色样式。读取链路为：图层 `fillStyleId` → `figma.getStyleByIdAsync(id)` → 样式 `name`。例如本次读到了 `…/C37 - 页面底色`，图层填充色为 `#E3E5EB`。它不是 Figma 通用色号，也不能只凭色值推断项目中的 Swift 属性。

只读查询示例，同样在 `figma_execute` 内执行：

```javascript
const node = figma.currentPage.selection[0];
if (!node) return { error: "请先选择图层" };
const styleId = typeof node.fillStyleId === "string" ? node.fillStyleId : "";
const style = styleId ? await figma.getStyleByIdAsync(styleId) : null;
return {
  nodeId: node.id,
  fills: "fills" in node ? node.fills : null,
  fillStyleId: styleId,
  fillStyleName: style ? style.name : null
};
```

此示例只核对第一个选中节点。完整读取时必须遍历全部选区及子节点。未绑定样式时只能报告色值；混合填充需检查具体子节点或文本分段。变量绑定通过 `boundVariables`、`figma.variables.getVariableByIdAsync()` 等接口读取，并结合生效模式解析。

## 资源与完整性

PNG 是渲染截图，不能据此判断设计中存在位图资源。先检查 IMAGE 类型填充；矢量图标可按节点导出 SVG。工具返回图片内容时，将实际内容保存到 `.local/figma-exports/`，检查 PNG 尺寸、SVG 的 viewBox 和实际填充/描边，不要只检查文件是否存在。

内置深度工具会跳过隐藏分支；需要完整结构时，在 `figma_execute` 中用原始 Plugin API 递归遍历 `children`，记录原始 ID、父子关系、`visible`、`opacity` 等属性。透明占位图标和隐藏子节点不能误报为可见资源。大选区可按子树分批读取，不应无声省略节点或合并同名元素。

本次实际验证结果：

- 读取一个选中页面框架，完整遍历得到 99 个节点；内置深度工具返回 96 个，差异为隐藏分支中的 3 个节点。
- 临时选择两个同名卡片时，正确返回数量 2 及不同的节点 ID，随后恢复原选区。
- 读取了 14 个颜色/文字样式，确认样式命名中的 C37 与实际填充色。
- 导出并校验一张 390×844 PNG 和三个 SVG；当前子树没有 IMAGE 类型位图填充。

真实设计的文件标识、节点数据和导出图片留在本地，不随仓库发布。新增验证时记录工具版本、选区数量、节点数量、资源尺寸和失败原因，区分自动检查与实际 Figma 运行结果。

## 使用边界

- 当前版本的本地读取、PNG/SVG 导出不依赖 Token，未发现本地按次或按月额度限制。Codex 模型额度仍单独计算，不能承诺未来版本永久不限次。
- REST 专用功能及部分工具的 REST 回退需要 PAT；缺少 Token 时回退可能失败，不代表本地次数用完。本版本截图工具的 PDF 路径使用 REST，不纳入上述无 Token 验证范围。
- 截图工具会将最长边限制在 1568 像素，实际导出可能小于请求的 scale；以返回数据和文件尺寸为准。
- 未进行长时间高频压力测试；插件连接、登录状态、文件权限、超时和大结果体积仍会影响使用。
- 本次验证不代表 Swift/UIKit 页面已完成。后续仍需在项目中映射颜色与组件，构建运行后做设备截图对比。

上游资料：[Figma Console MCP](https://github.com/southleft/figma-console-mcp)、[Figma Plugin API](https://developers.figma.com/docs/plugins/)、[Figma REST 限流](https://developers.figma.com/docs/rest-api/rate-limits/)。
