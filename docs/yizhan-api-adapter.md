# 一展 API 适配说明

本文说明 TokenGift 如何适配一展 API 这类 New API 二次开发平台，用于给 agent 创建有限额、限模型、可撤销的礼物 key。

## 定位

一展 API 在 TokenGift 中按 `newapi` provider 兼容处理。TokenGift 不要求一展 API 为第一阶段额外开发接口，而是复用平台已有的 token 管理能力：

- 创建有限额 key。
- 限制可用模型。
- 查询有限额 key 的用量。
- 撤销已经发出的 key。
- 将有限额 key 包装成 TokenGift gift payload 或领取链接。

TokenGift 不会把上游主 key 或管理 token 写入 gift payload。发给 agent 的只应该是有限额 key。

## 前置条件

你需要准备：

- 一展 API 站点地址，例如 `https://vip.yi-zhan.top`。
- 一展 API 用户管理 token。
- 一展 API 用户 ID。
- 可用模型列表，例如 `gpt-4o-mini,gpt-4o`。

管理 token 只用于创建、查询和撤销有限额 key，应放在环境变量或本地 `.env` 中，不要放进网页链接、gift payload、README 示例或聊天记录。

## 环境变量

一展 API 推荐使用以下兼容变量名：

```bash
NEW_API_URL=https://vip.yi-zhan.top
NEW_API_TOKEN=your-manager-token
NEW_API_USER_ID=293
```

TokenGift 也兼容标准 New API 变量名：

```bash
NEWAPI_BASE_URL=https://vip.yi-zhan.top
NEWAPI_USER_TOKEN=your-manager-token
NEWAPI_USER_ID=293
```

查询有限额 key 用量时，推荐把有限额 key 放入：

```bash
TOKENGIFT_API_KEY=sk-limited-xxx
```

也兼容：

```bash
NEWAPI_API_KEY=sk-limited-xxx
NEW_API_API_KEY=sk-limited-xxx
```

## 创建有限额 key

Node CLI：

```bash
npm run tokengift -- issue \
  --provider newapi \
  --name agent-b-review-budget \
  --quota 100000 \
  --models gpt-4o-mini,gpt-4o \
  --expires-at -1
```

Python CLI：

```bash
tokengift issue \
  --provider newapi \
  --name agent-b-review-budget \
  --quota 100000 \
  --models gpt-4o-mini,gpt-4o \
  --expires-at -1
```

输出会是 TokenGift 配置 JSON，核心字段类似：

```json
{
  "profileName": "agent-b-review-budget",
  "apiKey": "sk-limited-xxx",
  "baseUrl": "https://vip.yi-zhan.top/v1",
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

注意：

- `baseUrl` 会自动规范成 OpenAI-compatible 地址。如果输入 `https://vip.yi-zhan.top`，输出给 agent 使用的是 `https://vip.yi-zhan.top/v1`。
- `quota` 是一展 API 平台额度单位，通常会受到分组倍率、模型倍率、输入输出倍率影响，不等同于原始模型 token 数。
- 额度耗尽后的硬停止由一展 API 执行，TokenGift 只负责创建、包装、分发和查询。

## 加密给接收方

如果接收 agent 提供了公钥，可以直接输出加密 gift：

```bash
npm run tokengift -- issue \
  --provider newapi \
  --name agent-b-review-budget \
  --quota 100000 \
  --models gpt-4o-mini \
  --public keys/agent_b_public.pem
```

生成可领取链接：

```bash
npm run tokengift -- issue \
  --provider newapi \
  --name agent-b-review-budget \
  --quota 100000 \
  --models gpt-4o-mini \
  --public keys/agent_b_public.pem \
  --link-base https://mappedinfo.github.io/tokenGift/
```

未传 `--public` 但传 `--link-base` 时，会生成 `?cfg=<base64url-json>` 链接。传了 `--public` 时，会生成 `?gift=<cipher>` 链接。

## 查询用量

一展 API 这类二次开发平台可能不提供标准 New API 的 `/api/usage/token`。TokenGift 会优先请求标准接口，失败后自动 fallback 到：

```text
/v1/dashboard/billing/usage?start_date=<ms>&end_date=<ms>
```

