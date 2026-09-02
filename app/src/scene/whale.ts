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
  /** Where the animal is in the five phases of a lunge (plan §13.3.2). */
  phase: LungePhase;
  /** Seconds spent in the present phase. */
  phaseT: number;
  /** 0..1 how committed the present lunge is. Drives the stroke's depth. */
  lunge: number;
  /** The jaw, 0 shut and 1 open. Lags the decision in both directions. */
  gape: number;
  /** Multiplier on cruise speed, eased. Positive is a charge, negative a brake. */
  boost: number;
  /** 0..1 how far the lunge has brought it toward the glass. Eased. */
  near: number;
  /** 0..1 how hard it is presently working. Drives the beat and the wake. */
  effort: number;
  /** 0..1: the rare ascent (plan §3). */
  ascend: number;
  /** Where along its own track it presently is, world units. */
  cruise: number;
  /** The tail beat, in radians. Integrated, so the rate can change under it. */
  stroke: number;
  /** 0 while headed one way, 1 the other. Eased through the turn, never snapped. */
  turn: number;
  /** Which end of the track it is presently making for. */
  turnTarget: 0 | 1;
}

/**
 * The five phases, and the order matters because the old one was wrong.
 *
 * What was here was a single envelope — lunge = 1, then 2.4 seconds of linear
 * decay — with the mouth opening *while the body was still accelerating*,
 * which is backwards for the animal and backwards for the picture. A rorqual
 * opens at the end of the charge, and the moment that reads as feeding is not
 * the acceleration but the stop: the filled pouch is a parachute and a fin
 * whale comes very nearly to a halt in a second.
 *
 *   aim      up to 3s   turn toward the middle of the track if facing away
 *   run      2–4s       accelerate; the stroke deepens on its own with effort
 *   engulf   1.5s       fires on *reaching the centre*, not on a timer, and
 *                       brakes hard. This is the moment
 *   recover  8s         the pouch drains and the body returns to cruise
 *
 * Opening on position rather than on elapsed time is also what quietly fixes
 * the third complaint from watching it: the event cannot happen at the ends of
 * the track any more, so the animal is never cropped by the frame while doing
 * the one thing worth watching.
 */
export type LungePhase = 'none' | 'aim' | 'run' | 'engulf' | 'recover';

export interface Whales {
  mesh: THREE.Mesh;
  state: WhaleState;
  /** Asks for a lunge. What happens next is up to the phase machine. */
  beginLunge: (power: number) => void;
  /**
   * Called on the frame the jaw opens, with the mouth in the animal's own
   * space. main.ts is what turns that into water, a shock and a shove.
   */
  setOnEngulf: (fn: (mouth: THREE.Vector3, power: number) => void) => void;
  /** The mouth's present position, in the animal's own space. */
  mouth: (out: THREE.Vector3) => THREE.Vector3;
  /** The body's present girth, in world units. Sizes the mouth's reach. */
  girth: () => number;
  /** The flukes' present position, in the animal's own space. */
  tail: (out: THREE.Vector3) => THREE.Vector3;
  /** Unit heading in the animal's own space: which way the body is pointed. */
  headingX: () => number;
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
uniform vec4 uSwim;       // yaw added by the turn, bank roll, stroke phase, effort 0..1

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
  /*
   * The stroke: a travelling wave, largest at the flukes and zero at the head,
   * because that is how a whale is driven.
   *
   * The phase arrives from the CPU rather than being read off uTime here. It
   * has to: the beat rate follows how hard the animal is working, and a rate
   * that multiplies the clock — sin(k*x - w*uTime) — jumps the phase the
   * instant w changes — the tail teleports mid-beat every time the animal
   * accelerates. Integrating the rate instead keeps the beat continuous
   * through any change of speed, which is the whole point of tying it to
   * speed at all.
   */
  float amp = wave * smoothstep(0.5 * L, -L, p.x);
  p.y -= sin(p.x * (1.7 / L) * PI - uSwim.z) * amp;

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

