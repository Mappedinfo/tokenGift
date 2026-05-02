#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  createPublicKey,
  createPrivateKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  constants
} from 'node:crypto';

const HELP = `
tokengift - 与他人安全交换配置的通用命令行

用法:
  tokengift keygen   [--public keys/bob_public.pem] [--private keys/bob_private.pem] [--bits 4096]
  tokengift encrypt  --public keys/bob_public.pem --text "..." --out out/tokengift.payload
  tokengift encrypt  --public keys/bob_public.pem --in config.json
  tokengift decrypt  --private keys/bob_private.pem --in out/tokengift.payload
  tokengift decrypt  --private keys/bob_private.pem --text <payload>
  tokengift issue    --provider newapi --base-url https://newapi.example.com --name agent-a --quota 100000 --models gpt-4o-mini,gpt-4o
  tokengift usage    --provider newapi --base-url https://newapi.example.com --api-key sk-limited-xxx
  tokengift revoke   --provider newapi --base-url https://newapi.example.com --token-id 123

别名:
  tokengift gift -> encrypt
  tokengift open -> decrypt

示例（用于 tokenSwap 配置赠予）:
  1) 生成对方公私钥对（你保留私钥）
     node scripts/tokengift.js keygen --public bob.pub.pem --private bob.private.pem

  2) 用对方公钥加密配置，得到可挂到链接中的字符串
     node scripts/tokengift.js gift --public bob.pub.pem --in ./config.json > gift.txt

  3) 对方拿到密文后用私钥解密
     node scripts/tokengift.js open --private bob.private.pem --in gift.txt

  4) 通过 New API 创建有限额 key，并加密成邀请密文
     NEWAPI_USER_TOKEN=... NEWAPI_USER_ID=1 node scripts/tokengift.js issue \\
       --provider newapi --base-url https://newapi.example.com --name agent-a \\
       --quota 100000 --models gpt-4o-mini --public bob.pub.pem

Issuer 环境变量:
  New API: NEWAPI_BASE_URL / NEWAPI_USER_TOKEN / NEWAPI_USER_ID
  One API: ONEAPI_BASE_URL / ONEAPI_ACCESS_TOKEN

支持算法：RSA + OAEP(SHA-256)
输出默认使用 Base64URL 编码，支持一次写入到 URL。
`;

const BOOLEAN_FLAGS = new Set(['help', 'dry-run']);

const loadDotEnv = () => {
  const envPath = resolve('.env');
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
};

loadDotEnv();

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {};
  const positionals = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';

    if (arg.startsWith('--')) {
      const key = arg.replace(/^--/, '');

      if (key === 'help' || BOOLEAN_FLAGS.has(key)) {
        options[key] = true;
        continue;
      }

      if (i + 1 >= args.length) {
        throw new Error(`参数 ${arg} 缺少值`);
      }

      const value = args[i + 1] ?? '';
      options[key] = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('-')) {
      if (arg === '-h') {
        options.help = true;
        continue;
      }

      const next = args[i + 1] ?? '';
      if (arg === '-p') {
        options.public = next;
        i += 1;
        continue;
      }
      if (arg === '-k') {
        options.private = next;
        i += 1;
        continue;
      }
      if (arg === '-i' || arg === '-in') {
        options.in = next;
        i += 1;
        continue;
      }
      if (arg === '-o') {
        options.out = next;
        i += 1;
        continue;
      }
      if (arg === '-t') {
        options.text = next;
        i += 1;
        continue;
      }
      throw new Error(`不支持的参数 ${arg}`);
    }

    positionals.push(arg);
  }

  if (!positionals.length && !options.help) {
    throw new Error('缺少子命令：keygen/encrypt/decrypt');
  }

  return { ...options, _cmd: positionals[0] || '' };
};

