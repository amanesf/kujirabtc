import * as THREE from 'three';

/**
 * The whales, and the backdrop they sit in.
 *
 * I argued at one point that the whale should not be drawn at all — that it
 * should be an absence, a hole the field is dimmer around. That was the safe
 * answer and it was wrong, for a reason worth writing down: an absence is a
 * single idea, and once the viewer has had it, it is spent. A body you can
 * almost resolve and never quite is inexhaustible.
 *
 * So there is a whale. It is anatomically real, it breathes, and it is *never
 * seen whole*:
 *
 *  - it is longer than the frame is wide, so both ends are always off screen —
 *    which is also what removes any sense of its scale (plan §1). Nothing in
 *    this picture has a known size, and the eye never stops trying to solve it.
 *  - it emits no light of its own. It is visible only where the moving light
 *    happens to be, and that light covers a few metres of a body that is
 *    hundreds long. You get a patch of skin — barnacles, an old scar, once in a
 *    while an eye — for two or three seconds, and then the dark.
 *  - the viewer assembles, over twenty minutes, a whale they have never seen.
 *
 * Its mass is the standing limit order behind it. Mass does not make it
 * brighter. It makes it *nearer, larger and darker*: a heavy bid is a bigger
 * silhouette occluding more of the field. That inversion — the more there is,
 * the less light — is where the unease in the piece comes from.
 */

export interface WhaleState {
  /** World Y of the level this body is sitting at. */
  y: number;
  /** 0..1 mass, from market/ocean.ts. */
  mass: number;
  /**
   * 0..1: how far this wall sits from the touch, across the visible book.
   *
   * It becomes *depth*, and that is not decoration. Two bodies at one distance
   * overlap into a single unreadable mass, and worse, the frame has no z axis
   * to read them apart with. Sending the far wall deeper fixes the composition
   * and says something true at the same time: a wall resting against the spread
   * is the one that is about to matter, and it is the one looming near.
   */
  distance: number;
  /** 0..1, decays. Set when a print goes off on this side. */
  flash: number;
}

export interface Whales {
  mesh: THREE.Mesh;
  /** Below the mid: the bid wall, cold. */
  bid: WhaleState;
  /** Above the mid: the ask wall, warm. */
  ask: WhaleState;
  update: (time: number, camera: THREE.PerspectiveCamera) => void;
  setLight: (x: number, y: number, z: number, strength: number) => void;
  setBoundary: (y: number) => void;
  /** Sizes the quad to exactly cover the frustum at its own depth. */
  fit: (camera: THREE.PerspectiveCamera) => void;
  dispose: () => void;
}

/** Where the quad sits. Behind everything the field can reach. */
const PLANE_Z = -18;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform float uTime;
uniform vec3 uCam;
uniform vec4 uLight;      // xyz world position, w strength
uniform float uBoundary;
uniform vec4 uBid;        // y, z, mass, flash
uniform vec4 uAsk;

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
 * The girth profile, from tail (0) to snout (1).
 *
 * Fitted by eye against a balaenopterid: the widest point is about two thirds
 * of the way forward, the peduncle in front of the flukes is very thin, and the
 * head does not come to a point — it is blunt and takes up nearly a third of
 * the animal. Getting the peduncle thin is what makes the silhouette read as a
 * whale rather than as a fish; it is the shape of the join, not the shape of
 * the body, that the eye recognises.
 */
float girth(float t) {
  float base = pow(max(0.0, sin(PI * pow(clamp(t, 0.0, 1.0), 0.78))), 0.52);
  float snout = smoothstep(1.0, 0.86, t);       // blunts the nose
  float peduncle = smoothstep(0.0, 0.20, t);    // thins the tail stock
  return base * mix(0.55, 1.0, snout) * mix(0.22, 1.0, peduncle);
}

/**
 * The body, in the animal's own frame — and every length in here is in world
 * units, including x.
 *
 * The first version normalised x by the half-length and left y and z in world
 * units, which is a units bug with two symptoms that look nothing alike. The
 * loud one: a fin whose extent was written as R * 0.62 came out R * 0.62 * L
 * long, so the pectorals were sheets a hundred units across and the captures had
 * flat blue slabs in them. The quiet one: the field was then Lipschitz-L along
 * the body, so the sphere tracer overstepped and faceted the flanks. One fix
 * for both.
 */
