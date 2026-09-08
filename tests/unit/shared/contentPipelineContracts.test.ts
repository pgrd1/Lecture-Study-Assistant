import { describe, expect, it } from 'vitest';
import { ContentClassificationSchema } from '../../../src/shared/contracts/contentClassification';
import {
  EvidenceSegmentSchema,
  SourceLocatorSchema,
  validateEvidenceSources,
} from '../../../src/shared/contracts/evidence';
import {
  StudyContentResultSchema,
  TopicClusterSchema,
  validateStudyEvidence,
  validateTopicEvidence,
} from '../../../src/shared/contracts/studyContent';

const SOURCE_ID = '123e4567-e89b-42d3-a456-426614174000';
const EVIDENCE_ID = '123e4567-e89b-42d3-a456-426614174001';
const evidence = {
  id: EVIDENCE_ID,
  sourceId: SOURCE_ID,
  kind: 'definition',
  text: '빅오 표기법은 입력 크기에 따른 증가율을 나타낸다.',
  confidence: 0.94,
  locator: { kind: 'audio', startMs: 12_000, endMs: 19_500 },
};
describe('closed evidence pipeline contracts', () => {
  it.each([
    ['self conflict', [SOURCE_ID, SOURCE_ID], false],
    ['duplicate among distinct claims', [SOURCE_ID, EVIDENCE_ID, SOURCE_ID], false],
    ['distinct existing claims', [SOURCE_ID, EVIDENCE_ID], true],
    ['unknown claim', [SOURCE_ID, '123e4567-e89b-42d3-a456-426614174002'], false],
  ] as const)('validates conflict references: %s', (_label, claimIds, expected) => {
    const result = StudyContentResultSchema.safeParse({
      claims: [SOURCE_ID, EVIDENCE_ID].map((id) => ({
        id,
        text: 'claim',
        evidenceIds: [],
        status: 'uncertain',
        uncertainty: 'unresolved',
      })),
      conflicts: [{ claimIds, description: 'Conflicting statements' }],
      sessionDates: [],
    });
    expect(result.success).toBe(expected);
    if (result.success) expect(Object.isFrozen(result.data.conflicts[0]?.claimIds)).toBe(true);
  });
  it('retains multiple classification types and located syllabus facts without invented dates', () => {
    const result = ContentClassificationSchema.parse({
      sourceId: SOURCE_ID,
      types: ['orientation', 'syllabus'],
      sections: [],
      facts: [
        {
          kind: 'grading_component',
          text: 'Final exam 40%',
          confidence: 0.9,
          uncertainty: null,
          locator: { kind: 'document', page: 1 },
          date: null,
          weightPercent: 40,
        },
      ],
      confidence: 0.9,
      uncertainty: null,
      sessionDate: null,
    });
    expect(result.types).toEqual(['orientation', 'syllabus']);
    expect(result.facts[0]?.date).toBeNull();
    expect(Object.isFrozen(result.facts[0])).toBe(true);
    expect(
      ContentClassificationSchema.safeParse({
        ...result,
        facts: [{ ...result.facts[0], weightPercent: 101 }],
      }).success,
    ).toBe(false);
  });
  it('requires every evidence claim to point to a typed source locator', () => {
    const result = EvidenceSegmentSchema.parse(evidence);
    expect(result).toMatchObject({ sourceId: SOURCE_ID, locator: { kind: 'audio' } });
    expect(Object.isFrozen(result.locator)).toBe(true);
    expect(EvidenceSegmentSchema.safeParse({ ...evidence, locator: undefined }).success).toBe(
      false,
    );
    expect(EvidenceSegmentSchema.safeParse({ ...evidence, trusted: true }).success).toBe(false);
    expect(EvidenceSegmentSchema.safeParse({ ...evidence, confidence: 2 }).success).toBe(false);
  });
  it.each([
    { kind: 'audio', startMs: -1, endMs: 2 },
    { kind: 'audio', startMs: 3, endMs: 2 },
    { kind: 'document', page: 0 },
    { kind: 'slide', slide: 0 },
    { kind: 'image', x: -1, y: 0, width: 1, height: 1 },
    { kind: 'image', x: 0.9, y: 0, width: 0.2, height: 1 },
    { kind: 'text', startLine: 2, endLine: 1 },
  ])('rejects invalid locator %j', (locator) =>
    expect(SourceLocatorSchema.safeParse(locator).success).toBe(false),
  );
  it('validates references against known sources and evidence', () => {
    expect(() => validateEvidenceSources([EvidenceSegmentSchema.parse(evidence)], [])).toThrow();
    expect(
      validateEvidenceSources([EvidenceSegmentSchema.parse(evidence)], [SOURCE_ID]),
    ).toHaveLength(1);
    const result = StudyContentResultSchema.parse({
      claims: [
        {
          id: SOURCE_ID,
          text: 'claim',
          evidenceIds: [EVIDENCE_ID],
          status: 'source_supported',
          uncertainty: null,
        },
      ],
      conflicts: [],
      sessionDates: [],
    });
    expect(() => validateStudyEvidence(result, [])).toThrow();
    expect(validateStudyEvidence(result, [EVIDENCE_ID])).toEqual(result);
    expect(
      StudyContentResultSchema.safeParse({
        ...result,
        claims: [{ ...result.claims[0], evidenceIds: [] }],
      }).success,
    ).toBe(false);
  });
  it('bounds and freezes classification and topic results', () => {
    const classification = ContentClassificationSchema.parse({
      sourceId: SOURCE_ID,
      types: ['lecture_recording'],
      sections: [],
      facts: [],
      confidence: 0.8,
      uncertainty: null,
      sessionDate: null,
    });
    expect(Object.isFrozen(classification)).toBe(true);
    expect(ContentClassificationSchema.safeParse({ ...classification, extra: true }).success).toBe(
      false,
    );
    const topic = TopicClusterSchema.parse({
      id: SOURCE_ID,
      title: 'topic',
      evidenceIds: [EVIDENCE_ID],
      uncertainty: null,
    });
    expect(Object.isFrozen(topic.evidenceIds)).toBe(true);
    expect(() => validateTopicEvidence([topic], [])).toThrow('INVALID_TOPIC_EVIDENCE_REFERENCE');
    expect(validateTopicEvidence([topic], [EVIDENCE_ID])).toEqual([topic]);
    expect(TopicClusterSchema.safeParse({ ...topic, title: 'x'.repeat(501) }).success).toBe(false);
  });
});