const ensurePathDir = (path) => {
  const dir = dirname(path);
  if (dir && dir !== '.' && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
};

const toBase64Url = (buffer) => {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const fromBase64Url = (value) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  const padded =
    pad === 0 ? normalized : `${normalized}${'='.repeat(pad === 2 ? 2 : pad === 3 ? 1 : 0)}`;
  return Buffer.from(padded, 'base64');
};

const readTextInput = (options) => {
  if (typeof options.text === 'string') {
    return options.text;
  }

  if (typeof options.in === 'string') {
    return readFileSync(options.in, 'utf8');
  }

  return readFileSync(0, 'utf8');
};

const writeOutput = (value, options) => {
  if (options.out) {
    const outputPath = resolve(options.out);
    ensurePathDir(outputPath);
    writeFileSync(outputPath, value);
  } else {
    process.stdout.write(`${value}\n`);
  }
};

const splitChunks = (buffer, chunkSize) => {
  const chunks = [];
  for (let i = 0; i < buffer.length; i += chunkSize) {
    chunks.push(buffer.subarray(i, i + chunkSize));
  }
  return chunks;
};

const encrypt = (publicKeyPath, inputText) => {
  const publicKey = createPublicKey(readFileSync(publicKeyPath, 'utf8'));
  const keySizeBytes = Math.ceil((publicKey.asymmetricKeySize ?? 2048) / 8);
  const maxInput = Math.max(1, keySizeBytes - 2 * 32 - 2);
  const input = Buffer.from(inputText, 'utf8');
  const chunks = splitChunks(input, maxInput);

  const encrypted = chunks.map((chunk) => {
    const cipher = publicEncrypt(
      {
        key: publicKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
      },
      chunk,
    );
    return toBase64Url(cipher);
  });

  return encrypted.join('.');
};

const decrypt = (privateKeyPath, inputText) => {
  const privateKey = createPrivateKey(readFileSync(privateKeyPath, 'utf8'));
  const parts = inputText.trim().split('.').filter(Boolean);
  const decrypted = parts.map((part) => {
    const cipher = fromBase64Url(part);
    return privateDecrypt(
      {
        key: privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
      },
      cipher,
    );
  });

  return Buffer.concat(decrypted).toString('utf8');
};

const envValue = (name) => {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
};

const optionValue = (options, key, fallback = '') => {
  const value = options[key];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
};

const normalizeProvider = (options) => {
  const provider = optionValue(options, 'provider').toLowerCase();
  if (provider !== 'newapi' && provider !== 'oneapi') {
    throw new Error('issuer 需要 --provider newapi 或 --provider oneapi');
  }
  return provider;
};

const parseModelCsv = (raw) => {
  const models = String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!models.length) {
    throw new Error('issuer 需要 --models <model1,model2>');
  }
  return [...new Set(models)];
};

const parsePositiveInteger = (raw, label) => {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} 必须是大于 0 的整数`);
  }
  return value;
};

const parseExpiresAt = (raw) => {
  if (raw === undefined || raw === null || raw === '') return -1;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < -1) {
    throw new Error('--expires-at 必须是 Unix 秒级时间戳，或 -1 表示永不过期');
  }
  return value;
};

const normalizeGatewayUrls = (rawBaseUrl) => {
  const raw = String(rawBaseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) {
    throw new Error('issuer 需要 --base-url，或配置对应平台的 BASE_URL 环境变量');
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('--base-url 必须是有效 URL');
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error('--base-url 仅支持 http(s) URL');
  }

  const withoutTrailingSlash = parsed.toString().replace(/\/+$/, '');
  if (withoutTrailingSlash.endsWith('/v1')) {
    return {
      apiBaseUrl: withoutTrailingSlash.slice(0, -3).replace(/\/+$/, ''),
      clientBaseUrl: withoutTrailingSlash
    };
  }

  return {
    apiBaseUrl: withoutTrailingSlash,
    clientBaseUrl: `${withoutTrailingSlash}/v1`
  };
};

const getIssuerBaseUrl = (provider, options) => {
  return optionValue(
    options,
    'base-url',
    provider === 'newapi'
      ? envValue('NEWAPI_BASE_URL') || envValue('NEW_API_URL') || envValue('NEW_API_BASE_URL')
      : envValue('ONEAPI_BASE_URL') || envValue('ONE_API_URL') || envValue('ONE_API_BASE_URL'),
  );
};

const getManagerToken = (provider, options) => {
  const token = optionValue(
    options,
    'manager-token',
    provider === 'newapi'
      ? envValue('NEWAPI_USER_TOKEN') || envValue('NEW_API_TOKEN') || envValue('NEW_API_USER_TOKEN')
      : envValue('ONEAPI_ACCESS_TOKEN') || envValue('ONE_API_TOKEN') || envValue('ONE_API_ACCESS_TOKEN'),
  );
  if (!token) {
    throw new Error(
      provider === 'newapi'
        ? 'New API issuer 需要 --manager-token 或 NEWAPI_USER_TOKEN'
        : 'One API issuer 需要 --manager-token 或 ONEAPI_ACCESS_TOKEN',
    );
  }
  return token;
};

const getNewApiUserId = (options) => {
  const userId = optionValue(options, 'user-id', envValue('NEWAPI_USER_ID') || envValue('NEW_API_USER_ID'));
  if (!userId) {
    throw new Error('New API issuer 需要 --user-id 或 NEWAPI_USER_ID');
  }
  return userId;
};

const ensureFetch = () => {
  if (typeof fetch !== 'function') {
    throw new Error('当前 Node.js 版本不支持 fetch，请使用 Node.js 18+');
  }
};

const readJsonResponse = async (response) => {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
};

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const requestJson = async (url, init) => {
  ensureFetch();
  let response;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(url, init);
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await sleep(300 * (attempt + 1));
      }
    }
  }
  if (!response) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError || 'fetch failed'));
  }
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${payload.message || JSON.stringify(payload)}`);
  }
  if (payload && payload.success === false) {
    throw new Error(payload.message || '平台返回失败');
  }
  if (payload && payload.code === false) {
    throw new Error(payload.message || '平台返回失败');
  }
  return payload;
};

