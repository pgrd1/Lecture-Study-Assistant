import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assertBoundedPipelineJson } from '../../shared/contracts/boundedPipelineJson';
import { CourseSchema } from '../../shared/contracts/course';
import { JobSchema, SummaryModeSchema } from '../../shared/contracts/job';
import {
  assertPartitionedWorkspaceData,
  type GeneratedSection,
  GeneratedSectionSchema,
  type ManagedMarkdownDocument,
  ManagedMarkdownDocumentSchema,
  ObsidianBaseDocumentSchema,
  VaultRelativePathSchema,
  WorkspaceProjectionSchema,
} from '../../shared/contracts/obsidianWorkspace';
import { SourceBundleSchema, SourceRecordSchema } from '../../shared/contracts/sourceBundle';
import {
  ExistingTopicDescriptorSchema,
  parseExistingTopics,
  STUDY_ITEM_FIELDS,
  type StudyContentResult,
  type StudyItem,
  studyItems,
  VerifiedStudyContentSchema,
} from '../../shared/contracts/studyContent';
import { attachmentPath } from './attachmentProjector';
import { renderCallout, renderMarkdownDocument } from './markdownRenderer';
import { layoutMindMap, type MindMapLayoutInput } from './mindMapLayout';
import { renderEvidenceCitations, renderObsidianEmbed, renderObsidianLink } from './obsidianLink';
import { conceptNotePath, courseWorkspaceLayout, topicNotePath } from './workspaceLayout';

export const workspaceHash = (text: string): string =>
  createHash('sha256').update(text).digest('hex');
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/u);
export const ProvenanceSchema = z
  .strictObject({
    invocationId: z.uuid(),
    modelId: z.string().max(200).nullable(),
    promptVersion: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
  })
  .readonly();
const InputSchema = z
  .strictObject({
    course: CourseSchema,
    job: JobSchema,
    bundle: SourceBundleSchema,
    sources: z.array(SourceRecordSchema).min(1).max(32).readonly(),
    content: VerifiedStudyContentSchema,
    provenance: z.array(ProvenanceSchema).max(200).readonly(),
  })
  .readonly();
export type WorkspacePublicationInput = z.infer<typeof InputSchema>;
export const AttachmentSchema = z
  .strictObject({
    sourceId: z.uuid(),
    relativePath: VaultRelativePathSchema,
    sha256: Hash,
    sizeBytes: z
      .int()
      .positive()
      .max(4 * 1024 ** 3),
    mediaType: z.enum(['audio', 'video', 'document', 'image']),
  })
  .readonly();
export type WorkspaceAttachment = z.infer<typeof AttachmentSchema>;
export const NoteMetadataSchema = z
  .strictObject({
    stableId: Id,
    relativePath: VaultRelativePathSchema,
    kind: z.enum([
      'lecture',
      'concept',
      'question_bank',
      'memory',
      'question_inbox',
      'professor_profile',
    ]),
    sourceIds: z.array(z.uuid()).max(1000).readonly(),
  })
  .readonly();
export const TopicStateSchema = z
  .strictObject({
    descriptor: ExistingTopicDescriptorSchema,
    relativePath: VaultRelativePathSchema,
  })
  .readonly();
export const CourseStateSchema = z
  .strictObject({
    courseId: z.uuid(),
    folderName: z.string().max(100),
    courseMainPath: VaultRelativePathSchema,
    summaryMode: SummaryModeSchema,
    topics: z.array(TopicStateSchema).max(100).readonly(),
    notes: z.array(NoteMetadataSchema).max(2000).readonly(),
    attachments: z.array(AttachmentSchema).max(1000).readonly(),
    jobs: z
      .array(
        z
          .strictObject({
            jobId: z.uuid(),
            inputSha256: Hash,
            sourceIds: z.array(z.uuid()).max(32).readonly(),
            existingTopics: z.array(ExistingTopicDescriptorSchema).max(100).readonly(),
            generationRevision: Hash,
            timestamp: z.iso.datetime(),
            provenance: z.array(ProvenanceSchema).max(200).readonly(),
          })
          .readonly(),
      )
      .max(100)
      .readonly(),
  })
  .readonly();
