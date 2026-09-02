import * as THREE from 'three';

/**
 * The one conversion the picture was missing.
 *
 * Three populations live at three depths. The water — the fluid grid, the
 * krill, the fish — is at z ≈ 0, where the frame is about 9.5 units across.
 * The whale is at z ≈ −70, where the same frame is 31 units across. Its track
 * runs to ±21 and its own body adds another ±20 on top of that, so a mouth
 * position in the animal's frame reaches ±45 — ten domain widths outside the
 * water it is supposed to be inhaling.
 *
 * That was being handed straight to `fluid.add()`, whose forcing falls off as
 * exp(−r²/radius²): at forty units out it is exactly zero. Every lunge since
 * the animal learned to lunge has drawn its vortex out of a piece of ocean
 * that is not on screen, which is the whole of "it does not look like it is
 * feeding". The shock ring had the same bug in a different form — projected at
 * z = −6 rather than at the body's depth — and landed off frame, where its
 * front sat along the edge and the three channels of the abyss pass clamped
 * separately and coloured the border.
 *
 * So: no more magic constants (the 0.4 on the lens, the 0.55 on the lamp).
 * A point in the animal's frame goes through the camera — the real one, with
 * its drift and its lag, not an idealised one at the origin — and comes back
 * either as the screen position it actually occupies, or as the point in the
 * water directly in front of it. Those two are the only conversions anything
 * needs, and having them in one place is what makes the light on the water and
 * the light on the animal the same light.
 */

const ndc = new THREE.Vector3();
const ray = new THREE.Vector3();

/** Screen position of a world point, in NDC (−1..1 on both axes). */
export function toNdc(
  x: number,
  y: number,
  z: number,
  camera: THREE.Camera,
  out: THREE.Vector2,
): THREE.Vector2 {
  ndc.set(x, y, z).project(camera);
  return out.set(ndc.x, ndc.y);
}

/**
 * The point on the z = 0 plane that appears at the same place on the glass as
 * the given world point. This is what carries the whale into the water.
 */
export function toWater(
  x: number,
  y: number,
  z: number,
  camera: THREE.PerspectiveCamera,
  out: THREE.Vector2,
): THREE.Vector2 {
  ndc.set(x, y, z).project(camera);
  ray.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(camera.position);
  if (Math.abs(ray.z) < 1e-6) return out.set(x, y);
  const t = -camera.position.z / ray.z;
  return out.set(camera.position.x + ray.x * t, camera.position.y + ray.y * t);
}

/**
 * Half-width of the frame at a given depth, in world units. Kept here because
 * it is the same trigonometry, and because several places want to size a
 * radius in *frame fractions* rather than in world units — a mouth that
 * swallows a fifth of the picture should keep doing so at any depth.
 */
export function halfWidthAt(z: number, camera: THREE.PerspectiveCamera): number {
  return Math.tan((camera.fov * Math.PI) / 360) * Math.abs(camera.position.z - z) * camera.aspect;
}

/**
 * How much a length in a plane at `z` shrinks when carried into the water at
 * z = 0 — the ratio of the two planes' distances from the camera. A head two
 * girths across at seventy units out covers less water than the same head at
 * forty, and the mouth's reach has to follow that or a lunge that comes closer
 * would inhale exactly as little as one that stayed away.
 */
export function waterScale(z: number, camera: THREE.PerspectiveCamera): number {
  return camera.position.z / (camera.position.z - z);
}