Node CLI：

```bash
export TOKENGIFT_API_KEY="sk-limited-xxx"

npm run tokengift -- usage \
  --provider newapi \
  --base-url https://vip.yi-zhan.top
```

Python CLI：

```bash
export TOKENGIFT_API_KEY="sk-limited-xxx"

tokengift usage \
  --provider newapi \
  --base-url https://vip.yi-zhan.top
```

可指定毫秒级时间窗口：

```bash
npm run tokengift -- usage \
  --provider newapi \
  --base-url https://vip.yi-zhan.top \
  --start-date 1716149437000 \
  --end-date 1746517437000
```

## 撤销 key

创建 key 后，输出中的 `issuerTokenId` 用于撤销：

```bash
npm run tokengift -- revoke \
  --provider newapi \
  --token-id 123
```

Python CLI：

```bash
tokengift revoke \
  --provider newapi \
  --token-id 123
```

撤销需要管理 token 和用户 ID，因此仍然需要设置：

```bash
NEW_API_URL=https://vip.yi-zhan.top
NEW_API_TOKEN=your-manager-token
NEW_API_USER_ID=293
```

## 请求映射

创建有限额 key 时，TokenGift 会向一展 API 发送 New API 兼容请求：

```text
POST /api/token/
Authorization: Bearer <manager-token>
New-Api-User: <user-id>
X-Api-User: <user-id>
```

请求体核心字段：

```json
{
  "name": "agent-b-review-budget",
  "expired_time": -1,
  "remain_quota": 100000,
  "unlimited_quota": false,
  "model_limits_enabled": true,
  "model_limits": ["gpt-4o-mini", "gpt-4o"],
  "allow_ips": "",
  "group": "default"
}
```

其中：

- `Authorization` 使用管理 token。
- `New-Api-User` 用于标准 New API 兼容。
- `X-Api-User` 用于一展 API 这类二次开发平台兼容。
- `remain_quota` 是平台额度单位。
- `model_limits` 控制 agent 可调用的模型集合。

## Dry run

在真实发券前，可以先用 dry run 检查请求形状：

```bash
npm run tokengift -- issue \
  --provider newapi \
  --name tg-dry-run \
  --quota 1000 \
  --models gpt-4o-mini \
  --dry-run
```

Dry run 不会发出真实创建请求，并会脱敏管理 token。

## 常见问题

### 1. 为什么 provider 不是 `yizhan`

第一阶段一展 API 按 New API 二开兼容处理，使用 `--provider newapi` 可以复用现有创建、查询和撤销逻辑。只有当一展 API 未来提供独立接口语义时，才需要新增 `yizhan` provider。

### 2. 为什么输出的 `baseUrl` 自动加了 `/v1`

Agent 通常使用 OpenAI-compatible SDK 调用模型，需要 `/v1` 作为客户端 API 地址。管理接口仍然使用站点根地址下的 `/api/token/`。

### 3. 为什么 usage 需要有限额 key

一展 API 的普通用量查询面向实际调用 key。管理 token 用于创建和撤销，有限额 key 用于查询该 key 自身在某个时间窗口内的消耗。

### 4. 额度为什么和真实 token 数不一致

一展 API 的 `remain_quota` 是平台额度单位，可能按模型、分组、输入输出价格等倍率折算。TokenGift 文档中统一标记为 `platform_quota`，避免误解为原始模型 token 数。

### 5. 是否需要一展 API 额外开发

MVP 不需要。未来如果要做更强能力，可以和 API 站协作这些接口：

- 原生 scoped key：限额、限模型、限时间、限接收 agent。
- Usage webhook：请求结束后推送真实消耗。
- 原生 escrow：任务完成后自动释放额度。
- 风控联动：被盗 key、异常调用、刷量封禁。

## Agent 使用建议

给 agent 发放一展 API gift 时，推荐遵守：

- 每个任务单独创建一个有限额 key。
- 默认设置模型范围，不给全模型权限。
- 默认 gift 不可二次转让。
- 任务结束后查询 usage，并撤销未用完 key。
- 重要任务使用接收方公钥加密 gift。