export type CourseWorkspaceState = z.infer<typeof CourseStateSchema>;
const cleanCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// Never interpret generated text as Markdown syntax or a path. Trusted renderers
// receive only escaped prose, strict relative references and closed properties.
const safeText = (value: string): string => {
  if (
    /(?:[a-z]:[\\/]|file:\/\/|\\\\|(?:sk-|AIza)[A-Za-z0-9_-]{16,}|-----BEGIN .*PRIVATE KEY|(?:api[_ -]?key|password|secret|token)\s*[:=])/iu.test(
      value,
    ) ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value.replace(/[\n\r\t]/gu, ''))
  )
    throw new TypeError('UNSAFE_WORKSPACE_TEXT');
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\`*_[\]{}()#+.!|~])/gu, '\\$1');
};
export const parseWorkspacePublication = (value: unknown): WorkspacePublicationInput => {
  assertBoundedPipelineJson(value);
  const input = InputSchema.parse(value);
  const { course, job, bundle, sources, content } = input;
  if (
    course.id !== job.courseId ||
    bundle.id !== job.sourceBundleId ||
    bundle.jobId !== job.id ||
    bundle.sourceCount !== sources.length ||
    job.sourceCount !== sources.length ||
    bundle.totalBytes !== sources.reduce((sum, source) => sum + source.sizeBytes, 0) ||
    new Set(sources.map((source) => source.id)).size !== sources.length ||
    sources.some((source, index) => source.bundleId !== bundle.id || source.ordinal !== index)
  )
    throw new TypeError('INVALID_WORKSPACE_SOURCE_IDENTITY');
  const first = sources[0];
  if (
    !first ||
    first.sha256 !== job.sourceSha256 ||
    first.originalFileName !== job.sourceFileName ||
    first.mediaType !== job.sourceMediaType
  )
    throw new TypeError('INVALID_WORKSPACE_JOB_SOURCE');
  const known = new Map(sources.map((source) => [source.id, source]));
  const decisions = new Map(
    content.verification.decisions.map((decision) => [decision.itemId, decision]),
  );
  const items = studyItems(content);
  if (
    decisions.size !== content.verification.decisions.length ||
    new Set(items.map((item) => item.id)).size !== items.length ||
    items.some(
      (item) =>
        item.evidenceIds.length === 0 ||
        decisions.get(item.id)?.decision !== 'accept' ||
        decisions.get(item.id)?.missingEvidenceIds.length !== 0,
    )
  )
    throw new TypeError('UNVERIFIED_WORKSPACE_CLAIM');
  const topicIds = content.topics.map((topic) => topic.existingTopicId ?? topic.cluster.id);
  if (new Set(topicIds).size !== topicIds.length) throw new TypeError('DUPLICATE_WORKSPACE_TOPIC');
  for (const topic of content.topics) {
    const citations = new Map(topic.citations.map((citation) => [citation.evidenceId, citation]));
    const references = [
      ...topic.cluster.evidenceIds,
      ...topic.sessions.flatMap((session) => session.evidenceIds),
      ...STUDY_ITEM_FIELDS.flatMap((field) => topic[field].flatMap((item) => item.evidenceIds)),
      ...topic.conflicts.flatMap((conflict) => [
        ...conflict.evidenceIds,
        ...conflict.alternatives.flatMap((a) => a.evidenceIds),
      ]),
    ];
    if (
      citations.size !== topic.citations.length ||
      references.some((evidenceId) => !citations.has(evidenceId)) ||
      topic.citations.some((citation) => {
        const source = known.get(citation.sourceId);
        if (!source) return true;
        return source.mediaType === 'image'
          ? citation.locator.kind !== 'image'
          : source.mediaType === 'audio' || source.mediaType === 'video'
            ? citation.locator.kind !== 'audio'
            : !['text', 'document', 'slide'].includes(citation.locator.kind);
      })
    )
      throw new TypeError('INVALID_WORKSPACE_CITATION');
  }
  // Preflight every public string; course instructions and staged paths are private.
  safeText(course.name);
  safeText(course.professorName);
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      safeText(node);
      if (course.userInstructions.length > 0 && node.includes(course.userInstructions))
        throw new TypeError('WORKSPACE_PRIVATE_INSTRUCTION_ECHO');
    } else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') Object.values(node).forEach(visit);
  };
  visit(content);
  visit(input.provenance);
  for (const source of sources) attachmentPath(course.folderName, source);
  return input;
};

const chunks = (text: string, limit = 85_000): readonly string[] => {
  const result: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const line = remaining.lastIndexOf('\n', limit);
    const end =
      line > limit / 2
        ? line
        : limit - (/[\uD800-\uDBFF]/u.test(remaining[limit - 1] ?? '') ? 1 : 0);
    result.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) result.push(remaining);
  return result;
};
const sections = (id: string, blocks: readonly string[]): readonly GeneratedSection[] =>
  chunks(blocks.join('\n\n')).map((markdown, index) => ({ id: `${id}_${index}`, markdown }));
type Topic = StudyContentResult['topics'][number];
const evidence = (
  topic: Topic,
  ids: readonly string[],
  attachments: readonly WorkspaceAttachment[],
): string =>
  renderEvidenceCitations(
    [...new Set(ids)].map((id) => {
      const citation = topic.citations.find((item) => item.evidenceId === id);
      const attachment = attachments.find((item) => item.sourceId === citation?.sourceId);
      if (!citation || !attachment) throw new TypeError('INVALID_WORKSPACE_CITATION');
      const loc = citation.locator;
      const label =
        loc.kind === 'audio'
          ? `audio ${loc.startMs}–${loc.endMs} ms`
          : loc.kind === 'text'
            ? `lines ${loc.startLine}–${loc.endLine}`
            : loc.kind === 'document'
              ? `page ${loc.page}`
              : loc.kind === 'slide'
                ? `slide ${loc.slide}`
                : `image region (${loc.x}, ${loc.y}, ${loc.width}, ${loc.height})`;
      return {
        evidenceId: id,
        relativePath: attachment.relativePath,
        label: `${citation.sourceId} · ${label}`,
      };
    }),
  );
const itemBlocks = (
  topic: Topic,
  item: StudyItem,
  attachments: readonly WorkspaceAttachment[],
  type?: 'important' | 'warning' | 'example' | 'summary' | 'question',
): readonly string[] => {
  const details =
    'symbols' in item ? topic.formulas.find((formula) => formula.id === item.id) : undefined;
  const signal = topic.professorSignals.find((candidate) => candidate.id === item.id);
  const conflict = topic.conflicts.find((candidate) => candidate.id === item.id);
  const body = [
    safeText(item.text),
    `Claim: ${item.id} · ${item.status}`,
    ...(item.uncertainty ? [safeText(item.uncertainty)] : []),
    ...(signal ? [signal.observationKind, signal.inference] : []),
    ...(details
      ? [
          ...details.symbols.map((symbol) =>
            safeText(`${symbol.symbol}: ${symbol.meaning} (${symbol.unit ?? '단위 미지정'})`),
          ),
          ...details.assumptions.map((text) => safeText(`가정: ${text}`)),
          ...details.conditions.map((text) => safeText(`조건: ${text}`)),
        ]
      : []),
    ...(conflict
      ? conflict.alternatives.flatMap((alternative) => [
          `${alternative.sessionDate} · ${alternative.claimId}`,
          evidence(topic, alternative.evidenceIds, attachments),
        ])
      : []),
    evidence(topic, item.evidenceIds, attachments),
  ].join('\n\n');
  const parts = chunks(body, 70_000);
  const anchor = evidence(topic, item.evidenceIds.slice(0, 1), attachments);
  return parts.map((part) =>
    type
      ? renderCallout({
          type,
          title: '근거 기반 학습',
          body: parts.length > 1 ? `${part}\n\n${anchor}` : part,
        })
      : part,
  );
};
const baseViews = () =>
  [
    { id: 'recent-lectures', name: '최근 강의노트', noteKinds: ['lecture'] },
    { id: 'attention-needed', name: '검토 필요', noteKinds: ['lecture', 'concept'] },
    { id: 'exam-candidates', name: '시험 후보', noteKinds: ['lecture', 'concept'] },
    { id: 'question-counts', name: '질문 수', noteKinds: ['question_bank', 'question_inbox'] },
    { id: 'latest-exam-packages', name: '최근 시험', noteKinds: ['course'] },
  ].map((view) => ({
    ...view,
    type: 'table',
    properties: ['stable_id', 'note_type', 'updated_at', 'question_count'],
  }));

type ProjectionContext = Readonly<{
  input: WorkspacePublicationInput;
  attachments: readonly WorkspaceAttachment[];
  previous: CourseWorkspaceState | null;
  priorNotes: readonly ManagedMarkdownDocument[];
  courses: readonly z.infer<typeof CourseSchema>[];
  coursePaths: readonly Readonly<{ courseId: string; relativePath: string }>[];
  courseMainPath: string;
  existingTopics: readonly z.infer<typeof ExistingTopicDescriptorSchema>[];
  userRegionBytes: Readonly<Record<string, number>>;
}>;

const DOCUMENT_BYTES = 16 * 1024 ** 2;
const DEFAULT_USER_BYTES = Buffer.byteLength('\n사용자 메모를 이 영역에 작성하세요.\n');
/** Budget the renderer output, not UTF-16 prose length; retain every section. */
export const splitManagedNoteParts = (
  document: ManagedMarkdownDocument,
  revision: string,
  userRegionBytes: Readonly<Record<string, number>>,
): readonly ManagedMarkdownDocument[] => {
  assertPartitionedWorkspaceData(
    document,
    ['stableId', 'kind', 'relativePath', 'properties', 'relatedSourceIds'],
    { generatedSections: 200_000 },
  );
  const source = document.generatedSections.map((section) => GeneratedSectionSchema.parse(section));
  if (new Set(source.map((section) => section.id)).size !== source.length)
    throw new TypeError('DUPLICATE_WORKSPACE_SECTION');
  const parts: ManagedMarkdownDocument[] = [];
  let cursor = 0;
  const priorParts = Object.keys(userRegionBytes)
    .filter((id) => id.startsWith(`${document.stableId}_part_`))
    .map((id) => Number(id.slice(`${document.stableId}_part_`.length)))
    .filter(Number.isSafeInteger);
  const lastPriorPart = Math.max(0, ...priorParts);
  do {
    const index = parts.length;
    if (index >= 2000) throw new TypeError('WORKSPACE_DOCUMENT_LIMIT');
    const stableId = index === 0 ? document.stableId : `${document.stableId}_part_${index}`;
    const base = ManagedMarkdownDocumentSchema.parse(
      cleanCopy({
        ...document,
        stableId,
        relativePath:
          index === 0
            ? document.relativePath
            : `${document.relativePath.slice(0, -3)}--part-${index}.md`,
        properties: { ...document.properties, stable_id: stableId },
        generatedSections: [],
      }),
    );
    const emptyBytes = Buffer.byteLength(renderMarkdownDocument(base, revision));
    let renderedBytes =
      emptyBytes +
      Math.max(0, (userRegionBytes[stableId] ?? DEFAULT_USER_BYTES) - DEFAULT_USER_BYTES);
    let jsonBytes = Buffer.byteLength(JSON.stringify(base));
    if (renderedBytes > DOCUMENT_BYTES) throw new TypeError('WORKSPACE_DOCUMENT_LIMIT');
    const generatedSections: GeneratedSection[] = [];
    while (cursor < source.length && generatedSections.length < 100) {
      const section = source[cursor];
      if (!section) break;
      const cost =
        Buffer.byteLength(
          renderMarkdownDocument({ ...base, generatedSections: [section] }, revision),
        ) - emptyBytes;
      const jsonCost =
        Buffer.byteLength(JSON.stringify(section)) + (generatedSections.length > 0 ? 1 : 0);
      if (renderedBytes + cost > DOCUMENT_BYTES || jsonBytes + jsonCost > DOCUMENT_BYTES) break;
      generatedSections.push(section);
      renderedBytes += cost;
      jsonBytes += jsonCost;
      cursor += 1;
    }
    if (
      generatedSections.length === 0 &&
      cursor < source.length &&
      userRegionBytes[stableId] === undefined
    )
      throw new TypeError('WORKSPACE_DOCUMENT_LIMIT');
    parts.push(ManagedMarkdownDocumentSchema.parse({ ...base, generatedSections }));
  } while (cursor < source.length || parts.length <= lastPriorPart);
  return parts;
};

export const projectCourseWorkspace = (raw: unknown) => {
  assertPartitionedWorkspaceData(
    raw,
    ['input', 'previous', 'courseMainPath', 'existingTopics', 'userRegionBytes'],
    { attachments: 32, priorNotes: 2000, courses: 1000, coursePaths: 1000 },
  );
  const context = z
    .strictObject({
      input: InputSchema,
      attachments: z.array(AttachmentSchema).max(32),
      previous: CourseStateSchema.nullable(),
      priorNotes: z.array(ManagedMarkdownDocumentSchema).max(2000),
      courses: z.array(CourseSchema).max(1000),
      coursePaths: z
        .array(z.strictObject({ courseId: z.uuid(), relativePath: VaultRelativePathSchema }))
        .max(1000),
      courseMainPath: VaultRelativePathSchema,
      existingTopics: z.array(ExistingTopicDescriptorSchema).max(100),
      userRegionBytes: z.record(Id, z.int().min(0).max(DOCUMENT_BYTES)),
    })
    .parse(raw) as ProjectionContext;
  if (
    new Set(context.priorNotes.map((note) => note.stableId)).size !== context.priorNotes.length ||
    new Set(context.priorNotes.map((note) => note.relativePath.toLowerCase())).size !==
      context.priorNotes.length
  )
    throw new TypeError('DUPLICATE_WORKSPACE_NOTE');
  const input = parseWorkspacePublication(context.input);
  const layout = Object.freeze({
    ...courseWorkspaceLayout(input.course),
    courseMainPath: context.courseMainPath,
  });
  const inputSha256 = workspaceHash(
    JSON.stringify({
      jobId: input.job.id,
      sources: input.sources.map((s) => ({ id: s.id, sha256: s.sha256 })),
      content: input.content,
      provenance: input.provenance,
    }),
  );
  const generationRevision = inputSha256;
  const previous = context.previous;
  if (
    previous &&
    (previous.courseId !== input.course.id || previous.folderName !== input.course.folderName)
  )
    throw new TypeError('WORKSPACE_COURSE_IDENTITY_CHANGED');
  const attachments = [
    ...(previous?.attachments ?? []).filter(
      (s) => !context.attachments.some((a) => a.sourceId === s.sourceId),
    ),
    ...context.attachments,
  ];
  if (
    context.attachments.length !== input.sources.length ||
    input.sources.some(
      (s) =>
        !context.attachments.some(
          (a) => a.sourceId === s.id && a.sha256 === s.sha256 && a.sizeBytes === s.sizeBytes,
        ),
    )
  )
    throw new TypeError('WORKSPACE_ATTACHMENT_MISSING');
  const summaryMode = previous?.summaryMode ?? input.job.summaryMode;
  const notes: ManagedMarkdownDocument[] = [];
  const properties = (stableId: string, kind: ManagedMarkdownDocument['kind']) => ({
    stable_id: stableId,
    course_id: input.course.id,
    note_type: kind,
    locked: false,
    updated_at: input.bundle.createdAt,
    review_status: 'verified',
    job_id: input.job.id,
    source_ids: input.sources.map((s) => s.id),
    source_links: context.attachments.map((a) => renderObsidianLink(a.relativePath)),
    generation_model: input.provenance.at(-1)?.modelId ?? 'unknown',
    prompt_version: input.provenance.at(-1)?.promptVersion ?? 'unknown',
    session_dates: [...new Set(input.content.topics.flatMap((topic) => topic.sessionDates))].sort(),
    question_count: 0,
  });
  const add = (
    stableId: string,
    kind: ManagedMarkdownDocument['kind'],
    path: string,
    blocks: readonly string[],
    cumulative = true,
  ) => {
    const prefix = `j${input.job.id.replaceAll('-', '')}`;
    const old = cumulative
      ? context.priorNotes.filter(
          (note) => note.stableId === stableId || note.stableId.startsWith(`${stableId}_part_`),
        )
      : [];
    const generated = [
      ...old
        .flatMap((note) => note.generatedSections)
        .filter((s) => !s.id.startsWith(`${prefix}_`)),
      ...sections(prefix, blocks),
    ];
    const relatedSourceIds = [
      ...new Set([...old.flatMap((n) => n.relatedSourceIds), ...input.sources.map((s) => s.id)]),
    ];
    const priorStrings = (key: string) =>
      old.flatMap((note) => {
        const value = note.properties[key];
        return Array.isArray(value)
          ? value.filter((item): item is string => typeof item === 'string')
          : [];
      });
    notes.push(
      ...splitManagedNoteParts(
        {
          stableId,
          kind,
          relativePath: path,
          relatedSourceIds,
          generatedSections: generated,
          properties: {
            ...properties(stableId, kind),
            ...(kind === 'question_inbox'
              ? {
                  question_count:
                    old.find((note) => note.stableId === stableId)?.properties.question_count ?? 0,
                }
              : {}),
            source_ids: relatedSourceIds,
            source_links: [
              ...new Set([
                ...priorStrings('source_links'),
                ...attachments
                  .filter((a) => relatedSourceIds.includes(a.sourceId))
                  .map((a) => renderObsidianLink(a.relativePath)),
              ]),
            ],
            session_dates: [
              ...new Set([
                ...priorStrings('session_dates'),
                ...input.content.topics.flatMap((topic) => topic.sessionDates),
              ]),
            ].sort(),
          },
        },
        generationRevision,
        context.userRegionBytes,
      ),
    );
  };
  const topicStates = [...(previous?.topics ?? [])];
  for (const topic of input.content.topics) {
    const topicId = topic.existingTopicId ?? topic.cluster.id;
    const prior = previous?.topics.find((t) => t.descriptor.id === topicId);
    if (topic.action === 'merge' && !prior) throw new TypeError('WORKSPACE_MERGE_TARGET_MISSING');
    const path =
      prior?.relativePath ??
      topicNotePath({ courseFolderName: input.course.folderName, topicId, title: topic.title });
    const blocks = [
      `# ${safeText(topic.title)}`,
      `Sessions: ${topic.sessionDates.join(', ')}`,
      ...STUDY_ITEM_FIELDS.flatMap((field) =>
        topic[field].flatMap((item) =>
          itemBlocks(
            topic,
            item,
            attachments,
            field === 'outline'
              ? 'summary'
              : field === 'professorSignals'
                ? 'important'
                : field === 'examples'
                  ? 'example'
                  : field === 'exceptions' || field === 'misconceptions'
                    ? 'warning'
                    : undefined,
          ),
        ),
      ),
      ...topic.conflicts.flatMap((item) => itemBlocks(topic, item, attachments, 'warning')),
      ...(topic.cluster.uncertainty
        ? chunks(
            `${safeText(topic.cluster.uncertainty)}\n\n${evidence(topic, topic.cluster.evidenceIds, attachments)}`,
            70_000,
          ).map((body) => renderCallout({ type: 'warning', title: '불확실성', body }))
        : []),
    ];
    for (const item of [...topic.definitions, ...topic.formulas]) {
      const stableId = `concept_${item.id}`;
      const conceptPath =
        context.priorNotes.find((note) => note.stableId === stableId)?.relativePath ??
        conceptNotePath({
          courseFolderName: input.course.folderName,
          conceptId: item.id,
          title: item.text.slice(0, 80),
        });
      blocks.push(renderObsidianLink(conceptPath));
      add(stableId, 'concept', conceptPath, [
        ...itemBlocks(topic, item, attachments),
        renderObsidianLink(path),
      ]);
    }
    add(`topic_${topicId}`, 'lecture', path, blocks);
    const provenance = [...(prior?.descriptor.provenance ?? [])];
    for (const sourceId of [...new Set(topic.citations.map((c) => c.sourceId))]) {
      const before = provenance.find((p) => p.sourceId === sourceId);
      const next = {
        sourceId,
        evidenceIds: [
          ...new Set([
            ...(before?.evidenceIds ?? []),
            ...topic.citations.filter((c) => c.sourceId === sourceId).map((c) => c.evidenceId),
          ]),
        ].sort(),
      };
      const at = provenance.findIndex((p) => p.sourceId === sourceId);
      if (at < 0) provenance.push(next);
      else provenance.splice(at, 1, next);
    }
    const descriptor = ExistingTopicDescriptorSchema.parse({
      id: topicId,
      courseId: input.course.id,
      title: prior?.descriptor.title ?? topic.title,
      aliases: [...new Set([...(prior?.descriptor.aliases ?? []), topic.title])],
      summary: prior?.descriptor.summary || topic.title,
      sessionDates: [
        ...new Set([...(prior?.descriptor.sessionDates ?? []), ...topic.sessionDates]),
      ].sort(),
      acceptedContentSha256: workspaceHash(
        JSON.stringify([prior?.descriptor.acceptedContentSha256 ?? null, topic]),
      ),
      provenance,
    });
    const index = topicStates.findIndex((t) => t.descriptor.id === topicId);
    if (index >= 0) topicStates.splice(index, 1, { descriptor, relativePath: path });
    else topicStates.push({ descriptor, relativePath: path });
  }
  const courseId = input.course.id;
  add(
    `profile_${courseId}`,
    'professor_profile',
    layout.professorProfilePath,
    input.content.topics.flatMap((topic) =>
      topic.professorSignals.flatMap((item) => itemBlocks(topic, item, attachments, 'important')),
    ),
  );
  add(
    `memory_${courseId}`,
    'memory',
    layout.memoryPath,
    input.content.topics.flatMap((topic) =>
      [...topic.definitions, ...topic.formulas].flatMap((item) => [
        `- [ ] ${safeText(item.text)}`,
        ...itemBlocks(topic, item, attachments, 'question'),
      ]),
    ),
  );
  add(
    `source_questions_${courseId}`,
    'question_bank',
    layout.sourceQuestionBankPath,
    context.attachments
      .filter((a) => a.mediaType === 'image')
      .flatMap((a) => [
        '원본 이미지 (원문)',
        `Source: ${a.sourceId}`,
        renderObsidianEmbed(a.relativePath),
      ]),
  );
  add(`predicted_${courseId}`, 'question_bank', layout.predictedQuestionBankPath, [
    'AI 예상문제가 아직 생성되지 않았습니다.',
  ]);
  add(`variants_${courseId}`, 'question_bank', layout.variantQuestionBankPath, [
    'AI 변형문제가 아직 생성되지 않았습니다.',
  ]);
  add(`inbox_${courseId}`, 'question_inbox', layout.questionInboxPath, [
    '학습 질문을 사용자 메모 영역에 기록하세요.',
  ]);
  if (summaryMode !== 'none')
    add(
      `summary_${courseId}`,
      'memory',
      `${layout.courseRoot}/핵심정리.md`,
      input.content.topics.flatMap((topic) => [
        renderObsidianLink(
          topicStates.find((t) => t.descriptor.id === (topic.existingTopicId ?? topic.cluster.id))
            ?.relativePath,
        ),
        ...topic.outline.flatMap((item) => itemBlocks(topic, item, attachments, 'summary')),
      ]),
    );
  const allNotes = [
    ...context.priorNotes.filter((old) => !notes.some((note) => note.stableId === old.stableId)),
    ...notes,
  ];
  const noteMetadata = allNotes.map((note) => ({
    stableId: note.stableId,
    relativePath: note.relativePath,
    kind: note.kind,
    sourceIds: [...note.relatedSourceIds],
  }));
  const graphNodes: MindMapLayoutInput['nodes'] = [
    { id: 'course', role: 'center', depth: 0, type: 'file', file: layout.courseMainPath },
    ...allNotes
      .filter((n) => n.kind === 'lecture' || n.kind === 'concept')
      .map((n) => ({
        id: n.stableId,
        role: n.kind === 'lecture' ? ('topic' as const) : ('concept' as const),
        depth: n.kind === 'lecture' ? 1 : 2,
        type: 'file' as const,
        file: n.relativePath,
      })),
    ...attachments.map((a) => ({
      id: `source_${a.sourceId}`,
      role: 'media' as const,
      depth: 2,
      type: 'file' as const,
      file: a.relativePath,
    })),
  ];
  const graph = layoutMindMap({
    nodes: graphNodes,
    edges: graphNodes
      .filter((n) => n.id !== 'course')
      .map((node, index) => ({
        id: `edge_${index}`,
        fromNode: 'course',
        toNode: node.id,
        label: '포함',
      })),
  });
  const courseMain = ManagedMarkdownDocumentSchema.parse({
    stableId: `course_${courseId}`,
    kind: 'course',
    relativePath: layout.courseMainPath,
    properties: {
      ...properties(`course_${courseId}`, 'course'),
      source_ids: attachments.map((attachment) => attachment.sourceId),
      source_links: attachments.map((attachment) => renderObsidianLink(attachment.relativePath)),
      session_dates: [
        ...new Set(
          allNotes.flatMap((note) => {
            const dates = note.properties.session_dates;
            return Array.isArray(dates)
              ? dates.filter((date): date is string => typeof date === 'string')
              : [];
          }),
        ),
      ].sort(),
    },
    relatedSourceIds: attachments.map((attachment) => attachment.sourceId),
    generatedSections: sections('index', [
      `# ${safeText(input.course.name)}`,
      ...allNotes.map((note) => renderObsidianLink(note.relativePath)),
      ...attachments.map((a) => renderObsidianLink(a.relativePath)),
      renderObsidianLink(layout.courseCanvasPath),
      renderObsidianLink(layout.courseSvgPath),
      renderObsidianLink(layout.courseBasePath),
    ]),
  });
  const dashboard = ManagedMarkdownDocumentSchema.parse({
    stableId: 'dashboard',
    kind: 'dashboard',
    relativePath: layout.dashboardPath,
    properties: { note_type: 'dashboard', locked: false },
    relatedSourceIds: [],
    generatedSections: sections('courses', [
      renderObsidianLink(layout.dashboardBasePath),
      ...context.courses
        .filter((c) => !c.archived)
        .map((c) =>
          renderObsidianLink(
            c.id === input.course.id
              ? layout.courseMainPath
              : (context.coursePaths.find((path) => path.courseId === c.id)?.relativePath ??
                  courseWorkspaceLayout(c).courseMainPath),
          ),
        ),
    ]),
  });
  const makeBase = (global: boolean) =>
    ObsidianBaseDocumentSchema.parse({
      stableId: global ? 'dashboard_base' : `base_${courseId}`,
      kind: 'base',
      relativePath: global ? layout.dashboardBasePath : layout.courseBasePath,
      courseId: global ? null : courseId,
      views: baseViews(),
    });
  const projection = WorkspaceProjectionSchema.parse({
    courseId,
    courseRoot: layout.courseRoot,
    dashboard,
    dashboardBase: makeBase(true),
    courseMain,
    notes,
    artifacts: [
      makeBase(false),
      {
        stableId: `canvas_${courseId}`,
        kind: 'canvas',
        relativePath: layout.courseCanvasPath,
        ...graph,
      },
      { stableId: `svg_${courseId}`, kind: 'svg', relativePath: layout.courseSvgPath, ...graph },
    ],
  });
  const state = CourseStateSchema.parse(
    cleanCopy({
      courseId,
      folderName: input.course.folderName,
      courseMainPath: layout.courseMainPath,
      summaryMode,
      topics: topicStates,
      notes: noteMetadata,
      attachments,
      jobs: [
        ...(previous?.jobs ?? []).filter((job) => job.jobId !== input.job.id),
        {
          jobId: input.job.id,
          inputSha256,
          sourceIds: input.sources.map((s) => s.id),
          existingTopics: context.existingTopics,
          generationRevision,
          timestamp: input.bundle.createdAt,
          provenance: input.provenance,
        },
      ],
    }),
  );
  parseExistingTopics(
    state.topics.map((t) => cleanCopy(t.descriptor)),
    courseId,
  );
  return Object.freeze({ projection, state, generationRevision, inputSha256 });
};
