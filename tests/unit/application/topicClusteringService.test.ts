import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateTopicClusters } from '../../../src/application/content/topicClusteringService';
import { parseExistingTopics } from '../../../src/shared/contracts/studyContent';
import { required } from './contentFixtures';

const courseId = randomUUID();
const sourceId = randomUUID();
const evidence = [0, 1, 2].map(() => ({
  id: randomUUID(),
  sourceId,
  kind: 'explanation' as const,
  text: '강의',
  confidence: 1,
  locator: { kind: 'audio' as const, startMs: 0, endMs: 10 },
  sessionDate: '2026-09-09',
}));
const topics = ['시간복잡도', '배열', '연결리스트'].map((title, i) => ({
  id: randomUUID(),
  title,
  action: 'create',
  existingTopicId: null as string | null,
  evidenceIds: [evidence[i]?.id],
  uncertainty: null,
  sessionDates: ['2026-09-09'],
}));
const existing = {
  id: randomUUID(),
  courseId,
  title: '배열',
  aliases: [],
  summary: '배열의 기존 내용',
  sessionDates: ['2026-09-07'],
  acceptedContentSha256: 'a'.repeat(64),
  provenance: [{ sourceId, evidenceIds: [randomUUID()] }],
};

describe('TopicClusteringService contracts', () => {
  it('splits one recording into three exact topics and allows shared evidence', () => {
    const value = validateTopicClusters(
      {
        contentSchemaVersion: 2,
        topics: topics.map((topic, i) => ({
          ...topic,
          evidenceIds: i === 1 ? [evidence[1]?.id, evidence[0]?.id] : topic.evidenceIds,
        })),
      },
      evidence,
      [],
    );
    expect(value.topics.map((t) => t.title)).toEqual(['시간복잡도', '배열', '연결리스트']);
    expect(value.topics[1]?.evidenceIds).toHaveLength(2);
  });
  it('merges uploads into a known topic and retains old and new dates', () => {
    const value = validateTopicClusters(
      {
        contentSchemaVersion: 2,
        topics: [
          {
            ...topics[0],
            action: 'merge',
            existingTopicId: existing.id,
            evidenceIds: evidence.map((e) => e.id),
            sessionDates: ['2026-09-07', '2026-09-09'],
          },
        ],
      },
      evidence,
      parseExistingTopics([existing], courseId),
    );
    expect(value.topics[0]?.sessionDates).toEqual(['2026-09-07', '2026-09-09']);
  });
  it.each(['drop', 'foreign', 'invented', 'duplicate-target', 'dates'] as const)(
    'rejects %s cluster output',
    (failure) => {
      const bad = topics.map((t) => ({ ...t }));
      if (failure === 'drop') bad.pop();
      if (failure === 'foreign') bad[0] = { ...required(bad[0]), evidenceIds: [randomUUID()] };
      if (failure === 'invented')
        bad[0] = {
          ...required(bad[0]),
          action: 'merge',
          existingTopicId: randomUUID(),
        } as (typeof bad)[number];
      if (failure === 'duplicate-target')
        for (const i of [0, 1])
          bad[i] = {
            ...required(bad[i]),
            action: 'merge',
            existingTopicId: existing.id,
            sessionDates: ['2026-09-07', '2026-09-09'],
          } as (typeof bad)[number];
      if (failure === 'dates') bad[0] = { ...required(bad[0]), sessionDates: [] };
      expect(() =>
        validateTopicClusters({ contentSchemaVersion: 2, topics: bad }, evidence, [existing]),
      ).toThrow();
    },
  );
  it('rejects foreign-course, duplicate, excessive and accessor context before reading getters', () => {
    expect(() =>
      parseExistingTopics([{ ...existing, courseId: randomUUID() }], courseId),
    ).toThrow();
    expect(() => parseExistingTopics([existing, { ...existing }], courseId)).toThrow();
    expect(() =>
      parseExistingTopics(
        Array.from({ length: 101 }, () => ({ ...existing, id: randomUUID() })),
        courseId,
      ),
    ).toThrow();
    let accessed = false;
    expect(() =>
      parseExistingTopics(
        [
          {
            ...existing,
            get title() {
              accessed = true;
              return 'bad';
            },
          },
        ],
        courseId,
      ),
    ).toThrow();
    expect(accessed).toBe(false);
  });
});