  /*
   * The mouth, which did not exist.
   *
   * The body was head, flukes, dorsal, pectoral and pleats — no opening
   * anywhere — so a "lunge" was a throat that swelled downward while the face
   * stayed shut. That is almost certainly the largest single reason it did not
   * read as feeding: a whale with a closed mouth is a whale that is not eating,
   * whatever else is happening to it.
   *
   * It is cut rather than modelled: the intersection of three half-spaces —
   * forward of a hinge at t = 0.78, below the palate, and above a lower jaw
   * plane rotated open by the gape — subtracted from the body. A max of plane
   * distances stays Lipschitz, which the sphere tracer requires and which a
   * rotated sampling coordinate would have broken (that bug is already in the
   * record once, as the faceted flanks).
   *
   * Nothing lights the inside. The shading here has no ambient term at all, so
   * the cavity comes out as an actual hole in the animal — which is what an
   * open mouth is, and it costs three dot products.
   */
  vec2 q = vec2(p.x - L * 0.56, p.y);
  float ang = gape * 1.15;
  vec2 nJaw = vec2(sin(ang), cos(ang));
  float cavity = max(max(q.y + R * (0.015 + gape * 0.05), -dot(q, nJaw)), -q.x);
  // Never wider than the head it is cut into, or the jaw would open the flanks.
  cavity = max(cavity, abs(p.z) - r * 0.92);
  body = max(body, -cavity);

  /*
   * The flukes, pitched.
   *
   * They were a rigid horizontal blade carried along by the body's wave, which
   * is a paddle being slid through water rather than a tail: a fluke works
   * because it meets the water at an *angle*, and the angle is the slope of
   * the very wave that is already being applied. Taking that slope at the
   * fluke's own station gives a rigid rotation — the same everywhere on the
   * blade, so the distance field stays isometric — and the blade now leads and
   * feathers through each beat the way a real one does. It is the single
   * cheapest thing that separates swimming from being towed.
   */
  float k = (1.7 / L) * PI;
  float fx = -L * 1.02;
  float slope = cos(fx * k - uSwim.z) * wave * smoothstep(0.5 * L, -L, fx) * k;
  float pitch = atan(slope) * 0.85;
  vec3 f = p - vec3(-L * 1.02, 0.0, 0.0);
  f.xy = mat2(cos(pitch), -sin(pitch), sin(pitch), cos(pitch)) * f.xy;
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
  /*
   * The ventral grooves, at twice the depth and reaching further round.
   *
   * These are the most beautiful thing about a rorqual at close range — fifty
   * or so parallel furrows running from the chin to the navel — and they were
   * one per cent of the girth at seven cycles across it, which is invisible at
   * a distance and, once the animal came close, a set of wide bands like a
   * beach ball. Twenty cycles is the right count for the animal; the amplitude
   * comes down to match so that the product of the two — which is all the
   * distance field cares about — stays small, well inside what a sphere tracer
   * will follow.
   *
   * And they were in the wrong half of the animal. t is zero at the *flukes*,
   * so a mask of smoothstep(0.05, 0.75, t) carved them from the tail stock
   * forward to mid-body — a striped back end, which no rorqual has and which
   * turned into a zebra the moment the rim was raised, because every crest
   * caught its own contour. They run from the chin to about the navel, which
   * is t from roughly 0.95 down to 0.5, and nowhere else.
   */
  float pleat = sin(p.z * (20.0 / R)) * (0.006 + gape * 0.012) * R
              * smoothstep(0.42, 0.58, t) * smoothstep(0.99, 0.90, t)
              * smoothstep(0.15 * R, -0.4 * R, p.y);
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
  /*
   * The step floor and the hit threshold are fractions of the *girth*, not
   * absolute distances, and that is the whole of a bug that only appeared once
   * the animal came close.
   *
   * At 0.02 world units a ray grazing a body that fills half the frame takes
   * hundreds of ever-smaller steps along the flank and runs out of iterations
   * before it ever gets under the threshold. The tracer then reports a *miss*
   * with a tiny closest approach — which the edge feather below reads as full
   * coverage and paints with a flat rim colour. The result is a pale wedge
   * with a staircase along its boundary, sitting exactly where the animal
   * should be: the jagged blob in the captures was never a shading problem, it
   * was every one of those pixels failing to converge.
   *
   * Scaled to the body, the step count needed is the same whether the whale is
   * forty units away or a hundred, which is what it should have been from the
   * start.
   */
  float t = max(b.x, 0.1);
  float nearest = 1e9;
  float eps = R * 0.016;
  for (int i = 0; i < 100; i++) {
    vec3 q = lo + ld * t;
    float d = sdWhale(q, R, L, wave, gape);
    nearest = min(nearest, d);
    if (d < eps) {
      coverage = 1.0;
      tHit = t;
      lp = q;
      // Half what it was. The normal is a difference over this distance, and
      // at the silhouette — where the surface curves away fastest — too wide a
      // stencil returns a direction that jitters from pixel to pixel. With the
      // rim now keyed to exactly that angle, the jitter shows up as black
      // speckle along the contour.
      vec2 e = vec2(max(0.02, R * 0.012), 0.0);
      vec3 n = normalize(vec3(
        sdWhale(q + e.xyy, R, L, wave, gape) - sdWhale(q - e.xyy, R, L, wave, gape),
        sdWhale(q + e.yxy, R, L, wave, gape) - sdWhale(q - e.yxy, R, L, wave, gape),
        sdWhale(q + e.yyx, R, L, wave, gape) - sdWhale(q - e.yyx, R, L, wave, gape)));
      // The attitude is a rotation, so its inverse is its transpose.
      nrm = transpose(att) * n;
      return true;
    }
    t += max(d * 0.75, R * 0.010);
    if (t > b.y) break;
  }
  // A near miss is the edge of the animal. The width is a fraction of the
  // girth, so it scales with the body rather than with the screen.
  // A genuine near miss only. Anything closer than the hit threshold that got
  // here ran out of iterations rather than passing the body by, and letting it
  // count as full coverage is what filled the silhouette with flat colour.
  coverage = (1.0 - smoothstep(eps, R * 0.055, nearest)) * 0.9;
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
  /*
   * Two rims, not one.
   *
   * The fifth power is a *flood*: on a body this long most of the visible
   * surface is at a glancing angle, so it washes the whole flank faintly — and
   * that is what gives the animal its volume. What it cannot do is draw a
   * line, because by the time it is bright enough to be one it has lifted the
   * entire flank with it.
   *
   * So the contour is a second term at a much higher power, which is nothing
   * anywhere except in the last few degrees before the silhouette. The flood
   * says how big the body is; the line says exactly where it ends. Together
   * they are the picture the piece is actually about: a shape you can read the
   * edge of and cannot see the inside of.
   */
  float graze = 1.0 - abs(dot(n, rd));
  float fres = pow(graze, 5.0);
  float edge = pow(graze, 14.0);

