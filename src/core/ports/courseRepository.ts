import type { Course } from '../../shared/contracts/course';

export type CourseListOptions = Readonly<{
  includeArchived?: boolean;
}>;

export interface CourseRepository {
  get(id: string): Course | null;
  list(options?: CourseListOptions): readonly Course[];
  insert(course: Course): Course;
  update(course: Course, expectedRevision: number): Course;
  delete(id: string, expectedRevision: number): void;
}
