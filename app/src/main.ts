import './style.css';
import * as THREE from 'three';
import { createStage, fieldResolution } from './core/renderer';
import { createFrame, WORLD_HEIGHT } from './core/frame';
import { createPostFx } from './core/postFx';
import { createObserver } from './core/observer';
import { createFluid } from './scene/fluid';
import { createField } from './scene/field';
import { createWhales } from './scene/whale';
import { createStreaks } from './scene/streaks';
import { createFeed, type FeedState } from './market/feed';
import { createOcean } from './market/ocean';
import { createHud } from './ui/hud';

/**
 * 深海の静かなるクジラ — a live BTC/USDT tape, as an ocean.
 *
 * The whole piece in one paragraph: the vertical axis is price; standing limit
 * orders are bodies in the deep whose mass makes them nearer and darker rather
 * than brighter; every fill pushes a real fluid whose wake outlives it by
 * seconds; and the light comes almost entirely from water that is being
 * strained, so the picture is lit by the market doing something.
 *
 * This file only wires it. The one piece of judgement in it is the mapping from
 * a print to an impulse, which is the boundary the whole design turns on:
 * market/ knows nothing about water and scene/ knows nothing about Bitcoin.
 */

const host = document.querySelector<HTMLDivElement>('#stage')!;
const stage = createStage(host);
const scene = new THREE.Scene();

const frame = createFrame();
const fluid = createFluid(stage.renderer);
const field = createField(stage.renderer, fieldResolution(), fluid);
const whales = createWhales();
const streaks = createStreaks();
const observer = createObserver();

scene.add(whales.mesh);
scene.add(field.points);
scene.add(streaks.mesh);

const postFx = createPostFx(stage.renderer, scene, stage.camera, stage.size.x, stage.size.y);
const ocean = createOcean();
const hud = createHud(document.querySelector<HTMLElement>('#hud')!);
let feedState: FeedState = 'connecting';

const feed = createFeed({
  onTrade: (t) => ocean.onTrade(t),
  onBook: (b) => ocean.onBook(b),
  onState: (s) => {
    feedState = s;
  },
});

/** Half-height of the world frame; the width follows the phone's aspect. */
const halfHeight = WORLD_HEIGHT / 2;

function layout(): void {
  stage.resize();
  frame.setAspect(stage.aspect());
  postFx.setSize(stage.size.x, stage.size.y, stage.aspect());
  fluid.setExtent(frame.halfWidth, halfHeight);
  field.setExtent(frame.halfWidth, halfHeight);
  whales.fit(stage.camera);
}
layout();
window.addEventListener('resize', layout);
// iOS changes the viewport when the address bar retracts, and that fires
// orientationchange rather than resize on some versions.
window.addEventListener('orientationchange', () => window.setTimeout(layout, 250));

const ndc = new THREE.Vector3();
/** World Y -> fraction down the screen, for the HUD's price axis. */
function project(worldY: number): number {
  ndc.set(0, worldY, 0).project(stage.camera);
  return (1 - ndc.y) / 2;
}

/**
 * The impulse mapping: one print, one push.
 *
 * A fish gets a jet — a directed shove that opens a corridor. A whale gets a
 * jet *with a spin*, and the spin is what makes it an event rather than an
 * explosion: the radial part throws the krill outward in a fifth of a second,
 * the rotational part is still winding them into a vortex ten seconds later.
 * Alongside it go the two fast components — the ring in the post chain and the
 * flash on the animal's own flank — so a single trade is delivered at three
 * different speeds and reads as physics rather than as a cue (plan §7).
 */
function applyImpulses(): void {
  for (const imp of ocean.drain()) {
    const y = frame.toY(imp.price);
    const x = imp.x * frame.halfWidth;
    if (imp.whale) {
      streaks.spawn(x, y, imp.side, imp.power);
      fluid.add({
        x, y,
        dx: imp.side * 26 * imp.power,
        dy: 5 * imp.power,
        radius: 2.6 + imp.power * 4.5,
        // Buyers wind the water one way and sellers the other, so consecutive
        // prints on the same side compound into one large rotation instead of
        // cancelling — which is why a sweep looks like a sweep.
        spin: imp.side * 34 * imp.power,
        strength: 1,
        life: 6.5,
        span: 6.5,
      });
      postFx.shocks.push({ x: 0, y: 0, age: 0, power: (0.5 + imp.power) * (imp.leviathan ? 1.7 : 1) });
      const shock = postFx.shocks[postFx.shocks.length - 1];
      ndc.set(x, y, -6).project(stage.camera);
      shock.x = ndc.x * 0.5 * stage.aspect();
      shock.y = ndc.y * 0.5;
      observer.push(x, y, imp.power * (imp.leviathan ? 3.2 : 1.4));
      // A lift eats the offer, so it is the *ask* side that flinches.
      const hit = imp.side > 0 ? whales.ask : whales.bid;
      hit.flash = Math.min(1.6, hit.flash + 0.6 + imp.power);
    } else {
      streaks.spawn(x, y, imp.side, imp.power);
      fluid.add({
        x, y,
        dx: imp.side * 15 * imp.power,
        dy: (Math.random() - 0.5) * 4,
        radius: 1.5 + imp.power * 2.0,
        spin: imp.side * 4 * imp.power,
        strength: 1,
        life: 2.4,
        span: 2.4,
      });
    }
  }
  if (postFx.shocks.length > 8) postFx.shocks.splice(0, postFx.shocks.length - 8);
}

