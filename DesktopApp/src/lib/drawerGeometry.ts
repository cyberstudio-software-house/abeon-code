import { computePaneRects, type PaneRect } from './paneGeometry';
import type { PaneNode } from './paneTree';

export const DRAWER_HEADER_HEIGHT = 28;
export const DRAWER_DEFAULT_SIZE = 0.35;
export const DRAWER_MIN_SIZE = 0.2;
export const DRAWER_MAX_SIZE = 0.8;
export const DRAWER_MIN_SESSION_HEIGHT = 120;
export const DRAWER_MIN_BODY_HEIGHT = 120;
export const DRAWER_MIN_SPLIT_WIDTH = 160;
export const DRAWER_MIN_SPLIT_HEIGHT = 90;

export type Len = { pct: number; px: number };
export type LenRect = { left: Len; top: Len; width: Len; height: Len };
export type Direction = 'left' | 'right' | 'up' | 'down';

export const len = (pct: number, px = 0): Len => ({ pct, px });
export const addLen = (a: Len, b: Len): Len => ({ pct: a.pct + b.pct, px: a.px + b.px });
export const scaleLen = (a: Len, k: number): Len => ({ pct: a.pct * k, px: a.px * k });
export const resolveLen = (a: Len, totalPx: number): number => (a.pct / 100) * totalPx + a.px;

const round = (v: number) => Number(v.toFixed(4)) + 0;

export function cssLen(a: Len): string {
  const pct = round(a.pct);
  const px = round(a.px);
  if (px === 0) return `${pct}%`;
  return px > 0 ? `calc(${pct}% + ${px}px)` : `calc(${pct}% - ${-px}px)`;
}

export function lenRectStyle(r: LenRect) {
  return { left: cssLen(r.left), top: cssLen(r.top), width: cssLen(r.width), height: cssLen(r.height) };
}

export function paneContentRect(pane: PaneRect, barHeight: number): LenRect {
  return {
    left: len(pane.left),
    top: len(pane.top, barHeight),
    width: len(pane.width),
    height: len(pane.height, -barHeight),
  };
}

export function withinRect(frame: LenRect, r: PaneRect): LenRect {
  return {
    left: addLen(frame.left, scaleLen(frame.width, r.left / 100)),
    top: addLen(frame.top, scaleLen(frame.height, r.top / 100)),
    width: scaleLen(frame.width, r.width / 100),
    height: scaleLen(frame.height, r.height / 100),
  };
}

export type DrawerLayoutRects = {
  content: LenRect;
  session: LenRect;
  header: LenRect;
  body: LenRect;
  terminals: Map<string, LenRect>;
};

export function computeDrawerLayout(pane: PaneRect, barHeight: number, size: number, layout: PaneNode): DrawerLayoutRects {
  const content = paneContentRect(pane, barHeight);
  const sessionHeight = scaleLen(content.height, 1 - size);
  const drawerTop = addLen(content.top, sessionHeight);
  const header: LenRect = {
    left: content.left,
    top: drawerTop,
    width: content.width,
    height: len(0, DRAWER_HEADER_HEIGHT),
  };
  const body: LenRect = {
    left: content.left,
    top: addLen(drawerTop, len(0, DRAWER_HEADER_HEIGHT)),
    width: content.width,
    height: addLen(scaleLen(content.height, size), len(0, -DRAWER_HEADER_HEIGHT)),
  };
  const terminals = new Map<string, LenRect>();
  for (const [id, rect] of computePaneRects(layout)) terminals.set(id, withinRect(body, rect));
  return { content, session: { ...content, height: sessionHeight }, header, body, terminals };
}

export type CollapsedDrawerRects = { session: LenRect; bar: LenRect };

export function computeCollapsedDrawerLayout(content: LenRect): CollapsedDrawerRects {
  const sessionHeight = addLen(content.height, len(0, -DRAWER_HEADER_HEIGHT));
  return {
    session: { ...content, height: sessionHeight },
    bar: {
      left: content.left,
      top: addLen(content.top, sessionHeight),
      width: content.width,
      height: len(0, DRAWER_HEADER_HEIGHT),
    },
  };
}

export function clampDrawerSize(next: number, contentPx: number): number {
  if (!Number.isFinite(next)) return DRAWER_DEFAULT_SIZE;
  const globalClamp = Math.min(DRAWER_MAX_SIZE, Math.max(DRAWER_MIN_SIZE, next));
  if (!(contentPx > 0)) return globalClamp;
  const min = Math.max(DRAWER_MIN_SIZE, (DRAWER_MIN_BODY_HEIGHT + DRAWER_HEADER_HEIGHT) / contentPx);
  const max = Math.min(DRAWER_MAX_SIZE, 1 - DRAWER_MIN_SESSION_HEIGHT / contentPx);
  if (min > max) return globalClamp;
  return Math.min(max, Math.max(min, next));
}

const EDGE_EPSILON = 1e-6;

export function neighborInDirection(layout: PaneNode, fromId: string, dir: Direction): string | null {
  const rects = computePaneRects(layout);
  const from = rects.get(fromId);
  if (!from) return null;
  const horizontal = dir === 'left' || dir === 'right';
  let best: { id: string; overlap: number } | null = null;
  for (const [id, r] of rects) {
    if (id === fromId) continue;
    const gap =
      dir === 'left' ? from.left - (r.left + r.width)
      : dir === 'right' ? r.left - (from.left + from.width)
      : dir === 'up' ? from.top - (r.top + r.height)
      : r.top - (from.top + from.height);
    if (Math.abs(gap) > EDGE_EPSILON) continue;
    const overlap = horizontal
      ? Math.min(from.top + from.height, r.top + r.height) - Math.max(from.top, r.top)
      : Math.min(from.left + from.width, r.left + r.width) - Math.max(from.left, r.left);
    if (overlap <= EDGE_EPSILON) continue;
    if (!best || overlap > best.overlap) best = { id, overlap };
  }
  return best?.id ?? null;
}
