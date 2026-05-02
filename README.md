# tokengift

## 项目描述

这是一个名为 `tokengift` 的项目，可直接部署到 GitHub 仓库 [mappedinfo/tokengift](https://github.com/mappedinfo/tokengift)。项目提供 token 银行与 token 兑换能力，并支持通过访问链接附加字符串自动解析配置。

官方链接：

- GitHub: https://github.com/mappedinfo/tokengift
- PyPI: https://pypi.org/project/tokengift/
- npm: https://www.npmjs.com/package/tokengift

## 三版本说明

当前项目有三个版本，协同支持同一套配置解析与 RSA-OAEP(SHA-256) 加解密兼容规则：

- `npm` 包 `tokengift`：命令行工具（`node scripts/tokengift.js` 封装）。
- `PyPI` 包 `tokengift`：提供同样参数与加密规则的 Python CLI。
- GitHub Pages：网页版“兑换中心 + 发起邀请 + 领取礼物”（本仓库页面，按网址链接直接使用）。

3 个版本共享同一套配置解析与 RSA-OAEP(SHA-256) 加解密规则，因此命令行与页面互相兼容。


## 特性

- 不依赖服务端数据库
- 使用 React + TypeScript + Ant Design + AntV
- 自动解析 URL 配置，提取：`apiKey / baseUrl / 支持模型 / token 数量`
- 默认以 `gpt-5.5-medium` 作为结算基准
- 本地持久化记录每组配置下的余额与兑换记录（localStorage）
- 兑换后用图表和表格可视化余额变化

## 本地运行

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build
npm run preview
```

## GitHub Pages 部署

```bash
# 使用你自己的仓库名，示例：mappedinfo/tokengift
npm run build
```

前端工程已统一放在 `web/` 目录下，默认构建产物为 `web/dist`，然后发布该目录到 GitHub Pages（可手动上传或使用 gh-pages/Workflow）。

### 自动发布（推荐）

本仓库已经新增了 GitHub Actions：

- 文件：`.github/workflows/deploy-gh-pages.yml`
- 触发：`main` 分支 push 或手动触发
- 流程：`npm ci -> npm run build -> 同步 web/dist 到 gh-pages`
- 默认会按仓库名 `/tokengift/` 作为 `base`，如果你仓库名不同可改：
  - `web/vite.config.ts` 的 `GH_PAGES_BASE_PATH` / `VITE_BASE_PATH`
  - workflow 里的 `env: GH_PAGES_BASE_PATH: /你的仓库名/`

## URL 自动配置约定

页面启动时会自动读取如下来源：

1. 查询参数 `?cfg=...` 或 `?config=...`
2. 原始查询字符串（`https://.../?<payload>`）
3. hash 字符串（`https://.../#<payload>`）

支持两种 `payload`：

### 1) Base64/URL-safe Base64 编码 JSON

```json
{
  "profileName": "team-a",
  "apiKey": "sk-xxxx",
  "baseUrl": "https://api.openai.com/v1",
  "models": [
    { "id": "gpt-5.5-medium", "rate": 1 },
    { "id": "gpt-4o", "rate": 1.15 }
  ],
  "tokenQuota": 50000,
  "initialBalances": {
    "gpt-5.5-medium": 30000,
    "gpt-4o": 10000
  }
}
```

例如拼接：

```text
https://your-domain/#eyJwcm9maWxlTmFtZSI6InRlYW0tYSIsImFwaUtleSI6InNrLXh4Iiw... 
```

### 2) 简化短串

```text
<apiKey>|<baseUrl>|<model1:rate,model2:rate>|<totalToken>|<model1:balance,model2:balance>
```

示例：

```text
aaa|https://api.openai.com/v1|gpt-5.5-medium:1,gpt-4o:1.15|50000|gpt-5.5-medium:20000
```

也可以粘贴到页面中的「手动解析」输入框。

## 说明

- 本项目不持久传输 API Key，解析行为发生在前端；但请注意 URL 上明文包含 API Key 会有安全风险，请仅用于测试与演示。

## Issuer 发券模式（New API / One API）

如果希望把“指定额度后自动停止消耗”做成硬限制，不应把真实上游 API Key 直接交给 agent。推荐先在 New API / One API 中放入真实上游 Key，再由 `tokengift` 生成有限额、限模型、可过期的本地令牌并包装成礼物配置。

当前 issuer 第一版只在 npm CLI 中提供；Python CLI 继续保持 RSA 加解密兼容。

### New API 发券

New API 的 Token 管理接口支持 `remain_quota`、`model_limits_enabled`、`model_limits`、`allow_ips`、`group` 等字段。管理凭证只从环境变量或命令参数读取，不会写入页面、localStorage 或分享链接。

```bash
# 也可以写入本地 .env；CLI 会自动读取缺失的环境变量
export NEWAPI_BASE_URL="https://newapi.example.com"
export NEWAPI_USER_TOKEN="your-user-token"
export NEWAPI_USER_ID="1"

npm run tokengift -- issue \
  --provider newapi \
  --name agent-a \
  --quota 100000 \
  --models gpt-4o-mini,gpt-4o \
  --expires-at -1
```

默认输出可被页面解析的配置 JSON：

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

如果要直接加密给接收方：

```bash
npm run tokengift -- issue \
  --provider newapi \
  --base-url https://newapi.example.com \
  --name agent-a \
  --quota 100000 \
  --models gpt-4o-mini \
  --public keys/bob_public.pem
```

如果要生成领取链接：

```bash
npm run tokengift -- issue \
  --provider newapi \
  --base-url https://newapi.example.com \
  --name agent-a \
  --quota 100000 \
  --models gpt-4o-mini \
  --public keys/bob_public.pem \
  --link-base https://your-domain/
```

查询 New API 有限额令牌当前用量：

```bash
export TOKENGIFT_API_KEY="sk-limited-xxx"

npm run tokengift -- usage \
  --provider newapi \
  --base-url https://newapi.example.com
```

`usage` 会优先请求标准 New API 的 `/api/usage/token`；如果平台是类似一展 API 的二次开发并使用 `/v1/dashboard/billing/usage`，会自动 fallback。可用 `--start-date` 和 `--end-date` 传入毫秒级时间戳覆盖默认近 30 天窗口。

撤销令牌：

```bash
npm run tokengift -- revoke \
  --provider newapi \
  --base-url https://newapi.example.com \
  --token-id 123
```

### One API 兼容发券

One API 官方说明支持令牌额度、过期时间、允许 IP 范围以及允许模型访问。由于 One API 官方管理 API 文档列表不完整，`tokengift` 按当前 One API 源码字段兼容：`remain_quota`、`unlimited_quota`、`models`、`subnet`。

New API 二次开发平台如果要求 `X-Api-User`，`tokengift` 会和标准 `New-Api-User` 一起发送以兼容。

```bash
export ONEAPI_BASE_URL="https://oneapi.example.com"
export ONEAPI_ACCESS_TOKEN="your-oneapi-access-token"

npm run tokengift -- issue \
  --provider oneapi \
  --name agent-a \
  --quota 100000 \
  --models gpt-4o-mini,gpt-4o \
  --subnet "192.168.1.0/24"
```

注意：这里的 `quota` 是 New API / One API 平台额度单位，通常会按平台的分组倍率、模型倍率、输入输出倍率折算，不等同于原始模型 token 数。额度耗尽后的硬停止由 New API / One API 执行，`tokengift` 只负责创建、包装、加密和分发有限额 key。

## 配套命令行工具（tokengift）

为了实现“赠予逻辑”中的密钥交换，项目增加了一个通用 CLI：`tokengift`（`scripts/tokengift.js`）。

用途：
- 用对方公钥加密配置（礼物发起方）
- 对方用自己的私钥解密配置（领取方）
- 生成 RSA 公/私钥对

### 安装与运行

```bash
npm install
npm run tokengift -- --help
```

### 典型流程

1. 生成公私钥（发送方或接收方）：

```bash
npm run tokengift -- keygen --public keys/receiver_public.pem --private keys/receiver_private.pem
```

2. 发送方用接收方公钥加密 JSON 配置：

```bash
npm run tokengift -- gift --public keys/receiver_public.pem --in token-config.json > encrypted.txt
```

3. 接收方用自己的私钥解密：

```bash
npm run tokengift -- open --private keys/receiver_private.pem --in encrypted.txt
```

### 输出格式

- 默认输出为 `Base64URL`（可直接贴到 `cfg=...` 参数中）
- 为兼容更大体积内容，命令会按 RSA 分块加密，密文由多段 `.` 分隔组合

> 说明：该 CLI 使用 `RSA + OAEP(SHA-256)`，属于经典的“公钥加密、私钥解密”模型，适合用于配置/小对象共享场景。更大对象可先压缩或签名再加密。

## Python 版 tokengift（可发布到 PyPI）

在仓库根目录新增了 Python CLI，功能与 Node 版参数与行为对齐：
- `keygen`：生成 `public/private` RSA PEM 密钥对（SPKI + PKCS8）
- `gift`（alias `encrypt`）：用公钥加密
- `open`（alias `decrypt`）：用私钥解密
- 输出/输入使用 `Base64URL`，多段密文用 `.` 分隔

### 打包与本地可执行

```bash
# 推荐使用 uv 管理本地环境
uv venv
uv pip install -e .[dev]
uv run tokengift --help
uv run python -m build
uv pip install .
```

### 发布到 PyPI

```bash
UV_PYTHON=3.11 ./scripts/release_py.sh
```

### 手动构建与上传（可选）

```bash
# 不使用脚本时，手动执行
UV_PYTHON=3.11 uv run --with build --with twine python -m build
UV_PYTHON=3.11 uv run --with build --with twine python -m twine upload dist/*
```

### 一键发布脚本

如果你仍想直接使用发布脚本，当前脚本会自动完成版本 bump + build + twine upload：
```bash
./scripts/release_py.sh
./scripts/release_py.sh patch
./scripts/release_py.sh minor
./scripts/release_py.sh major
```

说明：

- 默认执行 `patch` 递增
- 支持参数 `patch`、`minor`、`major`
- 自动读取 `.env` 中的：
  - `TWINE_USERNAME=__token__`
  - `TWINE_PASSWORD=<你的 PyPI token>`
- 发布前会清理旧 `dist/`，再执行 `python -m build`
- 发布后会把新版本写入 `pyproject.toml`

### 示例（与 Node 行为一致）

```bash
tokengift keygen --public keys/bob_public.pem --private keys/bob_private.pem

tokengift gift --public keys/bob_public.pem --in token-config.json > encrypted.txt

tokengift open --private keys/bob_private.pem --in encrypted.txt
```

> 小贴士：Node 版也使用同一套命令和分块 OAEP 规则，因此两端可互相加解密。
