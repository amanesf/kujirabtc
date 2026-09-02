/**
 * The frame, and the one decision the whole piece rests on:
 *
 *   the vertical axis is price.
 *
 * Not depth, not time — price. A bid wall sits at the height of its own limit
 * price, a print appears at the height it printed at, and when the market rises
 * the entire ocean sinks past the viewer. "Buying is strong" is not a number on
 * a meter; it is the water going down.
 *
 * This is also what makes the piece legible without destroying the scale
 * ambiguity that keeps it watchable (plan §1). The viewer never learns how many
 * metres across the whale is — there is deliberately no object of known size in
 * the frame — but they can read to the dollar where its body is sitting. The
 * physical scale stays unsolvable; the financial scale is exact.
 *
 * Portrait is the primary target, and the axis is why it is a gift rather than
 * a constraint: price gets the long edge of a phone, and the whale's body runs
 * off both short edges without ever being seen whole.
 */

/** World height of the frame. Everything else is derived from it. */
export const WORLD_HEIGHT = 20;

/**
 * How much price the frame spans, as a fraction of mid.
 *
 * 0.32% top to bottom. Fitted to the book, not chosen: depth20 on this pair
 * reaches about 0.1–0.2% from the touch in normal conditions, so at this span
 * both walls are comfortably inside the frame with room to move, and a level
 * that is *not* a wall is still far enough from mid to be visibly outside the
 * action. Widen it and the whales pin to the mid-line; narrow it and they leave
 * the picture every time the market twitches.
 */
const SPAN_FRACTION = 0.0032;

export interface Frame {
  /** Aspect-derived half-width, in world units. */
  halfWidth: number;
  /** World height, always WORLD_HEIGHT. */
  height: number;
  /** The price at the centre of the frame — a lagged mid (see follow()). */
  anchor: number;
  /** Price span from top to bottom of the frame. */
  span: number;
  /** Price -> world Y. */
  toY: (price: number) => number;
  /** World Y -> price, for the axis ticks. */
  toPrice: (y: number) => number;
  /** Price -> 0 at the top of the frame, 1 at the bottom (for the HUD). */
  toScreen: (price: number) => number;
  setAspect: (aspect: number) => void;
  /** Eases the anchor toward the mid. Call once per fixed step. */
  follow: (mid: number, dt: number) => void;
}

export function createFrame(): Frame {
  const frame: Frame = {
    halfWidth: WORLD_HEIGHT * 0.24,
    height: WORLD_HEIGHT,
    anchor: 0,
    span: 1,
    toY: (price) => ((price - frame.anchor) / frame.span) * WORLD_HEIGHT,
    toPrice: (y) => frame.anchor + (y / WORLD_HEIGHT) * frame.span,
    toScreen: (price) => 0.5 - (price - frame.anchor) / frame.span,
    setAspect(aspect) {
      frame.halfWidth = (WORLD_HEIGHT * aspect) / 2;
    },
    follow(mid, dt) {
      if (!(mid > 0)) return;
      frame.span = mid * SPAN_FRACTION;
      if (frame.anchor === 0) {
        frame.anchor = mid;
        return;
      }
      /*
       * The lag, and it is the whole feeling of the piece.
       *
       * A camera pinned exactly to mid would make the ocean perfectly still and
       * the walls would never move — the price axis would be doing no work at
       * all, because everything is measured against the thing it is chasing.
       * A camera that did not follow would let the market walk off the top of
       * the frame in a minute.
       *
       * So it follows with a six-second time constant. Fast enough that price
       * never escapes, slow enough that a real move is *felt*: the water sinks,
       * the whales slide, and the frame catches up afterwards. Six seconds is
       * about the length of a breath, which is not a coincidence — it is the
       * slowest lag that still reads as the same body of water.
       */
      frame.anchor += (mid - frame.anchor) * (1 - Math.exp(-dt / 6));
    },
  };
  return frame;
}
