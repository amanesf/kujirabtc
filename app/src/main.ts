import './style.css';
import * as THREE from 'three';
import { createStage, fieldResolution } from './core/renderer';
import { createFrame, WORLD_HEIGHT } from './core/frame';
import { createPostFx } from './core/postFx';
import { createObserver } from './core/observer';
import { createFluid } from './scene/fluid';
import { createField } from './scene/field';
import { createWhales } from './scene/whale';
import { createShoal } from './scene/shoal';
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
const shoal = createShoal();
const observer = createObserver();

scene.add(whales.mesh);
scene.add(field.points);
scene.add(shoal.mesh);

const postFx = createPostFx(stage.renderer, scene, stage.camera, stage.size.x, stage.size.y);
const ocean = createOcean();
const hud = createHud(document.querySelector<HTMLElement>('#hud')!, () => provoke());
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

/*
 * The touch.
 *
 * A finger on the glass does not select anything, open anything or navigate
 * anywhere — it disturbs the water. The krill are not pushed directly; the
 * *fluid* is (scene/fluid.ts), and they follow it, which is why the response
 * has weight to it: the water bulges away, curls at the edges of the bulge, and
 * is still settling several seconds after the finger has gone. Pushing the
 * particles would have given an instant, weightless, and much worse answer.
 *
 * It is deliberately gentle — a startle, not a blast. The first attempt used a
 * radial of 20 over a 1.6 second life and, dragged, stacked ten of those into a
 * pool of eight: the crop taken afterwards was *empty*, a clean hole swept
 * through the field. What was asked for was that they avoid the finger a
 * little, and "a little" turned out to be about a third of the strength and
 * half the duration. The one thing this must not do is compete with a whale.
 */
const touchWorld = new THREE.Vector3();
const touchDir = new THREE.Vector3();
let lastTouch = 0;

function disturb(clientX: number, clientY: number, strength: number): void {
  // Screen to the z = 0 plane, which is where the field is densest.
  touchWorld.set(
    (clientX / window.innerWidth) * 2 - 1,
    -((clientY / window.innerHeight) * 2 - 1),
    0.5,
  ).unproject(stage.camera);
  touchDir.copy(touchWorld).sub(stage.camera.position).normalize();
  if (Math.abs(touchDir.z) < 1e-4) return;
  const t = -stage.camera.position.z / touchDir.z;
  if (t <= 0) return;
  const x = stage.camera.position.x + touchDir.x * t;
  const y = stage.camera.position.y + touchDir.y * t;

  fluid.add({
    x, y,
    dx: 0,
    dy: 0,
    radius: 3.0,
    // A little swirl with it. A purely radial push makes a clean expanding
    // disc, which reads as a shockwave; the swirl makes it read as a hand.
    spin: 2.5,
    radial: 6.0 * strength,
    strength: 1,
    life: 1.0,
    span: 1.0,
  });
  shoal.scatter(x, y, 3.0, 2.2 * strength);
}

function onPointer(event: PointerEvent, strength: number): void {
  // The HUD's own controls keep their taps; everything else is water.
  if ((event.target as HTMLElement | null)?.closest('button')) return;
  const now = performance.now();
  // Dragging paints a continuous disturbance, but at pointer-move rates that
  // would be sixty impulses a second into a pool of eight.
  if (now - lastTouch < 100) return;
  lastTouch = now;
  disturb(event.clientX, event.clientY, strength);
}

window.addEventListener('pointerdown', (e) => onPointer(e, 1));
window.addEventListener('pointermove', (e) => {
  if (e.pressure > 0 || e.buttons > 0) onPointer(e, 0.45);
});

const ndc = new THREE.Vector3();
/** World Y -> fraction down the screen, for the HUD's price axis. */
function project(worldY: number): number {
  ndc.set(0, worldY, 0).project(stage.camera);
  return (1 - ndc.y) / 2;
}

/**
 * A whale print, which is a lunge, and the fluid gets a *negative* radial.
 *
 * This is the one place the piece departs from "big trade, big explosion", and
 * it is the better picture in both directions. Biologically a rorqual's lunge
 * is an inhalation: the krill are drawn into the pouch, not blown clear.
 * Financially a large aggressive order is a thing that *consumes* the book
 * rather than one that pushes it away. Both say inward, so the water goes
 * inward — and a hundred thousand bodies spiralling into a mouth is a sight
 * the outward version cannot buy.
 *
 * The spin is kept, so what is drawn in is drawn in turning.
 */
function lunge(x: number, y: number, side: number, power: number, leviathan: boolean): void {
  const at = whales.lungeAt();
  shoal.spawn(x, y, side, power);
  fluid.add({
    x: at.x, y: at.y,
    dx: Math.cos(0.58) * 9 * power,
    dy: 0,
    radius: 5.0 + power * 7.0,
    spin: side * 22 * power,
    radial: -34 * power,
    strength: 1,
    life: 7.0,
    span: 7.0,
  });
  postFx.shocks.push({ x: 0, y: 0, age: 0, power: (0.5 + power) * (leviathan ? 1.7 : 1) });
  const shock = postFx.shocks[postFx.shocks.length - 1];
  ndc.set(at.x, at.y, -6).project(stage.camera);
  shock.x = ndc.x * 0.5 * stage.aspect();
  shock.y = ndc.y * 0.5;
  observer.push(at.x, at.y, power * (leviathan ? 3.2 : 1.4));
  whales.state.flash = Math.min(1.6, whales.state.flash + 0.6 + power);
  // The rare tier is the one that brings it up out of the dark (plan §3).
  if (leviathan) whales.state.ascend = 1;
}

