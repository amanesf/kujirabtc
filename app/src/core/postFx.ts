import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { AbyssShader, MAX_LENSES } from '../effects/abyss';

/**
 * The chain:
 *
 *   render -> bloom -> OutputPass (ACES + sRGB) -> abyss
 *
 * Bloom before the tonemap, because bloom is light and light adds in linear.
 * The abyss pass last, because a lens sits in front of the finished picture and
 * because its grain has to survive into the display blacks rather than being
 * crushed by a tone curve applied after it.
 */

export interface Lens {
  /** NDC x, y (aspect-corrected by the shader). */
  x: number;
  y: number;
  strength: number;
  radius: number;
}

export interface PostFx {
  render: () => void;
  setSize: (w: number, h: number, aspect: number) => void;
  setTime: (t: number) => void;
  /** A whole-frame lever, driven by the market (main.ts). */
  setExposure: (e: number) => void;
  lenses: Lens[];
  dispose: () => void;
}

export function createPostFx(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  width: number,
  height: number,
): PostFx {
  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));

  /*
   * Bloom, and the threshold is the most important number in the file.
   *
   * The field's resting brightness is around 0.06 linear and a krill in a wake
   * reaches past 1.5 (scene/field.ts). Setting the threshold at 0.35 means the
   * still water does not bloom at all and the strained water blooms hard —
   * so the glow appears exactly where the market is doing something, and the
   * ninety per cent of the frame that is quiet stays crisp and dark.
   *
   * A lower threshold is the single easiest way to ruin this picture: the
   * whole frame lifts into a grey haze and the contrast that the deep sea is
   * made of is gone.
   */
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(width, height),
    0.74, // strength
    0.82, // radius
    0.48, // threshold, in linear light before the tonemap
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const abyss = new ShaderPass(AbyssShader);
  abyss.renderToScreen = true;
  composer.addPass(abyss);

  const lenses: Lens[] = [];

  return {
    lenses,

    setSize(w, h, aspect) {
      composer.setSize(w, h);
      bloom.setSize(w, h);
      abyss.uniforms.uAspect.value = aspect;
    },

    setTime(t) {
      abyss.uniforms.uTime.value = t;
    },

    setExposure(e) {
      abyss.uniforms.uExposure.value = e;
    },

    render() {
      const lensU = abyss.uniforms.uLens.value as THREE.Vector4[];
      for (let i = 0; i < MAX_LENSES; i++) {
        const l = lenses[i];
        if (l) lensU[i].set(l.x, l.y, l.strength, l.radius);
        else lensU[i].set(0, 0, 0, 1);
      }
      composer.render();
    },

    dispose() {
      composer.dispose();
      target.dispose();
    },
  };
}
