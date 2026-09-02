import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/examples/jsm/misc/GPUComputationRenderer.js';
import type { Fluid } from './fluid';

/**
 * The krill: every print under a tenth of a coin, which is most of them.
 *
 * They are not drawn as points. Each one is a quad stretched along its own
 * velocity, so a still particle is a round mote and a moving one is a line —
 * and the transition between those two states, across a hundred thousand
 * bodies, is the single largest quality lever in the piece. A field of round
 * dots reads as confetti at any density; a field that *smears where the water
 * is moving* reads as a photograph of a medium. The cost is one extra vertex
 * per particle.
 *
 * Their brightness is shear, not size. This is the one place the piece takes
 * something literally from biology: dinoflagellates emit when the water around
 * them is strained, which is why a boat's wake glows at night and still water
 * does not. So a krill sitting in dead water is nearly invisible, and the
 * corridor a fish tore open is a bright streak in the dark — the *water* is
 * what lights up, not the animals, and the picture gets its light from exactly
 * the places where something is happening.
 */

export interface Field {
  points: THREE.Mesh;
  update: (dt: number, time: number) => void;
  /** World Y where the warm and cold halves of the water meet (plan §8). */
  setBoundary: (y: number) => void;
  setExtent: (halfWidth: number, halfHeight: number) => void;
  /** 0..1: how much of the moving light is currently on the field. */
  setLight: (x: number, y: number, strength: number) => void;
  /**
   * Where the whale's open mouth is, in the water's own space, and how open.
   * Krill inside it are being swallowed and go dark (plan §13.3.4).
   */
  setMouth: (x: number, y: number, radius: number, strength: number) => void;
  /** The slow market-driven exposure. Shared with the post chain. */
  setExposure: (e: number) => void;
  dispose: () => void;
}

const POSITION_SHADER = /* glsl */ `
uniform float uDt;
uniform vec2 uMin;
uniform vec2 uSize;
uniform float uDepth;

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 pos = texture2D(texturePosition, uv);
  vec4 vel = texture2D(textureVelocity, uv);
  vec3 p = pos.xyz + vel.xyz * uDt;

  /*
   * Wrapping, rather than a lifetime.
   *
   * A krill that died and respawned would pop, and worse, it would give the
   * field a *clock* — a population that turns over on a schedule is a texture
   * that repeats on a schedule. Wrapped, the population is constant and the
   * field's only history is the water's. Nothing in this ocean is ever born or
   * dies, which is also what the concept requires: the deep does not tick.
   *
   * The pop is handled in the vertex shader, which fades a particle out over
   * the outer margin so it is already invisible when it crosses.
   */
  vec2 lo = uMin, hi = uMin + uSize;
  if (p.x < lo.x) p.x += uSize.x;
  if (p.x > hi.x) p.x -= uSize.x;
  if (p.y < lo.y) p.y += uSize.y;
  if (p.y > hi.y) p.y -= uSize.y;
  if (p.z < -uDepth) p.z += uDepth * 2.0;
  if (p.z > uDepth) p.z -= uDepth * 2.0;

  gl_FragColor = vec4(p, pos.w);
}
`;

