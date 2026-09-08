import type { StatementSync } from 'node:sqlite';
import { z } from 'zod';
import type { CourseListOptions, CourseRepository } from '../../core/ports/courseRepository';
import { type Course, CourseSchema } from '../../shared/contracts/course';
import type { SqliteDatabase } from './sqliteDatabase';
import {
  assertNextRevision,
  assertSingleChange,
  parseDatabaseEntity,
  translateSqliteError,
} from './sqliteErrors';

const COURSE_COLUMNS = `
  id,
  name,
  professor_name AS professorName,
  folder_name AS folderName,
  user_instructions AS userInstructions,
  archived,
  created_at AS createdAt,
  updated_at AS updatedAt,
  revision
`;

const CourseRowSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  professorName: z.string(),
  folderName: z.string(),
  userInstructions: z.string(),
  archived: z.union([z.literal(0), z.literal(1)]),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.int(),
});

const CourseListOptionsSchema = z
  .strictObject({ includeArchived: z.boolean().optional() })
  .default({});

const toCourse = (value: unknown): Course =>
  parseDatabaseEntity(() => {
    const row = CourseRowSchema.parse(value);
    return CourseSchema.parse({ ...row, archived: row.archived === 1 });
  });

const requireCourse = (course: Course | null): Course =>
  parseDatabaseEntity(() => {
    if (course === null) {
      throw new TypeError('MISSING_COURSE_AFTER_WRITE');
    }
    return course;
  });

export class SqliteCourseRepository implements CourseRepository {
  readonly #getStatement: StatementSync;
  readonly #listActiveStatement: StatementSync;
  readonly #listAllStatement: StatementSync;
  readonly #insertStatement: StatementSync;
  readonly #deleteStatement: StatementSync;
  readonly #updateStatement: StatementSync;

  constructor(database: SqliteDatabase) {
    this.#getStatement = database.prepare(`SELECT ${COURSE_COLUMNS} FROM courses WHERE id = ?`);
    this.#listActiveStatement = database.prepare(
      `SELECT ${COURSE_COLUMNS} FROM courses WHERE archived = 0 ORDER BY created_at, id`,
    );
    this.#listAllStatement = database.prepare(
      `SELECT ${COURSE_COLUMNS} FROM courses ORDER BY created_at, id`,
    );
    this.#insertStatement = database.prepare(`
      INSERT INTO courses (
        id, name, professor_name, folder_name, user_instructions,
        archived, created_at, updated_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#deleteStatement = database.prepare('DELETE FROM courses WHERE id = ? AND revision = ?');
    this.#updateStatement = database.prepare(`
      UPDATE courses
      SET name = ?, professor_name = ?, folder_name = ?, user_instructions = ?,
          archived = ?, updated_at = ?, revision = ?
      WHERE id = ? AND revision = ? AND created_at = ?
    `);
  }

  get(id: string): Course | null {
    const parsedId = parseDatabaseEntity(() => z.uuid().parse(id));
    try {
      const row = this.#getStatement.get(parsedId);
      return row === undefined ? null : toCourse(row);
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  list(options: CourseListOptions = {}): readonly Course[] {
    const parsedOptions = parseDatabaseEntity(() => CourseListOptionsSchema.parse(options));
    try {
      const statement = parsedOptions.includeArchived
        ? this.#listAllStatement
        : this.#listActiveStatement;
      return Object.freeze(statement.all().map(toCourse));
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  insert(course: Course): Course {
    const parsed = parseDatabaseEntity(() => CourseSchema.parse(course));
    try {
      this.#insertStatement.run(
        parsed.id,
        parsed.name,
        parsed.professorName,
        parsed.folderName,
        parsed.userInstructions,
        parsed.archived ? 1 : 0,
        parsed.createdAt,
        parsed.updatedAt,
        parsed.revision,
      );
    } catch (error) {
      return translateSqliteError(error, 'DUPLICATE_COURSE');
    }
    return requireCourse(this.get(parsed.id));
  }

  update(course: Course, expectedRevision: number): Course {
    const parsed = parseDatabaseEntity(() => CourseSchema.parse(course));
    assertNextRevision(parsed.revision, expectedRevision);
    try {
      const result = this.#updateStatement.run(
        parsed.name,
        parsed.professorName,
        parsed.folderName,
        parsed.userInstructions,
        parsed.archived ? 1 : 0,
        parsed.updatedAt,
        parsed.revision,
        parsed.id,
        expectedRevision,
        parsed.createdAt,
      );
      assertSingleChange(result);
    } catch (error) {
      return translateSqliteError(error, 'DUPLICATE_COURSE');
    }
    return requireCourse(this.get(parsed.id));
  }

  delete(id: string, expectedRevision: number): void {
    const parsed = parseDatabaseEntity(() =>
      z
        .strictObject({ id: z.uuid(), expectedRevision: z.int().min(0) })
        .parse({ id, expectedRevision }),
    );
    try {
      assertSingleChange(this.#deleteStatement.run(parsed.id, parsed.expectedRevision));
    } catch (error) {
      translateSqliteError(error);
    }
  }
}

export const createCourseRepository = (database: SqliteDatabase): CourseRepository =>
  new SqliteCourseRepository(database);
