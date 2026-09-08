import { describe, expect, it } from 'vitest';
import { APP_METADATA } from '../../../src/shared/appMetadata';

describe('APP_METADATA', () => {
  it('locks the app id, custom protocol, and managed Vault root', () => {
    expect(APP_METADATA).toEqual({
      name: 'Lecture Study Assistant',
      appId: 'com.lecturestudyassistant.desktop',
      protocol: 'studyapp',
      managedVaultRoot: 'AI 학습',
    });
    expect(Object.isFrozen(APP_METADATA)).toBe(true);
  });
});