  /*
   * Three scales of skin, because the body is now seen from forty units as
   * well as from a hundred.
   *
   * Every frequency here was low: the coarsest mottle has features thirteen
   * units across on a flank seven units wide, so close up the whole animal
   * came out as one flat tone — a smooth pale balloon with no surface on it at
   * all. A body needs detail at the scale you are looking at it, and the grain
   * is what the eye reads as *skin* rather than as a shaded solid.
   */
  float mottle = fbm(p * 0.075);
  float grain = fbm(p * 3.10 + 7.0) - 0.5;
  float scars = smoothstep(0.56, 0.74, fbm(p * 0.30 + 11.0));
  float barnacle = smoothstep(0.68, 0.88, fbm(p * 1.10 + 31.0));
  /*
   * 0.06, not 0.20.
   *
   * At four times the base albedo the barnacles *were* the skin: every lit
   * patch came back as mottled grey rock, and a grey rock is the one thing a
   * body must not look like. They are an accent on an animal, not its
   * material.
   */
  float skin = 0.048 + mottle * 0.045 + scars * 0.085 + barnacle * 0.06 + grain * 0.034;

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

  /*
   * The eye. It is small, it is where a rorqual's is — just above and behind
   * the corner of the mouth — and it is the only part of this animal that is
   * *black on purpose*. A body with an eye is looked at differently from a
   * body without one, and the whole design of the reveal is that the lamp
   * eventually lands on the head; when it does, this is what it finds.
   */
  vec3 eyeAt = vec3(L * 0.53, -R * 0.30, R * 0.60);
  float eye = 1.0 - smoothstep(R * 0.05, R * 0.11, length(lp - eyeAt));
  skin *= 1.0 - eye * 0.92;