const extractTokenRecord = (payload, expectedName = '') => {
  const data = payload?.data ?? payload;
  const candidates = [];

  if (Array.isArray(data)) {
    candidates.push(...data);
  } else if (Array.isArray(data?.items)) {
    candidates.push(...data.items);
  } else if (data && typeof data === 'object') {
    candidates.push(data);
  }

  const named = expectedName
    ? candidates.find((item) => String(item?.name || '') === expectedName && item?.key)
    : null;
  return named || candidates.find((item) => item?.key) || null;
};

const fetchNewApiTokenByName = async (apiBaseUrl, headers, name) => {
  const searchUrl = `${apiBaseUrl}/api/token/search?keyword=${encodeURIComponent(name)}`;
  const searched = await requestJson(searchUrl, { method: 'GET', headers });
  const searchedToken = extractTokenRecord(searched, name);
  if (searchedToken) return searchedToken;

  const listUrl = `${apiBaseUrl}/api/token/?p=1&size=20`;
  const listed = await requestJson(listUrl, { method: 'GET', headers });
  return extractTokenRecord(listed, name);
};

const fetchOneApiTokenByName = async (apiBaseUrl, headers, name) => {
  const searchUrl = `${apiBaseUrl}/api/token/search?keyword=${encodeURIComponent(name)}`;
  const searched = await requestJson(searchUrl, { method: 'GET', headers });
  return extractTokenRecord(searched, name);
};

