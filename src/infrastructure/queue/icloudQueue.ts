import { createHash, randomUUID } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { lstat, mkdir, opendir, rename, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { sha256File } from '../../core/jobs/fingerprint';
import { assertNoReparsePoints } from '../../core/paths/safePath';
import type {
  ClaimedSource,
  ClaimedSourceRecord,
  QueuePort,
  ReadyQueueItem,
} from '../../core/ports/queue';
import type { VaultConnection } from '../../core/ports/vault';
import type { ICloudSourceKind } from '../../shared/contracts/job';
import {
  type NormalizedSourceBundleManifest,
  type RejectionReceipt,
  RejectionReceiptSchema,
  type StatusReceipt,
  StatusReceiptSchema,
} from '../../shared/contracts/queue';
import { extensionOf } from '../../shared/contracts/sourceFile';
import {
  APP_ERROR_MESSAGES,
  AppError,
  type AppErrorCode,
  toErrorEnvelope,
} from '../../shared/errors';
import { assertManagedDirectory, atomicReplace } from '../filesystem/atomicWrite';
import { VaultWriter } from '../vault/vaultWriter';
import {
  type AcquiredClaimReservation,
  acquireClaimReservation,
  type ClaimReservation,
  type ClaimReservationHooks,
  type ClaimReservationLocation,
  commitClaimReservation,
  DEFAULT_SOURCE_LIMITS,
  isClaimReservationCollision,
  QUEUE_BUNDLE_CONFIG,
  type QueueCleanupEntry,
  readBounded,
  readDirectoryEntriesBounded,
  readOwnedClaimReservation,
  readQueueBundle,
  readQueueBundleMetadata,
  removeClaimReservation,
  type SourceLimits,
  SourceLimitsSchema,
  sameFileSnapshot,
  snapshotQueueBundle,
  sourceLimit,
  validateCommittedClaimReservation,
  validateQueueBundleForCleanup,
} from './icloudSourceBundle';
import {
  connectQueueRoot,
  createSafeRootConnection,
  ensureQueueLayout,
  queuePath,
  toQueueWriteError,
} from './queueLayout';

const RECEIPT_MAX_BYTES = 16 * 1024;
const DEFAULT_STABILITY_MS = 1_000;
const DEFAULT_MAX_SCAN_ENTRIES = 250;
const DEFAULT_MAX_READY_ITEMS = 10;
const OBSERVATION_TTL_MS = 10 * 60 * 1_000;
const MAX_OBSERVATIONS = 10_000;
const CLEANUP_DIRECTORY = /^\.completed-(icloud(?:_course)?)-([0-9a-f-]{36})$/u;
const SOURCE_SCAN_ORDER = Object.freeze(['icloud_course', 'icloud'] as const);
const ICloudSourceKindSchema = z.enum(SOURCE_SCAN_ORDER);

const ReadyQueueItemSchema = z
  .strictObject({
    jobId: z.uuid(),
    claimToken: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceKind: ICloudSourceKindSchema,
  })
  .readonly();

export type ICloudQueueDependencies = Readonly<{
  afterClaimReservation?: (reservationPath: string) => void | Promise<void>;
  afterStagingCopy?: (stagedSourcePath: string) => void | Promise<void>;
  beforeClaimReservationCommit?: ClaimReservationHooks['beforeCommit'];
  beforeClaimReservationRemoval?: ClaimReservationHooks['beforeRemoval'];
  beforeClaimReservationSync?: ClaimReservationHooks['beforeSync'];
  beforeClaimReservationWrite?: ClaimReservationHooks['beforeWrite'];
  beforeCompletedCleanupRename?: (sourcePath: string, cleanupPath: string) => void | Promise<void>;
  beforeCompletedEntryRemoval?: (entryPath: string, quarantinePath: string) => void | Promise<void>;
  claimReservationLink?: ClaimReservationHooks['link'];
  clock?: () => number;
  stabilityMs?: number;
  idGenerator?: () => string;
  sourceLimits?: SourceLimits;
  maxScanEntries?: number;
  maxReadyItems?: number;
  openScanDirectory?: (path: string) => Promise<ScanDirectory>;
  readBundleMetadata?: typeof readQueueBundleMetadata;
}>;

export type ScanDirectory = Readonly<{
  close: () => Promise<void>;
  read: () => Promise<Dirent | null>;
}>;

type Observation = Readonly<{
  claimToken: string;
  lastSeenAt: number;
  observedAt: number;
  signature: string;
}>;

const REJECTED_ERROR_CODES: ReadonlySet<AppErrorCode> = new Set([
  'INVALID_QUEUE_ITEM',
  'SOURCE_HASH_MISMATCH',
  'SOURCE_TOO_LARGE',
]);

const invalidQueueItem = () =>
  new AppError('INVALID_QUEUE_ITEM', APP_ERROR_MESSAGES.INVALID_QUEUE_ITEM);
const unstableQueueItem = (): AppError =>
  new AppError('QUEUE_ITEM_NOT_STABLE', APP_ERROR_MESSAGES.QUEUE_ITEM_NOT_STABLE);
const sourceCopyError = () =>
  new AppError('SOURCE_COPY_FAILED', APP_ERROR_MESSAGES.SOURCE_COPY_FAILED);

const normalizeClaimError = (error: unknown): AppError =>
  AppError.isTrusted(error) ? error : invalidQueueItem();

const isMissingPathError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const isClosedDirectoryError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ERR_DIR_CLOSED';

const closeDirectory = async (directory: ScanDirectory): Promise<void> => {
  try {
    await directory.close();
  } catch (error) {
    if (!isClosedDirectoryError(error)) {
      throw error;
    }
  }
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

const claimTokenForSignature = (signature: string): string =>
  createHash('sha256').update(signature, 'utf8').digest('hex');

const sameFileIdentity = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const sameRenamedFileSnapshot = (left: Stats, right: Stats): boolean =>
  sameFileIdentity(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs;

type ValidatedCompletedEntry = Readonly<
  QueueCleanupEntry & {
    stats: Stats;
  }
>;

type ValidatedCompletedBundle = Readonly<{
  directoryStats: Stats;
  entries: readonly ValidatedCompletedEntry[];
  signature: string;
}>;

const validateCompletedBundle = async (
  directoryPath: string,
  sourceKind: ICloudSourceKind,
  jobId: string,
): Promise<ValidatedCompletedBundle> => {
  const before = await lstat(directoryPath);
  const beforeSignature = await snapshotQueueBundle(directoryPath, sourceKind);
  const entries = await validateQueueBundleForCleanup(directoryPath, sourceKind, true, jobId);
  const validatedEntries = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(directoryPath, entry.relativePath);
      assertNoReparsePoints(entryPath);
      const stats = await lstat(entryPath);
      const matchesKind = entry.kind === 'file' ? stats.isFile() : stats.isDirectory();
      if (!matchesKind || stats.isSymbolicLink()) {
        throw invalidQueueItem();
      }
      return Object.freeze({ ...entry, stats });
    }),
  );
  const afterSignature = await snapshotQueueBundle(directoryPath, sourceKind);
  const after = await lstat(directoryPath);
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    !sameFileIdentity(before, after) ||
    beforeSignature === null ||
    beforeSignature !== afterSignature
  ) {
    throw invalidQueueItem();
  }
  return Object.freeze({
    directoryStats: after,
    entries: Object.freeze(validatedEntries),
    signature: beforeSignature,
  });
};

