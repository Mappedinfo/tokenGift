import { BankConfig, ConfigSource, ParsedModel } from '../types';

export const BASELINE_MODEL_ID = 'gpt-5.5-medium';

export const FALLBACK_MODELS: ParsedModel[] = [
  { id: BASELINE_MODEL_ID, rate: 1, note: '基准模型（可按此结算）' },
  { id: 'gpt-4.1', rate: 1.05 },
  { id: 'gpt-4o', rate: 1.15 },
  { id: 'gpt-4.1-mini', rate: 0.72 },
];

export const FALLBACK_CONFIG: BankConfig = {
  source: 'fallback',
  profileName: '本地演示钱包',
  apiKey: 'demo-api-key',
  baseUrl: 'https://api.openai.com/v1',
  models: FALLBACK_MODELS,
  tokenQuota: 120000
};

const ensureNumber = (value: unknown, fallback: number): number => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const parseBase64Url = (value: string): string | null => {
  const sanitized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const pad = sanitized.length % 4;
  const normalized =
    pad === 0 ? sanitized : `${sanitized}${'='.repeat(pad === 2 ? 2 : pad === 3 ? 1 : 0)}`;

  try {
    const bytes = atob(normalized).split('').map((char) => char.charCodeAt(0));
    return new TextDecoder().decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
};

const parseModelList = (input: unknown): ParsedModel[] => {
  if (!input) return [];

  const collect = (value: unknown): ParsedModel[] => {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => {
        if (typeof item === 'string') {
          const [rawId, rawRate] = item.split(':');
          const id = String(rawId || '').trim();
          if (!id) return null;
          return { id, rate: ensureNumber(rawRate, 1) };
        }

        if (item && typeof item === 'object') {
          const source = item as Record<string, unknown>;
          const id = String(source.id || source.model || source.name || '').trim();
          if (!id) return null;
          return {
            id,
            rate: ensureNumber(source.rate, 1),
            note: source.note as string | undefined
          };
        }

        return null;
      })
      .filter((v): v is ParsedModel => Boolean(v));
  };

  const fromObjectMap = (obj: Record<string, unknown>): ParsedModel[] =>
    Object.entries(obj).map(([id, rate]) => ({ id, rate: ensureNumber(rate, 1) }));

  if (typeof input === 'string') {
    const value = input.trim();
    if (!value) return [];
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [rawId, rawRate] = entry.split(':');
        return { id: rawId.trim(), rate: ensureNumber(rawRate, 1) };
      })
      .filter((v) => v.id);
  }

  if (Array.isArray(input)) {
    return collect(input);
  }

  if (typeof input === 'object') {
    return fromObjectMap(input as Record<string, unknown>);
  }

  return [];
};

const normalizeModels = (models: ParsedModel[]): ParsedModel[] => {
  const map = new Map<string, ParsedModel>();

  for (const item of models) {
    const id = item.id.trim();
    if (!id) continue;
    map.set(id, {
      id,
      rate: ensureNumber(item.rate, 1),
      note: item.note
    });
  }

  if (!map.has(BASELINE_MODEL_ID)) {
    map.set(BASELINE_MODEL_ID, FALLBACK_MODELS[0]!);
  }

  return [...map.values()];
};

const normalizeConfig = (source: ConfigSource, raw: Record<string, unknown>): BankConfig => {
  const apiKey = String(raw.apiKey || raw.key || raw.api_key || '').trim();
  const baseUrl = String(
    raw.baseUrl || raw.base_url || raw.endpoint || raw.endpointUrl || 'https://api.openai.com/v1',
  ).trim();
  const profileName = String(raw.profileName || raw.profile || raw.name || '外部配置钱包').trim();
  const tokenQuota = ensureNumber(raw.tokenQuota || raw.tokens || raw.quota, 0);
  const initialBalances =
    (typeof raw.initialBalances === 'object' && raw.initialBalances) ||
    (typeof raw.balances === 'object' && raw.balances) ||
    (typeof raw.tokensByModel === 'object' && raw.tokensByModel);

  const modelRateList = normalizeModels(
    parseModelList(raw.models).length
      ? parseModelList(raw.models)
      : parseModelList(raw.modelRates || raw.rates || raw.supportedModels || []),
  );

  const balances: Record<string, number> = {};
  if (initialBalances && typeof initialBalances === 'object') {
    Object.entries(initialBalances as Record<string, unknown>).forEach(([key, val]) => {
      const normalized = ensureNumber(val, NaN);
      if (Number.isFinite(normalized) && key.trim()) {
        balances[key.trim()] = normalized;
      }
    });
  }

  return {
    source,
    profileName: profileName || '外部配置钱包',
    apiKey,
    baseUrl,
    models: modelRateList,
    tokenQuota,
    initialBalances: balances
  };
};

