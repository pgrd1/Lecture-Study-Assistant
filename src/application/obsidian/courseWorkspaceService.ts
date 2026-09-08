import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { assertNoReparsePoints, resolveManagedPath } from '../../core/paths/safePath';
import type { VaultConnection, VaultWriterPort } from '../../core/ports/vault';
import type { SqliteRepositories } from '../../infrastructure/db/sqliteDatabase';
import { assertBoundedPipelineJson } from '../../shared/contracts/boundedPipelineJson';
import {
  type ManagedMarkdownDocument,
  ManagedMarkdownDocumentSchema,
  ObsidianPropertiesSchema,
  VaultRelativePathSchema,
  workspacePathKey,
} from '../../shared/contracts/obsidianWorkspace';
import {
  type QuestionEvidence,
  QuestionEvidenceListSchema,
  type QuestionInboxTarget,
} from '../../shared/contracts/questionInbox';
import { parseExistingTopics } from '../../shared/contracts/studyContent';
import { AttachmentProjector, attachmentPath } from './attachmentProjector';
import { renderCourseBase } from './baseRenderer';
import { renderCourseCanvas } from './canvasRenderer';
import {
  CourseStateSchema,
  type CourseWorkspaceState,
  parseWorkspacePublication,
  projectCourseWorkspace,
  type WorkspacePublicationInput,
  workspaceHash,
} from './courseWorkspaceProjector';
import { ManagedNoteService } from './managedNoteService';
import { renderMarkdownDocument } from './markdownRenderer';
import { renderMindMapSvg } from './mindMapSvgRenderer';
import { toVaultRelativePath } from './vaultReferencePath';
import { courseWorkspaceLayout } from './workspaceLayout';
import { runWorkspaceExclusive } from './workspaceSerialQueue';

const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Artifact = z
  .strictObject({
    relativePath: VaultRelativePathSchema,
    sha256: Hash,
    kind: z.enum(['markdown', 'base', 'canvas', 'svg', 'attachment']),
  })
  .readonly();
const Manifest = z
  .strictObject({
    version: z.literal(1),
    revision: z.int().min(0),
    courses: z.array(CourseStateSchema).max(1000).readonly(),
    artifacts: z.array(Artifact).max(10000).readonly(),
    updatedAt: z.iso.datetime(),
  })
  .readonly();
const Envelope = z.strictObject({ sha256: Hash, manifest: Manifest }).readonly();
type ManifestValue = z.infer<typeof Manifest>;
type Dependencies = Readonly<{
  repositories: SqliteRepositories;
  writer: VaultWriterPort;
  connection: VaultConnection;
  artifactRoot: string;
}>;
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const ANSWER_BLOCK =
  /<!-- study-assistant:generated:start section="(answer_q_[a-f0-9]{32})" revision="[A-Za-z0-9_-]+" -->\n([\s\S]*?)\n<!-- study-assistant:generated:end -->/gu;
const contains = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
};

/** Manifest is the app-private commit point. Both process-local serialization and
 * an exclusive filesystem lease protect the shared dashboard and manifest. A
 * crashed lease fails closed; it is never guessed stale or automatically erased. */
export class CourseWorkspaceService {
  readonly #manifestPath: string;
  constructor(private readonly dependencies: Dependencies) {
    const { artifactRoot, connection } = dependencies;
    if (
      !isAbsolute(artifactRoot) ||
      contains(connection.vaultRoot, artifactRoot) ||
      contains(artifactRoot, connection.vaultRoot)
    )
      throw new TypeError('WORKSPACE_MANIFEST_NOT_PRIVATE');
    assertNoReparsePoints(artifactRoot);
    this.#manifestPath = join(artifactRoot, 'workspace-manifest.json');
  }

