import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { toSafeCourseFolder } from '../../core/paths/safePath';
import type { CourseCatalog } from '../../core/ports/courseCatalog';
import type { CourseRepository } from '../../core/ports/courseRepository';
import type { VaultWriterPort, WriteResult } from '../../core/ports/vault';
import {
  type Course,
  type CourseInput,
  type CoursePatch,
  type CourseProvisioningInput,
  CourseSchema,
  parseCourseInput,
  parseCoursePatch,
  parseCourseProvisioningInput,
} from '../../shared/contracts/course';
import {
  APP_ERROR_MESSAGES,
  AppError,
  type ErrorEnvelope,
  toErrorEnvelope,
} from '../../shared/errors';

const MAIN_NOTE_PATH = '메인 학습 노트.md';
const MAIN_COURSES_START = '<!-- studyapp:courses:start -->';
const MAIN_COURSES_END = '<!-- studyapp:courses:end -->';
const COURSE_INFO_START = '<!-- studyapp:course-info:start -->';
const COURSE_INFO_END = '<!-- studyapp:course-info:end -->';
const COURSE_FRONTMATTER_FIELDS = Object.freeze([
  'studyapp-note-version',
  'studyapp-note-kind',
  'studyapp-course-id',
  'studyapp-folder-name',
  'studyapp-course-name',
  'studyapp-professor-name',
  'studyapp-user-instructions',
  'studyapp-course-archived',
  'studyapp-course-created-at',
  'studyapp-course-updated-at',
  'studyapp-course-revision',
] as const);
const CourseIdSchema = z.uuid();
const IsoDateTimeSchema = z.iso.datetime({ offset: true });

export type CourseServiceDependencies = Readonly<{
  repository: CourseRepository;
  vault: VaultWriterPort;
  catalog: CourseCatalog;
  clock?: () => string;
  idGenerator?: () => string;
}>;

export type CourseSynchronizationIssue = Readonly<{
  scope: 'course-note' | 'indexes';
  courseId: string | null;
  error: ErrorEnvelope;
}>;

const vaultWriteError = (): AppError =>
  new AppError('VAULT_WRITE_FAILED', APP_ERROR_MESSAGES.VAULT_WRITE_FAILED);

const courseNotFoundError = (): AppError =>
  new AppError('COURSE_NOT_FOUND', APP_ERROR_MESSAGES.COURSE_NOT_FOUND);

const duplicateCourseError = (): AppError =>
  new AppError('DUPLICATE_COURSE', APP_ERROR_MESSAGES.DUPLICATE_COURSE);

