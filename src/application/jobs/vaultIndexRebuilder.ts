import type { Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, relative } from 'node:path';
import { z } from 'zod';
import {
  createBundleFingerprint,
  createJobFingerprint,
  sha256File,
} from '../../core/jobs/fingerprint';
import { assertNoReparsePoints, resolveManagedPath } from '../../core/paths/safePath';
import type { CourseRepository } from '../../core/ports/courseRepository';
import type { JobArtifactRepository } from '../../core/ports/jobArtifactRepository';
import type { JobRepository } from '../../core/ports/jobRepository';
import type { SourceBundleRepository } from '../../core/ports/sourceBundleRepository';
import type { VaultConnection, VaultWriterPort } from '../../core/ports/vault';
import { type Course, CourseSchema } from '../../shared/contracts/course';
import { type Job, JobSchema, SourceKindSchema } from '../../shared/contracts/job';
import { type JobArtifact, JobArtifactSchema } from '../../shared/contracts/jobArtifact';
import { QueueSourceSchema } from '../../shared/contracts/queue';
import { extensionOf } from '../../shared/contracts/sourceFile';
import { usesLegacyStagingLayout } from './legacySourceBundle';

const SHA_256 = /^[a-f0-9]{64}$/u;
const LARGE_SOURCE_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const SMALL_SOURCE_MAX_BYTES = 500 * 1024 * 1024;

const CourseFrontmatterSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('course'),
  id: z.uuid(),
  folderName: z.string(),
  name: z.string(),
  professorName: z.string(),
  userInstructions: z.string(),
  archived: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  revision: z.int().min(0),
});

const RecordingFrontmatterSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('recording'),
  courseId: z.uuid(),
  jobId: z.uuid(),
  sourceId: z.uuid(),
  sourceKind: SourceKindSchema,
  sourceSha256: z.string().regex(SHA_256),
  fingerprint: z.string().regex(SHA_256),
  sourceFileName: z.string(),
  sourceMediaType: z.enum(['audio', 'video', 'document', 'image']),
  summaryMode: z.enum(['none', 'core', 'standard', 'full']),
  archivePath: z.string(),
  archiveSha256: z.string().regex(SHA_256),
  createdAt: z.iso.datetime({ offset: true }),
  generatedBaseHash: z.string().regex(SHA_256),
});

const COURSE_KEYS = Object.freeze({
  version: 'studyapp-note-version',
  kind: 'studyapp-note-kind',
  id: 'studyapp-course-id',
  folderName: 'studyapp-folder-name',
  name: 'studyapp-course-name',
  professorName: 'studyapp-professor-name',
  userInstructions: 'studyapp-user-instructions',
  archived: 'studyapp-course-archived',
  createdAt: 'studyapp-course-created-at',
  updatedAt: 'studyapp-course-updated-at',
  revision: 'studyapp-course-revision',
} as const);

const RECORDING_KEYS = Object.freeze({
  version: 'studyapp-note-version',
  kind: 'studyapp-note-kind',
  courseId: 'course_id',
  jobId: 'job_id',
  sourceId: 'source_id',
  sourceKind: 'source_kind',
  sourceSha256: 'source_sha256',
  fingerprint: 'source_fingerprint',
  sourceFileName: 'source_file_name',
  sourceMediaType: 'source_media_type',
  summaryMode: 'summary_mode',
  archivePath: 'source_archive_path',
  archiveSha256: 'source_archive_sha256',
  createdAt: 'created_at',
  generatedBaseHash: 'app_generated_base_hash',
} as const);

export type VaultRecoveryIssue = Readonly<{
  code: 'duplicate' | 'invalid-frontmatter' | 'invalid-integrity' | 'unsafe-entry';
  relativePath: string;
}>;

export type VaultIndexRebuilderDependencies = Readonly<{
  connection: VaultConnection;
  courses: CourseRepository;
  jobs: JobRepository;
  sourceBundles?: SourceBundleRepository;
  artifacts: JobArtifactRepository;
  vault: VaultWriterPort;
  clock?: () => string;
}>;