const removeValidatedCompletedEntry = async (
  connection: VaultConnection,
  cleanupPath: string,
  validated: ValidatedCompletedBundle['entries'][number],
  beforeRemoval: NonNullable<ICloudQueueDependencies['beforeCompletedEntryRemoval']>,
): Promise<void> => {
  const entryPath = join(cleanupPath, validated.relativePath);
  const quarantinePath = queuePath(
    connection,
    'Rejected',
    `.completed-entry-quarantine-${randomUUID()}`,
  );
  assertNoReparsePoints(entryPath);
  assertNoReparsePoints(quarantinePath);
  const current = await lstat(entryPath);
  if (validated.kind === 'directory') {
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameFileIdentity(validated.stats, current) ||
      (await readDirectoryEntriesBounded(entryPath, 0)).length !== 0
    ) {
      throw invalidQueueItem();
    }
    await beforeRemoval(entryPath, quarantinePath);
    await rename(entryPath, quarantinePath);
    const moved = await lstat(quarantinePath);
    if (
      !moved.isDirectory() ||
      moved.isSymbolicLink() ||
      !sameFileIdentity(validated.stats, moved) ||
      (await readDirectoryEntriesBounded(quarantinePath, 0)).length !== 0
    ) {
      throw invalidQueueItem();
    }
    await rmdir(quarantinePath);
    return;
  }
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    !sameFileSnapshot(validated.stats, current)
  ) {
    throw invalidQueueItem();
  }
  await beforeRemoval(entryPath, quarantinePath);
  await rename(entryPath, quarantinePath);
  const moved = await lstat(quarantinePath);
  if (
    !moved.isFile() ||
    moved.isSymbolicLink() ||
    !sameRenamedFileSnapshot(validated.stats, moved)
  ) {
    throw invalidQueueItem();
  }
  await unlink(quarantinePath);
};

const removeValidatedCompletedDirectory = async (
  connection: VaultConnection,
  cleanupPath: string,
  expected: Stats,
): Promise<void> => {
  const quarantinePath = queuePath(
    connection,
    'Rejected',
    `.completed-directory-quarantine-${randomUUID()}`,
  );
  assertNoReparsePoints(cleanupPath);
  assertNoReparsePoints(quarantinePath);
  const current = await lstat(cleanupPath);
  if (!current.isDirectory() || current.isSymbolicLink() || !sameFileIdentity(expected, current)) {
    throw invalidQueueItem();
  }
  await rename(cleanupPath, quarantinePath);
  const moved = await lstat(quarantinePath);
  if (!moved.isDirectory() || moved.isSymbolicLink() || !sameFileIdentity(expected, moved)) {
    throw invalidQueueItem();
  }
  if ((await readDirectoryEntriesBounded(quarantinePath, 0)).length !== 0) {
    throw invalidQueueItem();
  }
  await rmdir(quarantinePath);
};

const observationKey = (sourceKind: ICloudSourceKind, jobId: string): string =>
  `${sourceKind}:${jobId}`;

