import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderFileBlock, ProviderRequest } from '../../src/core/ports/aiProvider';
import type { SecretStore } from '../../src/core/ports/secretStore';
import { createAnthropicApiAdapter } from '../../src/infrastructure/providers/api/anthropicApiAdapter';
import { buildAnthropicMessageBody } from '../../src/infrastructure/providers/api/anthropicApiProtocol';
import { createGeminiApiAdapter } from '../../src/infrastructure/providers/api/geminiApiAdapter';
import { buildGeminiInteractionBody } from '../../src/infrastructure/providers/api/geminiApiProtocol';
import { createOpenAiApiAdapter } from '../../src/infrastructure/providers/api/openAiApiAdapter';
import { buildOpenAiResponseBody } from '../../src/infrastructure/providers/api/openAiApiProtocol';
import { prepareApiMediaBody } from '../../src/infrastructure/providers/api/providerApiMedia';
import type { ProviderHttpRequest } from '../../src/infrastructure/providers/api/providerHttpClient';
import { createProviderHttpClientForTest } from '../../src/infrastructure/providers/api/providerHttpClient';
import { ProviderSourceMaterializer } from '../../src/infrastructure/providers/providerSourceMaterializer';
import type { ApiProviderId, JsonValue } from '../../src/shared/contracts/provider';
import { jpeg, wav } from '../fixtures/metadata/synthetic';