const VELOCITY_SHADER = /* glsl */ `
uniform float uDt;
uniform float uTime;
uniform sampler2D tFluid;
uniform vec2 uFluidMin;
uniform vec2 uFluidSize;

float hash(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
}
float noise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), u.x),
                 mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), u.x), u.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), u.x),
                 mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), u.x), u.y), u.z);
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 pos = texture2D(texturePosition, uv);
  vec4 vel = texture2D(textureVelocity, uv);
  float seed = pos.w;

  // The water's own velocity, at this particle's position.
  vec2 fuv = (pos.xy - uFluidMin) / uFluidSize;
  vec2 water = texture2D(tFluid, clamp(fuv, 0.0, 1.0)).rg;

  /*
   * The particle is *dragged toward* the water, never assigned to it.
   *
   * This one line is what gives the field inertia. A krill set equal to the
   * flow would stop the instant the flow did, and the whole picture would
   * switch off between events. Dragged, it overshoots, coasts, and takes a
   * couple of seconds to give its momentum back — so the field keeps moving
   * after the water has forgotten, and the eye keeps finding motion in a frame
   * where nothing has happened for a minute.
   *
   * Heavier particles (the marine snow, seed < 0.16) are slower to answer,
   * which separates them from the field without any change in how they are
   * drawn: they hang while the krill are swept past them, and that difference
   * in *lag* is what makes two populations out of one buffer.
   */
  float mass = seed < 0.16 ? 0.34 : 1.0;
  vec3 target = vec3(water * 0.85, 0.0);

  // A slow three-dimensional stir, so the field has depth to it: without a z
  // component the whole population lies in one plane and the depth of field
  // has nothing to separate.
  vec3 q = pos.xyz * 0.11 + vec3(0.0, 0.0, uTime * 0.04);
  vec3 wander = vec3(noise(q) - 0.5, noise(q + 19.7) - 0.5, noise(q + 41.3) - 0.5);
  target += wander * 0.9;

  // Marine snow sinks. Very slowly — it is the only absolute direction in a
  // frame with no horizon, and it is what tells the eye which way is down.
  if (seed < 0.16) target.y -= 0.22;

  vec3 v = mix(vel.xyz, target, clamp(uDt * 2.2 * mass, 0.0, 1.0));
  gl_FragColor = vec4(v, vel.w);
}
`;

