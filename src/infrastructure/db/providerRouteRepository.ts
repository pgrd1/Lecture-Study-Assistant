import type { StatementSync } from 'node:sqlite';
import { z } from 'zod';
import type { ProviderRouteRepository } from '../../core/ports/providerRepositories';
import {
  AI_FEATURES,
  type AiFeature,
  type ProviderRoute,
  ProviderRouteSchema,
} from '../../shared/contracts/provider';
import type { SqliteDatabase } from './sqliteDatabase';
import {
  assertNextRevision,
  assertSingleChange,
  parseDatabaseEntity,
  translateSqliteError,
} from './sqliteErrors';

const ROUTE_COLUMNS = `
  feature,
  provider_id AS providerId,
  model_id AS modelId,
  prompt_version AS promptVersion,
  enabled,
  provider_managed_history_consent_at AS providerManagedHistoryConsentAt,
  provider_managed_history_consent_version AS providerManagedHistoryConsentVersion,
  updated_at AS updatedAt,
  revision
`;

const ProviderRouteRowSchema = z.strictObject({
  feature: z.string(),
  providerId: z.string().nullable(),
  modelId: z.string().nullable(),
  promptVersion: z.string(),
  enabled: z.union([z.literal(0), z.literal(1)]),
  providerManagedHistoryConsentAt: z.string().nullable(),
  providerManagedHistoryConsentVersion: z.string().nullable(),
  updatedAt: z.string(),
  revision: z.int(),
});

const toRoute = (value: unknown): ProviderRoute =>
  parseDatabaseEntity(() => {
    const row = ProviderRouteRowSchema.parse(value);
    return Object.freeze(
      ProviderRouteSchema.parse({ ...row, enabled: row.enabled === 1 }),
    ) as ProviderRoute;
  });

const requireRoute = (route: ProviderRoute | null): ProviderRoute =>
  parseDatabaseEntity(() => {
    if (route === null) {
      throw new TypeError('MISSING_PROVIDER_ROUTE_AFTER_WRITE');
    }
    return route;
  });

export class SqliteProviderRouteRepository implements ProviderRouteRepository {
  readonly #getStatement: StatementSync;
  readonly #listStatement: StatementSync;
  readonly #updateStatement: StatementSync;

  constructor(database: SqliteDatabase) {
    this.#getStatement = database.prepare(
      `SELECT ${ROUTE_COLUMNS} FROM provider_routes WHERE feature = ?`,
    );
    this.#listStatement = database.prepare(
      `SELECT ${ROUTE_COLUMNS} FROM provider_routes
       ORDER BY CASE feature ${AI_FEATURES.map((feature, index) => `WHEN '${feature}' THEN ${index}`).join(' ')} END`,
    );
    this.#updateStatement = database.prepare(`
      UPDATE provider_routes
      SET provider_id = ?, model_id = ?, prompt_version = ?, enabled = ?,
          provider_managed_history_consent_at = ?, provider_managed_history_consent_version = ?,
          updated_at = ?, revision = ?
      WHERE feature = ? AND revision = ?
    `);
  }

  get(feature: AiFeature): ProviderRoute | null {
    const parsedFeature = parseDatabaseEntity(() => z.enum(AI_FEATURES).parse(feature));
    try {
      const row = this.#getStatement.get(parsedFeature);
      return row === undefined ? null : toRoute(row);
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  list(): readonly ProviderRoute[] {
    try {
      return Object.freeze(this.#listStatement.all().map(toRoute));
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  update(next: ProviderRoute, expectedRevision: number): ProviderRoute {
    const parsed = parseDatabaseEntity(() => ProviderRouteSchema.parse(next));
    assertNextRevision(parsed.revision, expectedRevision);
    try {
      assertSingleChange(
        this.#updateStatement.run(
          parsed.providerId,
          parsed.modelId,
          parsed.promptVersion,
          parsed.enabled ? 1 : 0,
          parsed.providerManagedHistoryConsentAt,
          parsed.providerManagedHistoryConsentVersion,
          parsed.updatedAt,
          parsed.revision,
          parsed.feature,
          expectedRevision,
        ),
      );
    } catch (error) {
      return translateSqliteError(error);
    }
    return requireRoute(this.get(parsed.feature));
  }
}

export const createProviderRouteRepository = (database: SqliteDatabase): ProviderRouteRepository =>
  new SqliteProviderRouteRepository(database);
