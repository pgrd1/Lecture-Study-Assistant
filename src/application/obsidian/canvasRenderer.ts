import { JsonCanvasDocumentSchema } from '../../shared/contracts/obsidianWorkspace';
import { canonicalMindMapGraph } from './mindMapLayout';
import { toVaultRelativePath } from './vaultReferencePath';

/** JSON Canvas 1.0 only; workspace identity/path never enter the file payload. */
export const renderCourseCanvas = (input: unknown): string => {
  const document = JsonCanvasDocumentSchema.parse(input);
  const graph = canonicalMindMapGraph({ nodes: document.nodes, edges: document.edges });
  const nodes = graph.nodes.map((node) => {
    const geometry = {
      id: node.id,
      type: node.type,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    };
    return node.type === 'file'
      ? { ...geometry, file: toVaultRelativePath(node.file) }
      : { ...geometry, text: node.text };
  });
  const edges = graph.edges.map((edge) => ({
    id: edge.id,
    fromNode: edge.fromNode,
    toNode: edge.toNode,
    label: edge.label,
  }));
  return `${JSON.stringify({ nodes, edges }, null, 2)}\n`;
};
