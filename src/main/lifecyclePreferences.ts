import type { SettingsRepository } from '../core/ports/settingsRepository';
import { type AppSettings, AppSettingsSchema } from '../shared/contracts/settings';

export type LifecyclePreferences = Readonly<{
  processingPaused: boolean;
  autoStart: boolean;
}>;

export type LifecyclePreferenceStore = Readonly<{
  load(): LifecyclePreferences;
  setProcessingPaused(paused: boolean): LifecyclePreferences;
  setAutoStart(enabled: boolean): LifecyclePreferences;
}>;

const toPreferences = (settings: AppSettings): LifecyclePreferences =>
  Object.freeze({
    processingPaused: settings.processingPaused,
    autoStart: settings.autoStart,
  });

const createDefaultSettings = (updatedAt: string): AppSettings =>
  AppSettingsSchema.parse({
    schemaVersion: 1,
    vaultPath: null,
    icloudQueuePath: null,
    defaultSummaryMode: 'standard',
    autoStart: false,
    processingPaused: false,
    legalNoticeAcceptedAt: null,
    updatedAt,
    revision: 0,
  });

export const createLifecyclePreferenceStore = (
  repository: SettingsRepository,
  clock: () => string = () => new Date().toISOString(),
): LifecyclePreferenceStore => {
  const loadSettings = (): AppSettings =>
    repository.get() ?? repository.insert(createDefaultSettings(clock()));

  const update = (key: 'processingPaused' | 'autoStart', value: boolean): LifecyclePreferences => {
    const current = loadSettings();
    if (current[key] === value) {
      return toPreferences(current);
    }

    const updated = AppSettingsSchema.parse({
      ...current,
      [key]: value,
      updatedAt: clock(),
      revision: current.revision + 1,
    });
    return toPreferences(repository.update(updated, current.revision));
  };

  return Object.freeze({
    load: () => toPreferences(loadSettings()),
    setProcessingPaused: (paused) => update('processingPaused', paused),
    setAutoStart: (enabled) => update('autoStart', enabled),
  });
};
