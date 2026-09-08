import { createHash } from 'node:crypto';
import type { JobRepository } from '../../core/ports/jobRepository';
import {
  type ProcessorInput,
  ProcessorInputSchema,
  type ProcessorPort,
  ProcessorResultSchema,
} from '../../core/ports/processor';
import type { SourceBundleRepository } from '../../core/ports/sourceBundleRepository';
import type { StudyContentProcessor } from '../../core/ports/studyContentProcessor';
import { assertBoundedPipelineJson } from '../../shared/contracts/boundedPipelineJson';
import type { SourceLocator } from '../../shared/contracts/evidence';
import { JobSchema } from '../../shared/contracts/job';
import { SourceBundleSchema } from '../../shared/contracts/sourceBundle';
import {
  parseExistingTopics,
  STUDY_ITEM_FIELDS,
  type StudyContentResult,
  VerifiedStudyContentSchema,
} from '../../shared/contracts/studyContent';
import { contentError } from './pipelineOperations';

type Dependencies = Readonly<{
  processor: StudyContentProcessor;
  jobs: Pick<JobRepository, 'get'>;
  bundles: Pick<SourceBundleRepository, 'getByJobId'>;
  existingTopics: (courseId: string) => unknown | Promise<unknown>;
}>;
const escapeMarkdown = (text: string): string =>
  text
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/([\\`*_[\]{}()#+.!|~-])/gu, '\\$1');
const locatorText = (locator: SourceLocator): string => {
  switch (locator.kind) {
    case 'audio':
      return `audio ${locator.startMs}–${locator.endMs} ms`;
    case 'document':
      return `page ${locator.page}`;
    case 'slide':
      return `slide ${locator.slide}`;
    case 'text':
      return `lines ${locator.startLine}–${locator.endLine}`;
    case 'image':
      return `image region (${locator.x}, ${locator.y}, ${locator.width}, ${locator.height})`;
  }
};
export const renderStudyMarkdown = (result: StudyContentResult): string => {
  const sections = result.topics.map((topic) =>
    [
      `## ${escapeMarkdown(topic.cluster.title)}`,
      `Action: ${topic.cluster.action}; content: ${topic.contentMode}`,
      `Sessions: ${topic.cluster.sessionDates.join(', ') || 'undated'}`,
      ...(topic.cluster.existingTopicId
        ? [
            `Existing topic: ${topic.cluster.existingTopicId}`,
            'Merge delta: preserve prior accepted facts and citations.',
          ]
        : []),
      ...STUDY_ITEM_FIELDS.flatMap((field) =>
        topic[field].length === 0
          ? []
          : [`### ${field}`, ...topic[field].map((item) => `- ${escapeMarkdown(item.text)}`)],
      ),
      ...topic.formulas.flatMap((formula) => [
        ...formula.symbols.map(
          (s) =>
            `- ${escapeMarkdown(s.symbol)}: ${escapeMarkdown(s.meaning)} (${escapeMarkdown(s.unit ?? 'unit unspecified')})`,
        ),
        ...formula.assumptions.map((a) => `- Assumption: ${escapeMarkdown(a)}`),
        ...formula.conditions.map((c) => `- Condition: ${escapeMarkdown(c)}`),
      ]),
      ...topic.conflicts.flatMap((c) => [
        `### Conflict`,
        escapeMarkdown(c.text),
        ...c.alternatives.map((a) => `- ${a.sessionDate}: ${a.claimId}`),
      ]),
      '### Citations',
      ...topic.citations.map(
        (c) => `- ${c.sourceId} · ${locatorText(c.locator)} · evidence ${c.evidenceId}`,
      ),
    ].join('\n\n'),
  );
  const body = `# Lecture study topics\n\n${sections.join('\n\n')}\n`;
  if (body.length > 2_000_000 || /(?:[a-z]:[\\/]|file:\/\/)/iu.test(body)) throw contentError();
  return body;
};

/** Temporary ProcessorPort bridge. It does not own or write Vault content. */
export class CompatibilityLectureProcessor implements ProcessorPort {
  constructor(private readonly dependencies: Dependencies) {}
  async process(raw: ProcessorInput) {
    const input = ProcessorInputSchema.parse(raw);
    const job = JobSchema.parse(this.dependencies.jobs.get(input.jobId));
    const bundle = SourceBundleSchema.parse(this.dependencies.bundles.getByJobId(input.jobId));
    if (
      job.courseId !== input.courseId ||
      job.sourceBundleId !== bundle.id ||
      bundle.jobId !== job.id ||
      job.sourceSha256 !== input.sourceSha256 ||
      job.sourceFileName !== input.sourceFileName ||
      job.sourceMediaType !== input.sourceMediaType ||
      job.summaryMode !== input.summaryMode
    )
      throw contentError();
    const existingTopics = parseExistingTopics(
      await this.dependencies.existingTopics(input.courseId),
      input.courseId,
    );
    const value = await this.dependencies.processor.processBundle({
      jobId: input.jobId,
      courseId: input.courseId,
      sourceBundleId: bundle.id,
      existingTopics,
      signal: new AbortController().signal,
    });
    assertBoundedPipelineJson(value);
    const result = VerifiedStudyContentSchema.parse(value);
    const markdownBody = renderStudyMarkdown(result);
    return ProcessorResultSchema.parse({
      title: '강의 학습 주제',
      markdownBody,
      baseSha256: createHash('sha256').update(markdownBody, 'utf8').digest('hex'),
    });
  }
}
