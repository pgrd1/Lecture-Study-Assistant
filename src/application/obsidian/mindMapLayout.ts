import { z } from 'zod';
import { assertBoundedPipelineJson } from '../../shared/contracts/boundedPipelineJson';
import {
  type JsonCanvasDocument,
  JsonCanvasDocumentSchema,
  VaultRelativePathSchema,
} from '../../shared/contracts/obsidianWorkspace';

export type MindMapGraph = Readonly<Pick<JsonCanvasDocument, 'nodes' | 'edges'>>;
const identifier = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/u);
const fields = {
  id: identifier,
  role: z.enum(['center', 'topic', 'concept', 'file', 'media', 'text']),
  depth: z.number().int().min(0).max(12),
};
const node = z
  .discriminatedUnion('type', [
    z
      .strictObject({
        ...fields,
        type: z.literal('text'),
        text: z
          .string()
          .min(1)
          .max(500)
          .refine((value) => !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)),
      })
      .readonly(),
    z
      .strictObject({ ...fields, type: z.literal('file'), file: VaultRelativePathSchema })
      .readonly(),
  ])
  .refine((value) => {
    if (value.role === 'center') return value.depth === 0;
    if (value.role === 'topic') return value.depth === 1;
    if (value.role === 'media' || value.role === 'file')
      return value.depth >= 2 && value.type === 'file';
    return value.depth >= 2;
  });
const edge = z
  .strictObject({
    id: identifier,
    fromNode: identifier,
    toNode: identifier,
    label: z.enum(['선행', '포함', '비교', '원인', '예외', '출제 연계']),
  })
  .readonly();
const layoutInput = z
  .strictObject({
    nodes: z.array(node).min(1).max(256).readonly(),
    edges: z.array(edge).max(1024).readonly(),
  })
  .refine((value) => value.nodes.filter((item) => item.role === 'center').length === 1)
  .readonly();
export type MindMapLayoutInput = z.infer<typeof layoutInput>;

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Validates laid-out graphs too: Task 1 allows fractional geometry; Canvas 1.0 does not. */
export const canonicalMindMapGraph = (input: unknown): MindMapGraph => {
  assertBoundedPipelineJson(input);
  const graph = z.strictObject({ nodes: z.unknown(), edges: z.unknown() }).parse(input);
  const validated = JsonCanvasDocumentSchema.parse({
    ...graph,
    stableId: 'graph',
    kind: 'canvas',
    relativePath: 'graph.canvas',
  });
  if (validated.nodes.length === 0) throw new TypeError('EMPTY_MIND_MAP');
  for (const item of validated.nodes) {
    if (![item.x, item.y, item.width, item.height].every(Number.isInteger))
      throw new TypeError('INVALID_MIND_MAP_GEOMETRY');
    if (item.type === 'text' && /\p{Cs}/u.test(item.text))
      throw new TypeError('INVALID_MIND_MAP_TEXT');
  }
  return Object.freeze({
    nodes: Object.freeze([...validated.nodes].sort((a, b) => a.x - b.x || compareIds(a.id, b.id))),
    edges: Object.freeze([...validated.edges].sort((a, b) => compareIds(a.id, b.id))),
  });
};

/** Fixed 320x160 rectangles, 100px column/60px row gaps. At most 256 nodes,
 * 1024 edges and depth 12: x <= 5040, y <= 56100, below contract bounds.
 * Relationships may form conceptual cycles; cyclic JavaScript data is rejected.
 */
export const layoutMindMap = (input: unknown): MindMapGraph => {
  assertBoundedPipelineJson(input);
  const graph = layoutInput.parse(input);
  const sorted = [...graph.nodes].sort((a, b) => a.depth - b.depth || compareIds(a.id, b.id));
  const nodes = sorted.map((item, index) => {
    // A global row index guarantees separation for every mixture of node types.
    const geometry = { id: item.id, x: item.depth * 420, y: index * 220, width: 320, height: 160 };
    return item.type === 'file'
      ? { ...geometry, type: item.type, file: item.file }
      : { ...geometry, type: item.type, text: item.text };
  });
  return canonicalMindMapGraph({ nodes, edges: graph.edges });
};
