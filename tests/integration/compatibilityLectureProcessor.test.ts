import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CompatibilityLectureProcessor } from '../../src/application/content/compatibilityLectureProcessor';
import { VerifiedStudyContentSchema } from '../../src/shared/contracts/studyContent';
import { TEST_IDS } from '../testkit/fixtures';
import { createFoundationServices } from '../testkit/foundationServices';
import { withTempDirectory } from '../testkit/tempDirectory';

const result = () =>
  VerifiedStudyContentSchema.parse({
    contentSchemaVersion: 2,
    topics: [
      {
        cluster: {
          id: '11111111-1111-4111-8111-111111111111',
          title: '[에너지](danger)',
          action: 'merge',
          existingTopicId: '22222222-2222-4222-8222-222222222222',
          evidenceIds: ['44444444-4444-4444-8444-444444444444'],
          uncertainty: null,
          sessionDates: ['2026-09-07', '2026-09-09'],
        },
        contentMode: 'merge_delta',
        title: '[에너지](danger)',
        action: 'merge',
        existingTopicId: '22222222-2222-4222-8222-222222222222',
        sessionDates: ['2026-09-07', '2026-09-09'],
        outline: [],
        explanations: [],
        definitions: [],
        formulas: [],
        examples: [],
        exceptions: [],
        misconceptions: [],
        professorSignals: [],
        conflicts: [],
        citations: [
          {
            evidenceId: '44444444-4444-4444-8444-444444444444',
            sourceId: '55555555-5555-4555-8555-555555555555',
            locator: { kind: 'audio', startMs: 1000, endMs: 2500 },
          },
        ],
        sessions: [
          { date: '2026-09-07', evidenceIds: [] },
          { date: '2026-09-09', evidenceIds: ['44444444-4444-4444-8444-444444444444'] },
        ],
      },
    ],
    verification: { verificationSchemaVersion: 1, decisions: [] },
  });

describe('CompatibilityLectureProcessor', () => {
  it('renders deterministic escaped titles, merge deltas, dates and human-readable citations with an exact body hash', async () =>
    withTempDirectory(async (root) => {
      const f = await createFoundationServices(root);
      try {
        const course = await f.courseService.create({ name: '물리', professorName: '' });
        const file = join(root, 'lecture.txt');
        await writeFile(file, 'source');
        const [job] = await f.localIntake.enqueue({
          courseId: course.id,
          filePaths: [file],
          summaryMode: 'standard',
        });
        if (!job) throw new Error('Missing fixture job');
        const adapter = new CompatibilityLectureProcessor({
          bundles: f.repositories.sourceBundles,
          jobs: f.repositories.jobs,
          existingTopics: () => [],
          processor: { processBundle: async () => result() },
        });
        const input = {
          jobId: job.id,
          courseId: course.id,
          sourceFileName: job.sourceFileName,
          sourceMediaType: job.sourceMediaType,
          sourceSha256: job.sourceSha256,
          summaryMode: job.summaryMode,
        };
        const first = await adapter.process(input);
        expect(await adapter.process(input)).toEqual(first);
        expect(first.markdownBody).toContain('\\[에너지\\]\\(danger\\)');
        expect(first.markdownBody).toContain('merge_delta');
        expect(first.markdownBody).toContain('2026-09-07, 2026-09-09');
        expect(first.markdownBody).toContain(
          '55555555-5555-4555-8555-555555555555 · audio 1000–2500 ms',
        );
        expect(first.markdownBody).not.toContain(root);
        expect(first.markdownBody.startsWith('---')).toBe(false);
        expect(first.baseSha256).toBe(
          createHash('sha256').update(first.markdownBody, 'utf8').digest('hex'),
        );
      } finally {
        f.database.close();
      }
    }));
  it('runs through JobRunner using the adapter without modifying its interface', async () =>
    withTempDirectory(async (root) => {
      const f = await createFoundationServices(root);
      try {
        await f.courseService.create({ name: '물리', professorName: '' });
        const file = join(root, 'lecture.txt');
        await writeFile(file, 'source');
        const [job] = await f.localIntake.enqueue({
          courseId: TEST_IDS.course,
          filePaths: [file],
          summaryMode: 'standard',
        });
        if (!job) throw new Error('Missing fixture job');
        const adapter = new CompatibilityLectureProcessor({
          bundles: f.repositories.sourceBundles,
          jobs: f.repositories.jobs,
          existingTopics: () => [],
          processor: { processBundle: async () => result() },
        });
        await f.createRunner({ processor: adapter }).pollOnce();
        expect(f.repositories.jobs.get(job.id)?.status).toBe('completed');
      } finally {
        f.database.close();
      }
    }));
});
