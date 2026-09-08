import { isAbsolute } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { z } from 'zod';
import type { CourseRepository } from '../../core/ports/courseRepository';
import type { DatabasePort, DatabaseRuntimeConfiguration } from '../../core/ports/database';
import type { JobArtifactRepository } from '../../core/ports/jobArtifactRepository';
import type { JobRepository } from '../../core/ports/jobRepository';
import type { ManagedNoteRevisionRepository } from '../../core/ports/managedNoteRevisionRepository';
import type { PipelineArtifactRepository } from '../../core/ports/pipelineArtifactRepository';
import type { PromptProfileRepository } from '../../core/ports/promptProfileRepository';
import type {
  ProviderDiagnosticRepository,
  ProviderInvocationRepository,
  ProviderRouteRepository,
} from '../../core/ports/providerRepositories';
import type { SettingsRepository } from '../../core/ports/settingsRepository';
import type { SourceBundleRepository } from '../../core/ports/sourceBundleRepository';
import { applyMigrations } from './migrations';
import { createProviderDiagnosticRepository } from './providerDiagnosticRepository';
import { createProviderInvocationRepository } from './providerInvocationRepository';
import { createProviderRouteRepository } from './providerRouteRepository';
import { createCourseRepository } from './sqliteCourseRepository';
import { translateSqliteError } from './sqliteErrors';
import { createJobArtifactRepository } from './sqliteJobArtifactRepository';
import { createJobRepository } from './sqliteJobRepository';
import { createManagedNoteRevisionRepository } from './sqliteManagedNoteRevisionRepository';
import { createPipelineArtifactRepository } from './sqlitePipelineArtifactRepository';
import { createPromptProfileRepository } from './sqlitePromptProfileRepository';
import { createSettingsRepository } from './sqliteSettingsRepository';
import { createSourceBundleRepository } from './sqliteSourceBundleRepository';

const DATABASE_BUSY_TIMEOUT_MS = 5_000;

const DatabasePathSchema = z
  .string()
  .min(1)
  .max(32_767)
  .refine((value) => !value.includes('\0'))
  .refine(isAbsolute);

const RuntimeConfigurationRowSchema = z.strictObject({
  journalMode: z.literal('wal'),
  foreignKeys: z.literal(1),
  busyTimeoutMs: z.literal(DATABASE_BUSY_TIMEOUT_MS),
  synchronous: z.literal(2),
});

const SchemaVersionRowSchema = z.strictObject({ version: z.int().min(0).nullable() });

export type SqliteRepositories = Readonly<{
  artifacts: JobArtifactRepository;
  courses: CourseRepository;
  jobs: JobRepository;
  managedNotes: ManagedNoteRevisionRepository;
  pipelineArtifacts: PipelineArtifactRepository;
  promptProfiles: PromptProfileRepository;
  sourceBundles: SourceBundleRepository;
  settings: SettingsRepository;
  providerRoutes: ProviderRouteRepository;
  providerDiagnostics: ProviderDiagnosticRepository;
  providerInvocations: ProviderInvocationRepository;
}>;

export class SqliteDatabase implements DatabasePort {
  readonly #connection: DatabaseSync;
  #closed = false;

  constructor(connection: DatabaseSync) {
    this.#connection = connection;
  }

  prepare(sql: string): StatementSync {
    this.#assertOpen();
    try {
      return this.#connection.prepare(sql);
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  getRuntimeConfiguration(): DatabaseRuntimeConfiguration {
    this.#assertOpen();
    try {
      const journal = this.#connection.prepare('PRAGMA journal_mode').get();
      const foreignKeys = this.#connection.prepare('PRAGMA foreign_keys').get();
      const timeout = this.#connection.prepare('PRAGMA busy_timeout').get();
      const synchronous = this.#connection.prepare('PRAGMA synchronous').get();
      const parsed = RuntimeConfigurationRowSchema.parse({
        journalMode: journal?.journal_mode,
        foreignKeys: foreignKeys?.foreign_keys,
        busyTimeoutMs: timeout?.timeout,
        synchronous: synchronous?.synchronous,
      });
      return Object.freeze({
        journalMode: parsed.journalMode,
        foreignKeys: true,
        busyTimeoutMs: parsed.busyTimeoutMs,
        synchronous: 'full',
      });
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  getSchemaVersion(): number {
    this.#assertOpen();
    try {
      const row = this.#connection
        .prepare('SELECT MAX(version) AS version FROM schema_migrations')
        .get();
      return SchemaVersionRowSchema.parse(row).version ?? 0;
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    try {
      this.#connection.close();
      this.#closed = true;
    } catch (error) {
      translateSqliteError(error);
    }
  }

  beginImmediate(): void {
    this.#executeTransactionStatement('BEGIN IMMEDIATE');
  }

  commit(): void {
    this.#executeTransactionStatement('COMMIT');
  }

  rollback(): void {
    try {
      this.#executeTransactionStatement('ROLLBACK');
    } catch {
      // A failed BEGIN has no transaction to roll back.
    }
  }

  #executeTransactionStatement(sql: 'BEGIN IMMEDIATE' | 'COMMIT' | 'ROLLBACK'): void {
    this.#assertOpen();
    try {
      this.#connection.exec(sql);
    } catch (error) {
      translateSqliteError(error);
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      translateSqliteError(new TypeError('DATABASE_CLOSED'));
    }
  }
}

const configureConnection = (database: DatabaseSync): void => {
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(`PRAGMA busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS}`);
  database.exec('PRAGMA synchronous = FULL');
  database.exec('PRAGMA trusted_schema = OFF');
};

export const openDatabase = (path: string): SqliteDatabase => {
  let connection: DatabaseSync | undefined;
  try {
    const parsedPath = DatabasePathSchema.parse(path);
    connection = new DatabaseSync(parsedPath, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      timeout: DATABASE_BUSY_TIMEOUT_MS,
      readBigInts: false,
      returnArrays: false,
      allowBareNamedParameters: false,
      allowUnknownNamedParameters: false,
      defensive: true,
    });
    configureConnection(connection);
    applyMigrations(connection);
    const database = new SqliteDatabase(connection);
    database.getRuntimeConfiguration();
    return database;
  } catch (error) {
    try {
      connection?.close();
    } catch {
      return translateSqliteError(error);
    }
    return translateSqliteError(error);
  }
};

export const createRepositories = (database: SqliteDatabase): SqliteRepositories => {
  try {
    const jobs = createJobRepository(database);
    return Object.freeze({
      artifacts: createJobArtifactRepository(database),
      courses: createCourseRepository(database),
      jobs,
      managedNotes: createManagedNoteRevisionRepository(database),
      pipelineArtifacts: createPipelineArtifactRepository(database),
      promptProfiles: createPromptProfileRepository(database),
      sourceBundles: createSourceBundleRepository(database, jobs),
      settings: createSettingsRepository(database),
      providerRoutes: createProviderRouteRepository(database),
      providerDiagnostics: createProviderDiagnosticRepository(database),
      providerInvocations: createProviderInvocationRepository(database),
    });
  } catch (error) {
    return translateSqliteError(error);
  }
};
