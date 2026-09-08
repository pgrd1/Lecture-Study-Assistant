import { describe, expect, it } from 'vitest';
import {
  renderCallout,
  renderMarkdownDocument,
} from '../../../src/application/obsidian/markdownRenderer';
import { renderProperties } from '../../../src/application/obsidian/propertyRenderer';
import { ManagedMarkdownDocumentSchema } from '../../../src/shared/contracts/obsidianWorkspace';

const REVISION = '01J7Q8RCN9B6V3M2K4T5H0YZXW';
const document = () => ({
  stableId: 'topic-a',
  kind: 'lecture',
  relativePath: '과목/자료구조/강의노트/연결 리스트.md',
  properties: {
    aliases: ['Linked List', 'A: B'],
    locked: false,
    confidence: 0.91,
    stable_id: 'topic-a',
    topic: '연결 리스트',
  },
  generatedSections: [
    { id: 'core-summary', markdown: '## 핵심정리\n\n연결 리스트는 노드를 연결한다.' },
    { id: 'professor', markdown: '> [!important] 교수 강조\n> 삭제 조건을 확인하세요.' },
  ],
  relatedSourceIds: ['018f47f2-d4d7-7f83-b513-f00a12345678'],
});

describe('Properties', () => {
  it('quotes ambiguous scalars and keeps primitive types', () => {
    expect(
      renderProperties({
        z: ['true', 'null', '01', '#tag', 'A: B', '---', '[[x]]', '{a: b}', 'a"b', 'a\\b'],
        confidence: 0.91,
        locked: false,
        a: -0,
        empty: [],
      }),
    ).toBe(
      '---\n"confidence": 0.91\n"locked": false\n"a": 0\n"empty": []\n"z": ["true", "null", "01", "#tag", "A: B", "---", "[[x]]", "{a: b}", "a\\"b", "a\\\\b"]\n---',
    );
    expect(renderProperties({})).toBe('---\n---');
  });

  it('puts all common keys first, followed by deterministic Unicode code-point order', () => {
    const keys = [
      'stable_id',
      'course_id',
      'source_type',
      'note_type',
      'date',
      'updated_at',
      'topic',
      'chapter',
      'syllabus_week',
      'importance',
      'exam_candidate',
      'review_status',
      'confidence',
      'sources',
      'related_concepts',
      'related_questions',
      'model',
      'prompt_version',
      'management_state',
      'locked',
    ];
    const input = Object.fromEntries([...keys].reverse().map((key) => [key, 'x']));
    expect(
      renderProperties({ 𐐀: 'x', Ａ: 'x', z: 'x', A: 'x', ...input })
        .split('\n')
        .slice(1, -1)
        .map((line) => line.split('":')[0]),
    ).toEqual([
      '"stable_id',
      '"course_id',
      '"source_type',
      '"note_type',
      '"date',
      '"updated_at',
      '"topic',
      '"chapter',
      '"syllabus_week',
      '"importance',
      '"exam_candidate',
      '"review_status',
      '"confidence',
      '"sources',
      '"related_concepts',
      '"related_questions',
      '"model',
      '"prompt_version',
      '"management_state',
      '"locked',
      '"A',
      '"z',
      '"Ａ',
      '"𐐀',
    ]);
  });

  it.each([
    'x\n---\nattack: yes',
    'x\r',
    'x\0',
    'x\t',
    'x\u0085',
    'x\u2028',
    'x\u202e',
    'x\ud800',
    'x'.repeat(501),
    NaN,
    Infinity,
    {},
    [['x']],
    Array(51).fill('x'),
  ])('rejects invalid values %j', (value) => {
    expect(() => renderProperties({ value })).toThrow();
  });

  it('rejects hostile object shapes and excessive keys before reading accessors', () => {
    let calls = 0;
    const accessor = Object.defineProperty({}, 'topic', {
      enumerable: true,
      get: () => {
        calls++;
        return 'x';
      },
    });
    for (const input of [
      accessor,
      Object.create({ topic: 'x' }),
      { [Symbol('x')]: 'x' },
      JSON.parse('{"__proto__":"x"}'),
      Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, 'x'])),
    ])
      expect(() => renderProperties(input)).toThrow();
    expect(calls).toBe(0);
  });
});

