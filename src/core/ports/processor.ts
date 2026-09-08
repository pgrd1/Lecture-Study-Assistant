import { z } from 'zod';
import { SourceMediaTypeSchema, SummaryModeSchema } from '../../shared/contracts/job';
import { SupportedSourceFileNameSchema } from '../../shared/contracts/sourceFile';

export const ProcessorInputSchema = z
  .strictObject({
    jobId: z.uuid(),
    courseId: z.uuid(),
    sourceFileName: SupportedSourceFileNameSchema,
    sourceMediaType: SourceMediaTypeSchema,
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    summaryMode: SummaryModeSchema,
  })
  .readonly();

export const ProcessorResultSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(180),
    markdownBody: z.string().min(1).max(2_000_000),
    baseSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .readonly();

export type ProcessorInput = z.infer<typeof ProcessorInputSchema>;
export type ProcessorResult = z.infer<typeof ProcessorResultSchema>;

export interface ProcessorPort {
  process(input: ProcessorInput): Promise<ProcessorResult>;
}
