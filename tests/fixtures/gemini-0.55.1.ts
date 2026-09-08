// Source-derived offline fixtures, not a CLI capture or account/isolation attestation.
// v0.55.1 packages/core/src/output/types.ts and cli/src/nonInteractiveCli.ts.
export const timestamp = '2026-09-07T00:00:00.000Z';
export const sessionId = '50000000-0000-4000-8000-000000000099';
export const model = 'gemini-2.5-pro';
export const modelStats = {
  input_tokens: 7,
  output_tokens: 2,
  total_tokens: 11,
  cached: 4,
  input: 3,
};
export const stats = {
  ...modelStats,
  duration_ms: 20,
  tool_calls: 0,
  models: { [model]: modelStats },
};
export const init = { type: 'init', timestamp, session_id: sessionId, model };
export const echo = {
  type: 'message',
  timestamp,
  role: 'user',
  content: 'private source @C:\\private',
};
export const assistant = (content: string) => ({
  type: 'message',
  timestamp,
  role: 'assistant',
  content,
  delta: true,
});
export const result = { type: 'result', timestamp, status: 'success', stats };
export const events = [init, echo, assistant('{"ok":'), assistant('true}'), result];
export const stream = (items: readonly unknown[] = events) =>
  items.map((event) => JSON.stringify(event)).join('\n');

// v0.55.1 packages/cli/src/config/config.ts option definitions (263-484).
// This fixture checks app argv against source declarations, not a live help capture.
export const invocationOptions = {
  '--output-format': ['text', 'json', 'stream-json'],
  '--approval-mode': ['default', 'auto_edit', 'yolo', 'plan'],
  '--admin-policy': 'string',
  '--model': 'string',
} as const;
// core/src/utils/headless.ts: piped stdin OR stdout is headless. The existing
// nodeCliProcessRunner tests independently verify the pipe-based process contract.

// Type/constraint projection of the managed subset of schemas/settings.schema.json
// at the same tag. Descriptions/defaults and unrelated properties are not validation
// authority; the real schema includes them and must not be compared to a fake root.
const boolean = { type: 'boolean' };
const object = <T extends Record<string, unknown>>(properties: T) => ({
  type: 'object',
  additionalProperties: false,
  properties,
});
export const settingsSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://raw.githubusercontent.com/google-gemini/gemini-cli/main/schemas/settings.schema.json',
  title: 'Gemini CLI Settings',
  ...object({
    mcpServers: {
      type: 'object',
      default: {},
      additionalProperties: { $ref: '#/$defs/MCPServerConfig' },
    },
    policyPaths: { type: 'array', default: [], items: { type: 'string' } },
    adminPolicyPaths: { type: 'array', default: [], items: { type: 'string' } },
    general: object({
      enableAutoUpdate: boolean,
      enableAutoUpdateNotification: boolean,
      checkpointing: object({ enabled: boolean }),
      maxAttempts: { type: 'number', default: 10 },
      debugKeystrokeLogging: boolean,
      logRagSnippets: boolean,
    }),
    privacy: object({ usageStatisticsEnabled: boolean }),
    telemetry: object({ enabled: boolean, logPrompts: boolean }),
    ide: object({ enabled: boolean }),
    hooksConfig: object({ enabled: boolean }),
    skills: object({ enabled: boolean }),
    experimental: object({
      enableAgents: boolean,
      adk: object({ agentSessionNoninteractiveEnabled: boolean }),
    }),
  }),
};
