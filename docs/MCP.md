# TrendPublish MCP 服务

TrendPublish 在现有服务上提供一个 MCP（Model Context
Protocol）服务层。写作由**你自己的客户端**完成（Codex、WorkBuddy、Cursor、Claude
Desktop
等，消耗你自己的模型额度，过程完全可见）；服务端负责提供数据和工具，并**强制执行所有关卡**：

- `PUBLISH_ENABLED`：总开关，默认
  `false`，关闭时所有微信写操作（上传图片、建草稿、发布）一律拒绝；
- `PUBLISH_MODE`：`draft`（默认，只允许建草稿）或 `publish`（允许
  `freepublish/submit` 正式发布）；
- 质量门禁：事实不足 / 历史重复 /
  版权风险，任何一项不通过都不能建草稿或发布，**没有绕过参数**；
- 幂等：taskId = 账号 + 业务键（默认内容哈希），草稿与正式发布都按 taskId
  去重，同一草稿永不重复提交；
- 只使用微信官方接口（`draft/add`、`material/add_material`、`media/uploadimg`、`freepublish/submit`、`freepublish/get`）。

工具输出和日志都会做密钥脱敏，不会返回 AppSecret、API Key、access_token。

## 端点

| 传输                    | 地址                                                              | 认证                                     |
| ----------------------- | ----------------------------------------------------------------- | ---------------------------------------- |
| Streamable HTTP（推荐） | `POST http://127.0.0.1:18600/mcp`                                 | `Authorization: Bearer <SERVER_API_KEY>` |
| stdio                   | `docker exec -i trendpublish-wx deno run -A scripts/mcp-stdio.ts` | 本机进程，无需 token                     |

说明：HTTP 端为无状态实现，`POST` 返回 `application/json`；纯通知返回
`202`；`GET /mcp` 返回 `405`（不提供服务端推送流）。 支持协议版本 `2025-06-18` /
`2025-03-26` / `2024-11-05`。服务只绑定在 `127.0.0.1`，如需远程使用请自行加
HTTPS 反向代理。

## 工具

| 工具                                  | 类型   | 说明                                                                         |
| ------------------------------------- | ------ | ---------------------------------------------------------------------------- |
| `trendpublish_list_sources`           | 只读   | 已配置的数据源                                                               |
| `trendpublish_fetch_hot_topics`       | 只读   | 用服务端抓取通道抓最新内容（标题/链接/时间/摘要）                            |
| `trendpublish_score_topics`           | 只读   | 确定性选题打分：时效、跨来源热度、写作方案匹配度、新颖度；标记重复           |
| `trendpublish_dedup_check`            | 只读   | 与该账号历史文章去重                                                         |
| `trendpublish_get_writing_guidelines` | 只读   | 写作方案、风格指南、门禁规则、当前写开关状态                                 |
| `trendpublish_submit_article`         | 本地写 | 提交文章（markdown 或 html + 来源 + 图片版权声明），生成确定性 taskId 并落盘 |
| `trendpublish_run_quality_gate`       | 本地写 | 运行门禁并持久化结果                                                         |
| `trendpublish_upload_image`           | 微信写 | 封面 `add_material`（按账号+URL 缓存）/ 正文 `uploadimg`；需开关 + 门禁通过  |
| `trendpublish_create_draft`           | 微信写 | `draft/add`；需开关 + 门禁 + 封面已上传；幂等                                |
| `trendpublish_publish`                | 微信写 | `freepublish/submit`；需开关 + `PUBLISH_MODE=publish`；之后服务端每分钟轮询  |
| `trendpublish_get_status`             | 只读   | 任务、门禁、发布记录；`refresh=true` 立即查询一次发布状态                    |

推荐流程：读规范 → 抓热点/打分 → 去重 → 客户端写作 → 提交 → 门禁（按 issues
修改后重新提交，内容变化会得到新 taskId）→ 上传图片 → 建草稿 →（可选）正式发布 →
查状态。

每个任务的产物保存在
`data/temp/mcp-tasks/<taskId>/`：`task.json`、`article.html`、`article.md`、`sources.json`、`gate.json`、`run.log.jsonl`；发布状态在
SQLite 的 `publish_records` 表。

### 门禁规则（服务端确定性检查，不调用大模型）

- 至少 2 个 http(s) 来源；至少 1 个来源可核验（附 ≥80 字原文摘录
  `excerpt`，或服务端能抓取到原文）；
- 正文纯文本 ≥ 600 字；
- 正文与任一来源原文的 12 字片段重合度 ≤ 30%（防搬运/洗稿）；
- 所有图片必须声明 `rights`：`generated` / `own` / `licensed` /
  `public_domain`；
- 与该账号历史文章标题高度相似或来源大量重合 → 拦截。

## 客户端配置

先在本机设置环境变量（值即 `.env` 中的
`SERVER_API_KEY`，不要写进配置文件或提交到 git）：

```powershell
# Windows（当前用户永久生效，重开终端/客户端后可用）
[Environment]::SetEnvironmentVariable("TRENDPUBLISH_API_KEY", "<你的 SERVER_API_KEY>", "User")
```

### Codex（`~/.codex/config.toml`）

Streamable HTTP：

```toml
[mcp_servers.trendpublish]
url = "http://127.0.0.1:18600/mcp"
bearer_token_env_var = "TRENDPUBLISH_API_KEY"
```

（较老版本的 Codex 需要在顶层加 `experimental_use_rmcp_client = true` 才支持
HTTP。）

stdio（不需要 token）：

```toml
[mcp_servers.trendpublish]
command = "docker"
args = ["exec", "-i", "trendpublish-wx", "deno", "run", "-A", "scripts/mcp-stdio.ts"]
```

### Cursor（`~/.cursor/mcp.json` 或项目内 `.cursor/mcp.json`）

```json
{
  "mcpServers": {
    "trendpublish": {
      "url": "http://127.0.0.1:18600/mcp",
      "headers": { "Authorization": "Bearer ${env:TRENDPUBLISH_API_KEY}" }
    }
  }
}
```

### Claude Desktop / WorkBuddy 等 `mcp.json` 风格客户端

stdio（最通用）：

```json
{
  "mcpServers": {
    "trendpublish": {
      "command": "docker",
      "args": [
        "exec",
        "-i",
        "trendpublish-wx",
        "deno",
        "run",
        "-A",
        "scripts/mcp-stdio.ts"
      ]
    }
  }
}
```

只支持 stdio、但想走 HTTP 的客户端，可用 `mcp-remote` 桥接：

```json
{
  "mcpServers": {
    "trendpublish": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:18600/mcp",
        "--header",
        "Authorization:${AUTH_HEADER}"
      ],
      "env": { "AUTH_HEADER": "Bearer <你的 SERVER_API_KEY>" }
    }
  }
}
```

## 自检

```powershell
$h = @{ Authorization = "Bearer $env:TRENDPUBLISH_API_KEY" }
Invoke-RestMethod http://127.0.0.1:18600/mcp -Method Post -Headers $h -ContentType application/json `
  -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 限制

- 门禁是确定性规则（长度、来源、重合度、去重、图片版权声明），不能替代人工事实核查；
- `fetch_hot_topics` 使用配置文件中的数据源，Dashboard
  上编辑的运行时数据源暂未接入 MCP；
- 历史去重基于编辑记忆（工作流写入）；MCP 提交并发布的文章暂未回写编辑记忆；
- HTTP 端无会话与服务端推送（每个请求独立），长耗时工具（抓取）会同步等待；
- relay 发布通道不支持正式发布。
