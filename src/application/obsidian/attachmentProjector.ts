import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import { assertNoReparsePoints, resolveManagedPath } from '../../core/paths/safePath';
import type { VaultConnection, VaultWriterPort } from '../../core/ports/vault';
import { assertBoundedPipelineJson } from '../../shared/contracts/boundedPipelineJson';
import {
  VaultRelativePathSchema,
  WorkspaceCourseFolderSchema,
} from '../../shared/contracts/obsidianWorkspace';
import { type SourceRecord, SourceRecordSchema } from '../../shared/contracts/sourceBundle';

export const attachmentPath = (folderName: string, value: unknown): string => {
  assertBoundedPipelineJson(value);
  const source = SourceRecordSchema.parse(value);
  const directory =
    source.mediaType === 'image' ? '이미지' : source.mediaType === 'document' ? '문서' : '녹음';
  const extension = extname(source.originalFileName).toLowerCase();
  return VaultRelativePathSchema.parse(
    `과목/${WorkspaceCourseFolderSchema.parse(folderName)}/원본자료/${directory}/${source.sha256}${extension}`,
  );
};

export class AttachmentProjector {
  constructor(
    private readonly writer: VaultWriterPort,
    private readonly connection: VaultConnection,
  ) {}

  async #reusable(source: SourceRecord, planned: string): Promise<string> {
    const pieces = planned.split('/');
    const directory = pieces.slice(0, -1);
    const absolute = resolveManagedPath(this.connection.managedRoot, ...directory);
    let entries: string[];
    try {
      entries = await readdir(absolute);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return planned;
      throw error;
    }
    if (entries.length > 5000) throw new TypeError('WORKSPACE_ATTACHMENT_LIMIT');
    for (const name of entries
      .filter((name) => name.startsWith(`${source.sha256}.`) && name.endsWith(extname(planned)))
      .sort()) {
      const candidate = resolveManagedPath(this.connection.managedRoot, ...directory, name);
      assertNoReparsePoints(candidate);
      const stats = await lstat(candidate);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== source.sizeBytes) continue;
      const hash = createHash('sha256');
      for await (const bytes of createReadStream(candidate)) hash.update(bytes);
      if (hash.digest('hex') === source.sha256) return `${directory.join('/')}/${name}`;
    }
    return planned;
  }

  async publish(folderName: string, sources: readonly SourceRecord[]) {
    assertBoundedPipelineJson(sources);
    const plans = sources.map((source) => ({
      source: SourceRecordSchema.parse(source),
      relativePath: attachmentPath(folderName, source),
    }));
    const results = [];
    for (const plan of plans) {
      const target = await this.#reusable(plan.source, plan.relativePath);
      const relativePath = await this.writer.copyAttachment({
        sourcePath: plan.source.stagedPath,
        relativePath: target,
        expectedSha256: plan.source.sha256,
        maxBytes: plan.source.sizeBytes,
      });
      VaultRelativePathSchema.parse(relativePath);
      if (
        !relativePath.startsWith(plan.relativePath.slice(0, plan.relativePath.lastIndexOf('/') + 1))
      )
        throw new TypeError('INVALID_WORKSPACE_ATTACHMENT_PATH');
      results.push(
        Object.freeze({
          sourceId: plan.source.id,
          relativePath,
          sha256: plan.source.sha256,
          sizeBytes: plan.source.sizeBytes,
          mediaType: plan.source.mediaType,
        }),
      );
    }
    return Object.freeze(results);
  }
}
