import { describe, expect, it } from 'vitest';
import { renderCourseBase } from '../../../src/application/obsidian/baseRenderer';

const course = {
  stableId: 'course-base',
  kind: 'base',
  relativePath: '과목/자료구조/자료구조.base',
  courseId: '018f47f2-d4d7-7f83-b513-f00a12345678',
  views: [
    {
      id: 'recent-lectures',
      name: '최근 강의',
      type: 'table',
      noteKinds: ['lecture'],
      properties: ['topic', 'updated_at'],
    },
  ],
};
const fixture = () => ({ ...course, views: [{ ...course.views[0] }] });

describe('Base renderer', () => {
  it('emits literal course YAML with exact course and lecture-folder scope', () => {
    expect(renderCourseBase(fixture())).toBe(`filters:
  and:
    - 'file.inFolder("AI 학습/과목/자료구조")'
    - 'course_id == "018f47f2-d4d7-7f83-b513-f00a12345678"'
views:
  - type: 'table'
    name: '최근 강의'
    filters:
      and:
        - '(note_type == "lecture")'
        - 'file.inFolder("AI 학습/과목/자료구조/강의노트")'
    order:
      - 'topic'
      - 'updated_at'
    sort:
      - property: 'updated_at'
        direction: 'DESC'
    limit: 20
`);
  });

  it('emits literal global YAML restricted to the managed course tree', () => {
    expect(
      renderCourseBase({
        ...fixture(),
        courseId: null,
        relativePath: '학습 대시보드.base',
        views: [
          {
            id: 'generic',
            name: '질문',
            type: 'list',
            noteKinds: ['question_inbox'],
            properties: ['topic'],
          },
        ],
      }),
    ).toBe(`filters:
  and:
    - 'file.inFolder("AI 학습/과목")'
views:
  - type: 'list'
    name: '질문'
    filters:
      and:
        - '(note_type == "question_inbox")'
    order:
      - 'topic'
`);
  });

  it.each([
    [
      'recent-lectures',
      'file.inFolder("AI 학습/과목/자료구조/강의노트")',
      'updated_at',
      'DESC',
      20,
    ],
    [
      'attention-needed',
      '(review_status == "processing" || review_status == "failed" || review_status == "needs_review")',
      'updated_at',
      'DESC',
      null,
    ],
    ['exam-candidates', 'exam_candidate == true', 'importance', 'DESC', null],
    [
      'question-counts',
      '(note_type == "question_bank" || note_type == "question_inbox")',
      'updated_at',
      'DESC',
      null,
    ],
    [
      'latest-exam-packages',
      'file.inFolder("AI 학습/과목/자료구조/시험")',
      'updated_at',
      'DESC',
      5,
    ],
  ])('uses fixed built-in semantics for %s', (id, filter, property, direction, limit) => {
    for (const global of [false, true]) {
      const output = renderCourseBase({
        ...fixture(),
        ...(global ? { courseId: null, relativePath: '학습 대시보드.base' } : {}),
        views: [
          {
            id,
            name: '보기',
            type: 'cards',
            noteKinds: ['question_inbox', 'question_bank'],
            properties: ['related_questions', 'topic'],
          },
        ],
      });
      expect(output).toContain(
        `- '(note_type == "question_bank" || note_type == "question_inbox")'`,
      );
      if (!global || (id !== 'recent-lectures' && id !== 'latest-exam-packages'))
        expect(output).toContain(`- '${filter}'`);
      if (global && id === 'recent-lectures')
        expect(output).toContain(`        - 'note_type == "lecture"'\n`);
      if (global && id === 'latest-exam-packages')
        expect(output).toContain(`        - 'file.path.contains("/시험/")'\n`);
      expect(output).toContain(`    order:\n      - 'related_questions'\n      - 'topic'\n`);
      expect(output).toContain(
        `    sort:\n      - property: '${property}'\n        direction: '${direction}'\n`,
      );
      if (limit !== null) expect(output).toContain(`    limit: ${limit}\n`);
    }
  });

  it('quotes display names, paths and property names without interpreting them', () => {
    const output = renderCourseBase({
      ...fixture(),
      relativePath: "과목/O'Brien [x] # yes/a.base",
      views: [
        {
          id: 'generic',
          type: 'table',
          name: `a' : # ["filters:"]`,
          noteKinds: ['lecture'],
          properties: ['yes', 'null'],
        },
      ],
    });
    expect(output).toContain(`    name: 'a'' : # ["filters:"]'\n`);
    expect(output).toContain(`- 'file.inFolder("AI 학습/과목/O''Brien [x] # yes")'`);
    expect(output.match(/^filters:/gmu)).toHaveLength(1);
    expect(output).not.toContain('sort:');
  });

  it('does not mutate inputs and sorts semantic sets without changing property order', () => {
    const input = fixture();
    const before = JSON.stringify(input);
    const output = renderCourseBase(input);
    expect(renderCourseBase(input)).toBe(output);
    expect(JSON.stringify(input)).toBe(before);
    expect(output.endsWith('\n\n')).toBe(false);
  });

  it.each([
    { relativePath: 'private/data.base' },
    { relativePath: '과목/a.base' },
    { courseId: null },
    { relativePath: '../escape.base' },
    { views: [{ ...fixture().views[0], filters: 'true' }] },
    { views: [{ ...fixture().views[0], name: 'x\nfilters: true' }] },
    { views: [{ ...fixture().views[0], name: '\ud800' }] },
    { views: [{ ...fixture().views[0], name: '\uffff' }] },
    { relativePath: '과목/이름\ufffe/a.base' },
    { views: [{ ...fixture().views[0], type: 'dataview' }] },
  ])('rejects invalid scope or executable input %#', (change) => {
    expect(() => renderCourseBase({ ...fixture(), ...change })).toThrow();
  });

  it('rejects getters without executing them', () => {
    let reads = 0;
    const input = Object.defineProperty({}, 'views', {
      enumerable: true,
      get: () => {
        reads++;
        return [];
      },
    });
    expect(() => renderCourseBase(input)).toThrow();
    expect(reads).toBe(0);
  });
});
