import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, win32 } from 'node:path';
import { z } from 'zod';
import { DEFAULT_MAX_SOURCE_BYTES, sha256File } from '../../core/jobs/fingerprint';
import { assertNoReparsePoints, resolveManagedPath } from '../../core/paths/safePath';
import type {
  AttachmentCopyInput,
  MarkdownReadResult,
  MarkdownWriteInput,
  TextArtifactReadResult,
  TextArtifactWriteInput,
  VaultConnection,
  VaultWriterPort,
  WriteResult,
} from '../../core/ports/vault';
import { APP_ERROR_MESSAGES, AppError } from '../../shared/errors';
import {
  type AtomicTargetSelection,
  type AtomicWriteDependencies,
  assertManagedDirectory,
  atomicReplace,
  ensureManagedParentDirectories,
} from '../filesystem/atomicWrite';
import { SaxesParser, type SaxesTagNS } from '../metadata/saxesAdapter';

const SHA_256 = /^[a-f0-9]{64}$/u;
const MAX_RELATIVE_PATH_LENGTH = 4_096;
const MAX_SEGMENT_LENGTH = 180;
const MAX_MARKDOWN_BYTES = 16 * 1024 * 1024;
const MAX_SVG_BYTES = 32 * 1024 * 1024;
const MAX_SVG_DEPTH = 64;
const COPY_BUFFER_BYTES = 1024 * 1024;
type TextExtension = '.md' | '.base' | '.canvas' | '.svg' | '.json';

export type VaultWriterDependencies = AtomicWriteDependencies &
  Readonly<{
    maxMarkdownBytes?: number;
    beforeMarkdownRead?: (targetPath: string) => void | Promise<void>;
    beforeArtifactRead?: (targetPath: string) => void | Promise<void>;
    openAttachmentSource?: (sourcePath: string) => Promise<AttachmentSourceHandle>;
  }>;

export type AttachmentSourceHandle = Readonly<{
  close: () => Promise<void>;
  read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<Readonly<{ bytesRead: number }>>;
  stat: () => Promise<Stats>;
}>;

const TextInputSchema = z.strictObject({
  relativePath: z.string().min(1).max(MAX_RELATIVE_PATH_LENGTH),
  content: z
    .string()
    .max(MAX_SVG_BYTES)
    .refine((value) => !value.includes('\0'))
    .refine((value) => !/\p{Cs}/u.test(value)),
  expectedBaseHash: z.string().regex(SHA_256).nullable().optional(),
});

const ManagedRelativePathSchema = z.string().min(1).max(MAX_RELATIVE_PATH_LENGTH);

const AttachmentInputSchema = z.strictObject({
  sourcePath: z
    .string()
    .min(1)
    .max(32_767)
    .refine((value) => isAbsolute(value) && !value.includes('\0')),
  relativePath: z.string().min(1).max(MAX_RELATIVE_PATH_LENGTH),
  expectedSha256: z.string().regex(SHA_256),
  maxBytes: z.number().int().positive().max(DEFAULT_MAX_SOURCE_BYTES).optional(),
});

type ManagedTarget = Readonly<{
  absolutePath: string;
  relativePath: string;
}>;

const safePathError = (): AppError => new AppError('SAFE_PATH', APP_ERROR_MESSAGES.SAFE_PATH);

const invalidText = (): never => {
  throw new AppError('VAULT_WRITE_FAILED', APP_ERROR_MESSAGES.VAULT_WRITE_FAILED);
};

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const SVG_ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'title',
  'desc',
  'text',
  'tspan',
  'rect',
  'path',
  'line',
  'circle',
  'ellipse',
  'polyline',
  'polygon',
  'marker',
  'clipPath',
  'linearGradient',
  'radialGradient',
  'stop',
  'use',
]);
const SVG_ATTRIBUTES = new Set([
  'id',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
  'viewBox',
  'preserveAspectRatio',
  'd',
  'points',
  'transform',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'dx',
  'dy',
  'rotate',
  'letter-spacing',
  'marker-start',
  'marker-mid',
  'marker-end',
  'markerWidth',
  'markerHeight',
  'markerUnits',
  'refX',
  'refY',
  'orient',
  'clip-path',
  'clipPathUnits',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
  'fx',
  'fy',
  'href',
  'version',
]);

