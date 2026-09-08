import { describe, expect, it } from 'vitest';
import {
  GeneratedSectionSchema,
  JsonCanvasDocumentSchema,
  ManagedMarkdownDocumentSchema,
  ObsidianBaseDocumentSchema,
  ObsidianPropertiesSchema,
  SvgArtifactDocumentSchema,
  VaultRelativePathSchema,
  WorkspaceProjectionSchema,
} from '../../../src/shared/contracts/obsidianWorkspace';

const COURSE = '018f47f2-d4d7-7f83-b513-f00a12345678';
const SOURCE = '018f47f2-d4d7-7f83-b513-f00a12345679';
const note = (stableId = 'topic-a', relativePath = '과목/자료구조/강의노트/A.md') => ({
  stableId,
  kind: 'lecture',
  relativePath,
  properties: { title: '연결 리스트', aliases: ['Linked List'], confidence: 0.9, locked: false },
  generatedSections: [{ id: 'core-summary', markdown: '정의\n\n긴 설명' }],
  relatedSourceIds: [SOURCE],
});
const base = () => ({
  stableId: 'dashboard-base',
  kind: 'base',
  relativePath: '학습 대시보드.base',
  courseId: null,
  views: [
    {
      id: 'recent',
      name: '최근 강의노트',
      type: 'table',
      noteKinds: ['lecture'],
      properties: ['title', 'confidence'],
    },
  ],
});
const graph = () => ({
  nodes: [
    {
      id: 'a',
      type: 'file',
      file: '과목/자료구조/자료구조.md',
      x: 0,
      y: 0,
      width: 300,
      height: 200,
    },
  ],
  edges: [],
});
const projection = () => ({
  courseId: COURSE,
  courseRoot: '과목/자료구조',
  dashboard: { ...note('dashboard', '학습 대시보드.md'), kind: 'dashboard' },
  dashboardBase: base(),
  courseMain: { ...note('course', '과목/자료구조/자료구조.md'), kind: 'course' },
  notes: [note()],
  artifacts: [],
});

