import { describe, expect, it } from 'vitest';
import { createProviderOperation } from '../../../../../src/core/ports/aiProvider';
import { snapshotAnthropicExecuteRequest } from '../../../../../src/infrastructure/providers/api/anthropicApiProtocol';
import { snapshotOpenAiExecuteRequest } from '../../../../../src/infrastructure/providers/api/openAiApiProtocol';

describe('protocol media snapshots', () => {
  it.each([
    ['openai', snapshotOpenAiExecuteRequest, 'gpt-5.6'],
    ['anthropic', snapshotAnthropicExecuteRequest, 'claude-sonnet-4-6'],
  ] as const)(
    'snapshots declared file metadata for %s without opening it',
    (_name, snapshot, modelId) => {
      const request = {
        ...createProviderOperation({
          requestId: '123e4567-e89b-42d3-a456-426614174000',
          feature: 'lecture_organize',
          jobId: null,
          outputSchemaId: 'lecture_output',
          outputJsonSchema: { type: 'object', additionalProperties: false },
          parseOutput: () => ({}),
          blocks: [
            {
              role: 'user',
              kind: 'source_file',
              sourceId: '123e4567-e89b-42d3-a456-426614174001',
              filePath: 'C:/private/audio.m4a',
              mediaType: 'audio',
              sha256: 'a'.repeat(64),
              sizeBytes: 100,
            },
          ],
          timeoutMs: 30_000,
          maxOutputTokens: 100,
          signal: new AbortController().signal,
        }),
        modelId,
        promptVersion: 'lecture-organize-v1',
        routeRevision: 0,
        providerManagedHistoryConsentAt: null,
        providerManagedHistoryConsentVersion: null,
        sharedCredentialConsentAt: null,
        sharedCredentialConsentVersion: null,
        attemptKind: 'initial' as const,
      };
      expect(snapshot(request).blocks).toEqual(request.blocks);
      expect(snapshot(request).blocks[0]).not.toBe(request.blocks[0]);
    },
  );
});
