# 项目记忆

## 项目目标

把当前 DeepSeek Chat 从单页本地对话工具，逐步升级为类似常见 AI 网页端/手机端的多对话聊天应用：

- 支持 Supabase Auth 登录。
- 支持云端保存完整历史对话。
- 支持开启新对话。
- 老对话保留，不默认删除。
- 模型请求只发送裁剪后的上下文，数据库保存完整历史。
- 后续预留文件输入、联网搜索、Agent 工具调用能力。

## 当前结构

- `index.html`：前端页面入口。
- `css/style.css`：页面样式。
- `js/settings.js`：本地非敏感设置，例如模型、思考模式、朗读速度、联网开关。
- `js/auth.js`：Supabase Auth 浏览器端封装。
- `js/api.js`：前端调用本项目后端 API，包括对话接口和聊天 SSE。
- `js/app.js`：主控制器，管理登录状态、对话列表、当前对话、发送消息、语音状态。
- `js/chat-ui.js`：消息 DOM 渲染。
- `server/server.js`：独立 Node 后端，提供静态资源、`/api/*`、模型调用、Supabase REST 访问。
- `supabase/migrations/20260603000000_conversation_management.sql`：Supabase/Postgres 表结构和 RLS 策略。
- `docs/conversation-management-plan.md`：中文对话管理执行计划。
- `docs/supabase-backend-setup.md`：中文 Supabase 和后端配置说明。

## 当前进度

- 已新增独立 Node 后端。
- 已将前端从直连 DeepSeek 改为调用后端 `/api/chat`。
- 已加入 Supabase Auth 前端登录入口。
- 已加入对话列表、新对话、老对话加载的前端骨架。
- 已加入 Supabase/Postgres migration。
- 已将默认模型切为 `deepseek-v4-flash`。
- 已把 DeepSeek Key 写入本地 `.env`，该文件被 git 忽略。
- Supabase 本地环境变量已配置，Project URL 使用 `https://cwtkiybfuimlgkgoddzw.supabase.co`。
- Supabase 数据库表 SQL 已由用户在 SQL Editor 执行。
- Supabase Auth、创建对话、读取对话列表、读取消息接口已通过临时用户联调；临时用户已删除。

## 已知当前状态

- 本地后端端口：`5173`。
- 健康检查：`GET /api/health`。
- 当前健康检查应显示 DeepSeek 已配置，Supabase 已配置。
- 登录、创建对话、读取历史的后端接口已验证。
- 尚未实际调用 `/api/chat` 生成模型回复，以避免消耗模型 token；DeepSeek 配置和默认 flash 模型已验证。

## 需要持续遵守

- 每次回复先写“喵”。
- 不擅自改 git 暂存区。
- `.env`、密钥、service role/secret key 不进 git。
- 默认模型保持 `deepseek-v4-flash`，除非用户明确要求切换。
- 老对话不要删除；需要删除时优先做归档或软删除。
- 后续重构时保持前端/后端职责清晰。

## 暂存区备注

当前暂存区中存在用户之前留下的内容，包括 `.playwright-mcp/*`、`js/voice-input.js`、`test.html`、`test_output.txt` 等。  
其中 `.playwright-mcp/*` 和 `test_output.txt` 看起来不适合进入 git，已加入 `.gitignore`，但尚未从暂存区移除，因为不能擅自改变暂存区边界。
