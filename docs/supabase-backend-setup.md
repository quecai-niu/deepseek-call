# Supabase + 后端配置说明

## 1. 创建 Supabase 项目

打开 [database.new](https://database.new)，创建一个 Supabase Free 项目。

项目创建完成后，需要复制三个值：

- Project URL -> 填入 `.env` 的 `SUPABASE_URL`
- Publishable key 或 legacy anon public key -> 填入 `.env` 的 `SUPABASE_ANON_KEY`
- Secret key 或 legacy service_role key -> 填入 `.env` 的 `SUPABASE_SERVICE_ROLE_KEY`

不要把 secret/service role key 放进前端代码，也不要提交到 git。

## 2. 获取 Project URL 和 API Keys

在 Supabase Dashboard 中：

1. 进入你的项目。
2. 点击左下角或侧边栏的 `Project Settings`。
3. 打开 `API Keys`。
4. 复制 `Project URL`。
5. 复制 `Publishable key`；如果页面显示 legacy keys，也可以复制 `anon public`。
6. 复制 `Secret key`；如果页面显示 legacy keys，也可以复制 `service_role`。

本项目后端已经兼容新版 `sb_publishable_...` / `sb_secret_...`，也兼容旧版 `anon` / `service_role` JWT key。

## 3. 创建数据库表

在 Supabase Dashboard 中：

1. 打开 `SQL Editor`。
2. 新建 query。
3. 复制下面文件里的全部 SQL：

```text
supabase/migrations/20260603000000_conversation_management.sql
```

4. 粘贴到 SQL Editor。
5. 点击运行。

这会创建对话、消息、文件元数据、工具调用记录和摘要相关表，并启用 RLS 策略。

## 4. 配置本地环境变量

本地 `.env` 已经被 `.gitignore` 忽略，不会提交到 git。

需要填入：

```text
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
DEEPSEEK_API_KEY=
TAVILY_API_KEY=
```

`DEEPSEEK_API_KEY` 已经配置在本机 `.env` 中。  
`TAVILY_API_KEY` 可选；不填时联网搜索开关不会真正执行搜索。

## 5. 本地启动

```bash
npm start
```

然后打开：

```text
http://localhost:5173
```

健康检查接口：

```text
http://localhost:5173/api/health
```

## 6. 部署注意事项

- 前端和后端尽量同域部署，这样前端可以直接调用 `/api/*`。
- `DEEPSEEK_API_KEY`、`TAVILY_API_KEY`、`SUPABASE_SERVICE_ROLE_KEY` 只放后端环境变量。
- 如果前端和后端分开域名部署，需要配置 `CORS_ORIGIN`。
- 后续如果从 Supabase 迁移到 Neon、自建 Postgres 或其他 Postgres 平台，主要改后端数据库访问层和环境变量。

## 7. 上下文行为

- 完整消息存储在 `messages` 表中。
- 每次模型请求只发送 `CONTEXT_MESSAGE_LIMIT` 和 `CONTEXT_CHAR_BUDGET` 限制内的最近消息。
- 后续长对话摘要会接入 `conversation_summaries`。