const validateSvgAttribute = (attribute: SaxesTagNS['attributes'][string]): void => {
  const { uri, local, value } = attribute;
  if (uri === 'http://www.w3.org/2000/xmlns/') {
    if (value !== SVG_NAMESPACE && value !== 'http://www.w3.org/1999/xlink') invalidText();
    return;
  }
  if (
    (uri !== '' && !(uri === 'http://www.w3.org/1999/xlink' && local === 'href')) ||
    !SVG_ATTRIBUTES.has(local)
  )
    invalidText();
  // Only unescaped local fragments are references. No CSS, URI decoding or fetching is needed.
  if (local === 'href') {
    if (!/^#[A-Za-z_][A-Za-z0-9_.-]*$/u.test(value)) invalidText();
    return;
  }
  if (/[\\%:@/]|[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) invalidText();
  if (/url/iu.test(value) && !/^url\(#[A-Za-z_][A-Za-z0-9_.-]*\)$/u.test(value)) invalidText();
};

const validateSvg = (content: string): void => {
  // Declarations and processing instructions are never part of the diagram grammar.
  if (content.includes('<?') || /<!\s*(?:DOCTYPE|ENTITY)/iu.test(content)) invalidText();
  const parser = new SaxesParser({ xmlns: true });
  let rootSeen = false;
  let depth = 0;
  parser.on('error', invalidText);
  parser.on('doctype', invalidText);
  parser.on('opentag', (tag) => {
    // Namespace lookup walks ancestors; cap depth before parsing another descendant.
    depth += 1;
    if (depth > MAX_SVG_DEPTH) invalidText();
    if (
      (!rootSeen && tag.local !== 'svg') ||
      (tag.uri !== '' && tag.uri !== SVG_NAMESPACE) ||
      !SVG_ELEMENTS.has(tag.local)
    )
      invalidText();
    rootSeen = true;
    for (const attribute of Object.values(tag.attributes)) validateSvgAttribute(attribute);
  });
  parser.on('closetag', () => {
    depth -= 1;
  });
  parser.write(content).close();
  if (!rootSeen) invalidText();
};

const validateTextContent = (content: string, extension: TextExtension, maxBytes: number): void => {
  if (
    Buffer.byteLength(content, 'utf8') > maxBytes ||
    content.includes('\0') ||
    /\p{Cs}/u.test(content)
  )
    invalidText();
  try {
    if (extension === '.canvas' || extension === '.json') JSON.parse(content);
    if (extension === '.svg') validateSvg(content);
  } catch {
    invalidText();
  }
};

const parseManagedTarget = (
  connection: VaultConnection,
  relativePath: string,
  requiredExtension?: string,
): ManagedTarget => {
  if (
    relativePath.includes('\0') ||
    (requiredExtension !== undefined && /[\\\p{Cc}\p{Cf}\p{Cs}]/u.test(relativePath)) ||
    win32.isAbsolute(relativePath) ||
    relativePath.startsWith('/') ||
    relativePath.startsWith('\\')
  ) {
    throw safePathError();
  }
  const segments = relativePath.split(/[\\/]/u);
  if (
    segments.some((segment) => segment.length === 0 || segment.length > MAX_SEGMENT_LENGTH) ||
    (requiredExtension !== undefined &&
      (extname(segments.at(-1) ?? '') !== requiredExtension ||
        (requiredExtension !== '.md' &&
          /\.[a-z][a-z0-9]*$/iu.test(basename(segments.at(-1) ?? '', requiredExtension)))))
  ) {
    throw safePathError();
  }

  return Object.freeze({
    absolutePath: resolveManagedPath(connection.managedRoot, ...segments),
    relativePath: segments.join('/'),
  });
};

const parseManagedDirectory = (connection: VaultConnection, relativePath: string): string => {
  const parsed = ManagedRelativePathSchema.safeParse(relativePath);
  if (
    !parsed.success ||
    parsed.data.includes('\0') ||
    win32.isAbsolute(parsed.data) ||
    parsed.data.startsWith('/') ||
    parsed.data.startsWith('\\')
  ) {
    throw safePathError();
  }
  const segments = parsed.data.split(/[\\/]/u);
  if (segments.some((segment) => segment.length === 0 || segment.length > MAX_SEGMENT_LENGTH)) {
    throw safePathError();
  }
  return resolveManagedPath(connection.managedRoot, ...segments);
};

const isMissingPathError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const sameFileSnapshot = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const readBoundedFileHandle = async (
  handle: Awaited<ReturnType<typeof open>>,
  initialSize: number,
  maxBytes: number,
): Promise<Buffer> => {
  const capacity = Math.min(initialSize, maxBytes) + 1;
  const buffer = Buffer.allocUnsafe(capacity);
  let total = 0;
  while (total < capacity) {
    const result = await handle.read(buffer, total, capacity - total, total);
    if (result.bytesRead === 0) {
      break;
    }
    total += result.bytesRead;
    if (total > maxBytes) {
      throw new TypeError('TEXT_ARTIFACT_TOO_LARGE');
    }
  }
  return buffer.subarray(0, total);
};

const currentManagedHash = async (
  connection: VaultConnection,
  targetPath: string,
): Promise<string | null> => {
  await assertManagedDirectory(connection, dirname(targetPath));
  try {
    assertNoReparsePoints(targetPath);
    const stats = await lstat(targetPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw safePathError();
    }
    return await sha256File(targetPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    if (AppError.isTrusted(error)) {
      throw error;
    }
    throw new AppError('VAULT_WRITE_FAILED', APP_ERROR_MESSAGES.VAULT_WRITE_FAILED);
  }
};

const formatTimestamp = (date: Date): string => {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`;
};

const conflictTarget = async (
  connection: VaultConnection,
  originalTarget: string,
  date: Date,
): Promise<string> => {
  const extension = extname(originalTarget);
  const stem = basename(originalTarget, extension);
  const timestamp = formatTimestamp(date);
  for (let suffix = 1; suffix <= 99; suffix += 1) {
    const numberedSuffix = suffix === 1 ? '' : `-${suffix}`;
    const candidateName = `${stem}.conflict-${timestamp}${numberedSuffix}${extension}`;
    const candidate = resolveManagedPath(
      connection.managedRoot,
      ...[
        ...relative(connection.managedRoot, dirname(originalTarget))
          .split(/[\\/]/u)
          .filter(Boolean),
        candidateName,
      ],
    );
    if ((await currentManagedHash(connection, candidate)) === null) {
      return candidate;
    }
  }
  throw new AppError('VAULT_WRITE_FAILED', APP_ERROR_MESSAGES.VAULT_WRITE_FAILED);
};

const toPortableRelativePath = (connection: VaultConnection, targetPath: string): string =>
  relative(connection.managedRoot, targetPath).replaceAll('\\', '/');

const copySourceToHandle = async (
  input: z.infer<typeof AttachmentInputSchema>,
  targetHandle: Awaited<ReturnType<typeof open>>,
  dependencies: VaultWriterDependencies,
): Promise<string> => {
  let sourceHandle: AttachmentSourceHandle | undefined;
  try {
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_SOURCE_BYTES;
    assertNoReparsePoints(input.sourcePath);
    const pathStats = await lstat(input.sourcePath);
    if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.size > maxBytes) {
      throw new TypeError('INVALID_ATTACHMENT_SOURCE');
    }
    sourceHandle = await (dependencies.openAttachmentSource ?? ((path) => open(path, 'r')))(
      input.sourcePath,
    );
    assertNoReparsePoints(input.sourcePath);
    const before = await sourceHandle.stat();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > maxBytes ||
      !sameFileSnapshot(pathStats, before)
    ) {
      throw new TypeError('ATTACHMENT_OPEN_IDENTITY_MISMATCH');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = 0;

    while (true) {
      const readResult = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (readResult.bytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, readResult.bytesRead);
      let written = 0;
      while (written < chunk.length) {
        const result = await targetHandle.write(chunk, written, chunk.length - written);
        if (result.bytesWritten <= 0) {
          throw new TypeError('ATTACHMENT_WRITE_STALLED');
        }
        written += result.bytesWritten;
      }
      hash.update(chunk);
      position += readResult.bytesRead;
      if (position > maxBytes) {
        throw new TypeError('ATTACHMENT_TOO_LARGE');
      }
    }

    const after = await sourceHandle.stat();
    assertNoReparsePoints(input.sourcePath);
    const current = await lstat(input.sourcePath);
    if (!sameFileSnapshot(before, after) || !sameFileSnapshot(after, current)) {
      throw new TypeError('ATTACHMENT_CHANGED_DURING_COPY');
    }
    const actualSha256 = hash.digest('hex');
    if (actualSha256 !== input.expectedSha256) {
      throw new AppError('ATTACHMENT_HASH_MISMATCH', APP_ERROR_MESSAGES.ATTACHMENT_HASH_MISMATCH);
    }
    return actualSha256;
  } catch (error) {
    if (AppError.isTrusted(error)) {
      throw error;
    }
    throw new AppError('SOURCE_COPY_FAILED', APP_ERROR_MESSAGES.SOURCE_COPY_FAILED);
  } finally {
    await sourceHandle?.close();
  }
};

export class VaultWriter implements VaultWriterPort {
  readonly #connection: VaultConnection;
  readonly #dependencies: VaultWriterDependencies;

  constructor(connection: VaultConnection, dependencies: VaultWriterDependencies = {}) {
    if (
      dependencies.maxMarkdownBytes !== undefined &&
      (!Number.isSafeInteger(dependencies.maxMarkdownBytes) ||
        dependencies.maxMarkdownBytes <= 0 ||
        dependencies.maxMarkdownBytes > MAX_MARKDOWN_BYTES)
    ) {
      throw new TypeError('INVALID_MAX_MARKDOWN_BYTES');
    }
    this.#connection = connection;
    this.#dependencies = Object.freeze({ ...dependencies });
  }

  async ensureDirectory(relativePath: string): Promise<void> {
    const directory = parseManagedDirectory(this.#connection, relativePath);
    await ensureManagedParentDirectories(this.#connection, win32.join(directory, '.studyapp-dir'));
  }

  async readMarkdown(relativePath: string): Promise<MarkdownReadResult | null> {
    return this.#readAllowlistedText(relativePath, '.md');
  }

  async readBase(relativePath: string): Promise<TextArtifactReadResult | null> {
    return this.#readAllowlistedText(relativePath, '.base');
  }

  async readCanvas(relativePath: string): Promise<TextArtifactReadResult | null> {
    return this.#readAllowlistedText(relativePath, '.canvas');
  }

  async readSvg(relativePath: string): Promise<TextArtifactReadResult | null> {
    return this.#readAllowlistedText(relativePath, '.svg');
  }

  async readJson(relativePath: string): Promise<TextArtifactReadResult | null> {
    return this.#readAllowlistedText(relativePath, '.json');
  }

  #textLimit(extension: TextExtension): number {
    if (extension === '.svg') return MAX_SVG_BYTES;
    return extension === '.md'
      ? (this.#dependencies.maxMarkdownBytes ?? MAX_MARKDOWN_BYTES)
      : MAX_MARKDOWN_BYTES;
  }

  async #readAllowlistedText(
    relativePath: string,
    extension: TextExtension,
  ): Promise<TextArtifactReadResult | null> {
    const parsed = ManagedRelativePathSchema.safeParse(relativePath);
    if (!parsed.success) {
      throw new AppError('VAULT_WRITE_FAILED', APP_ERROR_MESSAGES.VAULT_WRITE_FAILED);
    }
    const target = parseManagedTarget(this.#connection, parsed.data, extension);
    const maxBytes = this.#textLimit(extension);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      assertNoReparsePoints(target.absolutePath);
      const pathStats = await lstat(target.absolutePath);
      if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.size > maxBytes) {
        throw safePathError();
      }
      await assertManagedDirectory(this.#connection, dirname(target.absolutePath));
      assertNoReparsePoints(target.absolutePath);
      handle = await open(target.absolutePath, 'r');
      const before = await handle.stat();
      if (!before.isFile() || before.size > maxBytes || !sameFileSnapshot(pathStats, before)) {
        throw safePathError();
      }
      if (extension === '.md') await this.#dependencies.beforeMarkdownRead?.(target.absolutePath);
      else await this.#dependencies.beforeArtifactRead?.(target.absolutePath);
      const bytes = await readBoundedFileHandle(handle, before.size, maxBytes);
      const after = await handle.stat();
      if (!sameFileSnapshot(before, after)) {
        throw new AppError('VAULT_WRITE_FAILED', APP_ERROR_MESSAGES.VAULT_WRITE_FAILED);
      }
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      validateTextContent(content, extension, maxBytes);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      await assertManagedDirectory(this.#connection, dirname(target.absolutePath));
      assertNoReparsePoints(target.absolutePath);
      const currentPathStats = await lstat(target.absolutePath);
      if (!sameFileSnapshot(after, currentPathStats)) {
        throw new AppError('VAULT_WRITE_FAILED', APP_ERROR_MESSAGES.VAULT_WRITE_FAILED);
      }
      return Object.freeze({ relativePath: target.relativePath, content, sha256 });
    } catch (error) {
      if (isMissingPathError(error)) {
        return null;
      }
      if (AppError.isTrusted(error)) {
        throw error;
      }
      throw new AppError('VAULT_WRITE_FAILED', APP_ERROR_MESSAGES.VAULT_WRITE_FAILED);
    } finally {
      await handle?.close();
    }
  }

  async writeMarkdown(input: MarkdownWriteInput): Promise<WriteResult> {
    return this.#writeAllowlistedText(input, '.md');
  }

  async writeBase(input: TextArtifactWriteInput): Promise<WriteResult> {
    return this.#writeAllowlistedText(input, '.base');
  }

  async writeCanvas(input: TextArtifactWriteInput): Promise<WriteResult> {
    return this.#writeAllowlistedText(input, '.canvas');
  }

  async writeSvg(input: TextArtifactWriteInput): Promise<WriteResult> {
    return this.#writeAllowlistedText(input, '.svg');
  }

  async writeJson(input: TextArtifactWriteInput): Promise<WriteResult> {
    return this.#writeAllowlistedText(input, '.json');
  }

  async #writeAllowlistedText(
    input: TextArtifactWriteInput,
    extension: TextExtension,
  ): Promise<WriteResult> {
    const parsed = TextInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new AppError('VAULT_WRITE_FAILED', APP_ERROR_MESSAGES.VAULT_WRITE_FAILED);
    }
    const original = parseManagedTarget(this.#connection, parsed.data.relativePath, extension);
    validateTextContent(parsed.data.content, extension, this.#textLimit(extension));
    const selectTarget = async (): Promise<AtomicTargetSelection> => {
      if (parsed.data.expectedBaseHash === undefined) {
        return Object.freeze({ targetPath: original.absolutePath, replaceExisting: true });
      }
      const currentHash = await currentManagedHash(this.#connection, original.absolutePath);
      if (currentHash === parsed.data.expectedBaseHash) {
        return Object.freeze({
          targetPath: original.absolutePath,
          replaceExisting: currentHash !== null,
        });
      }
      return Object.freeze({
        targetPath: await conflictTarget(
          this.#connection,
          original.absolutePath,
          (this.#dependencies.clock ?? (() => new Date()))(),
        ),
        replaceExisting: false,
      });
    };

    const sha256 = createHash('sha256').update(parsed.data.content, 'utf8').digest('hex');
    const result = await atomicReplace({
      connection: this.#connection,
      targetPath: original.absolutePath,
      replaceExisting: true,
      selectTarget,
      dependencies: this.#dependencies,
      write: async (handle) => {
        await handle.writeFile(parsed.data.content, 'utf8');
        return sha256;
      },
    });
    const relativePath = toPortableRelativePath(this.#connection, result.targetPath);
    const kind: WriteResult['kind'] =
      win32.normalize(result.targetPath).toLocaleLowerCase('en-US') ===
      win32.normalize(original.absolutePath).toLocaleLowerCase('en-US')
        ? 'written'
        : 'conflict';
    return Object.freeze({
      kind,
      relativePath,
      ...(kind === 'conflict' ? { preservedRelativePath: original.relativePath } : {}),
      sha256: result.value,
      temporaryRecoveryToken: result.temporaryRecoveryToken,
      backupRecoveryToken: result.backupRecoveryToken,
    });
  }

  async copyAttachment(input: AttachmentCopyInput): Promise<string> {
    const parsed = AttachmentInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new AppError('SOURCE_COPY_FAILED', APP_ERROR_MESSAGES.SOURCE_COPY_FAILED);
    }
    const original = parseManagedTarget(this.#connection, parsed.data.relativePath);
    const selectTarget = async (): Promise<AtomicTargetSelection> => {
      const currentHash = await currentManagedHash(this.#connection, original.absolutePath);
      if (currentHash === null || currentHash === parsed.data.expectedSha256) {
        return Object.freeze({
          targetPath: original.absolutePath,
          replaceExisting: currentHash !== null,
        });
      }
      return Object.freeze({
        targetPath: await conflictTarget(
          this.#connection,
          original.absolutePath,
          (this.#dependencies.clock ?? (() => new Date()))(),
        ),
        replaceExisting: false,
      });
    };

    const result = await atomicReplace({
      connection: this.#connection,
      targetPath: original.absolutePath,
      replaceExisting: false,
      selectTarget,
      dependencies: this.#dependencies,
      write: (handle) => copySourceToHandle(parsed.data, handle, this.#dependencies),
    });
    return toPortableRelativePath(this.#connection, result.targetPath);
  }
}
