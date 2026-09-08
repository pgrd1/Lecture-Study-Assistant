import type { ProviderConnectionOperation } from '../../../core/ports/aiProvider';
import type { CodexImageInput } from './codexCliMedia';
import type { CodexManagedProfile, CodexRequestArtifacts } from './codexCliProtocol';

export interface CodexManagedArtifacts {
  prepareProfileAtomic(
    profile: CodexManagedProfile,
    operation: ProviderConnectionOperation,
  ): Promise<void>;
  verifyProfile(
    profile: CodexManagedProfile,
    operation: ProviderConnectionOperation,
  ): Promise<void>;
  prepareRequestAtomic(
    requestId: string,
    schemaJson: string,
    operation: ProviderConnectionOperation,
    images?: readonly CodexImageInput[],
  ): Promise<CodexRequestArtifacts>;
  verifyRequest(
    requestId: string,
    schemaJson: string,
    schemaSha256: string,
    operation: ProviderConnectionOperation,
  ): Promise<void>;
  cleanupRequest(requestId: string): Promise<void>;
  cleanupProfileTransients(): Promise<void>;
}