const block: ProviderFileBlock = {
  role: 'user',
  kind: 'source_file',
  sourceId: randomUUID(),
  filePath: 'C:\\unread\\image.jpg',
  mediaType: 'image',
  sizeBytes: 8,
  sha256: '0'.repeat(64),
};
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
  'base64',
);
const fixture = async (name = 'source.png', bytes: Buffer = png): Promise<ProviderFileBlock> => {
  const root = await mkdtemp(join(tmpdir(), 'native-media-test-'));
  roots.push(root);
  const filePath = join(root, name);
  await writeFile(filePath, bytes);
  return {
    ...block,
    filePath,
    mediaType: name.endsWith('.pdf')
      ? 'document'
      : /\.(?:mp3|wav)$/u.test(name)
        ? 'audio'
        : 'image',
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
};
const models = {
  gemini_api: 'gemini-3.8-flash',
  openai_api: 'gpt-4.1',
  claude_api: 'claude-sonnet-4-6',
} as const;
const prepare = (
  providerId: ApiProviderId,
  file: ProviderFileBlock,
  overrides: Partial<Parameters<typeof prepareApiMediaBody>[0]> = {},
) =>
  prepareApiMediaBody({
    providerId,
    modelId: models[providerId],
    requestId: randomUUID(),
    blocks: [file],
    signal: new AbortController().signal,
    build: (blocks) => {
      const input = {
        modelId: models[providerId],
        blocks,
        outputJsonSchema: { type: 'object', additionalProperties: false },
        outputSchemaId: 'evidence_segments',
        maxOutputTokens: 128,
      };
      return providerId === 'gemini_api'
        ? buildGeminiInteractionBody(input)
        : providerId === 'openai_api'
          ? buildOpenAiResponseBody(input)
          : buildAnthropicMessageBody({
              modelId: input.modelId,
              blocks,
              outputJsonSchema: input.outputJsonSchema,
              maxOutputTokens: input.maxOutputTokens,
            });
    },
    ...overrides,
  });
it('rejects an unknown model before materialization', async () => {
  await expect(
    prepareApiMediaBody({
      providerId: 'gemini_api',
      modelId: 'unknown',
      requestId: randomUUID(),
      blocks: [block],
      signal: new AbortController().signal,
      build: (blocks) =>
        buildGeminiInteractionBody({
          modelId: 'unknown',
          blocks,
          outputJsonSchema: { type: 'object' },
          maxOutputTokens: 128,
        }),
    }),
  ).rejects.toMatchObject({ code: 'PROVIDER_MEDIA_UNSUPPORTED' });
});

it.each(['gemini_api', 'openai_api', 'claude_api'] as const)(
  'uses the official native image shape for %s without original paths',
  async (id) => {
    const file = await fixture();
    const body = await prepare(id, file);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(file.filePath);
    expect(serialized).toContain(png.toString('base64'));
    expect(body).toMatchObject(
      id === 'gemini_api'
        ? {
            input: expect.arrayContaining([
              { type: 'image', mime_type: 'image/png', data: png.toString('base64') },
            ]),
          }
        : id === 'openai_api'
          ? {
              input: expect.arrayContaining([
                expect.objectContaining({
                  role: 'user',
                  content: expect.arrayContaining([
                    {
                      type: 'input_image',
                      image_url: `data:image/png;base64,${png.toString('base64')}`,
                      detail: 'auto',
                    },
                  ]),
                }),
              ]),
            }
          : {
              messages: [
                expect.objectContaining({
                  content: expect.arrayContaining([
                    {
                      type: 'image',
                      source: {
                        type: 'base64',
                        media_type: 'image/png',
                        data: png.toString('base64'),
                      },
                    },
                  ]),
                }),
              ],
            },
    );
  },
);

it.each(['gemini_api', 'openai_api', 'claude_api'] as const)(
  'builds native PDF parts for %s',
  async (id) => {
    const file = await fixture('source.pdf', Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF'));
    const body = await prepare(id, file);
    const serialized = JSON.stringify(body);
    expect(serialized).toContain('application/pdf');
    expect(serialized).toContain(id === 'openai_api' ? 'input_file' : 'document');
  },
);

it('encodes Gemini audio and rejects audio on Responses/Messages before opening', async () => {
  const file = await fixture('source.mp3', Buffer.from('ID3fixture'));
  expect(await prepare('gemini_api', file)).toMatchObject({
    input: expect.arrayContaining([
      expect.objectContaining({ type: 'audio', mime_type: 'audio/mpeg' }),
    ]),
  });
  for (const id of ['openai_api', 'claude_api'] as const)
    await expect(
      prepare(id, { ...file, filePath: 'C:\\unread\\source.mp3' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_MEDIA_UNSUPPORTED' });
});

it('encodes an iPhone M4A container as native Gemini audio/m4a and rejects ambiguous MP4 brands', async () => {
  const bytes = Buffer.from('00000018667479704d344120000000004d34412069736f6d', 'hex');
  const stored = await fixture('recording.m4a', bytes);
  const file = { ...stored, mediaType: 'audio' as const };
  expect(await prepare('gemini_api', file)).toMatchObject({
    input: expect.arrayContaining([
      { type: 'audio', mime_type: 'audio/m4a', data: bytes.toString('base64') },
    ]),
  });
  const ambiguous = Buffer.from(bytes);
  ambiguous.write('mp42', 8, 'ascii');
  const bad = await fixture('recording.m4a', ambiguous);
  await expect(prepare('gemini_api', { ...bad, mediaType: 'audio' })).rejects.toMatchObject({
    code: 'PROVIDER_MEDIA_UNSUPPORTED',
  });
  await expect(
    prepare('openai_api', { ...file, filePath: 'C:\\unread\\recording.m4a' }),
  ).rejects.toMatchObject({ code: 'PROVIDER_MEDIA_UNSUPPORTED' });
});

it.each(['gemini_api', 'openai_api', 'claude_api'] as const)(
  'rejects whole encoded request overflow before materialization for %s',
  async (id) => {
    const materializer = { materialize: vi.fn(), cleanup: vi.fn() };
    await expect(
      prepare(
        id,
        {
          ...block,
          filePath: 'C:\\unread\\source.pdf',
          mediaType: 'document',
          sizeBytes: 49_000_000,
        },
        {
          materializer,
          build: () => ({
            input:
              id === 'openai_api'
                ? [
                    {
                      role: 'user',
                      content: [{ type: 'input_text', text: 'x'.repeat(33_000_000) }],
                    },
                  ]
                : 'x'.repeat(33_000_000),
            messages: [{ role: 'user', content: 'x' }],
          }),
        },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_TOO_LARGE' });
    expect(materializer.materialize).not.toHaveBeenCalled();
    expect(materializer.cleanup).not.toHaveBeenCalled();
  },
);

it.each(['bad.png', 'bad.jpg', 'bad.pdf'] as const)(
  'rejects mismatched media signature %s and cleans the workspace',
  async (name) => {
    const file = await fixture(name, Buffer.from('bad format'));
    const root = await mkdtemp(join(tmpdir(), 'media-cleanup-test-'));
    roots.push(root);
    await expect(
      prepare('gemini_api', file, { materializer: new ProviderSourceMaterializer(root) }),
    ).rejects.toMatchObject({ code: 'PROVIDER_MEDIA_UNSUPPORTED' });
    expect(await readdir(root)).toEqual([]);
  },
);

it('rejects dimensions above the verified image limit', async () => {
  const bytes = Buffer.from(png);
  bytes.writeUInt32BE(8001, 16);
  const file = await fixture('big.png', bytes);
  await expect(prepare('claude_api', file)).rejects.toMatchObject({
    code: 'PROVIDER_MEDIA_UNSUPPORTED',
  });
});

const responseFor = (id: ApiProviderId): JsonValue =>
  id === 'gemini_api'
    ? {
        object: 'interaction',
        status: 'completed',
        model: models[id],
        steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"ok":true}' }] }],
        usage: {
          total_input_tokens: 1,
          total_output_tokens: 1,
          total_tokens: 2,
          total_tool_use_tokens: 0,
        },
      }
    : id === 'openai_api'
      ? {
          object: 'response',
          status: 'completed',
          error: null,
          incomplete_details: null,
          model: models[id],
          output: [
            {
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [
                { type: 'output_text', text: '{"ok":true}', annotations: [], logprobs: [] },
              ],
            },
          ],
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          },
        }
      : {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: models[id],
          content: [{ type: 'text', text: '{"ok":true}' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
it.each(
  (['gemini_api', 'openai_api', 'claude_api'] as const).flatMap((id) =>
    (
      [
        'success',
        'jpeg',
        ...(id === 'gemini_api' ? (['wav'] as const) : []),
        'failure',
        'cancel',
      ] as const
    ).map((mode) => [id, mode] as const),
  ),
)('adapter %s removes copies on %s through its existing execution lifecycle', async (id, mode) => {
  const bytes = mode === 'jpeg' ? jpeg() : mode === 'wav' ? wav() : png;
  const file = await fixture(
    mode === 'jpeg' ? 'source.jpg' : mode === 'wav' ? 'source.wav' : 'source.png',
    bytes,
  );
  const root = await mkdtemp(join(tmpdir(), 'adapter-media-cleanup-'));
  roots.push(root);
  const requestJson = vi.fn(async (_request: ProviderHttpRequest) => {
    expect(await readdir(root)).toEqual([]);
    if (mode === 'failure') throw new Error('controlled transport failure');
    if (mode === 'cancel') adapter.cancel(request.requestId);
    return responseFor(id);
  });
  const options = {
    httpClient: { requestJson },
    secretStore: { get: vi.fn(async () => 'test-key') } as unknown as SecretStore,
    now: () => '2026-09-07T00:00:00.000Z',
    nowMilliseconds: () => 0,
    materializer: new ProviderSourceMaterializer(root),
  };
  const adapter =
    id === 'gemini_api'
      ? createGeminiApiAdapter(options)
      : id === 'openai_api'
        ? createOpenAiApiAdapter(options)
        : createAnthropicApiAdapter(options);
  const request: ProviderRequest<JsonValue> = {
    requestId: randomUUID(),
    feature: 'media_extraction',
    jobId: null,
    outputSchemaId: 'evidence_segments',
    outputJsonSchema: { type: 'object', additionalProperties: false },
    parseOutput: (value) => value as JsonValue,
    blocks: [file],
    timeoutMs: 30_000,
    maxOutputTokens: 128,
    signal: new AbortController().signal,
    modelId: models[id],
    promptVersion: 'v1',
    routeRevision: 0,
    providerManagedHistoryConsentAt: null,
    providerManagedHistoryConsentVersion: null,
    sharedCredentialConsentAt: null,
    sharedCredentialConsentVersion: null,
    attemptKind: 'initial',
  };
  if (mode === 'success' || mode === 'jpeg' || mode === 'wav')
    await expect(adapter.execute(request)).resolves.toMatchObject({ output: { ok: true } });
  else
    await expect(adapter.execute(request)).rejects.toMatchObject({
      code: mode === 'cancel' ? 'PROVIDER_CANCELLED' : 'PROVIDER_EXECUTION_FAILED',
    });
  expect(requestJson).toHaveBeenCalledOnce();
  expect(JSON.stringify(requestJson.mock.calls)).toContain(bytes.toString('base64'));
  expect(JSON.stringify(requestJson.mock.calls)).not.toContain(file.filePath);
  if (mode === 'jpeg' || mode === 'wav') {
    const body = requestJson.mock.calls[0]?.[0] as unknown as { body: unknown };
    const data = bytes.toString('base64');
    expect(body.body).toMatchObject(
      id === 'gemini_api'
        ? {
            input: expect.arrayContaining([
              {
                type: mode === 'wav' ? 'audio' : 'image',
                mime_type: mode === 'wav' ? 'audio/wav' : 'image/jpeg',
                data,
              },
            ]),
          }
        : id === 'openai_api'
          ? {
              input: expect.arrayContaining([
                expect.objectContaining({
                  role: 'user',
                  content: expect.arrayContaining([
                    {
                      type: 'input_image',
                      image_url: `data:image/jpeg;base64,${data}`,
                      detail: 'auto',
                    },
                  ]),
                }),
              ]),
            }
          : {
              messages: [
                expect.objectContaining({
                  content: expect.arrayContaining([
                    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
                  ]),
                }),
              ],
            },
    );
  }
  expect(await readdir(root)).toEqual([]);
});

it('cleans copies when cancellation arrives after materialization but before encoding/disclosure', async () => {
  const file = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'cancel-media-'));
  roots.push(root);
  const real = new ProviderSourceMaterializer(root);
  const controller = new AbortController();
  const materializer = {
    materialize: async (...args: Parameters<typeof real.materialize>) => {
      const result = await real.materialize(...args);
      controller.abort();
      return result;
    },
    cleanup: (id: string) => real.cleanup(id),
  };
  await expect(
    prepare('gemini_api', file, { materializer, signal: controller.signal }),
  ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
  expect(await readdir(root)).toEqual([]);
});

it('treats cleanup failure as residual data before disclosing a body', async () => {
  const file = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'residual-media-'));
  roots.push(root);
  const real = new ProviderSourceMaterializer(root);
  const materializer = {
    materialize: (...args: Parameters<typeof real.materialize>) => real.materialize(...args),
    cleanup: async () => {
      throw new Error('controlled cleanup failure');
    },
  };
  await expect(prepare('gemini_api', file, { materializer })).rejects.toMatchObject({
    code: 'PROVIDER_RESIDUAL_DATA',
  });
});

it('a rejected duplicate preparation cannot remove the original request workspace', async () => {
  const file = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'duplicate-media-'));
  roots.push(root);
  const materializer = new ProviderSourceMaterializer(root);
  const requestId = randomUUID();
  const original = await materializer.materialize(requestId, [file]);
  await expect(prepare('gemini_api', file, { materializer, requestId })).rejects.toMatchObject({
    code: 'PROVIDER_EXECUTION_FAILED',
  });
  const copied = original.files[0];
  if (!copied) throw new Error('fixture missing');
  expect(await readFile(copied.absolutePath)).toEqual(png);
  await materializer.cleanup(requestId);
});

it('rejects repeated large strings before calling whole-body JSON serialization', async () => {
  const request = vi.fn();
  const http = createProviderHttpClientForTest({
    transport: { request },
    logger: { record: vi.fn() },
    now: () => 0,
  });
  const piece = '\\'.repeat(1_000_000);
  const body = { copies: Array.from({ length: 100 }, () => piece) };
  const stringify = vi.spyOn(JSON, 'stringify');
  try {
    await expect(
      http.requestJson({
        providerId: 'claude_api',
        endpoint: { id: 'claude_messages' },
        authValue: 'test-key',
        body,
        timeoutMs: 30_000,
        responseLimitBytes: 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_TOO_LARGE' });
    expect(
      stringify.mock.calls.some(
        ([value]) => value !== null && typeof value === 'object' && 'copies' in value,
      ),
    ).toBe(false);
    expect(request).not.toHaveBeenCalled();
  } finally {
    stringify.mockRestore();
  }
});

it.each([
  ['gemini_api', 'gemini_interactions', 96_000_000],
  ['openai_api', 'openai_responses', 64_000_000],
  ['claude_api', 'claude_messages', 32_000_000],
] as const)(
  'HTTP transport independently enforces %s whole-body ceiling before network access',
  async (providerId, endpoint, limit) => {
    const request = vi.fn();
    const http = createProviderHttpClientForTest({
      transport: { request },
      logger: { record: vi.fn() },
      now: () => 0,
    });
    await expect(
      http.requestJson({
        providerId,
        endpoint: { id: endpoint },
        authValue: 'test-key',
        body: { text: 'x'.repeat(limit) },
        timeoutMs: 30_000,
        responseLimitBytes: 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_TOO_LARGE' });
    expect(request).not.toHaveBeenCalled();
  },
);
