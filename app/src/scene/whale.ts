import * as THREE from 'three';

/**
 * The whale. One of them, and it is a fin whale.
 *
 * Three corrections are baked into this file, all of them from watching it
 * rather than from reading it:
 *
 * 1. There were two, and they overlapped into an unreadable stack. There is now
 *    one, and it belongs to whichever side of the book is presently heavier. It
 *    does not teleport when dominance changes — it *swims* to the new level over
 *    about ten seconds, which turns a data event into the most legible motion in
 *    the piece.
 *
 * 2. The head came to a point, which is a dolphin. A fin whale's rostrum is
 *    pointed in plan and flattened in profile: seen from the side it is a
 *    wedge, seen from above it is a broad V. The cross-section is therefore
 *    squashed vertically and widened horizontally through the head, and that
 *    one change is most of the difference between the two animals.
 *
 * 3. There was no dorsal fin. A rorqual is recognised by a small falcate fin
 *    about three quarters of the way back, and without it the silhouette is
 *    just a large smooth thing. It is a few lines of SDF and it is the single
 *    strongest identification cue on the body.
 *
 * And it does something now. A print large enough to be a whale on this side of
 * the book makes it *lunge feed*: it accelerates, the throat pleats balloon out
 * into a pouch bigger than its own head, and the water in front of it is drawn
 * inward — the krill are not blown away, they are inhaled (scene/fluid.ts). It
 * is the correct picture of what a large aggressive order does to a book, and
 * it is the only moment the animal is unmistakably alive.
 */

export interface WhaleState {
  /** World Y of the level this body is holding. Eased, never assigned. */
  y: number;
  /** 0..1 mass of the wall it embodies. */
  mass: number;
  /** 0..1 across the visible book: how far that wall is from the touch. */
  distance: number;
  /** 0 for the bid side (cold), 1 for the ask side (ember). Blends. */
  warm: number;
  /** 0..1, decays fast. A print landing on this side. */
  flash: number;
  /** 0..1 lunge envelope, and the gape that lags it. */
  lunge: number;
  gape: number;
  /** 0..1: the rare ascent (plan §3). */
  ascend: number;
  /** Where along its own track it presently is, world units. */
  cruise: number;
}

export interface Whales {
  mesh: THREE.Mesh;
  state: WhaleState;
  /** Starts a lunge. Returns the world position of the mouth. */
  lungeAt: () => THREE.Vector3;
  update: (dt: number, time: number, camera: THREE.PerspectiveCamera) => void;
  setLight: (x: number, y: number, z: number, strength: number) => void;
  setBoundary: (y: number) => void;
  fit: (camera: THREE.PerspectiveCamera) => void;
  /** The depth the body is presently at, for the lens in main.ts. */
  depth: () => number;
  dispose: () => void;
}

/** Where the backdrop quad sits. Behind everything the field can reach. */
const PLANE_Z = -18;

/** The animal's heading, in radians of yaw away from broadside. */
const YAW = 0.58;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform float uTime;
uniform vec3 uCam;
uniform vec4 uLight;      // xyz world position, w strength
uniform float uBoundary;
uniform vec4 uBody;       // y, z, mass, flash
uniform vec4 uMotion;     // cruise x, gape, warm, ascend

varying vec3 vWorld;

const float PI = 3.14159265;

float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float noise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), u.x),
                 mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), u.x), u.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), u.x),
                 mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), u.x), u.y), u.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.02; a *= 0.5; }
  return s;
}
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

/*
 * The girth profile of a balaenopterid, tail (t=0) to snout (t=1).
 *
 * The exponent 1.45 puts the widest point at t = 0.62 — a bit under forty per
 * cent back from the nose, which is where a fin whale carries it. The first
 * version had it at 0.36, i.e. behind the midpoint, which is a shape no whale
 * has; it is closer to a tadpole. The peduncle floor of 0.18 is what makes the
 * tail stock read as a *stock* rather than as a taper: the sudden thinness in
 * front of the flukes is a rorqual's most characteristic line after the fin.
 */
float girth(float t) {
  t = clamp(t, 0.0, 1.0);
  float base = pow(max(0.0, sin(PI * pow(t, 1.45))), 0.48);
  float peduncle = smoothstep(0.0, 0.17, t);
  return base * mix(0.18, 1.0, peduncle);
}

/**
 * The body, in the animal's own frame. Every length here is in world units,
 * x included — normalising one axis and not the others is a units bug that
 * makes fins hundreds of units long and facets the flanks.
 */
