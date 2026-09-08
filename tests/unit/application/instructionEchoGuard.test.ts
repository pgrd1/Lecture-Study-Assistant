import { describe, expect, it } from 'vitest';
import { assertNoInstructionEcho } from '../../../src/application/prompts/instructionEchoGuard';

describe('private instruction echo boundary', () => {
  it.each(['VIOLET7319', '비공개코드:청록등대', 'secret:fern', 'token=fern', '암호:등대'])(
    'rejects short distinctive echoes, including containment and split fields',
    (instruction) => {
      const escaped = instruction.toLowerCase().split('').join(' \\_ ');
      for (const echo of [instruction, escaped, `Answer: ${escaped} is recorded.`])
        expect(() => assertNoInstructionEcho({ answer: echo }, [instruction])).toThrow(
          'PRIVATE_INSTRUCTION_ECHO',
        );
      expect(() =>
        assertNoInstructionEcho(
          { answer: instruction.slice(0, 3), steps: [instruction.slice(3)] },
          [instruction],
        ),
      ).toThrow('PRIVATE_INSTRUCTION_ECHO');
    },
  );
  it('rejects exact short instruction strings but permits incidental generic prose', () => {
    expect(() =>
      assertNoInstructionEcho({ answer: 'Useful explanation', steps: ['B E brief.'] }, [
        'Be brief.',
      ]),
    ).toThrow('PRIVATE_INSTRUCTION_ECHO');
    expect(() => assertNoInstructionEcho({ answer: 'ＯＫ' }, ['ok'])).toThrow();
    expect(() =>
      assertNoInstructionEcho({ answer: 'Be brief. This is legitimate advice about summaries.' }, [
        'Be brief.',
      ]),
    ).not.toThrow();
  });
  it.each([
    'PRIVATE_SENTINEL_7319',
    'private\\_sentinel\\_7319',
    'P R I V A T E sentinel 7 3 1 9',
    'ＰＲＩＶＡＴＥ＿ＳＥＮＴＩＮＥＬ＿７３１９',
  ])('rejects normalized private text without reflecting it in errors', (echo) => {
    expect(() => assertNoInstructionEcho({ answer: echo }, ['PRIVATE_SENTINEL_7319'])).toThrow(
      'PRIVATE_INSTRUCTION_ECHO',
    );
  });
  it('checks nested fields, field-split echoes and meaningful instruction lines', () => {
    expect(() =>
      assertNoInstructionEcho({ answer: 'STRASSE_PRIVATE_SENTINEL_7319' }, [
        'Straße private sentinel7319',
      ]),
    ).toThrow();
    expect(() =>
      assertNoInstructionEcho({ answer: 'private', steps: ['sentinel7319'] }, [
        'PRIVATE_SENTINEL_7319',
      ]),
    ).toThrow();
    expect(() =>
      assertNoInstructionEcho(
        { provenance: { modelId: 'Hidden rule sentence about private instructions' } },
        ['Heading\nHidden rule sentence about private instructions.\nOther rule'],
      ),
    ).toThrow();
  });
  it('accepts unrelated prose and empty instructions without changing output', () => {
    const value = Object.freeze({
      answer: 'An array stores ordered values.',
      evidenceIds: ['abc'],
    });
    expect(() => assertNoInstructionEcho(value, ['', '  ', 'PRIVATE_SENTINEL_7319'])).not.toThrow();
    expect(value.answer).toBe('An array stores ordered values.');
    expect(() => assertNoInstructionEcho({ answer: null, counts: [1, true] }, [])).not.toThrow();
    expect(() =>
      assertNoInstructionEcho({ answer: 'I will be brief about arrays.' }, ['Be brief.']),
    ).not.toThrow();
  });
  it('rejects unbounded, cyclic and accessor data before evaluating it', () => {
    let reads = 0;
    const getter = Object.defineProperty({}, 'answer', {
      enumerable: true,
      get: () => {
        reads++;
        return 'private';
      },
    });
    const cycle: unknown[] = [];
    cycle.push(cycle);
    for (const value of [getter, cycle])
      expect(() => assertNoInstructionEcho(value, ['private'])).toThrow('PRIVATE_INSTRUCTION_ECHO');
    expect(() => assertNoInstructionEcho({}, Array(129).fill('private'))).toThrow();
    expect(() => assertNoInstructionEcho({}, {} as unknown as string[])).toThrow(
      'PRIVATE_INSTRUCTION_ECHO',
    );
    expect(() => assertNoInstructionEcho({}, ['x'.repeat(512 * 1024 + 1)])).toThrow();
    expect(reads).toBe(0);
  });
});
