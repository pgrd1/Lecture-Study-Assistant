import { z } from 'zod';
import { APP_METADATA } from '../appMetadata';
import { APP_ERROR_MESSAGES, AppError } from '../errors';
import { createSafeWindowsPathSegmentSchema } from './windowsPath';

const SingleLineDisplayTextPattern = String.raw`^[^\u0000-\u001F\u007F-\u009F\u2028\u2029]*$`;
const SingleLineDisplayTextSchema = z.string().regex(new RegExp(SingleLineDisplayTextPattern, 'u'));
export const CourseNameSchema = SingleLineDisplayTextSchema.trim().min(1).max(80).regex(/\S/u);
export const ProfessorNameSchema = SingleLineDisplayTextSchema.trim().max(80);
const UserInstructionsSchema = z
  .string()
  .max(4_000)
  .transform((value) => value.replaceAll('\r\n', '\n'))
  .refine((value) =>
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined &&
        (codePoint === 9 ||
          codePoint === 10 ||
          (codePoint > 31 && (codePoint < 127 || codePoint > 159)))
      );
    }),
  );
const IsoDateTimeSchema = z.iso.datetime({ offset: true });

const CourseFolderSchema = createSafeWindowsPathSegmentSchema(100);

export const MANAGED_VAULT_ROOT = APP_METADATA.managedVaultRoot;

export const CourseInputSchema = z
  .strictObject({
    name: CourseNameSchema,
    professorName: ProfessorNameSchema,
  })
  .readonly();

export const CourseProvisioningInputSchema = z
  .strictObject({
    id: z.uuid(),
    name: CourseNameSchema,
    professorName: ProfessorNameSchema,
  })
  .readonly();

export const CoursePatchSchema = z
  .strictObject({
    name: CourseNameSchema.optional(),
    professorName: ProfessorNameSchema.optional(),
    userInstructions: UserInstructionsSchema.optional(),
  })
  .transform((patch) => ({
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.professorName === undefined ? {} : { professorName: patch.professorName }),
    ...(patch.userInstructions === undefined ? {} : { userInstructions: patch.userInstructions }),
  }))
  .refine((patch) => Object.keys(patch).length > 0, '변경할 과목 정보가 필요합니다.')
  .readonly();

export const CourseSchema = z
  .strictObject({
    id: z.uuid(),
    name: CourseNameSchema,
    professorName: ProfessorNameSchema,
    folderName: CourseFolderSchema,
    userInstructions: UserInstructionsSchema,
    archived: z.boolean(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    revision: z.int().min(0),
  })
  .readonly();

export type CourseInput = z.infer<typeof CourseInputSchema>;
export type CourseProvisioningInput = z.infer<typeof CourseProvisioningInputSchema>;
export type CoursePatch = z.infer<typeof CoursePatchSchema>;
export type Course = z.infer<typeof CourseSchema>;

export const parseCourseInput = (input: unknown): CourseInput => {
  const result = CourseInputSchema.safeParse(input);
  if (!result.success) {
    throw new AppError('INVALID_COURSE', '과목명과 교수 표시명을 확인해 주세요.');
  }
  return result.data;
};

export const parseCourseProvisioningInput = (input: unknown): CourseProvisioningInput => {
  const result = CourseProvisioningInputSchema.safeParse(input);
  if (!result.success) {
    throw new AppError('INVALID_COURSE', APP_ERROR_MESSAGES.INVALID_COURSE);
  }
  return result.data;
};

export const parseCoursePatch = (input: unknown): CoursePatch => {
  const result = CoursePatchSchema.safeParse(input);
  if (!result.success) {
    throw new AppError('INVALID_COURSE_PATCH', '변경할 과목 정보를 확인해 주세요.');
  }
  return result.data;
};
