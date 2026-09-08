import { resolve } from 'node:path';
import { type FuseV1Config, FuseV1Options, FuseVersion } from '@electron/fuses';
import { MakerSquirrel, type MakerSquirrelConfig } from '@electron-forge/maker-squirrel';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import type { ForgeConfig } from '@electron-forge/shared-types';

const isE2eBuild = process.env.STUDYAPP_E2E_BUILD === '1';
const metadataSmokeId = process.env.STUDYAPP_METADATA_SMOKE_ID;
if (metadataSmokeId !== undefined && !/^metadata-smoke-[a-f0-9-]{36}$/u.test(metadataSmokeId))
  throw new Error('INVALID_METADATA_SMOKE_ID');
const WINDOWS_ICON_PATH = resolve(process.cwd(), 'assets', 'icon.ico');
const DEVELOPMENT_TITLE = 'Lecture Study Assistant (UNSIGNED-DEVELOPMENT)';

export const createFuseConfig = (enableE2eInspection: boolean): FuseV1Config => ({
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: enableE2eInspection,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: true,
});

export const createPackagerConfig = (): NonNullable<ForgeConfig['packagerConfig']> => ({
  asar: true,
  // Parser workers import pinned production ESM modules at runtime. Forge prunes dev dependencies.
  ignore: (file: string) =>
    file !== '' &&
    file !== '/package.json' &&
    file !== '/.vite' &&
    !file.startsWith('/.vite/') &&
    file !== '/node_modules' &&
    !file.startsWith('/node_modules/'),
  icon: WINDOWS_ICON_PATH,
  win32metadata: {
    FileDescription: DEVELOPMENT_TITLE,
    ProductName: DEVELOPMENT_TITLE,
  },
});

export const createSquirrelConfig = (): MakerSquirrelConfig => ({
  authors: 'Lecture Study Assistant',
  description: 'Unsigned development build of the local-first lecture study assistant.',
  name: 'lecture_study_assistant',
  noMsi: true,
  setupExe: 'Lecture-Study-Assistant-UNSIGNED-DEVELOPMENT-Setup.exe',
  setupIcon: WINDOWS_ICON_PATH,
  title: DEVELOPMENT_TITLE,
});

const config: ForgeConfig = {
  ...(metadataSmokeId
    ? { buildIdentifier: metadataSmokeId }
    : isE2eBuild
      ? { buildIdentifier: 'e2e' }
      : {}),
  packagerConfig: createPackagerConfig(),
  rebuildConfig: {},
  makers: [new MakerSquirrel(createSquirrelConfig())],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: metadataSmokeId
            ? 'tests/fixtures/metadata/electron-smoke-main.ts'
            : 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/index.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          entry: 'src/infrastructure/metadata/metadataWorker.ts',
          config: 'vite.metadata.config.ts',
          target: 'main',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin(createFuseConfig(isE2eBuild)),
  ],
};

export default config;
