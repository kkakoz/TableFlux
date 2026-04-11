## Why

当前前端各页面与组件在间距、控件尺寸（尤其按钮）上不够一致，整体偏松散，与桌面数据库客户端常见的紧凑工作区体验不符。需要在不破坏可用性的前提下统一视觉密度，并把约定写入项目规则，便于后续迭代保持一致。

## What Changes

- 建立一套紧凑型 UI 约定（间距、字体层级、控件最小高度/内边距），优先在 `frontend/` 内落地。
- 将按钮及主要可点击控件统一为更小尺寸（在可访问性可接受范围内），并通过可复用的类名或设计令牌减少各处魔法数。
- 梳理并收敛分散的组件级 CSS（如各 `*.css`）与 Tailwind 用法，避免同一类控件多套互斥样式。
- 在 Cursor 项目规则中增加「前端样式与紧凑 UI」章节，描述令牌命名、按钮/表单控件约定及修改时的注意点（**不涉及** Go 后端或 API 变更）。

## Capabilities

### New Capabilities

- `frontend-compact-ui`: 定义 TableFlux 前端紧凑布局与控件尺寸的可测试需求（含按钮较小、密度一致、与 Cursor 规则对齐的文档化约定）。

### Modified Capabilities

- （无）当前 `openspec/specs/` 下无既有能力规范需增量修改。

## Impact

- **代码**：主要影响 `frontend/`（`App.tsx`、各 `components/*.css`、全局样式与 Tailwind 配置若有）。无 Wails 绑定或 Go Service 变更。
- **依赖**：不新增运行时依赖为宜；若采用 CSS 变量或现有 Tailwind 主题扩展，仅触及构建/样式层。
- **协作**：新增/修改 `.cursor/rules`（或项目约定的规则文件）中的样式约定，供 AI 与人工遵循。
