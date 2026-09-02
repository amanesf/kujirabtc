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
 *   < 5.00 BTC   fish    the algorithmic middle: sliced parent orders.
 *   >= 5.00 BTC  whale   a print that moves the book by itself.
 *
 * They are cut in *base* currency deliberately. A dollar threshold would drift
 * with the price and the picture would slowly stop meaning what it meant.
 */
export const KRILL_MAX = 0.1;
export const FISH_MAX = 5.0;

export interface Impulse {
  /** Where, in the -1..1 normalised frame the scene maps to world space. */
  x: number;
  y: number;
  /** Signed: +1 a lift, -1 a hit. Drives hue and the direction of the jet. */
  side: number;
  /** 0..1, already compressed — the scene multiplies, it does not judge. */
  power: number;
  /** BTC, for the log. */
  size: number;
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

      // Placed by *price* across the frame, not at random: a print at the
      // offer belongs above one at the bid, so a sweep through the book reads
      // as a diagonal rather than as confetti.
      const y = state.price > 0
        ? Math.max(-1, Math.min(1, ((t.price - state.price) / Math.max(state.price * 0.0006, 1e-9)) * 0.5))
        : 0;

      if (t.size >= FISH_MAX) {
        push('whale', t);
        // A whale arrives from the deep and from the side its aggression came
        // from; the scene reads `power` as both the radius of the shock and
        // the strength of the vortex that follows it.
        impulses.push({ x: (Math.random() - 0.5) * 0.4, y: y * 0.5, side: t.buy ? 1 : -1, power, size: t.size });
      } else {
        push('fish', t);
        // A fish enters from one edge and crosses. Which edge is the side it
        // took: buyers run with the current, sellers against it.
        impulses.push({ x: t.buy ? -1.15 : 1.15, y, side: t.buy ? 1 : -1, power: power * 0.7, size: t.size });
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

      signedVolume = 0;
      totalVolume = 0;
      prints = 0;
    },

    drain() {
      const out = impulses;
      impulses = [];
      return out;
    },
  };
}
