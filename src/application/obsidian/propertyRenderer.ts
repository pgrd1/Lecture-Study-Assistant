import {
  ObsidianPropertiesSchema,
  type ObsidianPropertyValue,
} from '../../shared/contracts/obsidianWorkspace';

const COMMON_KEYS = Object.freeze([
  'stable_id',
  'course_id',
  'source_type',
  'note_type',
  'date',
  'updated_at',
  'topic',
  'chapter',
  'syllabus_week',
  'importance',
  'exam_candidate',
  'review_status',
  'confidence',
  'sources',
  'related_concepts',
  'related_questions',
  'model',
  'prompt_version',
  'management_state',
  'locked',
]);

// Compare Unicode scalar values, independent of locale and UTF-16 surrogate ordering.
const compareCodePoints = (left: string, right: string): number => {
  const a = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const b = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
};

const quoted = (value: string): string => {
  if (/\p{Cs}/u.test(value)) throw new TypeError('INVALID_OBSIDIAN_PROPERTY_TEXT');
  // JSON double-quoted strings are a conservative subset of YAML quoted scalars.
  return JSON.stringify(value);
};

const renderValue = (value: ObsidianPropertyValue): string => {
  if (typeof value === 'string') return quoted(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  return `[${value.map(quoted).join(', ')}]`;
};

/** Includes both frontmatter delimiters, with no final newline. */
export const renderProperties = (input: unknown): string => {
  const properties = ObsidianPropertiesSchema.parse(input);
  const entries = Object.entries(properties).sort(([left], [right]) => {
    const a = COMMON_KEYS.indexOf(left);
    const b = COMMON_KEYS.indexOf(right);
    if (a >= 0 || b >= 0)
      return (a < 0 ? COMMON_KEYS.length : a) - (b < 0 ? COMMON_KEYS.length : b);
    return compareCodePoints(left, right);
  });
  return [
    '---',
    ...entries.map(([key, value]) => `${quoted(key)}: ${renderValue(value)}`),
    '---',
  ].join('\n');
};
