import * as THREE from 'three';

/**
 * The fish: prints between the krill line and the whale line.
 *
 * This started as one comet per print and it was wrong twice over.
 *
 * The loud error was a sign. The fragment shader took the along-body parameter
 * as `pow(1.0 - head, 3.0)` when it wanted `pow(head, 3.0)`, so the brightest
 * point sat at the *far end of the trail* and the mark faded toward the place
 * the animal actually was. The result moves like a shooting star played
 * backwards, which is exactly what it was called when someone watched it. A
 * sign error in a taper is invisible in the source and unmistakable in motion.
 *
 * The quieter error was the concept. A single comet is not a fish and cannot be
 * made into one by shading. What the middle of the tape actually *is* is a
 * parent order sliced into children and fed out over a few seconds — so it is
 * already a group of things travelling together, and drawing it as one is the
 * inaccurate choice as well as the duller one. Each print is now a school:
 * five to eleven bodies in loose formation, each with its own tail beat and its
 * own slightly wrong speed, which is what keeps a formation from looking
 * stamped.
 *
 * Each body is a spindle with a forked tail, brightest at the head, undulating
 * as it goes. At the size these are on a phone — thirty pixels, most of them
 * dim — the silhouette is doing all the work, so it is a real one.
 */

/** Bodies, not schools. A school takes as many of these as it needs. */
const CAPACITY = 420;

interface Fish {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** Where this one sits in its school's formation. */
  slot: THREE.Vector3;
  phase: number;
  beat: number;
  life: number;
  span: number;
  power: number;
  warm: number;
  /** 0..1, decaying. Set when this one is being swallowed. */
  flare: number;
}

export interface Shoal {
  mesh: THREE.Mesh;
  /** Releases a school. `side` is +1 for a lift, -1 for a hit. */
  spawn: (x: number, y: number, side: number, power: number) => void;
  /** Scatters whatever is near (x, y). A finger on the glass, or a whale. */
  scatter: (x: number, y: number, radius: number, strength: number) => void;
  /**
   * Eats whatever is inside (x, y). They are drawn in, flare, and are gone —
   * the only thing in this ocean that ever disappears (plan §13.3.4).
   */
  consume: (x: number, y: number, radius: number) => void;
  update: (dt: number, time: number) => void;
  dispose: () => void;
}