const VERTEX_SHADER = /* glsl */ `
uniform sampler2D tPosition;
uniform sampler2D tVelocity;
uniform float uScale;
uniform vec2 uMin;
uniform vec2 uSize;

attribute vec2 aRef;
attribute float aSeed;

varying float vSpeed;
varying float vSeed;
varying vec2 vQuad;
varying float vFade;
varying vec3 vWorld;

void main() {
  vec4 pos = texture2D(tPosition, aRef);
  vec3 vel = texture2D(tVelocity, aRef).xyz;
  vWorld = pos.xyz;
  vSeed = aSeed;

  vec4 mv = modelViewMatrix * vec4(pos.xyz, 1.0);
  vec3 vv = (modelViewMatrix * vec4(vel, 0.0)).xyz;
  float speed = length(vv.xy);
  vSpeed = speed;

  /*
   * The stretch. Capped, and the cap is doing real work: an uncapped stretch
   * turns a shock front into screen-long streaks that read as scratches on the
   * lens rather than as water. Seven times its own width is about as long as a
   * mark can be and still be read as a body that moved.
   */
  vec2 dir = speed > 1e-4 ? vv.xy / speed : vec2(1.0, 0.0);
  float heavy = step(aSeed, 0.16);
  float stretch = 1.0 + min(speed * 0.30, 6.0) * (1.0 - heavy * 0.75);
  float width = uScale * (heavy > 0.5 ? 1.9 : 1.0) * (0.55 + aSeed * 0.9);

  mv.xy += position.x * dir * width * stretch
         + position.y * vec2(-dir.y, dir.x) * width;
  vQuad = position.xy * 2.0;

  // The wrap, hidden: a particle is faded out across the outer margin of the
  // box so that it has already gone before the position shader teleports it.
  vec2 lo = uMin, hi = uMin + uSize;
  vec2 edge = min(pos.xy - lo, hi - pos.xy) / (uSize * 0.06);
  vFade = clamp(min(edge.x, edge.y), 0.0, 1.0);

  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform float uBoundary;
uniform vec3 uLight;   // xy world position, z strength
uniform vec4 uMouth;   // xy world position, z radius, w how open
uniform float uExposure;

varying float vSpeed;
varying float vSeed;
varying vec2 vQuad;
varying float vFade;
varying vec3 vWorld;

void main() {
  // A gaussian, not a disc: a hard-edged sprite at this count reads as a mesh
  // of dots. The tail is most of what is seen once a hundred thousand of them
  // overlap.
  float r2 = dot(vQuad, vQuad);
  float core = exp(-r2 * 3.4);
  if (core < 0.004) discard;

  /*
   * Colour is a *place*, not a state (plan §8).
   *
   * The naive mapping — the whole screen goes cyan when buyers lead, magenta
   * when sellers do — is both garish and unstable: at the moment of balance one
   * of the two colours is entirely absent and the image loses its harmony. Here
   * the water is warm above and cold below at all times, and pressure moves
   * only the *height of the boundary between them*. Both colours are always on
   * screen, the picture is always harmonious, and it is never the same picture.
   *
   * The warm side is an ember red rather than a magenta, and that is a
   * deliberate wrongness: below a couple of hundred metres there is no red
   * light in the ocean at all, so a red glow down here reads as something that
   * should not be here. Selling pressure ought to feel like that.
   */
  vec3 cold = vec3(0.28, 0.86, 1.0);
  vec3 warm = vec3(1.0, 0.40, 0.20);
  float band = smoothstep(uBoundary - 5.0, uBoundary + 5.0, vWorld.y);
  vec3 tint = mix(cold, warm, band);

  // Bioluminescence: the water lights where it is strained. A krill in still
  // water is barely there; the same krill in a wake is the brightest thing in
  // the frame.
  float shear = 1.0 - exp(-vSpeed * 0.42);
  // Raised from 0.030 / 0.95: the first pass was too austere to sit and watch —
  // correct about the blacks and wrong about the light. The resting term is
  // what the still water is worth and the shear term is what a wake is worth,
  // and it is the *ratio* between them that has to survive: eighty to one, so
  // that a disturbance is still an event and not merely a brighter patch.
  float lum = 0.042 + shear * 1.45;

  // The marine snow is not bioluminescent — it is dead matter, and it is only
  // ever seen because something else lit it. That makes it the one population
  // whose brightness reports on the *light*, which is what lets the moving
  // light source (plan §6) be visible at all.
  float heavy = step(vSeed, 0.16);
  float lit = uLight.z * exp(-distance(vWorld.xy, uLight.xy) * 0.11);
  lum = mix(lum, 0.034 + lit * 2.1, heavy);
  tint = mix(tint, mix(tint, vec3(0.86, 0.94, 1.0), 0.7), heavy);

  /*
   * Swallowed.
   *
   * Krill do not die in this ocean — they wrap, so that the field has no clock
   * (see the position shader) — but a lunge that takes a hundred thousand
   * bodies into a mouth and gives every one of them back is a lunge that ate
   * nothing. Inside the pouch they simply stop being lit: they are behind a
   * closing jaw, in the one volume of this water where there is no light at
   * all, and darkness is the only disappearance this design will accept.
   *
   * The edge is soft, so what is seen is a shadow drawing itself over the
   * swarm as the mouth arrives rather than a disc switching off.
   */
  float swallowed = uMouth.w * exp(-dot(vWorld.xy - uMouth.xy, vWorld.xy - uMouth.xy)
                                   / max(uMouth.z * uMouth.z, 1e-4));
  lum *= 1.0 - 0.92 * clamp(swallowed, 0.0, 1.0);

  gl_FragColor = vec4(tint * lum * uExposure * core * vFade, 1.0);
}
`;

