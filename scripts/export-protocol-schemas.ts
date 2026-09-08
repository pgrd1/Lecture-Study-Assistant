import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CourseCatalogSchema,
  CourseInboxRequestSchema,
  QueueManifestSchema,
  RejectionReceiptSchema,
  StatusReceiptSchema,
} from '../src/shared/contracts/queue';
import { SourceBundleManifestV2Schema } from '../src/shared/contracts/sourceBundle';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(scriptDirectory, '..', 'protocol', 'schemas');
const schemas = Object.freeze([
  ['course-catalog.schema.json', CourseCatalogSchema],
  ['course-inbox-request.schema.json', CourseInboxRequestSchema],
  ['job-manifest.schema.json', QueueManifestSchema],
  ['source-bundle-manifest-v2.schema.json', SourceBundleManifestV2Schema],
  ['status-receipt.schema.json', StatusReceiptSchema],
  ['rejection-receipt.schema.json', RejectionReceiptSchema],
] as const);

await mkdir(outputDirectory, { recursive: true });
for (const [fileName, schema] of schemas) {
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-2020-12' });
  await writeFile(
    resolve(outputDirectory, fileName),
    `${JSON.stringify(jsonSchema, null, 2)}\n`,
    'utf8',
  );
}
