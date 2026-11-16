import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement } from 'react';
import { useElementHeight } from './useElementHeight';

const observers = vi.hoisted(() => [] as Array<() => void>);

vi.stubGlobal('ResizeObserver', class {
  callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
    observers.push(() => this.callback());
  }
  observe() {}
  unobserve() {}
  disconnect() {}
});

function Probe({ attached }: { attached: boolean }) {
  const [ref, height] = useElementHeight<HTMLDivElement>();
  return createElement(
    'div',
    null,
    attached ? createElement('div', { ref }) : null,
    createElement('span', { 'data-testid': 'height' }, String(height)),
  );
}

describe('useElementHeight', () => {
  beforeEach(() => {
    observers.length = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 180 } as DOMRect);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the element height after mount and 0 once it is removed', () => {
    const { getByTestId, rerender } = render(createElement(Probe, { attached: true }));
    expect(getByTestId('height').textContent).toBe('180');

    rerender(createElement(Probe, { attached: false }));
    expect(getByTestId('height').textContent).toBe('0');
  });

  it('follows resize observer notifications', () => {
    const { getByTestId } = render(createElement(Probe, { attached: true }));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 240 } as DOMRect);
    act(() => { observers.forEach(fire => fire()); });
    expect(getByTestId('height').textContent).toBe('240');
  });
});
