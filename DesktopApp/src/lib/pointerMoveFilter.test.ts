import { describe, it, expect } from 'vitest';
import { createPointerMoveFilter } from './pointerMoveFilter';

const move = (screenX: number, screenY: number) => new MouseEvent('mousemove', { screenX, screenY });

describe('createPointerMoveFilter', () => {
  it('lets the first mouse move through', () => {
    const accepts = createPointerMoveFilter();
    expect(accepts(move(10, 20))).toBe(true);
  });

  it('rejects a mouse move at the same screen position as the previous one', () => {
    const accepts = createPointerMoveFilter();
    accepts(move(10, 20));
    expect(accepts(move(10, 20))).toBe(false);
    expect(accepts(move(10, 20))).toBe(false);
  });

  it('accepts a mouse move once either coordinate changes', () => {
    const accepts = createPointerMoveFilter();
    accepts(move(10, 20));
    expect(accepts(move(11, 20))).toBe(true);
    expect(accepts(move(11, 21))).toBe(true);
    expect(accepts(move(11, 21))).toBe(false);
  });

  it('accepts every other event type', () => {
    const accepts = createPointerMoveFilter();
    accepts(move(10, 20));
    expect(accepts(new WheelEvent('wheel', { screenX: 10, screenY: 20 }))).toBe(true);
    expect(accepts(new MouseEvent('mousedown', { screenX: 10, screenY: 20 }))).toBe(true);
    expect(accepts(new KeyboardEvent('keydown', { key: 'a' }))).toBe(true);
    expect(accepts(new Event('focus'))).toBe(true);
  });
});