float sdWhale(vec3 p, float R, float L, float wave) {
  // The swimming stroke: a travelling wave, biggest at the tail and absent at
  // the head, because that is how a whale is propelled. The amplitude is tiny —
  // this animal is holding station, not travelling.
  float amp = wave * smoothstep(0.55 * L, -L, p.x);
  p.y -= sin(p.x * (1.7 / L) * PI - uTime * 0.55) * amp;

  float t = p.x / L * 0.5 + 0.5;
  float r = girth(t) * R;
  // The cross-section is not round: whales are slightly taller than wide, and
  // the belly is flatter than the back.
  vec2 yz = vec2(p.y * (p.y > 0.0 ? 0.92 : 1.08), p.z * 1.06);
  float body = length(yz) - r;
  body += max(abs(p.x) - L, 0.0);

  // The flukes: a thin horizontal blade behind the peduncle.
  vec3 f = p - vec3(-L * 1.02, 0.0, 0.0);
  float fluke = length(vec3(max(abs(f.x) - R * 0.55, 0.0),
                            f.y * 4.2,
                            max(abs(f.z) - R * 1.7 * smoothstep(R * 1.1, 0.0, abs(f.x)), 0.0)))
                - R * 0.16;

  // One pectoral fin, the near one only. The far one is never lit and costs a
  // distance evaluation to be invisible.
  vec3 g = p - vec3(L * 0.30, -R * 0.55, R * 0.62);
  g.xz = mat2(0.86, -0.51, 0.51, 0.86) * g.xz;
  float pec = length(vec3(max(abs(g.x) - R * 0.95, 0.0), g.y * 3.2, max(abs(g.z) - R * 0.14, 0.0)))
              - R * 0.15;

  float d = smin(body, fluke, R * 0.34);
  d = smin(d, pec, R * 0.24);

  // Ventral pleats, and they are the reason the animal survives being lit up
  // close: a smooth silhouette at this size reads as a submarine. Only on the
  // throat, only in front of the widest point.
  float pleat = sin(p.z * (7.0 / R)) * 0.010 * R
              * smoothstep(0.1, 0.75, t) * smoothstep(0.0, -0.4, p.y);
  return d + pleat;
}

/** A cheap bound so most pixels never march: the body fits inside this. */
vec2 hitBound(vec3 ro, vec3 rd, float R, float L) {
  vec3 semi = vec3(L * 1.15, R * 1.9, R * 1.9);
  vec3 o = ro / semi;
  vec3 d = rd / semi;
  float a = dot(d, d), b = 2.0 * dot(o, d), cc = dot(o, o) - 1.0;
  float disc = b * b - 4.0 * a * cc;
  if (disc < 0.0) return vec2(1.0, -1.0);
  float s = sqrt(disc);
  return vec2((-b - s) / (2.0 * a), (-b + s) / (2.0 * a));
}

/*
 * The attitude of the animal, and this is the correction that finally made it
 * an animal.
 *
 * Held level and broadside, a body seventy units long crossing a frame nine
 * units wide is a *band*: a cylinder seen from the side has no silhouette to
 * read, its back and its belly come out as two straight bright lines, and no
 * amount of shading will make it anything but a stripe.
 *
 * The fix is yaw. Turned thirty or forty degrees away, the animal is diving
 * *into* the picture: the head is near and large, the body foreshortens, and
 * the tail goes into the dark where the extinction takes it. The silhouette
 * becomes a taper instead of a stripe, the frame gains a depth axis it did not
 * have, and — the part that matters most — the far end is now unreachable
 * rather than merely cropped.
 *
 * Roll and pitch are small on top of it, on periods that share no common
 * multiple, so no two moments show the same arrangement.
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

/**
 * The march, done entirely in the animal's own frame.
 *
 * The ray is rotated once on the way in rather than the body being rotated at
 * every step, which is both cheaper and the only way the bounding test stays
 * tight: an axis-aligned ellipsoid around a yawed body would be several times
 * the volume, and the bound is what keeps most of the screen from marching at
 * all.
 */
