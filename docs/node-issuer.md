# Node Issuer 实现说明

`tokengift` 的 Node issuer 用来为 agent 自动创建有限额、限模型、可过期的 API key。它不实现请求中转，也不持有真实上游模型 key；额度耗尽后的硬停止由 New API、One API 或其二次开发平台执行。

## 支持的平台

| Provider | 状态 | 管理接口 | 用量接口 |
| --- | --- | --- | --- |
| `newapi` | 主路径 | `/api/token/` | `/api/usage/token`，失败后 fallback 到 `/v1/dashboard/billing/usage` |
| `oneapi` | 兼容路径 | `/api/token/` | 暂不提供统一 usage 命令 |
| 一展 API | New API 二开兼容 | `/api/token/` + `X-Api-User` | `/v1/dashboard/billing/usage` |

## 安全边界

- 管理 token 只从环境变量、命令参数或本地 `.env` 读取。
- 管理 token 不会写入 gift payload、浏览器 localStorage、README 示例或输出 JSON。
- `issue` 输出给 agent 的只是有限额 API key。
- 如果传 `--public`，输出会被 RSA-OAEP(SHA-256) 加密。
- 如果传 `--link-base`，输出是可领取链接。

## 环境变量

Node CLI 会自动读取当前目录下的 `.env`，仅填充当前进程缺失的环境变量。

### New API / 一展 API

```bash
NEWAPI_BASE_URL=https://newapi.example.com
NEWAPI_USER_TOKEN=your-user-token
NEWAPI_USER_ID=1
```

也兼容以下别名：

```bash
NEW_API_URL=https://vip.yi-zhan.top
NEW_API_TOKEN=your-user-token
NEW_API_USER_ID=293
NEW_API_BASE_URL=https://newapi.example.com
NEW_API_USER_TOKEN=your-user-token
```

### One API

```bash
ONEAPI_BASE_URL=https://oneapi.example.com
ONEAPI_ACCESS_TOKEN=your-oneapi-access-token
```

也兼容以下别名：

```bash
ONE_API_URL=https://oneapi.example.com
ONE_API_TOKEN=your-oneapi-access-token
ONE_API_BASE_URL=https://oneapi.example.com
ONE_API_ACCESS_TOKEN=your-oneapi-access-token
```

### 用量查询 key

为了避免 `npm run` 回显完整 key，推荐用环境变量给 `usage` 传入有限额 key：

```bash
TOKENGIFT_API_KEY=sk-limited-xxx
NEWAPI_API_KEY=sk-limited-xxx
NEW_API_API_KEY=sk-limited-xxx
```

## 创建有限额 key

```bash
npm run tokengift -- issue \
  --provider newapi \
  --name agent-a \
  --quota 100000 \
  --models gpt-4o-mini,gpt-4o \
  --expires-at -1
```

默认输出配置 JSON：

```json
{
  "profileName": "agent-a",
  "apiKey": "sk-limited-xxx",
  "baseUrl": "https://newapi.example.com/v1",
  "models": [
    { "id": "gpt-4o-mini", "rate": 1 },
    { "id": "gpt-4o", "rate": 1 }
  ],
  "tokenQuota": 100000,
  "provider": "newapi",
  "issuerTokenId": 123,
  "expiresAt": -1,
  "quotaUnit": "platform_quota"
}
```

`baseUrl` 会自动规范为 OpenAI-compatible 客户端地址。如果输入 `https://vip.yi-zhan.top`，输出给 agent 的地址会是 `https://vip.yi-zhan.top/v1`。

## 加密输出和领取链接

只输出加密 payload：

```bash
npm run tokengift -- issue \
  --provider newapi \
  --name agent-a \
  --quota 100000 \
  --models gpt-4o-mini \
  --public keys/bob_public.pem
```

输出完整领取链接：

```bash
npm run tokengift -- issue \
  --provider newapi \
  --name agent-a \
  --quota 100000 \
  --models gpt-4o-mini \
  --public keys/bob_public.pem \
  --link-base https://your-domain/
```

未传 `--public` 但传了 `--link-base` 时，会生成 `?cfg=<base64url-json>` 链接。传了 `--public` 时，会生成 `?gift=<cipher>` 链接。

## 查询用量

标准 New API：

```bash
export TOKENGIFT_API_KEY="sk-limited-xxx"

npm run tokengift -- usage \
  --provider newapi \
  --base-url https://newapi.example.com
```

一展 API 这类二次开发平台可能没有 `/api/usage/token`，CLI 会自动 fallback 到：

```text
/v1/dashboard/billing/usage?start_date=<ms>&end_date=<ms>
```

可指定毫秒级时间窗口：

```bash
npm run tokengift -- usage \
  --provider newapi \
  --start-date 1716149437000 \
  --end-date 1746517437000
```

## 撤销 key

```bash
npm run tokengift -- revoke \
  --provider newapi \
  --token-id 123
```

One API 同样使用 `--provider oneapi` 和 `--token-id`。

## Dry run

`--dry-run` 不会发出真实创建、查询或撤销请求，只输出将要请求的接口形状，且会脱敏 header：

```bash
npm run tokengift -- issue \
  --provider newapi \
  --name tg-dry-run \
  --quota 1000 \
  --models gpt-4o-mini \
  --dry-run
```

## New API 请求映射

`issue --provider newapi` 创建 token 时发送：

```json
{
  "name": "agent-a",
  "expired_time": -1,
  "remain_quota": 100000,
  "unlimited_quota": false,
  "model_limits_enabled": true,
  "model_limits": ["gpt-4o-mini"],
  "allow_ips": "",
  "group": "default"
}
```

headers：

```text
Authorization: Bearer <manager-token>
New-Api-User: <user-id>
X-Api-User: <user-id>
```

`X-Api-User` 是为一展 API 这类 New API 二次开发平台兼容而加；标准 New API 会忽略不需要的 header。

## One API 请求映射

`issue --provider oneapi` 创建 token 时发送：

```json
{
  "name": "agent-a",
  "expired_time": -1,
  "remain_quota": 100000,
  "unlimited_quota": false,
  "models": "gpt-4o-mini,gpt-4o",
  "subnet": "192.168.1.0/24"
}
```

headers：

```text
Authorization: <oneapi-access-token>
```

One API 官方管理 API 文档不完整，该兼容层按其 README 功能说明和当前源码字段实现。

## 输出字段说明

| 字段 | 含义 |
| --- | --- |
| `profileName` | token 名称，默认等于 `--name` |
| `apiKey` | 平台创建出的有限额 key |
| `baseUrl` | agent 使用的 OpenAI-compatible `/v1` 地址 |
| `models` | tokengift 页面可展示和兑换的模型列表 |
| `tokenQuota` | 平台额度数值，不等同于原始模型 token 数 |
| `provider` | `newapi` 或 `oneapi` |
| `issuerTokenId` | 平台 token id，用于撤销 |
| `expiresAt` | Unix 秒级过期时间；`-1` 表示永不过期 |
| `quotaUnit` | 当前固定为 `platform_quota` |

## 已知兼容点

- Node CLI 需要 Node.js 18+，因为使用内置 `fetch`。
- 网络请求内置 3 次轻量重试，用于处理偶发 `fetch failed`。
- 一展 API 的普通用量查询需要有限额 key，不接受管理 token。
- `npm run` 会回显命令参数，敏感 key 推荐通过环境变量传入，不推荐写在 `--api-key` 后面。
- npm 包只包含 `README.md`、`package.json` 和 `scripts/tokengift.js`；Python CLI 暂不包含 issuer 功能。
