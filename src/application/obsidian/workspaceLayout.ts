import { z } from 'zod';
import type { Course } from '../../shared/contracts/course';
import {
  VaultRelativePathSchema,
  WorkspaceCourseFolderSchema,
  workspacePathKey,
} from '../../shared/contracts/obsidianWorkspace';
import {
  isWindowsDeviceName,
  isWindowsForbiddenCharacter,
} from '../../shared/contracts/windowsPath';

export const WORKSPACE_DIRECTORIES = Object.freeze([
  '강의노트',
  '개념',
  '원본자료',
  '원본자료/녹음',
  '원본자료/이미지',
  '원본자료/문서',
  '문제은행',
  '마인드맵',
  '암기',
  '질문함',
  '시험',
] as const);

export const sanitizeWorkspaceTitle = (title: string): string => {
  const normalized = z.string().parse(title).normalize('NFC');
  const replaced = Array.from(normalized, (character) =>
    isWindowsForbiddenCharacter(character) || /[\p{Cf}\p{Cs}\p{Zl}\p{Zp}%]/u.test(character)
      ? '-'
      : character,
  )
    .join('')
    .trim()
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/[. -]+$/u, '');
  const bounded = replaced.slice(0, 80).replace(/[\uD800-\uDBFF]$/u, '');
  const slug = bounded.replace(/[. -]+$/u, '') || '제목없음';
  return isWindowsDeviceName(slug) ? `_${slug}` : slug;
};

const courseRoot = (folderName: string): string =>
  `과목/${WorkspaceCourseFolderSchema.parse(folderName)}`;

export const courseWorkspaceLayout = (course: Pick<Course, 'id' | 'name' | 'folderName'>) => {
  const root = courseRoot(course.folderName);
  const mainName =
    workspacePathKey(course.folderName) === workspacePathKey('교수 강조·출제 프로필')
      ? `${course.folderName}--course`
      : course.folderName;
  return Object.freeze({
    courseId: z.uuid().parse(course.id).toLowerCase(),
    courseRoot: root,
    dashboardPath: '학습 대시보드.md',
    dashboardBasePath: '학습 대시보드.base',
    courseMainPath: VaultRelativePathSchema.parse(`${root}/${mainName}.md`),
    courseBasePath: `${root}/과목 색인.base`,
    directories: Object.freeze(WORKSPACE_DIRECTORIES.map((directory) => `${root}/${directory}`)),
    sourceQuestionBankPath: `${root}/문제은행/원문 문제.md`,
    predictedQuestionBankPath: `${root}/문제은행/AI 예상문제.md`,
    variantQuestionBankPath: `${root}/문제은행/AI 변형문제.md`,
    memoryPath: `${root}/암기/암기 체크리스트.md`,
    questionInboxPath: `${root}/질문함/AI 질문함.md`,
    professorProfilePath: `${root}/교수 강조·출제 프로필.md`,
    courseCanvasPath: `${root}/마인드맵/과목 전체.canvas`,
    courseSvgPath: `${root}/마인드맵/과목 전체.svg`,
  });
};
export type CourseWorkspaceLayout = ReturnType<typeof courseWorkspaceLayout>;

// The suffix survives title changes; the display path does not. Projectors must
// retain the full UUID and consult persisted prior paths when merging/renaming.
// A 64-bit suffix collision is rejected by projection path uniqueness checks.
const identifiedPath = (
  folder: string,
  directory: string,
  kind: string,
  id: string,
  title: string,
): string => {
  const suffix = z.uuid().parse(id).replaceAll('-', '').toLowerCase().slice(-16);
  return VaultRelativePathSchema.parse(
    `${courseRoot(folder)}/${directory}/${sanitizeWorkspaceTitle(title)}--${kind}_${suffix}.md`,
  );
};
export const topicNotePath = (
  input: Readonly<{ courseFolderName: string; topicId: string; title: string }>,
): string =>
  identifiedPath(input.courseFolderName, '강의노트', 'topic', input.topicId, input.title);
export const conceptNotePath = (
  input: Readonly<{ courseFolderName: string; conceptId: string; title: string }>,
): string =>
  identifiedPath(input.courseFolderName, '개념', 'concept', input.conceptId, input.title);
export const recordNotePath = (
  input: Readonly<{ courseFolderName: string; recordId: string; title: string }>,
): string =>
  identifiedPath(input.courseFolderName, '문제은행', 'record', input.recordId, input.title);