float sdWhale(vec3 p, float R, float L, float wave, float gape) {
  // The stroke: a travelling wave, largest at the flukes and zero at the head,
  // because that is how a whale is driven. Tiny at rest, deep in a lunge.
  float amp = wave * smoothstep(0.5 * L, -L, p.x);
  p.y -= sin(p.x * (1.7 / L) * PI - uTime * 0.55) * amp;

  float t = p.x / L * 0.5 + 0.5;
  float r = girth(t) * R;

  /*
   * The lunge pouch.
   *
   * A rorqual's throat unfolds into a bag that holds more than the animal
   * weighs. It only ever goes *downward* — the back stays a clean line through
   * the whole event, and that contrast between a rigid spine and a grotesquely
   * distended throat is the entire image of a lunge.
   */
  float throat = smoothstep(0.28, 0.72, t) * smoothstep(1.02, 0.86, t);
  float below = smoothstep(0.0, -0.30 * R, p.y);
  r += gape * throat * below * R * 1.25;

  /*
   * The head: flattened in profile, broadened in plan.
   *
   * Scaling the sampling coordinate *up* on an axis shrinks the body on it, so
   * y is multiplied through the head and z divided. The result is a wedge from
   * the side and a wide V from above, which is a fin whale's rostrum. Left
   * round, the same profile is a dolphin's — which is exactly what it looked
   * like.
   */
  float head = smoothstep(0.70, 1.0, t);
  vec2 yz = vec2(p.y * (p.y > 0.0 ? 0.92 : 1.08) * mix(1.0, 1.85, head),
                 p.z * mix(1.06, 0.70, head));
  // The rostrum keeps a little substance instead of vanishing to a point.
  r = max(r, 0.085 * R * head);
  float body = length(yz) - r;
  body += max(abs(p.x) - L, 0.0);

  // The flukes: a thin horizontal blade behind the peduncle.
  vec3 f = p - vec3(-L * 1.02, 0.0, 0.0);
  float fluke = length(vec3(max(abs(f.x) - R * 0.55, 0.0),
                            f.y * 4.2,
                            max(abs(f.z) - R * 1.7 * smoothstep(R * 1.1, 0.0, abs(f.x)), 0.0)))
                - R * 0.16;

  /*
   * The dorsal fin, at t = 0.28 — about three quarters of the way back.
   *
   * Small, and swept: the shear term leans its tip toward the tail, which is
   * what "falcate" means and what separates a rorqual's fin from the upright
   * triangle every other sea creature is drawn with. Its absence was why the
   * silhouette read as a generic large animal.
   */
  vec3 df = p - vec3(-L * 0.44, girth(0.28) * R * 0.86, 0.0);
  df.x += max(df.y, 0.0) * 1.15;
  float dorsal = length(vec3(max(abs(df.x) - R * 0.26, 0.0),
                             max(abs(df.y) - R * 0.30, 0.0),
                             df.z * 3.6)) - R * 0.085;

  // One pectoral, the near one. The far one is never lit.
  vec3 g = p - vec3(L * 0.30, -R * 0.55, R * 0.62);
  g.xz = mat2(0.86, -0.51, 0.51, 0.86) * g.xz;
  float pec = length(vec3(max(abs(g.x) - R * 0.95, 0.0), g.y * 3.2, max(abs(g.z) - R * 0.14, 0.0)))
              - R * 0.15;

  float d = smin(body, fluke, R * 0.34);
  d = smin(d, dorsal, R * 0.16);
  d = smin(d, pec, R * 0.24);

  // Ventral pleats. A silhouette this smooth reads as a submarine without them,
  // and in a lunge they are the whole point — they are what is unfolding.
  float pleat = sin(p.z * (7.0 / R)) * (0.010 + gape * 0.030) * R
              * smoothstep(0.1, 0.75, t) * smoothstep(0.0, -0.4, p.y);
  return d + pleat;
}

/** A cheap bound so most pixels never march. */
vec2 hitBound(vec3 ro, vec3 rd, float R, float L) {
  vec3 semi = vec3(L * 1.15, R * 2.4, R * 2.2);
  vec3 o = ro / semi;
  vec3 d = rd / semi;
  float a = dot(d, d), b = 2.0 * dot(o, d), cc = dot(o, o) - 1.0;
  float disc = b * b - 4.0 * a * cc;
  if (disc < 0.0) return vec2(1.0, -1.0);
  float s = sqrt(disc);
  return vec2((-b - s) / (2.0 * a), (-b + s) / (2.0 * a));
}

/*
 * The attitude.
 *
 * Held broadside, a body seventy units long crossing a frame nine units wide is
 * a *band*: a cylinder seen from the side has no silhouette to read and its
 * back and belly come out as two straight bright lines. Yawed away, the animal
 * dives into the picture — the head is near and large, the body foreshortens,
 * and the tail goes into the dark where the extinction takes it. That turns a
 * stripe into a taper and gives the frame a depth axis it did not have.
 */
