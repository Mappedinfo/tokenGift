const ENCRYPT_MAX_PADDING = 66;
const HASH_NAME = 'SHA-256';

const ensureCrypto = (): SubtleCrypto => {
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前浏览器环境不支持 Web Crypto API，无法执行加解密。');
  }
  return globalThis.crypto.subtle;
};

export const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

export const fromBase64Url = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').trim();
  const pad = (4 - (normalized.length % 4)) % 4;
  const padded = pad === 0 ? normalized : `${normalized}${'='.repeat(pad)}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const normalizeKeyInput = (keyText: string): string => {
  const trimmed = keyText.replace(/\r/g, '').trim();
  if (!trimmed) {
    throw new Error('密钥内容为空。');
  }

  if (/-----BEGIN/.test(trimmed)) {
    const body = trimmed
      .replace(/-----BEGIN [^-]+-----/g, '')
      .replace(/-----END [^-]+-----/g, '')
      .replace(/\s+/g, '');

    if (!body) {
      throw new Error('PEM 密钥内容不完整。');
    }

    return body;
  }

  return trimmed.replace(/\s+/g, '');
};

const decodeDerFromText = (pemOrBase64: string): Uint8Array => {
  const body = normalizeKeyInput(pemOrBase64);
  try {
    return fromBase64Url(body);
  } catch {
    throw new Error('密钥不是有效的 PEM/Base64 格式。');
  }
};

export const parsePemPublicKey = async (publicPem: string): Promise<CryptoKey> => {
  const subtle = ensureCrypto();
  const der = decodeDerFromText(publicPem);

  try {
    return await subtle.importKey(
      'spki',
      der,
      {
        name: 'RSA-OAEP',
        hash: HASH_NAME
      },
      false,
      ['encrypt']
    );
  } catch {
    throw new Error('导入公钥失败，请确认是标准 RSA 公钥（SPKI/PKIX PEM）。');
  }
};

export const parsePemPrivateKey = async (privatePem: string): Promise<CryptoKey> => {
  const subtle = ensureCrypto();
  const der = decodeDerFromText(privatePem);

  try {
    return await subtle.importKey(
      'pkcs8',
      der,
      {
        name: 'RSA-OAEP',
        hash: HASH_NAME
      },
      false,
      ['decrypt']
    );
  } catch {
    throw new Error('导入私钥失败，请确认是标准 RSA 私钥（PKCS#8 PEM）。');
  }
};

export const getMaxChunkSize = (key: CryptoKey): number => {
  const rsaKey = key.algorithm as RsaHashedImportParams & { modulusLength?: number };
  const keySize = Math.floor((rsaKey.modulusLength ?? 4096) / 8);
  return Math.max(1, keySize - ENCRYPT_MAX_PADDING);
};

export const encryptConfigForPublicKey = async (
  publicKeyText: string,
  plaintext: string,
): Promise<string> => {
  const subtle = ensureCrypto();
  const publicKey = await parsePemPublicKey(publicKeyText);
  const maxChunk = getMaxChunkSize(publicKey);

  if (maxChunk < 1) {
    throw new Error('当前公钥长度不支持加密，请更换更长的 RSA 密钥。');
  }

  const payload = new TextEncoder().encode(plaintext);
  if (!payload.length) {
    throw new Error('加密内容为空。');
  }

  const chunks: string[] = [];
  for (let start = 0; start < payload.length; start += maxChunk) {
    const slice = payload.slice(start, start + maxChunk);
    const encrypted = await subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, slice);
    chunks.push(toBase64Url(new Uint8Array(encrypted)));
  }

  return chunks.join('.');
};

export const decryptPayloadWithPrivateKey = async (
  privateKeyText: string,
  payloadText: string,
): Promise<string> => {
  const subtle = ensureCrypto();
  const privateKey = await parsePemPrivateKey(privateKeyText);

  const normalized = payloadText
    .split(/\s+/)
    .join('')
    .trim();

  if (!normalized) {
    throw new Error('密文为空。');
  }

  const blocks = normalized.split('.').filter(Boolean);
  if (!blocks.length) {
    throw new Error('密文格式无效（未找到可解析分块）。');
  }

  const decoder = new TextDecoder();
  const plainBuffers = await Promise.all(
    blocks.map(async (block) => {
      let cipher: Uint8Array;
      try {
        cipher = fromBase64Url(block);
      } catch {
        throw new Error('密文 base64URL 解码失败，请确认密文未损坏。');
      }

      try {
        const decrypted = await subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, cipher);
        return new Uint8Array(decrypted);
      } catch {
        throw new Error('密文无法解密：可能是私钥不匹配或数据损坏。');
      }
    })
  );

  const totalLength = plainBuffers.reduce((sum, buffer) => sum + buffer.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;

  for (const buffer of plainBuffers) {
    merged.set(buffer, offset);
    offset += buffer.length;
  }

  return decoder.decode(merged);
};
