import type { Course } from '../../shared/contracts/course';

export interface CourseCatalog {
  publish(courses: readonly Course[]): Promise<void>;
}
