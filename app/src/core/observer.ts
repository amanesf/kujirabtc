import * as THREE from 'three';

/**
 * The camera, which is not a camera.
 *
 * A fixed frame makes the viewer an audience and an orbiting frame makes them a
 * tourist. This one has mass and a nervous system: it drifts on the current,
 * it is shoved by shocks, and — the detail that does all the work — when
 * something moves down there it *flinches a third of a second late*.
 *
 * That lag is the entire trick. A camera that reacts instantly is a machine
 * being driven by a signal. A camera that reacts late is something with a spine
 * that noticed. It costs one spring and one delay line, and it converts the
 * whole piece from "being shown a thing" to "being present at a thing".
 *
 * There are no cuts, ever, and there is no orbit. The observer holds station,
 * badly, the way anything holds station in moving water.
 */

export interface Observer {
  update: (dt: number, time: number, camera: THREE.PerspectiveCamera) => void;
  /** A shove, in world units per second, from a shock at (x, y). */
  push: (x: number, y: number, power: number) => void;
  /** The moving light: xyz is where it is, w is how strong (plan §6). */
  light: THREE.Vector4;
}

export function createObserver(): Observer {
  const home = new THREE.Vector3(0, 0, 30);
  const position = home.clone();
  const velocity = new THREE.Vector3();
  const target = new THREE.Vector3();
  const light = new THREE.Vector4(0, 0, -46, 0);

  // The delay line the flinch comes out of: a shove is queued and applied a few
  // frames later rather than on the frame it happened.
  const pending: { t: number; x: number; y: number; power: number }[] = [];
  let clock = 0;

  return {
    light,

    push(x, y, power) {
      pending.push({ t: clock + 0.30, x, y, power });
    },

    update(dt, time, camera) {
      clock += dt;

      for (let i = pending.length - 1; i >= 0; i--) {
        if (clock < pending[i].t) continue;
        const p = pending[i];
        pending.splice(i, 1);
        // Pushed *away* from the event and slightly back, which is what a body
        // does when something large moves nearby: it recoils before it looks.
        const d = new THREE.Vector3(position.x - p.x, position.y - p.y, 0);
        if (d.lengthSq() < 1e-6) d.set(0, 1, 0);
        d.normalize();
        velocity.addScaledVector(d, p.power * 1.6);
        velocity.z += p.power * 0.9;
      }

      /*
       * The breath: two slow sinusoids at incommensurable periods (47s and 71s)
       * so the pair never repeats. A single period, however slow, is a loop, and
       * a loop is the thing that ends a piece meant to be left running.
       */
      const driftX = Math.sin(time / 47) * 0.9 + Math.sin(time / 17.3) * 0.22;
      const driftY = Math.cos(time / 71) * 0.7 + Math.sin(time / 23.9) * 0.18;
      const driftZ = Math.sin(time / 59) * 1.6;
      const rest = new THREE.Vector3(home.x + driftX, home.y + driftY, home.z + driftZ);

      // A critically damped spring back to the resting drift. Soft (k = 2.4) so
      // a shove takes two or three seconds to settle and the recovery is as
      // visible as the hit.
      const k = 2.4;
      velocity.addScaledVector(rest.clone().sub(position), k * dt);
      velocity.multiplyScalar(Math.exp(-dt * 1.9));
      position.addScaledVector(velocity, dt);
      camera.position.copy(position);

      // The look direction lags the position, which gives the frame a slight,
      // constant sense of turning to keep up with itself.
      target.x += (driftX * 0.35 - target.x) * (1 - Math.exp(-dt / 2.2));
      target.y += (driftY * 0.35 - target.y) * (1 - Math.exp(-dt / 2.2));
      camera.lookAt(target.x, target.y, 0);

      /*
       * The moving light.
       *
       * One source, wandering on a path that never closes, lighting a few
       * metres of a body that is hundreds long (scene/whale.ts) and glinting
       * off whatever marine snow it passes (scene/field.ts). This is the
       * cheapest possible way to get an unbounded number of images out of a
       * bounded amount of geometry: the same skin, lit from somewhere new, is
       * something you have not seen.
       *
       * It also pulses — 0.6 to 1.0 over about eleven seconds — because a
       * steady light is a lamp and an unsteady one is alive.
       *
       * It lives *down there*, near the animals, and that is not a detail. Held
       * up at the viewer's own depth its falloff reached the whale as a uniform
       * dimness and lit the entire body evenly, which is the flat, slab-like
       * look the first capture had. Put among them, the same falloff makes a
       * patch a few metres across on a body hundreds long — which is the whole
       * mechanism of the piece (plan §2).
       */
      light.x = Math.sin(time / 31.4) * 11.0 + Math.sin(time / 7.7) * 2.6;
      light.y = Math.cos(time / 43.1) * 12.0 + Math.cos(time / 11.3) * 3.0;
      light.z = -86.0 + Math.sin(time / 26.7) * 14.0;
      light.w = 0.60 + 0.40 * (0.5 + 0.5 * Math.sin(time / 11.0));
    },
  };
}
