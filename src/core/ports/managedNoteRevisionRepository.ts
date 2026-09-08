import type {
  ManagedNoteConflict,
  ManagedNoteRevision,
} from '../../shared/contracts/managedNoteRevision';

export interface ManagedNoteRevisionRepository {
  get(stableId: string): ManagedNoteRevision | null;
  findByPath(relativePath: string): ManagedNoteRevision | null;
  append(revision: ManagedNoteRevision, expectedRevision: number | null): ManagedNoteRevision;
  recordConflict(
    conflict: ManagedNoteConflict,
    expectedRevision: number | null,
  ): ManagedNoteConflict;
  history(stableId: string, afterRevision?: number, limit?: number): readonly ManagedNoteRevision[];
  conflicts(stableId: string, offset?: number, limit?: number): readonly ManagedNoteConflict[];
}
