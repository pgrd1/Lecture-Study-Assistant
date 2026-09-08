import { describe, expect, it } from 'vitest';
import {
  conceptNotePath,
  courseWorkspaceLayout,
  recordNotePath,
  sanitizeWorkspaceTitle,
  topicNotePath,
} from '../../../src/application/obsidian/workspaceLayout';

const ID = '018f47f2-d4d7-7f83-b513-f00a12345678';
const OTHER_ID = '018f47f2-d4d7-7f83-b513-f00a12345679';
const course = { id: ID, name: '바뀐 과목명', folderName: '자료구조' };

describe('workspace layout', () => {
  it('uses the persisted course folder and the complete built-in tree', () => {
    expect(courseWorkspaceLayout(course)).toEqual({
      courseId: ID,
      courseRoot: '과목/자료구조',
      dashboardPath: '학습 대시보드.md',
      dashboardBasePath: '학습 대시보드.base',
      courseMainPath: '과목/자료구조/자료구조.md',
      courseBasePath: '과목/자료구조/과목 색인.base',
      directories: [
        '과목/자료구조/강의노트',
        '과목/자료구조/개념',
        '과목/자료구조/원본자료',
        '과목/자료구조/원본자료/녹음',
        '과목/자료구조/원본자료/이미지',
        '과목/자료구조/원본자료/문서',
        '과목/자료구조/문제은행',
        '과목/자료구조/마인드맵',
        '과목/자료구조/암기',
        '과목/자료구조/질문함',
        '과목/자료구조/시험',
      ],
      sourceQuestionBankPath: '과목/자료구조/문제은행/원문 문제.md',
      predictedQuestionBankPath: '과목/자료구조/문제은행/AI 예상문제.md',
      variantQuestionBankPath: '과목/자료구조/문제은행/AI 변형문제.md',
      memoryPath: '과목/자료구조/암기/암기 체크리스트.md',
      questionInboxPath: '과목/자료구조/질문함/AI 질문함.md',
      professorProfilePath: '과목/자료구조/교수 강조·출제 프로필.md',
      courseCanvasPath: '과목/자료구조/마인드맵/과목 전체.canvas',
      courseSvgPath: '과목/자료구조/마인드맵/과목 전체.svg',
    });
    expect(courseWorkspaceLayout({ ...course, name: 'Another name' })).toEqual(
      courseWorkspaceLayout(course),
    );
    expect(Object.isFrozen(courseWorkspaceLayout(course).directories)).toBe(true);
  });

  it.each([
    ['연결 리스트', '연결-리스트'],
    ['Data Structures', 'Data-Structures'],
    ['Cafe\u0301', 'Café'],
    ['a/b\\c:\u0000d', 'a-b-c-d'],
    ['CON', '_CON'],
    ['AUX.txt', '_AUX.txt'],
    ['COM¹', '_COM¹'],
    ['LPT9.log', '_LPT9.log'],
    ['x...  ', 'x'],
    ['   ', '제목없음'],
    ['...', '제목없음'],
    ['a\u2028b\u202eb', 'a-b-b'],
    ['bad\ud800name', 'bad-name'],
  ])('normalizes unsafe display title %j deterministically', (input, expected) => {
    expect(sanitizeWorkspaceTitle(input)).toBe(expected);
  });

  it('bounds long slugs without splitting Unicode characters', () => {
    expect(sanitizeWorkspaceTitle('가'.repeat(200))).toBe('가'.repeat(80));
    expect(sanitizeWorkspaceTitle('😀'.repeat(100))).toBe('😀'.repeat(40));
    expect(sanitizeWorkspaceTitle(`${'a'.repeat(79)}😀z`)).toBe('a'.repeat(79));
  });

  it('keeps the compact stable suffix across renames and separates same/case-folded titles', () => {
    const input = { courseFolderName: '자료구조', topicId: ID, title: '연결 리스트' };
    expect(topicNotePath(input)).toBe(
      '과목/자료구조/강의노트/연결-리스트--topic_b513f00a12345678.md',
    );
    expect(topicNotePath({ ...input, title: 'Linked List' })).toBe(
      '과목/자료구조/강의노트/Linked-List--topic_b513f00a12345678.md',
    );
    expect(topicNotePath({ ...input, topicId: OTHER_ID })).toBe(
      '과목/자료구조/강의노트/연결-리스트--topic_b513f00a12345679.md',
    );
    expect(topicNotePath({ ...input, title: 'A' }).toLowerCase()).not.toBe(
      topicNotePath({ ...input, title: 'a', topicId: OTHER_ID }).toLowerCase(),
    );
    expect(topicNotePath({ ...input, title: 'Cafe\u0301' })).toBe(
      topicNotePath({ ...input, title: 'Café' }),
    );
    expect(conceptNotePath({ courseFolderName: '자료구조', conceptId: ID, title: '빅오' })).toBe(
      '과목/자료구조/개념/빅오--concept_b513f00a12345678.md',
    );
    expect(recordNotePath({ courseFolderName: '자료구조', recordId: ID, title: '문제 1' })).toBe(
      '과목/자료구조/문제은행/문제-1--record_b513f00a12345678.md',
    );
  });

  it.each(['../escape', 'A/B', 'A\\B', 'CON', 'x.', ''])(
    'rejects an unsafe persisted folder %j',
    (folderName) => {
      expect(() => courseWorkspaceLayout({ ...course, folderName })).toThrow();
      expect(() =>
        topicNotePath({ courseFolderName: folderName, topicId: ID, title: 'safe' }),
      ).toThrow();
    },
  );

  it('rejects invalid IDs and avoids a fixed profile/main filename collision', () => {
    expect(() =>
      topicNotePath({ courseFolderName: 'safe', topicId: '../x', title: 'safe' }),
    ).toThrow();
    expect(
      courseWorkspaceLayout({ ...course, folderName: '교수 강조·출제 프로필' }).courseMainPath,
    ).toBe('과목/교수 강조·출제 프로필/교수 강조·출제 프로필--course.md');
  });
});
