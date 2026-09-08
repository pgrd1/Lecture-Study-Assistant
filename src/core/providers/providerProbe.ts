import { z } from 'zod';

export const PROVIDER_PROBE_PROMPT = '연결을 확인합니다. 정확히 { "ok": true } JSON만 응답하세요.';

export const ProviderProbeOutputSchema = z.strictObject({ ok: z.literal(true) }).readonly();
export type ProviderProbeOutput = z.infer<typeof ProviderProbeOutputSchema>;

export const PROVIDER_PROBE_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: Object.freeze({ ok: Object.freeze({ const: true }) }),
} as const);