  /*
   * Countershading, which is the strongest identification cue a marine animal
   * has and costs one smoothstep: dark along the back, pale underneath. Every
   * animal that swims in open water is painted this way, because it is what
   * cancels the light coming from above — and the eye knows it well enough
   * that its absence is what made this body read as an object rather than as
   * a fish-shaped thing that is alive.
   */
  float ventral = smoothstep(0.45 * R, -0.55 * R, lp.y);
  skin *= mix(0.60, 1.30, ventral);

  vec3 toLight = uLight.xyz - p;
  float dist = length(toLight);
  float lambert = max(dot(n, toLight / dist), 0.0);
  /*
   * 0.13 per unit, not 0.075 — and this is what a lamp anchored to the animal
   * costs.
   *
   * While the lamp wandered the world it was rarely near the body and the
   * falloff barely mattered. Put it on the animal (which is the fix that made
   * the whale visible at all) and 0.075 lights everything: across a body forty
   * units long the near end and the far end differ by less than four to one,
   * so the entire whale came up at once, evenly, with no gradient anywhere —
   * and a surface with no gradient has no form. §2's reveal was gone in the
   * same stroke that made the animal present.
   *
   * At 0.13 the same span is a factor of thirteen. The patch has an inside and
   * an outside again, the roll of the flank is legible inside it, and the
   * intensity is raised to pay for the light being thrown away.
   */
  float lit = uLight.w * lambert * exp(-dist * 0.13);
  // Heavier is darker (plan §6): the wall that matters most takes the most
  // light out of the picture, rather than announcing itself with more of it.
  lit *= mix(1.0, 0.62, mass);

  /*
   * 26, and the number matters less than what it is against.
   *
   * The lit patch was worth about 0.02 and the rim below was worth 0.18, so
   * the animal was being *drawn by its own silhouette*: every grazing surface
   * glowed, the flukes and the flank came out as outlines with nothing inside
   * them, and the result read first as a pale slab and then, once the lamp was
   * tightened, as an X-ray. Neither is a whale.
   *
   * The right relation is the one a torch in dark water actually gives: the
   * lit part is by far the brightest thing on the body, the rim is a thin
   * edge, and everything outside the patch is black. So the patch is worth
   * about a quarter — bright, and still under the bloom threshold of 0.48, so
   * the animal never blooms and the water still does.
   */
  /*
   * 26, softly clamped.
   *
   * The lit patch has to be by far the brightest thing on the body — it was
   * worth a fiftieth of the rim, which is why the animal came out as an
   * outline with nothing inside it — but it must never cross the bloom
   * threshold of 0.48, because a whale that blooms is a lamp, and the only
   * things allowed to glow in this ocean are strained water and the creatures
   * that live in it. The rolloff holds the brightest skin just under a third
   * however close the lamp gets, so approaching the glass cannot wash the
   * animal out.
   */
  float body = skin * lit * 13.0;
  vec3 col = tint * (body / (1.0 + body * 4.6));
  /*
   * One narrow specular. Almost the entire visual difference between wet skin
   * and stone is the width of the highlight: a broad one is rock, a tight one
   * is something with a film of water on it. It is tinted toward white rather
   * than toward the body, because a reflection is the colour of the *light*.
   */
  vec3 hv = normalize(normalize(toLight) - rd);
  col += mix(tint, vec3(1.0), 0.6) * pow(max(dot(n, hv), 0.0), 64.0) * lit * 0.7;
  /*
   * The rim carries the animal, and the lit skin only says what it is made of.
   *
   * There is a balance to find here and it has been wrong in both directions.
   * All rim and no skin is an X-ray — a contour with nothing inside it. All
   * skin and no rim is a lump of wet rock with a torch on it, which is
   * accurate and completely unmysterious. What is wanted is the edge doing
   * most of the describing, with just enough inside the lit patch to know that
   * it is skin: a body you can see the *shape* of and cannot quite see.
   */
  col += tint * fres * (0.150 + mass * 0.130 + flash * 0.5);
  /*
   * The line, and it is allowed to bloom.
   *
   * Everywhere else this file is careful to keep the animal under the bloom
   * threshold, because a whale that glows is a lamp. The last degree of the
   * silhouette is the exception: a contour that just crosses it picks up a
   * thread of halo from the post chain, which is what light scattering round
   * the edge of a large body in water actually looks like — and it is the one
   * place the glow describes the animal rather than replacing it. Cooled
   * toward white, because scattered light loses the body's colour.
   */
  col += mix(tint, vec3(0.74, 0.94, 1.0), 0.55) * edge * (0.24 + mass * 0.22);
  // A trace of scattering through the near surface: without it the unlit body
  // is pure black inside a bright contour, and a bright contour around nothing
  // is an *outline*, which would make this a drawing of a whale.
  float inner = pow(1.0 - abs(dot(n, rd)), 2.0);
  // Halved. It is meant to keep the unlit body off pure black so that the rim
  // is not an outline; at the old strength it was a flat glow over every
  // grazing surface, which on a body filling half the frame is most of it —
  // the milky slab in the captures was largely this term.
  col += tint * inner * (0.009 + mass * 0.011);
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
    /*
     * How deep the tail swings.
     *
     * This was 0.035 of the girth at cruise, which on a body of this size is
     * a couple of centimetres of fluke travel — below the threshold of being
     * seen at all. The animal was therefore *stationary except when feeding*,
     * and a body that holds still while its position changes does not read as
     * an animal; it reads as a model being slid across the frame. A fin whale
     * carries a fluke excursion of something like a tenth of its own length
     * peak to peak, which for these proportions is around a third of the
     * girth in each direction. The base is set below that and the rest is
     * bought with effort, because the reserve has to be visible: a cruising
     * animal that is already thrashing has nowhere to go when it lunges.
     */
    float wave = R * (0.17 + uSwim.w * 0.15 + gape * 0.55 + uBody.w * 0.20);

