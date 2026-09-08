import { describe, expect, it } from 'vitest';
import {
  renderEvidenceCitations,
  renderObsidianEmbed,
  renderObsidianLink,
} from '../../../src/application/obsidian/obsidianLink';

const EVIDENCE = '018f47f2-d4d7-7f83-b513-f00a12345678';
const citation = () => ({
  label: '강의 1, 12쪽',
  relativePath: '원본자료/문서/강의 1.pdf',
  evidenceId: EVIDENCE,
});

describe('Obsidian links and embeds', () => {
  it('preserves exact human-readable paths and aliases', () => {
    expect(renderObsidianLink('개념/연결 리스트.md')).toBe('[[AI 학습/개념/연결 리스트.md]]');
    expect(renderObsidianLink('개념/연결 리스트.md', '연결 리스트')).toBe(
      '[[AI 학습/개념/연결 리스트.md|연결 리스트]]',
    );
    expect(renderObsidianEmbed('원본자료/이미지/문제 1.jpg')).toBe(
      '![[AI 학습/원본자료/이미지/문제 1.jpg]]',
    );
  });

  it.each([
    '',
    'AI 학습/a.md',
    'AI 학습/AI 학습/a.md',
    '/a.md',
    'C:/a.md',
    'C:a.md',
    '\\\\host\\a.md',
    '//host/a.md',
    'file:///a.md',
    'https://host/a.md',
    '../a.md',
    'x/../a.md',
    'a\\b.md',
    'a//b.md',
    'CON.md',
    'a.html',
    'a\0.md',
    'a\n.md',
    'a\u202e.md',
    'a\ud800.md',
    'a%23b.md',
    'a#b.md',
    'a^b.md',
    'a[b].md',
    'a|b.md',
    'a.md#heading',
    'a.md ',
    ' a.md',
    'x/ a.md',
    `${'a'.repeat(256)}.md`,
  ])('rejects unsafe or ambiguous targets %j without changing filenames', (target) => {
    expect(() => renderObsidianLink(target)).toThrow();
    expect(() => renderObsidianEmbed(target)).toThrow();
  });

  it.each([
    '',
    'a|b',
    'a[b]',
    'a]b',
    'a\\b',
    '#heading',
    '^block',
    'a\ntext',
    'a\rtext',
    'a\0',
    'a\u0085',
    '<script>',
    'a'.repeat(501),
  ])('rejects unsafe aliases %j', (alias) => {
    expect(() => renderObsidianLink('a.md', alias)).toThrow();
  });

  it('rejects objects before coercion or accessor evaluation', () => {
    let calls = 0;
    const target = {
      toString: () => {
        calls++;
        return 'a.md';
      },
    };
    expect(() => renderObsidianLink(target)).toThrow();
    expect(calls).toBe(0);
  });
});

describe('evidence citations', () => {
  it('renders ordered labels and canonical stable evidence IDs', () => {
    const input = Object.freeze([
      Object.freeze(citation()),
      Object.freeze({
        label: '개념',
        relativePath: '개념/A.md',
        evidenceId: '018f47f2-d4d7-7f83-b513-f00a12345679',
      }),
    ]);
    expect(renderEvidenceCitations(input)).toBe(
      '- [[AI 학습/원본자료/문서/강의 1.pdf|강의 1, 12쪽]] — 근거: `018f47f2-d4d7-7f83-b513-f00a12345678`\n- [[AI 학습/개념/A.md|개념]] — 근거: `018f47f2-d4d7-7f83-b513-f00a12345679`',
    );
    expect(renderEvidenceCitations([])).toBe('');
    expect(
      renderEvidenceCitations([{ ...citation(), evidenceId: EVIDENCE.toUpperCase() }]),
    ).toContain(EVIDENCE);
  });

  it.each(
    [
      [citation(), citation()],
      [citation(), { ...citation(), evidenceId: EVIDENCE.toUpperCase(), relativePath: 'other.md' }],
      [{ label: 'missing', relativePath: 'a.md' }],
      [{ ...citation(), relativePath: 'C:/private.md' }],
      [{ ...citation(), extra: true }],
      [{ ...citation(), label: 'a]]\n<script>' }],
      Array.from({ length: 1001 }, () => citation()),
    ].map((input) => [input]),
  )('rejects incomplete, conflicting, unsafe or unbounded provenance %j', (input) => {
    expect(() => renderEvidenceCitations(input)).toThrow();
  });

  it('rejects nested accessors, prototypes, sparse arrays and cycles without invoking getters', () => {
    let calls = 0;
    const accessor = Object.defineProperty(citation(), 'label', {
      enumerable: true,
      get: () => {
        calls++;
        return 'x';
      },
    });
    const cycle: unknown[] = [];
    cycle.push(cycle);
    for (const input of [
      [accessor],
      [Object.create(citation())],
      new Array(1),
      [Symbol('x')],
      cycle,
    ]) {
      expect(() => renderEvidenceCitations(input)).toThrow();
    }
    expect(calls).toBe(0);
  });
});
