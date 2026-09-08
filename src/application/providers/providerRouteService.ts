import type {
  ProviderDiagnosticRepository,
  ProviderRouteRepository,
} from '../../core/ports/providerRepositories';
import {
  ANTIGRAVITY_HISTORY_NOTICE_VERSION,
  type ProviderRoute,
  type SaveProviderRouteRequest,
  SaveProviderRouteRequestSchema,
} from '../../shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError } from '../../shared/errors';

export type ProviderRouteServiceDependencies = Readonly<{
  routes: ProviderRouteRepository;
  diagnostics: ProviderDiagnosticRepository;
  clock: () => string;
}>;

const routeError = (
  code:
    | 'INVALID_INPUT'
    | 'PROVIDER_DATA_RETENTION_CONSENT_REQUIRED'
    | 'PROVIDER_NOT_CONFIGURED'
    | 'PROVIDER_NOT_READY',
): AppError => new AppError(code, APP_ERROR_MESSAGES[code]);

export class ProviderRouteService {
  readonly #clock: () => string;
  readonly #diagnostics: ProviderDiagnosticRepository;
  readonly #routes: ProviderRouteRepository;

  constructor(dependencies: ProviderRouteServiceDependencies) {
    this.#routes = dependencies.routes;
    this.#diagnostics = dependencies.diagnostics;
    this.#clock = dependencies.clock;
  }

  list(): readonly ProviderRoute[] {
    return this.#routes.list();
  }

  update(request: SaveProviderRouteRequest): ProviderRoute {
    const parsed = SaveProviderRouteRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw routeError('INVALID_INPUT');
    }
    const input = parsed.data;
    const currentRoute = this.#routes.get(input.feature);
    if (currentRoute === null) {
      throw routeError('PROVIDER_NOT_CONFIGURED');
    }
    if (input.providerId !== null) {
      const diagnostic = this.#diagnostics.get(input.providerId);
      if (diagnostic === null && !input.confirmNotReady) {
        throw routeError('PROVIDER_NOT_CONFIGURED');
      }
      if (diagnostic !== null && diagnostic.status !== 'ready' && !input.confirmNotReady) {
        throw routeError('PROVIDER_NOT_READY');
      }
    }

    const now = this.#clock();
    const hasCurrentConsent =
      currentRoute.providerId === 'antigravity_cli' &&
      currentRoute.providerManagedHistoryConsentAt !== null &&
      currentRoute.providerManagedHistoryConsentVersion === ANTIGRAVITY_HISTORY_NOTICE_VERSION;
    const nextConsentAt =
      input.providerId !== 'antigravity_cli'
        ? null
        : input.confirmProviderManagedHistory
          ? now
          : hasCurrentConsent
            ? currentRoute.providerManagedHistoryConsentAt
            : null;
    if (input.enabled && input.providerId === 'antigravity_cli' && nextConsentAt === null) {
      throw routeError('PROVIDER_DATA_RETENTION_CONSENT_REQUIRED');
    }
    const nextRoute = Object.freeze({
      ...currentRoute,
      providerId: input.providerId,
      modelId: input.modelId,
      enabled: input.enabled,
      providerManagedHistoryConsentAt: nextConsentAt,
      providerManagedHistoryConsentVersion:
        nextConsentAt === null ? null : ANTIGRAVITY_HISTORY_NOTICE_VERSION,
      updatedAt: now,
      revision: currentRoute.revision + 1,
    });
    return this.#routes.update(nextRoute, input.expectedRevision);
  }
}
