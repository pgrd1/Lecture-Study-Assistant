import { basename } from 'node:path';
import { FuseV1Options } from '@electron/fuses';
import { describe, expect, it } from 'vitest';
import {
  createFuseConfig,
  createPackagerConfig,
  createSquirrelConfig,
} from '../../../forge.config';
import { APP_METADATA } from '../../../src/shared/appMetadata';

describe('packaged Electron fuse policy', () => {
  it('uses launchable production defaults and allows inspection only for E2E builds', () => {
    const production = createFuseConfig(false);
    const e2e = createFuseConfig(true);

    expect(production.strictlyRequireAllFuses).toBe(true);
    expect(production[FuseV1Options.RunAsNode]).toBe(false);
    expect(production[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(false);
    expect(production[FuseV1Options.EnableNodeCliInspectArguments]).toBe(false);
    expect(e2e[FuseV1Options.EnableNodeCliInspectArguments]).toBe(true);
    expect(production[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]).toBe(false);
    expect(production[FuseV1Options.GrantFileProtocolExtraPrivileges]).toBe(false);
  });

  it('labels the unsigned development build and applies the Windows icon without signing', () => {
    const packager = createPackagerConfig();
    const squirrel = createSquirrelConfig();

    expect(APP_METADATA.appId).toBe('com.lecturestudyassistant.desktop');
    expect(packager).toMatchObject({
      asar: true,
      win32metadata: {
        ProductName: 'Lecture Study Assistant (UNSIGNED-DEVELOPMENT)',
      },
    });
    expect(basename(String(packager.icon))).toBe('icon.ico');
    expect(squirrel).toMatchObject({
      name: 'lecture_study_assistant',
      noMsi: true,
      setupExe: 'Lecture-Study-Assistant-UNSIGNED-DEVELOPMENT-Setup.exe',
      title: 'Lecture Study Assistant (UNSIGNED-DEVELOPMENT)',
    });
    expect(basename(String(squirrel.setupIcon))).toBe('icon.ico');
    expect(squirrel).not.toHaveProperty('certificateFile');
    expect(squirrel).not.toHaveProperty('certificatePassword');
    expect(squirrel).not.toHaveProperty('windowsSign');
  });
});
