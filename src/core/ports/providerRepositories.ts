import type { AiFeature, AiProviderId, ProviderRoute } from '../../shared/contracts/provider';
import type {
  ProviderInvocation,
  ProviderInvocationCompletion,
} from '../../shared/contracts/providerInvocation';
import type { ProviderDiagnostic } from './aiProvider';

export interface ProviderRouteRepository {
  list(): readonly ProviderRoute[];
  get(feature: AiFeature): ProviderRoute | null;
  update(next: ProviderRoute, expectedRevision: number): ProviderRoute;
}

export interface ProviderDiagnosticRepository {
  list(): readonly ProviderDiagnostic[];
  get(providerId: AiProviderId): ProviderDiagnostic | null;
  upsert(next: ProviderDiagnostic, expectedRevision: number | null): ProviderDiagnostic;
}

export interface ProviderInvocationRepository {
  create(next: ProviderInvocation): ProviderInvocation;
  get(id: string): ProviderInvocation | null;
  complete(
    id: string,
    expectedRevision: number,
    completion: ProviderInvocationCompletion,
  ): ProviderInvocation;
  listForJob(jobId: string): readonly ProviderInvocation[];
  recoverInterrupted(completedAt: string): number;
  cancelRunningForShutdown(completedAt: string): number;
}