const hasDurableRejection = async (
  connection: VaultConnection,
  jobId: string,
  requiredErrorCode?: AppErrorCode,
): Promise<boolean> => {
  try {
    const bytes = await readBounded(
      queuePath(connection, 'Rejected', `${jobId}.json`),
      RECEIPT_MAX_BYTES,
    );
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const receipt = RejectionReceiptSchema.parse(raw);
    if (receipt.jobId !== jobId) {
      throw invalidQueueItem();
    }
    return requiredErrorCode === undefined || receipt.errorCode === requiredErrorCode;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
};

const requireCompletedReceipt = async (
  connection: VaultConnection,
  jobId: string,
): Promise<void> => {
  const bytes = await readBounded(
    queuePath(connection, 'Status', `${jobId}.json`),
    RECEIPT_MAX_BYTES,
  );
  const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const receipt = StatusReceiptSchema.parse(raw);
  if (receipt.jobId !== jobId || receipt.status !== 'completed') {
    throw invalidQueueItem();
  }
};

const claimReservationLocation = (
  connection: VaultConnection,
  sourceKind: ICloudSourceKind,
  jobId: string,
): ClaimReservationLocation => {
  const otherSourceKind: ICloudSourceKind = sourceKind === 'icloud' ? 'icloud_course' : 'icloud';
  const directoryPath = queuePath(connection, QUEUE_BUNDLE_CONFIG[otherSourceKind].directory);
  const quarantineRoot = queuePath(connection, 'Rejected');
  return Object.freeze({
    anchorPath: queuePath(connection, 'Rejected', `.claim-${sourceKind}-${jobId}.json`),
    path: join(directoryPath, jobId),
    quarantineRoot,
  });
};

const readQueueClaimReservation = (
  connection: VaultConnection,
  sourceKind: ICloudSourceKind,
  jobId: string,
): Promise<ClaimReservation | null> =>
  readOwnedClaimReservation(
    claimReservationLocation(connection, sourceKind, jobId),
    Object.freeze({ jobId, sourceKind }),
  );

const acquireQueueClaimReservation = async (
  connection: VaultConnection,
  item: ReadyQueueItem,
  hooks: ClaimReservationHooks,
): Promise<AcquiredClaimReservation> => {
  const location = claimReservationLocation(connection, item.sourceKind, item.jobId);
  await assertManagedDirectory(connection, dirname(location.path));
  return acquireClaimReservation(
    location,
    Object.freeze({ jobId: item.jobId, sourceKind: item.sourceKind, claimToken: item.claimToken }),
    hooks,
  );
};

type StagedClaim = Readonly<{
  directoryPath: string;
  directorySnapshot: Stats;
  expectedFiles: readonly Readonly<{
    name: string;
    sha256: string;
    snapshot: Stats;
  }>[];
}>;

const removeOwnedStagingJob = async (
  connection: VaultConnection,
  staged: StagedClaim,
): Promise<void> => {
  if (!(await pathExists(staged.directoryPath))) {
    return;
  }
  assertNoReparsePoints(staged.directoryPath);
  const directoryStats = await lstat(staged.directoryPath);
  if (
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    !sameFileIdentity(directoryStats, staged.directorySnapshot)
  ) {
    throw sourceCopyError();
  }
  const cleanupPath = join(connection.managedRoot, `.failed-claim-${randomUUID()}`);
  assertNoReparsePoints(cleanupPath);
  await rename(staged.directoryPath, cleanupPath);
  const movedStats = await lstat(cleanupPath);
  if (!sameFileIdentity(movedStats, staged.directorySnapshot)) {
    throw sourceCopyError();
  }
  const entries = await readDirectoryEntriesBounded(cleanupPath, staged.expectedFiles.length);
  if (entries.length !== staged.expectedFiles.length) {
    throw sourceCopyError();
  }
  for (const expected of staged.expectedFiles) {
    const entry = entries.find((candidate) => candidate.name === expected.name);
    if (entry === undefined || !entry.isFile() || entry.isSymbolicLink()) {
      throw sourceCopyError();
    }
    const sourcePath = join(cleanupPath, entry.name);
    assertNoReparsePoints(sourcePath);
    const before = await lstat(sourcePath);
    if (!sameFileSnapshot(before, expected.snapshot)) {
      throw sourceCopyError();
    }
    const actualSha256 = await sha256File(sourcePath);
    const after = await lstat(sourcePath);
    if (actualSha256 !== expected.sha256 || !sameFileSnapshot(before, after)) {
      throw sourceCopyError();
    }
    await unlink(sourcePath);
  }
  if ((await readDirectoryEntriesBounded(cleanupPath, 0)).length !== 0) {
    throw sourceCopyError();
  }
  await rmdir(cleanupPath);
};

const connectStagingRoot = async (stagingRoot: string): Promise<VaultConnection> => {
  try {
    return await createSafeRootConnection(stagingRoot);
  } catch (error) {
    if (AppError.isTrusted(error) && error.code === 'SAFE_PATH') {
      throw error;
    }
    throw sourceCopyError();
  }
};

type StagedBundleResult = Readonly<{
  records: readonly ClaimedSourceRecord[];
  stagingDirectoryPath: string;
}>;

const stagedSourceName = (manifest: NormalizedSourceBundleManifest, ordinal: number): string => {
  const source = manifest.sources[ordinal];
  if (source === undefined) {
    throw invalidQueueItem();
  }
  return manifest.protocolVersion === 1
    ? `source${extensionOf(source.fileName)}`
    : `${ordinal}-${source.id}${extensionOf(source.fileName)}`;
};

const claimedRecord = (
  manifest: NormalizedSourceBundleManifest,
  ordinal: number,
  stagedPath: string,
  sha256: string,
  sizeBytes: number,
): ClaimedSourceRecord => {
  const source = manifest.sources[ordinal];
  if (source === undefined) {
    throw invalidQueueItem();
  }
  return Object.freeze({
    id: source.id,
    mediaType: source.mediaType,
    ordinal,
    originalFileName: source.fileName,
    sha256,
    sizeBytes,
    stagedPath,
  });
};

const hashQueueSources = async (
  bundle: Awaited<ReturnType<typeof readQueueBundle>>,
  limits: SourceLimits,
): Promise<readonly string[]> => {
  const hashes: string[] = [];
  for (const source of bundle.sources) {
    const descriptor = bundle.manifest.sources[source.ordinal];
    if (descriptor === undefined) {
      throw invalidQueueItem();
    }
    const sha256 = await sha256File(source.sourcePath, {
      maxBytes: sourceLimit(descriptor, limits),
    });
    const current = await lstat(source.sourcePath);
    if (!sameFileSnapshot(source.snapshot, current)) {
      throw unstableQueueItem();
    }
    hashes.push(sha256);
  }
  return Object.freeze(hashes);
};

const validateSenderHash = (expected: string | undefined, actual: string): void => {
  if (expected !== undefined && expected !== actual) {
    throw new AppError('SOURCE_HASH_MISMATCH', APP_ERROR_MESSAGES.SOURCE_HASH_MISMATCH);
  }
};

const validateExistingStaging = async (
  connection: VaultConnection,
  bundle: Awaited<ReturnType<typeof readQueueBundle>>,
  queueHashes: readonly string[],
  limits: SourceLimits,
  directoryPath: string,
): Promise<StagedBundleResult> => {
  assertNoReparsePoints(directoryPath);
  const stats = await lstat(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw sourceCopyError();
  }
  const entries = await readDirectoryEntriesBounded(directoryPath, bundle.manifest.sources.length);
  if (entries.length !== bundle.manifest.sources.length) {
    throw sourceCopyError();
  }
  const records: ClaimedSourceRecord[] = [];
  const stagedHashes = new Set<string>();
  for (const [ordinal, descriptor] of bundle.manifest.sources.entries()) {
    const name = stagedSourceName(bundle.manifest, ordinal);
    const entry = entries.find((candidate) => candidate.name === name);
    if (entry === undefined || !entry.isFile() || entry.isSymbolicLink()) {
      throw sourceCopyError();
    }
    const stagedPath = join(directoryPath, name);
    const before = await lstat(stagedPath);
    const sha256 = await sha256File(stagedPath, {
      maxBytes: sourceLimit(descriptor, limits),
    });
    const after = await lstat(stagedPath);
    if (
      !sameFileSnapshot(before, after) ||
      before.size !== bundle.sources[ordinal]?.snapshot.size ||
      sha256 !== queueHashes[ordinal]
    ) {
      throw sourceCopyError();
    }
    validateSenderHash(descriptor.sha256, sha256);
    if (stagedHashes.has(sha256)) {
      throw invalidQueueItem();
    }
    stagedHashes.add(sha256);
    records.push(claimedRecord(bundle.manifest, ordinal, stagedPath, sha256, before.size));
  }
  await assertManagedDirectory(connection, directoryPath);
  return Object.freeze({ records: Object.freeze(records), stagingDirectoryPath: directoryPath });
};

const stageQueueBundle = async (
  connection: VaultConnection,
  bundle: Awaited<ReturnType<typeof readQueueBundle>>,
  queueHashes: readonly string[],
  limits: SourceLimits,
  allowExisting: boolean,
  onOwnedStagingChanged: (claim: StagedClaim) => void,
  beforePublication: () => Promise<void>,
): Promise<StagedBundleResult> => {
  const finalDirectoryPath = join(connection.managedRoot, bundle.manifest.jobId);
  if (await pathExists(finalDirectoryPath)) {
    if (!allowExisting) {
      throw sourceCopyError();
    }
    return validateExistingStaging(connection, bundle, queueHashes, limits, finalDirectoryPath);
  }

  const temporaryName = `.claim-${bundle.manifest.jobId}-${randomUUID()}`;
  const temporaryDirectoryPath = join(connection.managedRoot, temporaryName);
  assertNoReparsePoints(temporaryDirectoryPath);
  await mkdir(temporaryDirectoryPath);
  const directorySnapshot = await lstat(temporaryDirectoryPath);
  let ownedClaim: StagedClaim = Object.freeze({
    directoryPath: temporaryDirectoryPath,
    directorySnapshot,
    expectedFiles: Object.freeze([]),
  });
  onOwnedStagingChanged(ownedClaim);

  const writer = new VaultWriter(connection);
  const records: ClaimedSourceRecord[] = [];
  const stagedHashes = new Set<string>();
  for (const [ordinal, source] of bundle.sources.entries()) {
    const descriptor = bundle.manifest.sources[ordinal];
    const queueSha256 = queueHashes[ordinal];
    if (descriptor === undefined || queueSha256 === undefined || source.ordinal !== ordinal) {
      throw invalidQueueItem();
    }
    const name = stagedSourceName(bundle.manifest, ordinal);
    const expectedRelativePath = `${temporaryName}/${name}`;
    const actualRelativePath = await writer.copyAttachment({
      sourcePath: source.sourcePath,
      relativePath: expectedRelativePath,
      expectedSha256: queueSha256,
      maxBytes: sourceLimit(descriptor, limits),
    });
    if (actualRelativePath !== expectedRelativePath) {
      throw sourceCopyError();
    }
    const temporaryStagedPath = join(temporaryDirectoryPath, name);
    const before = await lstat(temporaryStagedPath);
    const stagedSha256 = await sha256File(temporaryStagedPath, {
      maxBytes: sourceLimit(descriptor, limits),
    });
    const after = await lstat(temporaryStagedPath);
    if (
      !sameFileSnapshot(before, after) ||
      before.size !== source.snapshot.size ||
      stagedSha256 !== queueSha256
    ) {
      throw sourceCopyError();
    }
    ownedClaim = Object.freeze({
      ...ownedClaim,
      expectedFiles: Object.freeze([
        ...ownedClaim.expectedFiles,
        Object.freeze({ name, sha256: stagedSha256, snapshot: after }),
      ]),
    });
    onOwnedStagingChanged(ownedClaim);
    validateSenderHash(descriptor.sha256, stagedSha256);
    if (stagedHashes.has(stagedSha256)) {
      throw invalidQueueItem();
    }
    stagedHashes.add(stagedSha256);
    records.push(
      claimedRecord(bundle.manifest, ordinal, temporaryStagedPath, stagedSha256, before.size),
    );
  }

  // Persist recovery ownership before making the complete bundle discoverable.
  await beforePublication();
  assertNoReparsePoints(finalDirectoryPath);
  await rename(temporaryDirectoryPath, finalDirectoryPath);
  ownedClaim = Object.freeze({ ...ownedClaim, directoryPath: finalDirectoryPath });
  onOwnedStagingChanged(ownedClaim);
  const finalRecords = records.map((record) =>
    Object.freeze({ ...record, stagedPath: join(finalDirectoryPath, basename(record.stagedPath)) }),
  );
  return Object.freeze({
    records: Object.freeze(finalRecords),
    stagingDirectoryPath: finalDirectoryPath,
  });
};

export class ICloudQueue implements QueuePort {
  readonly #afterClaimReservation: (reservationPath: string) => void | Promise<void>;
  readonly #afterStagingCopy: (stagedSourcePath: string) => void | Promise<void>;
  readonly #beforeCompletedCleanupRename: (
    sourcePath: string,
    cleanupPath: string,
  ) => void | Promise<void>;
  readonly #beforeCompletedEntryRemoval: NonNullable<
    ICloudQueueDependencies['beforeCompletedEntryRemoval']
  >;
  readonly #clock: () => number;
  readonly #claimReservationHooks: ClaimReservationHooks;
  readonly #idGenerator: () => string;
  readonly #maxReadyItems: number;
  readonly #maxScanEntries: number;
  readonly #openScanDirectory: (path: string) => Promise<ScanDirectory>;
  readonly #queueRoot: string;
  readonly #readBundleMetadata: typeof readQueueBundleMetadata;
  readonly #sourceLimits: SourceLimits;
  readonly #stabilityMs: number;
  #observations: ReadonlyMap<string, Observation> = new Map();
  #scanDirectories: ReadonlyMap<
    ICloudSourceKind,
    Readonly<{ directory: ScanDirectory; path: string }>
  > = new Map();

  constructor(queueRoot: string, dependencies: ICloudQueueDependencies = {}) {
    const stabilityMs = dependencies.stabilityMs ?? DEFAULT_STABILITY_MS;
    if (!Number.isSafeInteger(stabilityMs) || stabilityMs < DEFAULT_STABILITY_MS) {
      throw new TypeError('INVALID_QUEUE_STABILITY_MS');
    }
    const sourceLimits = SourceLimitsSchema.safeParse(
      dependencies.sourceLimits ?? DEFAULT_SOURCE_LIMITS,
    );
    if (!sourceLimits.success) {
      throw new TypeError('INVALID_QUEUE_SOURCE_LIMITS');
    }
    const maxScanEntries = z
      .int()
      .min(1)
      .max(1_000)
      .safeParse(dependencies.maxScanEntries ?? DEFAULT_MAX_SCAN_ENTRIES);
    const maxReadyItems = z
      .int()
      .min(1)
      .max(50)
      .safeParse(dependencies.maxReadyItems ?? DEFAULT_MAX_READY_ITEMS);
    if (!maxScanEntries.success || !maxReadyItems.success) {
      throw new TypeError('INVALID_QUEUE_WORK_LIMITS');
    }
    this.#queueRoot = queueRoot;
    this.#afterClaimReservation = dependencies.afterClaimReservation ?? (() => undefined);
    this.#afterStagingCopy = dependencies.afterStagingCopy ?? (() => undefined);
    this.#beforeCompletedCleanupRename =
      dependencies.beforeCompletedCleanupRename ?? (() => undefined);
    this.#beforeCompletedEntryRemoval =
      dependencies.beforeCompletedEntryRemoval ?? (() => undefined);
    this.#clock = dependencies.clock ?? Date.now;
    this.#claimReservationHooks = Object.freeze({
      beforeCommit: dependencies.beforeClaimReservationCommit,
      beforeRemoval: dependencies.beforeClaimReservationRemoval,
      beforeSync: dependencies.beforeClaimReservationSync,
      beforeWrite: dependencies.beforeClaimReservationWrite,
      link: dependencies.claimReservationLink,
    });
    this.#stabilityMs = stabilityMs;
    this.#idGenerator = dependencies.idGenerator ?? randomUUID;
    this.#sourceLimits = sourceLimits.data;
    this.#maxScanEntries = maxScanEntries.data;
    this.#maxReadyItems = maxReadyItems.data;
    this.#openScanDirectory = dependencies.openScanDirectory ?? opendir;
    this.#readBundleMetadata = dependencies.readBundleMetadata ?? readQueueBundleMetadata;
  }

  async scanReady(): Promise<readonly ReadyQueueItem[]> {
    const connection = await connectQueueRoot(this.#queueRoot);
    await ensureQueueLayout(connection);
    const now = this.#clock();
    if (!Number.isFinite(now)) {
      throw new TypeError('INVALID_QUEUE_CLOCK');
    }
    const next = new Map(
      [...this.#observations].filter(
        ([, observation]) =>
          now >= observation.lastSeenAt && now - observation.lastSeenAt <= OBSERVATION_TTL_MS,
      ),
    );
    const candidates: Array<Readonly<{ entry: Dirent; sourceKind: ICloudSourceKind }>> = [];
    for (const sourceKind of SOURCE_SCAN_ORDER) {
      const directory = QUEUE_BUNDLE_CONFIG[sourceKind].directory;
      const entries = await this.#readScanEntries(sourceKind, queuePath(connection, directory));
      candidates.push(...entries.map((entry) => Object.freeze({ entry, sourceKind })));
    }
    const candidatesByJobId = new Map<string, ReadonlySet<ICloudSourceKind>>();
    for (const candidate of candidates) {
      candidatesByJobId.set(
        candidate.entry.name,
        new Set([...(candidatesByJobId.get(candidate.entry.name) ?? []), candidate.sourceKind]),
      );
    }
    const duplicateJobIds = new Set<string>();
    for (const candidate of candidates) {
      if (
        (candidatesByJobId.get(candidate.entry.name)?.size ?? 0) > 1 ||
        (await isClaimReservationCollision(
          claimReservationLocation(connection, candidate.sourceKind, candidate.entry.name),
          Object.freeze({ jobId: candidate.entry.name, sourceKind: candidate.sourceKind }),
        ))
      ) {
        duplicateJobIds.add(candidate.entry.name);
      }
    }
    for (const jobId of duplicateJobIds) {
      next.delete(observationKey('icloud', jobId));
      next.delete(observationKey('icloud_course', jobId));
      let hasCollisionRejection = false;
      try {
        hasCollisionRejection = await hasDurableRejection(connection, jobId, 'INVALID_QUEUE_ITEM');
      } catch {
        // Replace malformed or unreadable receipt data with the required generic receipt.
      }
      if (!hasCollisionRejection) {
        try {
          await this.#writeRejectionForError(jobId, invalidQueueItem());
        } catch {
          throw invalidQueueItem();
        }
      }
    }
    const readyItems: ReadyQueueItem[] = [];
    for (const { entry, sourceKind } of candidates) {
      const key = observationKey(sourceKind, entry.name);
      if (duplicateJobIds.has(entry.name)) {
        continue;
      }
      const directory = QUEUE_BUNDLE_CONFIG[sourceKind].directory;
      const jobPath = queuePath(connection, directory, entry.name);
      try {
        const stats = await lstat(jobPath);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
          continue;
        }
        if (await hasDurableRejection(connection, entry.name)) {
          next.delete(key);
          continue;
        }
        const signature = await snapshotQueueBundle(jobPath, sourceKind);
        if (signature === null) {
          next.delete(key);
          continue;
        }
        const claimToken = claimTokenForSignature(signature);
        const previous = this.#observations.get(key);
        if (
          previous === undefined ||
          previous.signature !== signature ||
          now < previous.observedAt ||
          now - previous.lastSeenAt > OBSERVATION_TTL_MS
        ) {
          this.#setObservation(
            next,
            key,
            Object.freeze({ claimToken, lastSeenAt: now, observedAt: now, signature }),
          );
          continue;
        }
        this.#setObservation(next, key, Object.freeze({ ...previous, lastSeenAt: now }));
        if (
          now - previous.observedAt >= this.#stabilityMs &&
          readyItems.length < this.#maxReadyItems
        ) {
          readyItems.push(
            Object.freeze({
              jobId: entry.name,
              claimToken: previous.claimToken,
              sourceKind,
            }),
          );
        }
      } catch {
        // A partially synchronized iCloud directory is retried on the next scan.
        next.delete(key);
      }
    }
    this.#observations = next;
    return Object.freeze(readyItems);
  }

  async #readScanEntries(
    sourceKind: ICloudSourceKind,
    inboxPath: string,
  ): Promise<readonly Dirent[]> {
    const previous = this.#scanDirectories.get(sourceKind);
    if (previous !== undefined && previous.path !== inboxPath) {
      await this.#closeScanDirectory(sourceKind);
    }
    let state = this.#scanDirectories.get(sourceKind);
    if (state === undefined) {
      state = Object.freeze({
        directory: await this.#openScanDirectory(inboxPath),
        path: inboxPath,
      });
      this.#scanDirectories = new Map([...this.#scanDirectories, [sourceKind, state]]);
    }
    const entries: Dirent[] = [];
    try {
      for (let inspected = 0; inspected < this.#maxScanEntries; inspected += 1) {
        const entry = await state.directory.read();
        if (entry === null) {
          await this.#closeScanDirectory(sourceKind);
          break;
        }
        if (
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          z.uuid().safeParse(entry.name).success
        ) {
          entries.push(entry);
        }
      }
    } catch (error) {
      this.#scanDirectories = new Map(
        [...this.#scanDirectories].filter(
          ([kind, cached]) => kind !== sourceKind || cached !== state,
        ),
      );
      await closeDirectory(state.directory).catch(() => undefined);
      throw error;
    }
    return Object.freeze(entries);
  }

  async #closeScanDirectory(sourceKind: ICloudSourceKind): Promise<void> {
    const state = this.#scanDirectories.get(sourceKind);
    this.#scanDirectories = new Map(
      [...this.#scanDirectories].filter(([kind]) => kind !== sourceKind),
    );
    if (state !== undefined) {
      await closeDirectory(state.directory);
    }
  }

  #setObservation(next: Map<string, Observation>, jobId: string, value: Observation): void {
    next.delete(jobId);
    next.set(jobId, value);
    while (next.size > MAX_OBSERVATIONS) {
      const oldest = next.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      next.delete(oldest);
    }
  }

  async claim(item: ReadyQueueItem, stagingRoot: string): Promise<ClaimedSource> {
    const parsedItem = ReadyQueueItemSchema.safeParse(item);
    if (!parsedItem.success) {
      throw invalidQueueItem();
    }
    let jobPath: string | undefined;
    let manifest: NormalizedSourceBundleManifest | undefined;
    let courseProvisioning: ClaimedSource['courseProvisioning'];
    let stagedClaim: StagedClaim | undefined;
    let stagingConnection: VaultConnection | undefined;
    let claimReservation: AcquiredClaimReservation | undefined;
    let reservationCommitStarted = false;
    let stableSignature: string | undefined;
    try {
      stagingConnection = await connectStagingRoot(stagingRoot);
      const connection = await connectQueueRoot(this.#queueRoot);
      await ensureQueueLayout(connection);
      const config = QUEUE_BUNDLE_CONFIG[parsedItem.data.sourceKind];
      jobPath = queuePath(connection, config.directory, parsedItem.data.jobId);
      const jobStats = await lstat(jobPath);
      if (!jobStats.isDirectory() || jobStats.isSymbolicLink()) {
        throw invalidQueueItem();
      }
      stableSignature = await this.#requireStableSignature(jobPath, parsedItem.data);
      const metadata = await this.#readBundleMetadata(
        jobPath,
        parsedItem.data.sourceKind,
        parsedItem.data.jobId,
      );
      manifest = metadata.manifest;
      courseProvisioning = metadata.courseProvisioning;
      const bundle = await readQueueBundle(
        jobPath,
        parsedItem.data.sourceKind,
        metadata,
        this.#sourceLimits,
      );
      await this.#assertSignature(jobPath, parsedItem.data.sourceKind, stableSignature);
      const existingReservation = await readQueueClaimReservation(
        connection,
        parsedItem.data.sourceKind,
        parsedItem.data.jobId,
      );
      if (
        existingReservation !== null &&
        existingReservation.record.claimToken !== parsedItem.data.claimToken
      ) {
        throw invalidQueueItem();
      }
      const queueHashes = await hashQueueSources(bundle, this.#sourceLimits);
      await this.#assertSignature(jobPath, parsedItem.data.sourceKind, stableSignature);
      const validatedJobPath = jobPath;
      const validatedSignature = stableSignature;
      const stagedBundle = await stageQueueBundle(
        stagingConnection,
        bundle,
        queueHashes,
        this.#sourceLimits,
        existingReservation !== null,
        (claim) => {
          stagedClaim = claim;
        },
        async () => {
          await this.#assertSignature(
            validatedJobPath,
            parsedItem.data.sourceKind,
            validatedSignature,
          );
          claimReservation = await acquireQueueClaimReservation(
            connection,
            parsedItem.data,
            this.#claimReservationHooks,
          );
        },
      );
      const firstSource = stagedBundle.records[0];
      const primaryDescriptor = manifest.sources[0];
      if (firstSource === undefined || primaryDescriptor === undefined) {
        throw invalidQueueItem();
      }
      await this.#afterStagingCopy(firstSource.stagedPath);
      await this.#assertSignature(jobPath, parsedItem.data.sourceKind, stableSignature);
      claimReservation ??= await acquireQueueClaimReservation(
        connection,
        parsedItem.data,
        this.#claimReservationHooks,
      );
      await this.#afterClaimReservation(claimReservation.reservation.path);
      await this.#assertSignature(jobPath, parsedItem.data.sourceKind, stableSignature);
      reservationCommitStarted = true;
      claimReservation = Object.freeze({
        ...claimReservation,
        reservation: await commitClaimReservation(
          claimReservation.reservation,
          this.#claimReservationHooks,
        ),
      });
      await this.#assertSignature(jobPath, parsedItem.data.sourceKind, stableSignature);
      const compatibleManifest = Object.freeze({
        ...manifest,
        source: Object.freeze({
          fileName: primaryDescriptor.fileName,
          mediaType: primaryDescriptor.mediaType,
        }),
        sha256: firstSource.sha256,
      }) as ClaimedSource['manifest'];
      return Object.freeze({
        manifest: compatibleManifest,
        courseProvisioning,
        queueItemPath: jobPath,
        sourceKind: parsedItem.data.sourceKind,
        stagedSourcePath: firstSource.stagedPath,
        sourceSha256: firstSource.sha256,
        stagingDirectoryPath: stagedBundle.stagingDirectoryPath,
        sources: stagedBundle.records,
      });
    } catch (error) {
      let normalized = await this.#normalizeClaimError(
        error,
        jobPath,
        parsedItem.data.sourceKind,
        stableSignature,
      );
      let stagingRemoved = stagedClaim === undefined;
      if (stagedClaim !== undefined) {
        try {
          if (stagingConnection === undefined) {
            throw sourceCopyError();
          }
          await removeOwnedStagingJob(stagingConnection, stagedClaim);
          stagingRemoved = true;
        } catch {
          normalized = sourceCopyError();
        }
      }
      if (
        claimReservation?.created === true &&
        stagingRemoved &&
        (normalized.code !== 'QUEUE_ITEM_NOT_STABLE' || !reservationCommitStarted)
      ) {
        try {
          await removeClaimReservation(claimReservation.reservation);
        } catch {
          // Preserve an uncertain or replaced reservation rather than unlinking untrusted data.
        }
      }
      if (REJECTED_ERROR_CODES.has(normalized.code)) {
        await this.#writeRejectionForError(parsedItem.data.jobId, normalized);
      }
      if (manifest !== undefined && normalized.code !== 'QUEUE_ITEM_NOT_STABLE') {
        const envelope = toErrorEnvelope(normalized);
        await this.writeReceipt(
          StatusReceiptSchema.parse({
            jobId: manifest.jobId,
            courseId: manifest.courseId,
            status: 'failed',
            displayMessage: envelope.message,
            updatedAt: new Date(this.#clock()).toISOString(),
            errorCode: envelope.code,
          }),
        );
      }
      throw normalized;
    }
  }

  async writeReceipt(receipt: StatusReceipt): Promise<void> {
    const parsed = StatusReceiptSchema.parse(receipt);
    await this.#writeQueueJson('Status', parsed.jobId, parsed.updatedAt, parsed);
  }

  async writeRejection(receipt: RejectionReceipt): Promise<void> {
    const parsed = RejectionReceiptSchema.parse(receipt);
    await this.#writeQueueJson('Rejected', parsed.jobId, parsed.updatedAt, parsed);
  }

  async removeCompleted(jobId: string, sourceKind: ICloudSourceKind): Promise<void> {
    if (!ICloudSourceKindSchema.safeParse(sourceKind).success) {
      throw invalidQueueItem();
    }
    const parsedJobId = z.uuid().parse(jobId);
    const connection = await connectQueueRoot(this.#queueRoot);
    await ensureQueueLayout(connection);
    const config = QUEUE_BUNDLE_CONFIG[sourceKind];
    const inboxPath = queuePath(connection, config.directory, parsedJobId);
    try {
      const claimReservation = await readQueueClaimReservation(connection, sourceKind, parsedJobId);
      await requireCompletedReceipt(connection, parsedJobId);
      const inboxDirectory = queuePath(connection, config.directory);
      const rejectedDirectory = queuePath(connection, 'Rejected');
      const cleanupName = `.completed-${sourceKind}-${parsedJobId}`;
      if (!CLEANUP_DIRECTORY.test(cleanupName)) {
        throw invalidQueueItem();
      }
      const cleanupPath = queuePath(connection, 'Rejected', cleanupName);
      const [inboxExists, cleanupExists] = await Promise.all([
        pathExists(inboxPath),
        pathExists(cleanupPath),
      ]);
      if (inboxExists && cleanupExists) {
        throw invalidQueueItem();
      }
      if (!inboxExists && !cleanupExists) {
        if (claimReservation !== null) {
          await removeClaimReservation(claimReservation, this.#claimReservationHooks);
        }
        return;
      }
      if (claimReservation === null) {
        throw invalidQueueItem();
      }
      await validateCommittedClaimReservation(claimReservation);
      await assertManagedDirectory(connection, rejectedDirectory);
      let validatedBundle: ValidatedCompletedBundle;
      if (inboxExists) {
        validatedBundle = await validateCompletedBundle(inboxPath, sourceKind, parsedJobId);
        if (
          claimReservation.record.claimToken !== claimTokenForSignature(validatedBundle.signature)
        ) {
          throw invalidQueueItem();
        }
        await assertManagedDirectory(connection, inboxDirectory);
        assertNoReparsePoints(inboxPath);
        assertNoReparsePoints(cleanupPath);
        await this.#beforeCompletedCleanupRename(inboxPath, cleanupPath);
        await rename(inboxPath, cleanupPath);
        const movedBundle = await validateCompletedBundle(cleanupPath, sourceKind, parsedJobId);
        if (
          !sameFileIdentity(validatedBundle.directoryStats, movedBundle.directoryStats) ||
          validatedBundle.signature !== movedBundle.signature ||
          claimReservation.record.claimToken !== claimTokenForSignature(movedBundle.signature)
        ) {
          throw invalidQueueItem();
        }
        validatedBundle = movedBundle;
      } else {
        validatedBundle = await validateCompletedBundle(cleanupPath, sourceKind, parsedJobId);
        if (
          claimReservation.record.claimToken !== claimTokenForSignature(validatedBundle.signature)
        ) {
          throw invalidQueueItem();
        }
      }

      for (const entry of validatedBundle.entries) {
        await removeValidatedCompletedEntry(
          connection,
          cleanupPath,
          entry,
          this.#beforeCompletedEntryRemoval,
        );
      }
      await removeValidatedCompletedDirectory(
        connection,
        cleanupPath,
        validatedBundle.directoryStats,
      );
      if (claimReservation !== null) {
        await removeClaimReservation(claimReservation, this.#claimReservationHooks);
      }
    } catch (error) {
      throw toQueueWriteError(error);
    }
  }

  async #assertSignature(
    jobPath: string,
    sourceKind: ICloudSourceKind,
    expected: string,
  ): Promise<void> {
    const current = await snapshotQueueBundle(jobPath, sourceKind);
    if (current === null || current !== expected) {
      throw unstableQueueItem();
    }
  }

  async #normalizeClaimError(
    error: unknown,
    jobPath: string | undefined,
    sourceKind: ICloudSourceKind,
    stableSignature: string | undefined,
  ): Promise<AppError> {
    const normalized = normalizeClaimError(error);
    if (
      jobPath === undefined ||
      stableSignature === undefined ||
      normalized.code === 'QUEUE_ITEM_NOT_STABLE'
    ) {
      return normalized;
    }
    try {
      await this.#assertSignature(jobPath, sourceKind, stableSignature);
      return normalized;
    } catch (signatureError) {
      if (AppError.isTrusted(signatureError) && signatureError.code === 'QUEUE_ITEM_NOT_STABLE') {
        return signatureError;
      }
      return normalized;
    }
  }

  async #requireStableSignature(jobPath: string, item: ReadyQueueItem): Promise<string> {
    const observation = this.#observations.get(observationKey(item.sourceKind, item.jobId));
    const now = this.#clock();
    if (!Number.isFinite(now)) {
      throw new TypeError('INVALID_QUEUE_CLOCK');
    }
    const current = await snapshotQueueBundle(jobPath, item.sourceKind);
    if (
      observation === undefined ||
      current === null ||
      current !== observation.signature ||
      item.claimToken !== observation.claimToken ||
      item.claimToken !== claimTokenForSignature(current) ||
      now < observation.observedAt ||
      now - observation.observedAt < this.#stabilityMs
    ) {
      throw unstableQueueItem();
    }
    return current;
  }

  async #writeRejectionForError(jobId: string, error: AppError): Promise<void> {
    const envelope = toErrorEnvelope(error);
    const receipt = RejectionReceiptSchema.parse({
      jobId,
      status: 'failed',
      displayMessage: envelope.message,
      updatedAt: new Date(this.#clock()).toISOString(),
      errorCode: envelope.code,
    });
    await this.writeRejection(receipt);
  }

  async #writeQueueJson(
    directory: 'Rejected' | 'Status',
    jobId: string,
    updatedAt: string,
    value: unknown,
  ): Promise<void> {
    const connection = await connectQueueRoot(this.#queueRoot);
    await ensureQueueLayout(connection);
    const targetPath = queuePath(connection, directory, `${jobId}.json`);
    try {
      await atomicReplace({
        connection,
        targetPath,
        replaceExisting: true,
        dependencies: {
          clock: () => new Date(updatedAt),
          idGenerator: this.#idGenerator,
        },
        write: async (handle) => {
          await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
          return undefined;
        },
      });
    } catch (error) {
      throw toQueueWriteError(error);
    }
  }
}
