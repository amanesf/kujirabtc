import './style.css';
import * as THREE from 'three';
import { createStage, fieldResolution } from './core/renderer';
import { createFrame, WORLD_HEIGHT } from './core/frame';
import { createPostFx } from './core/postFx';
import { createObserver } from './core/observer';
import { toNdc, toWater, waterScale } from './core/space';
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
 * A whale print, which is a *request* for a lunge.
 *
 * What used to be here fired everything on the frame the print landed — the
 * suction, the ring, the shove — with the mouth wherever the animal happened
 * to be standing, which was usually mid-track and sometimes off the side of
 * the frame. The animal now runs its own sequence (scene/whale.ts) and calls
 * back when the jaw actually opens, so the water is disturbed at the instant
 * and in the place where something is being eaten. Everything that belongs to
 * the *print* rather than to the animal — the school it displaces, the flash
 * on the flank, the rare ascent — still happens now.
 */
let pendingLeviathan = false;

function lunge(x: number, y: number, side: number, power: number, leviathan: boolean): void {
  shoal.spawn(x, y, side, power);
  whales.state.flash = Math.min(1.6, whales.state.flash + 0.6 + power);
  // The rare tier is the one that brings it up out of the dark (plan §3).
  if (leviathan) whales.state.ascend = 1;
  pendingLeviathan = pendingLeviathan || leviathan;
  whales.beginLunge(Math.min(1, power * (leviathan ? 1.35 : 1)));
}

/** Scratch, all of it reused every frame rather than allocated per event. */
const water = new THREE.Vector2();
const screen = new THREE.Vector2();
const mouthWhale = new THREE.Vector3();
const tailWhale = new THREE.Vector3();
const tailWater = new THREE.Vector2();
const bodyWater = new THREE.Vector2();

/**
 * How wide the mouth's reach is, in the water's own units.
 *
 * Taken from the animal rather than from the frame: two and a half girths,
 * carried into the water by the same perspective that carries the mouth's
 * position. So when the lunge brings the body thirty units closer the reach
 * grows with it — which is the whole point of coming closer, and a constant
 * fraction of the frame would have thrown it away.
 */
function mouthRadius(power: number): number {
  const r = whales.girth() * 2.5 * waterScale(whales.depth(), stage.camera);
  return Math.max(1.2, r * (0.85 + power * 0.35));
}

/*
 * The moment the jaws open — and the one conversion this file used to be
 * missing (core/space.ts).
 *
 * The mouth arrives in the animal's frame, seventy units back and up to
 * forty-five units off the centre line. The fluid's domain is nine and a half
 * units across. Handing one to the other, which is what this did, put every
 * lunge's suction ten domain widths outside the water — where the forcing
 * gaussian is exactly zero — so the drama of the event never touched a single
 * krill. It is converted here, once, into the point in the water that appears
 * at the same place on the glass, and everything downstream takes that.
 *
 * The radial is negative and that is the whole idea: a rorqual's lunge is an
 * inhalation and a large aggressive order *consumes* the book rather than
 * pushing it away. Both say inward, and a hundred thousand bodies spiralling
 * into a mouth is a sight the outward version cannot buy. The spin is kept, so
 * what is drawn in is drawn in turning.
 */
whales.setOnEngulf((mouth, power) => {
  const leviathan = pendingLeviathan;
  pendingLeviathan = false;
  const depth = whales.depth();
  toWater(mouth.x, mouth.y, depth, stage.camera, water);
  toWater(whales.state.cruise, whales.state.y, depth, stage.camera, bodyWater);

  // Along the animal's own heading, as the screen sees it: the pouch is being
  // driven forward through the water even as the mouth pulls it in.
  const hx = water.x - bodyWater.x;
  const hy = water.y - bodyWater.y;
  const h = Math.hypot(hx, hy) || 1;
  const radius = mouthRadius(power);

  fluid.add({
    x: water.x, y: water.y,
    dx: (hx / h) * 5.0 * power,
    dy: (hy / h) * 5.0 * power,
    radius,
    spin: (hx > 0 ? 1 : -1) * 9 * power,
    radial: -16 * power,
    strength: 1,
    life: 7.0,
    span: 7.0,
  });

  // The ring, projected at the body's *actual* depth. At z = -6 it came out
  // at an NDC x of nearly eight — far off frame, where a front this wide sat
  // along the border and coloured it (effects/abyss.ts).
  toNdc(mouth.x, mouth.y, depth, stage.camera, screen);
  postFx.shocks.push({
    x: screen.x * 0.5 * stage.aspect(),
    y: screen.y * 0.5,
    age: 0,
    power: (0.5 + power) * (leviathan ? 1.7 : 1),
  });

  observer.push(water.x, water.y, power * (leviathan ? 3.2 : 1.4));
  // And the school that was in the wrong place at the wrong time.
  shoal.consume(water.x, water.y, radius * 0.75);
});

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

