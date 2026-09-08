import type { AppSettings } from '../../shared/contracts/settings';

export interface SettingsRepository {
  get(): AppSettings | null;
  insert(settings: AppSettings): AppSettings;
  update(settings: AppSettings, expectedRevision: number): AppSettings;
}
