import type { OceanState, LogEntry } from '../market/ocean';
import type { FeedState } from '../market/feed';
import { KRILL_MAX } from '../market/ocean';

/**
 * The instrument.
 *
 * The piece has to be legible as *Bitcoin* — which side is winning, how hard,
 * at what price — and the usual way that goes wrong is a dashboard bolted onto
 * an artwork, two things sharing a rectangle and ruining each other.
 *
 * The resolution is to make the readout diegetic: the frame is the window of a
 * submersible and this is its survey overlay. Hairlines, tick marks, monospaced
 * figures, and a leader line drawn out to the specimen it is annotating — the
 * grammar a nature documentary uses when it labels an animal. Read that way the
 * instrument does not fight the science fiction, it *is* the science fiction.
 *
 * It is built to be read at three depths of attention:
 *
 *   a glance     no text at all: which way the water is flowing, where the
 *                warm/cold boundary sits, how dense the field is
 *   a few seconds the price, the pressure bar, the rate
 *   reading      the annotated walls, and the tape
 *
 * Everything is on the vertical price axis, because in this ocean height *is*
 * price (core/frame.ts): a label at the height of a whale is quite literally
 * that whale's limit price.
 */

export interface Hud {
  update: (
    state: OceanState,
    log: LogEntry[],
    feed: FeedState,
    project: (worldY: number) => number,
    priceAt: (worldY: number) => number,
    whales: { bidY: number; askY: number },
  ) => void;
}

const money = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const axisMoney = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function coin(size: number): string {
  if (size >= 100) return size.toFixed(0);
  if (size >= 10) return size.toFixed(1);
  if (size >= 1) return size.toFixed(2);
  return size.toFixed(3);
}