const escapeMarkdown = (value: string): string =>
  value.replace(/[\\`*_[\]{}()#+.!|<>-]/gu, (character) => `\\${character}`);

const renderInstructions = (instructions: string): string => {
  if (instructions.length === 0) {
    return '_등록된 지침이 없습니다._';
  }
  return instructions
    .split(/\r?\n/u)
    .map((line) => `> ${escapeMarkdown(line)}`)
    .join('\n');
};

const renderCourseInfo = (course: Course): string => `${COURSE_INFO_START}
# ${escapeMarkdown(course.name)}

## 과목 정보

- 과목명: ${escapeMarkdown(course.name)}
- 교수 표시명: ${course.professorName.length === 0 ? '_미입력_' : escapeMarkdown(course.professorName)}
- 상태: ${course.archived ? '보관됨' : '사용 중'}

## 사용자 지침

${renderInstructions(course.userInstructions)}
${COURSE_INFO_END}`;

const renderCourseFrontmatter = (course: Course): string => `studyapp-note-version: 1
studyapp-note-kind: "course"
studyapp-course-id: ${JSON.stringify(course.id)}
studyapp-folder-name: ${JSON.stringify(course.folderName)}
studyapp-course-name: ${JSON.stringify(course.name)}
studyapp-professor-name: ${JSON.stringify(course.professorName)}
studyapp-user-instructions: ${JSON.stringify(course.userInstructions)}
studyapp-course-archived: ${JSON.stringify(course.archived)}
studyapp-course-created-at: ${JSON.stringify(course.createdAt)}
studyapp-course-updated-at: ${JSON.stringify(course.updatedAt)}
studyapp-course-revision: ${course.revision}`;

const renderCourseNote = (course: Course): string => `---
${renderCourseFrontmatter(course)}
---

${renderCourseInfo(course)}

## 강의 목록

> 녹음별 서브 노트가 여기에 연결됩니다.

## 자료 목록

> 등록한 음성·문서·과제·퀴즈가 여기에 연결됩니다.

## 교수 출제 성향

> 강의와 평가 자료에서 확인된 출제 신호가 여기에 누적됩니다.

## 핵심 개념 색인

> 강의 노트의 핵심 개념이 여기에 연결됩니다.

## 취약 개념

> 문제 풀이에서 확인된 취약 개념이 여기에 누적됩니다.

## 시험 산출물

- [[시험/최종 핵심 노트|최종 핵심 노트]]
- [[시험/예상문제|예상문제]]
- [[시험/정답·해설|정답·해설]]
- [[시험/오답·약점|오답·약점]]
- [[시험/PDF|iPad용 PDF]]
`;

const hasStableCourseId = (content: string, courseId: string): boolean => {
  if (!content.startsWith('---')) {
    return false;
  }
  const frontmatterEnd = content.indexOf('\n---', 3);
  if (frontmatterEnd < 0) {
    return false;
  }
  const frontmatter = content.slice(0, frontmatterEnd);
  const matches = [...frontmatter.matchAll(/^studyapp-course-id:\s*"([^"]+)"\s*$/gmu)];
  return matches.length === 1 && matches[0]?.[1] === courseId;
};

const replaceManagedCourseFrontmatter = (content: string, course: Course): string => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/u.exec(content);
  if (match === null) {
    throw vaultWriteError();
  }
  const originalFrontmatter = match[1] ?? '';
  const managedFields = new Set<string>(COURSE_FRONTMATTER_FIELDS);
  const unmanagedLines = originalFrontmatter.split(/\r?\n/u).filter((line) => {
    const key = /^([A-Za-z0-9_-]+)\s*:/u.exec(line)?.[1];
    return key === undefined || !managedFields.has(key);
  });
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const managed = renderCourseFrontmatter(course).replaceAll('\n', newline);
  const unmanaged = unmanagedLines.join(newline).trimEnd();
  const replacement = `---${newline}${managed}${unmanaged.length === 0 ? '' : `${newline}${unmanaged}`}${newline}---`;
  return `${replacement}${content.slice(match[0].length)}`;
};

const replaceManagedBlock = (
  content: string,
  startMarker: string,
  endMarker: string,
  replacement: string,
): string => {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (
    start < 0 ||
    end < start + startMarker.length ||
    content.lastIndexOf(startMarker) !== start ||
    content.lastIndexOf(endMarker) !== end
  ) {
    throw vaultWriteError();
  }
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const normalizedReplacement = replacement.replaceAll('\r\n', '\n').replaceAll('\n', newline);
  return `${content.slice(0, start)}${normalizedReplacement}${content.slice(end + endMarker.length)}`;
};

const courseNotePath = (course: Course): string =>
  `과목/${course.folderName}/${course.folderName}.md`;

const courseDirectories = (course: Course): readonly string[] =>
  Object.freeze([
    `과목/${course.folderName}`,
    `과목/${course.folderName}/녹음`,
    `과목/${course.folderName}/자료/음성`,
    `과목/${course.folderName}/자료/문서`,
    `과목/${course.folderName}/시험/PDF`,
  ]);

const OBSIDIAN_LINK_SYNTAX = Object.freeze([
  '\\',
  '`',
  '*',
  '_',
  '[',
  ']',
  '{',
  '}',
  '(',
  ')',
  '#',
  '+',
  '.',
  '!',
  '|',
  '<',
  '>',
  '^',
  '-',
]);

const requiresMarkdownLink = (course: Course): boolean =>
  OBSIDIAN_LINK_SYNTAX.some(
    (character) => course.name.includes(character) || course.folderName.includes(character),
  );

const courseLink = (course: Course): string => {
  if (!requiresMarkdownLink(course)) {
    return `[[과목/${course.folderName}/${course.folderName}|${course.name}]]`;
  }
  const href = ['과목', course.folderName, `${course.folderName}.md`]
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `[${escapeMarkdown(course.name)}](${href})`;
};

