export function createPointerMoveFilter(): (event: Event) => boolean {
  let lastX: number | null = null;
  let lastY: number | null = null;
  return (event) => {
    if (event.type !== 'mousemove') return true;
    const { screenX, screenY } = event as MouseEvent;
    const repeated = screenX === lastX && screenY === lastY;
    lastX = screenX;
    lastY = screenY;
    return !repeated;
  };
}