const normalizeConfigWithFallback = (source: ConfigSource, raw: Record<string, unknown>): BankConfig => {
  const base = normalizeConfig(source, raw);
  if (!base.models.length) {
    return {
      ...base,
      models: FALLBACK_MODELS,
      source
    };
  }
  return base;
};

export const getInitialBalanceFromConfig = (config: BankConfig): Record<string, number> => {
  const result: Record<string, number> = {};
  for (const model of config.models) {
    result[model.id] = 0;
  }

  if (config.initialBalances) {
    for (const [model, rawValue] of Object.entries(config.initialBalances)) {
      const value = ensureNumber(rawValue, NaN);
      if (Number.isFinite(value) && Number.isFinite(result[model])) {
        result[model] = Math.max(0, value);
      }
    }
    return result;
  }

  if (config.tokenQuota && config.tokenQuota > 0) {
    result[BASELINE_MODEL_ID] = config.tokenQuota;
  } else if (Object.values(result).every((value) => value === 0)) {
    result[BASELINE_MODEL_ID] = 120000;
  }

  return result;
};

export const buildStorageKey = (config: BankConfig): string => {
  return `token-swap-state::${encodeURIComponent(config.baseUrl)}::${encodeURIComponent(config.apiKey.slice(0, 20))}`;
};

export const getEmbeddedCodeFromLocation = (): string | null => {
  const { search, hash } = window.location;
  const query = new URLSearchParams(search);
  const direct =
    query.get('cfg') || query.get('config') || query.get('tokenCfg') || query.get('token_cfg');

  if (direct && direct.trim()) {
    return decodeURIComponent(direct.trim());
  }

  const rawSearch = search.replace(/^\?/, '');
  if (rawSearch && !rawSearch.includes('=')) {
    return decodeURIComponent(rawSearch);
  }

  const short = hash.replace(/^#\/?/, '').trim();
  if (short) {
    return decodeURIComponent(short);
  }

  return null;
};

const tryParseCompactString = (raw: string): BankConfig | null => {
  // 格式示例: apiKey|baseUrl|gpt-5.5-medium:1,gpt-4o-mini:0.6|10000|gpt-5.5-medium:8000,gpt-4o-mini:1200
  const [apiKey, baseUrl, modelPart, quotaPart, balancePart] = raw.split('|');
  if (!apiKey || !baseUrl || !modelPart) return null;

  const parsed: Record<string, unknown> = {
    apiKey: apiKey.trim(),
    baseUrl: baseUrl.trim(),
    models: parseModelList(modelPart),
    tokenQuota: ensureNumber(quotaPart, 0)
  } as Record<string, unknown>;

  if (balancePart) {
    const balances: Record<string, number> = {};
    balancePart
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach((entry) => {
        const [name, value] = entry.split(':');
        if (!name || !value) return;
        const n = Number(value);
        if (Number.isFinite(n)) balances[name.trim()] = Math.max(0, n);
      });
    if (Object.keys(balances).length) parsed.initialBalances = balances;
  }

  return normalizeConfigWithFallback('url', parsed);
};

export const parseConfigFromSuffix = (raw: string | null): BankConfig | null => {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidates = [trimmed];
  const decoded = parseBase64Url(trimmed);
  if (decoded && decoded !== trimmed) {
    candidates.unshift(decoded);
  }

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === 'object') {
        return normalizeConfigWithFallback('url', obj as Record<string, unknown>);
      }
    } catch {
      // ignore and try fallback parser
    }

    const compact = tryParseCompactString(candidate);
    if (compact) return compact;
  }

  return null;
};
