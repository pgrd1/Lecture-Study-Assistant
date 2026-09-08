import { win32 } from 'node:path';
import type {
  CliCredentialScopeFor,
  CliRuntimeBinding,
  ProviderConnectionOperation,
} from '../../../core/ports/aiProvider';
import type { CliProcessResult, CliProcessRunner } from '../../../core/ports/cliProcessRunner';
import type { CliProviderId } from '../../../shared/contracts/provider';
import { APP_ERROR_MESSAGES, AppError } from '../../../shared/errors';
import {
  assertProviderConnectionActive,
  type CliExecutableFileAccess,
  type CliFileHasher,
  canonicalizeSecure,
  hashSecureFile,
  isCanonicalAbsoluteWindowsPath,
  isDirectChild,
  isMissingPathError,
  readManifestSnapshot,
  sameWindowsPath,
  secureExactPath,
  secureExpectedPath,
  unsafeVersion,
} from './cliFileIntegrity';
import {
  assertBindingShape,
  assertCaptureShape,
  type CandidateCapture,
  type CandidateKind,
  captureMatchesBinding,
  createBinding,
  expectedPrefix,
  isVersionSupported,
  parsePackageManifest,
  parsePlatformManifest,
  parseVersionOutput,
  SUPPORTED_CLI_RECIPES,
  sameCapture,
} from './cliIdentity';
import type { AuthenticodeEvidence, CliSignatureVerifier } from './windowsAuthenticodeVerifier';
import { isIssuedWindowsKnownFolders, type WindowsKnownFolders } from './windowsKnownFolders';

export {
  type CliExecutableFileAccess,
  type CliFileHasher,
  type CliSignatureVerifier,
  SUPPORTED_CLI_RECIPES,
};

type InspectorOptions = Readonly<{
  files: CliExecutableFileAccess;
  hasher: CliFileHasher;
  signatures: CliSignatureVerifier;
  runner: CliProcessRunner;
  knownFolders: WindowsKnownFolders;
  now: () => string;
}>;

type CandidateDescriptor = Readonly<{
  providerId: CliProviderId;
  kind: CandidateKind;
  candidatePath: string;
}>;

export interface CliExecutableInspector {
  inspect<Id extends CliProviderId>(
    providerId: Id,
    operation: ProviderConnectionOperation,
  ): Promise<CliRuntimeBinding<Id, CliCredentialScopeFor<Id>>>;
  revalidate<Id extends CliProviderId>(
    binding: CliRuntimeBinding<Id, CliCredentialScopeFor<Id>>,
    operation: ProviderConnectionOperation,
  ): Promise<CliRuntimeBinding<Id, CliCredentialScopeFor<Id>>>;
}

const providerError = (
  code: 'PROVIDER_CLI_CHANGED' | 'PROVIDER_EXECUTABLE_NOT_FOUND' | 'PROVIDER_UNSAFE_VERSION',
): AppError => new AppError(code, APP_ERROR_MESSAGES[code]);

const isCliChanged = (error: unknown): boolean =>
  error instanceof AppError && error.code === 'PROVIDER_CLI_CHANGED';

class FixedLocationCliExecutableInspector implements CliExecutableInspector {
  readonly #files: CliExecutableFileAccess;
  readonly #hasher: CliFileHasher;
  readonly #signatures: CliSignatureVerifier;
  readonly #runner: CliProcessRunner;
  readonly #roots: WindowsKnownFolders;
  readonly #now: () => string;

  constructor(options: InspectorOptions) {
    this.#files = options.files;
    this.#hasher = options.hasher;
    this.#signatures = options.signatures;
    this.#runner = options.runner;
    this.#roots = options.knownFolders;
    this.#now = options.now;
  }

