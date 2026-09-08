import { createHash, randomUUID } from 'node:crypto';
import type { Dir, Dirent, Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { link, lstat, open, opendir, rename, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { assertNoReparsePoints } from '../../core/paths/safePath';
import type { CourseProvisioningInput } from '../../shared/contracts/course';
import type { ICloudSourceKind } from '../../shared/contracts/job';
import {
  CourseInboxRequestSchema,
  type NormalizedSourceBundleManifest,
  normalizeQueueManifest,
  QueueManifestSchema,
  SourceBundleManifestV2Schema,
  toQueueManifest,
} from '../../shared/contracts/queue';
import { extensionOf } from '../../shared/contracts/sourceFile';
import { APP_ERROR_MESSAGES, AppError } from '../../shared/errors';

const METADATA_MAX_BYTES = 64 * 1024;
const CLAIM_RESERVATION_MAX_BYTES = 1024;
const LARGE_SOURCE_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const SMALL_SOURCE_MAX_BYTES = 500 * 1024 * 1024;
const MAX_JOB_DIRECTORY_ENTRIES = 3;
const MAX_SOURCES_PER_BUNDLE = 32;
const SOURCE_FILE = /^source\.[^.]+$/u;

const ClaimReservationRecordSchema = z
  .strictObject({
    jobId: z.uuid(),
    sourceKind: z.enum(['icloud', 'icloud_course']),
    claimToken: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .readonly();

export const QUEUE_BUNDLE_CONFIG = Object.freeze({
  icloud: Object.freeze({ directory: 'Inbox', metadataFile: 'manifest.json' }),
  icloud_course: Object.freeze({ directory: 'CourseInbox', metadataFile: 'request.json' }),
} as const);

export type SourceLimits = Readonly<{
  audioVideoMaxBytes: number;
  documentImageMaxBytes: number;
}>;

export const SourceLimitsSchema = z
  .strictObject({
    audioVideoMaxBytes: z.int().min(1).max(LARGE_SOURCE_MAX_BYTES),
    documentImageMaxBytes: z.int().min(1).max(SMALL_SOURCE_MAX_BYTES),
  })
  .readonly();

export const DEFAULT_SOURCE_LIMITS: SourceLimits = SourceLimitsSchema.parse({
  audioVideoMaxBytes: LARGE_SOURCE_MAX_BYTES,
  documentImageMaxBytes: SMALL_SOURCE_MAX_BYTES,
});

export type ParsedBundleMetadata = Readonly<{
  manifest: NormalizedSourceBundleManifest;
  courseProvisioning: CourseProvisioningInput | null;
}>;

export type QueueSourceBundle = ParsedBundleMetadata &
  Readonly<{
    sources: readonly QueueSourceFile[];
  }>;

export type QueueSourceFile = Readonly<{
  ordinal: number;
  sourceFileName: string;
  sourcePath: string;
  snapshot: Stats;
}>;

export type QueueCleanupEntry = Readonly<{
  kind: 'directory' | 'file';
  relativePath: string;
}>;

export type ClaimReservationRecord = z.infer<typeof ClaimReservationRecordSchema>;

export type ClaimReservation = Readonly<{
  anchorPath: string;
  path: string;
  quarantineRoot: string;
  record: ClaimReservationRecord;
  snapshot: Stats;
}>;

export type ClaimReservationLocation = Readonly<{
  anchorPath: string;
  path: string;
  quarantineRoot: string;
}>;

export type AcquiredClaimReservation = Readonly<{
  created: boolean;
  reservation: ClaimReservation;
}>;

export type ClaimReservationHooks = Readonly<{
  beforeCommit?: ((reservationPath: string) => void | Promise<void>) | undefined;
  beforeRemoval?: ((reservationPath: string) => void | Promise<void>) | undefined;
  beforeSync?: (() => void | Promise<void>) | undefined;
  beforeWrite?: (() => void | Promise<void>) | undefined;
  link?: typeof link | undefined;
}>;

const invalidQueueItem = (): AppError =>
  new AppError('INVALID_QUEUE_ITEM', APP_ERROR_MESSAGES.INVALID_QUEUE_ITEM);

const claimReservationNotCommitted = (): AppError =>
  new AppError('QUEUE_ITEM_NOT_STABLE', APP_ERROR_MESSAGES.QUEUE_ITEM_NOT_STABLE);

const sourceTooLarge = (): AppError =>
  new AppError('SOURCE_TOO_LARGE', APP_ERROR_MESSAGES.SOURCE_TOO_LARGE);

const isClosedDirectoryError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ERR_DIR_CLOSED';

const closeDirectory = async (directory: Dir): Promise<void> => {
  try {
    await directory.close();
  } catch (error) {
    if (!isClosedDirectoryError(error)) {
      throw error;
    }
  }
};

export const readDirectoryEntriesBounded = async (
  directoryPath: string,
  maxAllowedEntries: number,
): Promise<readonly Dirent[]> => {
  assertNoReparsePoints(directoryPath);
  const directory = await opendir(directoryPath);
  const entries: Dirent[] = [];
  try {
    for (let inspected = 0; inspected <= maxAllowedEntries; inspected += 1) {
      const entry = await directory.read();
      if (entry === null) {
        break;
      }
      entries.push(entry);
    }
  } finally {
    await closeDirectory(directory);
  }
  return Object.freeze(entries.toSorted((left, right) => left.name.localeCompare(right.name)));
};

export const sameFileSnapshot = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

export const readBounded = async (filePath: string, maxBytes: number): Promise<Buffer> => {
  let handle: FileHandle | undefined;
  try {
    assertNoReparsePoints(filePath);
    const pathStats = await lstat(filePath);
    if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.size > maxBytes) {
      throw invalidQueueItem();
    }
    handle = await open(filePath, 'r');
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes || !sameFileSnapshot(pathStats, before)) {
      throw invalidQueueItem();
    }
    const capacity = Math.min(before.size, maxBytes) + 1;
    const buffer = Buffer.allocUnsafe(capacity);
    let total = 0;
    while (total < capacity) {
      const result = await handle.read(buffer, total, capacity - total, total);
      if (result.bytesRead === 0) {
        break;
      }
      total += result.bytesRead;
      if (total > maxBytes) {
        throw invalidQueueItem();
      }
    }
    const after = await handle.stat();
    assertNoReparsePoints(filePath);
    const current = await lstat(filePath);
    if (!sameFileSnapshot(before, after) || !sameFileSnapshot(after, current)) {
      throw invalidQueueItem();
    }
    return buffer.subarray(0, total);
  } finally {
    await handle?.close();
  }
};

const parseClaimReservation = (bytes: Buffer): ClaimReservationRecord => {
  try {
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return ClaimReservationRecordSchema.parse(raw);
  } catch {
    throw invalidQueueItem();
  }
};

const isMissingPathError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const sameFileIdentity = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

type ReservationFile = Readonly<{ record: ClaimReservationRecord; snapshot: Stats }>;

const readReservationFile = async (path: string): Promise<ReservationFile> => {
  const before = await lstat(path);
  const record = parseClaimReservation(await readBounded(path, CLAIM_RESERVATION_MAX_BYTES));
  const after = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !after.isFile() ||
    after.isSymbolicLink() ||
    !sameFileSnapshot(before, after)
  ) {
    throw invalidQueueItem();
  }
  return Object.freeze({ record, snapshot: after });
};

const readReservationFileIfPresent = async (path: string): Promise<ReservationFile | null> => {
  try {
    return await readReservationFile(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
};

const reservationMatches = (
  expected: Readonly<{ record: ClaimReservationRecord; snapshot: Stats }>,
  actual: ReservationFile,
): boolean =>
  sameFileIdentity(expected.snapshot, actual.snapshot) &&
  expected.record.jobId === actual.record.jobId &&
  expected.record.sourceKind === actual.record.sourceKind &&
  expected.record.claimToken === actual.record.claimToken;

export const readClaimReservation = async (
  path: string,
  anchorPath: string,
  quarantineRoot: string,
  hooks: ClaimReservationHooks = {},
): Promise<ClaimReservation | null> => {
  const quarantinePath = claimReservationQuarantinePath(anchorPath, quarantineRoot);
  const [marker, anchor, quarantine] = await Promise.all([
    readReservationFileIfPresent(path),
    readReservationFileIfPresent(anchorPath),
    readReservationFileIfPresent(quarantinePath),
  ]);
  if (marker === null && anchor === null && quarantine === null) {
    return null;
  }
  const current = marker ?? anchor;
  if (current === null) {
    throw invalidQueueItem();
  }
  if (
    basename(path) !== current.record.jobId ||
    basename(anchorPath) !== `.claim-${current.record.sourceKind}-${current.record.jobId}.json`
  ) {
    throw invalidQueueItem();
  }
  if (marker !== null && anchor !== null && !reservationMatches(marker, anchor)) {
    throw invalidQueueItem();
  }
  if (quarantine !== null && !reservationMatches(current, quarantine)) {
    throw invalidQueueItem();
  }
  let reservation: ClaimReservation = Object.freeze({
    anchorPath,
    path,
    quarantineRoot,
    ...current,
  });
  if (quarantine !== null) {
    await recoverClaimReservationPublication(reservation, quarantinePath, hooks);
    const [recoveredMarker, recoveredAnchor] = await Promise.all([
      readReservationFileIfPresent(path),
      readReservationFileIfPresent(anchorPath),
    ]);
    if (
      recoveredMarker === null ||
      (recoveredAnchor !== null && !reservationMatches(recoveredMarker, recoveredAnchor))
    ) {
      throw invalidQueueItem();
    }
    reservation = Object.freeze({
      anchorPath,
      path,
      quarantineRoot,
      ...recoveredMarker,
    });
  }
  return reservation;
};

export const readOwnedClaimReservation = async (
  location: ClaimReservationLocation,
  owner: Readonly<{ jobId: string; sourceKind: ICloudSourceKind }>,
): Promise<ClaimReservation | null> => {
  const reservation = await readClaimReservation(
    location.path,
    location.anchorPath,
    location.quarantineRoot,
  );
  if (
    reservation !== null &&
    (reservation.record.jobId !== owner.jobId || reservation.record.sourceKind !== owner.sourceKind)
  ) {
    throw invalidQueueItem();
  }
  return reservation;
};

export const isClaimReservationCollision = async (
  location: ClaimReservationLocation,
  owner: Readonly<{ jobId: string; sourceKind: ICloudSourceKind }>,
): Promise<boolean> =>
  readOwnedClaimReservation(location, owner).then(
    () => false,
    () => true,
  );

const randomQuarantinePath = (quarantineRoot: string): string =>
  join(quarantineRoot, `.claim-quarantine-${randomUUID()}`);

const claimReservationQuarantinePath = (anchorPath: string, quarantineRoot: string): string => {
  const anchorName = basename(anchorPath);
  const match = /^\.claim-(icloud(?:_course)?)-([0-9A-Fa-f-]{36})\.json$/u.exec(anchorName);
  if (
    match === null ||
    join(quarantineRoot, anchorName) !== anchorPath ||
    !z.uuid().safeParse(match[2]).success
  ) {
    throw invalidQueueItem();
  }
  return join(quarantineRoot, `.claim-quarantine-${match[1]}-${match[2]}.json`);
};

const quarantineAndRemoveOwnedPath = async (
  path: string,
  expected: Readonly<{ record?: ClaimReservationRecord; snapshot: Stats }>,
  quarantineRoot: string,
): Promise<void> => {
  const destination = randomQuarantinePath(quarantineRoot);
  assertNoReparsePoints(path);
  assertNoReparsePoints(destination);
  try {
    await rename(path, destination);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  const movedStats = await lstat(destination);
  if (!movedStats.isFile() || !sameFileIdentity(expected.snapshot, movedStats)) {
    throw invalidQueueItem();
  }
  if (expected.record !== undefined) {
    const moved = await readReservationFile(destination);
    if (!reservationMatches({ record: expected.record, snapshot: expected.snapshot }, moved)) {
      throw invalidQueueItem();
    }
  }
  await unlink(destination);
};

const recoverClaimReservationPublication = async (
  reservation: ClaimReservation,
  destination: string,
  hooks: ClaimReservationHooks = {},
): Promise<void> => {
  const publishLink = hooks.link ?? link;
  const moved = await readReservationFile(destination);
  if (!reservationMatches(reservation, moved)) {
    throw invalidQueueItem();
  }
  const current = await readReservationFileIfPresent(reservation.path);
  if (current !== null) {
    if (!reservationMatches(reservation, current)) {
      throw invalidQueueItem();
    }
  } else {
    assertNoReparsePoints(reservation.path);
    assertNoReparsePoints(destination);
    await publishLink(destination, reservation.path);
    const restored = await readReservationFile(reservation.path);
    if (!reservationMatches(reservation, restored)) {
      throw invalidQueueItem();
    }
  }
  await quarantineAndRemoveOwnedPath(
    destination,
    { record: reservation.record, snapshot: reservation.snapshot },
    reservation.quarantineRoot,
  );
};

export const createClaimReservation = async (
  path: string,
  anchorPath: string,
  quarantineRoot: string,
  record: ClaimReservationRecord,
  hooks: ClaimReservationHooks = {},
): Promise<ClaimReservation> => {
  const parsed = ClaimReservationRecordSchema.parse(record);
  let handle: FileHandle | undefined;
  let snapshot: Stats | undefined;
  try {
    assertNoReparsePoints(path);
    handle = await open(path, 'wx', 0o600);
    snapshot = await handle.stat();
    await hooks.beforeWrite?.();
    await handle.writeFile(`${JSON.stringify(parsed)}\n`, 'utf8');
    await hooks.beforeSync?.();
    await handle.sync();
    await handle.close();
    handle = undefined;
    const current = await readReservationFile(path);
    if (!sameFileIdentity(snapshot, current.snapshot)) {
      throw invalidQueueItem();
    }
    return Object.freeze({
      anchorPath,
      path,
      quarantineRoot,
      record: parsed,
      snapshot: current.snapshot,
    });
  } catch {
    await handle?.close().catch(() => undefined);
    if (snapshot !== undefined) {
      try {
        await quarantineAndRemoveOwnedPath(path, { snapshot }, quarantineRoot);
      } catch {
        // Preserve an attacker replacement moved into quarantine rather than deleting it.
      }
    }
    throw invalidQueueItem();
  }
};

export const acquireClaimReservation = async (
  location: ClaimReservationLocation,
  record: ClaimReservationRecord,
  hooks: ClaimReservationHooks = {},
): Promise<AcquiredClaimReservation> => {
  const existing = await readOwnedClaimReservation(location, record);
  if (existing !== null) {
    if (existing.record.claimToken !== record.claimToken) {
      throw invalidQueueItem();
    }
    return Object.freeze({ created: false, reservation: existing });
  }
  const reservation = await createClaimReservation(
    location.path,
    location.anchorPath,
    location.quarantineRoot,
    record,
    hooks,
  );
  return Object.freeze({ created: true, reservation });
};

export const validateClaimReservation = async (reservation: ClaimReservation): Promise<void> => {
  const current = await readClaimReservation(
    reservation.path,
    reservation.anchorPath,
    reservation.quarantineRoot,
  );
  if (current === null || !reservationMatches(reservation, current)) {
    throw invalidQueueItem();
  }
};

export const validateCommittedClaimReservation = async (
  reservation: ClaimReservation,
): Promise<void> => {
  await validateClaimReservation(reservation);
  const [marker, anchor] = await Promise.all([
    readReservationFileIfPresent(reservation.path),
    readReservationFileIfPresent(reservation.anchorPath),
  ]);
  if (
    marker === null ||
    anchor === null ||
    !reservationMatches(reservation, marker) ||
    !reservationMatches(reservation, anchor) ||
    !reservationMatches(marker, anchor)
  ) {
    throw invalidQueueItem();
  }
};

export const commitClaimReservation = async (
  reservation: ClaimReservation,
  hooks: ClaimReservationHooks = {},
): Promise<ClaimReservation> => {
  const publishLink = hooks.link ?? link;
  await validateClaimReservation(reservation);
  const anchor = await readReservationFileIfPresent(reservation.anchorPath);
  if (anchor !== null && !reservationMatches(reservation, anchor)) {
    throw invalidQueueItem();
  }
  if ((await readReservationFileIfPresent(reservation.path)) === null) {
    if (anchor === null) {
      throw invalidQueueItem();
    }
    try {
      await publishLink(reservation.anchorPath, reservation.path);
    } catch {
      throw claimReservationNotCommitted();
    }
  } else if (anchor === null) {
    try {
      await publishLink(reservation.path, reservation.anchorPath);
    } catch {
      throw claimReservationNotCommitted();
    }
  }
  await hooks.beforeCommit?.(reservation.path);
  const destination = claimReservationQuarantinePath(
    reservation.anchorPath,
    reservation.quarantineRoot,
  );
  if ((await readReservationFileIfPresent(destination)) !== null) {
    throw invalidQueueItem();
  }
  assertNoReparsePoints(reservation.path);
  assertNoReparsePoints(destination);
  await rename(reservation.path, destination);
  try {
    const moved = await readReservationFile(destination);
    if (!reservationMatches(reservation, moved)) {
      throw invalidQueueItem();
    }
    await publishLink(destination, reservation.path);
    await quarantineAndRemoveOwnedPath(
      destination,
      { record: reservation.record, snapshot: reservation.snapshot },
      reservation.quarantineRoot,
    );
    return Object.freeze({ ...reservation, snapshot: moved.snapshot });
  } catch {
    let recovered = false;
    try {
      await recoverClaimReservationPublication(reservation, destination);
      recovered = true;
    } catch {
      // Preserve the quarantine and any conflicting exact path rather than deleting either.
    }
    throw recovered ? claimReservationNotCommitted() : invalidQueueItem();
  }
};

export const removeClaimReservation = async (
  reservation: ClaimReservation,
  hooks: ClaimReservationHooks = {},
): Promise<void> => {
  await validateClaimReservation(reservation);
  await hooks.beforeRemoval?.(reservation.path);
  await quarantineAndRemoveOwnedPath(
    reservation.path,
    { record: reservation.record, snapshot: reservation.snapshot },
    reservation.quarantineRoot,
  );
  await quarantineAndRemoveOwnedPath(
    reservation.anchorPath,
    { record: reservation.record, snapshot: reservation.snapshot },
    reservation.quarantineRoot,
  );
};

export const parseBundleMetadata = (
  sourceKind: ICloudSourceKind,
  raw: unknown,
  jobId: string,
): ParsedBundleMetadata => {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'protocolVersion' in raw &&
    raw.protocolVersion === 2
  ) {
    const manifest = normalizeQueueManifest(SourceBundleManifestV2Schema.parse(raw));
    if (
      manifest.jobId !== jobId ||
      (sourceKind === 'icloud' && manifest.courseProvisioning !== null) ||
      (sourceKind === 'icloud_course' && manifest.courseProvisioning === null)
    ) {
      throw invalidQueueItem();
    }
    return Object.freeze({ manifest, courseProvisioning: manifest.courseProvisioning });
  }
  if (sourceKind === 'icloud') {
    const manifest = normalizeQueueManifest(QueueManifestSchema.parse(raw));
    if (manifest.jobId !== jobId) {
      throw invalidQueueItem();
    }
    return Object.freeze({ manifest, courseProvisioning: null });
  }
  const request = CourseInboxRequestSchema.parse(raw);
  if (request.jobId !== jobId) {
    throw invalidQueueItem();
  }
  return Object.freeze({
    manifest: normalizeQueueManifest(toQueueManifest(request)),
    courseProvisioning: request.course,
  });
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
};

const metadataFileForPath = async (
  jobPath: string,
  sourceKind: ICloudSourceKind,
): Promise<string> =>
  sourceKind === 'icloud_course' && (await pathExists(join(jobPath, 'manifest.json')))
    ? 'manifest.json'
    : QUEUE_BUNDLE_CONFIG[sourceKind].metadataFile;

export const readQueueBundleMetadata = async (
  jobPath: string,
  sourceKind: ICloudSourceKind,
  jobId: string,
): Promise<ParsedBundleMetadata> => {
  const metadataFile = await metadataFileForPath(jobPath, sourceKind);
  const bytes = await readBounded(join(jobPath, metadataFile), METADATA_MAX_BYTES);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw invalidQueueItem();
  }
  try {
    return parseBundleMetadata(sourceKind, raw, jobId);
  } catch (error) {
    if (AppError.isTrusted(error)) {
      throw error;
    }
    throw invalidQueueItem();
  }
};

export const sourceLimit = (
  source: NormalizedSourceBundleManifest['sources'][number],
  limits: SourceLimits,
): number =>
  source.mediaType === 'audio' || source.mediaType === 'video'
    ? limits.audioVideoMaxBytes
    : limits.documentImageMaxBytes;

export const isSourceFileName = (name: string): boolean => SOURCE_FILE.test(name);

const v2SourceFileName = (
  source: NormalizedSourceBundleManifest['sources'][number],
  ordinal: number,
): string => `${ordinal}-${source.id}${extensionOf(source.fileName)}`;

const queueSourceFile = async (
  jobPath: string,
  sourceFileName: string,
  ordinal: number,
): Promise<QueueSourceFile> => {
  const sourcePath = join(jobPath, sourceFileName);
  assertNoReparsePoints(sourcePath);
  const snapshot = await lstat(sourcePath);
  if (!snapshot.isFile() || snapshot.isSymbolicLink() || snapshot.size < 1) {
    throw invalidQueueItem();
  }
  return Object.freeze({ ordinal, sourceFileName, sourcePath, snapshot });
};

const readV1QueueBundle = async (
  jobPath: string,
  sourceKind: ICloudSourceKind,
  metadata: ParsedBundleMetadata,
  limits: SourceLimits,
): Promise<QueueSourceBundle> => {
  const metadataFile = QUEUE_BUNDLE_CONFIG[sourceKind].metadataFile;
  const entries = await readDirectoryEntriesBounded(jobPath, MAX_JOB_DIRECTORY_ENTRIES);
  const metadataEntry = entries.find((entry) => entry.name === metadataFile);
  const ready = entries.find((entry) => entry.name === 'ready');
  const sources = entries.filter((entry) => isSourceFileName(entry.name));
  const descriptor = metadata.manifest.sources[0];
  if (descriptor === undefined) {
    throw invalidQueueItem();
  }
  const expectedSourceName = `source${extensionOf(descriptor.fileName)}`;
  if (
    entries.length !== MAX_JOB_DIRECTORY_ENTRIES ||
    metadataEntry === undefined ||
    !metadataEntry.isFile() ||
    metadataEntry.isSymbolicLink() ||
    ready === undefined ||
    !ready.isFile() ||
    ready.isSymbolicLink() ||
    sources.length !== 1 ||
    sources[0]?.name !== expectedSourceName ||
    !sources[0].isFile() ||
    sources[0].isSymbolicLink()
  ) {
    throw invalidQueueItem();
  }
  const readyPath = join(jobPath, ready.name);
  assertNoReparsePoints(join(jobPath, metadataFile));
  assertNoReparsePoints(readyPath);
  const readyStats = await lstat(readyPath);
  if (readyStats.size !== 0) {
    throw invalidQueueItem();
  }
  const source = await queueSourceFile(jobPath, expectedSourceName, 0);
  if (source.snapshot.size > sourceLimit(descriptor, limits)) {
    throw sourceTooLarge();
  }
  return Object.freeze({ ...metadata, sources: Object.freeze([source]) });
};

const readV2QueueBundle = async (
  jobPath: string,
  metadata: ParsedBundleMetadata,
  limits: SourceLimits,
): Promise<QueueSourceBundle> => {
  const rootEntries = await readDirectoryEntriesBounded(jobPath, 2);
  const manifestEntry = rootEntries.find((entry) => entry.name === 'manifest.json');
  const sourcesEntry = rootEntries.find((entry) => entry.name === 'sources');
  if (
    rootEntries.length !== 2 ||
    manifestEntry === undefined ||
    !manifestEntry.isFile() ||
    manifestEntry.isSymbolicLink() ||
    sourcesEntry === undefined ||
    !sourcesEntry.isDirectory() ||
    sourcesEntry.isSymbolicLink()
  ) {
    throw invalidQueueItem();
  }
  const sourcesPath = join(jobPath, 'sources');
  assertNoReparsePoints(join(jobPath, 'manifest.json'));
  assertNoReparsePoints(sourcesPath);
  const sourceEntries = await readDirectoryEntriesBounded(sourcesPath, MAX_SOURCES_PER_BUNDLE);
  if (sourceEntries.length !== metadata.manifest.sources.length) {
    throw invalidQueueItem();
  }
  const sources: QueueSourceFile[] = [];
  for (const [ordinal, descriptor] of metadata.manifest.sources.entries()) {
    const expectedName = v2SourceFileName(descriptor, ordinal);
    const entry = sourceEntries.find((candidate) => candidate.name === expectedName);
    if (entry === undefined || !entry.isFile() || entry.isSymbolicLink()) {
      throw invalidQueueItem();
    }
    const source = await queueSourceFile(sourcesPath, expectedName, ordinal);
    if (source.snapshot.size !== descriptor.sizeBytes) {
      throw invalidQueueItem();
    }
    if (source.snapshot.size > sourceLimit(descriptor, limits)) {
      throw sourceTooLarge();
    }
    sources.push(source);
  }
  return Object.freeze({ ...metadata, sources: Object.freeze(sources) });
};

export const readQueueBundle = async (
  jobPath: string,
  sourceKind: ICloudSourceKind,
  metadata: ParsedBundleMetadata,
  limits: SourceLimits,
): Promise<QueueSourceBundle> => {
  return metadata.manifest.protocolVersion === 2
    ? readV2QueueBundle(jobPath, metadata, limits)
    : readV1QueueBundle(jobPath, sourceKind, metadata, limits);
};

const entrySnapshot = async (directoryPath: string, entry: Dirent) => {
  const stats = await lstat(join(directoryPath, entry.name));
  return Object.freeze({
    name: entry.name,
    kind: entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : 'file',
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  });
};

const metadataDigest = async (
  jobPath: string,
  sourceKind: ICloudSourceKind,
): Promise<string | null> => {
  try {
    const metadataFile = await metadataFileForPath(jobPath, sourceKind);
    const bytes = await readBounded(join(jobPath, metadataFile), METADATA_MAX_BYTES);
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return null;
  }
};

export const snapshotQueueBundle = async (
  jobPath: string,
  sourceKind: ICloudSourceKind,
): Promise<string | null> => {
  const metadataFile = await metadataFileForPath(jobPath, sourceKind);
  const entries = await readDirectoryEntriesBounded(jobPath, MAX_JOB_DIRECTORY_ENTRIES);
  const hasV2Shape = entries.some((entry) => entry.name === 'sources');
  if (!hasV2Shape) {
    if (
      entries.length <= MAX_JOB_DIRECTORY_ENTRIES &&
      (!entries.some((entry) => entry.name === metadataFile) ||
        !entries.some((entry) => entry.name === 'ready') ||
        !entries.some((entry) => isSourceFileName(entry.name)))
    ) {
      return null;
    }
    return JSON.stringify({
      metadataDigest: await metadataDigest(jobPath, sourceKind),
      root: await Promise.all(entries.map((entry) => entrySnapshot(jobPath, entry))),
    });
  }

  if (
    !entries.some((entry) => entry.name === 'manifest.json') ||
    !entries.some((entry) => entry.name === 'sources')
  ) {
    return null;
  }
  const sourcesPath = join(jobPath, 'sources');
  const sourcesDirectoryEntry = entries.find((entry) => entry.name === 'sources');
  const invalidSourcesDirectory =
    sourcesDirectoryEntry === undefined ||
    !sourcesDirectoryEntry.isDirectory() ||
    sourcesDirectoryEntry.isSymbolicLink();
  let sourceEntries: readonly Dirent[];
  try {
    sourceEntries = invalidSourcesDirectory
      ? Object.freeze([])
      : await readDirectoryEntriesBounded(sourcesPath, MAX_SOURCES_PER_BUNDLE);
  } catch {
    sourceEntries = Object.freeze([]);
  }
  let metadata: ParsedBundleMetadata | null = null;
  try {
    metadata = await readQueueBundleMetadata(jobPath, sourceKind, basename(jobPath));
  } catch {
    // A structurally committed but invalid manifest is surfaced for durable rejection after stability.
  }
  if (metadata?.manifest.protocolVersion === 2 && !invalidSourcesDirectory) {
    if (sourceEntries.length < metadata.manifest.sources.length) {
      return null;
    }
    const sourceEntriesByName = new Map(sourceEntries.map((entry) => [entry.name, entry]));
    for (const [ordinal, descriptor] of metadata.manifest.sources.entries()) {
      const expected = sourceEntriesByName.get(v2SourceFileName(descriptor, ordinal));
      if (expected === undefined) {
        if (sourceEntries.length === metadata.manifest.sources.length) {
          break;
        }
        return null;
      }
      if (expected.isFile() && !expected.isSymbolicLink()) {
        const stats = await lstat(join(sourcesPath, expected.name));
        if (stats.size !== descriptor.sizeBytes) {
          return null;
        }
      }
    }
  }
  return JSON.stringify({
    metadataDigest: await metadataDigest(jobPath, sourceKind),
    root: await Promise.all(entries.map((entry) => entrySnapshot(jobPath, entry))),
    sources: await Promise.all(sourceEntries.map((entry) => entrySnapshot(sourcesPath, entry))),
  });
};

export const validateQueueBundleForCleanup = async (
  directoryPath: string,
  sourceKind: ICloudSourceKind,
  requireComplete: boolean,
  expectedJobId?: string,
): Promise<readonly QueueCleanupEntry[]> => {
  assertNoReparsePoints(directoryPath);
  const stats = await lstat(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw invalidQueueItem();
  }
  const jobId = z.uuid().safeParse(expectedJobId ?? basename(directoryPath));
  if (requireComplete && !jobId.success) {
    throw invalidQueueItem();
  }
  let completeBundle: QueueSourceBundle | undefined;
  if (requireComplete) {
    if (!jobId.success) {
      throw invalidQueueItem();
    }
    const metadata = await readQueueBundleMetadata(directoryPath, sourceKind, jobId.data);
    completeBundle = await readQueueBundle(
      directoryPath,
      sourceKind,
      metadata,
      DEFAULT_SOURCE_LIMITS,
    );
  }
  if (completeBundle?.manifest.protocolVersion === 2) {
    return Object.freeze([
      Object.freeze({ kind: 'file', relativePath: 'manifest.json' }),
      ...completeBundle.sources.map((source) =>
        Object.freeze({
          kind: 'file' as const,
          relativePath: `sources/${source.sourceFileName}`,
        }),
      ),
      Object.freeze({ kind: 'directory', relativePath: 'sources' }),
    ]);
  }
  const metadataFile = QUEUE_BUNDLE_CONFIG[sourceKind].metadataFile;
  const entries = await readDirectoryEntriesBounded(directoryPath, MAX_JOB_DIRECTORY_ENTRIES);
  const allowed = entries.every(
    (entry) =>
      (entry.name === metadataFile || entry.name === 'ready' || isSourceFileName(entry.name)) &&
      entry.isFile() &&
      !entry.isSymbolicLink(),
  );
  const sourceCount = entries.filter((entry) => isSourceFileName(entry.name)).length;
  if (
    !allowed ||
    entries.length > MAX_JOB_DIRECTORY_ENTRIES ||
    sourceCount > 1 ||
    (requireComplete &&
      (entries.length !== MAX_JOB_DIRECTORY_ENTRIES ||
        sourceCount !== 1 ||
        !entries.some((entry) => entry.name === metadataFile) ||
        !entries.some((entry) => entry.name === 'ready')))
  ) {
    throw invalidQueueItem();
  }
  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name);
    assertNoReparsePoints(entryPath);
    if (entry.name === 'ready' && (await lstat(entryPath)).size !== 0) {
      throw invalidQueueItem();
    }
  }
  if (completeBundle !== undefined && completeBundle.manifest.protocolVersion !== 1) {
    throw invalidQueueItem();
  }
  return Object.freeze(
    entries.map((entry) => Object.freeze({ kind: 'file' as const, relativePath: entry.name })),
  );
};
