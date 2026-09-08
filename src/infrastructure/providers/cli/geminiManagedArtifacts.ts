import type {
  CliRuntimeBinding,
  ProviderConnectionOperation,
} from '../../../core/ports/aiProvider';
import type {
  GeminiBinding,
  GeminiManagedProfile,
  GeminiRequestArtifacts,
  GeminiSettingsSchemaSnapshot,
} from './geminiCliProtocol';

export interface GeminiManagedArtifacts {
  readSettingsSchemaSnapshot(
    binding: GeminiBinding,
    operation: ProviderConnectionOperation,
  ): Promise<GeminiSettingsSchemaSnapshot>;
  writeProfileAtomic(
    profile: GeminiManagedProfile,
    operation: ProviderConnectionOperation,
  ): Promise<void>;
  verifyProfile(
    profile: GeminiManagedProfile,
    operation: ProviderConnectionOperation,
  ): Promise<void>;
  prepareRequestAtomic(
    requestId: string,
    operation: ProviderConnectionOperation,
  ): Promise<GeminiRequestArtifacts>;
  verifyRequest(requestId: string, operation: ProviderConnectionOperation): Promise<void>;
  cleanupRequest(requestId: string): Promise<void>;
  cleanupProfileTransients(): Promise<void>;
}

export type GeminiManagedArtifactBinding = CliRuntimeBinding<'gemini_cli', 'provider_global'>;
