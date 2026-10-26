/**
 * Cup hole cut — discard terrain fragments inside the cup cylinder so the
 * sunken cup mesh (and ball) are visible through the green.
 *
 * Physics already punches via CupCapture; without this GPU discard the
 * continuous heightfield hides the well (you only see a flat rim ring).
 *
 * Safe to call repeatedly. Wraps any existing `onBeforeCompile` (e.g. clay).
 * Re-wraps automatically if clay (or another look) replaces `onBeforeCompile`.
 */

import * as THREE from 'three';
import { isClayTerrainCandidate } from './clay-terrain-look.js';

const CUT_KEY = 'cup-hole-cut-v1';

/**
 * Ensure a material can discard fragments inside the active cup.
 * @param {THREE.Material} material
 */
function ensureCupHoleUniforms(material) {
  const ud = material.userData;
  const center = ud.cupHoleCenterXZ;
  const hasCenter =
    center
    && center.value
    && typeof center.value.set === 'function';
  if (!hasCenter) {
    ud.cupHoleCenterXZ = { value: new THREE.Vector2(0, 0) };
  }
  if (!ud.cupHoleRadiusSq || typeof ud.cupHoleRadiusSq.value !== 'number') {
    ud.cupHoleRadiusSq = { value: 0 };
  }
  if (!ud.cupHoleEnabled || typeof ud.cupHoleEnabled.value !== 'number') {
    ud.cupHoleEnabled = { value: 0 };
  }
}

export function ensureCupHoleCut(material) {
  if (!material || Array.isArray(material)) return;
  material.userData = material.userData || {};

  // GLB extras / re-exports can leave plain `{x,y}` objects here — recreate
  // proper shader uniforms so `.value.set` never throws during boot.
  ensureCupHoleUniforms(material);

  // Clay / setLook may replace onBeforeCompile after we wrapped — re-wrap then.
  if (
    material.userData.cupHoleCutApplied
    && material.userData.cupHoleCompileWrapped === material.onBeforeCompile
  ) {
    return;
  }

  const prevCompile = material.onBeforeCompile;
  const wrapped = (shader, renderer) => {
    if (typeof prevCompile === 'function') prevCompile.call(material, shader, renderer);

    shader.uniforms.cupHoleCenterXZ = material.userData.cupHoleCenterXZ;
    shader.uniforms.cupHoleRadiusSq = material.userData.cupHoleRadiusSq;
    shader.uniforms.cupHoleEnabled = material.userData.cupHoleEnabled;

    if (!shader.vertexShader.includes('vCupHoleWorldPos')) {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vCupHoleWorldPos;`
        )
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
vCupHoleWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
        );
    }

    if (!shader.fragmentShader.includes('cupHoleEnabled')) {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform vec2 cupHoleCenterXZ;
uniform float cupHoleRadiusSq;
uniform float cupHoleEnabled;
varying vec3 vCupHoleWorldPos;`
        )
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>
if (cupHoleEnabled > 0.5) {
  vec2 dHole = vCupHoleWorldPos.xz - cupHoleCenterXZ;
  if (dot(dHole, dHole) < cupHoleRadiusSq) discard;
}`
        );
    }
  };

  material.onBeforeCompile = wrapped;
  material.userData.cupHoleCompileWrapped = wrapped;
  material.userData.cupHoleCutApplied = true;

  if (!material.userData.cupHoleBaseCacheKey) {
    material.userData.cupHoleBaseCacheKey = material.customProgramCacheKey
      ? material.customProgramCacheKey.bind(material)
      : () => '';
  }
  material.customProgramCacheKey = () =>
    `${material.userData.cupHoleBaseCacheKey()}|${CUT_KEY}`;
  material.needsUpdate = true;
}

/**
 * @param {THREE.Material} material
 * @param {{ x: number, z: number, radius: number } | null} hole
 */
export function setCupHoleCut(material, hole) {
  ensureCupHoleCut(material);
  // Re-validate after ensure — GLB-restored userData can still be a plain
  // `{x,y}` until uniforms are rebuilt.
  ensureCupHoleUniforms(material);
  if (!hole || !(hole.radius > 0)) {
    material.userData.cupHoleEnabled.value = 0;
    return;
  }
  material.userData.cupHoleCenterXZ.value.set(hole.x, hole.z);
  material.userData.cupHoleRadiusSq.value = hole.radius * hole.radius;
  material.userData.cupHoleEnabled.value = 1;
}

/**
 * Apply / clear the cup hole on every terrain-like mesh under `root`.
 * @param {THREE.Object3D|null} root
 * @param {{ x: number, z: number, radius: number } | null} hole
 */
export function setCupHoleCutOnRoot(root, hole) {
  if (!root) return;
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    if (!isClayTerrainCandidate(obj) && !obj.userData?.surfaceTable) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) setCupHoleCut(mat, hole);
  });
}