/*
 * The button under the whale in the legend (ui/hud.ts).
 *
 * A lunge is the only thing in this ocean that the market might simply decline
 * to do for minutes at a time, and it is where nearly everything the animal
 * can do is concentrated — the stroke deepens, the throat unfolds, the body
 * accelerates eightfold, the water turns inward. Waiting on a big print to see
 * any of that is the reason the animal reads as inert.
 *
 * The floor under mass is what makes the button honest rather than merely
 * present: below 0.03 the body is not drawn at all, so on a thin book the
 * lunge would happen to something invisible. It is a floor and not an
 * assignment — step() goes on easing mass toward whatever the book actually
 * says, and within a few seconds the animal is telling the truth again.
 */
function provoke(): void {
  const ws = whales.state;
  ws.mass = Math.max(ws.mass, 0.45);
  lunge(ws.cruise, ws.y, ws.warm > 0.5 ? 1 : -1, 0.8, false);
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
      lunge(x, y, imp.side, imp.power, imp.leviathan);
    } else {
      shoal.spawn(x, y, imp.side, imp.power);
      fluid.add({
        x, y,
        dx: imp.side * 15 * imp.power,
        dy: (Math.random() - 0.5) * 4,
        radius: 1.5 + imp.power * 2.0,
        spin: imp.side * 4 * imp.power,
        radial: 2 * imp.power,
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

  /*
   * The animal belongs to whichever side of the book is heavier — and it
   * *swims* to the new level when that changes rather than jumping to it.
   *
   * There were two of them and they stacked into one unreadable mass. One is
   * both the better composition and the better reading: a single body whose
   * colour says which side it is and whose height says at what price. Ten
   * seconds of travel turns what would be a discontinuity in the data into the
   * most legible motion in the piece — you see dominance change hands.
   */
  const dominant = state.askWhale.mass > state.bidWhale.mass ? state.askWhale : state.bidWhale;
  const wantWarm = dominant === state.askWhale ? 1 : 0;
  const wantY = dominant.price > 0
    ? frame.toY(dominant.price)
    : (wantWarm ? halfHeight * 0.7 : -halfHeight * 0.7);
  const ws = whales.state;
  ws.y += (wantY - ws.y) * (1 - Math.exp(-dt / 3.5));
  ws.warm += (wantWarm - ws.warm) * (1 - Math.exp(-dt / 6));
  ws.mass += (dominant.mass - ws.mass) * (1 - Math.exp(-dt / 2));
  ws.distance += (dominant.distance - ws.distance) * (1 - Math.exp(-dt / 4));
  whales.update(dt, simTime, stage.camera);

  /*
   * The lamp rides with the animal (core/observer.ts holds only the offset).
   *
   * The marine snow in the field is lit by the same source, so the glints that
   * appear in the water are always in the neighbourhood of the body — which
   * means the light in the frame and the thing worth looking at are never in
   * different places. It is one source doing two jobs and it is why the picture
   * has somewhere for the eye to go.
   */
  const lx = ws.cruise * 0.55 + observer.light.x;
  const ly = ws.y + observer.light.y;
  field.setLight(lx, ly, observer.light.w);
  whales.setLight(lx, ly, whales.depth() + observer.light.z, observer.light.w);

  fluid.update(dt, simTime, state.agitation);
  field.update(dt, simTime);
  shoal.update(dt, simTime);

  /*
   * The lenses, at the animals' own screen positions.
   *
   * Strength is mass, and the softening radius grows with it, so a big wall
   * bends a wide, gentle swathe of the picture and a small one makes a tight
   * knot — which is the right way round: a diffuse mass has a diffuse field.
   */
  postFx.lenses.length = 0;
  if (ws.mass >= 0.03) {
    ndc.set(ws.cruise * 0.4, ws.y, whales.depth()).project(stage.camera);
    postFx.lenses.push({
      x: ndc.x * 0.5 * stage.aspect(),
      y: ndc.y * 0.5,
      /*
       * 0.008, not 0.055.
       *
       * The softened 1/r term peaks near 1/core, so at a core radius of about a
       * fifth of the screen the multiplier on this number is roughly five —
       * which made the first version displace the picture by eight per cent of
       * its width and turned the frame into a fisheye. A lens you notice as a
       * lens has already failed; what it should do is make the field behind a
       * body *swim* slightly, and nothing more. The gape term adds to it during
       * a lunge, so the water visibly bends toward the mouth.
       */
      strength: ws.mass * 0.008 + ws.flash * 0.006 + ws.gape * 0.010,
      radius: 0.26 + ws.mass * 0.34,
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
    bidY: frame.toY(ocean.state.bidWhale.price),
    askY: frame.toY(ocean.state.askWhale.price),
  });
}
requestAnimationFrame(frameLoop);

window.addEventListener('pagehide', () => feed.dispose());