bool march(vec3 ro, vec3 rd, vec3 c, float R, float L, float wave, mat3 att,
           out float tHit, out vec3 nrm) {
  vec3 lo = att * (ro - c);
  vec3 ld = att * rd;
  vec2 b = hitBound(lo, ld, R, L);
  if (b.y < b.x || b.y < 0.0) return false;
  float t = max(b.x, 0.1);
  for (int i = 0; i < 48; i++) {
    vec3 lp = lo + ld * t;
    float d = sdWhale(lp, R, L, wave);
    if (d < 0.02) {
      tHit = t;
      vec2 e = vec2(0.05, 0.0);
      vec3 n = normalize(vec3(
        sdWhale(lp + e.xyy, R, L, wave) - sdWhale(lp - e.xyy, R, L, wave),
        sdWhale(lp + e.yxy, R, L, wave) - sdWhale(lp - e.yxy, R, L, wave),
        sdWhale(lp + e.yyx, R, L, wave) - sdWhale(lp - e.yyx, R, L, wave)));
      // Back into world space. The attitude is a rotation, so its inverse is
      // its transpose and no matrix has to be inverted at runtime.
      nrm = transpose(att) * n;
      return true;
    }
    t += max(d * 0.7, 0.05);
    if (t > b.y) break;
  }
  return false;
}

/**
 * The shading, and it is almost entirely subtraction.
 *
 * There is no ambient term. A whale in a place with no light is black, and this
 * one is black except for two things: a rim where the water behind it scatters
 * around the silhouette, and whatever the moving light is presently touching.
 * The skin detail exists in full at all times and is *only ever seen inside the
 * lit patch*, which is what makes the reveal worth waiting for.
 */
vec3 shade(vec3 p, vec3 n, vec3 rd, vec3 tint, float mass, float flash) {
  // Fifth power, not third. On a body this long most of the visible surface is
  // at a glancing angle, so a soft rim term does not sit at the edges — it
  // floods the whole flank with an even wash, which is precisely the painted
  // stripe the captures kept showing.
  float fres = pow(1.0 - abs(dot(n, rd)), 5.0);

  // The frequencies matter as much as the amounts: at the first attempt these
  // were three times higher and the body came out in hard blotches, because a
  // tight smoothstep on a high-frequency fbm across an animal sixty units long
  // is a threshold crossing every few pixels. Low and soft.
  float mottle = fbm(p * 0.075);
  float scars = smoothstep(0.56, 0.74, fbm(p * 0.30 + 11.0));
  float barnacle = smoothstep(0.68, 0.88, fbm(p * 1.10 + 31.0));
  float skin = 0.048 + mottle * 0.045 + scars * 0.085 + barnacle * 0.20;

  // The moving light: a small, close source, so its falloff is severe and the
  // patch it makes is a few per cent of the body.
  vec3 toLight = uLight.xyz - p;
  float dist = length(toLight);
  float lambert = max(dot(n, toLight / dist), 0.0);
  // A tenth per unit: at thirty units from the source there is a twentieth of
  // the light left. That severity is the whole reveal — it is what makes the
  // lamp illuminate a patch of an animal rather than an animal.
  float lit = uLight.w * lambert * exp(-dist * 0.10);

  vec3 col = tint * skin * lit * 2.6;
  // The rim is the only thing keeping an unlit body from being a hole, so it
  // has to be there — but it was three times this at first and it filled the
  // whole flank, which is how a cylinder ends up looking like a painted stripe.
  // It is not the animal glowing: it is the field behind it seen around the
  // edge, so it carries the water's colour rather than the body's.
  col += tint * fres * (0.045 + mass * 0.075 + flash * 0.8);
  /*
   * A trace of scattering through the near surface.
   *
   * Without it the unlit body is pure black inside a bright contour, and a
   * bright contour around nothing is an *outline* — the one thing that would
   * make this read as a drawing of a whale rather than a whale. A second-power
   * falloff off the rim, at a twentieth of its strength, is enough to give the
   * flank somewhere to go.
   */
  float inner = pow(1.0 - abs(dot(n, rd)), 2.0);
  col += tint * inner * (0.008 + mass * 0.014);
  // The flash of a print landing on this side: it lights the near flank from
  // in front for a fifth of a second (plan §7, the first of the three speeds).
  col += tint * flash * lambert * 0.5;
  return col;
}