type RecoveredJob = Readonly<{
  job: Job;
  note: JobArtifact;
  archive: JobArtifact;
}>;

type RecoveredCourseCandidate = Readonly<{
  course: Course;
  relativePath: string;
}>;

const isMissingPathError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const portable = (...segments: readonly string[]): string => segments.join('/');

const frontmatterValues = <T extends Record<string, string>>(
  content: string,
  keys: T,
): { [K in keyof T]: unknown } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/u.exec(content);
  if (match === null) {
    throw new TypeError('MISSING_FRONTMATTER');
  }
  const required = new Set<string>(Object.values(keys));
  const parsed = new Map<string, unknown>();
  for (const line of (match[1] ?? '').split(/\r?\n/u)) {
    const field = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/u.exec(line);
    const key = field?.[1];
    if (key === undefined || !required.has(key)) {
      continue;
    }
    if (parsed.has(key)) {
      throw new TypeError('DUPLICATE_FRONTMATTER_FIELD');
    }
    parsed.set(key, JSON.parse(field?.[2] ?? ''));
  }
  const result: Record<string, unknown> = {};
  for (const [property, key] of Object.entries(keys)) {
    if (!parsed.has(key)) {
      throw new TypeError('MISSING_FRONTMATTER_FIELD');
    }
    result[property] = parsed.get(key);
  }
  return result as { [K in keyof T]: unknown };
};

const courseFromNote = (content: string, directoryName: string): Course => {
  const metadata = CourseFrontmatterSchema.parse(frontmatterValues(content, COURSE_KEYS));
  if (metadata.folderName !== directoryName) {
    throw new TypeError('COURSE_FOLDER_MISMATCH');
  }
  return CourseSchema.parse({
    id: metadata.id,
    name: metadata.name,
    professorName: metadata.professorName,
    folderName: metadata.folderName,
    userInstructions: metadata.userInstructions,
    archived: metadata.archived,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    revision: metadata.revision,
  });
};

const archiveDirectory = (mediaType: Job['sourceMediaType']): '문서' | '음성' =>
  mediaType === 'audio' || mediaType === 'video' ? '음성' : '문서';

const sourceLimit = (mediaType: Job['sourceMediaType']): number =>
  mediaType === 'audio' || mediaType === 'video' ? LARGE_SOURCE_MAX_BYTES : SMALL_SOURCE_MAX_BYTES;

export class VaultIndexRebuilder {
  readonly #artifacts: JobArtifactRepository;
  readonly #connection: VaultConnection;
  readonly #courses: CourseRepository;
  readonly #jobs: JobRepository;
  readonly #sourceBundles: SourceBundleRepository | undefined;
  readonly #vault: VaultWriterPort;
  #issues: readonly VaultRecoveryIssue[] = Object.freeze([]);

  constructor(dependencies: VaultIndexRebuilderDependencies) {
    this.#connection = dependencies.connection;
    this.#courses = dependencies.courses;
    this.#jobs = dependencies.jobs;
    this.#sourceBundles = dependencies.sourceBundles;
    this.#artifacts = dependencies.artifacts;
    this.#vault = dependencies.vault;
  }

  listRecoveryIssues(): readonly VaultRecoveryIssue[] {
    return this.#issues;
  }

