import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/examples/jsm/misc/GPUComputationRenderer.js';

/**
 * The water itself: a velocity field, on a texture, that remembers.
 *
 * The obvious way to move a hundred thousand particles is curl noise — sample a
 * divergence-free noise field at each particle and follow it. It looks superb
 * for about thirty seconds and then it reads as wallpaper, and the reason is
 * precise: a noise field is *statistically stationary*. Nothing that happens in
 * it changes it. There is no history, so there is no event, so after half a
 * minute the eye has correctly concluded that it has seen everything this
 * picture can do.
 *
 * So the water here is an actual (if small) fluid: a 2D velocity field that is
 * advected by itself, forced by the market, and decays over seconds rather than
 * instantly. Three things follow from that, and they are the reason the piece
 * is watchable for an hour rather than a minute:
 *
 *  - a wake persists. A fish crosses the frame in two seconds and the corridor
 *    it tore through the krill is still visible for eight. The wake is more
 *    beautiful than the fish.
 *  - eddies interact. Two shocks from opposite sides do not add up, they
 *    *braid*, and what comes out was authored by nobody.
 *  - the field is never twice in the same state, because its state at t is the
 *    entire history of the market since the page opened.
 *
 * It is deliberately not a *correct* fluid — there is no pressure projection,
 * so it is compressible and krill will bunch. Bunching is what plankton does.
 * The two passes a projection would cost buy realism the picture does not want.
 */

/** How many impulses the shader will look at in one frame. */
const MAX_IMPULSES = 8;

/** Field resolution. Square, and low: this is a velocity field, not a picture —
 * it feeds a *direction*, and a direction does not need to be sharp. Every
 * sample of it by a particle is bilinear, so the field the krill actually see is
 * smooth however coarse this is. */
const RES = 160;

export interface Impulse {
  /** World position. */
  x: number;
  y: number;
  /** Unit direction; a whale's is radial and this is the swirl axis instead. */
  dx: number;
  dy: number;
  /** World units. */
  radius: number;
  /** Signed swirl. Nonzero only for whales. */
  spin: number;
  /** Signed radial: positive blows outward, negative draws in. */
  radial: number;
  strength: number;
  /** Seconds remaining, and seconds it started with. */
  life: number;
  span: number;
}

export interface Fluid {
  texture: () => THREE.Texture;
  /** World-space extent the field covers, for the samplers. */
  min: THREE.Vector2;
  size: THREE.Vector2;
  add: (i: Impulse) => void;
  /**
   * The swimmer: a *standing* forcing, refreshed every frame rather than
   * decaying like an impulse. Two of them — the head and the flukes — which is
   * how a body that swims through water gets to move the water it swims
   * through (see the shader).
   */
  setSwimmer: (
    i: 0 | 1,
    x: number, y: number, radius: number,
    dx: number, dy: number, spin: number, radial: number, strength: number,
  ) => void;
  setExtent: (halfWidth: number, halfHeight: number) => void;
  update: (dt: number, time: number, agitation: number) => void;
  dispose: () => void;
}

