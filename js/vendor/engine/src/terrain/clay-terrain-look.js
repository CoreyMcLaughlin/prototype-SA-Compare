/**
 * Clay-plus terrain look — soft albedo × vertex colors + gentle world mottling.
 *
 * Tuned for a smooth clay read: low-contrast map, light texture bombing (no
 * tile seams), minimal large-scale noise. Shared by editor + visualiser.
 */

import * as THREE from 'three';

/**
 * Master switch for clay-plus look (shader map/noise, soft zone blends).
 * Set `false` to compare against the original flat vertex-color surfaces.
 */
export const CLAY_PLUS_ENABLED = true;

/** Soft paint brush falloff (independent of clay-plus look). */
export const SOFT_PAINT_ENABLED = true;

/** Metres of ground covered by one albedo tile (before bombing breaks seams). */
export const CLAY_TILE_M = 28;

/** Amplitude of large-scale world-XZ mottling (0 = off). Keep very low for clay. */
export const CLAY_NOISE_AMT = 0.008;

/**
 * How much the albedo map tints the surface (0 = flat vertex color only,
 * 1 = full map). Lower = smoother clay.
 */
export const CLAY_MAP_AMT = 0;

const LOOK_KEY = 'clay-terrain-look-v7-toggle';

let _albedoTex = null;

/** Soft, low-contrast grayscale albedo (near-white so vertex colors dominate). */
export function getClayAlbedoTexture() {
  if (_albedoTex) return _albedoTex;

  const size = 256;
  const raw = new Float32Array(size * size);
  // Large periods only — soft cloud-like blobs, no fine grit.
  const octaves = [
    { period: 4, amp: 0.55 },
    { period: 8, amp: 0.35 },
    { period: 16, amp: 0.10 }
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0;
      let wsum = 0;
      for (const o of octaves) {
        n += seamlessValueNoise(x, y, o.period, size) * o.amp;
        wsum += o.amp;
      }
      raw[y * size + x] = n / wsum;
    }
  }

  // Box blur (wrap) for extra smoothing toward a clay/matte read.
  const blurred = new Float32Array(size * size);
  const r = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = (x + dx + size) % size;
          const yy = (y + dy + size) % size;
          sum += raw[yy * size + xx];
          count++;
        }
      }
      blurred[y * size + x] = sum / count;
    }
  }

  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    // Very narrow luminance band → subtle variation when multiplied.
    const g = Math.round(248 + blurred[i] * 7);
    const o = i * 4;
    data[o] = g;
    data[o + 1] = g;
    data[o + 2] = g;
    data[o + 3] = 255;
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  tex.name = 'clayAlbedo';
  _albedoTex = tex;
  return tex;
}

/**
 * Project UVs from local XZ so the albedo tiles in world metres.
 * Safe to call repeatedly (overwrites `uv`).
 */
export function ensureWorldXZUVs(geometry, tileM = CLAY_TILE_M) {
  if (!geometry?.attributes?.position) return;
  const pos = geometry.getAttribute('position');
  const n = pos.count;
  let uv = geometry.getAttribute('uv');
  if (!uv || uv.count !== n) {
    uv = new THREE.BufferAttribute(new Float32Array(n * 2), 2);
    geometry.setAttribute('uv', uv);
  }
  const inv = 1 / Math.max(1e-6, tileM);
  for (let i = 0; i < n; i++) {
    uv.setXY(i, pos.getX(i) * inv, pos.getZ(i) * inv);
  }
  uv.needsUpdate = true;
}

/**
 * Apply clay-plus look to a terrain (or skin) mesh.
 * Idempotent — re-entry refreshes map/UVs and recompiles if needed.
 * When {@link CLAY_PLUS_ENABLED} is false, strips any prior clay look.
 */
