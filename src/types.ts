export type ConfigSource = 'url' | 'manual' | 'fallback';

export interface ParsedModel {
  id: string;
  rate: number;
  note?: string;
}

export interface BankConfig {
  source: ConfigSource;
  profileName: string;
  apiKey: string;
  baseUrl: string;
  models: ParsedModel[];
  tokenQuota?: number;
  initialBalances?: Record<string, number>;
}

export interface SwapRecord {
  id: string;
  from: string;
  to: string;
  fromAmount: number;
  toAmount: number;
  at: number;
}
