import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { ProcessorPort, ProcessorResult } from '../core/ports/processor';
import { ProcessorInputSchema, ProcessorResultSchema } from '../core/ports/processor';

const escapeMarkdown = (value: string): string =>
  value.replace(/[\\`*_[\]{}()#+.!|<>-]/gu, (character) => `\\${character}`);

/** Test fixture only. Production must inject the evidence runtime's compatibility processor. */
export class FakeProcessor implements ProcessorPort {
  async process(input: Parameters<ProcessorPort['process']>[0]): Promise<ProcessorResult> {
    const parsed = ProcessorInputSchema.parse(input);
    const extension = extname(parsed.sourceFileName);
    const title = parsed.sourceFileName.slice(0, -extension.length);
    const markdownBody = `# ${escapeMarkdown(title)}

> 가짜 처리 결과 — 실제 전사 아님

## 처리 메타데이터

- 과목 ID: \`${parsed.courseId}\`
- 작업 ID: \`${parsed.jobId}\`
- 원본 유형: \`${parsed.sourceMediaType}\`
- 요약 모드: \`${parsed.summaryMode}\`
- 원본 SHA-256: \`${parsed.sourceSha256}\`

## 핵심 정리

이 문서는 파이프라인 검증용 결정적 결과입니다. 실제 AI 전사·요약은 공급자 어댑터 연결 후 생성됩니다.
`;
    return ProcessorResultSchema.parse({
      title,
      markdownBody,
      baseSha256: createHash('sha256').update(markdownBody, 'utf8').digest('hex'),
    });
  }
}
