# 密钥设置（Dashboard → 密钥设置）

## 首次使用

1. 在**服务器本机**打开 `http://127.0.0.1:18600/dashboard`。
2. 若 `SERVER_API_KEY` 为空/占位值（如 `PLACEHOLDER_CHANGE_ME`）或少于 16 位，系统处于“初始化模式”：除 `GET /api/secrets/bootstrap-status` 与本机 `POST /api/secrets/bootstrap` 外，所有 API / MCP 一律拒绝。
3. 登录页显示“首次初始化”表单：设置强管理员 key（≥24 位、≥3 类字符、≥10 个不同字符；可点“生成随机 key”），保存后自动登录。
4. 之后所有接口必须携带 `Authorization: Bearer <管理员 key>`。
5. 左侧进入“密钥设置”，填写公众号 AppID/AppSecret、大模型、图片、Embedding、通知 webhook，点“保存”。立即热更新，无需重启。
6. “测试连接（只读）”：微信只获取 access_token（40164 会提示需加入白名单的 IP）；大模型只调用 `GET /models`。`PUBLISH_ENABLED=false` 时也可用，不发布任何内容。

> Docker 端口映射下，宿主机 127.0.0.1 的请求在容器内可能显示为网关 IP（如 `172.x.0.1`）。`bootstrap-status` 返回 `clientIp`；需要时在 `.env` 设置 `BOOTSTRAP_ALLOWED_IPS=<该IP>`。端口只绑定 `127.0.0.1:18600`，外部机器无法访问。

## 安全设计

- 密钥字段只写不读：接口只返回“已配置/未配置”与来源（页面/环境变量），从不返回值；非密钥字段（AppID、作者、Base URL、模型名）可显示。
- 字段白名单：`PUBLISH_ENABLED` 等不在白名单，页面无法修改。
- 加密：每个值独立 AES-256-GCM，随机 12 字节 IV，AAD=字段名；`data/secrets/secrets.enc.json`，原子写入。
- 主密钥：优先 `TRENDPUBLISH_MASTER_KEY`（base64 32 字节），否则 `data/keys/master.key`（自动生成，0600）。可用 `TRENDPUBLISH_MASTER_KEY_FILE`、`TRENDPUBLISH_SECRETS_DIR` 改路径。
- 优先级：页面保存值 > 环境变量/.env > /run/secrets；清除页面值即回退。
- 审计：`data/secrets/audit.log.jsonl` 记录时间、操作者（IP）、动作、字段，不记录值。
- 保存的值注册到日志脱敏器；响应 `Cache-Control: no-store`；管理员 key 常量时间比对。
- `data/`、`*.key` 已加入 `.gitignore`。

## 备份与恢复

- 同时备份 `data/secrets/`（密文）和主密钥（`data/keys/master.key` 或 `TRENDPUBLISH_MASTER_KEY`），**分开存放**；缺主密钥无法解密。
- 恢复：放回原路径（或设置环境变量）后 `docker compose -p trendpublish-wx up -d`。
- 主密钥丢失 / 忘记管理员 key：页面值优先于 `.env`，因此需删除 `data/secrets/secrets.enc.json`；若 `.env` 中 `SERVER_API_KEY` 为占位值则重新本机初始化，再在页面重新录入各密钥。