describe('Obsidian workspace contracts', () => {
  it.each(['aac', 'pptx', 'heic'])(
    'accepts the supported intake attachment extension .%s',
    (extension) => {
      expect(VaultRelativePathSchema.parse(`과목/자료구조/원본자료/source.${extension}`)).toBe(
        `과목/자료구조/원본자료/source.${extension}`,
      );
    },
  );
  it('validates bounded documents separately when their aggregate exceeds 16 MiB', () => {
    const input = {
      ...projection(),
      notes: Array.from({ length: 2 }, (_, index) => ({
        ...note(`large_${index}`, `과목/자료구조/강의노트/large-${index}.md`),
        generatedSections: Array.from({ length: 90 }, (_, section) => ({
          id: `section_${section}`,
          markdown: 'a'.repeat(100_000),
        })),
      })),
    };
    expect(WorkspaceProjectionSchema.safeParse(input).success).toBe(true);
  });
  it('accepts bounded data and returns fresh deeply readonly values', () => {
    const input = projection();
    const parsed = WorkspaceProjectionSchema.parse(input);
    input.notes[0]?.properties.aliases.push('changed');
    input.notes.push(note('other'));
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.notes[0]?.properties.aliases).toEqual(['Linked List']);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.notes)).toBe(true);
    expect(Object.isFrozen(parsed.notes[0]?.generatedSections[0])).toBe(true);
    expect(Object.isFrozen(parsed.notes[0]?.properties.aliases)).toBe(true);
  });

  it('preflights partitioned roots and array descriptors while retaining document and count caps', () => {
    let calls = 0;
    const getter = () => {
      calls++;
      return note();
    };
    const root = Object.defineProperty(projection(), 'courseMain', {
      enumerable: true,
      get: getter,
    });
    const notes = Object.defineProperty([note()], '0', { enumerable: true, get: getter });
    for (const input of [
      root,
      { ...projection(), notes },
      { ...projection(), notes: Array(5001).fill(null) },
      {
        ...projection(),
        notes: [
          {
            ...note(),
            generatedSections: Array.from({ length: 80 }, (_, index) => ({
              id: `s_${index}`,
              markdown: '강'.repeat(80_000),
            })),
          },
        ],
      },
    ])
      expect(WorkspaceProjectionSchema.safeParse(input).success).toBe(false);
    expect(calls).toBe(0);
  });

  it.each([
    '/a.md',
    'C:/a.md',
    'C:a.md',
    '\\\\server\\a.md',
    '//server/a.md',
    'file:///a.md',
    '../a.md',
    'a/../b.md',
    './a.md',
    'a//b.md',
    'a\\b.md',
    'a/./b.md',
    'a\u0000.md',
    'a\u0085.md',
    'a./b.md',
    'a /b.md',
    'a.md ',
    'a.md:stream',
    '//?/C:/a.md',
    'CON.md',
    'a/AUX.txt',
    'a\u202e.md',
    'a\ud800.md',
  ])('rejects unsafe Vault-relative paths %j', (relativePath) => {
    expect(VaultRelativePathSchema.safeParse(relativePath).success).toBe(false);
    expect(ManagedMarkdownDocumentSchema.safeParse({ ...note(), relativePath }).success).toBe(
      false,
    );
  });

  it('rejects unsupported extensions and kind mismatches', () => {
    expect(VaultRelativePathSchema.safeParse('safe.exe').success).toBe(false);
    expect(
      ManagedMarkdownDocumentSchema.safeParse({ ...note(), relativePath: 'safe.canvas' }).success,
    ).toBe(false);
    expect(ManagedMarkdownDocumentSchema.safeParse({ ...note(), kind: 'script' }).success).toBe(
      false,
    );
    expect(
      ObsidianBaseDocumentSchema.safeParse({ ...base(), relativePath: 'safe.md' }).success,
    ).toBe(false);
    expect(
      JsonCanvasDocumentSchema.safeParse({
        stableId: 'c',
        kind: 'canvas',
        relativePath: 'a.svg',
        ...graph(),
      }).success,
    ).toBe(false);
    expect(
      SvgArtifactDocumentSchema.safeParse({
        stableId: 's',
        kind: 'svg',
        relativePath: 'a.html',
        ...graph(),
      }).success,
    ).toBe(false);
  });

  it.each([
    NaN,
    Infinity,
    -Infinity,
    { nested: true },
    [['nested']],
    'a'.repeat(501),
    ['a'.repeat(501)],
    Array(51).fill('x'),
  ])('rejects invalid or unbounded Properties values %j', (value) => {
    expect(ObsidianPropertiesSchema.safeParse({ value }).success).toBe(false);
  });

  it('rejects accessors without invoking them, prototypes, symbols and excess keys', () => {
    let calls = 0;
    const accessor = Object.defineProperty({}, 'title', {
      enumerable: true,
      get: () => {
        calls++;
        return 'x';
      },
    });
    expect(ObsidianPropertiesSchema.safeParse(accessor).success).toBe(false);
    expect(calls).toBe(0);
    expect(ObsidianPropertiesSchema.safeParse(Object.create({ title: 'x' })).success).toBe(false);
    expect(ObsidianPropertiesSchema.safeParse({ [Symbol('x')]: 'x' }).success).toBe(false);
    expect(ObsidianPropertiesSchema.safeParse(JSON.parse('{"__proto__":"x"}')).success).toBe(false);
    expect(ManagedMarkdownDocumentSchema.safeParse({ ...note(), extra: true }).success).toBe(false);
    expect(GeneratedSectionSchema.safeParse({ id: 'a', markdown: 'x', extra: true }).success).toBe(
      false,
    );
    expect(
      ManagedMarkdownDocumentSchema.safeParse(
        Object.assign(Object.create({ inherited: true }), note()),
      ).success,
    ).toBe(false);
  });

  it('bounds sections, Properties count, paths and source references', () => {
    expect(
      GeneratedSectionSchema.safeParse({ id: 'a', markdown: 'x'.repeat(100_001) }).success,
    ).toBe(false);
    expect(GeneratedSectionSchema.safeParse({ id: 'bad"marker', markdown: 'x' }).success).toBe(
      false,
    );
    expect(
      ObsidianPropertiesSchema.safeParse(
        Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, 'x'])),
      ).success,
    ).toBe(false);
    expect(
      ManagedMarkdownDocumentSchema.safeParse({
        ...note(),
        relatedSourceIds: [SOURCE, SOURCE.toUpperCase()],
      }).success,
    ).toBe(false);
    expect(
      ManagedMarkdownDocumentSchema.safeParse({ ...note(), relatedSourceIds: ['not-a-uuid'] })
        .success,
    ).toBe(false);
    expect(
      ManagedMarkdownDocumentSchema.safeParse({
        ...note(),
        generatedSections: [
          { id: 'a', markdown: '' },
          { id: 'a', markdown: '' },
        ],
      }).success,
    ).toBe(false);
    expect(VaultRelativePathSchema.safeParse(`${'a'.repeat(256)}.md`).success).toBe(false);
  });

  it('rejects duplicate stable IDs and normalized case-insensitive paths globally', () => {
    expect(
      WorkspaceProjectionSchema.safeParse({
        ...projection(),
        notes: [note('a', '과목/자료구조/개념/Σ.md'), note('b', '과목/자료구조/개념/ς.md')],
      }).success,
    ).toBe(false);
    expect(
      WorkspaceProjectionSchema.safeParse({ ...projection(), notes: [note('course')] }).success,
    ).toBe(false);
    expect(
      WorkspaceProjectionSchema.safeParse({
        ...projection(),
        notes: [
          note('a', '과목/자료구조/개념/Café.md'),
          note('b', '과목/자료구조/개념/CAFE\u0301.md'),
        ],
      }).success,
    ).toBe(false);
    expect(
      WorkspaceProjectionSchema.safeParse({
        ...projection(),
        artifacts: [{ ...base(), relativePath: '과목/자료구조/a.base', courseId: COURSE }],
      }).success,
    ).toBe(false);
  });

  it('rejects a compact suffix collision while retaining distinct full UUID identities', () => {
    const first = note(COURSE, '과목/자료구조/강의노트/A--topic_b513f00a12345678.md');
    const second = note(
      '018f47f3-d4d7-7f83-b513-f00a12345678',
      '과목/자료구조/강의노트/A--topic_b513f00a12345678.md',
    );
    expect(ManagedMarkdownDocumentSchema.parse(first).stableId).toBe(COURSE);
    expect(ManagedMarkdownDocumentSchema.parse(second).stableId).toBe(
      '018f47f3-d4d7-7f83-b513-f00a12345678',
    );
    expect(
      WorkspaceProjectionSchema.safeParse({ ...projection(), notes: [first, second] }).success,
    ).toBe(false);
  });

  it('rejects course-root escapes and incorrectly declared global/course documents', () => {
    for (const relativePath of ['과목/다른과목/A.md', '과목/자료구조2/A.md', 'A.md']) {
      expect(
        WorkspaceProjectionSchema.safeParse({ ...projection(), notes: [note('a', relativePath)] })
          .success,
      ).toBe(false);
    }
    expect(
      WorkspaceProjectionSchema.safeParse({ ...projection(), courseRoot: '다른곳/자료구조' })
        .success,
    ).toBe(false);
    expect(
      WorkspaceProjectionSchema.safeParse({ ...projection(), dashboard: note('dashboard') })
        .success,
    ).toBe(false);
    expect(
      WorkspaceProjectionSchema.safeParse({
        ...projection(),
        notes: [{ ...note(), kind: 'dashboard' }],
      }).success,
    ).toBe(false);
    expect(
      WorkspaceProjectionSchema.safeParse({
        ...projection(),
        artifacts: [
          { ...base(), stableId: 'b', relativePath: '과목/자료구조/a.base', courseId: SOURCE },
        ],
      }).success,
    ).toBe(false);
  });

  it('accepts closed structured artifacts and validates graph references and local file targets', () => {
    const canvas = {
      stableId: 'canvas',
      kind: 'canvas',
      relativePath: '과목/자료구조/마인드맵/과목 전체.canvas',
      ...graph(),
    };
    expect(JsonCanvasDocumentSchema.safeParse(canvas).success).toBe(true);
    expect(
      SvgArtifactDocumentSchema.safeParse({
        ...canvas,
        stableId: 'svg',
        kind: 'svg',
        relativePath: '과목/자료구조/마인드맵/과목 전체.svg',
      }).success,
    ).toBe(true);
    expect(
      WorkspaceProjectionSchema.safeParse({ ...projection(), artifacts: [canvas] }).success,
    ).toBe(true);
    expect(
      JsonCanvasDocumentSchema.safeParse({
        ...canvas,
        nodes: [{ ...canvas.nodes[0] }, { ...canvas.nodes[0] }],
      }).success,
    ).toBe(false);
    expect(
      JsonCanvasDocumentSchema.safeParse({
        ...canvas,
        edges: [{ id: 'edge', fromNode: 'a', toNode: 'missing', label: '포함' }],
      }).success,
    ).toBe(false);
    expect(
      JsonCanvasDocumentSchema.safeParse({
        ...canvas,
        nodes: [{ ...canvas.nodes[0], file: 'https://example.com/x' }],
      }).success,
    ).toBe(false);
    expect(
      JsonCanvasDocumentSchema.safeParse({
        ...canvas,
        nodes: [{ ...canvas.nodes[0], width: Infinity }],
      }).success,
    ).toBe(false);
    expect(
      SvgArtifactDocumentSchema.safeParse({
        ...canvas,
        kind: 'svg',
        relativePath: 'a.svg',
        content: '<script/>',
      }).success,
    ).toBe(false);
    expect(
      WorkspaceProjectionSchema.safeParse({
        ...projection(),
        artifacts: [{ ...canvas, nodes: [{ ...canvas.nodes[0], file: '과목/다른과목/x.md' }] }],
      }).success,
    ).toBe(false);
  });
});
