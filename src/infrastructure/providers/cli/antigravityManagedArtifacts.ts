import type { ProviderConnectionOperation } from '../../../core/ports/aiProvider';
import type { AntigravityArtifactPaths } from './antigravityCliProtocol';

export type AntigravityRequestArtifacts = AntigravityArtifactPaths;

export interface AntigravityManagedArtifacts {
  writeProfileAtomic(contents: string, operation: ProviderConnectionOperation): Promise<void>;
  verifyProfile(contents: string, operation: ProviderConnectionOperation): Promise<void>;
  prepareRequestAtomic(
    requestId: string,
    schemaJson: string | null,
    operation: ProviderConnectionOperation,
  ): Promise<AntigravityRequestArtifacts>;
  verifyRequest(
    requestId: string,
    schemaJson: string | null,
    operation: ProviderConnectionOperation,
  ): Promise<void>;
  cleanupRequest(requestId: string): Promise<void>;
  cleanupProfileTransients(): Promise<void>;
}
