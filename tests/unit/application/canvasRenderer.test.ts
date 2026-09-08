import { describe, expect, it } from 'vitest';
import { renderCourseCanvas } from '../../../src/application/obsidian/canvasRenderer';
import { layoutMindMap } from '../../../src/application/obsidian/mindMapLayout';

const graph = () => ({
  nodes: [
    { id: 'topic', role: 'topic', depth: 1, type: 'text', text: '자료 구조' },
    { id: 'course', role: 'center', depth: 0, type: 'file', file: '과목/자료구조/자료구조.md' },
    { id: 'concept', role: 'concept', depth: 2, type: 'text', text: '연결 리스트' },
    {
      id: 'image',
      role: 'media',
      depth: 2,
      type: 'file',
      file: '과목/자료구조/원본자료/이미지/문제.png',
    },
  ],
  edges: [
    { id: 'b', fromNode: 'topic', toNode: 'concept', label: '선행' },
    { id: 'a', fromNode: 'course', toNode: 'topic', label: '포함' },
  ],
});
const document = (data: ReturnType<typeof layoutMindMap>) => ({
  stableId: 'map',
  kind: 'canvas',
  relativePath: '과목/자료구조/마인드맵/과목 전체.canvas',
  ...data,
});

describe('mind-map layout and Canvas', () => {
  it('emits canonical Canvas 1.0 without workspace metadata', () => {
    const output = renderCourseCanvas(
      document(layoutMindMap({ nodes: [graph().nodes[1]], edges: [] })),
    );
    expect(output).toBe(`{
  "nodes": [
    {
      "id": "course",
      "type": "file",
      "x": 0,
      "y": 0,
      "width": 320,
      "height": 160,
      "file": "AI 학습/과목/자료구조/자료구조.md"
    }
  ],
  "edges": []
}
`);
  });

  it('has independently checked non-overlap, exact targets and connected references', () => {
    const input = graph();
    const output = JSON.parse(renderCourseCanvas(document(layoutMindMap(input))));
    expect(Object.keys(output)).toEqual(['nodes', 'edges']);
    const ids = [...output.nodes, ...output.edges].map((item: { id: string }) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [index, node] of output.nodes.entries()) {
      expect(Object.keys(node)).toEqual([
        'id',
        'type',
        'x',
        'y',
        'width',
        'height',
        node.type === 'file' ? 'file' : 'text',
      ]);
      for (const field of ['x', 'y', 'width', 'height'])
        expect(Number.isInteger(node[field])).toBe(true);
      if (node.type === 'file')
        expect(node.file).toBe(`AI 학습/${input.nodes.find((item) => item.id === node.id)?.file}`);
      for (const other of output.nodes.slice(index + 1)) {
        expect(
          node.x + node.width <= other.x ||
            other.x + other.width <= node.x ||
            node.y + node.height <= other.y ||
            other.y + other.height <= node.y,
        ).toBe(true);
      }
    }
    expect(output.edges.map((edge: { id: string }) => edge.id)).toEqual(['a', 'b']);
    for (const edge of output.edges) {
      expect(Object.keys(edge)).toEqual(['id', 'fromNode', 'toNode', 'label']);
      expect(output.nodes.some((node: { id: string }) => node.id === edge.fromNode)).toBe(true);
      expect(output.nodes.some((node: { id: string }) => node.id === edge.toNode)).toBe(true);
    }
  });

  it('is invariant to input permutations and preserves all input objects', () => {
    const input = graph();
    const before = JSON.stringify(input);
    const laid = layoutMindMap(input);
    const output = renderCourseCanvas(document(laid));
    expect(
      renderCourseCanvas(
        document(
          layoutMindMap({ nodes: [...input.nodes].reverse(), edges: [...input.edges].reverse() }),
        ),
      ),
    ).toBe(output);
    expect(
      renderCourseCanvas(
        document({ nodes: [...laid.nodes].reverse(), edges: [...laid.edges].reverse() }),
      ),
    ).toBe(output);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(laid.nodes[0])).toBe(true);
  });

  it('bounds 256 nodes and depth 12 with no coordinate overflow', () => {
    const nodes = [
      graph().nodes[1],
      ...Array.from({ length: 255 }, (_, index) => ({
        id: `n${index}`,
        role: 'text',
        depth: 12,
        type: 'text',
        text: '개념',
      })),
    ];
    const result = layoutMindMap({ nodes, edges: [] });
    for (const node of result.nodes) expect(Math.abs(node.y) + node.height).toBeLessThan(100_000);
    expect(() =>
      layoutMindMap({ nodes: [...nodes, { ...nodes[1], id: 'overflow' }], edges: [] }),
    ).toThrow();
    expect(() =>
      layoutMindMap({ nodes: [nodes[0], { ...nodes[1], depth: 13 }], edges: [] }),
    ).toThrow();
  });

  it.each([
    { nodes: [] },
    { nodes: [graph().nodes[0]] },
    { nodes: [graph().nodes[1], { ...graph().nodes[1], id: 'other' }] },
    { nodes: [graph().nodes[1], graph().nodes[1]] },
    { nodes: [{ ...graph().nodes[1], depth: 1 }] },
    { nodes: [graph().nodes[1], { ...graph().nodes[0], depth: 2 }] },
    { nodes: [graph().nodes[1], { ...graph().nodes[2], depth: 1 }] },
    { nodes: [{ ...graph().nodes[1], type: 'link' }] },
    { nodes: [{ ...graph().nodes[1], file: 'https://example.com/x.png' }] },
    { nodes: [{ ...graph().nodes[1], file: '../private.md' }] },
    { nodes: [{ ...graph().nodes[1], raw: 'xml' }] },
    { edges: [{ id: 'course', fromNode: 'course', toNode: 'topic', label: '포함' }] },
    { edges: [{ id: 'edge', fromNode: 'course', toNode: 'missing', label: '포함' }] },
    { edges: [{ id: 'edge', fromNode: 'course', toNode: 'topic', label: 'arbitrary' }] },
    { edges: [graph().edges[0], { ...graph().edges[0] }] },
    { extra: true },
  ])('fails closed for invalid graph %#', (change) => {
    expect(() => layoutMindMap({ ...graph(), ...change })).toThrow();
  });

  it('rejects accessor, custom prototype, cycle and excessive edges before access', () => {
    let reads = 0;
    const getter = Object.defineProperty({}, 'nodes', {
      enumerable: true,
      get: () => {
        reads++;
        return [];
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.nodes = cycle;
    for (const input of [
      getter,
      Object.create({ nodes: [] }),
      cycle,
      {
        ...graph(),
        edges: Array.from({ length: 1025 }, (_, index) => ({
          ...graph().edges[0],
          id: `e${index}`,
        })),
      },
    ]) {
      expect(() => layoutMindMap(input)).toThrow();
    }
    expect(reads).toBe(0);
  });

  it.each([0.5, Number.NaN, Infinity, 100001])('rejects invalid Canvas geometry %s', (x) => {
    expect(() =>
      renderCourseCanvas(
        document({
          nodes: [{ id: 'a', type: 'text', text: 'a', x, y: 0, width: 320, height: 160 }],
          edges: [],
        }),
      ),
    ).toThrow();
  });
});