export function applyClayTerrainLook(mesh, opts = {}) {
  if (!mesh?.isMesh || !mesh.geometry) return;
  const mat = mesh.material;
  if (!mat || Array.isArray(mat)) return;

  if (!CLAY_PLUS_ENABLED) {
    mat.map = null;
    mat.onBeforeCompile = () => {};
    mat.customProgramCacheKey = () => 'clay-terrain-off';
    if (mat.userData) mat.userData.clayTerrainLook = false;
    mat.needsUpdate = true;
    return;
  }

  const tileM = opts.tileM ?? CLAY_TILE_M;
  const noiseAmt = opts.noiseAmt ?? CLAY_NOISE_AMT;
  const mapAmt = opts.mapAmt ?? CLAY_MAP_AMT;

  ensureWorldXZUVs(mesh.geometry, tileM);

  const tex = getClayAlbedoTexture();
  mat.map = tex;
  if (mat.color) mat.color.set(0xffffff);
  mat.vertexColors = true;
  if ('roughness' in mat) mat.roughness = 1;
  if ('metalness' in mat) mat.metalness = 0;

  mat.userData = mat.userData || {};
  mat.userData.clayTerrainLook = true;
  mat.userData.clayNoiseAmt = noiseAmt;
  mat.userData.clayTileM = tileM;
  mat.userData.clayMapAmt = mapAmt;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.clayNoiseAmt = { value: mat.userData.clayNoiseAmt };
    shader.uniforms.clayTileM = { value: mat.userData.clayTileM };
    shader.uniforms.clayMapAmt = { value: mat.userData.clayMapAmt };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vClayWorldPos;`
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vClayWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float clayNoiseAmt;
uniform float clayTileM;
uniform float clayMapAmt;
varying vec3 vClayWorldPos;

float clayHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float clayValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = clayHash(i);
  float b = clayHash(i + vec2(1.0, 0.0));
  float c = clayHash(i + vec2(0.0, 1.0));
  float d = clayHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float clayFbm(vec2 p) {
  return clayValueNoise(p) * 0.55
       + clayValueNoise(p * 1.9) * 0.30
       + clayValueNoise(p * 3.4) * 0.15;
}
vec2 clayRotate(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}
`
      )
      .replace(
        '#include <map_fragment>',
        `
#ifdef USE_MAP
{
  vec2 wp = vClayWorldPos.xz;
  vec2 baseUv = wp / max(clayTileM, 1e-3);
  vec2 duvdx = dFdx(baseUv);
  vec2 duvdy = dFdy(baseUv);

  // Soft no-tile bombing — keeps seams away without busy grit.
  float k = clayFbm(wp * 0.035);
  float l = k * 6.0;
  float f = fract(l);
  float ia = floor(l);
  float ib = ia + 1.0;

  vec2 ha = vec2(clayHash(vec2(ia, 0.31)), clayHash(vec2(ia, 1.73)));
  vec2 hb = vec2(clayHash(vec2(ib, 0.31)), clayHash(vec2(ib, 1.73)));
  float aa = clayHash(vec2(ia, 2.91)) * 6.2831853;
  float ab = clayHash(vec2(ib, 2.91)) * 6.2831853;

  vec2 uva = clayRotate(baseUv + ha * 3.0, aa);
  vec2 uvb = clayRotate(baseUv * 1.02 + hb * 3.0, ab);

  vec4 ta = textureGrad(map, uva, duvdx, duvdy);
  vec4 tb = textureGrad(map, uvb, duvdx, duvdy);
  float w = smoothstep(0.2, 0.8, f);
  vec4 bombed = mix(ta, tb, w);

  // Mix toward white so the surface stays clay-smooth; map is a hint only.
  vec4 softMap = mix(vec4(1.0), bombed, clamp(clayMapAmt, 0.0, 1.0));
  diffuseColor *= softMap;

  // Very gentle large-scale mottling (almost off by default).
  float n = clayFbm(wp * 0.04);
  diffuseColor.rgb *= 1.0 + (n - 0.5) * 2.0 * clayNoiseAmt;
}
#endif
`
      );
  };

  mat.customProgramCacheKey = () => LOOK_KEY;
  mat.needsUpdate = true;
}

/** True when a mesh should get the clay terrain treatment. */
export function isClayTerrainCandidate(mesh) {
  if (!mesh?.isMesh || !mesh.geometry) return false;
  const ud = mesh.userData || {};
  if (!(ud.visualOnly || ud.surfaceTable || ud.singleMeshTerrain)) return false;
  return !!(mesh.geometry.attributes && mesh.geometry.attributes.color);
}

// ── Seamless procedural value noise (CPU, for albedo bake) ─────────────────

function hash2(ix, iy) {
  const n = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

/** Value noise with toroidal wrap so the DataTexture tiles without a seam. */
function seamlessValueNoise(x, y, period, size) {
  const fx = (x / size) * period;
  const fy = (y / size) * period;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const ux = tx * tx * (3 - 2 * tx);
  const uy = ty * ty * (3 - 2 * ty);
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const x0w = ((x0 % period) + period) % period;
  const y0w = ((y0 % period) + period) % period;
  const a = hash2(x0w, y0w);
  const b = hash2(x1, y0w);
  const c = hash2(x0w, y1);
  const d = hash2(x1, y1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
