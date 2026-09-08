import {
  type ObsidianBaseDocument,
  ObsidianBaseDocumentSchema,
  WorkspaceCourseRootSchema,
} from '../../shared/contracts/obsidianWorkspace';
import { toVaultRelativePath } from './vaultReferencePath';

// Single-quoted YAML leaves Base expression quotes intact; apostrophes are doubled.
const yaml = (value: string): string => {
  if (/[\p{Cs}\uFFFE\uFFFF]/u.test(value)) throw new TypeError('INVALID_BASE_TEXT');
  return `'${value.replaceAll("'", "''")}'`;
};
const folderFilter = (path: string): string =>
  `file.inFolder(${JSON.stringify(toVaultRelativePath(path))})`;
const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
type View = ObsidianBaseDocument['views'][number];
type Semantics = Readonly<{ filters: readonly string[]; sort?: string; limit?: number }>;

// Only these stable IDs activate built-in behavior. Properties such as question
// counts are supplied by projection; Bases reads them when opened, without IO here.
const viewSemantics = (id: string, root: string, global: boolean): Semantics => {
  switch (id) {
    case 'recent-lectures':
      return {
        filters: [global ? 'note_type == "lecture"' : folderFilter(`${root}/강의노트`)],
        sort: 'updated_at',
        limit: 20,
      };
    case 'attention-needed':
      return {
        filters: [
          '(review_status == "processing" || review_status == "failed" || review_status == "needs_review")',
        ],
        sort: 'updated_at',
      };
    case 'exam-candidates':
      return { filters: ['exam_candidate == true'], sort: 'importance' };
    case 'question-counts':
      return {
        filters: ['(note_type == "question_bank" || note_type == "question_inbox")'],
        sort: 'updated_at',
      };
    case 'latest-exam-packages':
      return {
        filters: [global ? 'file.path.contains("/시험/")' : folderFilter(`${root}/시험`)],
        sort: 'updated_at',
        limit: 5,
      };
    default:
      return { filters: [] };
  }
};

const renderView = (view: View, root: string, global: boolean): readonly string[] => {
  const semantics = viewSemantics(view.id, root, global);
  const kinds = [...view.noteKinds].sort(compareIds);
  const kindFilter = `(${kinds.map((kind) => `note_type == ${JSON.stringify(kind)}`).join(' || ')})`;
  return [
    `  - type: ${yaml(view.type)}`,
    `    name: ${yaml(view.name)}`,
    '    filters:',
    '      and:',
    ...[kindFilter, ...semantics.filters].map((filter) => `        - ${yaml(filter)}`),
    '    order:',
    ...view.properties.map((property) => `      - ${yaml(property)}`),
    ...(semantics.sort
      ? ['    sort:', `      - property: ${yaml(semantics.sort)}`, "        direction: 'DESC'"]
      : []),
    ...(semantics.limit ? [`    limit: ${semantics.limit}`] : []),
  ];
};

/** Pure renderer of the declarative Base contract, never raw expressions. */
export const renderCourseBase = (input: unknown): string => {
  const document = ObsidianBaseDocumentSchema.parse(input);
  const global = document.courseId === null;
  const parts = document.relativePath.split('/');
  if (global && document.relativePath !== '학습 대시보드.base')
    throw new TypeError('INVALID_BASE_SCOPE');
  if (!global && parts.length < 3) throw new TypeError('INVALID_BASE_SCOPE');
  const root = global ? '과목' : WorkspaceCourseRootSchema.parse(parts.slice(0, 2).join('/'));
  return [
    'filters:',
    '  and:',
    `    - ${yaml(folderFilter(root))}`,
    ...(document.courseId === null
      ? []
      : [`    - ${yaml(`course_id == ${JSON.stringify(document.courseId)}`)}`]),
    'views:',
    ...[...document.views]
      .sort((a, b) => compareIds(a.id, b.id))
      .flatMap((view) => renderView(view, root, global)),
    '',
  ].join('\n');
};