void main() {
  vec3 ro = uCam;
  vec3 rd = normalize(vWorld - uCam);

  /*
   * The backdrop.
   *
   * A vertical gradient with the warm/cold boundary in it (plan §8) so that the
   * water itself, and not only the particles, reports which side is winning —
   * and a very faint wash at the top of the frame, which is the surface three
   * hundred metres up. That wash is the only absolute direction in the picture
   * and it is what stops the frame from being disorienting: there is a *far
   * above*, and it is unreachable.
   */
  float h = vWorld.y;
  vec3 cold = vec3(0.020, 0.055, 0.090);
  vec3 warm = vec3(0.075, 0.038, 0.030);
  float band = smoothstep(uBoundary - 7.0, uBoundary + 7.0, h);
  vec3 col = mix(cold, warm, band);
  // The surface, three hundred metres up. It has to be barely there: at any
  // strength you would call "visible" it lifts the top third of the frame off
  // black, and the blacks are ninety per cent of this picture.
  col += vec3(0.016, 0.040, 0.062) * smoothstep(-6.0, 30.0, h);
  col *= 0.16;

  // Two bodies, drawn far to near so the nearer one covers the further.
  float mass[2]; float ypos[2]; float zpos[2]; float flash[2];
  mat3 att[2];
  mass[0] = uBid.z; ypos[0] = uBid.x; zpos[0] = uBid.y; flash[0] = uBid.w;
  mass[1] = uAsk.z; ypos[1] = uAsk.x; zpos[1] = uAsk.y; flash[1] = uAsk.w;
  // Yawed hard away from broadside, and the two of them the opposite way, so
  // the picture never has two parallel bodies in it. The periods share no
  // common multiple, so the arrangement never repeats.
  att[0] = attitude(0.62 + 0.13 * sin(uTime / 67.0),
                   -0.085 * sin(uTime / 53.0) - 0.05,
                    0.16 * sin(uTime / 37.0) + 0.07);
  att[1] = attitude(-0.78 + 0.11 * sin(uTime / 71.0),
                     0.095 * sin(uTime / 61.0) + 0.055,
                    -0.14 * sin(uTime / 41.0) - 0.06);

  float best = 1e9;
  vec3 hitCol = vec3(0.0);
  bool any = false;

  for (int i = 0; i < 2; i++) {
    float m = mass[i];
    if (m < 0.03) continue;
    /*
     * Mass -> geometry, and this is the inversion the whole concept turns on.
     *
     * A heavier wall is not a brighter whale. It is a *longer and nearer* one,
     * which means it covers more of the field, occludes more bioluminescence,
     * and leaves the frame darker than it found it. Watching a bid wall build
     * is watching the light go out.
     */
    float L = 15.0 + m * 15.0;
    /*
     * The girth, and the first version had it at a third of this.
     *
     * At R = 1.5 a maximal wall was a body four world units thick inside a
     * frame forty-four units tall — a sliver, invisible under the veil, and
     * nothing anyone would call a whale. The animal has to be large enough that
     * its *back alone* fills a good part of the frame, because the concept is
     * that you never see all of it.
     */
    float R = 1.9 + m * 2.6;
    // Laterally offset as well, and to opposite sides, so the two silhouettes
    // cross the frame at different places rather than stacking.
    vec3 c = vec3(mix(11.0, -13.0, float(i)), ypos[i], zpos[i]);
    // The breath: a forty-second cycle, two per cent of the girth. It is below
    // the threshold of being noticed and above the threshold of being felt,
    // which is the entire specification for it (plan §4).
    R *= 1.0 + 0.02 * sin(uTime * 2.0 * PI / 40.0 + float(i) * 2.1);
    float wave = R * (0.035 + flash[i] * 0.35);

    float t; vec3 n;
    if (march(ro, rd, c, R, L, wave, att[i], t, n)) {
      if (t < best) {
        best = t;
        vec3 p = ro + rd * t;
        vec3 tint = i == 0 ? vec3(0.34, 0.80, 1.0) : vec3(1.0, 0.47, 0.26);
        hitCol = shade(p, n, rd, tint, m, flash[i]);
        any = true;
      }
    }
  }

  if (any) {
    /*
     * Extinction, Beer-Lambert, and it is doing two jobs.
     *
     * Physically it is why the deep sea looks like the deep sea: the water
     * between you and a thing removes its light exponentially, and it removes
     * the long wavelengths first, so what survives from far away is blue. That
     * is the whole reason red is the wrong colour down here and why the ember
     * side of the palette reads as an intruder.
     *
     * Compositionally it is the veil that keeps the animal from ever being
     * fully legible. At this depth the far end of a body is simply gone.
     */
    /*
     * Extinction, Beer-Lambert, doing two jobs.
     *
     * Physically it is why the deep sea looks like the deep sea: the water
     * between you and a thing removes its light exponentially and removes the
     * long wavelengths first, so what survives from far away is blue — which is
     * also why red is the wrong colour down here and why the ember side of the
     * palette reads as an intruder.
     *
     * Compositionally it is the veil that keeps the animal from ever being
     * legible all at once. It starts close (34 units, well inside the near end
     * of the body) precisely so that the far half of a yawed animal is already
     * gone while the head is still sharp.
     */
    vec3 extinction = vec3(0.030, 0.018, 0.013);
    vec3 through = exp(-extinction * max(best - 34.0, 0.0));
    col = mix(col * (1.0 - 0.75 * (1.0 - through.b)), hitCol, through);
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
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uLight: { value: new THREE.Vector4() },
      uBoundary: { value: 0 },
      uBid: { value: new THREE.Vector4(-6, -40, 0, 0) },
      uAsk: { value: new THREE.Vector4(6, -40, 0, 0) },
    },
    depthTest: false,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.z = PLANE_Z;
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;

  const bid: WhaleState = { y: -6, mass: 0, distance: 0.5, flash: 0 };
  const ask: WhaleState = { y: 6, mass: 0, distance: 0.5, flash: 0 };

  return {
    mesh,
    bid,
    ask,

    fit(camera) {
      const dist = camera.position.z - PLANE_Z;
      const height = 2 * Math.tan((camera.fov * Math.PI) / 360) * dist;
      mesh.scale.set(height * camera.aspect * 1.02, height * 1.02, 1);
    },

    update(time, camera) {
      const u = material.uniforms;
      u.uTime.value = time;
      u.uCam.value.copy(camera.position);
      // Mass pulls the body forward out of the dark. The near limit is chosen
      // so that even a maximal wall never comes close enough to be resolved:
      // there is no distance at which you get to see the whole animal.
      /*
       * Depth, and it is the correction that mattered most.
       *
       * The first version put the bodies at z = -34, which at this field of
       * view meant a maximal wall covered most of a phone screen — two enormous
       * flat shapes, evenly lit, with nothing left to imagine. They belong far
       * enough back that even the heaviest of them is a shape the frame cannot
       * contain and the eye cannot total up.
       */
      /*
       * Depth: near limit -74, far limit about -135, and the two bodies are
       * offset by a further eight units so that even two walls at the same
       * distance from the touch are never at the same depth. Mass pulls a body
       * forward on top of that, so the heaviest thing in the picture is also
       * the nearest — which is the reading you want, and the one that makes it
       * loom.
       */
      u.uBid.value.set(bid.y, -74 - bid.distance * 52 + bid.mass * 14, bid.mass, bid.flash);
      u.uAsk.value.set(ask.y, -82 - ask.distance * 52 + ask.mass * 14, ask.mass, ask.flash);
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
