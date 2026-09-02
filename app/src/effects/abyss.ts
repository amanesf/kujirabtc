import * as THREE from 'three';

/**
 * The last pass: mass, shock, and the lens the whole thing is seen through.
 *
 * Everything here is screen-space and that is a deliberate choice, not a
 * shortcut. Warping the *finished image* means the krill behind a whale bend
 * too, and a body that bends the things behind it is a body with mass; a body
 * that only bends itself is a drawing. This one pass is what makes the deep
 * feel heavy.
 *
 * Three things happen, in this order:
 *
 *  1. gravitational lensing around each wall, with the three channels warped by
 *     slightly different amounts. Real gravitational lensing is achromatic —
 *     this is a lie, and it is the lie that makes the effect read as *optics*
 *     rather than as a distortion filter.
 *  2. the shock rings from whale prints: a thin annulus of radial displacement
 *     that expands and thins. Fast — a fifth of a second to cross the frame,
 *     against six seconds for the vortex it leaves behind in the fluid. The
 *     same event at three speeds is what makes it read as physics (plan §7).
 *  3. absorption, vignette and grain — the veil. The grain is not nostalgia;
 *     a perfectly clean frame reads as CG, and the noise floor is what makes
 *     the eye accept it as something that was *captured*.
 */

export const MAX_LENSES = 2;
export const MAX_SHOCKS = 4;

export const AbyssShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uAspect: { value: 1 },
    /** xy in NDC, z strength, w radius. */
    uLens: { value: Array.from({ length: MAX_LENSES }, () => new THREE.Vector4()) },
    /** xy in NDC, z ring radius, w strength. */
    uShock: { value: Array.from({ length: MAX_SHOCKS }, () => new THREE.Vector4()) },
    uExposure: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAspect;
    uniform float uExposure;
    uniform vec4 uLens[${MAX_LENSES}];
    uniform vec4 uShock[${MAX_SHOCKS}];
    varying vec2 vUv;

    /**
     * The displacement field, evaluated once per colour channel with a slightly
     * different strength. Returned in aspect-corrected screen units.
     */
    vec2 displace(vec2 sp, float k) {
      vec2 d = vec2(0.0);

      for (int i = 0; i < ${MAX_LENSES}; i++) {
        vec4 lens = uLens[i];
        if (lens.z <= 0.0) continue;
        vec2 toC = lens.xy - sp;
        float r = length(toC) + 1e-4;
        /*
         * 1/r, softened at the core.
         *
         * A true deflection goes as 1/r and is unbounded at the centre, which
         * on a screen means a singularity — a pixel-wide knot of garbage sitting
         * on the most important object in the frame. The +core term is a
         * Plummer softening: identical far away, finite at the middle, and it
         * turns the knot into the gentle swell an out-of-focus mass would make.
         */
        float core = lens.w * 0.55;
        d += normalize(toC) * lens.z * k * (r / (r * r + core * core));
      }

      for (int i = 0; i < ${MAX_SHOCKS}; i++) {
        vec4 s = uShock[i];
        if (s.w <= 0.0) continue;
        vec2 toC = sp - s.xy;
        float r = length(toC) + 1e-4;
        // A thin ring that thins further as it grows, so the front stays sharp
        // while the energy behind it spreads out and dies.
        float width = 0.035 + s.z * 0.10;
        float ring = exp(-pow((r - s.z) / width, 2.0));
        d += normalize(toC) * ring * s.w * k * 0.055;
      }
      return d;
    }

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    void main() {
      // Aspect-corrected screen space, centred: a circle here is a circle on
      // the glass, which matters a great deal on a phone in portrait where the
      // frame is more than twice as tall as it is wide.
      vec2 sp = (vUv - 0.5) * vec2(uAspect, 1.0);

      /*
       * Chromatic separation: 1.00 / 0.985 / 0.968.
       *
       * Under two per cent, and it has to be — at three the image reads as a
       * broken video codec, and at one it is invisible. This band is where it
       * stops being a defect and becomes the signature of a real lens with real
       * glass in front of a real deep.
       */
      vec2 r = sp + displace(sp, 1.000);
      vec2 g = sp + displace(sp, 0.985);
      vec2 b = sp + displace(sp, 0.968);
      vec2 inv = vec2(1.0 / uAspect, 1.0);
      vec3 col = vec3(
        texture2D(tDiffuse, clamp(r * inv + 0.5, 0.0, 1.0)).r,
        texture2D(tDiffuse, clamp(g * inv + 0.5, 0.0, 1.0)).g,
        texture2D(tDiffuse, clamp(b * inv + 0.5, 0.0, 1.0)).b);

      // Absorption: the water in front of a mass is *dimmer*, not brighter. A
      // heavier wall takes more of the field's light away, which is the whole
      // inversion the piece is built on (scene/whale.ts).
      for (int i = 0; i < ${MAX_LENSES}; i++) {
        vec4 lens = uLens[i];
        if (lens.z <= 0.0) continue;
        float d = length(sp - lens.xy);
        col *= 1.0 - 2.6 * lens.z * exp(-(d * d) / (lens.w * lens.w));
      }

      // The bright edge of each shock front. Separate from the displacement so
      // it can be a hair ahead of it — light outruns water.
      for (int i = 0; i < ${MAX_SHOCKS}; i++) {
        vec4 s = uShock[i];
        if (s.w <= 0.0) continue;
        float d = length(sp - s.xy);
        float width = 0.030 + s.z * 0.09;
        float ring = exp(-pow((d - s.z * 1.04) / width, 2.0));
        col += vec3(0.62, 0.86, 1.0) * ring * s.w * 0.16;
      }

      col *= uExposure;

      // The vignette. Heavy, and it is composition rather than decoration: it
      // is what keeps the eye in the middle third of a very tall frame.
      float v = length(sp * vec2(0.78, 0.62));
      col *= 1.0 - smoothstep(0.26, 0.98, v) * 0.80;

      /*
       * The noise floor.
       *
       * Two grains at once: a static one, which is the sensor, and a slow
       * crawling one, which is the water. Both are added rather than multiplied
       * so they survive into the blacks — the blacks are ninety per cent of this
       * picture, and a black with nothing in it is a dead pixel, not a deep sea.
       */
      float n1 = hash(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5;
      float n2 = hash(floor(gl_FragCoord.xy * 0.35) + floor(uTime * 8.0) * 13.1) - 0.5;
      col += (n1 * 0.016 + n2 * 0.010);

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};