const renderMainCourseBlock = (courses: readonly Course[]): string => {
  const active = courses
    .filter((course) => !course.archived)
    .toSorted((left, right) =>
      left.name.localeCompare(right.name, 'ko-KR', { sensitivity: 'base' }),
    );
  const links =
    active.length === 0
      ? '_등록된 과목이 없습니다._'
      : active.map((course) => `- ${courseLink(course)}`).join('\n');
  return `${MAIN_COURSES_START}\n## 과목\n\n${links}\n${MAIN_COURSES_END}`;
};

const renderMainNote = (courses: readonly Course[]): string => `# 메인 학습 노트

이 노트는 Lecture Study Assistant가 관리하는 과목 색인입니다.

${renderMainCourseBlock(courses)}
`;

const requireWritten = (result: WriteResult): void => {
  if (result.kind !== 'written') {
    throw vaultWriteError();
  }
};

export class CourseService {
  readonly #catalog: CourseCatalog;
  readonly #clock: () => string;
  readonly #idGenerator: () => string;
  readonly #repository: CourseRepository;
  readonly #vault: VaultWriterPort;
  #operationTail: Promise<void> = Promise.resolve();
  #synchronizationIssues: ReadonlyMap<string, CourseSynchronizationIssue> = new Map();

  constructor(dependencies: CourseServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#vault = dependencies.vault;
    this.#catalog = dependencies.catalog;
    this.#clock = dependencies.clock ?? (() => new Date().toISOString());
    this.#idGenerator = dependencies.idGenerator ?? randomUUID;
  }

  create(input: CourseInput): Promise<Course> {
    return this.#runExclusive(() => this.#create(input));
  }

  provision(input: CourseProvisioningInput): Promise<Course> {
    return this.#runExclusive(() => this.#provision(input));
  }

  update(id: string, patch: CoursePatch): Promise<Course> {
    return this.#runExclusive(() => this.#update(id, patch));
  }

  archive(id: string): Promise<Course> {
    return this.#runExclusive(() => this.#archive(id));
  }

  restore(id: string): Promise<Course> {
    return this.#runExclusive(() => this.#restore(id));
  }

  synchronize(): Promise<void> {
    return this.#runExclusive(() => this.#synchronize());
  }

  listSynchronizationIssues(): readonly CourseSynchronizationIssue[] {
    return Object.freeze([...this.#synchronizationIssues.values()]);
  }

  async #create(input: CourseInput): Promise<Course> {
    const parsed = parseCourseInput(input);
    const folderName = toSafeCourseFolder(parsed.name);
    const archived = this.#repository
      .list({ includeArchived: true })
      .find(
        (course) =>
          course.archived &&
          course.folderName.toLocaleLowerCase('ko-KR') === folderName.toLocaleLowerCase('ko-KR'),
      );
    if (archived !== undefined) {
      return this.#activate(archived, parsed);
    }
    return this.#createWithId(parsed, this.#idGenerator(), false);
  }

  async #provision(input: CourseProvisioningInput): Promise<Course> {
    const parsed = parseCourseProvisioningInput(input);
    const existing = this.#repository.get(parsed.id);
    if (existing !== null) {
      if (existing.archived) {
        throw courseNotFoundError();
      }
      await this.#synchronizeCourseNote(existing);
      this.#clearSynchronizationIssues('course-note', existing.id);
      await this.#synchronizeIndexesRequired(existing.id);
      return existing;
    }
    return this.#createWithId(parsed, parsed.id, true);
  }

  async #createWithId(input: CourseInput, id: string, strictIndexes: boolean): Promise<Course> {
    const folderName = toSafeCourseFolder(input.name);
    if (
      this.#repository
        .list({ includeArchived: true })
        .some(
          (course) =>
            course.folderName.toLocaleLowerCase('ko-KR') === folderName.toLocaleLowerCase('ko-KR'),
        )
    ) {
      throw duplicateCourseError();
    }
    const now = this.#now();
    const course = CourseSchema.parse({
      id,
      name: input.name,
      professorName: input.professorName,
      folderName,
      userInstructions: '',
      archived: false,
      createdAt: now,
      updatedAt: now,
      revision: 0,
    });

