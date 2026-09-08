import { describe, expect, it } from 'vitest';
import { cloneOpenAiOwnedJson } from '../../../../../src/infrastructure/providers/api/openAiApiOwnedJson';
import {
  buildOpenAiResponseBody,
  parseOpenAiResponse,
} from '../../../../../src/infrastructure/providers/api/openAiApiProtocol';

const FIXED_NOW = '2026-09-03T00:00:00.000Z';

type HostileJsonFixture = Readonly<{
  value: unknown;
  readCount: () => number;
}>;

const inertFixture = (value: unknown): HostileJsonFixture => ({ value, readCount: () => 0 });

const proxyFixture = (value: object): HostileJsonFixture => {
  let reads = 0;
  const trap = (): never => {
    reads += 1;
    throw new Error('private proxy trap');
  };
  return {
    value: new Proxy(value, {
      get: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
      ownKeys: trap,
    }),
    readCount: () => reads,
  };
};

const accessorFixture = (value: object, key: string): HostileJsonFixture => {
  let reads = 0;
  Object.defineProperty(value, key, {
    enumerable: true,
    get: () => {
      reads += 1;
      return 'hidden';
    },
  });
  return { value, readCount: () => reads };
};

const hostileJsonFactories: ReadonlyArray<
  readonly [name: string, create: () => HostileJsonFixture]
> = [
  [
    'object with a non-enumerable own key',
    () =>
      inertFixture(
        Object.defineProperty({ ok: true }, 'private', { enumerable: false, value: 'hidden' }),
      ),
  ],
  [
    'object with a symbol key',
    () =>
      inertFixture(
        Object.defineProperty({ ok: true }, Symbol('private'), {
          enumerable: true,
          value: 'hidden',
        }),
      ),
  ],
  [
    'object with an inherited enumerable key',
    () => inertFixture(Object.assign(Object.create({ private: 'hidden' }), { ok: true })),
  ],
  ['object with an accessor', () => accessorFixture({ ok: true }, 'private')],
  ['object Proxy', () => proxyFixture({ ok: true })],
  [
    'cyclic object',
    () => {
      const value: Record<string, unknown> = { ok: true };
      value.self = value;
      return inertFixture(value);
    },
  ],
  [
    'array with a non-enumerable own key',
    () =>
      inertFixture(
        Object.defineProperty([true], 'private', { enumerable: false, value: 'hidden' }),
      ),
  ],
  [
    'array with a symbol key',
    () =>
      inertFixture(
        Object.defineProperty([true], Symbol('private'), {
          enumerable: true,
          value: 'hidden',
        }),
      ),
  ],
  [
    'array with an inherited enumerable key',
    () => {
      const value = [true];
      Object.setPrototypeOf(
        value,
        Object.assign(Object.create(Array.prototype), { private: true }),
      );
      return inertFixture(value);
    },
  ],
  ['array with an accessor', () => accessorFixture([true], '0')],
  ['array Proxy', () => proxyFixture([true])],
  ['sparse array', () => inertFixture(new Array(1))],
  [
    'cyclic array',
    () => {
      const value: unknown[] = [];
      value.push(value);
      return inertFixture(value);
    },
  ],
];

const response = () => ({
  object: 'response',
  status: 'completed',
  error: null,
  incomplete_details: null,
  model: 'gpt-5.6-2026-08-01',
  output: [
    {
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '{"ok":true}', annotations: [], logprobs: [] }],
    },
  ],
  usage: {
    input_tokens: 1,
    input_tokens_details: {},
    output_tokens: 1,
    output_tokens_details: {},
    total_tokens: 2,
  },
});

const captureFailure = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('EXPECTED_FAILURE');
};

describe('OpenAI-owned strict JSON', () => {
  it('returns a deep-frozen fresh clone with no mutable aliases', () => {
    const source = { nested: [{ ok: true }] };
    const result = cloneOpenAiOwnedJson(source, 64, 100_000) as Readonly<{
      nested: readonly Readonly<{ ok: boolean }>[];
    }>;
    expect(result).toEqual({ nested: [{ ok: true }] });
    expect(result).not.toBe(source);
    expect(result.nested).not.toBe(source.nested);
    expect(result.nested[0]).not.toBe(source.nested[0]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.nested)).toBe(true);
    expect(Object.isFrozen(result.nested[0])).toBe(true);
    source.nested[0] = { ok: false };
    expect(result.nested[0]).toEqual({ ok: true });
  });

  it.each(hostileJsonFactories)(
    'rejects %s directly and at both protocol ownership boundaries without hostile reads',
    (_name, create) => {
      const direct = create();
      expect(() => cloneOpenAiOwnedJson(direct.value, 64, 100_000)).toThrow(TypeError);
      expect(direct.readCount()).toBe(0);

      const parsed = create();
      const parseFailure = captureFailure(() =>
        parseOpenAiResponse(response(), () => parsed.value as never, FIXED_NOW),
      );
      expect(parseFailure).toMatchObject({ code: 'PROVIDER_OUTPUT_INVALID' });
      expect((parseFailure as { cause?: unknown }).cause).toBeUndefined();
      expect(parsed.readCount()).toBe(0);

      const schema = create();
      const buildFailure = captureFailure(() =>
        buildOpenAiResponseBody({
          modelId: 'gpt-5.6',
          blocks: [],
          outputJsonSchema: { type: 'object', hazard: schema.value } as never,
          outputSchemaId: 'lecture_output',
          maxOutputTokens: 128,
        }),
      );
      expect(buildFailure).toMatchObject({ code: 'PROVIDER_EXECUTION_FAILED' });
      expect((buildFailure as { cause?: unknown }).cause).toBeUndefined();
      expect(schema.readCount()).toBe(0);
    },
  );
});