export function createHud(root: HTMLElement): Hud {
  root.innerHTML = `
    <div class="hud">
      <header class="hud-top">
        <div class="pair">
          <span class="pair-sym">BTC<span class="slash">/</span>USDT</span>
          <span class="pair-venue">BINANCE · SPOT</span>
        </div>
        <div class="feed"><i class="dot"></i><span class="feed-label">接続中</span></div>
      </header>

      <div class="price">
        <span class="price-value">—</span>
        <span class="price-unit">USDT</span>
      </div>

      <div class="axis" aria-hidden="true"></div>

      <div class="specimen specimen-ask">
        <div class="specimen-line"></div>
        <div class="specimen-text">
          <span class="specimen-tag">ASK WALL</span>
          <span class="specimen-size">—</span>
          <span class="specimen-price">—</span>
        </div>
      </div>
      <div class="specimen specimen-bid">
        <div class="specimen-line"></div>
        <div class="specimen-text">
          <span class="specimen-tag">BID WALL</span>
          <span class="specimen-size">—</span>
          <span class="specimen-price">—</span>
        </div>
      </div>

      <div class="gauge">
        <div class="gauge-rail"><div class="gauge-fill"></div><div class="gauge-mid"></div></div>
        <div class="gauge-caps"><span class="cap-buy">買</span><span class="cap-sell">売</span></div>
      </div>

      <footer class="hud-bottom">
        <div class="stats">
          <span class="stat"><b class="rate">0.0</b> 約定/秒</span>
          <span class="stat"><b class="spread">—</b> スプレッド</span>
        </div>
        <ul class="tape"></ul>
      </footer>

      <div class="legend" data-open="1">
        <p class="legend-title">この海の読み方</p>
        <ul>
          <li><i class="sw sw-krill"></i>オキアミ<em>&lt; ${KRILL_MAX} BTC</em><span>水そのもの。流れが強いところだけ光る</span></li>
          <li><i class="sw sw-fish"></i>魚<em>${KRILL_MAX} – <b class="w-line">2.0</b> BTC</em><span>横切る。残していく航跡が本体</span></li>
          <li><i class="sw sw-whale"></i>クジラ<em>&gt; <b class="w-line">2.0</b> BTC</em><span>深部の巨体。指値の厚みそのもの</span></li>
        </ul>
        <p class="legend-axis">縦軸は<b>価格</b>。買いが強ければ海が沈む。</p>
        <p class="legend-hint">画面をタップで再表示</p>
      </div>
    </div>
  `;

  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const priceValue = q<HTMLElement>('.price-value');
  const axis = q<HTMLElement>('.axis');
  const dot = q<HTMLElement>('.dot');
  const feedLabel = q<HTMLElement>('.feed-label');
  const gaugeFill = q<HTMLElement>('.gauge-fill');
  const rate = q<HTMLElement>('.rate');
  const spread = q<HTMLElement>('.spread');
  const tape = q<HTMLUListElement>('.tape');
  const legend = q<HTMLElement>('.legend');
  const whaleLines = Array.from(root.querySelectorAll<HTMLElement>('.w-line'));

  const specimens = {
    bid: {
      el: q<HTMLElement>('.specimen-bid'),
      size: q<HTMLElement>('.specimen-bid .specimen-size'),
      price: q<HTMLElement>('.specimen-bid .specimen-price'),
    },
    ask: {
      el: q<HTMLElement>('.specimen-ask'),
      size: q<HTMLElement>('.specimen-ask .specimen-size'),
      price: q<HTMLElement>('.specimen-ask .specimen-price'),
    },
  };

  /*
   * The legend is not optional furniture. A mapping only the author knows is
   * not legibility, and the whole point of §2 is that a viewer should be able
   * to *learn* to read the water. It is shown for twenty seconds, which is
   * about how long it takes to read, and then it gets out of the way — and a
   * tap anywhere brings it back, because on a phone there is no hover.
   */
  let legendTimer = window.setTimeout(() => legend.setAttribute('data-open', '0'), 20000);
  document.addEventListener('pointerdown', () => {
    window.clearTimeout(legendTimer);
    const open = legend.getAttribute('data-open') === '1';
    legend.setAttribute('data-open', open ? '0' : '1');
    if (!open) legendTimer = window.setTimeout(() => legend.setAttribute('data-open', '0'), 20000);
  });

  const feedText: Record<FeedState, string> = {
    connecting: '接続中',
    live: 'ライブ',
    reconnecting: '再接続',
    simulated: '模擬潮流',
  };

  let lastPrice = 0;
  let lastTapeAt = 0;
  const axisCells: HTMLElement[] = [];
  for (let i = 0; i < 5; i++) {
    const cell = document.createElement('div');
    cell.className = 'tick';
    cell.innerHTML = '<i></i><span></span>';
    axis.appendChild(cell);
    axisCells.push(cell);
  }

  return {
    update(state, log, feed, project, priceAt, whales) {
      dot.dataset.state = feed;
      feedLabel.textContent = feedText[feed];

      if (state.price > 0) {
        priceValue.textContent = money.format(state.price);
        // The direction is carried by colour for a second and a half. It is the
        // only element on screen allowed to change fast, and it earns that by
        // being the one number a viewer looks for first.
        if (state.price !== lastPrice) {
          priceValue.dataset.dir = state.price > lastPrice ? 'up' : 'down';
          lastPrice = state.price;
        }
      }
      // The whale line is a live quantity, so it is shown as one. It also tells
      // the viewer something a fixed threshold cannot: what large means today.
      for (const el of whaleLines) el.textContent = coin(state.whaleAt);
      spread.textContent = state.spread > 0 ? state.spread.toFixed(2) : '—';
      rate.textContent = state.rate.toFixed(1);

      /*
       * The price axis: five ticks at the heights they actually occupy.
       *
       * This is what converts the ocean from a mood into an instrument. Without
       * it "the water is sinking" is an impression; with it, it is a number of
       * dollars, and the viewer can check.
       */
      for (let i = 0; i < axisCells.length; i++) {
        const worldY = 8 - i * 4;
        const top = project(worldY);
        const cell = axisCells[i];
        cell.style.top = `${top * 100}%`;
        const p = priceAt(worldY);
        cell.querySelector('span')!.textContent = p > 0 ? axisMoney.format(p) : '';
      }

      // The specimen labels ride on their animals.
      for (const [key, whale] of [
        ['bid', { y: whales.bidY, w: state.bidWhale }],
        ['ask', { y: whales.askY, w: state.askWhale }],
      ] as const) {
        const s = specimens[key];
        const top = project(whale.y);
        // Hidden when the wall is small or the body has left the frame: an
        // annotation pointing off screen is worse than no annotation.
        const show = whale.w.mass > 0.16 && top > 0.06 && top < 0.94;
        s.el.dataset.show = show ? '1' : '0';
        s.el.style.top = `${top * 100}%`;
        s.size.textContent = `${coin(whale.w.size)} BTC`;
        s.price.textContent = whale.w.price > 0 ? axisMoney.format(whale.w.price) : '—';
      }

      // The pressure bar grows from the centre, so balance is a bar of zero
      // length rather than a bar at the halfway mark — the difference matters,
      // because "no pressure" should look like nothing, not like something.
      const p = Math.max(-1, Math.min(1, state.pressure));
      gaugeFill.style.height = `${Math.abs(p) * 50}%`;
      gaugeFill.style.top = p > 0 ? `${50 - Math.abs(p) * 50}%` : '50%';
      gaugeFill.dataset.side = p >= 0 ? 'buy' : 'sell';

      // The tape, rebuilt only when something new has landed on it.
      if (log.length && log[0].at !== lastTapeAt) {
        lastTapeAt = log[0].at;
        tape.innerHTML = log
          .slice(0, 4)
          .map(
            (e) =>
              `<li data-kind="${e.kind}" data-side="${e.buy ? 'buy' : 'sell'}">` +
              `<i></i><b>${coin(e.size)}</b><span>BTC</span>` +
              `<em>${axisMoney.format(e.price)}</em></li>`,
          )
          .join('');
      }
    },
  };
}
