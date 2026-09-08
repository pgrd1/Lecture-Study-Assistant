import { z } from 'zod';
import { assertBoundedPipelineJson } from './boundedPipelineJson';
import { createSafeWindowsPathSegmentSchema } from './windowsPath';

export const NOTE_KINDS = Object.freeze([
  'dashboard',
  'course',
  'lecture',
  'concept',
  'question_bank',
  'memory',
  'question_inbox',
  'professor_profile',
] as const);

// Syntax validation only: publication must separately check real paths/reparse points.
const Segment = createSafeWindowsPathSegmentSchema(255).refine(
  (value) => !/[\p{Cf}\p{Cs}\p{Zl}\p{Zp}%]/u.test(value),
);
export const WorkspaceCourseFolderSchema = createSafeWindowsPathSegmentSchema(100).refine(
  (value) => Segment.safeParse(value).success,
);
const RelativePath = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => value.split('/').every((part) => Segment.safeParse(part).success));

export { RelativePath as WorkspaceRelativePathSchema };
export const WorkspaceCourseRootSchema = RelativePath.refine((value) => {
  const parts = value.split('/');
  return (
    parts.length === 2 &&
    parts[0] === '과목' &&
    WorkspaceCourseFolderSchema.safeParse(parts[1]).success
  );
});
const EXTENSIONS = Object.freeze([
  '.md',
  '.base',
  '.canvas',
  '.svg',
  '.json',
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.m4a',
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.mp4',
  '.txt',
  '.docx',
  '.aac',
  '.pptx',
  '.heic',
] as const);
export const VaultRelativePathSchema = RelativePath.refine((value) =>
  EXTENSIONS.some((extension) => value.endsWith(extension)),
);
const pathFor = (extension: string) =>
  VaultRelativePathSchema.refine((value) => value.endsWith(extension));
export const workspacePathKey = (value: string): string =>
  value.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');

// Reject hostile object shapes before Zod reads fields. The existing guard also
// bounds total bytes, depth and node count; schemas impose tighter field limits.
const PlainData = z.unknown().superRefine((value, context) => {
  try {
    assertBoundedPipelineJson(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'INVALID_WORKSPACE_DATA' });
  }
});
const guarded = <T extends z.ZodType>(schema: T) => PlainData.pipe(schema);

/** Preflight a closed envelope without imposing a document-sized cap on the
 * whole workspace. Every collection member retains the 16-MiB/depth/node guard. */
export const assertPartitionedWorkspaceData = (
  value: unknown,
  fields: readonly string[],
  collections: Readonly<Record<string, number>>,
): void => {
  const invalid: () => never = () => {
    throw new TypeError('INVALID_WORKSPACE_DATA');
  };
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid();
  const allowed = new Set([...fields, ...Object.keys(collections)]);
  const keys = Reflect.ownKeys(value as object);
  if (keys.length !== allowed.size) invalid();
  const seen = new WeakSet<object>();
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
    const item: unknown = descriptor.value;
    const maximum = collections[key as string];
    if (maximum === undefined) {
      assertBoundedPipelineJson(item);
      continue;
    }
    if (
      !Array.isArray(item) ||
      Object.getPrototypeOf(item) !== Array.prototype ||
      item.length > maximum
    )
      invalid();
    const array = item as unknown[];
    if (Reflect.ownKeys(array).length !== array.length + 1) invalid();
    for (let index = 0; index < array.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(array, String(index));
      if (!entry || !('value' in entry) || !entry.enumerable) invalid();
      const child: unknown = entry.value;
      if (child !== null && typeof child === 'object') {
        if (seen.has(child)) invalid();
        seen.add(child);
      }
      assertBoundedPipelineJson(child);
    }
  }
};
const Identifier = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/u);
const Uuid = z.uuid().transform((value) => value.toLowerCase());
const SingleLine = z
  .string()
  .max(500)
  .refine((value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value));
const PropertyKey = z
  .string()
  .regex(/^[\p{L}\p{N}_][\p{L}\p{N}_ -]{0,63}$/u)
  .refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value));
const PropertyValue = z.union([
  SingleLine,
  z.number().finite(),
  z.boolean(),
  z.array(SingleLine).max(50).readonly(),
]);
export const ObsidianPropertyValueSchema = guarded(PropertyValue);
const Properties = z
  .record(PropertyKey, PropertyValue)
  .refine((value) => Object.keys(value).length <= 64)
  .readonly();
export const ObsidianPropertiesSchema = guarded(Properties);
export type ObsidianPropertyValue = z.infer<typeof ObsidianPropertyValueSchema>;

const Section = z
  .strictObject({
    id: Identifier,
    markdown: z
      .string()
      .max(100_000)
      .refine((value) => !value.includes('\0')),
  })
  .readonly();
export const GeneratedSectionSchema = guarded(Section);
export type GeneratedSection = z.infer<typeof GeneratedSectionSchema>;
const Markdown = z
  .strictObject({
    stableId: Identifier,
    kind: z.enum(NOTE_KINDS),
    relativePath: pathFor('.md'),
    properties: Properties,
    generatedSections: z
      .array(Section)
      .max(100)
      .refine((sections) => new Set(sections.map((section) => section.id)).size === sections.length)
      .readonly(),
    relatedSourceIds: z
      .array(Uuid)
      .max(1_000)
      .refine((ids) => new Set(ids).size === ids.length)
      .readonly(),
  })
  .readonly();
export const ManagedMarkdownDocumentSchema = guarded(Markdown);
export type ManagedMarkdownDocument = z.infer<typeof ManagedMarkdownDocumentSchema>;