const FLUID_SHADER = /* glsl */ `
uniform float uDt;
uniform float uTime;
uniform float uAmbient;
uniform vec2 uMin;
uniform vec2 uSize;
uniform vec4 uImpulse[${MAX_IMPULSES}];  // xy world position, z strength, w radius
uniform vec4 uImpulseDir[${MAX_IMPULSES}]; // xy direction, z spin, w radial
uniform vec4 uSwimmer[2];     // xy world position, z radius, w strength
uniform vec4 uSwimmerDir[2];  // xy push, z spin, w radial (negative draws in)

/*
 * Simplex-ish value noise. Cheap on purpose: it is only used to keep the field
 * from ever settling, and a smoother noise would not be visible under the
 * advection.
 */
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  return 0.5 * noise(p) + 0.25 * noise(p * 2.03) + 0.125 * noise(p * 4.01);
}
/* The ambient stir, taken as the curl of a scalar so it has no divergence and
 * therefore cannot itself pile the krill up anywhere. */
vec2 curl(vec2 p) {
  float e = 0.08;
  float a = fbm(p + vec2(0.0, e));
  float b = fbm(p - vec2(0.0, e));
  float c = fbm(p + vec2(e, 0.0));
  float d = fbm(p - vec2(e, 0.0));
  return vec2(a - b, d - c) / (2.0 * e);
}

vec2 worldOf(vec2 uv) { return uMin + uv * uSize; }

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 self = texture2D(textureFluid, uv);

  /*
   * Advection, backwards.
   *
   * Semi-Lagrangian: ask "what was at the place this parcel came from" rather
   * than pushing anything forward. It is unconditionally stable at any step
   * size, which matters because the shocks below inject velocities that would
   * blow up a forward integrator on the frame they land.
   */
  vec2 uvPerWorld = 1.0 / uSize;
  vec2 back = uv - self.rg * uDt * uvPerWorld;
  vec4 src = texture2D(textureFluid, clamp(back, 0.002, 0.998));
  vec2 v = src.rg;
  float dye = src.b;

  vec2 world = worldOf(uv);

  // The ambient stir. Large and slow — it is the current the whole body of
  // water sits in, and on a quiet market it is the only thing moving.
  v += curl(world * 0.075 + vec2(0.0, uTime * 0.012)) * uAmbient * uDt;

  /*
   * Vorticity confinement.
   *
   * A grid this coarse eats its own eddies within a couple of seconds — the
   * bilinear sample in the advection is a low-pass filter, and a vortex is
   * exactly the high frequency it removes. This puts the energy back: find
   * where the curl is strong, and push the velocity along the gradient of its
   * magnitude, which spins up the eddy instead of smearing it.
   *
   * This single term is the difference between "particles drifting" and
   * "water". Without it the wake of a fish is a straight fading line; with it
   * the wake curls up at its edges and sheds.
   */
  vec2 t = 1.0 / resolution.xy;
  float cL = texture2D(textureFluid, uv - vec2(t.x, 0.0)).a;
  float cR = texture2D(textureFluid, uv + vec2(t.x, 0.0)).a;
  float cD = texture2D(textureFluid, uv - vec2(0.0, t.y)).a;
  float cU = texture2D(textureFluid, uv + vec2(0.0, t.y)).a;
  vec2 grad = vec2(abs(cR) - abs(cL), abs(cU) - abs(cD));
  if (length(grad) > 1e-5) {
    vec2 n = normalize(grad);
    v += vec2(n.y, -n.x) * self.a * 2.4 * uDt;
  }

  /*
   * The market's forcing.
   *
   * A fish is a jet: a push along its heading, inside a soft gaussian. A whale
   * is a jet with a spin, which is what turns "an explosion" into "something
   * turned over down there" — the radial part throws the krill outward and the
   * tangential part winds them into a vortex that outlives the flash by many
   * seconds (plan §7: three speeds, one event).
   */
  for (int i = 0; i < ${MAX_IMPULSES}; i++) {
    vec4 imp = uImpulse[i];
    if (imp.z <= 0.0) continue;
    vec2 d = world - imp.xy;
    float r = length(d) + 1e-4;
    float fall = exp(-(r * r) / (imp.w * imp.w));
    vec4 dir = uImpulseDir[i];
    vec2 radial = d / r;
    vec2 tangent = vec2(-radial.y, radial.x);
    // The radial term is signed, and the negative half of it is the whole
    // reason it exists: a lunge-feeding whale does not blow the krill away, it
    // *inhales* them. A suction is a thing you can watch happen to a hundred
    // thousand bodies at once, and there is nothing else in the piece that
    // moves the field inward.
    v += (dir.xy + radial * dir.w + tangent * dir.z) * imp.z * fall * uDt;
    dye += fall * imp.z * uDt * 0.25;
  }

  /*
   * The animal, continuously.
   *
   * Everything above is an *event*: a print lands, the water is hit, the hit
   * decays. Nothing here was ever driven by the fact that a body a hundred
   * units long is crossing the frame — so the whale swam and the krill did not
   * notice, which is the whole of "the whale and the water do not fit
   * together". A body in water pushes water at all times, and it does it in
   * two places for two different reasons.
   *
   * The head is a bow: it shoulders the water aside, and the faster it goes
   * the harder. That is what makes the krill part in front of it.
   *
   * The flukes are the interesting one. The push there is *lateral and it
   * alternates with the stroke*, which is what a tail actually does, and a
   * field with vorticity confinement in it answers by shedding a vortex on
   * each beat — one to the left, one to the right, trailing behind the animal.
   * Nobody authored that wake; it is the same physics that puts one behind a
   * real fish, and it means the tail beat is now visible in the water long
   * after the animal has gone past.
   */
  for (int i = 0; i < 2; i++) {
    vec4 sw = uSwimmer[i];
    if (sw.w <= 0.0) continue;
    vec2 d = world - sw.xy;
    float r = length(d) + 1e-4;
    float fall = exp(-(r * r) / (sw.z * sw.z));
    vec4 dir = uSwimmerDir[i];
    vec2 radial = d / r;
    vec2 tangent = vec2(-radial.y, radial.x);
    v += (dir.xy + tangent * dir.z + radial * dir.w) * sw.w * fall * uDt;
    dye += fall * sw.w * uDt * 0.05;
  }

  // The walls. Velocity is faded to nothing over the outer eighth of the field
  // so nothing accumulates against the edge, which would read as a container —
  // and the one thing this space must not have is a container (plan §1).
  vec2 edge = min(uv, 1.0 - uv) / 0.12;
  v *= clamp(min(edge.x, edge.y), 0.0, 1.0);

  /*
   * Decay: about a six-second time constant.
   *
   * This number is the memory of the water and it was chosen against the
   * event rate, not for physical realism. Faster and a wake is gone before the
   * eye has followed it; slower and the field saturates in a busy minute into
   * uniform turbulence, which is as featureless as no motion at all. Six
   * seconds keeps four or five events legibly braided together.
   */
  v *= exp(-uDt / 6.0);
  dye *= exp(-uDt / 5.0);

  // The curl is stored so the next frame's confinement can read it without
  // recomputing the neighbourhood twice.
  float vL = texture2D(textureFluid, uv - vec2(t.x, 0.0)).g;
  float vR = texture2D(textureFluid, uv + vec2(t.x, 0.0)).g;
  float uD = texture2D(textureFluid, uv - vec2(0.0, t.y)).r;
  float uU = texture2D(textureFluid, uv + vec2(0.0, t.y)).r;
  float curlZ = (vR - vL) - (uU - uD);

  gl_FragColor = vec4(clamp(v, -60.0, 60.0), clamp(dye, 0.0, 3.0), curlZ);
}
`;

