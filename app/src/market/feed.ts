/**
 * The feed.
 *
 * One socket, two streams, no key: Binance publishes both the tape and the top
 * of the book on an anonymous websocket, which is the only reason this piece
 * can be a static page on GitHub Pages and still be *live*.
 *
 *   btcusdt@aggTrade        every fill, aggregated per taker order
 *   btcusdt@depth20@100ms   the twenty best bids and asks, ten times a second
 *
 * The two say different things and the piece needs both. The tape is what
 * *happened* — it is the animals. The book is what is *waiting* — it is the
 * whale, and the whole point of §2 of the plan is that the thing waiting has a
 * mass you can see before it ever moves.
 *
 * Everything below the parse is in the base currency (BTC), never in dollars:
 * a 5 BTC print is the same animal at $30k and at $300k, and every threshold
 * in market/ocean.ts is written in BTC for that reason.
 */

/** A fill off the tape. `size` is BTC, `buy` is true when the taker lifted. */
export interface Trade {
  price: number;
  size: number;
  buy: boolean;
  /** Exchange timestamp, ms. Only used to measure the feed's own latency. */
  time: number;
}

/** One side of the book, coarse: twenty levels is enough to find a wall. */
export interface Level {
  price: number;
  size: number;
}

export interface Book {
  bids: Level[];
  asks: Level[];
  mid: number;
}

export type FeedState = 'connecting' | 'live' | 'reconnecting' | 'simulated';

export interface Feed {
  readonly state: () => FeedState;
  dispose: () => void;
}

interface Handlers {
  onTrade: (t: Trade) => void;
  onBook: (b: Book) => void;
  onState: (s: FeedState) => void;
}

const ENDPOINT =
  'wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade/btcusdt@depth20@100ms';

/*
 * How long a dead socket is allowed to stay dead before the simulator takes
 * over.
 *
 * Binance refuses connections from a number of jurisdictions and from most
 * datacentre ranges, so "the socket did not open" is a normal outcome here,
 * not an error — and a black screen with a reconnect spinner is not a piece of
 * art. Eight seconds is roughly three failed handshakes: long enough that a
 * merely slow network still gets the real tape, short enough that a viewer who
 * cannot reach Binance at all is looking at a living ocean before they have
 * decided the page is broken.
 */
const FALLBACK_AFTER = 8000;

export function createFeed(handlers: Handlers): Feed {
  let socket: WebSocket | null = null;
  let state: FeedState = 'connecting';
  let attempt = 0;
  let closed = false;
  let retryTimer = 0;
  let fallbackTimer = 0;
  let sim: { stop: () => void } | null = null;

  function setState(next: FeedState): void {
    if (state === next) return;
    state = next;
    handlers.onState(next);
  }

  function connect(): void {
    if (closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(ENDPOINT);
    } catch {
      // A blocked scheme throws synchronously rather than firing onerror.
      scheduleRetry();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      attempt = 0;
      // The real tape has arrived, so the stand-in stands down — but only on
      // *open*, never on "we are trying": the swap is visible and should
      // happen once, not once per handshake.
      sim?.stop();
      sim = null;
      setState('live');
    };

    ws.onmessage = (event) => {
      // The combined-stream envelope: { stream, data }.
      let frame: { stream?: string; data?: unknown };
      try {
        frame = JSON.parse(event.data as string);
      } catch {
        return;
      }
      if (!frame.stream || !frame.data) return;
      if (frame.stream.endsWith('@aggTrade')) {
        const d = frame.data as { p: string; q: string; m: boolean; T: number };
        const size = Number(d.q);
        if (!(size > 0)) return;
        handlers.onTrade({
          price: Number(d.p),
          size,
          // `m` is "the buyer was the maker", i.e. the *taker* sold into a bid.
          // The piece is about aggression, so the flag is inverted here once
          // and never thought about again.
          buy: !d.m,
          time: d.T,
        });
      } else if (frame.stream.includes('@depth')) {
        const d = frame.data as { bids: [string, string][]; asks: [string, string][] };
        if (!d.bids?.length || !d.asks?.length) return;
        const bids = d.bids.map(([p, q]) => ({ price: Number(p), size: Number(q) }));
        const asks = d.asks.map(([p, q]) => ({ price: Number(p), size: Number(q) }));
        handlers.onBook({ bids, asks, mid: (bids[0].price + asks[0].price) / 2 });
      }
    };

    ws.onerror = () => ws.close();
    ws.onclose = () => {
      if (closed || socket !== ws) return;
      socket = null;
      scheduleRetry();
    };
  }

  function scheduleRetry(): void {
    if (closed) return;
    setState(sim ? 'simulated' : 'reconnecting');
    // Exponential, capped at ten seconds. Binance's limit is five connections
    // per five minutes per address; hammering it is how a temporary refusal
    // becomes a permanent one.
    const wait = Math.min(10000, 500 * 2 ** attempt++);
    retryTimer = window.setTimeout(connect, wait);
    armFallback();
  }

  /**
   * The stand-in.
   *
   * It is not a demo mode and it is not decoration — it is the same ocean
   * driven by a different tide, and the plan (§7) is explicit that it must
   * never be prettier or calmer than the real one. So it draws its sizes from
   * the same heavy tail the real tape has: a great many prints under a
   * hundredth of a coin, a fish every few seconds, and a whale roughly once a
   * minute, arriving in clusters because real whales do.
   */
  function armFallback(): void {
    if (sim || fallbackTimer) return;
    fallbackTimer = window.setTimeout(() => {
      fallbackTimer = 0;
      if (closed || state === 'live') return;
      sim = startSimulator(handlers);
      setState('simulated');
    }, FALLBACK_AFTER);
  }

  connect();
  armFallback();

  return {
    state: () => state,
    dispose() {
      closed = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(fallbackTimer);
      sim?.stop();
      socket?.close();
    },
  };
}