  async rebuild(): Promise<{ courses: number; jobs: number }> {
    const issues: VaultRecoveryIssue[] = [];
    const courses = await this.#scanCourses(issues);
    const jobs = await this.#scanJobs(courses, issues);
    this.#issues = Object.freeze(issues);

    let restoredCourses = 0;
    for (const course of courses.values()) {
      const existing = this.#courses.get(course.id);
      if (existing === null) {
        this.#courses.insert(course);
        restoredCourses += 1;
      } else if (JSON.stringify(existing) !== JSON.stringify(course)) {
        this.#addIssue(issues, 'duplicate', portable('과목', course.folderName));
      }
    }

    let restoredJobs = 0;
    for (const recovered of jobs.values()) {
      const existing = this.#jobs.get(recovered.job.id);
      if (existing === null) {
        this.#jobs.insert(recovered.job);
        restoredJobs += 1;
      } else if (existing.fingerprint !== recovered.job.fingerprint) {
        this.#addIssue(issues, 'duplicate', recovered.note.relativePath);
        continue;
      }
      if (this.#artifacts.get(recovered.job.id, 'source_archive') === null) {
        this.#artifacts.insert(recovered.archive);
      }
      if (this.#artifacts.get(recovered.job.id, 'recording_note') === null) {
        this.#artifacts.insert(recovered.note);
      }
    }
    this.#issues = Object.freeze(issues);
    return Object.freeze({ courses: restoredCourses, jobs: restoredJobs });
  }

  async #scanCourses(issues: VaultRecoveryIssue[]): Promise<Map<string, Course>> {
    const recovered = new Map<string, Course>();
    const candidates: RecoveredCourseCandidate[] = [];
    const coursesPath = resolveManagedPath(this.#connection.managedRoot, '과목');
    let entries: Dirent[];
    try {
      assertNoReparsePoints(coursesPath);
      entries = await readdir(coursesPath, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) {
        return recovered;
      }
      throw error;
    }

    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = portable('과목', entry.name, `${entry.name}.md`);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        this.#addIssue(issues, 'unsafe-entry', portable('과목', entry.name));
        continue;
      }
      try {
        assertNoReparsePoints(resolveManagedPath(this.#connection.managedRoot, '과목', entry.name));
        const note = await this.#vault.readMarkdown(relativePath);
        if (note === null) {
          throw new TypeError('MISSING_COURSE_NOTE');
        }
        const course = courseFromNote(note.content, entry.name);
        candidates.push(Object.freeze({ course, relativePath }));
      } catch {
        this.#addIssue(issues, 'invalid-frontmatter', relativePath);
      }
    }
    const idCounts = new Map<string, number>();
    const folderCounts = new Map<string, number>();
    for (const { course } of candidates) {
      idCounts.set(course.id, (idCounts.get(course.id) ?? 0) + 1);
      const folder = course.folderName.toLocaleLowerCase('ko-KR');
      folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
    }
    for (const candidate of candidates) {
      const folder = candidate.course.folderName.toLocaleLowerCase('ko-KR');
      if ((idCounts.get(candidate.course.id) ?? 0) > 1 || (folderCounts.get(folder) ?? 0) > 1) {
        this.#addIssue(issues, 'duplicate', candidate.relativePath);
        continue;
      }
      recovered.set(candidate.course.id, candidate.course);
    }
    return recovered;
  }

