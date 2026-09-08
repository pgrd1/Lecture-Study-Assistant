import type { CliProviderId } from '../../shared/contracts/provider';
import type { CliRuntimeBinding, ProviderConnectionOperation } from './aiProvider';

export type OpenCliLoginRequest = ProviderConnectionOperation &
  Readonly<{
    binding: CliRuntimeBinding;
    credentialPresent: boolean;
    confirmSharedCredentialMutation: boolean;
  }>;

export type OpenCliLogoutRequest = ProviderConnectionOperation &
  Readonly<{
    binding: CliRuntimeBinding;
  }>;

export interface CliLoginLauncher {
  openLogin(request: OpenCliLoginRequest): Promise<void>;
  openLogout(request: OpenCliLogoutRequest): Promise<void>;
  releaseAfterInspection(providerId: CliProviderId): Promise<void>;
  cancel(providerId: CliProviderId): Promise<void>;
  shutdown(signal: AbortSignal): Promise<void>;
}