mat3 attitude(float yaw, float pitch, float roll) {
  float cy = cos(yaw), sy = sin(yaw);
  float cp = cos(pitch), sp = sin(pitch);
  float cr = cos(roll), sr = sin(roll);
  mat3 Y = mat3(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy);
  mat3 P = mat3(cp, -sp, 0.0, sp, cp, 0.0, 0.0, 0.0, 1.0);
  mat3 R = mat3(1.0, 0.0, 0.0, 0.0, cr, -sr, 0.0, sr, cr);
  return R * P * Y;
}

/*
 * The march, with a soft edge.
 *
 * A sphere tracer either hits or it does not, and on a curved silhouette that
 * binary answer is a staircase — clearly visible in the captures along the
 * animal's back, and it is the one artifact that says "raymarched" out loud.
 *
 * The fix costs nothing: the closest approach of every ray is already known,
 * because the tracer computed it on the way past. A ray that missed by less
 * than a fraction of the body's girth was aiming at the edge, and mixing it in
 * proportionally *is* the coverage an analytic edge would have had. It is
 * antialiasing paid for with a value that was being thrown away.
 */
bool march(vec3 ro, vec3 rd, vec3 c, float R, float L, float wave, float gape, mat3 att,
           out float tHit, out vec3 nrm, out vec3 lp, out float coverage) {
  coverage = 0.0;
  vec3 lo = att * (ro - c);
  vec3 ld = att * rd;
  vec2 b = hitBound(lo, ld, R, L);
  if (b.y < b.x || b.y < 0.0) return false;
  float t = max(b.x, 0.1);
  float nearest = 1e9;
  for (int i = 0; i < 52; i++) {
    vec3 q = lo + ld * t;
    float d = sdWhale(q, R, L, wave, gape);
    nearest = min(nearest, d);
    if (d < 0.02) {
      coverage = 1.0;
      tHit = t;
      lp = q;
      vec2 e = vec2(0.05, 0.0);
      vec3 n = normalize(vec3(
        sdWhale(q + e.xyy, R, L, wave, gape) - sdWhale(q - e.xyy, R, L, wave, gape),
        sdWhale(q + e.yxy, R, L, wave, gape) - sdWhale(q - e.yxy, R, L, wave, gape),
        sdWhale(q + e.yyx, R, L, wave, gape) - sdWhale(q - e.yyx, R, L, wave, gape)));
      // The attitude is a rotation, so its inverse is its transpose.
      nrm = transpose(att) * n;
      return true;
    }
    t += max(d * 0.7, 0.05);
    if (t > b.y) break;
  }
  // A near miss is the edge of the animal. The width is a fraction of the
  // girth, so it scales with the body rather than with the screen.
  coverage = 1.0 - smoothstep(0.0, R * 0.055, nearest);
  return false;
}

/**
 * The shading, which is almost entirely subtraction.
 *
 * No ambient term. A whale where there is no light is black, and this one is
 * black except for the rim — the field behind it, seen around the silhouette —
 * and whatever the wandering lamp is presently touching. The skin detail is
 * there in full at all times and is only ever *seen* inside that patch, which
 * is what makes the reveal worth waiting for.
 */
vec3 shade(vec3 p, vec3 lp, vec3 n, vec3 rd, vec3 tint, float mass, float flash,
           float R, float L, float gape) {
  // Fifth power: on a body this long most of the visible surface is at a
  // glancing angle, so a soft rim floods the flank instead of edging it.
  float fres = pow(1.0 - abs(dot(n, rd)), 5.0);

  float mottle = fbm(p * 0.075);
  float scars = smoothstep(0.56, 0.74, fbm(p * 0.30 + 11.0));
  float barnacle = smoothstep(0.68, 0.88, fbm(p * 1.10 + 31.0));
  float skin = 0.048 + mottle * 0.045 + scars * 0.085 + barnacle * 0.20;

  /*
   * The white right jaw.
   *
   * A fin whale is asymmetrically pigmented — the lower right jaw is pale and
   * the left is dark, and no other large animal is marked that way. It costs
   * two smoothsteps, it is only ever visible when the lamp is on the head, and
   * anyone who knows the species will know it on sight.
   */
  float t = lp.x / L * 0.5 + 0.5;
  float jaw = smoothstep(0.74, 0.92, t) * smoothstep(0.0, -0.35 * R, lp.y)
            * smoothstep(0.0, 0.45 * R, lp.z);
  skin += jaw * 0.42;

  vec3 toLight = uLight.xyz - p;
  float dist = length(toLight);
  float lambert = max(dot(n, toLight / dist), 0.0);
  // A tenth per unit: at thirty units from the source there is a twentieth of
  // the light left. That severity is what lights a patch of an animal rather
  // than an animal.
  float lit = uLight.w * lambert * exp(-dist * 0.075);

  vec3 col = tint * skin * lit * 1.7;
  col += tint * fres * (0.075 + mass * 0.115 + flash * 0.8);
  // A trace of scattering through the near surface: without it the unlit body
  // is pure black inside a bright contour, and a bright contour around nothing
  // is an *outline*, which would make this a drawing of a whale.
  float inner = pow(1.0 - abs(dot(n, rd)), 2.0);
  col += tint * inner * (0.016 + mass * 0.024);
  col += tint * flash * lambert * 0.5;
  // The distended throat catches what little light there is, because it is
  // stretched taut and pointing down at the field it is swallowing.
  col += tint * gape * smoothstep(0.0, -0.3 * R, lp.y) * 0.06;
  return col;
}