// Declarative view data, never arbitrary YAML or Base filter expressions.
const BaseView = z
  .strictObject({
    id: Identifier,
    name: SingleLine.min(1),
    type: z.enum(['table', 'list', 'cards']),
    noteKinds: z
      .array(z.enum(NOTE_KINDS))
      .min(1)
      .max(NOTE_KINDS.length)
      .refine((values) => new Set(values).size === values.length)
      .readonly(),
    properties: z
      .array(PropertyKey)
      .min(1)
      .max(64)
      .refine((values) => new Set(values).size === values.length)
      .readonly(),
  })
  .readonly();
const Base = z
  .strictObject({
    stableId: Identifier,
    kind: z.literal('base'),
    relativePath: pathFor('.base'),
    courseId: Uuid.nullable(),
    views: z
      .array(BaseView)
      .min(1)
      .max(20)
      .refine((views) => new Set(views.map((view) => view.id)).size === views.length)
      .readonly(),
  })
  .readonly();
export const ObsidianBaseDocumentSchema = guarded(Base);
export type ObsidianBaseDocument = z.infer<typeof ObsidianBaseDocumentSchema>;

const geometry = {
  id: Identifier,
  x: z.number().finite().min(-100_000).max(100_000),
  y: z.number().finite().min(-100_000).max(100_000),
  width: z.number().finite().min(1).max(10_000),
  height: z.number().finite().min(1).max(10_000),
};
const GraphNode = z.discriminatedUnion('type', [
  z
    .strictObject({ ...geometry, type: z.literal('file'), file: VaultRelativePathSchema })
    .readonly(),
  z.strictObject({ ...geometry, type: z.literal('text'), text: SingleLine.min(1) }).readonly(),
]);
const GraphEdge = z
  .strictObject({
    id: Identifier,
    fromNode: Identifier,
    toNode: Identifier,
    label: z.enum(['선행', '포함', '비교', '원인', '예외', '출제 연계']),
  })
  .readonly();
const graphFields = {
  nodes: z.array(GraphNode).max(1_000).readonly(),
  edges: z.array(GraphEdge).max(5_000).readonly(),
};
type Graph = Readonly<{
  nodes: readonly z.infer<typeof GraphNode>[];
  edges: readonly z.infer<typeof GraphEdge>[];
}>;
const validGraph = (graph: Graph): boolean => {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const allIds = [...nodeIds, ...graph.edges.map((edge) => edge.id)];
  return (
    nodeIds.size === graph.nodes.length &&
    new Set(allIds).size === allIds.length &&
    graph.edges.every((edge) => nodeIds.has(edge.fromNode) && nodeIds.has(edge.toNode))
  );
};
const Canvas = z
  .strictObject({
    stableId: Identifier,
    kind: z.literal('canvas'),
    relativePath: pathFor('.canvas'),
    ...graphFields,
  })
  .refine(validGraph)
  .readonly();
export const JsonCanvasDocumentSchema = guarded(Canvas);
export type JsonCanvasDocument = z.infer<typeof JsonCanvasDocumentSchema>;

// SVG carries only a graph descriptor. Later rendering escapes labels and emits
// allowlisted SVG elements; accepting raw XML here would bypass that boundary.
const Svg = z
  .strictObject({
    stableId: Identifier,
    kind: z.literal('svg'),
    relativePath: pathFor('.svg'),
    ...graphFields,
  })
  .refine(validGraph)
  .readonly();
export const SvgArtifactDocumentSchema = guarded(Svg);
export type SvgArtifactDocument = z.infer<typeof SvgArtifactDocumentSchema>;
const Artifact = z.union([Base, Canvas, Svg]);
export const WorkspaceArtifactSchema = guarded(Artifact);
export type WorkspaceArtifact = z.infer<typeof WorkspaceArtifactSchema>;

const Projection = z
  .strictObject({
    courseId: Uuid,
    courseRoot: WorkspaceCourseRootSchema,
    dashboard: Markdown.refine(
      (note) => note.kind === 'dashboard' && note.relativePath === '학습 대시보드.md',
    ),
    dashboardBase: Base.refine(
      (base) => base.courseId === null && base.relativePath === '학습 대시보드.base',
    ),
    courseMain: Markdown.refine((note) => note.kind === 'course'),
    notes: z.array(Markdown).max(5_000).readonly(),
    artifacts: z.array(Artifact).max(1_000).readonly(),
  })
  .superRefine((value, context) => {
    const children = [value.courseMain, ...value.notes, ...value.artifacts];
    const documents = [value.dashboard, value.dashboardBase, ...children];
    const underCourse = (path: string): boolean => path.startsWith(`${value.courseRoot}/`);
    if (
      new Set(documents.map((document) => document.stableId)).size !== documents.length ||
      new Set(documents.map((document) => workspacePathKey(document.relativePath))).size !==
        documents.length ||
      children.some((document) => !underCourse(document.relativePath)) ||
      value.notes.some((note) => note.kind === 'dashboard' || note.kind === 'course') ||
      value.artifacts.some((artifact) =>
        artifact.kind === 'base'
          ? artifact.courseId !== value.courseId
          : artifact.nodes.some((node) => node.type === 'file' && !underCourse(node.file)),
      )
    )
      context.addIssue({ code: 'custom', message: 'INVALID_WORKSPACE_IDENTITY_OR_PATH' });
  })
  .readonly();
export const WorkspaceProjectionSchema = z
  .unknown()
  .superRefine((value, context) => {
    try {
      assertPartitionedWorkspaceData(
        value,
        ['courseId', 'courseRoot', 'dashboard', 'dashboardBase', 'courseMain'],
        { notes: 5000, artifacts: 1000 },
      );
    } catch {
      context.addIssue({ code: 'custom', message: 'INVALID_WORKSPACE_DATA' });
    }
  })
  .pipe(Projection);
export type WorkspaceProjection = z.infer<typeof WorkspaceProjectionSchema>;
