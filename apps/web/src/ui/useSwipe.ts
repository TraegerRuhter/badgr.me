import { useCallback, useRef, useState, type PointerEvent } from "react";

interface SwipeConfig {
  enabled: boolean;
  onSwipeRight: (() => void) | null;
  onSwipeLeft: (() => void) | null;
  /** Horizontal travel (px) past which release triggers the action. */
  threshold?: number;
}

interface SwipeState {
  /** Current horizontal translation to apply to the row. */
  offset: number;
  /** True while the pointer is down and committed to a horizontal drag. */
  dragging: boolean;
  /**
   * True (and self-clearing) right after a committed drag ends — the click
   * event the browser fires after that drag isn't a tap and must not
   * trigger tap actions like expanding the card.
   */
  didJustDrag: () => boolean;
  handlers: {
    onPointerDown: (e: PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: PointerEvent<HTMLElement>) => void;
  };
}

const DIRECTION_LOCK_PX = 10;
const MAX_PULL_PX = 128;

/**
 * Horizontal swipe recognition on a row, via pointer events so it works for
 * touch, pen, and mouse alike. The drag only commits once movement is
 * clearly horizontal (so vertical scrolling stays natural), never starts on
 * a button (so taps stay taps), and pulls with resistance past the
 * threshold. A disabled direction (null callback) barely moves at all.
 */
export function useSwipe({
  enabled,
  onSwipeRight,
  onSwipeLeft,
  threshold = 72,
}: SwipeConfig): SwipeState {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const committed = useRef(false);
  const justDragged = useRef(false);

  const reset = useCallback(() => {
    start.current = null;
    committed.current = false;
    setDragging(false);
    setOffset(0);
  }, []);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      if (!enabled) return;
      if (e.button !== 0) return;
      // Buttons on the row stay plain taps — swipes begin on the card body.
      if ((e.target as HTMLElement).closest("button")) return;
      start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
      committed.current = false;
    },
    [enabled]
  );

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const s = start.current;
      if (!s || e.pointerId !== s.id) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;

      if (!committed.current) {
        if (Math.abs(dx) < DIRECTION_LOCK_PX) return;
        if (Math.abs(dx) <= Math.abs(dy)) {
          // Vertical intent — hand the gesture back to the scroller.
          start.current = null;
          return;
        }
        committed.current = true;
        setDragging(true);
        e.currentTarget.setPointerCapture(e.pointerId);
      }

      // Resistance curve; a direction with no action stays nearly pinned.
      const actionable = dx > 0 ? onSwipeRight !== null : onSwipeLeft !== null;
      const give = actionable ? 1 : 0.15;
      const eased = Math.tanh(dx / MAX_PULL_PX) * MAX_PULL_PX * give;
      setOffset(eased);
    },
    [onSwipeRight, onSwipeLeft]
  );

  const onPointerUp = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const s = start.current;
      if (!s || e.pointerId !== s.id) return;
      if (committed.current) {
        justDragged.current = true;
        const dx = e.clientX - s.x;
        if (dx > threshold && onSwipeRight) onSwipeRight();
        else if (dx < -threshold && onSwipeLeft) onSwipeLeft();
      }
      reset();
    },
    [threshold, onSwipeRight, onSwipeLeft, reset]
  );

  const onPointerCancel = useCallback(() => reset(), [reset]);

  const didJustDrag = useCallback(() => {
    const was = justDragged.current;
    justDragged.current = false;
    return was;
  }, []);

  return {
    offset,
    dragging,
    didJustDrag,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}
