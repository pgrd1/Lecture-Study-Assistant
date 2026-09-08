import { describe, expect, it } from 'vitest';
import { threeWayMarkdownMerge } from '../../../src/application/obsidian/threeWayMarkdownMerge';

const START = '<!-- study-assistant:user:start -->';
const END = '<!-- study-assistant:user:end -->';
const BASE = `---\n"locked": false\n---\n\n<!-- study-assistant:generated:start section="summary" revision="r1" -->\nOld\n<!-- study-assistant:generated:end -->\n\n${START}\nnotes\n${END}\n`;
const NEXT = BASE.replace('Old', 'New').replace('revision="r1"', 'revision="r2"');

describe('exact managed Markdown merge', () => {
  it('updates untouched content and detects byte-identical no-op', () => {
    expect(threeWayMarkdownMerge({ base: BASE, current: BASE, candidate: NEXT })).toEqual({
      kind: 'write',
      mergedContent: NEXT,
    });
    expect(threeWayMarkdownMerge({ base: BASE, current: BASE, candidate: BASE })).toEqual({
      kind: 'unchanged',
    });
  });

  it.each(['', '\n', '\nmy notes  \n\n', '\r\n한글\t \r\n', 'inline\rcontent  '])(
    'preserves exact user interior %j',
    (user) => {
      const current = BASE.replace('\nnotes\n', user);
      expect(threeWayMarkdownMerge({ base: BASE, current, candidate: NEXT })).toEqual({
        kind: 'write',
        mergedContent: NEXT.replace('\nnotes\n', user),
      });
      expect(threeWayMarkdownMerge({ base: BASE, current, candidate: BASE })).toEqual({
        kind: 'unchanged',
      });
    },
  );

  it.each([
    BASE.replace('Old', 'User edit'),
    BASE.replace('false', 'true'),
    BASE.replace(START, ''),
    BASE.replace(END, START),
    BASE.replace(START, `${START}${START}`),
    BASE.replace('generated:end', 'generated:start'),
    BASE.replace('Old', '<!-- study-assistant:generated:start section="nested" revision="r1" -->'),
    BASE.replace('Old', '<!-- study-assistant:fake -->'),
    BASE.replace('Old', '<!-- STUDY-ASSISTANT:user:start -->'),
    BASE.replace(START, 'SWAP').replace(END, START).replace('SWAP', END),
    BASE.replace('section="summary"', 'section="summary" evil="x"'),
  ])('conflicts on generated edits or ambiguous grammar', (current) => {
    expect(threeWayMarkdownMerge({ base: BASE, current, candidate: NEXT }).kind).toBe('conflict');
  });

  it('never unlocks a locked base implicitly', () => {
    const locked = BASE.replace('false', 'true');
    expect(threeWayMarkdownMerge({ base: locked, current: locked, candidate: locked })).toEqual({
      kind: 'unchanged',
    });
    expect(threeWayMarkdownMerge({ base: locked, current: locked, candidate: NEXT })).toEqual({
      kind: 'conflict',
      reason: 'locked',
    });
  });

  it.each(['base', 'candidate'] as const)(
    'rejects malformed %s even if other bytes match',
    (key) => {
      expect(
        threeWayMarkdownMerge({
          base: BASE,
          current: BASE,
          candidate: BASE,
          [key]: BASE.replace(END, ''),
        }).kind,
      ).toBe('conflict');
    },
  );

  it('preflights hostile input without invoking accessors and freezes output', () => {
    let reads = 0;
    const accessor = {
      base: BASE,
      current: BASE,
      get candidate() {
        reads++;
        return BASE;
      },
    };
    for (const input of [
      accessor,
      Object.assign(Object.create({ inherited: true }), {
        base: BASE,
        current: BASE,
        candidate: BASE,
      }),
      { base: BASE, current: BASE, candidate: BASE, excess: true },
      { base: BASE, current: BASE, candidate: '가'.repeat(6_000_000) },
    ]) {
      expect(() => threeWayMarkdownMerge(input)).toThrow();
    }
    expect(reads).toBe(0);
    const input = Object.freeze({ base: BASE, current: BASE, candidate: NEXT });
    expect(Object.isFrozen(threeWayMarkdownMerge(input))).toBe(true);
    expect(input.candidate).toBe(NEXT);
  });

  it('preserves current user bytes even when the current base is untouched', () => {
    const candidate = NEXT.replace('\nnotes\n', '\nnew default\n');
    expect(threeWayMarkdownMerge({ base: BASE, current: BASE, candidate })).toEqual({
      kind: 'write',
      mergedContent: NEXT,
    });
  });

  it('rejects inline injected generated markers in the candidate', () => {
    const candidate = NEXT.replace(
      '<!-- study-assistant:generated:start',
      'prefix <!-- study-assistant:generated:start',
    );
    expect(threeWayMarkdownMerge({ base: BASE, current: BASE, candidate })).toEqual({
      kind: 'conflict',
      reason: 'malformed_markers',
    });
  });

  it('rejects an unterminated comment inside the editable interval', () => {
    const current = BASE.replace('\nnotes\n', '\n<!-- incomplete comment\n');
    expect(threeWayMarkdownMerge({ base: BASE, current, candidate: NEXT })).toEqual({
      kind: 'conflict',
      reason: 'malformed_markers',
    });
  });

  it('rejects generated marker pairs nested inside the editable interval', () => {
    const current = BASE.replace(
      '\nnotes\n',
      '\n<!-- study-assistant:generated:start section="fake" revision="r1" -->\n<!-- study-assistant:generated:end -->\n',
    );
    expect(threeWayMarkdownMerge({ base: BASE, current, candidate: NEXT }).kind).toBe('conflict');
  });

  it('accepts renderer output with empty frontmatter and zero generated sections', () => {
    const base = `---\n---\n\n${START}\nnotes\n${END}\n`;
    expect(threeWayMarkdownMerge({ base, current: base, candidate: base })).toEqual({
      kind: 'unchanged',
    });
    const current = base.replace('\nnotes\n', '\rmy edit\r');
    expect(threeWayMarkdownMerge({ base, current, candidate: base })).toEqual({
      kind: 'unchanged',
    });
  });
});
