import { describe, expect, it } from 'vitest';
import {
  findStudyAppAction,
  parseStudyAppUrl,
  registerStudyAppProtocolClient,
} from '../../../src/main/protocol';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';

describe('studyapp protocol', () => {
  it('parses one strict, non-negative play action', () => {
    expect(parseStudyAppUrl(`studyapp://play/${SOURCE_ID}?t=125.5`)).toEqual({
      type: 'play',
      sourceId: SOURCE_ID,
      seconds: 125.5,
    });
    expect(parseStudyAppUrl(`studyapp://play/${SOURCE_ID}?t=0`)).toEqual({
      type: 'play',
      sourceId: SOURCE_ID,
      seconds: 0,
    });
  });

  it.each([
    'https://play/id?t=1',
    'studyapp://other/11111111-1111-4111-8111-111111111111?t=1',
    'studyapp://play/not-a-uuid?t=1',
    `studyapp://play/${SOURCE_ID}?t=-1`,
    `studyapp://play/${SOURCE_ID}?t=NaN`,
    `studyapp://play/${SOURCE_ID}?t=Infinity`,
    `studyapp://play/${SOURCE_ID}?t=31536001`,
    `studyapp://play/${SOURCE_ID}?t=1e2`,
    `studyapp://play/${SOURCE_ID}?t=1&t=2`,
    `studyapp://play/${SOURCE_ID}?t=1&command=calc`,
    `studyapp://user@play/${SOURCE_ID}?t=1`,
    `studyapp://play/${SOURCE_ID}?t=1#fragment`,
    `studyapp://play/${SOURCE_ID}/extra?t=1`,
    `studyapp://play/${SOURCE_ID}`,
    'not a URL',
  ])('rejects unsafe or ambiguous deep link %s', (url) => {
    expect(() => parseStudyAppUrl(url)).toThrow('INVALID_DEEP_LINK');
  });

  it('extracts exactly one validated action from process arguments', () => {
    const valid = `studyapp://play/${SOURCE_ID}?t=42`;

    expect(findStudyAppAction(['app.exe', '--flag', valid])).toEqual({
      type: 'play',
      sourceId: SOURCE_ID,
      seconds: 42,
    });
    expect(findStudyAppAction(['app.exe', '--flag'])).toBeUndefined();
    expect(findStudyAppAction(['app.exe', 'studyapp://play/nope?t=1'])).toBeUndefined();
    expect(findStudyAppAction(['app.exe', valid, valid])).toBeUndefined();
  });

  it('registers the default client only for packaged builds', () => {
    const registrations: string[] = [];
    const registrar = {
      setAsDefaultProtocolClient: (scheme: string) => {
        registrations.push(scheme);
        return true;
      },
    };

    expect(registerStudyAppProtocolClient(registrar, false)).toBe(false);
    expect(registrations).toEqual([]);
    expect(registerStudyAppProtocolClient(registrar, true)).toBe(true);
    expect(registrations).toEqual(['studyapp']);
  });
});
