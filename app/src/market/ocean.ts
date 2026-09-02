import type { Book, Trade } from './feed';

/**
 * The ecosystem model: the one place where a number off the wire becomes an
 * animal.
 *
 * Nothing downstream of this file knows what a trade is. scene/ carries no
 * thresholds, no currency and no exchange semantics — it is given a pressure,
 * two masses and a queue of impulses, and it moves water. That separation is
 * what lets the whole picture be re-fitted by editing constants here.
 *
 * The three thresholds (plan §2) are in BTC and are not arbitrary:
 *
 *   < 0.10 BTC   krill   ~85% of prints on this pair. Retail and small bots.
 *   krill..W     fish    the algorithmic middle: sliced parent orders.
 *   >= W         whale   a print that moves the book by itself.
 *
 * The krill line is fixed. The whale line W is not, and the reason is worth
 * setting down because it is the difference between a piece that performs and
 * one that sits there.
 *
 * A fixed 5 BTC is the honest textbook answer and it is the wrong one. On this
 * pair a print that size lands somewhere between two and ten minutes apart on
 * average — and "on average" is the trap, because those prints arrive in
 * clusters: six inside a minute at the New York open and then nothing for
 * twenty at four in the morning. A viewer who opens this at four in the morning
 * sees an ocean in which the largest event never happens.
 *
 * So W is a *controller*, not a constant. It is moved slowly until whales are
 * arriving at about one a minute, whatever the market is doing — around 1.5–2
 * BTC in normal conditions, tens of BTC in a panic, and it says so on screen.
 * Nothing about the legibility is lost by this: the readout is still the true
 * size in BTC, and the moving line tells you something a fixed one cannot,
 * which is *what counts as large in this market right now*.
 */
export const KRILL_MAX = 0.1;

/** The event we are pacing to, in whales per minute. */
const TARGET_PER_MINUTE = 1.0;
/** W never leaves this range, whatever the controller wants. */
const WHALE_FLOOR = 0.8;
const WHALE_CEILING = 40;

export interface Impulse {
  /** Horizontal placement, -1..1 across the frame. */
  x: number;
  /** The price it printed at. The scene turns this into a height, because in
   * this ocean height *is* price (core/frame.ts) — so a sweep through the book
   * draws a diagonal and a print at the offer appears above one at the bid,
   * without anything downstream having to know why. */
  price: number;
  /** Signed: +1 a lift, -1 a hit. Drives hue and the direction of the jet. */
  side: number;
  /** 0..1, already compressed — the scene multiplies, it does not judge. */
  power: number;
  /** BTC, for the log. */
  size: number;
  /** True for a whale — the scene reads this rather than re-deriving it. */
  whale: boolean;
  /** True for the rare monster: many times the current line (plan §3). */
  leviathan: boolean;
}

/** A wall: the standing bid or offer the piece draws as a body. */
export interface Whale {
  /** 0..1 mass, relative to what this market has recently considered large. */
  mass: number;
  /** Normalised distance from mid, 0 at the touch, 1 at the edge of the book. */
  distance: number;
  /** BTC at that level, for the log. */
  size: number;
  /** The level's own price. */
  price: number;
}

export interface OceanState {
  /** -1 all sellers, +1 all buyers. Slow: this is the colour of the water. */
  pressure: number;
  /** 0..1 activity, drives the density and speed of the drift. */
  agitation: number;
  bidWhale: Whale;
  askWhale: Whale;
  price: number;
  spread: number;
  /** Prints per second, smoothed. */
  rate: number;
  /** The live whale line, in BTC. Shown in the legend. */
  whaleAt: number;
  /** Whales per minute, smoothed — what the controller is steering. */
  whaleRate: number;
}

export interface Ocean {
  onTrade: (t: Trade) => void;
  onBook: (b: Book) => void;
  /** Advances the smoothers. Called once per fixed simulation step. */
  step: (dt: number) => void;
  readonly state: OceanState;
  /** Impulses accumulated since the last call. The caller drains this. */
  drain: () => Impulse[];
  /** The tape, newest first, capped — the HUD's scrolling log. */
  readonly log: LogEntry[];
}

export interface LogEntry {
  size: number;
  price: number;
  buy: boolean;
  kind: 'fish' | 'whale';
  at: number;
}

