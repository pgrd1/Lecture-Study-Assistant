import { APP_METADATA } from '../shared/appMetadata';

const SOURCE_ID_PATH =
  /^\/(?<sourceId>[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;
const NON_NEGATIVE_SECONDS_QUERY = /^\?t=(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const MAX_DEEP_LINK_SECONDS = 31_536_000;

export type StudyAppAction = Readonly<{
  type: 'play';
  sourceId: string;
  seconds: number;
}>;

type ProtocolClientRegistrar = Readonly<{
  setAsDefaultProtocolClient(scheme: string): boolean;
}>;

const invalidDeepLink = (): never => {
  throw new TypeError('INVALID_DEEP_LINK');
};

export const parseStudyAppUrl = (value: string): StudyAppAction => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidDeepLink();
  }

  const pathMatch = SOURCE_ID_PATH.exec(url.pathname);
  if (
    url.protocol !== `${APP_METADATA.protocol}:` ||
    url.hostname !== 'play' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.hash !== '' ||
    !pathMatch ||
    !NON_NEGATIVE_SECONDS_QUERY.test(url.search)
  ) {
    return invalidDeepLink();
  }

  const sourceId = pathMatch.groups?.sourceId;
  const rawSeconds = url.search.slice('?t='.length);
  const seconds = Number(rawSeconds);
  if (
    sourceId === undefined ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds > MAX_DEEP_LINK_SECONDS
  ) {
    return invalidDeepLink();
  }

  return Object.freeze({
    type: 'play',
    sourceId: sourceId.toLowerCase(),
    seconds,
  });
};

export const findStudyAppAction = (
  argumentsList: readonly string[],
): StudyAppAction | undefined => {
  const candidates = argumentsList.filter((argument) => /^studyapp:/iu.test(argument));
  if (candidates.length !== 1) {
    return undefined;
  }

  try {
    return parseStudyAppUrl(candidates[0] ?? '');
  } catch {
    return undefined;
  }
};

export const registerStudyAppProtocolClient = (
  registrar: ProtocolClientRegistrar,
  isPackaged: boolean,
): boolean => (isPackaged ? registrar.setAsDefaultProtocolClient(APP_METADATA.protocol) : false);
