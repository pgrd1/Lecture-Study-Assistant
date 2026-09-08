import type { Course, CourseProvisioningInput } from '../../shared/contracts/course';

export interface CourseProvisioner {
  provision(input: CourseProvisioningInput): Promise<Course>;
}