export function createField(
  renderer: THREE.WebGLRenderer,
  resolution: number,
  fluid: Fluid,
): Field {
  const count = resolution * resolution;
  const gpu = new GPUComputationRenderer(resolution, resolution, renderer);

  const position = gpu.createTexture();
  const velocity = gpu.createTexture();
  const p = position.image.data as Float32Array;
  const v = velocity.image.data as Float32Array;
  for (let i = 0; i < count; i++) {
    p[i * 4 + 0] = (Math.random() - 0.5) * 40;
    p[i * 4 + 1] = (Math.random() - 0.5) * 34;
    p[i * 4 + 2] = -11 + Math.random() * 18;
    p[i * 4 + 3] = Math.random(); // the seed, and the only per-particle identity
    v[i * 4 + 0] = 0;
    v[i * 4 + 1] = 0;
    v[i * 4 + 2] = 0;
    v[i * 4 + 3] = 0;
  }

  const posVar = gpu.addVariable('texturePosition', POSITION_SHADER, position);
  const velVar = gpu.addVariable('textureVelocity', VELOCITY_SHADER, velocity);
  gpu.setVariableDependencies(posVar, [posVar, velVar]);
  gpu.setVariableDependencies(velVar, [posVar, velVar]);

  const posU = posVar.material.uniforms;
  posU.uDt = { value: 1 / 60 };
  posU.uMin = { value: new THREE.Vector2(-20, -17) };
  posU.uSize = { value: new THREE.Vector2(40, 34) };
  posU.uDepth = { value: 11 };

  const velU = velVar.material.uniforms;
  velU.uDt = { value: 1 / 60 };
  velU.uTime = { value: 0 };
  velU.tFluid = { value: fluid.texture() };
  velU.uFluidMin = { value: fluid.min };
  velU.uFluidSize = { value: fluid.size };

  const error = gpu.init();
  if (error) console.error('[field]', error);

  // One quad per particle, instanced. The base quad is a unit square centred on
  // the origin; the vertex shader gives it its orientation and its length.
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.instanceCount = count;
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const refs = new Float32Array(count * 2);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    refs[i * 2 + 0] = (i % resolution) / resolution;
    refs[i * 2 + 1] = Math.floor(i / resolution) / resolution;
    seeds[i] = p[i * 4 + 3];
  }
  geometry.setAttribute('aRef', new THREE.InstancedBufferAttribute(refs, 2));
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  // The field spans the whole box and is never entirely off screen, so frustum
  // culling can only ever be wrong about it.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60);

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      tPosition: { value: null },
      tVelocity: { value: null },
      uScale: { value: 0.032 },
      uMin: { value: posU.uMin.value },
      uSize: { value: posU.uSize.value },
      uBoundary: { value: 0 },
      uLight: { value: new THREE.Vector3(0, 0, 0) },
      uMouth: { value: new THREE.Vector4(0, 0, 1, 0) },
      uExposure: { value: 1 },
    },
    transparent: true,
    // Additive, and depth-tested against nothing: the field is the only thing
    // in its own depth range (the whales sit behind it, scene/whale.ts), so a
    // sort would cost a millisecond to change nothing.
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });

  const points = new THREE.Mesh(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 10;

  return {
    points,
    update(dt, time) {
      posU.uDt.value = dt;
      velU.uDt.value = dt;
      velU.uTime.value = time;
      velU.tFluid.value = fluid.texture();
      gpu.compute();
      material.uniforms.tPosition.value = gpu.getCurrentRenderTarget(posVar).texture;
      material.uniforms.tVelocity.value = gpu.getCurrentRenderTarget(velVar).texture;
    },
    setBoundary(y) {
      material.uniforms.uBoundary.value = y;
    },
    setExtent(halfWidth, halfHeight) {
      posU.uMin.value.set(-halfWidth * 1.4, -halfHeight * 1.25);
      posU.uSize.value.set(halfWidth * 2.8, halfHeight * 2.5);
    },
    setLight(x, y, strength) {
      material.uniforms.uLight.value.set(x, y, strength);
    },
    setMouth(x, y, radius, strength) {
      material.uniforms.uMouth.value.set(x, y, radius, strength);
    },
    setExposure(e) {
      material.uniforms.uExposure.value = e;
    },
    dispose() {
      gpu.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
