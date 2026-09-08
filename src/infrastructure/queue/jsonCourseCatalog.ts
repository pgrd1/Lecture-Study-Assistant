import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CourseCatalog } from '../../core/ports/courseCatalog';
import type { SettingsRepository } from '../../core/ports/settingsRepository';
import type { Course } from '../../shared/contracts/course';
import { CourseCatalogSchema } from '../../shared/contracts/queue';
import { atomicReplace } from '../filesystem/atomicWrite';
import { connectQueueRoot, queuePath, toQueueWriteError } from './queueLayout';

const GeneratedAtSchema = z.iso.datetime({ offset: true });

export type JsonCourseCatalogDependencies = Readonly<{
  clock?: () => string;
  idGenerator?: () => string;
}>;

const toCatalog = (courses: readonly Course[], generatedAt: string) =>
  CourseCatalogSchema.parse({
    protocolVersion: 1,
    generatedAt,
    courses: courses
      .filter((course) => !course.archived)
      .map((course) => Object.freeze({ id: course.id, name: course.name }))
      .toSorted((left, right) =>
        left.name.localeCompare(right.name, 'ko-KR', { sensitivity: 'base' }),
      ),
  });

export class JsonCourseCatalog implements CourseCatalog {
  readonly #dependencies: JsonCourseCatalogDependencies;
  readonly #settings: SettingsRepository;

  constructor(settings: SettingsRepository, dependencies: JsonCourseCatalogDependencies = {}) {
    this.#settings = settings;
    this.#dependencies = Object.freeze({ ...dependencies });
  }

  async publish(courses: readonly Course[]): Promise<void> {
    const settings = this.#settings.get();
    if (settings?.icloudQueuePath === null || settings === null) {
      return;
    }

    const generatedAt = GeneratedAtSchema.parse(
      (this.#dependencies.clock ?? (() => new Date().toISOString()))(),
    );
    const catalog = toCatalog(courses, generatedAt);
    const connection = await connectQueueRoot(settings.icloudQueuePath);
    const targetPath = queuePath(connection, 'Catalog', 'courses.json');
    try {
      await atomicReplace({
        connection,
        targetPath,
        replaceExisting: true,
        dependencies: {
          clock: () => new Date(generatedAt),
          idGenerator: this.#dependencies.idGenerator ?? randomUUID,
        },
        write: async (handle) => {
          await handle.writeFile(`${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
          return undefined;
        },
      });
    } catch (error) {
      throw toQueueWriteError(error);
    }
  }
}