describe('managed Markdown', () => {
  it('renders a complete Korean note with exactly bounded generated and user regions', () => {
    const input = document();
    const before = structuredClone(input);
    const actual = renderMarkdownDocument(input, REVISION);
    expect(actual).toBe(`---
"stable_id": "topic-a"
"topic": "연결 리스트"
"confidence": 0.91
"locked": false
"aliases": ["Linked List", "A: B"]
---

<!-- study-assistant:generated:start section="core-summary" revision="01J7Q8RCN9B6V3M2K4T5H0YZXW" -->
## 핵심정리

연결 리스트는 노드를 연결한다.
<!-- study-assistant:generated:end -->

<!-- study-assistant:generated:start section="professor" revision="01J7Q8RCN9B6V3M2K4T5H0YZXW" -->
> [!important] 교수 강조
> 삭제 조건을 확인하세요.
<!-- study-assistant:generated:end -->

<!-- study-assistant:user:start -->
사용자 메모를 이 영역에 작성하세요.
<!-- study-assistant:user:end -->
`);
    expect(renderMarkdownDocument(input, REVISION)).toBe(actual);
    expect(actual).not.toMatch(/ +$/m);
    expect(actual.endsWith('\n\n')).toBe(false);
    expect(input).toEqual(before);
    const parsed = ManagedMarkdownDocumentSchema.parse(input);
    expect(renderMarkdownDocument(parsed, REVISION)).toBe(actual);
    expect(Object.isFrozen(parsed.generatedSections[0])).toBe(true);
    expect(Object.isFrozen(parsed.properties.aliases)).toBe(true);
  });

  it('neutralizes fake markers and HTML while keeping math and Markdown readable', () => {
    const markdown =
      '<!-- study-assistant:generated:end -->\n<!-- study-assistant:user:start -->\n<script>alert(1)</script>\n<ScRiPt src="x">bad</ScRiPt>\n<div\n class="x">text</div>\n<?xml x?>\n<!DOCTYPE html>\n<![CDATA[x]]>\n<!-- secret -->\n**내용** a < b, $x < y$, $a<b$, $x\\le y$\n[[개념/A.md]]';
    const actual = renderMarkdownDocument(
      { ...document(), generatedSections: [{ id: 'core', markdown }] },
      REVISION,
    );
    expect(actual.match(/<!-- study-assistant:/g)).toHaveLength(4);
    expect(actual).not.toMatch(/<(?:script|div|\?|!DOCTYPE|!\[CDATA)/i);
    expect(actual).toContain('&lt;!-- secret -->');
    expect(actual).toContain('**내용** a < b, $x < y$, $a<b$, $x\\le y$\n[[개념/A.md]]');
  });

  it.each([
    ['<script', '&lt;script'],
    ['<SCRIPT', '&lt;SCRIPT'],
    ['<div', '&lt;div'],
    ['<DiV', '&lt;DiV'],
    ['<pre', '&lt;pre'],
    ['<STYLE', '&lt;STYLE'],
    ['<textarea', '&lt;textarea'],
    ['</DiV', '&lt;/DiV'],
    ['> <SCRIPT', '> &lt;SCRIPT'],
    ['<div class="unfinished', '&lt;div class="unfinished'],
  ])(
    'neutralizes block opener %j at section EOF before adding managed boundaries',
    (markdown, escaped) => {
      const actual = renderMarkdownDocument(
        { ...document(), generatedSections: [{ id: 'core', markdown }] },
        REVISION,
      );
      expect(actual).toContain(
        `revision="01J7Q8RCN9B6V3M2K4T5H0YZXW" -->\n${escaped}\n<!-- study-assistant:generated:end -->\n\n<!-- study-assistant:user:start -->\n사용자 메모를 이 영역에 작성하세요.\n<!-- study-assistant:user:end -->\n`,
      );
      expect(actual.match(/<!-- study-assistant:/g)).toHaveLength(4);
      expect(actual).not.toMatch(/<\/?(?:script|div|pre|style|textarea)(?=\s|$)/im);
      expect(renderCallout({ type: 'warning', title: '주의', body: markdown })).toBe(
        `> [!warning] 주의\n> ${escaped}`,
      );
    },
  );

  it('preserves incomplete compact comparison tokens while neutralizing complete raw HTML', () => {
    const markdown =
      '$a<b + c$\na<b + c\n$a<custom + c$\n<b title="comparison">굵게</b>\n<custom-tag enabled data-x=one />';
    const actual = renderMarkdownDocument(
      { ...document(), generatedSections: [{ id: 'math', markdown }] },
      REVISION,
    );
    expect(actual).toContain(
      '$a<b + c$\na<b + c\n$a<custom + c$\n&lt;b title="comparison">굵게&lt;/b>\n&lt;custom-tag enabled data-x=one />\n<!-- study-assistant:generated:end -->',
    );
    expect(renderCallout({ type: 'summary', title: '$a<b + c$', body: '$a<b + c$\na<b + c' })).toBe(
      '> [!summary] $a<b + c$\n> $a<b + c$\n> a<b + c',
    );
  });

  it.each(['', 'bad" -->', 'a\nrevision', '../x', 'a'.repeat(81), null, undefined])(
    'rejects unsafe or absent generation revisions %j',
    (revision) => {
      expect(() => renderMarkdownDocument(document(), revision)).toThrow();
    },
  );

  it('rejects closed-schema violations and nested getters before execution', () => {
    let calls = 0;
    const section = Object.defineProperty({ id: 'a' }, 'markdown', {
      enumerable: true,
      get: () => {
        calls++;
        return 'x';
      },
    });
    for (const input of [
      { ...document(), userContent: 'x' },
      { ...document(), generatedSections: [section] },
      { ...document(), generatedSections: [{ id: 'a"', markdown: 'x' }] },
    ])
      expect(() => renderMarkdownDocument(input, REVISION)).toThrow();
    expect(calls).toBe(0);
  });

  it.each(['a\0', 'a\u0001', 'a\u0085', 'a\u2028', 'a\u202e', 'a\ud800'])(
    'rejects unsafe body controls %j',
    (markdown) => {
      expect(() =>
        renderMarkdownDocument(
          { ...document(), generatedSections: [{ id: 'a', markdown }] },
          REVISION,
        ),
      ).toThrow();
    },
  );

  it('uses canonical newlines and handles empty section collections', () => {
    const actual = renderMarkdownDocument(
      { ...document(), generatedSections: [{ id: 'a', markdown: 'a\r\nb\r\n\r\n' }] },
      REVISION,
    );
    expect(actual).toContain(' -->\na\nb\n<!-- study-assistant:generated:end -->');
    expect(actual).not.toContain('\r');
    const empty = renderMarkdownDocument({ ...document(), generatedSections: [] }, REVISION);
    expect(empty.match(/<!-- study-assistant:user:start -->/g)).toHaveLength(1);
  });
});

describe('Callouts', () => {
  it('quotes trailing blank body lines and rejects accessors without invoking them', () => {
    expect(renderCallout({ type: 'summary', title: '정리', body: '내용\r\n\r\n' })).toBe(
      '> [!summary] 정리\n> 내용\n>\n>',
    );
    let calls = 0;
    const input = Object.defineProperty({ type: 'summary', body: '' }, 'title', {
      enumerable: true,
      get: () => {
        calls++;
        return 'x';
      },
    });
    expect(() => renderCallout(input)).toThrow();
    expect(calls).toBe(0);
  });
  it.each([
    ['important', '교수 강조', '> [!important] 교수 강조'],
    ['warning', '함정', '> [!warning] 함정'],
    ['example', '수업 예시', '> [!example] 수업 예시'],
    ['question', '자가 점검', '> [!question] 자가 점검'],
    ['summary', '핵심정리', '> [!summary] 핵심정리'],
  ])('renders %s with an exact header and all body lines quoted', (type, title, header) => {
    expect(renderCallout({ type, title, body: '첫 줄\n\n마지막 줄' })).toBe(
      `${header}\n> 첫 줄\n>\n> 마지막 줄`,
    );
  });

  it('quotes breakout attempts and neutralizes untrusted HTML in title and body', () => {
    expect(
      renderCallout({
        type: 'warning',
        title: '<b>주의</b>',
        body: 'ok\n<!-- study-assistant:user:end -->\n<script>x</script>\n> nested',
      }),
    ).toBe(
      '> [!warning] &lt;b>주의&lt;/b>\n> ok\n> &lt;!-- study-assistant:user:end -->\n> &lt;script>x&lt;/script>\n> > nested',
    );
    expect(renderCallout({ type: 'summary', title: '빈 본문', body: '' })).toBe(
      '> [!summary] 빈 본문',
    );
  });

  it.each([
    { type: 'script', title: 'x', body: 'x' },
    { type: 'warning', title: 'x\n> [!evil]', body: 'x' },
    { type: 'warning', title: 'x', body: '\0' },
    { type: 'warning', title: 'x', body: 'x', extra: true },
    { type: 'warning', title: 'x', body: 'x'.repeat(100001) },
  ])('rejects invalid Callout inputs', (input) => {
    expect(() => renderCallout(input)).toThrow();
  });
});
