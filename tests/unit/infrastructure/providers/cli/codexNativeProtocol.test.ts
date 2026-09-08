import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildCodexFeatureListArgs,
  buildCodexMainArgs,
  parseCodexExecHelp,
  parseCodexFeatureList,
  parseCodexJsonl,
} from '../../../../../src/infrastructure/providers/cli/codexCliProtocol';

// Source: rust-v0.146.0 exec_events.rs and installed 0.146.0 exec --help.
const stream = (
  usage: unknown = {
    input_tokens: 3,
    cached_input_tokens: 1,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 1,
  },
) =>
  `${[
    { type: 'thread.started', thread_id: '223e4567-e89b-42d3-a456-426614174000' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '{"ok":true}' } },
    { type: 'turn.completed', usage },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n')}\n`;

describe('pinned native Codex protocol', () => {
  it('accepts all 100 pinned registry rows including removed and benign default-enabled features', () => {
    const fixture = readFileSync(
      new URL('../../../../fixtures/codex-0.146-features.txt', import.meta.url),
      'utf8',
    );
    expect(parseCodexFeatureList(fixture)).toHaveLength(100);
    expect(() =>
      parseCodexFeatureList(
        fixture.replace(
          'external_agent_memory_import under development false',
          'external_agent_memory_import under development true',
        ),
      ),
    ).toThrow();
    expect(() => parseCodexFeatureList(`${fixture}unknown_hook stable false\n`)).toThrow();
  });
  it('accepts the installed pinned help fixture and fails closed if native attachment support disappears', () => {
    const help = readFileSync(
      new URL('../../../../fixtures/codex-0.146-exec-help.txt', import.meta.url),
      'utf8',
    );
    expect(parseCodexExecHelp(help)).toContain('image');
    expect(() =>
      parseCodexExecHelp(
        help.replace(
          '  -i, --image <FILE>...\n          Optional image(s) to attach to the initial prompt\n',
          '',
        ),
      ),
    ).toThrow();
  });
  it('accepts genuine events without manufacturing reported model evidence or double counting usage', () => {
    expect(parseCodexJsonl(stream(), () => ({ ok: true }))).toEqual({
      output: { ok: true },
      reportedModelId: null,
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    });
  });
  it('accepts the pinned second usage line, variadic image option and reviewed hook trust help without enabling it', () => {
    const flags = parseCodexExecHelp(
      [
        'Run Codex non-interactively',
        '',
        'Usage: codex exec [OPTIONS] [PROMPT]',
        '       codex exec [OPTIONS] <COMMAND> [ARGS]',
        '',
        'Options:',
        '  -c, --config <key=value>',
        '          ',
        ...[
          'strict-config',
          'ignore-user-config',
          'ignore-rules',
          'ephemeral',
          'sandbox',
          'skip-git-repo-check',
          'json',
          'cd',
          'output-schema',
          'color',
          'disable',
          'dangerously-bypass-hook-trust',
        ].map((flag) => `      --${flag}`),
        '  -i, --image <FILE>...',
        '  -m, --model <MODEL>',
      ].join('\n'),
    );
    expect(flags).toContain('image');
    expect(buildCodexMainArgs('C:\\private\\workspace', 'C:\\private\\schema')).not.toContain(
      '--dangerously-bypass-hook-trust',
    );
  });
  it('uses only supported root flags for offline feature discovery', () => {
    const args = buildCodexFeatureListArgs();
    expect(args).not.toContain('--strict-config');
    expect(args).not.toContain('--ignore-user-config');
    expect(args).not.toContain('--ignore-rules');
    expect(args.slice(-2)).toEqual(['features', 'list']);
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid additional usage counters %s',
    (count) => {
      expect(() =>
        parseCodexJsonl(
          stream({
            input_tokens: 3,
            cached_input_tokens: 1,
            cache_write_input_tokens: count,
            output_tokens: 2,
            reasoning_output_tokens: 1,
          }),
          () => ({ ok: true }),
        ),
      ).toThrow();
    },
  );
});
