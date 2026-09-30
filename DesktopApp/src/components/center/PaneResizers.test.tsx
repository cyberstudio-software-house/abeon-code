import { describe, it, expect, vi } from 'vitest';
import { createRef } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { SplitResizers } from './PaneResizers';
import { len, type LenRect } from '../../lib/drawerGeometry';
import { createLeaf, type PaneNode } from '../../lib/paneTree';

const frame: LenRect = { left: len(0), top: len(50, 28), width: len(100), height: len(50, -28) };

function renderInBox(layout: PaneNode, onResize: (splitId: string, sizes: number[]) => void) {
  const containerRef = createRef<HTMLDivElement>();
  const view = render(
    <div ref={containerRef}>
      <SplitResizers layout={layout} containerRef={containerRef} frame={frame} minPx={() => 10} onResize={onResize} />
    </div>,
  );
  containerRef.current!.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, toJSON: () => ({}),
  });
  return view;
}

describe('SplitResizers', () => {
  it('positions a vertical separator inside the frame', () => {
    const layout: PaneNode = { kind: 'split', id: 's', dir: 'row', sizes: [0.5, 0.5], children: [createLeaf('a', ['a'], 'a'), createLeaf('b', ['b'], 'b')] };
    const { container } = renderInBox(layout, vi.fn());
    const handle = container.querySelector('[role="separator"]') as HTMLElement;
    expect(handle.style.left).toBe('50%');
    expect(handle.style.top).toBe('calc(50% + 28px)');
    expect(handle.style.height).toBe('calc(50% - 28px)');
  });

  it('measures a horizontal drag against the frame width', () => {
    const onResize = vi.fn();
    const layout: PaneNode = { kind: 'split', id: 's', dir: 'row', sizes: [0.5, 0.5], children: [createLeaf('a', ['a'], 'a'), createLeaf('b', ['b'], 'b')] };
    const { container } = renderInBox(layout, onResize);
    fireEvent.mouseDown(container.querySelector('[role="separator"]')!, { clientX: 500, clientY: 600 });
    fireEvent.mouseMove(window, { clientX: 600, clientY: 600 });
    const [splitId, sizes] = onResize.mock.calls[onResize.mock.calls.length - 1];
    expect(splitId).toBe('s');
    expect(sizes[0]).toBeCloseTo(0.6);
  });

  it('measures a vertical drag against the frame height in pixels', () => {
    const onResize = vi.fn();
    const layout: PaneNode = { kind: 'split', id: 's', dir: 'col', sizes: [0.5, 0.5], children: [createLeaf('a', ['a'], 'a'), createLeaf('b', ['b'], 'b')] };
    const { container } = renderInBox(layout, onResize);
    fireEvent.mouseDown(container.querySelector('[role="separator"]')!, { clientX: 500, clientY: 600 });
    fireEvent.mouseMove(window, { clientX: 500, clientY: 637.2 });
    expect(onResize.mock.calls[onResize.mock.calls.length - 1][1][0]).toBeCloseTo(0.6);
  });
});
