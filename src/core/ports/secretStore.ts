import { z } from 'zod';

export const SECRET_KEYS = ['openai_api_key', 'gemini_api_key', 'anthropic_api_key'] as const;

export const SecretKeySchema = z.enum(SECRET_KEYS);
export type SecretKey = z.infer<typeof SecretKeySchema>;

export type SecretStoreOperation = Readonly<{
  requestId: string;
  signal: AbortSignal;
}>;

export interface SecretStore {
  set(key: SecretKey, value: string, operation: SecretStoreOperation): Promise<void>;
  get(key: SecretKey, operation: SecretStoreOperation): Promise<string | undefined>;
  delete(key: SecretKey, operation: SecretStoreOperation): Promise<void>;
  has(key: SecretKey, operation: SecretStoreOperation): Promise<boolean>;
}