  async existingTopics(courseId: string, jobId?: string) {
    z.uuid().parse(courseId);
    if (jobId !== undefined) z.uuid().parse(jobId);
    const loaded = await this.#load();
    const state = loaded?.manifest.courses.find((course) => course.courseId === courseId);
    const job = state?.jobs.find((item) => item.jobId === jobId);
    return parseExistingTopics(
      copy(job?.existingTopics ?? state?.topics.map((t) => t.descriptor) ?? []),
      courseId,
    );
  }

  async questionInboxTargets(): Promise<readonly QuestionInboxTarget[]> {
    const loaded = await this.#load();
    return Object.freeze(
      this.dependencies.repositories.courses.list().flatMap((course) => {
        const state = loaded?.manifest.courses.find((item) => item.courseId === course.id);
        const note = state?.notes.find((item) => item.kind === 'question_inbox');
        if (
          !note ||
          !loaded?.manifest.artifacts.some(
            (item) => item.kind === 'markdown' && item.relativePath === note.relativePath,
          )
        )
          return [];
        return [
          Object.freeze({
            courseId: course.id,
            stableId: note.stableId,
            relativePath: note.relativePath,
            userInstructions: course.userInstructions,
          }),
        ];
      }),
    );
  }

  /** Read a revision accepted at the manifest commit, never a current Vault user region
   * or a later generated revision from a publication which has not committed. */
  async questionEvidence(courseId: string): Promise<readonly QuestionEvidence[]> {
    z.uuid().parse(courseId);
    const loaded = await this.#load();
    const state = loaded?.manifest.courses.find((item) => item.courseId === courseId);
    if (!state) return [];
    const evidence: QuestionEvidence[] = [];
    for (const note of state.notes.filter((item) => item.kind === 'lecture').slice(0, 100)) {
      const artifact = loaded?.manifest.artifacts.find(
        (item) => item.kind === 'markdown' && item.relativePath === note.relativePath,
      );
      const head = this.dependencies.repositories.managedNotes.get(note.stableId);
      const accepted =
        head?.publishedHash === artifact?.sha256
          ? head
          : this.dependencies.repositories.managedNotes
              .history(note.stableId, -1, 1000)
              .find((item) => item.publishedHash === artifact?.sha256);
      if (!accepted || accepted.relativePath !== note.relativePath) continue;
      const generated = accepted.generatedBase.slice(
        0,
        accepted.generatedBase.indexOf('<!-- study-assistant:user:start -->'),
      );
      for (const section of generated.matchAll(
        /<!-- study-assistant:generated:start section="[a-z0-9_-]+" revision="[A-Za-z0-9_-]+" -->\n([\s\S]*?)\n<!-- study-assistant:generated:end -->/gu,
      )) {
        if (!section[1] || section[1].length > 16000) continue;
        for (const citation of section[1].matchAll(
          /- \[\[([^\]\n|]+)\|([^\]\n]+)\]\] — 근거: `([a-f0-9-]{36})`/gu,
        )) {
          const attachment = state.attachments.find(
            (item) => toVaultRelativePath(item.relativePath) === citation[1],
          );
          if (
            !citation[1] ||
            !citation[2] ||
            !citation[3] ||
            !attachment ||
            evidence.some((item) => item.evidenceId === citation[3])
          )
            continue;
          const item = {
            evidenceId: citation[3],
            relativePath: attachment.relativePath,
            label: citation[2],
            text: section[1],
          };
          if (
            evidence.length >= 32 ||
            Buffer.byteLength(JSON.stringify([...evidence, item])) > 128 * 1024
          )
            return QuestionEvidenceListSchema.parse(evidence);
          evidence.push(Object.freeze(item));
        }
      }
    }
    return QuestionEvidenceListSchema.parse(evidence);
  }

  async publish(raw: unknown) {
    const input = parseWorkspacePublication(raw);
    return runWorkspaceExclusive(this.dependencies.connection.realManagedRoot, () =>
      this.#lockedPublish(input),
    );
  }

  async #load() {
    assertNoReparsePoints(this.dependencies.artifactRoot);
    assertNoReparsePoints(this.#manifestPath);
    let text: string;
    try {
      const stats = await lstat(this.#manifestPath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16 * 1024 ** 2)
        throw new TypeError('INVALID_WORKSPACE_MANIFEST');
      text = await readFile(this.#manifestPath, 'utf8');
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    const raw: unknown = JSON.parse(text);
    assertBoundedPipelineJson(raw);
    const parsed = Envelope.parse(raw);
    if (
      workspaceHash(JSON.stringify(parsed.manifest)) !== parsed.sha256 ||
      new Set(parsed.manifest.courses.map((c) => c.courseId)).size !==
        parsed.manifest.courses.length ||
      new Set(parsed.manifest.artifacts.map((a) => workspacePathKey(a.relativePath))).size !==
        parsed.manifest.artifacts.length
    )
      throw new TypeError('INVALID_WORKSPACE_MANIFEST');
    for (const course of parsed.manifest.courses) {
      parseExistingTopics(copy(course.topics.map((t) => t.descriptor)), course.courseId);
      const root = `과목/${course.folderName}/`;
      if (
        !course.courseMainPath.startsWith(root) ||
        [...course.notes, ...course.attachments, ...course.topics].some(
          (a) => !a.relativePath.startsWith(root),
        ) ||
        new Set(course.jobs.map((job) => job.jobId)).size !== course.jobs.length
      )
        throw new TypeError('INVALID_WORKSPACE_MANIFEST_SCOPE');
    }
    return Object.freeze({ manifest: parsed.manifest, fileHash: workspaceHash(text) });
  }

  #priorNotes(state: CourseWorkspaceState | null, extra: readonly ManagedMarkdownDocument[] = []) {
    const metadata = [
      ...(state?.notes ?? []),
      ...extra.map((note) => ({ ...note, sourceIds: note.relatedSourceIds })),
    ];
    const ids = new Set<string>();
    return metadata.flatMap((note) => {
      if (ids.has(note.stableId)) return [];
      ids.add(note.stableId);
      const head = this.dependencies.repositories.managedNotes.get(note.stableId);
      if (!head) {
        if (state?.notes.some((n) => n.stableId === note.stableId))
          throw new TypeError('WORKSPACE_REVISION_MISSING');
        return [];
      }
      if (head.relativePath !== note.relativePath) throw new TypeError('WORKSPACE_PATH_CHANGED');
      const generatedSections = [
        ...head.generatedBase.matchAll(
          /<!-- study-assistant:generated:start section="([a-z0-9_-]+)" revision="[A-Za-z0-9_-]+" -->\n([\s\S]*?)\n<!-- study-assistant:generated:end -->/gu,
        ),
      ].map((match) => ({ id: match[1], markdown: match[2] }));
      const frontmatter = head.generatedBase.slice(4, head.generatedBase.indexOf('\n---\n', 4));
      const properties = ObsidianPropertiesSchema.parse(
        JSON.parse(`{${frontmatter.split('\n').join(',')}}`),
      );
      return [
        ManagedMarkdownDocumentSchema.parse({
          stableId: note.stableId,
          kind: note.kind,
          relativePath: note.relativePath,
          properties,
          generatedSections,
          relatedSourceIds: [...note.sourceIds],
        }),
      ];
    });
  }

  async #userRegionBytes(notes: readonly ManagedMarkdownDocument[]) {
    const entries = await Promise.all(
      notes.map(async (note) => {
        const current = await this.dependencies.writer.readMarkdown(note.relativePath);
        const region = current?.content.match(
          /<!-- study-assistant:user:start -->([\s\S]*?)<!-- study-assistant:user:end -->/u,
        )?.[1];
        return region === undefined ? [] : [[note.stableId, Buffer.byteLength(region)]];
      }),
    );
    return Object.fromEntries(entries.flat()) as Record<string, number>;
  }

  async #lockedPublish(input: WorkspacePublicationInput) {
    const { artifactRoot } = this.dependencies;
    assertNoReparsePoints(artifactRoot);
    await mkdir(artifactRoot, { recursive: true });
    const lockPath = join(artifactRoot, 'workspace-publication.lock');
    assertNoReparsePoints(lockPath);
    const lock = await open(lockPath, 'wx', 0o600);
    try {
      return await this.#publish(input);
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }

  async #publish(input: WorkspacePublicationInput) {
    const { writer, repositories } = this.dependencies;
    const loaded = await this.#load();
    const previous = loaded?.manifest.courses.find((c) => c.courseId === input.course.id) ?? null;
    const job = previous?.jobs.find((item) => item.jobId === input.job.id);
    const canonical = courseWorkspaceLayout(input.course).courseMainPath;
    const head = repositories.managedNotes.get(`course_${input.course.id}`);
    // CourseService owns its legacy Markdown. Never adopt or replace an
    // untracked note: the new hub gets a deterministic, independently managed path.
    const courseMainPath =
      previous?.courseMainPath ??
      head?.relativePath ??
      ((await writer.readMarkdown(canonical))
        ? `${canonical.slice(0, -3)}--workspace.md`
        : canonical);
    const existingTopics = copy(
      job?.existingTopics ?? previous?.topics.map((t) => t.descriptor) ?? [],
    );
    const plannedAttachments = input.sources.map((source) => ({
      sourceId: source.id,
      relativePath: attachmentPath(input.course.folderName, source),
      sha256: source.sha256,
      sizeBytes: source.sizeBytes,
      mediaType: source.mediaType,
    }));
    const committedNotes = this.#priorNotes(previous);
    const context = {
      input,
      attachments: plannedAttachments,
      previous,
      priorNotes: committedNotes,
      userRegionBytes: await this.#userRegionBytes(committedNotes),
      courses: repositories.courses.list({ includeArchived: true }),
      coursePaths:
        loaded?.manifest.courses.map((course) => ({
          courseId: course.courseId,
          relativePath: course.courseMainPath,
        })) ?? [],
      courseMainPath,
      existingTopics,
    };
    const preflight = projectCourseWorkspace(context);
    if (job) {
      if (!loaded) throw new TypeError('WORKSPACE_MANIFEST_MISSING');
      if (job.inputSha256 !== preflight.inputSha256)
        throw new TypeError('WORKSPACE_JOB_CONTENT_CHANGED');
      await this.#verifyArtifacts(loaded.manifest.artifacts, loaded.manifest);
      return Object.freeze({
        generationRevision: job.generationRevision,
        manifestPath: 'workspace-manifest.json',
      });
    }
    // Resolve pending accepted revisions too, so a failed manifest write never
    // causes a later retry to discard a generated section already on disk.
    const priorNotes = this.#priorNotes(previous, preflight.projection.notes);
    const userRegionBytes = await this.#userRegionBytes(priorNotes);
    projectCourseWorkspace({ ...context, priorNotes, userRegionBytes });
    const attachments = await new AttachmentProjector(writer, this.dependencies.connection).publish(
      input.course.folderName,
      input.sources,
    );
    const { projection, state, generationRevision } = projectCourseWorkspace({
      ...context,
      priorNotes,
      userRegionBytes,
      attachments,
    });
    for (const directory of courseWorkspaceLayout(input.course).directories)
      await writer.ensureDirectory(directory);
    const accepted: z.infer<typeof Artifact>[] = [];
    const managed = new ManagedNoteService(repositories.managedNotes, writer);
    // Answer sections are immutable records. Recover complete accepted blocks,
    // including their own revisions, across all parts of this course's inbox.
    const priorAnswers = new Map(
      priorNotes
        .filter((note) => note.kind === 'question_inbox')
        .flatMap((note) => {
          const base = repositories.managedNotes.get(note.stableId)?.generatedBase ?? '';
          return [...base.matchAll(ANSWER_BLOCK)].map(
            (match) => [match[1], { block: match[0], body: match[2] }] as const,
          );
        }),
    );
    const publishNote = async (note: ManagedMarkdownDocument) => {
      const rendered = renderMarkdownDocument(note, generationRevision);
      const content =
        note.kind !== 'question_inbox'
          ? rendered
          : rendered.replace(ANSWER_BLOCK, (_block, section: string, body: string) => {
              const prior = priorAnswers.get(section);
              if (!prior || prior.body !== body) throw new TypeError('WORKSPACE_ANSWER_CHANGED');
              return prior.block;
            });
      const result = await managed.publish({
        stableId: note.stableId,
        relativePath: note.relativePath,
        content,
        generationRevision,
      });
      if (result.kind === 'conflict_preserved')
        throw new TypeError('WORKSPACE_NOTE_CONFLICT_PRESERVED');
      accepted.push({ relativePath: note.relativePath, sha256: result.sha256, kind: 'markdown' });
    };
    for (const note of projection.notes) await publishNote(note);
    await publishNote(projection.courseMain);
    const publishStructured = async (
      kind: 'base' | 'canvas' | 'svg',
      relativePath: string,
      content: string,
    ) => {
      const read =
        kind === 'base'
          ? writer.readBase.bind(writer)
          : kind === 'canvas'
            ? writer.readCanvas.bind(writer)
            : writer.readSvg.bind(writer);
      const write =
        kind === 'base'
          ? writer.writeBase.bind(writer)
          : kind === 'canvas'
            ? writer.writeCanvas.bind(writer)
            : writer.writeSvg.bind(writer);
      const current = await read(relativePath);
      const sha256 = workspaceHash(content);
      if (current?.sha256 !== sha256) {
        const expectedBaseHash =
          loaded?.manifest.artifacts.find((a) => a.relativePath === relativePath)?.sha256 ?? null;
        const result = await write({ relativePath, content, expectedBaseHash });
        if (
          result.kind !== 'written' ||
          result.relativePath !== relativePath ||
          result.sha256 !== sha256
        )
          throw new TypeError('WORKSPACE_ARTIFACT_CONFLICT');
      }
      accepted.push({ relativePath, sha256, kind });
    };
    for (const artifact of projection.artifacts) {
      const content =
        artifact.kind === 'base'
          ? renderCourseBase(artifact)
          : artifact.kind === 'canvas'
            ? renderCourseCanvas(artifact)
            : renderMindMapSvg(artifact);
      await publishStructured(artifact.kind, artifact.relativePath, content);
    }
    await publishNote(projection.dashboard);
    await publishStructured(
      'base',
      projection.dashboardBase.relativePath,
      renderCourseBase(projection.dashboardBase),
    );
    for (const metadata of loaded?.manifest.artifacts.filter(
      (artifact) => artifact.kind === 'markdown',
    ) ?? []) {
      if (accepted.some((artifact) => artifact.relativePath === metadata.relativePath)) continue;
      const head = repositories.managedNotes.findByPath(metadata.relativePath);
      if (!head) throw new TypeError('WORKSPACE_REVISION_MISSING');
      const result = await managed.publish({
        stableId: head.stableId,
        relativePath: head.relativePath,
        content: head.generatedBase,
        generationRevision: head.generationRevision,
      });
      if (result.kind === 'conflict_preserved')
        throw new TypeError('WORKSPACE_NOTE_CONFLICT_PRESERVED');
      accepted.push({ relativePath: head.relativePath, sha256: result.sha256, kind: 'markdown' });
    }
    accepted.push(
      ...attachments.map((a) => ({
        relativePath: a.relativePath,
        sha256: a.sha256,
        kind: 'attachment' as const,
      })),
    );
    const candidates = [
      ...(loaded?.manifest.artifacts ?? []).filter(
        (a) => !accepted.some((b) => b.relativePath === a.relativePath),
      ),
      ...accepted,
    ];
    const unique = new Map<string, z.infer<typeof Artifact>>();
    for (const artifact of candidates) {
      const key = workspacePathKey(artifact.relativePath);
      const existing = unique.get(key);
      if (existing && (existing.sha256 !== artifact.sha256 || existing.kind !== artifact.kind))
        throw new TypeError('WORKSPACE_ARTIFACT_IDENTITY_COLLISION');
      unique.set(key, artifact);
    }
    const artifacts = [...unique.values()];
    await this.#verifyArtifacts(
      artifacts,
      loaded?.manifest,
      attachments.map((a) => a.relativePath),
    );
    const manifest = Manifest.parse(
      copy({
        version: 1,
        revision: (loaded?.manifest.revision ?? -1) + 1,
        courses: [
          ...(loaded?.manifest.courses ?? []).filter((c) => c.courseId !== state.courseId),
          state,
        ],
        artifacts,
        updatedAt: input.bundle.createdAt,
      }),
    );
    await this.#commit(manifest, loaded?.fileHash ?? null);
    return Object.freeze({ generationRevision, manifestPath: 'workspace-manifest.json' });
  }

  async #verifyArtifacts(
    artifacts: readonly z.infer<typeof Artifact>[],
    committed?: ManifestValue,
    currentAttachments: readonly string[] = [],
  ) {
    for (const artifact of artifacts) {
      const path = resolveManagedPath(
        this.dependencies.connection.managedRoot,
        ...artifact.relativePath.split('/'),
      );
      assertNoReparsePoints(path);
      const stats = await lstat(path);
      if (
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        stats.size > (artifact.kind === 'attachment' ? 4 * 1024 ** 3 : 32 * 1024 ** 2)
      )
        throw new TypeError('WORKSPACE_ARTIFACT_MISSING');
      if (
        artifact.kind === 'attachment' &&
        !currentAttachments.includes(artifact.relativePath) &&
        committed?.artifacts.some(
          (old) =>
            old.relativePath === artifact.relativePath &&
            old.sha256 === artifact.sha256 &&
            old.kind === 'attachment',
        )
      ) {
        // Immutable originals were cryptographically checked at their commit.
        // Historical publication checks are bounded regardless of media size.
        const metadata = committed.courses
          .flatMap((course) => course.attachments)
          .find(
            (item) =>
              item.relativePath === artifact.relativePath && item.sha256 === artifact.sha256,
          );
        if (!metadata || stats.size !== metadata.sizeBytes)
          throw new TypeError('WORKSPACE_ARTIFACT_CHANGED');
        continue;
      }
      const hash = createHash('sha256');
      for await (const bytes of createReadStream(path)) hash.update(bytes);
      if (hash.digest('hex') !== artifact.sha256) throw new TypeError('WORKSPACE_ARTIFACT_CHANGED');
    }
  }

  async #commit(manifest: ManifestValue, expectedHash: string | null) {
    const envelope = { sha256: workspaceHash(JSON.stringify(manifest)), manifest };
    assertBoundedPipelineJson(envelope);
    Envelope.parse(envelope);
    const text = JSON.stringify(envelope);
    const temporaryPath = join(this.dependencies.artifactRoot, `workspace-${randomUUID()}.tmp`);
    assertNoReparsePoints(temporaryPath);
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    const current = await this.#load();
    if ((current?.fileHash ?? null) !== expectedHash)
      throw new TypeError('WORKSPACE_MANIFEST_STALE');
    assertNoReparsePoints(this.#manifestPath);
    await rename(temporaryPath, this.#manifestPath);
    // Windows does not support opening a directory for fsync. File data was
    // flushed before the atomic rename; POSIX also flushes the directory entry.
    if (process.platform !== 'win32') {
      const directory = await open(this.dependencies.artifactRoot, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    const confirmed = await this.#load();
    if (confirmed?.fileHash !== workspaceHash(text))
      throw new TypeError('WORKSPACE_MANIFEST_STALE');
  }
}