/** The slow whole-frame lever (see step()). Starts where a quiet market sits. */
let exposure = 0.9;

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
   * The lamp rides with the animal (core/observer.ts holds only the offset) —
   * and there is now exactly one of it.
   *
   * There were two. The same number, `cruise * 0.55`, was handed to the water
   * and to the whale, which live at depths where the frame is 9.5 and 31 units
   * across respectively: one number cannot be the same place in both, so the
   * light on the water and the light on the animal were simply two different
   * lights that happened to pulse together. §5's claim that one source does two
   * jobs was false in the implementation.
   *
   * The lamp has a position — in the animal's space, because that is the thing
   * it is exploring — and the water is told where that position *appears*.
   * Now the glints in the field really are around the body, and the picture has
   * one place for the eye to go instead of two.
   */
  const depth = whales.depth();
  const lampX = ws.cruise + observer.light.x;
  const lampY = ws.y + observer.light.y;
  const lampZ = depth + observer.light.z;
  whales.setLight(lampX, lampY, lampZ, observer.light.w);
  toWater(lampX, lampY, lampZ, stage.camera, water);
  field.setLight(water.x, water.y, observer.light.w);

  /*
   * The mouth, in the water.
   *
   * Two things read it: the krill go dark inside it (they are behind a closing
   * jaw, in the only unlit volume in the picture) and the fish are pulled out
   * of the way of the body ahead of it. Before this the animal and the school
   * swam through each other with no acquaintance at all, which is a strange
   * thing to allow in an ocean whose entire subject is one eating the other.
   */
  whales.mouth(mouthWhale);
  toWater(mouthWhale.x, mouthWhale.y, depth, stage.camera, water);
  const gapeR = mouthRadius(0.8);
  field.setMouth(water.x, water.y, gapeR * 0.8, ws.gape);
  if (ws.gape > 0.35) shoal.consume(water.x, water.y, gapeR * 0.55 * ws.gape);
  // A steady, gentle avoidance of the body itself — a startle, scaled by the
  // step so it is a rate rather than a kick, and small enough that it never
  // competes with the lunge that follows it.
  toWater(ws.cruise, ws.y, depth, stage.camera, bodyWater);
  if (ws.mass >= 0.03) {
    shoal.scatter(bodyWater.x, bodyWater.y, frame.halfWidth * 0.9, 34 * ws.mass * dt);
  }

  /*
   * The animal in the water, at last.
   *
   * Every impulse in this piece was an event — a print lands, the field is
   * hit, the hit fades — and nothing at all was driven by the plain fact that
   * a body longer than the frame is crossing it. So the whale swam and the
   * krill were unaware of it, which is exactly what "the whale and the water
   * do not fit together" looks like from the outside.
   *
   * Two standing forcings (scene/fluid.ts), both taken from the animal's own
   * geometry rather than from numbers chosen here:
   *
   *   the head   pushes forward along the heading, hard when it is charging.
   *              The krill part ahead of it.
   *   the flukes push *sideways, alternating with the stroke*. The field's
   *              vorticity confinement answers by shedding a vortex on each
   *              beat, left then right, and the wake trails behind the body
   *              for the six seconds the water remembers. That street is not
   *              authored anywhere: it is what a beating tail does to water,
   *              and it is the strongest evidence in the frame that the animal
   *              is in the same ocean as the plankton.
   */
  if (ws.mass >= 0.03) {
    whales.tail(tailWhale);
    toWater(tailWhale.x, tailWhale.y, depth, stage.camera, tailWater);
    const hx = water.x - tailWater.x;
    const hy = water.y - tailWater.y;
    const h = Math.hypot(hx, hy) || 1;
    const ux = hx / h;
    const uy = hy / h;
    const reach = mouthRadius(0.5);

    // Steady state is roughly six times the push (the water's decay constant),
    // so these are small numbers on purpose: a cruising animal should stir the
    // field, not blow it apart.
    const bow = (0.22 + ws.effort * 1.05) * (0.4 + ws.mass);
    fluid.setSwimmer(0, water.x, water.y, reach * 1.15, ux * bow, uy * bow, 0, 1);

    const beat = Math.sin(ws.stroke);
    const swat = beat * (0.45 + ws.effort * 2.1) * (0.4 + ws.mass);
    fluid.setSwimmer(1, tailWater.x, tailWater.y, reach * 0.95,
      -uy * swat, ux * swat, beat * (0.6 + ws.effort * 2.4), 1);
  } else {
    fluid.setSwimmer(0, 0, 0, 1, 0, 0, 0, 0);
    fluid.setSwimmer(1, 0, 0, 1, 0, 0, 0, 0);
  }

  /*
   * Exposure, which was wired and dead.
   *
   * `uExposure` is declared in effects/abyss.ts and in scene/field.ts, is
   * multiplied into the output of both, and was set by nothing — a whole-frame
   * lever with the cable already run to it. Tied to agitation with a
   * forty-second time constant it gives the piece the one thing §9
   * (accumulation) was asking for, without adding a single new piece of state:
   * a quiet market slowly sinks and a busy one slowly lifts, over minutes, so
   * that forty minutes in does not look like one minute in.
   *
   * The field's copy is applied *before* the bloom threshold, so activity also
   * changes how much of the water crosses into glow; the post chain's copy is
   * applied after the tonemap, where it is only a black level, and takes a
   * fraction of the same swing so the two do not multiply into a flicker.
   */
  const wantExposure = 0.80 + state.agitation * 0.48;
  exposure += (wantExposure - exposure) * (1 - Math.exp(-dt / 40));
  field.setExposure(exposure);
  postFx.setExposure(1 + (exposure - 1) * 0.45);

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
    /*
     * At the body's own screen position — no 0.4.
     *
     * Projecting at the real depth already applies the perspective, so scaling
     * x by another 0.4 applied it twice and put the bend somewhere the mass is
     * not. A body that curves space forty units from itself is not a body with
     * mass; it is a smudge with a coincidence.
     */
    toNdc(ws.cruise, ws.y, depth, stage.camera, screen);
    postFx.lenses.push({
      x: screen.x * 0.5 * stage.aspect(),
      y: screen.y * 0.5,
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
