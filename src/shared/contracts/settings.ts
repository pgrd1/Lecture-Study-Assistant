import { z } from 'zod';
import { APP_METADATA } from '../appMetadata';
import { SummaryModeSchema } from './job';

const OptionalInternalPathSchema = z.string().min(1).max(32_767).nullable();

export const MANAGED_SETTINGS_ROOT = APP_METADATA.managedVaultRoot;

export const AppSettingsSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    vaultPath: OptionalInternalPathSchema,
    icloudQueuePath: OptionalInternalPathSchema,
    defaultSummaryMode: SummaryModeSchema,
    autoStart: z.boolean(),
    processingPaused: z.boolean(),
    legalNoticeAcceptedAt: z.iso.datetime({ offset: true }).nullable(),
    updatedAt: z.iso.datetime({ offset: true }),
    revision: z.int().min(0),
  })
  .readonly();

export type AppSettings = z.infer<typeof AppSettingsSchema>;
