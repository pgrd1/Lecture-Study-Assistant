import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { layoutMindMap } from '../../../src/application/obsidian/mindMapLayout';
import { renderMindMapSvg } from '../../../src/application/obsidian/mindMapSvgRenderer';

const fixture = () => ({
  stableId: 'preview',
  kind: 'svg',
  relativePath: '과목/자료구조/마인드맵/과목 전체.svg',
  nodes: [
    {
      id: 'a',
      type: 'text',
      text: '자료 & <개념> "중요"',
      x: -320,
      y: -160,
      width: 320,
      height: 160,
    },
    {
      id: 'b',
      type: 'file',
      file: '과목/자료구조/연결 리스트.md',
      x: 100,
      y: 0,
      width: 320,
      height: 160,
    },
  ],
  edges: [{ id: 'ab', fromNode: 'a', toNode: 'b', label: '포함' }],
});

// Independently reserve 20px around each cue segment: the 10x10 marker scales
// with a 2px stroke. Assert actual rendered geometry, without renderer helpers.
const verifyDirectionCueGeometry = (document: Document, count: number): void => {
  const lines = [...document.querySelectorAll('line[marker-end="url(#arrow)"]')];
  expect(lines).toHaveLength(count);
  const [left = 0, top = 0, width = 0, height = 0] = (
    document.documentElement.getAttribute('viewBox') ?? ''
  )
    .split(' ')
    .map(Number);
  expect([left, top, width, height].every(Number.isSafeInteger)).toBe(true);
  const rectangles = [...document.querySelectorAll('rect')].map((rectangle) => ({
    x: Number(rectangle.getAttribute('x')),
    y: Number(rectangle.getAttribute('y')),
    width: Number(rectangle.getAttribute('width')),
    height: Number(rectangle.getAttribute('height')),
  }));
  const bounds = lines.map((line) => {
    const x1 = Number(line.getAttribute('x1'));
    const x2 = Number(line.getAttribute('x2'));
    const y1 = Number(line.getAttribute('y1'));
    const y2 = Number(line.getAttribute('y2'));
    expect([x1, x2, y1, y2].every(Number.isSafeInteger)).toBe(true);
    return {
      x: Math.min(x1, x2) - 20,
      y: Math.min(y1, y2) - 20,
      width: Math.abs(x2 - x1) + 40,
      height: Math.abs(y2 - y1) + 40,
    };
  });
  const elements = [...document.querySelectorAll('*')];
  const lastNode = [...document.querySelectorAll('rect[stroke="#64748b"]')].at(-1);
  if (!lastNode) throw new Error('Missing node');
  for (const [index, cue] of bounds.entries()) {
    expect(cue.x).toBeGreaterThanOrEqual(left);
    expect(cue.y).toBeGreaterThanOrEqual(top);
    expect(cue.x + cue.width).toBeLessThanOrEqual(left + width);
    expect(cue.y + cue.height).toBeLessThanOrEqual(top + height);
    for (const box of [...rectangles, ...bounds.slice(index + 1)]) {
      expect(
        cue.x + cue.width < box.x ||
          box.x + box.width < cue.x ||
          cue.y + cue.height < box.y ||
          box.y + box.height < cue.y,
      ).toBe(true);
    }
  }
  for (const line of lines) {
    expect(elements.indexOf(line)).toBeGreaterThan(elements.indexOf(lastNode));
    expect([...line.attributes].map((attribute) => attribute.name).sort()).toEqual([
      'marker-end',
      'stroke',
      'stroke-width',
      'x1',
      'x2',
      'y1',
      'y2',
    ]);
  }
};