/**
 * A synthetic tape and book, for when Binance is unreachable.
 *
 * The price is a random walk with a slow drift that reverses on its own, so the
 * book's walls migrate rather than sitting still; the sizes are a Pareto tail,
 * which is the one statistical fact about trade sizes that matters to this
 * piece — the picture is built entirely out of the difference between the tail
 * and the body.
 */
function startSimulator(handlers: Handlers): { stop: () => void } {
  let price = 96000 + Math.random() * 8000;
  let drift = 0;
  let clock = 0;
  let running = true;

  /** Pareto(alpha): the tail that puts one whale behind ten thousand krill. */
  function pareto(min: number, alpha: number): number {
    return min / Math.pow(Math.random(), 1 / alpha);
  }

  function tick(): void {
    if (!running) return;
    clock++;
    // The drift is itself a slow random walk, mean-reverting: this is what
    // makes the simulated ocean have *moods* — a minute of accumulation, then
    // a minute of distribution — instead of uniform noise.
    drift += (Math.random() - 0.5) * 0.03;
    drift *= 0.985;
    price = Math.max(1000, price * (1 + drift * 0.0002 + (Math.random() - 0.5) * 0.00012));

    // The tape: a burst of prints per 100ms frame, sizes off the tail.
    const prints = 1 + Math.floor(Math.random() * 6);
    for (let i = 0; i < prints; i++) {
      const size = Math.min(120, pareto(0.0008, 0.62));
      handlers.onTrade({
        price: price * (1 + (Math.random() - 0.5) * 0.00004),
        // The imbalance follows the drift, so a rising simulated market is a
        // cyan one — the same correspondence the real feed produces.
        buy: Math.random() < 0.5 + Math.max(-0.35, Math.min(0.35, drift * 6)),
        size,
        time: Date.now(),
      });
    }

    // The book, rebuilt each frame: a decaying ladder with one heavy level per
    // side that persists for tens of seconds. The persistence is the point —
    // a wall that flickered would never read as a body.
    const bids: Level[] = [];
    const asks: Level[] = [];
    const bidWallAt = 3 + ((clock / 240) | 0) % 9;
    const askWallAt = 4 + ((clock / 300) | 0) % 9;
    for (let i = 0; i < 20; i++) {
      const step = (i + 1) * price * 0.00008;
      const base = 0.4 + Math.random() * 1.6;
      bids.push({ price: price - step, size: base + (i === bidWallAt ? 30 + 45 * Math.abs(Math.sin(clock / 120)) : 0) });
      asks.push({ price: price + step, size: base + (i === askWallAt ? 30 + 45 * Math.abs(Math.cos(clock / 140)) : 0) });
    }
    handlers.onBook({ bids, asks, mid: price });
  }

  const timer = window.setInterval(tick, 100);
  tick();
  return {
    stop() {
      running = false;
      window.clearInterval(timer);
    },
  };
}