export function createFluid(renderer: THREE.WebGLRenderer): Fluid {
  const gpu = new GPUComputationRenderer(RES, RES, renderer);
  const initial = gpu.createTexture();
  // Starts dead still. The ambient stir has it moving within a second or two,
  // and the piece is never shown before the warm-up has run anyway (main.ts).
  (initial.image.data as Float32Array).fill(0);

  const variable = gpu.addVariable('textureFluid', FLUID_SHADER, initial);
  gpu.setVariableDependencies(variable, [variable]);

  const uniforms = variable.material.uniforms;
  uniforms.uDt = { value: 1 / 60 };
  uniforms.uTime = { value: 0 };
  uniforms.uAmbient = { value: 1.0 };
  uniforms.uMin = { value: new THREE.Vector2(-12, -12) };
  uniforms.uSize = { value: new THREE.Vector2(24, 24) };
  uniforms.uImpulse = {
    value: Array.from({ length: MAX_IMPULSES }, () => new THREE.Vector4()),
  };
  uniforms.uImpulseDir = {
    value: Array.from({ length: MAX_IMPULSES }, () => new THREE.Vector4()),
  };
  uniforms.uSwimmer = { value: [new THREE.Vector4(), new THREE.Vector4()] };
  uniforms.uSwimmerDir = { value: [new THREE.Vector4(), new THREE.Vector4()] };

  const error = gpu.init();
  if (error) console.error('[fluid]', error);

  const active: Impulse[] = [];
  const min = new THREE.Vector2(-12, -12);
  const size = new THREE.Vector2(24, 24);

  return {
    min,
    size,
    texture: () => gpu.getCurrentRenderTarget(variable).texture,

    add(i) {
      // Newest wins when the frame is full: a fresh whale matters more than the
      // tail of an old fish, and the old one's energy is already in the field.
      if (active.length >= MAX_IMPULSES) active.shift();
      active.push(i);
    },

    setSwimmer(i, x, y, radius, dx, dy, spin, radial, strength) {
      (uniforms.uSwimmer.value as THREE.Vector4[])[i].set(x, y, radius, strength);
      (uniforms.uSwimmerDir.value as THREE.Vector4[])[i].set(dx, dy, spin, radial);
    },

    setExtent(halfWidth, halfHeight) {
      // A margin past the visible frame, so a wake that leaves the picture is
      // still being simulated when it comes back.
      min.set(-halfWidth * 1.35, -halfHeight * 1.15);
      size.set(halfWidth * 2.7, halfHeight * 2.3);
      uniforms.uMin.value.copy(min);
      uniforms.uSize.value.copy(size);
    },

    update(dt, time, agitation) {
      uniforms.uDt.value = dt;
      uniforms.uTime.value = time;
      // The ambient stir rises with the market's activity, but only a little
      // and never to zero: a dead tape still has a living ocean (plan §4).
      uniforms.uAmbient.value = 0.5 + agitation * 1.1;

      const slots = uniforms.uImpulse.value as THREE.Vector4[];
      const dirs = uniforms.uImpulseDir.value as THREE.Vector4[];
      for (let i = active.length - 1; i >= 0; i--) {
        active[i].life -= dt;
        if (active[i].life <= 0) active.splice(i, 1);
      }
      for (let i = 0; i < MAX_IMPULSES; i++) {
        const imp = active[i];
        if (!imp) {
          slots[i].set(0, 0, 0, 1);
          dirs[i].set(0, 0, 0, 0);
          continue;
        }
        /*
         * The envelope: instant attack, slow decay (plan §1). The impulse is at
         * full strength on the frame it arrives and then falls off as the
         * square of its remaining life, so an event *lands* and then subsides,
         * which is what a release of energy into a medium does. A symmetric
         * envelope reads as an animation being played.
         */
        const k = Math.max(0, imp.life / imp.span);
        slots[i].set(imp.x, imp.y, imp.strength * k * k, imp.radius);
        dirs[i].set(imp.dx, imp.dy, imp.spin * k, imp.radial * k);
      }

      gpu.compute();
    },

    dispose() {
      gpu.dispose();
    },
  };
}
