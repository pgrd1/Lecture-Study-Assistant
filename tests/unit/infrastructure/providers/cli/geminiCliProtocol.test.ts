import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  assertGeminiRoots,
  buildGeminiArgs,
  buildGeminiPrompt,
  createGeminiManagedProfile,
  type GeminiBinding,
  parseGeminiStream,
  validateGeminiSettingsSchema,
} from '../../../../../src/infrastructure/providers/cli/geminiCliProtocol';
import {
  assistant,
  echo,
  events,
  init,
  model,
  result,
  settingsSchema,
  stats,
  stream,
  timestamp,
} from '../../../../fixtures/gemini-0.55.1';

const requestId = '50000000-0000-4000-8000-000000000001';
const parse = (text = stream(), selected: string | null = model) =>
  parseGeminiStream(text, requestId, selected, (value) => value as { ok: true });
const validateSchema = (schema: unknown) => {
  const contents = JSON.stringify(schema);
  return validateGeminiSettingsSchema({ packageManifestSha256: 'c'.repeat(64) } as GeminiBinding, {
    packageManifestSha256: 'c'.repeat(64),
    relativePath: 'settings.schema.json',
    schemaSha256: createHash('sha256').update(contents).digest('hex'),
    contents,
  });
};
describe('pinned Gemini text protocol', () => {
  it.each([null, model])('uses only source-declared options for model %s', (selected) => {
    const args = buildGeminiArgs(
      [],
      'R:\\profiles\\gemini_cli\\settings\\.gemini\\policies\\studyapp-deny-all.toml',
      selected,
    );
    const base = [
      '--output-format',
      'stream-json',
      '--approval-mode',
      'default',
      '--admin-policy',
      'R:\\profiles\\gemini_cli\\settings\\.gemini\\policies\\studyapp-deny-all.toml',
    ];
    expect(args).toEqual(selected === null ? base : [...base, '--model', model]);
  });
  it('rejects contradictory constraints in the managed subset rather than ignoring them', () => {
    const properties = settingsSchema.properties;
    expect(() =>
      validateSchema({
        ...settingsSchema,
        properties: {
          ...properties,
          general: {
            ...properties.general,
            properties: {
              ...properties.general.properties,
              maxAttempts: { type: 'number', enum: [2] },
            },
          },
        },
      }),
    ).toThrow();
  });
  it('rejects depth, duplicate keys, final JSON suffixes and private paths without returning diagnostics', () => {
    const outputs = [
      `${'['.repeat(40)}0${']'.repeat(40)}`,
      '{"ok":true} trailing',
      '{"path":"C:\\\\private"}',
    ];
    for (const text of outputs)
      expect(() => parse(stream([init, echo, assistant(text), result]))).toThrow();
    expect(() =>
      parse(stream().replace('"status":"success"', '"status":"error","status":"success"')),
    ).toThrow();
  });
  it('assembles genuine assistant deltas, discards the source echo and projects reported statistics', () => {
    expect(parse()).toEqual({
      output: { ok: true },
      reportedModelId: model,
      usage: { inputTokens: 7, outputTokens: 2, totalTokens: 11 },
    });
    expect(Object.isFrozen(parse().output)).toBe(true);
  });
  it('does not claim an init configuration label was the execution model without per-model evidence', () => {
    expect(
      parse(
        stream([...events.slice(0, -1), { type: 'result', timestamp, status: 'success' }]),
        null,
      ),
    ).toMatchObject({
      reportedModelId: null,
      usage: { inputTokens: null, outputTokens: null, totalTokens: null },
    });
  });
  it.each([
    ['missing init', events.slice(1)],
    ['missing echo', [init, assistant('{"ok":true}'), result]],
    ['echo-only', [init, { ...echo, content: '{"ok":true}' }, result]],
    ['extra init field', [{ ...init, auth: { tier: 'enterprise' } }, ...events.slice(1)]],
    [
      'missing timestamp',
      [{ type: 'init', session_id: init.session_id, model }, ...events.slice(1)],
    ],
    ['unknown event', [init, echo, { type: 'reroute', timestamp }, result]],
    [
      'error',
      [init, echo, { type: 'error', timestamp, severity: 'warning', message: 'private' }, result],
    ],
    ['terminal error', [...events.slice(0, -1), { ...result, status: 'error' }]],
    ['duplicate terminal', [...events, result]],
    ['post-assistant echo', [init, echo, assistant('{"ok":true}'), echo, result]],
    ['non-delta assistant', [init, echo, { ...assistant('{"ok":true}'), delta: false }, result]],
    ['bad stats', [...events.slice(0, -1), { ...result, stats: { ...stats, input_tokens: null } }]],
  ])('rejects %s without accepting or leaking source content', (_name, items) => {
    expect(() => parse(stream(items as readonly unknown[]))).toThrow(
      expect.objectContaining({ code: 'PROVIDER_OUTPUT_INVALID' }),
    );
  });
  it.each(['tool_use', 'tool_result'])(
    'rejects upstream %s even for a denied canary attempt',
    (type) => {
      const tool =
        type === 'tool_use'
          ? {
              type,
              timestamp,
              tool_name: 'run_shell_command',
              tool_id: '1',
              parameters: { command: 'echo canary' },
            }
          : {
              type,
              timestamp,
              tool_id: '1',
              status: 'error',
              error: { type: 'TOOL_EXECUTION_ERROR', message: 'denied' },
            };
      expect(() => parse(stream([init, echo, tool, ...events.slice(2)]))).toThrow(
        expect.objectContaining({ code: 'PROVIDER_TOOL_ACTIVITY_DETECTED' }),
      );
    },
  );
  it('rejects per-model rerouting and selected/configured mismatch', () => {
    expect(() => parse(stream(), 'other-model')).toThrow(
      expect.objectContaining({ code: 'PROVIDER_MODEL_INCOMPATIBLE' }),
    );
    expect(() =>
      parse(
        stream([
          ...events.slice(0, -1),
          { ...result, stats: { ...stats, models: { other: stats.models[model] } } },
        ]),
      ),
    ).toThrow(expect.objectContaining({ code: 'PROVIDER_MODEL_INCOMPATIBLE' }));
  });
  it.each(['', 'not json', `${stream()}\n\n`, stream().slice(0, -2), 'x'.repeat(1024 * 1024 + 1)])(
    'rejects malformed or bounded stream input',
    (text) => expect(() => parse(text)).toThrow(),
  );
  it('validates final output only once', () => {
    const validate = vi.fn(() => ({ ok: true }));
    parseGeminiStream(stream(), requestId, model, validate);
    expect(validate).toHaveBeenCalledExactlyOnceWith({ ok: true });
  });
  it('accepts more than 64 genuine deltas but bounds event count and individual event bytes', () => {
    const fragments = Array.from({ length: 100 }, () => assistant('a'));
    expect(
      parseGeminiStream(
        stream([init, echo, assistant('"'), ...fragments, assistant('"'), result]),
        requestId,
        model,
        (value) => String(value),
      ).output,
    ).toBe('a'.repeat(100));
    expect(() =>
      parse(stream([init, echo, ...Array.from({ length: 4096 }, () => assistant('a')), result])),
    ).toThrow();
    expect(() => parse(stream([init, echo, assistant('a'.repeat(512 * 1024)), result]))).toThrow();
  });
  it.each([
    'mail@example.test',
    '@C:\\private',
    '@\\\\server\\share',
    '@../secret',
    '@*.pdf',
    '@agent',
    '@mcp:resource',
    '@"white space"',
    '\\@file',
    '\\\\@file',
    '\\u0040 literal @file',
    '@\u00a0file',
  ])('escapes every envelope at-sign while round-tripping %s', (text) => {
    const blocks = [
      { role: 'system', kind: 'instruction', text },
      { role: 'user', kind: 'source', text },
    ] as const;
    const outputJsonSchema = { '@schema': text };
    const prompt = buildGeminiPrompt(blocks, outputJsonSchema);
    expect(prompt).not.toContain('@');
    expect(JSON.parse(prompt)).toEqual({ blocks, outputJsonSchema });
  });
  it('writes settings under the replacement home .gemini directory', () => {
    const profile = createGeminiManagedProfile(assertGeminiRoots('C:\\StudyApp\\providers'));
    expect(profile.settingsPath).toBe(`${profile.geminiCliHomePath}\\.gemini\\settings.json`);
    expect(profile.policyPath).toBe(
      `${profile.geminiCliHomePath}\\.gemini\\policies\\studyapp-deny-all.toml`,
    );
  });
  it('validates the pinned managed subset with metadata, unrelated settings, and numeric maxAttempts', () =>
    expect(validateSchema(settingsSchema)).toMatch(/^[a-f0-9]{64}$/));
  it('rejects a missing or changed managed setting type', () => {
    expect(() =>
      validateSchema({
        ...settingsSchema,
        properties: { ...settingsSchema.properties, general: { type: 'object', properties: {} } },
      }),
    ).toThrow();
  });
});
