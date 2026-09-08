import type { PromptProfile, PromptProfileKey } from '../../shared/contracts/promptProfile';

export interface PromptProfileRepository {
  /** Includes tombstones so removal cannot reset the optimistic revision counter. */
  getCurrent(key: PromptProfileKey): PromptProfile | null;
  list(): readonly PromptProfile[];
  history(key: PromptProfileKey): readonly PromptProfile[];
  /** Atomically append immutable history and advance the current head. null means first creation. */
  save(profile: PromptProfile, expectedRevision: number | null): PromptProfile;
}
