import { describe, expect, it } from 'vitest';
import {
  type AiProviderAdapter,
  assertProviderSupportsBlocks,
  createProviderConnectionOperation,
  createProviderOperation,
  requireTextBlocks,
} from '../../../../src/core/ports/aiProvider';

const requestId = '123e4567-e89b-42d3-a456-426614174000';

const audioBlock = {
  role: 'user',
  kind: 'source_file',
  sourceId: requestId,
  filePath: 'C:/private/source.m4a',
  mediaType: 'audio',
  sha256: 'a'.repeat(64),
  sizeBytes: 123,
} as const;
const descriptor = () => ({
  requestId,
  feature: 'media_extraction' as const,
  jobId: null,
  outputSchemaId: 'evidence_segments',
  outputJsonSchema: { type: 'object', additionalProperties: false },
  parseOutput: () => ({}),
  blocks: [audioBlock],
  timeoutMs: 30_000,
  maxOutputTokens: 100,
  signal: new AbortController().signal,
});
describe('provider media operations', () => {
  it('rejects files in temporary text execution boundaries without leaking paths', () => {
    expect(() => requireTextBlocks([audioBlock])).toThrow('PROVIDER_MEDIA_UNSUPPORTED');
    expect(() =>
      assertProviderSupportsBlocks('codex_cli', [{ ...audioBlock, mediaType: 'document' }]),
    ).toThrow('PROVIDER_MEDIA_UNSUPPORTED');
    expect(() =>
      assertProviderSupportsBlocks('gemini_api', [audioBlock], 'lecture_organize'),
    ).toThrow('PROVIDER_MEDIA_UNSUPPORTED');
    expect(() =>
      assertProviderSupportsBlocks('gemini_api', [audioBlock], 'audio_transcription'),
    ).not.toThrow();
    expect(() =>
      assertProviderSupportsBlocks('claude_api', [audioBlock], 'media_extraction'),
    ).toThrow('PROVIDER_MEDIA_UNSUPPORTED');
    expect(
      requireTextBlocks([
        { role: 'system', kind: 'instruction', text: 'app instruction' },
        { role: 'user', kind: 'source', text: 'untrusted source' },
      ]),
    ).toEqual([
      { role: 'system', kind: 'instruction', text: 'app instruction' },
      { role: 'user', kind: 'source', text: 'untrusted source' },
    ]);
  });
  it('rejects an audio file block for a provider without audio capability', () => {
    expect(() => assertProviderSupportsBlocks('codex_cli', [audioBlock])).toThrowError(
      'PROVIDER_MEDIA_UNSUPPORTED',
    );
  });
  it('copies immutable file descriptors and validates IDs and metadata', () => {
    const operation = createProviderOperation(descriptor());
    expect(operation.blocks[0]).toEqual(audioBlock);
    expect(Object.isFrozen(operation.blocks[0])).toBe(true);
    for (const change of [
      { feature: 'unknown' },
      { jobId: 'bad' },
      { blocks: [{ ...audioBlock, sizeBytes: -1 }] },
      { blocks: [{ ...audioBlock, sourceId: 'bad' }] },
      { blocks: [{ ...audioBlock, role: 'system' }] },
    ]) {
      expect(() => createProviderOperation({ ...descriptor(), ...change } as never)).toThrow();
    }
  });
  it('does not invoke a file accessor', () => {
    let reads = 0;
    const block = {
      ...audioBlock,
      get filePath() {
        reads += 1;
        return 'private';
      },
    };
    expect(() => createProviderOperation({ ...descriptor(), blocks: [block] })).toThrow();
    expect(reads).toBe(0);
  });
});

describe('provider connection operation contract', () => {
  it('creates a frozen operation from an exact request id and AbortSignal descriptor', () => {
    const controller = new AbortController();

    const operation = createProviderConnectionOperation({
      requestId,
      signal: controller.signal,
    });

    expect(operation).toEqual({ requestId, signal: controller.signal });
    expect(Object.isFrozen(operation)).toBe(true);
  });

  it.each([
    ['missing requestId', { signal: new AbortController().signal }],
    ['missing signal', { requestId }],
    ['extra key', { requestId, signal: new AbortController().signal, leaked: true }],
    ['invalid requestId', { requestId: 'not-a-uuid', signal: new AbortController().signal }],
    ['invalid signal', { requestId, signal: { aborted: false } }],
  ] as const)('rejects %s', (_label, descriptor) => {
    expect(() => createProviderConnectionOperation(descriptor as never)).toThrow(
      'INVALID_PROVIDER_CONNECTION_OPERATION',
    );
  });

  it('rejects accessors, symbols, and inherited keys without invoking caller logic', () => {
    const controller = new AbortController();
    const withAccessor = {};
    Object.defineProperty(withAccessor, 'requestId', {
      enumerable: true,
      get: () => requestId,
    });
    Object.defineProperty(withAccessor, 'signal', {
      enumerable: true,
      value: controller.signal,
    });

    const withSymbol = {
      requestId,
      signal: controller.signal,
      [Symbol('hidden')]: 'hidden',
    };

    const withInherited = Object.create({ inherited: true }) as Record<string, unknown>;
    withInherited.requestId = requestId;
    withInherited.signal = controller.signal;

    expect(() => createProviderConnectionOperation(withAccessor as never)).toThrow(
      'INVALID_PROVIDER_CONNECTION_OPERATION',
    );
    expect(() => createProviderConnectionOperation(withSymbol as never)).toThrow(
      'INVALID_PROVIDER_CONNECTION_OPERATION',
    );
    expect(() => createProviderConnectionOperation(withInherited as never)).toThrow(
      'INVALID_PROVIDER_CONNECTION_OPERATION',
    );
  });

  it('fails closed when proxy traps throw or the key snapshot changes without reading values', () => {
    const signal = new AbortController().signal;
    let valueReads = 0;
    const throwingProxy = new Proxy(
      { requestId, signal },
      {
        get: () => {
          valueReads += 1;
          throw new Error('PRIVATE_PROXY_VALUE');
        },
        ownKeys: () => {
          throw new Error('PRIVATE_PROXY_KEYS');
        },
      },
    );

    let snapshots = 0;
    const changingProxy = new Proxy(
      { requestId, signal },
      {
        ownKeys: (target) => {
          snapshots += 1;
          return snapshots === 1 ? Reflect.ownKeys(target) : [...Reflect.ownKeys(target), 'late'];
        },
      },
    );

    expect(() => createProviderConnectionOperation(throwingProxy)).toThrow(
      'INVALID_PROVIDER_CONNECTION_OPERATION',
    );
    expect(valueReads).toBe(0);
    expect(() => createProviderConnectionOperation(changingProxy)).toThrow(
      'INVALID_PROVIDER_CONNECTION_OPERATION',
    );
  });

  it('requires the connection operation on every inspection method at compile time', () => {
    const compileContract = (adapter: AiProviderAdapter<'openai_api'>): void => {
      // @ts-expect-error A caller-owned connection operation is required.
      void adapter.inspect();
      // @ts-expect-error A caller-owned connection operation is required.
      void adapter.listModels();
      // @ts-expect-error A caller-owned connection operation is required.
      void adapter.probe('gpt-5.6');
    };

    expect(compileContract).toBeTypeOf('function');
  });
});
