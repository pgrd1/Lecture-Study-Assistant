import { z } from 'zod';
import {
  guardManagedNoteRecord,
  ManagedMarkdownContentSchema,
  type ManagedNoteConflictReason,
} from '../../shared/contracts/managedNoteRevision';

const Input = guardManagedNoteRecord(
  z
    .strictObject({
      base: ManagedMarkdownContentSchema,
      current: ManagedMarkdownContentSchema,
      candidate: ManagedMarkdownContentSchema,
    })
    .readonly(),
);
export type MarkdownMergeResult =
  | Readonly<{ kind: 'unchanged' }>
  | Readonly<{ kind: 'write'; mergedContent: string }>
  | Readonly<{ kind: 'conflict'; reason: ManagedNoteConflictReason }>;
const USER_START = '<!-- study-assistant:user:start -->';
const USER_END = '<!-- study-assistant:user:end -->';
const GENERATED_END = '<!-- study-assistant:generated:end -->';
const GENERATED_START =
  /^<!-- study-assistant:generated:start section="([a-z0-9][a-z0-9_-]{0,79})" revision="[A-Za-z0-9][A-Za-z0-9_-]{0,79}" -->$/u;
type Regions = Readonly<{ prefix: string; user: string; suffix: string; locked: boolean }>;

// Consume every reserved token, including misspellings in comments. Marker
// interiors are never line-normalized; the only editable interval is byte exact.
const regions = (content: string): Regions | null => {
  if (!content.startsWith('---\n')) return null;
  const frontmatterEnd = content.indexOf('\n---\n', 3);
  if (frontmatterEnd < 0) return null;
  let state: 'outside' | 'generated' | 'user' | 'done' = 'outside';
  let start = -1;
  let end = -1;
  let reserved = 0;
  const sections = new Set<string>();
  let cursor = 0;
  while (cursor < content.length) {
    const index = content.indexOf('<!--', cursor);
    if (index < 0) break;
    const close = content.indexOf('-->', index + 4);
    if (close < 0) return null;
    const text = content.slice(index, close + 3);
    cursor = close + 3;
    if (!/study-assistant/iu.test(text)) continue;
    reserved++;
    if (index <= frontmatterEnd) return null;
    if (text !== USER_END && content[index - 1] !== '\n') return null;
    if (text !== USER_START && content[index + text.length] !== '\n') return null;
    const section = GENERATED_START.exec(text)?.[1];
    if (section && state === 'outside' && !sections.has(section) && sections.size < 100) {
      sections.add(section);
      state = 'generated';
    } else if (text === GENERATED_END && state === 'generated') state = 'outside';
    else if (text === USER_START && state === 'outside') {
      start = index + text.length;
      state = 'user';
    } else if (text === USER_END && state === 'user') {
      end = index;
      state = 'done';
    } else return null;
  }
  // Also catches malformed/unclosed/injected reserved comments and embedded tokens.
  if (state !== 'done' || (content.match(/study-assistant:/giu)?.length ?? 0) !== reserved)
    return null;
  return Object.freeze({
    prefix: content.slice(0, start),
    user: content.slice(start, end),
    suffix: content.slice(end),
    locked: /^(?:"locked"|locked):[\t ]*true[\t ]*$/mu.test(content.slice(4, frontmatterEnd)),
  });
};

export const threeWayMarkdownMerge = (input: unknown): MarkdownMergeResult => {
  const { base, current, candidate } = Input.parse(input);
  const before = regions(base);
  const now = regions(current);
  const next = regions(candidate);
  if (!before || !now || !next)
    return Object.freeze({ kind: 'conflict', reason: 'malformed_markers' });
  if (now.locked)
    return current === candidate
      ? Object.freeze({ kind: 'unchanged' })
      : Object.freeze({ kind: 'conflict', reason: 'locked' });
  if (before.prefix !== now.prefix || before.suffix !== now.suffix)
    return Object.freeze({ kind: 'conflict', reason: 'managed_content_changed' });
  const mergedContent = `${next.prefix}${now.user}${next.suffix}`;
  return mergedContent === current
    ? Object.freeze({ kind: 'unchanged' })
    : Object.freeze({ kind: 'write', mergedContent });
};