  async #scanJobs(
    courses: ReadonlyMap<string, Course>,
    issues: VaultRecoveryIssue[],
  ): Promise<Map<string, RecoveredJob>> {
    const recovered = new Map<string, RecoveredJob>();
    const candidates: RecoveredJob[] = [];
    for (const course of courses.values()) {
      const recordingDirectory = resolveManagedPath(
        this.#connection.managedRoot,
        '과목',
        course.folderName,
        '녹음',
      );
      let entries: Dirent[];
      try {
        assertNoReparsePoints(recordingDirectory);
        entries = await readdir(recordingDirectory, { withFileTypes: true });
      } catch (error) {
        if (isMissingPathError(error)) {
          continue;
        }
        throw error;
      }
      for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.name.toLocaleLowerCase('en-US').endsWith('.md')) {
          continue;
        }
        const relativePath = portable('과목', course.folderName, '녹음', entry.name);
        if (!entry.isFile() || entry.isSymbolicLink()) {
          this.#addIssue(issues, 'unsafe-entry', relativePath);
          continue;
        }
        try {
          const note = await this.#vault.readMarkdown(relativePath);
          if (note === null) {
            throw new TypeError('MISSING_RECORDING_NOTE');
          }
          const recoveredJob = await this.#jobFromNote(course, note);
          candidates.push(recoveredJob);
        } catch {
          this.#addIssue(issues, 'invalid-integrity', relativePath);
        }
      }
    }
    const idCounts = new Map<string, number>();
    const fingerprintCounts = new Map<string, number>();
    for (const candidate of candidates) {
      idCounts.set(candidate.job.id, (idCounts.get(candidate.job.id) ?? 0) + 1);
      const fingerprintKey = `${candidate.job.courseId}:${candidate.job.fingerprint}`;
      fingerprintCounts.set(fingerprintKey, (fingerprintCounts.get(fingerprintKey) ?? 0) + 1);
    }
    for (const candidate of candidates) {
      const fingerprintKey = `${candidate.job.courseId}:${candidate.job.fingerprint}`;
      if (
        (idCounts.get(candidate.job.id) ?? 0) > 1 ||
        (fingerprintCounts.get(fingerprintKey) ?? 0) > 1
      ) {
        this.#addIssue(issues, 'duplicate', candidate.note.relativePath);
        continue;
      }
      recovered.set(candidate.job.id, candidate);
    }
    return recovered;
  }

  async #jobFromNote(
    course: Course,
    note: NonNullable<Awaited<ReturnType<VaultWriterPort['readMarkdown']>>>,
  ): Promise<RecoveredJob> {
    const metadata = RecordingFrontmatterSchema.parse(
      frontmatterValues(note.content, RECORDING_KEYS),
    );
    if (metadata.courseId !== course.id || metadata.sourceId !== metadata.jobId) {
      throw new TypeError('RECORDING_IDENTITY_MISMATCH');
    }
    QueueSourceSchema.parse({
      fileName: metadata.sourceFileName,
      mediaType: metadata.sourceMediaType,
    });
    const expectedArchivePrefix = portable(
      '과목',
      course.folderName,
      '자료',
      archiveDirectory(metadata.sourceMediaType),
    );
    const archiveName = basename(metadata.archivePath.replaceAll('\\', '/'));
    const sourceExtension = extensionOf(metadata.sourceFileName);
    const expectedArchiveName = `${metadata.jobId}${sourceExtension}`;
    const generatedArchiveName = `${metadata.jobId}.generated-${metadata.sourceSha256.slice(0, 12)}${sourceExtension}`;
    const conflictArchiveName = new RegExp(
      `^${metadata.jobId}\\.conflict-[0-9]{8}-[0-9]{6}(?:-(?:[2-9]|[1-9][0-9]))?\\${sourceExtension}$`,
      'u',
    );
    if (
      !metadata.archivePath.startsWith(`${expectedArchivePrefix}/`) ||
      (archiveName !== expectedArchiveName &&
        archiveName !== generatedArchiveName &&
        !conflictArchiveName.test(archiveName))
    ) {
      throw new TypeError('ARCHIVE_PATH_MISMATCH');
    }
    const archiveAbsolutePath = resolveManagedPath(
      this.#connection.managedRoot,
      ...metadata.archivePath.split('/'),
    );
    if (
      metadata.archiveSha256 !== metadata.sourceSha256 ||
      (await sha256File(archiveAbsolutePath, {
        maxBytes: sourceLimit(metadata.sourceMediaType),
      })) !== metadata.sourceSha256
    ) {
      throw new TypeError('ARCHIVE_HASH_MISMATCH');
    }

    const bundleIdentity = await this.#verifyBundleIdentity(metadata, archiveAbsolutePath);
    const job = JobSchema.parse({
      id: metadata.jobId,
      courseId: metadata.courseId,
      sourceKind: metadata.sourceKind,
      sourceFileName: metadata.sourceFileName,
      sourceMediaType: metadata.sourceMediaType,
      summaryMode: metadata.summaryMode,
      stagedSourcePath: archiveAbsolutePath,
      queueItemPath: null,
      sourceSha256: metadata.sourceSha256,
      fingerprint: metadata.fingerprint,
      ...bundleIdentity,
      status: 'completed',
      lastSuccessfulStatus: 'completed',
      retryCount: 0,
      errorCode: null,
      cleanupWarningCode: null,
      attentionResolutionId: null,
      createdAt: metadata.createdAt,
      updatedAt: metadata.createdAt,
      revision: 0,
    });
    return Object.freeze({
      job,
      note: JobArtifactSchema.parse({
        jobId: job.id,
        kind: 'recording_note',
        relativePath: note.relativePath,
        sha256: note.sha256,
        createdAt: metadata.createdAt,
      }),
      archive: JobArtifactSchema.parse({
        jobId: job.id,
        kind: 'source_archive',
        relativePath: metadata.archivePath,
        sha256: metadata.archiveSha256,
        createdAt: metadata.createdAt,
      }),
    });
  }

  async #verifyBundleIdentity(
    metadata: z.infer<typeof RecordingFrontmatterSchema>,
    verifiedArchivePath: string,
  ): Promise<Pick<Job, 'sourceBundleId' | 'sourceCount'>> {
    const existing = this.#jobs.get(metadata.jobId);
    const bundle = this.#sourceBundles?.getByJobId(metadata.jobId) ?? null;
    if (bundle === null) {
      if (
        existing?.sourceBundleId != null ||
        metadata.fingerprint !== createJobFingerprint(metadata.courseId, metadata.sourceSha256)
      ) {
        throw new TypeError('MISSING_BUNDLE_EVIDENCE');
      }
      return { sourceBundleId: null, sourceCount: 1 };
    }
    const records = this.#sourceBundles?.listRecords(bundle.id) ?? [];
    const primary = records[0];
    const fingerprint =
      records.length === 1
        ? createJobFingerprint(metadata.courseId, primary?.sha256 ?? '')
        : createBundleFingerprint(
            metadata.courseId,
            records.map((record) => record.sha256),
          );
    if (
      existing?.sourceBundleId !== bundle.id ||
      existing.sourceCount !== bundle.sourceCount ||
      existing.courseId !== metadata.courseId ||
      existing.fingerprint !== metadata.fingerprint ||
      records.length !== bundle.sourceCount ||
      records.reduce((sum, record) => sum + record.sizeBytes, 0) !== bundle.totalBytes ||
      records.some((record, index) => record.bundleId !== bundle.id || record.ordinal !== index) ||
      primary?.sha256 !== metadata.sourceSha256 ||
      primary.originalFileName !== metadata.sourceFileName ||
      primary.mediaType !== metadata.sourceMediaType ||
      fingerprint !== metadata.fingerprint
    ) {
      throw new TypeError('BUNDLE_IDENTITY_MISMATCH');
    }
    for (const record of records) {
      // Legacy singleton staging is intentionally removed only after archival/completion.
      // Its deterministic linkage and the already validated archive identify the same bytes.
      const legacy =
        existing.status === 'completed' &&
        record.id === existing.id &&
        record.stagedPath === existing.stagedSourcePath &&
        usesLegacyStagingLayout(existing, dirname(bundle.stagingDirectoryPath));
      const path = legacy
        ? verifiedArchivePath
        : resolveManagedPath(
            bundle.stagingDirectoryPath,
            ...relative(bundle.stagingDirectoryPath, record.stagedPath).split(/[\\/]/u),
          );
      if (
        (await lstat(path)).size !== record.sizeBytes ||
        (await sha256File(path, { maxBytes: sourceLimit(record.mediaType) })) !== record.sha256
      ) {
        throw new TypeError('BUNDLE_SOURCE_HASH_MISMATCH');
      }
    }
    return { sourceBundleId: bundle.id, sourceCount: bundle.sourceCount };
  }

  #addIssue(
    issues: VaultRecoveryIssue[],
    code: VaultRecoveryIssue['code'],
    relativePath: string,
  ): void {
    issues.push(Object.freeze({ code, relativePath }));
  }
}