    const inserted = this.#repository.insert(course);
    try {
      await this.#createCourseNote(inserted);
      this.#clearSynchronizationIssues('course-note', inserted.id);
    } catch (error) {
      this.#repository.delete(inserted.id, inserted.revision);
      throw error;
    }
    if (strictIndexes) {
      await this.#synchronizeIndexesRequired(inserted.id);
    } else {
      await this.#synchronizeIndexesOrDefer(inserted.id);
    }
    return inserted;
  }

  async #update(id: string, patch: CoursePatch): Promise<Course> {
    const existing = this.#requireCourse(id);
    const parsed = parseCoursePatch(patch);
    const updated = CourseSchema.parse({
      ...existing,
      ...parsed,
      folderName: existing.folderName,
      updatedAt: this.#now(),
      revision: existing.revision + 1,
    });
    const stored = this.#repository.update(updated, existing.revision);
    try {
      await this.#synchronizeCourseNote(stored);
      this.#clearSynchronizationIssues('course-note', stored.id);
    } catch (error) {
      this.#restoreCourse(existing, stored);
      throw error;
    }
    await this.#synchronizeIndexesOrDefer(stored.id);
    return stored;
  }

  async #archive(id: string): Promise<Course> {
    const existing = this.#requireCourse(id);
    if (existing.archived) {
      await this.#synchronizeCourseNote(existing);
      this.#clearSynchronizationIssues('course-note', existing.id);
      await this.#synchronizeIndexesOrDefer(existing.id);
      return existing;
    }
    const archived = CourseSchema.parse({
      ...existing,
      archived: true,
      updatedAt: this.#now(),
      revision: existing.revision + 1,
    });
    const stored = this.#repository.update(archived, existing.revision);
    try {
      await this.#synchronizeCourseNote(stored);
      this.#clearSynchronizationIssues('course-note', stored.id);
    } catch (error) {
      this.#restoreCourse(existing, stored);
      throw error;
    }
    await this.#synchronizeIndexesOrDefer(stored.id);
    return stored;
  }

  async #restore(id: string): Promise<Course> {
    return this.#activate(this.#requireCourse(id));
  }

  async #activate(existing: Course, input?: CourseInput): Promise<Course> {
    if (!existing.archived) {
      await this.#synchronizeCourseNote(existing);
      this.#clearSynchronizationIssues('course-note', existing.id);
      await this.#synchronizeIndexesOrDefer(existing.id);
      return existing;
    }
    const restored = CourseSchema.parse({
      ...existing,
      ...(input === undefined
        ? {}
        : {
            name: input.name,
            professorName:
              input.professorName.length === 0 ? existing.professorName : input.professorName,
          }),
      archived: false,
      updatedAt: this.#now(),
      revision: existing.revision + 1,
    });
    const stored = this.#repository.update(restored, existing.revision);
    try {
      await this.#synchronizeCourseNote(stored);
      this.#clearSynchronizationIssues('course-note', stored.id);
    } catch (error) {
      this.#restoreCourse(existing, stored);
      throw error;
    }
    await this.#synchronizeIndexesOrDefer(stored.id);
    return stored;
  }

  async #synchronize(): Promise<void> {
    const courses = this.#repository.list({ includeArchived: true });
    for (const course of courses) {
      try {
        await this.#synchronizeCourseNote(course);
        this.#clearSynchronizationIssues('course-note', course.id);
      } catch (error) {
        this.#recordSynchronizationIssue('course-note', course.id, error);
        throw error;
      }
    }
    try {
      await this.#synchronizeIndexes();
      this.#clearSynchronizationIssues('indexes');
    } catch (error) {
      if (courses.length === 0) {
        this.#recordSynchronizationIssue('indexes', null, error);
      } else {
        for (const course of courses) {
          this.#recordSynchronizationIssue('indexes', course.id, error);
        }
      }
      throw error;
    }
  }

  #now(): string {
    return IsoDateTimeSchema.parse(this.#clock());
  }

  #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #requireCourse(id: string): Course {
    const parsedId = CourseIdSchema.safeParse(id);
    if (!parsedId.success) {
      throw courseNotFoundError();
    }
    const course = this.#repository.get(parsedId.data);
    if (course === null) {
      throw courseNotFoundError();
    }
    return course;
  }

  #restoreCourse(original: Course, stored: Course): Course {
    return this.#repository.update(
      CourseSchema.parse({
        ...original,
        updatedAt: this.#now(),
        revision: stored.revision + 1,
      }),
      stored.revision,
    );
  }

  #recordSynchronizationIssue(
    scope: CourseSynchronizationIssue['scope'],
    courseId: string | null,
    error: unknown,
  ): void {
    const key = `${scope}:${courseId ?? '__global__'}`;
    this.#synchronizationIssues = new Map(this.#synchronizationIssues).set(
      key,
      Object.freeze({ scope, courseId, error: toErrorEnvelope(error) }),
    );
  }

  #clearSynchronizationIssues(scope: CourseSynchronizationIssue['scope'], courseId?: string): void {
    this.#synchronizationIssues = new Map(
      [...this.#synchronizationIssues].filter(
        ([, issue]) =>
          issue.scope !== scope || (courseId !== undefined && issue.courseId !== courseId),
      ),
    );
  }

  async #synchronizeIndexesOrDefer(courseId: string): Promise<void> {
    try {
      await this.#synchronizeIndexes();
      this.#clearSynchronizationIssues('indexes');
    } catch (error) {
      this.#recordSynchronizationIssue('indexes', courseId, error);
    }
  }

  async #synchronizeIndexesRequired(courseId: string): Promise<void> {
    try {
      await this.#synchronizeIndexes();
      this.#clearSynchronizationIssues('indexes');
    } catch (error) {
      this.#recordSynchronizationIssue('indexes', courseId, error);
      throw error;
    }
  }

  async #ensureHierarchy(course: Course): Promise<void> {
    for (const directory of courseDirectories(course)) {
      await this.#vault.ensureDirectory(directory);
    }
  }

  async #createCourseNote(course: Course): Promise<void> {
    await this.#ensureHierarchy(course);
    const relativePath = courseNotePath(course);
    if ((await this.#vault.readMarkdown(relativePath)) !== null) {
      throw duplicateCourseError();
    }
    const result = await this.#vault.writeMarkdown({
      relativePath,
      content: renderCourseNote(course),
      expectedBaseHash: null,
    });
    if (result.kind !== 'written') {
      throw duplicateCourseError();
    }
  }

  async #synchronizeCourseNote(course: Course): Promise<void> {
    await this.#ensureHierarchy(course);
    const relativePath = courseNotePath(course);
    const current = await this.#vault.readMarkdown(relativePath);
    if (current === null) {
      requireWritten(
        await this.#vault.writeMarkdown({
          relativePath,
          content: renderCourseNote(course),
          expectedBaseHash: null,
        }),
      );
      return;
    }
    if (!hasStableCourseId(current.content, course.id)) {
      throw vaultWriteError();
    }
    const frontmatterSynchronized = replaceManagedCourseFrontmatter(current.content, course);
    const content = replaceManagedBlock(
      frontmatterSynchronized,
      COURSE_INFO_START,
      COURSE_INFO_END,
      renderCourseInfo(course),
    );
    if (content === current.content) {
      return;
    }
    requireWritten(
      await this.#vault.writeMarkdown({
        relativePath,
        content,
        expectedBaseHash: current.sha256,
      }),
    );
  }

  async #synchronizeIndexes(): Promise<void> {
    const active = this.#repository.list();
    const current = await this.#vault.readMarkdown(MAIN_NOTE_PATH);
    if (current === null) {
      requireWritten(
        await this.#vault.writeMarkdown({
          relativePath: MAIN_NOTE_PATH,
          content: renderMainNote(active),
          expectedBaseHash: null,
        }),
      );
    } else {
      const content = replaceManagedBlock(
        current.content,
        MAIN_COURSES_START,
        MAIN_COURSES_END,
        renderMainCourseBlock(active),
      );
      if (content !== current.content) {
        requireWritten(
          await this.#vault.writeMarkdown({
            relativePath: MAIN_NOTE_PATH,
            content,
            expectedBaseHash: current.sha256,
          }),
        );
      }
    }
    await this.#catalog.publish(active);
  }
}