const STEP = 1 / 60;
let simTime = 0;
let carry = 0;
let last = performance.now();

function step(dt: number): void {
  simTime += dt;
  ocean.step(dt);
  const state = ocean.state;

  frame.follow(state.price, dt);
  applyImpulses();

  observer.update(dt, simTime, stage.camera);
  field.setLight(observer.light.x, observer.light.y, observer.light.w);
  whales.setLight(observer.light.x, observer.light.y, observer.light.z, observer.light.w);

  /*
   * The warm/cold boundary (plan §8).
   *
   * Pressure does not recolour the picture, it *moves the horizon between two
   * colours that are both always present*. Buyers push the cold half up and the
   * ember retreats to the top of the frame; sellers let it down over everything.
   * Eight world units of travel out of twenty means neither colour is ever
   * driven off screen, so the image cannot fall out of balance.
   */
  const boundary = state.pressure * 8;
  field.setBoundary(boundary);
  whales.setBoundary(boundary);

  // The bodies sit at their own limit prices. With no book yet they rest at the
  // edges of the frame, which is also where a market with no walls puts them.
  whales.bid.y = state.bidWhale.price > 0 ? frame.toY(state.bidWhale.price) : -halfHeight * 0.7;
  whales.ask.y = state.askWhale.price > 0 ? frame.toY(state.askWhale.price) : halfHeight * 0.7;
  whales.bid.mass = state.bidWhale.mass;
  whales.ask.mass = state.askWhale.mass;
  whales.bid.distance = state.bidWhale.distance;
  whales.ask.distance = state.askWhale.distance;
  // The flash is the fast end of the event: 150ms of it and then it is gone,
  // while the vortex it announced is still turning six seconds later.
  whales.bid.flash *= Math.exp(-dt / 0.15);
  whales.ask.flash *= Math.exp(-dt / 0.15);
  whales.update(simTime, stage.camera);

  fluid.update(dt, simTime, state.agitation);
  field.update(dt, simTime);
  streaks.update(dt);

  /*
   * The lenses, at the animals' own screen positions.
   *
   * Strength is mass, and the softening radius grows with it, so a big wall
   * bends a wide, gentle swathe of the picture and a small one makes a tight
   * knot — which is the right way round: a diffuse mass has a diffuse field.
   */
  postFx.lenses.length = 0;
  for (const w of [whales.bid, whales.ask]) {
    if (w.mass < 0.03) continue;
    ndc.set(0, w.y, -74 - w.distance * 52).project(stage.camera);
    postFx.lenses.push({
      x: ndc.x * 0.5 * stage.aspect(),
      y: ndc.y * 0.5,
      /*
       * 0.008, not 0.055.
       *
       * The softened 1/r term peaks near 1/core, so at a core radius of about
       * a fifth of the screen the multiplier on this number is roughly five —
       * which made the first version displace the picture by eight per cent of
       * its width and turned the frame into a fisheye. A lens you notice as a
       * lens has already failed; what it should do is make the field behind a
       * body *swim* slightly, and nothing more.
       */
      strength: w.mass * 0.008 + w.flash * 0.006,
      radius: 0.26 + w.mass * 0.34,
    });
  }
  for (let i = postFx.shocks.length - 1; i >= 0; i--) {
    postFx.shocks[i].age += dt;
    if (postFx.shocks[i].age > 1.0) postFx.shocks.splice(i, 1);
  }
  postFx.setTime(simTime);
}

/*
 * The warm-up.
 *
 * The fluid starts dead still and a still fluid is a blank screen: the ambient
 * stir needs a few seconds to build the eddies that the krill trace out. Six
 * seconds of simulation, run in slices between frames so the loader keeps
 * animating and the tab never freezes, and the picture is revealed on the frame
 * the last slice lands.
 */
const WARM_UP = 360;
let warmed = 0;

function frameLoop(now: number): void {
  requestAnimationFrame(frameLoop);

  if (warmed < WARM_UP) {
    const slice = Math.min(30, WARM_UP - warmed);
    for (let i = 0; i < slice; i++) step(STEP);
    warmed += slice;
    last = now;
    postFx.render();
    if (warmed >= WARM_UP) document.body.classList.add('ready');
    return;
  }

  const elapsed = Math.min(0.25, (now - last) / 1000);
  last = now;
  carry += elapsed;
  // Clamped at eight steps: a tab that has been in the background for a minute
  // resumes rather than trying to catch up, which would stall for a second.
  let steps = 0;
  while (carry >= STEP && steps < 8) {
    step(STEP);
    carry -= STEP;
    steps++;
  }
  if (steps === 8) carry = 0;

  postFx.render();
  hud.update(ocean.state, ocean.log, feedState, project, (y) => frame.toPrice(y), {
    bidY: whales.bid.y,
    askY: whales.ask.y,
  });
}
requestAnimationFrame(frameLoop);

window.addEventListener('pagehide', () => feed.dispose());