describe('passive SVG preview', () => {
  it('shows a separate visible arrow beside every parallel/reverse lane label with opposite directions', () => {
    const graph = layoutMindMap({
      nodes: [
        { id: 'center', role: 'center', depth: 0, type: 'text', text: '과목' },
        { id: 'a', role: 'topic', depth: 1, type: 'text', text: '시작' },
        { id: 'b', role: 'topic', depth: 1, type: 'text', text: '중간' },
        { id: 'c', role: 'topic', depth: 1, type: 'text', text: '끝' },
      ],
      edges: [
        { id: 'forward', fromNode: 'a', toNode: 'c', label: '선행' },
        { id: 'reverse', fromNode: 'c', toNode: 'a', label: '예외' },
        { id: 'parallel', fromNode: 'a', toNode: 'c', label: '출제 연계' },
      ],
    });
    const input = { ...fixture(), ...graph };
    const output = renderMindMapSvg(input);
    const document = new JSDOM(output, { contentType: 'image/svg+xml' }).window.document;
    verifyDirectionCueGeometry(document, 3);
    for (const [label, direction] of [
      ['선행', 1],
      ['예외', -1],
      ['출제 연계', 1],
    ] as const) {
      const text = [...document.querySelectorAll('text')].find(
        (item) => item.textContent === label,
      );
      const cue = text?.parentElement?.querySelector('line');
      expect(cue).not.toBeNull();
      expect(cue?.getAttribute('x1')).toBe(text?.getAttribute('x'));
      expect(cue?.getAttribute('x2')).toBe(text?.getAttribute('x'));
      expect(Math.sign(Number(cue?.getAttribute('y2')) - Number(cue?.getAttribute('y1')))).toBe(
        direction,
      );
    }
    expect(
      renderMindMapSvg({
        ...input,
        nodes: [...graph.nodes].reverse(),
        edges: [...graph.edges].reverse(),
      }),
    ).toBe(output);
  });

  it.each([-100000, 100000])(
    'gives equal-y and self relationships bounded unambiguous cues at y=%s',
    (y) => {
      const input = {
        ...fixture(),
        nodes: [
          { id: 'a', type: 'text', text: '왼쪽', x: -100000, y, width: 1, height: 1 },
          { id: 'b', type: 'text', text: '오른쪽', x: 100000, y, width: 1, height: 1 },
        ],
        edges: [
          { id: 'forward', fromNode: 'a', toNode: 'b', label: '선행' },
          { id: 'reverse', fromNode: 'b', toNode: 'a', label: '예외' },
          { id: 'self', fromNode: 'a', toNode: 'a', label: '포함' },
        ],
      };
      const output = renderMindMapSvg(input);
      const document = new JSDOM(output, { contentType: 'image/svg+xml' }).window.document;
      verifyDirectionCueGeometry(document, 3);
      for (const [label, direction] of [
        ['선행', 1],
        ['예외', -1],
        ['포함', 1],
      ] as const) {
        const text = [...document.querySelectorAll('text')].find(
          (item) => item.textContent === label,
        );
        const cue = text?.parentElement?.querySelector('line');
        expect(cue).not.toBeNull();
        expect(cue?.getAttribute('y1')).toBe(cue?.getAttribute('y2'));
        expect((Number(cue?.getAttribute('x1')) + Number(cue?.getAttribute('x2'))) / 2).toBe(
          Number(text?.getAttribute('x')),
        );
        expect(Math.sign(Number(cue?.getAttribute('x2')) - Number(cue?.getAttribute('x1')))).toBe(
          direction,
        );
      }
      expect(
        renderMindMapSvg({
          ...input,
          nodes: [...input.nodes].reverse(),
          edges: [...input.edges].reverse(),
        }),
      ).toBe(output);
    },
  );

  it('bounds directional cues at the maximum 5000-edge contract and refuses overflow', () => {
    const input = {
      ...fixture(),
      edges: Array.from({ length: 5000 }, (_, index) => ({
        ...fixture().edges[0],
        id: `edge${index}`,
      })),
    };
    const output = renderMindMapSvg(input);
    expect(output.match(/<line /gu)).toHaveLength(5000);
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThan(32 * 1024 * 1024);
    const viewBox =
      output
        .match(/viewBox="([^"]+)"/u)?.[1]
        ?.split(' ')
        .map(Number) ?? [];
    expect(viewBox).toHaveLength(4);
    expect(viewBox.every(Number.isSafeInteger)).toBe(true);
    expect(viewBox[2]).toBeLessThan(900000);
    expect(() =>
      renderMindMapSvg({
        ...input,
        edges: [...input.edges, { ...input.edges[0], id: 'overflow' }],
      }),
    ).toThrow();
  });

  it('keeps skip-edge labels visible outside all ordinary layout nodes and separate from each other', () => {
    const graph = layoutMindMap({
      nodes: [
        { id: 'center', role: 'center', depth: 0, type: 'text', text: '과목' },
        { id: 'a', role: 'topic', depth: 1, type: 'text', text: '주제 A' },
        { id: 'b', role: 'topic', depth: 1, type: 'text', text: '주제 B' },
        { id: 'c', role: 'topic', depth: 1, type: 'text', text: '주제 C' },
      ],
      edges: [
        { id: 'skip', fromNode: 'a', toNode: 'c', label: '선행' },
        { id: 'reverse', fromNode: 'c', toNode: 'a', label: '예외' },
        { id: 'parallel', fromNode: 'a', toNode: 'c', label: '출제 연계' },
      ],
    });
    const input = { ...fixture(), ...graph };
    const output = renderMindMapSvg(input);
    const document = new JSDOM(output, { contentType: 'image/svg+xml' }).window.document;
    const labels = [...document.querySelectorAll('text[font-size="14"]')];
    expect(labels.map((label) => label.textContent)).toEqual(['출제 연계', '예외', '선행']);
    const rectangles = graph.nodes.map((node) => ({
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    }));
    const labelBounds = labels.map((label) => {
      const x = Number(label.getAttribute('x'));
      const y = Number(label.getAttribute('y'));
      // Conservative hand-derived bounds for the closed labels, at 14px font size.
      const width = Array.from(label.textContent ?? '').length * 14;
      return { x: x - width / 2, y: y - 14, width, height: 20 };
    });
    for (const [index, label] of labelBounds.entries()) {
      for (const rectangle of [...rectangles, ...labelBounds.slice(index + 1)]) {
        expect(
          label.x + label.width < rectangle.x ||
            rectangle.x + rectangle.width < label.x ||
            label.y + label.height < rectangle.y ||
            rectangle.y + rectangle.height < label.y,
        ).toBe(true);
      }
    }
    const renderedElements = [...document.querySelectorAll('*')];
    const lastNodeRectangle = document.querySelectorAll('rect[stroke="#64748b"]')[3];
    expect(lastNodeRectangle).toBeDefined();
    if (!lastNodeRectangle) throw new Error('Missing topic rectangle');
    for (const label of labels)
      expect(renderedElements.indexOf(label)).toBeGreaterThan(
        renderedElements.indexOf(lastNodeRectangle),
      );
    for (const edge of graph.edges) {
      const route = document.getElementById(`edge-route-${edge.id}`);
      const label = document.getElementById(`edge-label-${edge.id}`)?.querySelector('text');
      expect(route).not.toBeNull();
      expect(label?.textContent).toBe(edge.label);
      const points = (route?.getAttribute('points') ?? '')
        .split(' ')
        .map((point) => point.split(',').map(Number));
      const source = graph.nodes.find((node) => node.id === edge.fromNode);
      const target = graph.nodes.find((node) => node.id === edge.toNode);
      if (!source || !target) throw new Error('Missing relationship endpoint');
      expect(points[0]).toEqual([source.x + source.width, source.y + source.height / 2]);
      expect(points.at(-1)).toEqual([target.x + target.width, target.y + target.height / 2]);
      expect(points.some(([x]) => x === Number(label?.getAttribute('x')))).toBe(true);
    }
    expect(
      renderMindMapSvg({
        ...input,
        nodes: [...graph.nodes].reverse(),
        edges: [...graph.edges].reverse(),
      }),
    ).toBe(output);
  });

  it('includes every route and full label backing in finite integer viewBox bounds', () => {
    const input = fixture();
    const output = renderMindMapSvg({
      ...input,
      nodes: [
        { ...input.nodes[0], x: -100000, y: -100000 },
        { ...input.nodes[1], x: 100000, y: 100000 },
      ],
      edges: Array.from({ length: 32 }, (_, index) => ({ ...input.edges[0], id: `e${index}` })),
    });
    const document = new JSDOM(output, { contentType: 'image/svg+xml' }).window.document;
    const viewBox = document.documentElement.getAttribute('viewBox')?.split(' ').map(Number) ?? [];
    expect(viewBox).toHaveLength(4);
    expect(viewBox.every(Number.isSafeInteger)).toBe(true);
    const [left = 0, top = 0, width = 0, height = 0] = viewBox;
    const inside = (x: number, y: number): void => {
      expect(x).toBeGreaterThanOrEqual(left);
      expect(x).toBeLessThanOrEqual(left + width);
      expect(y).toBeGreaterThanOrEqual(top);
      expect(y).toBeLessThanOrEqual(top + height);
    };
    const routes = [...document.querySelectorAll('polyline')];
    expect(routes).toHaveLength(32);
    for (const route of routes) {
      for (const point of (route.getAttribute('points') ?? '').split(' ')) {
        const [x = Number.NaN, y = Number.NaN] = point.split(',').map(Number);
        expect(Number.isSafeInteger(x) && Number.isSafeInteger(y)).toBe(true);
        inside(x, y);
      }
    }
    const labels = [...document.querySelectorAll('g[id^="edge-label-"] rect')];
    expect(labels).toHaveLength(32);
    for (const label of labels) {
      const x = Number(label.getAttribute('x'));
      const y = Number(label.getAttribute('y'));
      inside(x, y);
      inside(x + Number(label.getAttribute('width')), y + Number(label.getAttribute('height')));
    }
  });

  it('emits a literal readable escaped SVG with local arrows and negative viewBox', () => {
    expect(
      renderMindMapSvg(fixture()),
    ).toBe(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-352 -192 916 384">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto">
      <path d="M 0 0 L 10 5 L 0 10 Z" fill="#64748b"/>
    </marker>
  </defs>
  <polyline id="edge-route-ab" points="0,-80 484,-80 484,80 420,80" fill="none" stroke="#64748b" stroke-width="2" marker-end="url(#arrow)"/>
  <rect x="-320" y="-160" width="320" height="160" rx="12" fill="#f8fafc" stroke="#64748b"/>
  <text x="-304" y="-128" font-size="16" fill="#0f172a">자료 &amp; &lt;개념&gt; &quot;중요&quot;</text>
  <rect x="100" y="0" width="320" height="160" rx="12" fill="#f8fafc" stroke="#64748b"/>
  <text x="116" y="32" font-size="16" fill="#0f172a">연결 리스트.md</text>
  <g id="edge-label-ab">
    <rect x="436" y="-14" width="96" height="28" rx="4" fill="#ffffff"/>
    <text x="484" y="5" font-size="14" text-anchor="middle" fill="#334155">포함</text>
    <line x1="484" y1="38" x2="484" y2="62" stroke="#64748b" stroke-width="2" marker-end="url(#arrow)"/>
  </g>
</svg>
`);
  });

  it('is well-formed passive XML and cannot turn user labels into elements', () => {
    const input = fixture();
    const text = `<script href="https://evil.test">&x;</script> '한글'`;
    const output = renderMindMapSvg({ ...input, nodes: [{ ...input.nodes[0], text }], edges: [] });
    const document = new JSDOM(output, { contentType: 'image/svg+xml' }).window.document;
    expect(document.querySelector('parsererror')).toBeNull();
    expect([...document.querySelectorAll('text')].map((node) => node.textContent).join('')).toBe(
      text,
    );
    for (const element of document.querySelectorAll('*')) {
      expect(['svg', 'defs', 'marker', 'path', 'polyline', 'line', 'g', 'text', 'rect']).toContain(
        element.localName,
      );
      for (const attribute of element.attributes) {
        expect(attribute.name).not.toMatch(/^(on|style|href)/iu);
        if (attribute.name !== 'xmlns')
          expect(attribute.value).not.toMatch(/(?:https?:|data:|file:|javascript:)/iu);
      }
    }
    expect(output).not.toMatch(/<\?|<!|<script|<style|foreignObject/u);
  });

  it('is canonical for reordered laid-out nodes and edges without input mutation', () => {
    const input = fixture();
    const before = JSON.stringify(input);
    expect(
      renderMindMapSvg({
        ...input,
        nodes: [...input.nodes].reverse(),
        edges: [...input.edges].reverse(),
      }),
    ).toBe(renderMindMapSvg(input));
    expect(renderMindMapSvg(input)).toBe(renderMindMapSvg(input));
    expect(JSON.stringify(input)).toBe(before);
  });

  it('uses the same layout as Canvas and bounded wrapping for long labels', () => {
    const graph = layoutMindMap({
      nodes: [{ id: 'center', role: 'center', depth: 0, type: 'text', text: '한'.repeat(500) }],
      edges: [],
    });
    const output = renderMindMapSvg({ ...fixture(), ...graph });
    const document = new JSDOM(output, { contentType: 'image/svg+xml' }).window.document;
    expect(document.querySelectorAll('text')).toHaveLength(5);
    expect(document.querySelector('rect')?.getAttribute('width')).toBe('320');
    expect(document.querySelectorAll('text')[4]?.textContent).toBe(`${'한'.repeat(17)}…`);
  });

  it('derives finite integer bounds at both coordinate extremes and normalizes negative zero', () => {
    const input = fixture();
    const output = renderMindMapSvg({
      ...input,
      nodes: [
        { ...input.nodes[0], x: -100000, y: -100000, width: 10000, height: 10000 },
        { ...input.nodes[1], x: 100000, y: 100000, width: 10000, height: 10000 },
      ],
    });
    expect(output).toContain('viewBox="-100032 -100032 210176 210064"');
    expect(output).not.toMatch(/NaN|Infinity/u);
    const zero = renderMindMapSvg({
      ...input,
      nodes: [{ ...input.nodes[0], x: -0, y: -0 }],
      edges: [],
    });
    expect(zero).not.toContain('="-0"');
  });

  it.each([
    { nodes: [] },
    { nodes: [{ ...fixture().nodes[0], width: 0.5 }] },
    { nodes: [{ ...fixture().nodes[0], text: '\ud800' }] },
    { nodes: [{ ...fixture().nodes[0], text: '\uffff' }] },
    { edges: [{ ...fixture().edges[0], toNode: 'missing' }] },
    { rawXml: '<svg/>' },
  ])('rejects invalid SVG graph %#', (change) => {
    expect(() => renderMindMapSvg({ ...fixture(), ...change })).toThrow();
  });
});
