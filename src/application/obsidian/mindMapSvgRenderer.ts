import { SvgArtifactDocumentSchema } from '../../shared/contracts/obsidianWorkspace';
import { canonicalMindMapGraph, type MindMapGraph } from './mindMapLayout';

type Node = MindMapGraph['nodes'][number];
const xml = (value: string): string => {
  if (/[\p{Cs}\uFFFE\uFFFF]/u.test(value)) throw new TypeError('INVALID_SVG_TEXT');
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
};
const text = (x: number, y: number, label: string, edge = false): string =>
  `  <text x="${x}" y="${y}" font-size="${edge ? 14 : 16}"${edge ? ' text-anchor="middle"' : ''} fill="${edge ? '#334155' : '#0f172a'}">${xml(label)}</text>`;

const renderNode = (node: Node): readonly string[] => {
  const label = node.type === 'text' ? node.text : (node.file.split('/').at(-1) ?? node.file);
  xml(label); // Validate the full label, including any portion omitted in the preview.
  const characters = Array.from(label);
  const columns = Math.max(1, Math.min(80, Math.floor((node.width - 32) / 16)));
  const rows = Math.max(1, Math.min(5, Math.floor((node.height - 40) / 24)));
  const lines = Array.from(
    { length: Math.min(rows, Math.ceil(characters.length / columns)) },
    (_, index) => {
      const start = index * columns;
      const truncated = index === rows - 1 && characters.length > start + columns;
      return (
        characters.slice(start, start + columns - (truncated ? 1 : 0)).join('') +
        (truncated ? '…' : '')
      );
    },
  );
  return [
    `  <rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="12" fill="#f8fafc" stroke="#64748b"/>`,
    ...lines.map((line, index) => text(node.x + 16, node.y + 32 + index * 24, line)),
  ];
};

type DirectionCue = Readonly<{ x1: number; y1: number; x2: number; y2: number }>;
type EdgeRoute = Readonly<{
  id: string;
  label: string;
  points: readonly (readonly [number, number])[];
  x: number;
  y: number;
  cue: DirectionCue;
}>;

// Reserve 20px around the line for the 10x10 marker at 2px stroke width.
// Vertical arrows follow source-to-target y; equal-y edges point left/right.
// Coincident endpoints use stable IDs as a tie-breaker; self edges point right.
const directionCue = (x: number, y: number, from: Node, to: Node): DirectionCue => {
  const vertical = Math.sign(
    to.y + Math.floor(to.height / 2) - from.y - Math.floor(from.height / 2),
  );
  if (vertical !== 0) return { x1: x, y1: y + vertical * 38, x2: x, y2: y + vertical * 62 };
  const horizontal =
    Math.sign(to.x + Math.floor(to.width / 2) - from.x - Math.floor(from.width / 2)) ||
    (from.id <= to.id ? 1 : -1);
  return { x1: x - horizontal * 12, y1: y + 48, x2: x + horizontal * 12, y2: y + 48 };
};

// One 128px lane per stable edge ID. The 96px label boxes cannot overlap each
// other or any node, even for parallel, reverse or same-depth skip relationships.
// The renderer caps this at 5,000 edges: at most 640,000px additional horizontal span.
const routeEdges = (graph: MindMapGraph): readonly EdgeRoute[] => {
  const right = Math.max(...graph.nodes.map((node) => node.x + node.width));
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.edges.map((edge, index) => {
    const from = nodes.get(edge.fromNode);
    const to = nodes.get(edge.toNode);
    if (!from || !to) throw new TypeError('INVALID_MIND_MAP_EDGE');
    const x = right + 64 + index * 128;
    const y1 = from.y + Math.floor(from.height / 2);
    const y2 = to.y + Math.floor(to.height / 2);
    const y = Math.floor((y1 + y2) / 2);
    return {
      id: edge.id,
      label: edge.label,
      points: [
        [from.x + from.width, y1],
        [x, y1],
        [x, y2],
        [to.x + to.width, y2],
      ],
      x,
      y,
      cue: directionCue(x, y, from, to),
    };
  });
};

const renderRoute = (route: EdgeRoute): string =>
  `  <polyline id="edge-route-${route.id}" points="${route.points.map((point) => point.join(',')).join(' ')}" fill="none" stroke="#64748b" stroke-width="2" marker-end="url(#arrow)"/>`;

const renderEdgeLabel = (route: EdgeRoute): readonly string[] => [
  `  <g id="edge-label-${route.id}">`,
  `    <rect x="${route.x - 48}" y="${route.y - 14}" width="96" height="28" rx="4" fill="#ffffff"/>`,
  `  ${text(route.x, route.y + 5, route.label, true)}`,
  `    <line x1="${route.cue.x1}" y1="${route.cue.y1}" x2="${route.cue.x2}" y2="${route.cue.y2}" stroke="#64748b" stroke-width="2" marker-end="url(#arrow)"/>`,
  '  </g>',
];

/** Passive preview only: notes and Canvas remain the full content carriers. */
export const renderMindMapSvg = (input: unknown): string => {
  const document = SvgArtifactDocumentSchema.parse(input);
  const graph = canonicalMindMapGraph({ nodes: document.nodes, edges: document.edges });
  const routes = routeEdges(graph);
  const left =
    Math.min(
      ...graph.nodes.map((node) => node.x),
      ...routes.map(({ cue }) => Math.min(cue.x1, cue.x2) - 20),
    ) - 32;
  const top =
    Math.min(
      ...graph.nodes.map((node) => node.y),
      ...routes.map((route) => route.y - 14),
      ...routes.map(({ cue }) => Math.min(cue.y1, cue.y2) - 20),
    ) - 32;
  const right =
    Math.max(
      ...graph.nodes.map((node) => node.x + node.width),
      ...routes.map((route) => route.x + 48),
      ...routes.map(({ cue }) => Math.max(cue.x1, cue.x2) + 20),
    ) + 32;
  const bottom =
    Math.max(
      ...graph.nodes.map((node) => node.y + node.height),
      ...routes.map((route) => route.y + 14),
      ...routes.map(({ cue }) => Math.max(cue.y1, cue.y2) + 20),
    ) + 32;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${right - left} ${bottom - top}">`,
    '  <defs>',
    '    <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto">',
    '      <path d="M 0 0 L 10 5 L 0 10 Z" fill="#64748b"/>',
    '    </marker>',
    '  </defs>',
    ...routes.map(renderRoute),
    ...graph.nodes.flatMap(renderNode),
    ...routes.flatMap(renderEdgeLabel),
    '</svg>',
    '',
  ].join('\n');
};