const createNewApiToken = async ({ apiBaseUrl, managerToken, userId, name, quota, models, expiresAt, allowIps, group }) => {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${managerToken}`,
    'New-Api-User': userId,
    'X-Api-User': userId
  };
  const body = {
    name,
    expired_time: expiresAt,
    remain_quota: quota,
    unlimited_quota: false,
    model_limits_enabled: true,
    model_limits: models,
    allow_ips: allowIps,
    group
  };
  const created = await requestJson(`${apiBaseUrl}/api/token/`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  return extractTokenRecord(created, name) || fetchNewApiTokenByName(apiBaseUrl, headers, name);
};

const createOneApiToken = async ({ apiBaseUrl, managerToken, name, quota, models, expiresAt, subnet }) => {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: managerToken
  };
  const body = {
    name,
    expired_time: expiresAt,
    remain_quota: quota,
    unlimited_quota: false,
    models: models.join(','),
    subnet
  };
  const created = await requestJson(`${apiBaseUrl}/api/token/`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  return extractTokenRecord(created, name) || fetchOneApiTokenByName(apiBaseUrl, headers, name);
};

const buildIssuedConfig = ({ provider, token, name, quota, models, expiresAt, clientBaseUrl }) => {
  if (!token?.key) {
    throw new Error('平台未返回新令牌 key，且无法通过名称找回。请确认令牌名称唯一、账号有 Token 管理权限。');
  }

  return {
    profileName: name,
    apiKey: token.key,
    baseUrl: clientBaseUrl,
    models: models.map((id) => ({ id, rate: 1 })),
    tokenQuota: quota,
    provider,
    issuerTokenId: token.id,
    expiresAt,
    quotaUnit: 'platform_quota'
  };
};

const buildShareLink = (linkBase, key, value) => {
  const url = new URL(linkBase);
  url.searchParams.set(key, value);
  return url.toString();
};

const commandIssue = async (options) => {
  const provider = normalizeProvider(options);
  const baseUrl = getIssuerBaseUrl(provider, options);
  const { apiBaseUrl, clientBaseUrl } = normalizeGatewayUrls(baseUrl);
  const name = optionValue(options, 'name');
  if (!name) {
    throw new Error('issue 需要 --name <令牌名称>');
  }
  if (name.length > 30) {
    throw new Error('--name 最多 30 个字符');
  }

  const quota = parsePositiveInteger(options.quota, '--quota');
  const models = parseModelCsv(options.models);
  const expiresAt = parseExpiresAt(options['expires-at'] ?? options.expiresAt);
  const allowIps = optionValue(options, 'allow-ips');
  const group = optionValue(options, 'group', 'default');
  const subnet = optionValue(options, 'subnet', allowIps);
  const managerToken = getManagerToken(provider, options);
  const userId = provider === 'newapi' ? getNewApiUserId(options) : '';

  if (options['dry-run']) {
    const previewBody =
      provider === 'newapi'
        ? {
            name,
            expired_time: expiresAt,
            remain_quota: quota,
            unlimited_quota: false,
            model_limits_enabled: true,
            model_limits: models,
            allow_ips: allowIps,
            group
          }
        : {
            name,
            expired_time: expiresAt,
            remain_quota: quota,
            unlimited_quota: false,
            models: models.join(','),
            subnet
          };
    writeOutput(
      JSON.stringify(
        {
          provider,
          method: 'POST',
          url: `${apiBaseUrl}/api/token/`,
          headers:
            provider === 'newapi'
              ? { Authorization: 'Bearer <redacted>', 'New-Api-User': userId, 'X-Api-User': userId }
              : { Authorization: '<redacted>' },
          body: previewBody,
          clientBaseUrl
        },
        null,
        2,
      ),
      options,
    );
    return;
  }

  const token =
    provider === 'newapi'
      ? await createNewApiToken({
          apiBaseUrl,
          managerToken,
          userId,
          name,
          quota,
          models,
          expiresAt,
          allowIps,
          group
        })
      : await createOneApiToken({
          apiBaseUrl,
          managerToken,
          name,
          quota,
          models,
          expiresAt,
          subnet
        });

  const config = buildIssuedConfig({
    provider,
    token,
    name,
    quota,
    models,
    expiresAt,
    clientBaseUrl
  });
  const json = JSON.stringify(config, null, 2);

  let output = json;
  if (options.public) {
    output = encrypt(options.public, json);
    if (options['link-base']) {
      output = buildShareLink(options['link-base'], 'gift', output);
    }
  } else if (options['link-base']) {
    output = buildShareLink(options['link-base'], 'cfg', toBase64Url(Buffer.from(json, 'utf8')));
  }

  writeOutput(output, options);
};

const commandUsage = async (options) => {
  const provider = normalizeProvider(options);
  if (provider !== 'newapi') {
    throw new Error('usage 第一版仅支持 --provider newapi');
  }
  const baseUrl = getIssuerBaseUrl(provider, options);
  const { apiBaseUrl, clientBaseUrl } = normalizeGatewayUrls(baseUrl);
  const apiKey = optionValue(
    options,
    'api-key',
    envValue('TOKENGIFT_API_KEY') || envValue('NEWAPI_API_KEY') || envValue('NEW_API_API_KEY'),
  );
  const startDate = optionValue(
    options,
    'start-date',
    optionValue(options, 'start_date', String(Date.now() - 30 * 24 * 60 * 60 * 1000)),
  );
  const endDate = optionValue(options, 'end-date', optionValue(options, 'end_date', String(Date.now())));
  const billingUsageUrl = `${clientBaseUrl}/dashboard/billing/usage?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`;

  if (options['dry-run']) {
    writeOutput(
      JSON.stringify(
        {
          provider,
          primary: {
            method: 'GET',
            url: `${apiBaseUrl}/api/usage/token`,
            headers: { Authorization: 'Bearer <redacted>' }
          },
          fallback: {
            method: 'GET',
            url: billingUsageUrl,
            headers: { Authorization: 'Bearer <redacted>', 'Content-Type': 'application/json' }
          }
        },
        null,
        2,
      ),
      options,
    );
    return;
  }

  if (!apiKey) {
    throw new Error('usage 需要 --api-key <有限额令牌>，或 TOKENGIFT_API_KEY / NEWAPI_API_KEY / NEW_API_API_KEY');
  }

  let usage;
  try {
    usage = await requestJson(`${apiBaseUrl}/api/usage/token`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });
  } catch (error) {
    usage = await requestJson(billingUsageUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    usage = {
      ...usage,
      fallback_from: '/api/usage/token',
      fallback_reason: error instanceof Error ? error.message : String(error)
    };
  }
  writeOutput(JSON.stringify(usage, null, 2), options);
};

const commandRevoke = async (options) => {
  const provider = normalizeProvider(options);
  const baseUrl = getIssuerBaseUrl(provider, options);
  const { apiBaseUrl } = normalizeGatewayUrls(baseUrl);
  const tokenId = parsePositiveInteger(options['token-id'] ?? options.tokenId, '--token-id');
  const managerToken = getManagerToken(provider, options);
  const headers =
    provider === 'newapi'
      ? {
          Authorization: `Bearer ${managerToken}`,
          'New-Api-User': getNewApiUserId(options),
          'X-Api-User': getNewApiUserId(options)
        }
      : {
          Authorization: managerToken
        };

  if (options['dry-run']) {
    writeOutput(
      JSON.stringify(
        {
          provider,
          method: 'DELETE',
          url: `${apiBaseUrl}/api/token/${tokenId}`,
          headers:
            provider === 'newapi'
              ? {
                  Authorization: 'Bearer <redacted>',
                  'New-Api-User': headers['New-Api-User'],
                  'X-Api-User': headers['X-Api-User']
                }
              : { Authorization: '<redacted>' }
        },
        null,
        2,
      ),
      options,
    );
    return;
  }

  const result = await requestJson(`${apiBaseUrl}/api/token/${tokenId}`, {
    method: 'DELETE',
    headers
  });
  writeOutput(JSON.stringify(result, null, 2), options);
};

const commandKeygen = (options) => {
  const bits = Number(options.bits || 4096);
  const publicPath = resolve(options.public || './keys/tokengift-public.pem');
  const privatePath = resolve(options.private || './keys/tokengift-private.pem');

  const pair = generateKeyPairSync('rsa', {
    modulusLength: Number.isFinite(bits) && bits >= 2048 ? bits : 4096,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });

  ensurePathDir(publicPath);
  ensurePathDir(privatePath);
  writeFileSync(publicPath, pair.publicKey);
  writeFileSync(privatePath, pair.privateKey);

  console.log(`已生成：\npublic=${publicPath}\nprivate=${privatePath}`);
};

const commandEncrypt = (options) => {
  if (!options.public) {
    throw new Error('加密需要 --public/ -p 公钥路径');
  }
  const inputText = readTextInput(options);
  if (!inputText.trim()) {
    throw new Error('加密输入为空');
  }
  const encrypted = encrypt(options.public, inputText);
  writeOutput(encrypted, options);
};

const commandDecrypt = (options) => {
  if (!options.private) {
    throw new Error('解密需要 --private/ -k 私钥路径');
  }
  const inputText = readTextInput(options);
  if (!inputText.trim()) {
    throw new Error('解密输入为空');
  }
  const decrypted = decrypt(options.private, inputText);
  writeOutput(decrypted, options);
};

const run = async () => {
  const options = parseArgs();
  const command = (options._cmd || '').toLowerCase();

  if (options.help || !command) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (command === 'gift') {
    commandEncrypt(options);
    return;
  }

  if (command === 'open') {
    commandDecrypt(options);
    return;
  }

  switch (command) {
    case 'issue':
      await commandIssue(options);
      break;
    case 'usage':
      await commandUsage(options);
      break;
    case 'revoke':
      await commandRevoke(options);
      break;
    case 'keygen':
      commandKeygen(options);
      break;
    case 'encrypt':
      commandEncrypt(options);
      break;
    case 'decrypt':
      commandDecrypt(options);
      break;
    default:
      throw new Error(`不支持的子命令：${command}`);
  }
};

try {
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[tokengift] ${message}`);
  process.exit(1);
}
