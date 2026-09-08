import { createContentPipelineRuntime as createRealRuntime } from '../../src/main/contentPipelineRuntime';
import {
  METADATA_PARSER_VERSION,
  METADATA_POLICY_VERSION,
  TrustedSourceMetadataSchema,
} from '../../src/shared/contracts/sourceMetadata';

/** The legacy queue fixture contains synthetic audio bytes. Only its metadata
 * measurement is doubled; extraction, evidence checks and publication are real. */
export const createContentPipelineRuntime = (
  dependencies: Parameters<typeof createRealRuntime>[0],
) =>
  createRealRuntime({
    ...dependencies,
    metadata: {
      measure: async (source) =>
        TrustedSourceMetadataSchema.parse({
          sourceId: source.id,
          sha256: source.sha256,
          sizeBytes: source.sizeBytes,
          parserVersion: METADATA_PARSER_VERSION,
          policyVersion: METADATA_POLICY_VERSION,
          facts: { kind: 'audio', durationSeconds: 1, assurance: 'structural' },
        }),
    },
  });