export function createShoal(): Shoal {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);

  const offsets = new Float32Array(CAPACITY * 3);
  const headings = new Float32Array(CAPACITY * 2);
  // x length, y width, z brightness, w warmth
  const shapes = new Float32Array(CAPACITY * 4);
  // x beat phase, y beat amplitude
  const beats = new Float32Array(CAPACITY * 2);
  geometry.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3));
  geometry.setAttribute('aHeading', new THREE.InstancedBufferAttribute(headings, 2));
  geometry.setAttribute('aShape', new THREE.InstancedBufferAttribute(shapes, 4));
  geometry.setAttribute('aBeat', new THREE.InstancedBufferAttribute(beats, 2));
  geometry.instanceCount = 0;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60);

  const material = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      attribute vec3 aOffset;
      attribute vec2 aHeading;
      attribute vec4 aShape;
      attribute vec2 aBeat;
      varying vec2 vQuad;
      varying float vBright;
      varying float vWarm;
      varying vec2 vBeat;
      void main() {
        vQuad = position.xy * 2.0;
        vBright = aShape.z;
        vWarm = aShape.w;
        vBeat = aBeat;
        vec4 mv = modelViewMatrix * vec4(aOffset, 1.0);
        vec2 dir = aHeading;
        // The quad hangs *behind* the position: the animal's nose is where the
        // simulation says it is, and the body follows it. Straddling the
        // position instead makes the whole school look like it is skidding.
        float along = position.x - 0.5;
        mv.xy += along * dir * aShape.x + position.y * vec2(-dir.y, dir.x) * aShape.y;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vQuad;
      varying float vBright;
      varying float vWarm;
      varying vec2 vBeat;

      const float PI = 3.14159265;

      void main() {
        // u: 0 at the snout, 1 at the tip of the tail.
        float u = clamp(0.5 - vQuad.x * 0.5, 0.0, 1.0);

        /*
         * The undulation. The body is a travelling sine whose amplitude grows
         * toward the tail and is zero at the head, which is how a fish actually
         * swims — the head barely moves and the tail does all of it. Applied to
         * the sampling coordinate rather than to the geometry, so it costs
         * nothing and cannot pull the shape outside its own quad.
         */
        float sway = sin(u * 5.2 - vBeat.x) * vBeat.y * u * u;
        float v = vQuad.y - sway;

        /*
         * The silhouette: fusiform, with a forked caudal fin.
         *
         * Girth peaks about a third back and the peduncle pinches to almost
         * nothing before the tail opens out again. That pinch is the single
         * feature that says "fish" — without it the same profile reads as a
         * grain of rice.
         */
        float body = pow(max(0.0, sin(PI * pow(1.0 - u, 0.62))), 0.62);
        float pinch = smoothstep(0.68, 0.86, u);
        body *= 1.0 - pinch * 0.86;
        float fan = smoothstep(0.84, 0.99, u) * (1.0 - smoothstep(0.99, 1.0, u)) * 1.5;
        float halfW = body * 0.62 + fan;

        float d = abs(v) / max(halfW, 1e-4);
        float across = exp(-d * d * 2.6);

        /*
         * Brightness peaks at the head and falls off down the body — the
         * correct way round this time. The eye of a swimming thing is the
         * brightest part of it in dark water, and it is what makes a school
         * read as a direction rather than as a smear.
         */
        float along = 0.22 + 0.78 * pow(1.0 - u, 2.2);
        float a = across * along;
        if (a < 0.004) discard;

        vec3 cold = vec3(0.45, 0.95, 1.0);
        vec3 warm = vec3(1.0, 0.52, 0.30);
        vec3 tint = mix(cold, warm, vWarm);
        tint = mix(tint, vec3(1.0), pow(1.0 - u, 8.0) * 0.75);
        gl_FragColor = vec4(tint * a * vBright, 1.0);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 12;

  const pool: Fish[] = [];

  return {
    mesh,

    spawn(x, y, side, power) {
      // A bigger parent order is a bigger school, not a bigger fish. Sizes in
      // the tape run over three orders of magnitude and body length cannot.
      const members = 5 + Math.round(power * 6);
      if (pool.length + members > CAPACITY) pool.splice(0, pool.length + members - CAPACITY);
      const speed = 7 + power * 9;
      const drift = (Math.random() - 0.5) * 0.42;
      const life = 2.6 + power * 1.8;
      for (let i = 0; i < members; i++) {
        pool.push({
          pos: new THREE.Vector3(x, y, -6 + Math.random() * 10),
          // The formation is wide across the heading and shallow along it, the
          // shape a school actually holds; and it is jittered, because a lattice
          // reads as a machine at any spacing.
          slot: new THREE.Vector3(
            (Math.random() - 0.5) * 2.6 - i * 0.35,
            (Math.random() - 0.5) * 1.9,
            (Math.random() - 0.5) * 3.2,
          ),
          phase: Math.random() * Math.PI * 2,
          // Small fish beat faster. The spread of rates across a school is what
          // makes it shimmer rather than pulse.
          beat: 8.5 + Math.random() * 5.0,
          vel: new THREE.Vector3(
            side * speed * (0.86 + Math.random() * 0.28),
            drift * speed * 0.45 + side * 1.1 + (Math.random() - 0.5) * 1.6,
            0,
          ),
          life,
          span: life,
          power,
          warm: side > 0 ? 0 : 1,
          flare: 0,
        });
      }
    },

    scatter(x, y, radius, strength) {
      /*
       * The fish are the one population that does not simply follow the water:
       * they carry their own velocity, so a disturbance passes straight through
       * them unless they are told about it. A gaussian push away from the point
       * — not a hard shove — because what this is modelling is a startle, and a
       * startled fish turns rather than being knocked sideways.
       */
      const r2 = radius * radius;
      for (const f of pool) {
        const dx = f.pos.x - x;
        const dy = f.pos.y - y;
        const d2 = dx * dx + dy * dy;
        const fall = Math.exp(-d2 / r2);
        if (fall < 0.02) continue;
        const d = Math.sqrt(d2) + 1e-4;
        f.vel.x += (dx / d) * strength * fall;
        f.vel.y += (dy / d) * strength * fall;
      }
    },

    consume(x, y, radius) {
      /*
       * What "eaten" looks like.
       *
       * Nothing in this ocean died before this: the krill wrap forever and the
       * fish simply time out wherever they happen to be. So a lunge that took
       * a school into its mouth gave every one of them back a second later,
       * and an event with no consequence is not an event — the fish crossing
       * the jaws unharmed was quietly telling the viewer that the mouth is
       * scenery.
       *
       * They are pulled the last of the way in rather than snapped out, they
       * flare as they go (a startled fish fires everything it has, and it is
       * also simply the right shape for an ending: brightest at the last
       * instant), and a quarter of a second later there is nothing there. The
       * flare is what makes it read as swallowed instead of as a dropped
       * frame.
       */
      const r2 = radius * radius;
      for (const f of pool) {
        const dx = x - f.pos.x;
        const dy = y - f.pos.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const d = Math.sqrt(d2) + 1e-4;
        // Drawn in rather than snatched: a nine-unit kick over a third of a
        // second is a jump cut, and the flare that went with it was one more
        // thing blinking on a frame. They turn toward the mouth, dim as they
        // reach it, and are gone.
        f.vel.x += (dx / d) * 3.5;
        f.vel.y += (dy / d) * 3.5;
        f.flare = Math.max(f.flare, 0.55);
        f.life = Math.min(f.life, 0.55);
        f.span = Math.max(f.span, 0.55);
      }
    },

    update(dt, time) {
      let n = 0;
      for (let i = pool.length - 1; i >= 0; i--) {
        const f = pool[i];
        f.life -= dt;
        if (f.life <= 0) {
          pool.splice(i, 1);
          continue;
        }
        f.flare = Math.max(0, f.flare - dt / 0.55);
        f.pos.addScaledVector(f.vel, dt);
        // They coast rather than stopping dead, so the school stretches out and
        // the light goes out from the back.
        f.vel.multiplyScalar(Math.exp(-dt * 0.5));
      }
      for (const f of pool) {
        const k = f.life / f.span;
        const speed = Math.hypot(f.vel.x, f.vel.y) || 1;
        const ux = f.vel.x / speed;
        const uy = f.vel.y / speed;
        // The formation slot is carried in the school's own frame, so a turn
        // takes the whole group with it instead of shearing it.
        offsets[n * 3 + 0] = f.pos.x + f.slot.x * ux - f.slot.y * uy;
        offsets[n * 3 + 1] = f.pos.y + f.slot.x * uy + f.slot.y * ux;
        offsets[n * 3 + 2] = f.pos.z + f.slot.z;
        headings[n * 2 + 0] = ux;
        headings[n * 2 + 1] = uy;
        /*
         * Half a world unit, give or take.
         *
         * This went 0.85 -> 1.35 -> 0.55 across three captures. At 1.35 they
         * were a tenth of the frame each and the school read as a flight of
         * airships; the mistake was judging the size from a still taken at a
         * quarter of the particle count, where everything looks sparse and
         * everything wants to be bigger. The fish are meant to be *small* — the
         * shoal is a texture that crosses the picture, not a cast of
         * characters.
         */
        const length = 0.55 + f.power * 0.5;
        shapes[n * 4 + 0] = length;
        shapes[n * 4 + 1] = length * 0.42;
        // Fades in over the first sixth of its life and out over the rest. An
        // instant appearance is a pop, and a pop is the one thing a picture
        // about stillness cannot afford.
        shapes[n * 4 + 2] = (0.5 + f.power * 1.25) * Math.min(1, (1 - k) * 6) * k * k
                          + f.flare * f.flare * 0.8;
        shapes[n * 4 + 3] = f.warm;
        beats[n * 2 + 0] = f.phase + time * f.beat;
        // The beat deepens with speed: a fish holding station barely moves, one
        // that is running is thrashing.
        beats[n * 2 + 1] = Math.min(0.55, 0.10 + speed * 0.035);
        n++;
      }
      geometry.instanceCount = n;
      for (const name of ['aOffset', 'aHeading', 'aShape', 'aBeat']) {
        (geometry.attributes[name] as THREE.InstancedBufferAttribute).needsUpdate = true;
      }
    },

    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
