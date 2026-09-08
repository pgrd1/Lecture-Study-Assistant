import { APP_METADATA } from '../../shared/appMetadata';
import {
  WorkspaceRelativePathSchema,
  workspacePathKey,
} from '../../shared/contracts/obsidianWorkspace';

/** Output boundary only: storage/manifest paths remain managed-root-relative.
 * Already encoded inputs fail closed instead of guessing or stripping prefixes. */
export const toVaultRelativePath = (input: unknown): string => {
  const managed = WorkspaceRelativePathSchema.parse(input);
  if (workspacePathKey(managed).split('/')[0] === workspacePathKey(APP_METADATA.managedVaultRoot))
    throw new TypeError('ALREADY_VAULT_RELATIVE');
  return WorkspaceRelativePathSchema.parse(`${APP_METADATA.managedVaultRoot}/${managed}`);
};
