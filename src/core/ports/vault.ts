export type VaultConnectInput = Readonly<{
  path: string;
  mode: 'existing' | 'create';
}>;

export type VaultConnection = Readonly<{
  vaultRoot: string;
  managedRoot: string;
  realManagedRoot: string;
}>;

export type TextArtifactWriteInput = Readonly<{
  relativePath: string;
  content: string;
  expectedBaseHash?: string | null;
}>;

export type MarkdownWriteInput = TextArtifactWriteInput;

export type TextArtifactReadResult = Readonly<{
  relativePath: string;
  content: string;
  sha256: string;
}>;

export type MarkdownReadResult = TextArtifactReadResult;

export type WriteResult = Readonly<{
  kind: 'written' | 'conflict';
  relativePath: string;
  preservedRelativePath?: string;
  sha256: string;
  temporaryRecoveryToken: string | null;
  backupRecoveryToken: string | null;
}>;

export type AttachmentCopyInput = Readonly<{
  sourcePath: string;
  relativePath: string;
  expectedSha256: string;
  maxBytes?: number;
}>;

export interface VaultServicePort {
  connect(input: VaultConnectInput): Promise<VaultConnection>;
}

export interface VaultWriterPort {
  ensureDirectory(relativePath: string): Promise<void>;
  readMarkdown(relativePath: string): Promise<MarkdownReadResult | null>;
  writeMarkdown(input: MarkdownWriteInput): Promise<WriteResult>;
  readBase(relativePath: string): Promise<TextArtifactReadResult | null>;
  writeBase(input: TextArtifactWriteInput): Promise<WriteResult>;
  readCanvas(relativePath: string): Promise<TextArtifactReadResult | null>;
  writeCanvas(input: TextArtifactWriteInput): Promise<WriteResult>;
  readSvg(relativePath: string): Promise<TextArtifactReadResult | null>;
  writeSvg(input: TextArtifactWriteInput): Promise<WriteResult>;
  readJson(relativePath: string): Promise<TextArtifactReadResult | null>;
  writeJson(input: TextArtifactWriteInput): Promise<WriteResult>;
  copyAttachment(input: AttachmentCopyInput): Promise<string>;
}
