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

支持算法：RSA + OAEP(SHA-256)
输出默认使用 Base64URL 编码，支持一次写入到 URL。
`;

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {};
  const positionals = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';

    if (arg.startsWith('--')) {
      if (arg === '--help' || arg === '-h') {
        options.help = true;
        continue;
      }

      if (i + 1 >= args.length) {
        throw new Error(`参数 ${arg} 缺少值`);
      }

      const value = args[i + 1] ?? '';
      options[arg.replace(/^--/, '')] = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('-')) {
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

const run = () => {
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
  run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[tokengift] ${message}`);
  process.exit(1);
}
