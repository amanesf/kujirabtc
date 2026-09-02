import * as THREE from 'three';

/**
 * The renderer, sized for a phone held upright.
 *
 * Unlike jellyfish — which pins its buffer to a reference frame because every
 * constant in it was fitted against a painting at that exact resolution — this
 * piece has no plate to register against and no fitted pixel radii, so it
 * renders at the viewport's own shape. What it does have is a thermal budget:
 * a phone that renders this at 3x device pixels will hold sixty frames for
 * about ninety seconds and then throttle, and a piece meant to be watched for
 * an hour cannot spend its quality on the first minute.
 *
 * So the pixel count is capped rather than the ratio. Roughly two megapixels is
 * a little over a full-resolution iPhone screen in portrait, and it is the
 * point past which the additive point-sprite fill of scene/field.ts stops being
 * free on mobile silicon.
 */
const MAX_PIXELS = 2_100_000;

/*
 * Two overrides, and they exist for scripts/capture.js rather than for viewers.
 *
 *   ?scale=0.5   multiplies the pixel budget
 *   ?res=96      sets the field's texture edge directly
 *
 * A headless browser renders through SwiftShader on the CPU, where a hundred
 * thousand instanced quads and a forty-eight step raymarch take minutes per
 * frame rather than milliseconds. The composition, the palette and the layout
 * are all still exactly right at a quarter of the particles, and those are what
 * a still is looked at for.
 */
const params = new URLSearchParams(window.location.search);

export interface Stage {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  /** Current drawing-buffer size, in pixels. */
  size: THREE.Vector2;
  /** Viewport aspect (w/h). Below 1 on a phone in portrait. */
  aspect: () => number;
  resize: () => void;
}

export function createStage(host: HTMLElement): Stage {
  const renderer = new THREE.WebGLRenderer({
    antialias: false, // nothing here has a hard edge; the post chain is the AA
    alpha: false,
    powerPreference: 'high-performance',
    // The abyss is very dark and the display is likely OLED. Without a deep
    // buffer the gradient from #04070c to black bands visibly, in wide flat
    // areas, which is most of this picture.
    stencil: false,
    depth: true,
  });
  renderer.setClearColor(0x000000, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 400);
  camera.position.set(0, 0, 30);

  const size = new THREE.Vector2(1, 1);
  const canvas = renderer.domElement;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  host.appendChild(canvas);

  function resize(): void {
    const w = host.clientWidth || window.innerWidth;
    const h = host.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * Number(params.get('scale') ?? 1);
    // Scale the ratio down, never the layout size: the canvas always fills the
    // viewport, and quality is what gives way.
    const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h * dpr * dpr)));
    renderer.setPixelRatio(dpr * scale);
    renderer.setSize(w, h, false);
    renderer.getDrawingBufferSize(size);

    /*
     * Vertical field of view is held constant and the horizontal follows from
     * the aspect, which is three.js' default and is the correct choice *here*
     * specifically because the vertical axis is price (core/frame.ts). The
     * frame must always show the same amount of price whatever the shape of the
     * screen; a phone in portrait then simply shows a narrower slice of ocean,
     * which is exactly right — you are looking down a shaft of water.
     */
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();

  return {
    renderer,
    camera,
    size,
    aspect: () => camera.aspect,
    resize,
  };
}

/**
 * How many particles the field gets, decided once at startup.
 *
 * The simulation is nearly free — it is two small fragment shaders over a
 * texture — and the cost is entirely the additive fill of the sprites, so the
 * count scales with the pixel budget rather than with anything about the CPU.
 * The values are a texture edge: 320^2 is 102,400 krill, 200^2 is 40,000.
 *
 * Forty thousand is not a compromised version of a hundred thousand. Both read
 * as "uncountably many" — past a few thousand the eye stops counting and starts
 * seeing a medium, which is the only thing the field is for.
 */
export function fieldResolution(): number {
  const override = Number(params.get('res'));
  if (override > 0) return Math.round(override);
  const mobile = Math.min(window.innerWidth, window.innerHeight) < 700
    || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  return mobile ? 200 : 320;
}