/*
 * Time constants, in seconds, and every one of them is a statement about the
 * piece rather than about the data.
 *
 * The pressure is slow (12s) because it is the colour of the water and water
 * does not change colour in a second. The agitation is quick (1.5s) because it
 * is the weather. The walls are slower still (4s) because a body that jittered
 * with every book frame would read as a swarm, not as a mass — and the whole
 * concept rests on the deep being *still*.
 */
const PRESSURE_TAU = 12;
const AGITATION_TAU = 1.5;
const WALL_TAU = 4;
const REFERENCE_TAU = 90;

export function createOcean(): Ocean {
  const state: OceanState = {
    pressure: 0,
    agitation: 0,
    bidWhale: { mass: 0, distance: 0.5, size: 0, price: 0 },
    askWhale: { mass: 0, distance: 0.5, size: 0, price: 0 },
    price: 0,
    spread: 0,
    rate: 0,
    whaleAt: 2.0,
    whaleRate: 0,
  };

  const log: LogEntry[] = [];
  let impulses: Impulse[] = [];

  // Accumulators, drained by step(): the socket and the frame clock run at
  // different rates, so nothing is smoothed on arrival.
  let signedVolume = 0;
  let totalVolume = 0;
  let prints = 0;
  let pressureRaw = 0;
  let agitationRaw = 0;
  let whaleCount = 0;

  /*
   * The adaptive scale.
   *
   * "Large" is not a constant. A quiet Sunday's biggest wall is forty coins and
   * a Wednesday's is four hundred, and a piece with a fixed denominator is
   * either black on the Sunday or saturated on the Wednesday. So the reference
   * is a slow high-water mark of what this market has recently shown: it rises
   * immediately to a new maximum and decays over about ninety seconds toward
   * what is presently there.
   *
   * The floor exists because at four in the morning the reference would
   * otherwise decay to nothing and a two-coin bid would become a leviathan.
   */
  let wallReference = 25;
  let tradeReference = 8;

  function push(kind: 'fish' | 'whale', t: Trade): void {
    log.unshift({ size: t.size, price: t.price, buy: t.buy, kind, at: performance.now() });
    if (log.length > 24) log.length = 24;
  }

  return {
    state,
    log,

    onTrade(t) {
      prints++;
      totalVolume += t.size;
      signedVolume += t.buy ? t.size : -t.size;

      if (t.size < KRILL_MAX) return; // krill are the field, not an event

      tradeReference = Math.max(tradeReference * 0.9995, t.size, 4);

      /*
       * The compression.
       *
       * Trade sizes are Pareto — the largest print of an hour is a thousand
       * times the median — so anything linear here is a picture in which one
       * print of the hour is visible and the rest are black. The log puts a
       * ten-coin print at roughly half the power of a hundred-coin one, which
       * is how a trader reads them too.
       */
      const power = Math.min(1, Math.log1p(t.size) / Math.log1p(tradeReference));

      if (t.size >= state.whaleAt) {
        whaleCount++;
        /*
         * The rare tier.
         *
         * A piece whose largest event happens every minute has a vocabulary you
         * have finished in five (plan §3), so above six times the line there is
         * a second animal that most sittings will not contain — perhaps once an
         * hour, perhaps not at all. It is the same code path with the numbers
         * let off their leash, and it exists so that there is always something
         * left that you have not seen.
         */
        const leviathan = t.size >= state.whaleAt * 6;
        push('whale', t);
        // A whale arrives from the deep and from the side its aggression came
        // from; the scene reads `power` as both the radius of the shock and
        // the strength of the vortex that follows it.
        impulses.push({
          x: (Math.random() - 0.5) * 0.4,
          price: t.price,
          side: t.buy ? 1 : -1,
          power: leviathan ? Math.min(1.8, power * 1.7) : power,
          size: t.size,
          whale: true,
          leviathan,
        });
      } else {
        push('fish', t);
        // A fish enters from one edge and crosses. Which edge is the side it
        // took: buyers run with the current, sellers against it.
        impulses.push({
          x: t.buy ? -1.15 : 1.15,
          price: t.price,
          side: t.buy ? 1 : -1,
          power: power * 0.7,
          size: t.size,
          whale: false,
          leviathan: false,
        });
      }
    },

    onBook(b) {
      state.price = b.mid;
      state.spread = b.asks[0].price - b.bids[0].price;

      const span = Math.max(1e-9, Math.abs(b.bids[b.bids.length - 1].price - b.asks[b.asks.length - 1].price) / 2);

      // The heaviest level on each side, not the sum: the concept is a *body*,
      // a single thing sitting at a single price, and a sum of twenty ordinary
      // levels is not that. A level only counts as a wall if it is heavy
      // relative to its own side, which is what the `- mean` term does.
      function heaviest(levels: { price: number; size: number }[]): { price: number; size: number } {
        let best = levels[0];
        for (const l of levels) if (l.size > best.size) best = l;
        return best;
      }
      const bid = heaviest(b.bids);
      const ask = heaviest(b.asks);
      wallReference = Math.max(wallReference * 0.999, bid.size, ask.size, 10);

      const bidMass = Math.min(1, Math.log1p(bid.size) / Math.log1p(wallReference));
      const askMass = Math.min(1, Math.log1p(ask.size) / Math.log1p(wallReference));

      // The book arrives ten times a second and the mass is eased toward it
      // rather than assigned: this is where the deep gets its stillness.
      const k = 1 - Math.exp(-0.1 / WALL_TAU);
      state.bidWhale.mass += (bidMass - state.bidWhale.mass) * k;
      state.askWhale.mass += (askMass - state.askWhale.mass) * k;
      state.bidWhale.distance += (Math.min(1, (b.mid - bid.price) / span) - state.bidWhale.distance) * k;
      state.askWhale.distance += (Math.min(1, (ask.price - b.mid) / span) - state.askWhale.distance) * k;
      state.bidWhale.size = bid.size;
      state.askWhale.size = ask.size;
      state.bidWhale.price = bid.price;
      state.askWhale.price = ask.price;

      wallReference += (Math.max(bid.size, ask.size) - wallReference) * (1 - Math.exp(-0.1 / REFERENCE_TAU));
    },

    step(dt) {
      // The raw signals are ratios over the window that just elapsed; the
      // exponential below is the frame-rate-independent form of a lerp, so a
      // machine at 30fps and one at 60 settle at the same place at the same
      // wall-clock moment.
      if (totalVolume > 0) pressureRaw = signedVolume / totalVolume;
      agitationRaw = Math.min(1, Math.log1p(prints / Math.max(dt, 1e-3)) / Math.log1p(60));

      state.pressure += (pressureRaw - state.pressure) * (1 - Math.exp(-dt / PRESSURE_TAU));
      state.agitation += (agitationRaw - state.agitation) * (1 - Math.exp(-dt / AGITATION_TAU));
      state.rate += (prints / Math.max(dt, 1e-3) - state.rate) * (1 - Math.exp(-dt / AGITATION_TAU));

      /*
       * The controller.
       *
       * A slow integral term on the log of the threshold: measure whales per
       * minute over a two-and-a-half minute window, and move W multiplicatively
       * toward whatever produces one. The gain is small (0.006) on purpose —
       * at ten times this the line chases every burst and the size that counts
       * as a whale changes while you are watching it, which is worse than a
       * wrong constant. As set, it takes a couple of minutes to answer a change
       * of regime, which is about how long a change of regime takes.
       *
       * The clamp is the safety: in a flat hour the controller would happily
       * walk W down until a 0.1 BTC print was a leviathan, and a whale that is
       * not actually large is a lie the whole piece rests on not telling.
       */
      state.whaleRate += ((whaleCount / Math.max(dt, 1e-3)) * 60 - state.whaleRate)
        * (1 - Math.exp(-dt / 150));
      const error = state.whaleRate - TARGET_PER_MINUTE;
      state.whaleAt = Math.min(
        WHALE_CEILING,
        Math.max(WHALE_FLOOR, state.whaleAt * Math.exp(0.006 * dt * error)),
      );

      signedVolume = 0;
      totalVolume = 0;
      prints = 0;
      whaleCount = 0;
    },

    drain() {
      const out = impulses;
      impulses = [];
      return out;
    },
  };
}
