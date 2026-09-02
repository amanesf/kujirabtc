import * as THREE from 'three';

/**
 * The fish: prints between a tenth of a coin and five.
 *
 * The middle of the tape is algorithmic — a parent order sliced into children
 * and fed out — so these arrive in runs, from one side, going one way, and that
 * is exactly what a shoal looks like. Each one is a comet: a bright head and a
 * tail that is not a trail of geometry but the *same quad*, stretched along the
 * heading and faded from the front. One draw call, forty-eight of them, and
 * nothing is stored between frames except position.
 *
 * The important thing about them is not how they look. It is that each one also
 * pushes the fluid (main.ts), so what the eye actually follows is not the comet
 * but the corridor it opens in the krill — which is still there, curling and
 * shedding, eight seconds after the fish itself has gone. The fish is the
 * cause; the wake is the picture.
 */

const CAPACITY = 48;

interface Comet {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  span: number;
  power: number;
  warm: number;
}

export interface Streaks {
  mesh: THREE.Mesh;
  /** Launches one. `side` is +1 for a lift, -1 for a hit. */
  spawn: (x: number, y: number, side: number, power: number) => void;
  update: (dt: number) => void;
  dispose: () => void;
}

export function createStreaks(): Streaks {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);

  const offsets = new Float32Array(CAPACITY * 3);
  const headings = new Float32Array(CAPACITY * 2);
  // x: length, y: width, z: brightness, w: warmth
  const shapes = new Float32Array(CAPACITY * 4);
  geometry.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3));
  geometry.setAttribute('aHeading', new THREE.InstancedBufferAttribute(headings, 2));
  geometry.setAttribute('aShape', new THREE.InstancedBufferAttribute(shapes, 4));
  geometry.instanceCount = 0;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60);

  const material = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      attribute vec3 aOffset;
      attribute vec2 aHeading;
      attribute vec4 aShape;
      varying vec2 vQuad;
      varying float vBright;
      varying float vWarm;
      void main() {
        vQuad = position.xy * 2.0;
        vBright = aShape.z;
        vWarm = aShape.w;
        vec4 mv = modelViewMatrix * vec4(aOffset, 1.0);
        // The quad is built around the head rather than centred, so the body
        // trails *behind* the position instead of straddling it: a comet whose
        // bright end is not where it actually is reads as slipping.
        vec2 dir = aHeading;
        float along = position.x - 0.5;
        mv.xy += along * dir * aShape.x + position.y * vec2(-dir.y, dir.x) * aShape.y;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vQuad;
      varying float vBright;
      varying float vWarm;
      void main() {
        // Along the body: 1 at the head, falling away cubically down the tail.
        float head = clamp(vQuad.x * 0.5 + 0.5, 0.0, 1.0);
        float along = pow(1.0 - head, 3.0);
        // Across it: a gaussian that narrows toward the tail, so the shape is a
        // teardrop and not a rectangle.
        float across = exp(-vQuad.y * vQuad.y * (2.4 + 7.0 * along));
        float a = along * across;
        if (a < 0.003) discard;
        vec3 cold = vec3(0.45, 0.95, 1.0);
        vec3 warm = vec3(1.0, 0.52, 0.30);
        vec3 tint = mix(cold, warm, vWarm);
        // The head goes white: the brightest part of any light is the part that
        // has run out of colour.
        tint = mix(tint, vec3(1.0), pow(along, 6.0) * 0.8);
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

  const pool: Comet[] = [];

  return {
    mesh,

    spawn(x, y, side, power) {
      if (pool.length >= CAPACITY) pool.shift();
      // Buyers run with the current and sellers against it, so a one-sided tape
      // produces a shoal all swimming the same way — the single clearest read
      // of aggression in the whole picture, and it needs no legend.
      const speed = 7 + power * 11;
      const drift = (Math.random() - 0.5) * 0.5;
      pool.push({
        pos: new THREE.Vector3(x, y, -6 + Math.random() * 10),
        vel: new THREE.Vector3(side * speed, drift * speed * 0.45 + side * 1.2, 0),
        life: 2.2 + power * 1.6,
        span: 2.2 + power * 1.6,
        power,
        warm: side > 0 ? 0 : 1,
      });
    },

    update(dt) {
      let n = 0;
      for (let i = pool.length - 1; i >= 0; i--) {
        const c = pool[i];
        c.life -= dt;
        if (c.life <= 0) {
          pool.splice(i, 1);
          continue;
        }
        c.pos.addScaledVector(c.vel, dt);
        // They coast to a stop rather than vanishing at speed, which is what
        // lets the tail catch up and the light go out from the back.
        c.vel.multiplyScalar(Math.exp(-dt * 0.55));
      }
      for (const c of pool) {
        const k = c.life / c.span;
        const speed = Math.hypot(c.vel.x, c.vel.y) || 1;
        offsets[n * 3 + 0] = c.pos.x;
        offsets[n * 3 + 1] = c.pos.y;
        offsets[n * 3 + 2] = c.pos.z;
        headings[n * 2 + 0] = c.vel.x / speed;
        headings[n * 2 + 1] = c.vel.y / speed;
        shapes[n * 4 + 0] = (1.4 + c.power * 4.2) * (0.35 + speed * 0.075);
        shapes[n * 4 + 1] = 0.16 + c.power * 0.22;
        // Fades in over the first fifth of its life and out over the rest: an
        // instant appearance is a pop, and a pop is the one thing a picture
        // about stillness cannot afford.
        shapes[n * 4 + 2] = (0.28 + c.power * 1.05) * Math.min(1, (1 - k) * 6) * k * k;
        shapes[n * 4 + 3] = c.warm;
        n++;
      }
      geometry.instanceCount = n;
      (geometry.attributes.aOffset as THREE.InstancedBufferAttribute).needsUpdate = true;
      (geometry.attributes.aHeading as THREE.InstancedBufferAttribute).needsUpdate = true;
      (geometry.attributes.aShape as THREE.InstancedBufferAttribute).needsUpdate = true;
    },

    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