  async inspect<Id extends CliProviderId>(
    providerId: Id,
    operation: ProviderConnectionOperation,
  ): Promise<CliRuntimeBinding<Id, CliCredentialScopeFor<Id>>> {
    assertProviderConnectionActive(operation);
    if (!Object.hasOwn(SUPPORTED_CLI_RECIPES, providerId)) throw unsafeVersion();
    const candidates = await this.#reviewedCandidates(providerId, operation);
    assertProviderConnectionActive(operation);
    let foundOfficialCandidate = false;
    for (const descriptor of candidates) {
      try {
        await canonicalizeSecure(this.#files, descriptor.candidatePath, operation);
        assertProviderConnectionActive(operation);
        foundOfficialCandidate = true;
        const verified = await this.#captureAndVerify(descriptor, operation);
        assertProviderConnectionActive(operation);
        const commandResult = await this.#runVersionCommand(descriptor, verified, operation);
        assertProviderConnectionActive(operation);
        if (
          commandResult.capture.packageVersion !== null &&
          commandResult.capture.packageVersion !== commandResult.version
        ) {
          throw unsafeVersion();
        }
        return createBinding(
          commandResult.capture as CandidateCapture & Readonly<{ providerId: Id }>,
          commandResult.version,
          this.#now(),
        );
      } catch (error) {
        if (error instanceof AppError && error.code === 'PROVIDER_CANCELLED') throw error;
        if (isCliChanged(error)) throw error;
      }
    }
    throw providerError(
      foundOfficialCandidate ? 'PROVIDER_UNSAFE_VERSION' : 'PROVIDER_EXECUTABLE_NOT_FOUND',
    );
  }

  async revalidate<Id extends CliProviderId>(
    binding: CliRuntimeBinding<Id, CliCredentialScopeFor<Id>>,
    operation: ProviderConnectionOperation,
  ): Promise<CliRuntimeBinding<Id, CliCredentialScopeFor<Id>>> {
    try {
      assertProviderConnectionActive(operation);
      const kind = assertBindingShape(binding);
      const descriptor = Object.freeze({
        providerId: binding.providerId,
        kind,
        candidatePath: this.#candidatePathForBinding(binding, kind),
      });
      const initial = await this.#captureCandidate(descriptor, operation);
      assertProviderConnectionActive(operation);
      if (!captureMatchesBinding(initial, binding)) throw providerError('PROVIDER_CLI_CHANGED');
      await this.#verifySignature(initial, operation);
      assertProviderConnectionActive(operation);
      const afterSignature = await this.#recaptureOrChanged(descriptor, operation);
      assertProviderConnectionActive(operation);
      if (
        !sameCapture(initial, afterSignature) ||
        !captureMatchesBinding(afterSignature, binding)
      ) {
        throw providerError('PROVIDER_CLI_CHANGED');
      }
      return createBinding(
        afterSignature as CandidateCapture & Readonly<{ providerId: Id }>,
        binding.version,
        this.#now(),
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'PROVIDER_CANCELLED') throw error;
      throw providerError('PROVIDER_CLI_CHANGED');
    }
  }

  async #reviewedCandidates(
    providerId: CliProviderId,
    operation: ProviderConnectionOperation,
  ): Promise<readonly CandidateDescriptor[]> {
    assertProviderConnectionActive(operation);
    if (providerId === 'antigravity_cli') {
      return Object.freeze([
        Object.freeze({
          providerId,
          kind: 'antigravity_native' as const,
          candidatePath: win32.join(this.#roots.localAppData, 'agy', 'bin', 'agy.exe'),
        }),
      ]);
    }
    if (providerId === 'gemini_cli') {
      return Object.freeze([
        Object.freeze({
          providerId,
          kind: 'gemini_npm' as const,
          candidatePath: win32.join(this.#roots.appData, 'npm', 'gemini.cmd'),
        }),
      ]);
    }
    const descriptors: CandidateDescriptor[] = [
      Object.freeze({
        providerId,
        kind: 'codex_npm',
        candidatePath: win32.join(this.#roots.appData, 'npm', 'codex.cmd'),
      }),
    ];
    const nativeRoot = win32.join(this.#roots.localAppData, 'OpenAI', 'Codex', 'bin');
    try {
      await this.#files.assertNoReparsePoints(nativeRoot, operation);
      assertProviderConnectionActive(operation);
      const children = await this.#files.listChildren(nativeRoot, operation);
      assertProviderConnectionActive(operation);
      for (const child of children) {
        if (
          isCanonicalAbsoluteWindowsPath(child) &&
          isDirectChild(nativeRoot, child) &&
          win32.basename(child).toLowerCase() === 'codex.exe'
        ) {
          await this.#files.assertNoReparsePoints(child, operation);
          assertProviderConnectionActive(operation);
          descriptors.push(
            Object.freeze({ providerId, kind: 'codex_native', candidatePath: child }),
          );
        }
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'PROVIDER_CANCELLED') throw error;
      // The fixed native root is optional; the fixed npm location remains eligible.
    }
    return Object.freeze(descriptors);
  }

  #candidatePathForBinding(binding: CliRuntimeBinding, kind: CandidateKind): string {
    if (kind === 'gemini_npm') return win32.join(this.#roots.appData, 'npm', 'gemini.cmd');
    if (kind === 'codex_npm') return win32.join(this.#roots.appData, 'npm', 'codex.cmd');
    return binding.canonicalLauncherPath;
  }

  async #captureAndVerify(
    descriptor: CandidateDescriptor,
    operation: ProviderConnectionOperation,
  ): Promise<CandidateCapture> {
    const initial = await this.#captureCandidate(descriptor, operation);
    assertProviderConnectionActive(operation);
    await this.#verifySignature(initial, operation);
    assertProviderConnectionActive(operation);
    const afterSignature = await this.#recaptureOrChanged(descriptor, operation);
    assertProviderConnectionActive(operation);
    if (!sameCapture(initial, afterSignature)) throw providerError('PROVIDER_CLI_CHANGED');
    return afterSignature;
  }

  async #recaptureOrChanged(
    descriptor: CandidateDescriptor,
    operation: ProviderConnectionOperation,
  ): Promise<CandidateCapture> {
    try {
      const capture = await this.#captureCandidate(descriptor, operation);
      assertProviderConnectionActive(operation);
      return capture;
    } catch (error) {
      if (error instanceof AppError && error.code === 'PROVIDER_CANCELLED') throw error;
      throw providerError('PROVIDER_CLI_CHANGED');
    }
  }

  async #captureCandidate(
    descriptor: CandidateDescriptor,
    operation: ProviderConnectionOperation,
  ): Promise<CandidateCapture> {
    assertProviderConnectionActive(operation);
    const capture =
      descriptor.kind === 'antigravity_native'
        ? await this.#captureNative(descriptor, 'google', operation)
        : descriptor.kind === 'codex_native'
          ? await this.#captureNative(descriptor, 'openai', operation)
          : descriptor.kind === 'gemini_npm'
            ? await this.#captureGeminiNpm(descriptor, operation)
            : await this.#captureCodexNpm(descriptor, operation);
    assertProviderConnectionActive(operation);
    assertCaptureShape(capture);
    return capture;
  }

  async #captureNative(
    descriptor: CandidateDescriptor,
    signerClassification: 'google' | 'openai',
    operation: ProviderConnectionOperation,
  ): Promise<CandidateCapture> {
    const launcher = await secureExactPath(this.#files, descriptor.candidatePath, operation);
    assertProviderConnectionActive(operation);
    const expected =
      descriptor.kind === 'antigravity_native'
        ? win32.join(this.#roots.localAppData, 'agy', 'bin', 'agy.exe')
        : descriptor.candidatePath;
    const codexNativeRoot = win32.join(this.#roots.localAppData, 'OpenAI', 'Codex', 'bin');
    if (
      !sameWindowsPath(launcher, expected) ||
      (descriptor.kind === 'codex_native' &&
        (!isDirectChild(codexNativeRoot, launcher) ||
          win32.basename(launcher).toLowerCase() !== 'codex.exe'))
    ) {
      throw unsafeVersion();
    }
    return Object.freeze({
      providerId: descriptor.providerId,
      kind: descriptor.kind,
      canonicalLauncherPath: launcher,
      canonicalEntryPath: null,
      canonicalPackageManifestPath: null,
      canonicalPlatformPackageManifestPath: null,
      fixedPrefixArgs: expectedPrefix(descriptor.providerId, null),
      launcherSha256: await hashSecureFile(
        { files: this.#files, hasher: this.#hasher },
        launcher,
        operation,
      ),
      entrySha256: null,
      packageManifestSha256: null,
      platformPackageManifestSha256: null,
      signerClassification,
      packageVersion: null,
    });
  }

  async #captureGeminiNpm(
    descriptor: CandidateDescriptor,
    operation: ProviderConnectionOperation,
  ): Promise<CandidateCapture> {
    const shim = await secureExactPath(this.#files, descriptor.candidatePath, operation);
    const expectedShim = win32.join(this.#roots.appData, 'npm', 'gemini.cmd');
    if (!sameWindowsPath(shim, expectedShim)) throw unsafeVersion();
    const packageRoot = win32.join(
      this.#roots.appData,
      'npm',
      'node_modules',
      '@google',
      'gemini-cli',
    );
    const manifest = await secureExpectedPath(
      this.#files,
      win32.join(packageRoot, 'package.json'),
      packageRoot,
      operation,
    );
    const manifestSnapshot = await readManifestSnapshot(this.#files, manifest, operation);
    const parsed = parsePackageManifest(manifestSnapshot.text, '@google/gemini-cli', 'gemini');
    if (!isVersionSupported('gemini_cli', parsed.version)) throw unsafeVersion();
    const entry = await secureExpectedPath(
      this.#files,
      win32.resolve(packageRoot, parsed.entry),
      packageRoot,
      operation,
    );
    const launcher = await secureExactPath(
      this.#files,
      win32.join(this.#roots.programFiles, 'nodejs', 'node.exe'),
      operation,
    );
    const [launcherSha256, entrySha256] = await Promise.all([
      hashSecureFile({ files: this.#files, hasher: this.#hasher }, launcher, operation),
      hashSecureFile({ files: this.#files, hasher: this.#hasher }, entry, operation),
    ]);
    assertProviderConnectionActive(operation);
    return Object.freeze({
      providerId: 'gemini_cli',
      kind: 'gemini_npm',
      canonicalLauncherPath: launcher,
      canonicalEntryPath: entry,
      canonicalPackageManifestPath: manifest,
      canonicalPlatformPackageManifestPath: null,
      fixedPrefixArgs: expectedPrefix('gemini_cli', entry),
      launcherSha256,
      entrySha256,
      packageManifestSha256: manifestSnapshot.sha256,
      platformPackageManifestSha256: null,
      signerClassification: 'nodejs',
      packageVersion: parsed.version,
    });
  }

  async #captureCodexNpm(
    descriptor: CandidateDescriptor,
    operation: ProviderConnectionOperation,
  ): Promise<CandidateCapture> {
    const shim = await secureExactPath(this.#files, descriptor.candidatePath, operation);
    const expectedShim = win32.join(this.#roots.appData, 'npm', 'codex.cmd');
    if (!sameWindowsPath(shim, expectedShim)) throw unsafeVersion();
    const packageRoot = win32.join(this.#roots.appData, 'npm', 'node_modules', '@openai', 'codex');
    const manifest = await secureExpectedPath(
      this.#files,
      win32.join(packageRoot, 'package.json'),
      packageRoot,
      operation,
    );
    const manifestSnapshot = await readManifestSnapshot(this.#files, manifest, operation);
    const parsed = parsePackageManifest(manifestSnapshot.text, '@openai/codex', 'codex');
    if (!isVersionSupported('codex_cli', parsed.version)) throw unsafeVersion();
    const entry = await secureExpectedPath(
      this.#files,
      win32.resolve(packageRoot, parsed.entry),
      packageRoot,
      operation,
    );
    const platform = await this.#captureCodexPlatformPackage(
      packageRoot,
      parsed.version,
      operation,
    );
    const launcher = await secureExpectedPath(
      this.#files,
      win32.join(platform.root, 'vendor', platform.targetTriple, 'codex', 'codex.exe'),
      platform.root,
      operation,
    );
    const [launcherSha256, entrySha256] = await Promise.all([
      hashSecureFile({ files: this.#files, hasher: this.#hasher }, launcher, operation),
      hashSecureFile({ files: this.#files, hasher: this.#hasher }, entry, operation),
    ]);
    assertProviderConnectionActive(operation);
    return Object.freeze({
      providerId: 'codex_cli',
      kind: 'codex_npm',
      canonicalLauncherPath: launcher,
      canonicalEntryPath: entry,
      canonicalPackageManifestPath: manifest,
      canonicalPlatformPackageManifestPath: platform.manifest,
      fixedPrefixArgs: expectedPrefix('codex_cli', entry),
      launcherSha256,
      entrySha256,
      packageManifestSha256: manifestSnapshot.sha256,
      platformPackageManifestSha256: platform.sha256,
      signerClassification: 'openai',
      packageVersion: parsed.version,
    });
  }

  async #captureCodexPlatformPackage(
    packageRoot: string,
    version: string,
    operation: ProviderConnectionOperation,
  ): Promise<Readonly<{ root: string; manifest: string; sha256: string; targetTriple: string }>> {
    const platformLeaf = `codex-win32-${this.#roots.architecture}`;
    const platformName = `@openai/${platformLeaf}`;
    const roots = Object.freeze([
      win32.join(packageRoot, 'node_modules', '@openai', platformLeaf),
      win32.join(this.#roots.appData, 'npm', 'node_modules', '@openai', platformLeaf),
    ]);
    for (const [index, root] of roots.entries()) {
      try {
        const manifest = await secureExpectedPath(
          this.#files,
          win32.join(root, 'package.json'),
          root,
          operation,
        );
        const snapshot = await readManifestSnapshot(this.#files, manifest, operation);
        assertProviderConnectionActive(operation);
        parsePlatformManifest(snapshot.text, platformName, version, this.#roots.architecture);
        return Object.freeze({
          root,
          manifest,
          sha256: snapshot.sha256,
          targetTriple:
            this.#roots.architecture === 'x64'
              ? 'x86_64-pc-windows-msvc'
              : 'aarch64-pc-windows-msvc',
        });
      } catch (error) {
        if (error instanceof AppError && error.code === 'PROVIDER_CANCELLED') throw error;
        if (index === 0 && isMissingPathError(error)) continue;
        throw unsafeVersion();
      }
    }
    throw unsafeVersion();
  }

  async #verifySignature(
    capture: CandidateCapture,
    operation: ProviderConnectionOperation,
  ): Promise<void> {
    const evidence: AuthenticodeEvidence = await this.#signatures.verify(
      capture.canonicalLauncherPath,
      capture.signerClassification,
      operation,
    );
    assertProviderConnectionActive(operation);
    if (evidence.signerClassification !== capture.signerClassification) throw unsafeVersion();
  }

  async #runVersionCommand(
    descriptor: CandidateDescriptor,
    capture: CandidateCapture,
    operation: ProviderConnectionOperation,
  ): Promise<Readonly<{ version: string; capture: CandidateCapture }>> {
    const recipe = SUPPORTED_CLI_RECIPES[capture.providerId];
    let result: CliProcessResult | null = null;
    let processFailed = false;
    try {
      result = await this.#runner.run(
        Object.freeze({
          requestId: operation.requestId,
          launcherPath: capture.canonicalLauncherPath,
          args: Object.freeze([...capture.fixedPrefixArgs, ...recipe.versionArgs]),
          cwd: win32.dirname(capture.canonicalLauncherPath),
          env: Object.freeze({}),
          stdin: '',
          timeoutMs: 5_000,
          stdoutLimitBytes: 4_096,
          stderrLimitBytes: 1_024,
          signal: operation.signal,
          shell: false,
        }),
      );
    } catch (error) {
      if (operation.signal.aborted) throw error;
      processFailed = true;
    }
    assertProviderConnectionActive(operation);
    const afterCommand = await this.#recaptureOrChanged(descriptor, operation);
    assertProviderConnectionActive(operation);
    if (!sameCapture(capture, afterCommand)) throw providerError('PROVIDER_CLI_CHANGED');
    if (processFailed || result === null || result.exitCode !== 0) throw unsafeVersion();
    return Object.freeze({
      version: parseVersionOutput(capture.providerId, result.stdout),
      capture: afterCommand,
    });
  }
}

export const createCliExecutableInspector = (options: InspectorOptions): CliExecutableInspector => {
  if (!isIssuedWindowsKnownFolders(options.knownFolders)) throw unsafeVersion();
  return new FixedLocationCliExecutableInspector(options);
};

export const createCliExecutableInspectorForTest = createCliExecutableInspector;
