import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateStudyCandidate } from '../../../src/application/content/lectureSynthesisService';
import { applyStudyVerification } from '../../../src/application/content/lectureVerificationService';
import { StudyContentV2Schema, studyItems } from '../../../src/shared/contracts/studyContent';
import { required } from './contentFixtures';

const studyFixture = () => {
  const sourceId = randomUUID();
  const evidence = ['2026-09-07', '2026-09-09'].map((sessionDate) => ({
    id: randomUUID(),
    sourceId,
    kind: 'formula' as const,
    text: 'E = mc²',
    confidence: 1,
    locator: { kind: 'document' as const, page: 1 },
    sessionDate,
  }));
  const cluster = {
    id: randomUUID(),
    title: 'Energy 에너지',
    action: 'create' as const,
    existingTopicId: null,
    evidenceIds: evidence.map((e) => e.id),
    uncertainty: null,
    sessionDates: ['2026-09-07', '2026-09-09'],
  };
  const claim = {
    id: randomUUID(),
    text: 'Energy E = mc²',
    evidenceIds: [required(evidence[0]).id],
    status: 'source_supported' as const,
    uncertainty: null,
  };
  const other = { ...claim, id: randomUUID(), evidenceIds: [required(evidence[1]).id] };
  const candidate = StudyContentV2Schema.parse({
    contentSchemaVersion: 2,
    topics: [
      {
        cluster,
        contentMode: 'new_topic',
        outline: [claim, other],
        explanations: [],
        definitions: [],
        formulas: [
          {
            ...claim,
            id: randomUUID(),
            symbols: [{ symbol: 'm', meaning: '질량 mass', unit: 'kg' }],
            assumptions: ['정지 질량'],
            conditions: ['진공'],
          },
        ],
        examples: [],
        exceptions: [],
        misconceptions: [],
        professorSignals: [],
        conflicts: [
          {
            ...claim,
            id: randomUUID(),
            text: '날짜별 설명 차이',
            evidenceIds: evidence.map((e) => e.id),
            alternatives: [
              { claimId: claim.id, sessionDate: '2026-09-07', evidenceIds: claim.evidenceIds },
              { claimId: other.id, sessionDate: '2026-09-09', evidenceIds: other.evidenceIds },
            ],
          },
        ],
        citations: evidence.map((e) => ({ evidenceId: e.id, sourceId, locator: { ...e.locator } })),
        sessions: evidence.map((e) => ({ date: e.sessionDate, evidenceIds: [e.id] })),
      },
    ],
  });
  const decisions = studyItems(candidate).map((item) => ({
    itemId: item.id,
    decision: 'accept' as const,
    reason: 'source matches',
    missingEvidenceIds: [],
  }));
  return {
    evidence,
    clusters: { contentSchemaVersion: 2 as const, topics: [cluster] },
    candidate,
    decisions,
  };
};

describe('Lecture synthesis and independent verification', () => {
  it('preserves structured formulas, units, assumptions and dated conflict alternatives', () => {
    const f = studyFixture();
    const result = validateStudyCandidate(f.candidate, f.evidence, f.clusters);
    expect(result.topics[0]?.formulas[0]).toMatchObject({
      text: 'Energy E = mc²',
      symbols: [{ unit: 'kg' }],
      assumptions: ['정지 질량'],
      conditions: ['진공'],
    });
    expect(result.topics[0]?.conflicts[0]?.alternatives.map((a) => a.sessionDate)).toEqual([
      '2026-09-07',
      '2026-09-09',
    ]);
  });
  it('filters exact rejected items and dependent conflicts without accepting rewritten prose', () => {
    const f = studyFixture();
    const result = applyStudyVerification(
      f.candidate,
      {
        verificationSchemaVersion: 1,
        decisions: f.decisions.map((d, i) =>
          i === 0 ? { ...d, decision: 'reject', reason: 'unsupported' } : d,
        ),
      },
      f.evidence,
    );
    expect(result.topics[0]?.outline).toHaveLength(1);
    expect(result.topics[0]).toMatchObject({
      title: 'Energy 에너지',
      action: 'create',
      existingTopicId: null,
      sessionDates: ['2026-09-07', '2026-09-09'],
    });
    expect(result.topics[0]?.conflicts).toEqual([]);
    expect(
      result.verification.decisions.some(
        (d) => d.decision === 'reject' && d.reason === 'unsupported',
      ),
    ).toBe(true);
    expect(f.candidate.topics[0]?.outline).toHaveLength(2);
  });
  it('never accepts model-only content even if the verifier accepts it', () => {
    const f = studyFixture();
    const candidate = {
      ...f.candidate,
      topics: f.candidate.topics.map((t) => ({
        ...t,
        outline: t.outline.map((item) => ({ ...item, status: 'model_only' as const })),
      })),
    };
    const result = applyStudyVerification(
      candidate,
      { verificationSchemaVersion: 1, decisions: f.decisions },
      f.evidence,
    );
    expect(result.topics[0]?.outline).toEqual([]);
    expect(result.topics[0]?.conflicts).toEqual([]);
  });
  it.each(['missing', 'duplicate', 'foreign', 'foreign-evidence'] as const)(
    'rejects %s verification decisions',
    (failure) => {
      const f = studyFixture();
      const decisions: unknown[] = [...f.decisions];
      if (failure === 'missing') decisions.pop();
      if (failure === 'duplicate') decisions.push({ ...f.decisions[0] });
      if (failure === 'foreign') decisions[0] = { ...f.decisions[0], itemId: randomUUID() };
      if (failure === 'foreign-evidence')
        decisions[0] = { ...f.decisions[0], missingEvidenceIds: [randomUUID()] };
      expect(() =>
        applyStudyVerification(
          f.candidate,
          { verificationSchemaVersion: 1, decisions },
          f.evidence,
        ),
      ).toThrow();
    },
  );
  it('rejects invented citations, dates, duplicate item IDs and personality inference', () => {
    const f = studyFixture();
    const mutate = (fields: object) => ({
      ...f.candidate,
      topics: f.candidate.topics.map((t) => ({ ...t, ...fields })),
    });
    expect(() =>
      validateStudyCandidate(
        mutate({
          citations: [
            {
              evidenceId: required(f.evidence[0]).id,
              sourceId: randomUUID(),
              locator: { kind: 'document', page: 1 },
            },
          ],
        }),
        f.evidence,
        f.clusters,
      ),
    ).toThrow();
    expect(() =>
      validateStudyCandidate(mutate({ sessions: [] }), f.evidence, f.clusters),
    ).toThrow();
    expect(() =>
      validateStudyCandidate(
        mutate({ explanations: required(f.candidate.topics[0]).outline }),
        f.evidence,
        f.clusters,
      ),
    ).toThrow();
    expect(() =>
      validateStudyCandidate(
        mutate({
          professorSignals: [
            {
              ...required(f.candidate.topics[0]).outline[0],
              id: randomUUID(),
              observationKind: 'personality',
              inference: 'exam_guarantee',
            },
          ],
        }),
        f.evidence,
        f.clusters,
      ),
    ).toThrow();
  });
});