    vec3 c = vec3(uMotion.x, uBody.x, uBody.y);
    mat3 att = attitude(YAW_CONST + uSwim.x + 0.10 * sin(uTime / 67.0),
                        -0.075 * sin(uTime / 53.0) - 0.04 + uMotion.w * 0.28,
                         0.14 * sin(uTime / 37.0) + 0.06 + uSwim.y);

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
      // Matched to the rim just inside it: left where it was, the antialiased
      // outer edge came out darker than the contour it is supposed to be the
      // fringe of, which puts a thin dark seam around a bright line.
      col = mix(col, tint * (0.20 + mass * 0.30), coverage * 0.55 * veil);
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
      uSwim: { value: new THREE.Vector4(0, 0, 0, 0) },
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
    phase: 'none',
    phaseT: 0,
    lunge: 0,
    gape: 0,
    boost: 0,
    near: 0,
    effort: 0,
    ascend: 0,
    cruise: 0,
    stroke: 0,
    turn: 0,
    turnTarget: 1,
  };

  /** How far through its turn it is, eased: 0 headed one way, 1 the other. */
  function turnEase(): number {
    const t = state.turn;
    return t * t * (3 - 2 * t);
  }

  /** +1 or -1 along the track, and zero at the top of the turn. */
  function heading(): number {
    return Math.cos(Math.PI * turnEase());
  }

  /*
   * The attitude of the two legs, and the asymmetry that was in them.
   *
   * The turn added π to the yaw, which reverses the heading — and reverses the
   * *depth* component with it. So one leg of the track was angled toward the
   * viewer and the other was angled away: going one way the head was near and
   * large and a lunge came out of the screen, going the other way the animal
   * was pointed into the dark and the same lunge went away from you. Two
   * different animals, alternating, and only one of them was the one the piece
   * is about.
   *
   * Mirroring instead of rotating fixes it, and the reason is one identity:
   * cos(π − a) = −cos a but −sin(π − a) = −sin a, so π − YAW has the opposite
   * heading and the *same* attitude in depth. Both passes now carry the head
   * toward the glass; only the direction along the track changes.
   */
  function yawNow(): number {
    return YAW + (Math.PI - 2 * YAW) * turnEase();
  }

  const mouthPos = new THREE.Vector3();
  let depth = -90;
  let power = 0.8;
  let onEngulf: (mouth: THREE.Vector3, power: number) => void = () => {};

  /*
   * The mouth is at the front of the animal, and the front is wherever the
   * body is presently pointed — cos(YAW + swing), not cos(YAW) scaled by the
   * forward speed. The two agree at each end of the track and disagree
   * completely in the middle of a turn, where the old form put the mouth at
   * the body's centre: a lunge landing there drew its vortex out of the
   * animal's flank rather than out of its jaws.
   *
   * It is returned in the *animal's* space, which is the whole point of it
   * being a function rather than a number — core/space.ts is what carries it
   * into the water, and nothing downstream is allowed to guess.
   */
  function mouthAt(out: THREE.Vector3): THREE.Vector3 {
    const L = 15 + state.mass * 15;
    return out.set(
      state.cruise + Math.cos(yawNow()) * L * 0.95,
      state.y - 1.5,
      0,
    );
  }

  /** The other end, which is the end that does the work. */
  function tailAt(out: THREE.Vector3): THREE.Vector3 {
    const L = 15 + state.mass * 15;
    return out.set(
      state.cruise - Math.cos(yawNow()) * L * 1.0,
      state.y,
      0,
    );
  }

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
    girth: () => 1.6 + state.mass * 2.0,

    beginLunge(p) {
      // A second call during a run is a bigger appetite, not a second animal:
      // it raises the power and leaves the sequence it is already committed to
      // alone. Restarting would reset the charge to nothing every time the
      // tape delivered a burst, which is exactly when it must not.
      power = state.phase === 'none' ? p : Math.max(power, p);
      if (state.phase === 'none' || state.phase === 'recover') {
        state.phase = 'aim';
        state.phaseT = 0;
      }
    },

    setOnEngulf(fn) {
      onEngulf = fn;
    },

    mouth: (out) => mouthAt(out),

    tail: (out) => tailAt(out),

    headingX: () => Math.cos(yawNow()),

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
      /*
       * Twenty units either side, not forty-six.
       *
       * The frame is about thirty-six world units across at the depth the
       * animal holds, so a track of ninety spent most of its length off screen
       * — captures came back with an empty ocean, or with a tail cropped into a
       * corner. It should be *leaving* and *returning*, which needs a track a
       * little wider than the frame and no more.
       *
       * It *turns* at each end rather than wrapping. Subtracting the track
       * length was a wrap in everything but name: the body vanished at the
       * right edge and reappeared at the left one frame later, which reads as a
       * second animal, and there is only one. So the far end of the track sets
       * a new heading and the body swings through half a circle to meet it,
       * banking into the turn the way a body with mass has to. Forward speed is
       * the cosine of that swing, so it eases to nothing broadside-on and comes
       * back up the other way: the pause at the end of the track is the turn
       * itself, not a wait.
       */
      const range = 21;
      if (state.cruise > range) state.turnTarget = 1;
      else if (state.cruise < -range) state.turnTarget = 0;

      /*
       * The lunge, phase by phase (plan §13.3.2, and the type above).
       *
       * Everything here decides two numbers — where the turn is going and what
       * the boost is aiming at — and then lets the existing swim integrate
       * them. That is deliberate: the stroke rate and depth already follow
       * effort, so a charge deepens the beat and a brake flattens it without
       * this code saying anything about the tail.
       */
      const toCentre = state.cruise > 0 ? 1 : 0;
      let boostWant = 0;
      let gapeWant = 0;
      state.phaseT += dt;
      // How fast the heading is closing on the middle of the track: +1 is
      // straight at it, -1 is straight away from it.
      const closing = heading() * (state.cruise > 0 ? -1 : 1);

      if (state.phase === 'aim') {
        // A hunting turn is allowed to be quick. The 26 seconds a cruising
        // turn takes is a statement about tip speed against forward speed, and
        // at eight times the forward speed that ratio is unchanged — so the
        // body may come round eight times faster without ever looking like it
        // was spun by a hand.
        state.turnTarget = toCentre;
        boostWant = -0.25;
        if ((closing > 0.6 && state.phaseT > 0.6) || state.phaseT > 3) {
          state.phase = 'run';
          state.phaseT = 0;
        }
      } else if (state.phase === 'run') {
        state.turnTarget = toCentre;
        boostWant = 7.5 * power;
        /*
         * The jaw opens on *arriving*, not after n seconds.
         *
         * A timer put the open mouth wherever the animal happened to be, which
         * on a track wider than the frame meant it regularly happened off the
         * side of the picture — the "it gets cropped" complaint. Firing on
         * position makes the geometry of the event and the geometry of the
         * frame the same thing, and no clamp or special case is needed.
         */
        /*
         * The *mouth* has to reach the middle, not the body's centre.
         *
         * The centre is what follows the track, and the head is most of a body
         * length ahead of it along the yaw — twenty world units, which at the
         * depth of a lunge is nearly twice the half-width of the frame. So
         * firing when the centre crossed zero put the open jaws reliably off
         * the right-hand edge, and the one moment the whole sequence exists
         * for happened where nobody could see it. Everything that hangs off
         * the mouth — the suction, the shadow the jaw casts over the krill,
         * the fish that are taken — was landing out there with it.
         */
        if (Math.abs(mouthAt(mouthPos).x) < 4.0 || state.phaseT > 4.5) {
          state.phase = 'engulf';
          state.phaseT = 0;
          onEngulf(mouthAt(mouthPos), power);
        }
      } else if (state.phase === 'engulf') {
        // The brake. A rorqual that has taken in more water than it weighs is
        // dragging a parachute and stops almost dead; that stop is the single
        // most legible instant in the whole sequence, and it is *free* — the
        // drag is the same number as the pouch.
        boostWant = -0.82;
        gapeWant = 1;
        if (state.phaseT > 1.5) {
          state.phase = 'recover';
          state.phaseT = 0;
        }
      } else if (state.phase === 'recover') {
        boostWant = 0;
        if (state.phaseT > 8) {
          state.phase = 'none';
          state.phaseT = 0;
        }
      }

      /*
       * Attack fast, release slow — the same envelope as everything else in
       * the piece (plan §7). Accelerating takes a second and a half, braking
       * takes a third of one, and coming back to cruise takes four: the charge
       * is effort, the stop is an impact, and the recovery is exhaustion.
       */
      /*
       * It comes at you to feed.
       *
       * Everything else about the lunge was in the plane of the picture — the
       * charge, the brake, the jaw — and the one axis that was doing nothing
       * is the one the frame is weakest on. A body that only ever holds its
       * depth is a body on a rail; a body that closes thirty units while it
       * charges fills the frame, loses a third of the veil that hides it, and
       * makes the event happen *to the viewer* rather than in front of them.
       *
       * It never arrives. The near limit is thirty-eight units out, which at
       * this field of view still puts a fifty-unit animal well past both edges
       * of the frame — §6's rule that the whole body is never seen is not
       * negotiable, and coming closer is precisely what makes the rule bite:
       * near enough to fill the picture, so large that less of it fits.
       *
       * Approach is quick (the charge) and withdrawal is slow (the recovery),
       * the same asymmetry as everything else here.
       */
      const nearWant = state.phase === 'run' ? 0.55
                     : state.phase === 'engulf' ? 1
                     : state.phase === 'aim' ? 0.15 : 0;
      state.near += (nearWant - state.near)
                  * (1 - Math.exp(-dt / (nearWant > state.near ? 1.6 : 5.0)));

      const boostTau = boostWant > state.boost
        ? (state.phase === 'run' ? 1.5 : 1.0)
        : (state.phase === 'engulf' ? 0.32 : 4.0);
      state.boost += (boostWant - state.boost) * (1 - Math.exp(-dt / boostTau));
      state.lunge = Math.max(0, Math.min(1, state.boost / 6));

      /*
       * Twenty-six seconds, not nine, and the reason is the body's length.
       *
       * A nine-second reversal looked like a lurch, and it was one: the centre
       * is what follows the track, so the animal was *pivoting about its own
       * middle*, and the ends of a body fifty units long swung through a half
       * circle in those nine seconds. The head therefore crossed some sixty
       * units of water while the centre crossed none — seven or eight times
       * cruise speed — which is exactly the "it speeds up for a moment". The
       * spin was the whole of the turn, and no amount of easing hides a tip
       * speed that is an order of magnitude out.
       *
       * A turn is instead a radius, and an animal of this size has a large
       * one: something like half its own length, which at this speed is most
       * of half a minute. Slowing it is what puts the tip speed back within
       * sight of the cruise speed; nothing else does.
       */
      const before = turnEase();
      const rate = (dt / 26) * (state.phase === 'aim' || state.phase === 'run' ? 8 : 1);
      state.turn = state.turnTarget === 1
        ? Math.min(1, state.turn + rate)
        : Math.max(0, state.turn - rate);
      // Bank into it, proportional to how fast the heading is presently swinging.
      const swing = dt > 0 ? (turnEase() - before) / dt : 0;
      const bank = swing * 2.6;

      /*
       * The other half of the turn: the part that goes sideways.
       *
       * Only the *sign* of the velocity was being turned, which is a body that
       * reverses along one line — it has to end the turn where it started it,
       * and a path that closes on itself like that is a pendulum rather than
       * an animal. A body holding its speed through a half circle comes out of
       * it displaced by two radii at right angles to the track, so the two legs
       * run in different lanes and the turn is a swing rather than a spin.
       *
       * The lane is a function of the turn's own progress, not an integral of
       * it: (1 - cos) is exactly the perpendicular displacement of that semi-
       * circle, and taking it directly means the animal cannot accumulate a
       * drift over an hour of turns the way a summed velocity would. Sideways
       * here means *into the depth*, because the yaw is in the horizontal
       * plane — so the far leg is a little further off, a little dimmer, and
       * the water in between reads as water.
       */
      const lane = 0.5 - 0.5 * Math.cos(Math.PI * turnEase());

      // Never quite zero: a body that stops dead in water it has just thrown
      // into motion is a body that was switched off.
      const base = 0.85 + state.mass * 0.4;
      const speed = Math.max(0.10, base * (1 + state.boost));
      state.cruise += speed * heading() * dt;

      /*
       * The beat, and the fact that it costs something.
       *
       * Rate and depth both follow effort, which is the part that reads as
       * life: an animal that is working beats faster *and* deeper, and one
       * that is coasting does neither. A fin whale cruises at roughly a fifth
       * of a hertz and drives at about three times that, so those are the ends
       * of the range. Effort is thrust, not ground speed — the body is still
       * stroking at the top of a turn, where its forward progress is zero, and
       * a tail that stopped there would look like the animal had been paused.
       */
      const effort = Math.max(0, Math.min(1, (speed - 0.85) / 1.6));
      state.effort = effort;
      const hz = 0.20 + effort * 0.40;
      state.stroke = (state.stroke + hz * 2 * Math.PI * dt) % (2 * Math.PI);

      // The gape lags the decision and closes far more slowly than it opens,
      // which is what makes the pouch look heavy with water rather than
      // elastic: a fin whale's throat takes the better part of a minute to
      // drain, and even a compressed version of that is unmistakable.
      state.gape += (gapeWant - state.gape)
                  * (1 - Math.exp(-dt / (gapeWant > state.gape ? 0.28 : 2.2)));
      state.ascend = Math.max(0, state.ascend - dt / 26);
      // 1.5 seconds, not 0.15. Combined with the fifth of the amplitude in
      // main.ts this is a swell across the flank rather than a blink, and a
      // blink is what "the sudden brightening feels wrong" was about.
      state.flash *= Math.exp(-dt / 1.5);

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
      // Clamped at -38: nearer than that and the body crosses into the krill's
      // own depth range (-11 to +7 is the field's box, and the veil between
      // them is what says "water"), which would put a whale in front of the
      // water it is supposed to be swimming in.
      /*
       * Further off while it is only swimming, and the lunge is what closes it.
       *
       * At -64 with a heavy book the body sat at about -52, where it fills the
       * frame permanently — and a whale that is always enormous has nowhere to
       * go when it charges, which is the same mistake the tail beat made
       * before it was given a reserve. Held back to about -68 at cruise, the
       * approach is worth thirty units of looming rather than fourteen, and
       * the difference between "it is down there" and "it is coming" is a
       * difference you can see.
       */
      depth = Math.min(-38,
        -78 - state.distance * 34 + state.mass * 10 + state.ascend * 20 - lane * 8
        + state.near * 40);
      u.uBody.value.set(state.y + state.ascend * 9, depth, state.mass, state.flash);
      u.uMotion.value.set(state.cruise, state.gape, state.warm, state.ascend);
      // The shader adds YAW itself, so what goes across is the difference.
      u.uSwim.value.set(yawNow() - YAW, bank, state.stroke, effort);
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