void main() {
  vec3 ro = uCam;
  vec3 rd = normalize(vWorld - uCam);

  /*
   * The backdrop: a vertical gradient carrying the warm/cold boundary, plus a
   * very faint wash at the top of the frame which is the surface three hundred
   * metres up. That wash is the only absolute direction in the picture and it
   * is what keeps the frame from being disorienting — there is a far above, and
   * it is out of reach.
   */
  float h = vWorld.y;
  vec3 cold = vec3(0.020, 0.055, 0.090);
  vec3 warm = vec3(0.075, 0.038, 0.030);
  float band = smoothstep(uBoundary - 7.0, uBoundary + 7.0, h);
  vec3 col = mix(cold, warm, band);
  col += vec3(0.016, 0.040, 0.062) * smoothstep(-6.0, 30.0, h);
  col *= 0.16;

  float mass = uBody.z;
  if (mass >= 0.03) {
    float gape = uMotion.y;
    float L = 13.0 + mass * 12.0;
    float R = 1.6 + mass * 2.0;
    // The breath: a forty-second cycle, two per cent of the girth. Below the
    // threshold of being noticed and above the threshold of being felt, which
    // is the whole specification for it.
    R *= 1.0 + 0.02 * sin(uTime * 2.0 * PI / 40.0);
    // The stroke deepens enormously in a lunge — this is an animal that has
    // just decided to move.
    float wave = R * (0.035 + gape * 0.55 + uBody.w * 0.20);

    vec3 c = vec3(uMotion.x, uBody.x, uBody.y);
    mat3 att = attitude(YAW_CONST + 0.10 * sin(uTime / 67.0),
                        -0.075 * sin(uTime / 53.0) - 0.04 + uMotion.w * 0.28,
                         0.14 * sin(uTime / 37.0) + 0.06);

    float t; vec3 n; vec3 lp; float coverage;
    vec3 tint = mix(vec3(0.34, 0.80, 1.0), vec3(1.0, 0.47, 0.26), uMotion.z);
    if (march(ro, rd, c, R, L, wave, gape, att, t, n, lp, coverage)) {
      vec3 p = ro + rd * t;
      vec3 hitCol = shade(p, lp, n, rd, tint, mass, uBody.w, R, L, gape);

      /*
       * Extinction, Beer-Lambert, doing two jobs.
       *
       * Physically it is why the deep sea looks like the deep sea: the water
       * between you and a thing removes its light exponentially and takes the
       * long wavelengths first, so what survives from far away is blue — which
       * is also why red is the wrong colour down here and why the ember side of
       * the palette reads as an intruder.
       *
       * Compositionally it is the veil that stops the animal ever being legible
       * all at once. It starts close, well inside the near end of the body, so
       * that the far half of a yawed whale is already gone while its head is
       * still sharp.
       */
      vec3 extinction = vec3(0.030, 0.018, 0.013);
      vec3 through = exp(-extinction * max(t - 34.0, 0.0));
      col = mix(col * (1.0 - 0.75 * (1.0 - through.b)), hitCol, through);
    } else if (coverage > 0.0) {
      // The feathered edge. A silhouette edge is dominated by the rim term
      // anyway — the flank behind it is at a grazing angle — so it is enough to
      // lay the rim colour in at partial strength rather than shade a surface
      // the ray never actually reached.
      float veil = exp(-0.013 * max(length(vWorld - uCam) * 2.0 - 34.0, 0.0));
      col = mix(col, tint * (0.10 + mass * 0.16), coverage * 0.55 * veil);
    }
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

export function createWhales(): Whales {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: FRAGMENT_SHADER.replace('YAW_CONST', YAW.toFixed(3)),
    uniforms: {
      uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uLight: { value: new THREE.Vector4() },
      uBoundary: { value: 0 },
      uBody: { value: new THREE.Vector4(0, -90, 0, 0) },
      uMotion: { value: new THREE.Vector4(0, 0, 0, 0) },
    },
    depthTest: false,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.z = PLANE_Z;
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;

  const state: WhaleState = {
    y: 0,
    mass: 0,
    distance: 0.5,
    warm: 0.5,
    flash: 0,
    lunge: 0,
    gape: 0,
    ascend: 0,
    cruise: 0,
  };

  const mouth = new THREE.Vector3();
  let depth = -90;

  /*
   * The backdrop quad has to cover the frustum, and it has to keep covering it.
   *
   * Sized once for a camera at the origin, it left a hard vertical seam down
   * the right of the frame the moment the observer drifted sideways — the edge
   * of the quad, with nothing behind it. The camera in this piece is never
   * still (core/observer.ts), so the quad follows its x and y and is cut with a
   * third again of margin for the small rotation the look-at adds.
   */
  function fitTo(camera: THREE.PerspectiveCamera): void {
    const span = camera.position.z - PLANE_Z;
    const height = 2 * Math.tan((camera.fov * Math.PI) / 360) * span;
    mesh.position.set(camera.position.x, camera.position.y, PLANE_Z);
    mesh.scale.set(height * camera.aspect * 1.35, height * 1.35, 1);
  }

  return {
    mesh,
    state,
    depth: () => depth,

    lungeAt() {
      state.lunge = 1;
      const L = 15 + state.mass * 15;
      // The mouth is at the front of the animal, along its own heading.
      mouth.set(state.cruise + Math.cos(YAW) * L * 0.95, state.y - 1.5, 0);
      return mouth;
    },

    fit(camera) {
      fitTo(camera);
    },

    update(dt, time, camera) {
      /*
       * The swim.
       *
       * It travels. Holding station was the single most common complaint from
       * watching it — two minutes of a body that never went anywhere — and a
       * whale that does not move is a model of a whale. Base speed is slow
       * enough to cross the frame in about a minute; a lunge multiplies it for
       * a couple of seconds, which is what makes the lunge look like effort.
       */
      const speed = 0.85 + state.mass * 0.4 + state.lunge * 8.0;
      state.cruise += speed * dt;
      /*
       * Twenty units either side, not forty-six.
       *
       * The frame is about thirty-six world units across at the depth the
       * animal holds, so a track of ninety spent most of its length off screen
       * — captures came back with an empty ocean, or with a tail cropped into a
       * corner. It should be *leaving* and *returning*, which needs a track a
       * little wider than the frame and no more.
       *
       * It reverses rather than wrapping, because an animal that reappears at
       * the opposite edge is a second animal, and there is only one.
       */
      const range = 21;
      if (state.cruise > range) state.cruise -= 2 * range;

      state.lunge = Math.max(0, state.lunge - dt / 2.4);
      // The gape lags the decision and closes more slowly than it opens, which
      // is what makes the pouch look heavy with water rather than elastic.
      const wanted = Math.sin(Math.min(1, state.lunge) * Math.PI) ** 0.6;
      state.gape += (wanted - state.gape) * (1 - Math.exp(-dt / (wanted > state.gape ? 0.28 : 0.9)));
      state.ascend = Math.max(0, state.ascend - dt / 26);
      state.flash *= Math.exp(-dt / 0.15);

      fitTo(camera);
      const u = material.uniforms;
      u.uTime.value = time;
      u.uCam.value.copy(camera.position);
      /*
       * Depth, and it carries meaning: a wall resting against the spread is the
       * one about to matter, and it is the one looming near. Mass pulls it
       * forward on top of that, and an ascent brings it nearer still.
       */
      // The near limit was -74 and the span 52, which put a typical wall at
      // about a hundred and thirty units — far enough that the veil took nearly
      // all of it and the animal was, for minutes at a time, simply not there.
      // Closer, and over a shorter range: still unreachable, but present.
      depth = -64 - state.distance * 34 + state.mass * 12 + state.ascend * 20;
      u.uBody.value.set(state.y + state.ascend * 9, depth, state.mass, state.flash);
      u.uMotion.value.set(state.cruise, state.gape, state.warm, state.ascend);
    },

    setLight(x, y, z, strength) {
      material.uniforms.uLight.value.set(x, y, z, strength);
    },

    setBoundary(y) {
      material.uniforms.uBoundary.value = y;
    },

    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
