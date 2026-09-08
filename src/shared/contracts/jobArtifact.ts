import { win32 } from 'node:path';
import { z } from 'zod';
import { isSafeWindowsPathSegment } from './windowsPath';

export const JOB_ARTIFACT_KINDS = ['recording_note', 'source_archive'] as const;

export const JobArtifactKindSchema = z.enum(JOB_ARTIFACT_KINDS);

const ManagedRelativePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes('\0') && !win32.isAbsolute(value))
  .refine((value) => {
    const segments = value.split('/');
    return (
      segments.length > 0 &&
      segments.every((segment) => segment.length <= 180 && isSafeWindowsPathSegment(segment))
    );
  });

export const JobArtifactSchema = z
  .strictObject({
    jobId: z.uuid(),
    kind: JobArtifactKindSchema,
    relativePath: ManagedRelativePathSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .readonly();

export type JobArtifactKind = z.infer<typeof JobArtifactKindSchema>;
export type JobArtifact = z.infer<typeof JobArtifactSchema>;
