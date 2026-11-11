/**
 * SurfaceSampler — single source of truth for "what surface is under this point?"
 *
 * Wraps a Three.js Raycaster against the loaded scene root and normalises the
 * `userData.surface` block from any version of the schema into a stable v2 shape
 * the integrator can consume without branching.
 *
 * Why this lives in its own module:
 *   - The integrator (bounce-roll.js) calls `sampleAt()` 60-120 times per
 *     second during a shot. Centralising the raycast + lookup here keeps that
 *     hot path readable.
 *   - Any future schema bump (v3, v4) is absorbed in `_normaliseSurface()`,
 *     so the integrator never sees version drift.
 *   - The default fallback (`DEFAULT_SURFACE`) is defined once. If a GLB
 *     ships without `userData.surface` (e.g. a non-builder GLB the host
 *     loads), the ball still bounces sensibly.
 *
 * Usage:
 *   const sampler = new SurfaceSampler(sceneRoot);
 *   const hit = sampler.sampleAt(ballX, ballZ, fromY = 100);
 *   if (hit) {
 *     // hit.point: THREE.Vector3 (worldspace contact point)
 *     // hit.normal: THREE.Vector3 (worldspace surface normal)
 *     // hit.surface: normalised v2 surface profile (always populated)
 *     // hit.object: the THREE.Mesh that was hit
 *   }
 */

import * as THREE from 'three';

/**
 * Default surface used when a hit mesh has no `userData.surface`. Tuned to
 * "generic firm ground" — playable but not exciting. Values match the
 * tee_box / fairway middle-ground so the ball doesn't behave wildly.
 *
 * Frozen so accidental mutation by a caller doesn't poison every fallback
 * for the rest of the session.
 */
export const DEFAULT_SURFACE = Object.freeze({
  id: 'unknown_firm_ground',
  version: 2,
  friction: 0.32,
  restitution: 0.22,
  rollResistance: 0.14,
  absorb: false,
  spinGrab: 0.30
});

export class SurfaceSampler {
  /**
   * @param {THREE.Object3D} sceneRoot - The currently active scene (typically
   *   the visible `scene__NN__Label` group, NOT the `scenes` parent — sampling
   *   only the active subtree avoids hitting hidden sibling scenes).
   */
  constructor(sceneRoot) {
    this._sceneRoot = sceneRoot;
    this._raycaster = new THREE.Raycaster();
    this._down = new THREE.Vector3(0, -1, 0);
    this._origin = new THREE.Vector3();
  }

  /**
   * Replace the active scene root. Call on `golf:scenechange` so samples
   * always hit the visible scene's geometry.
   */
  setSceneRoot(sceneRoot) {
    this._sceneRoot = sceneRoot;
  }

  /**
   * Cast a ray straight down from (x, fromY, z) and return the first hit.
   *
   * @param {number} x
   * @param {number} z
   * @param {number} [fromY=200] - Start height. Must be above the highest
   *   point in the scene; 200 m comfortably covers any real golf hole.
   * @returns {?{point: THREE.Vector3, normal: THREE.Vector3, surface: object, object: THREE.Mesh}}
   *   `null` if no geometry was hit (off-map).
   */
  sampleAt(x, z, fromY = 200) {
    if (!this._sceneRoot) return null;

    this._origin.set(x, fromY, z);
    this._raycaster.set(this._origin, this._down);
    const hits = this._raycaster.intersectObject(this._sceneRoot, true);
    if (!hits.length) return null;

    // Split geometry from surface typing (single-skin courses):
    //   • Contact geometry (point + normal) comes from the visible skin so the
    //     ball rests on what the player sees. Falls back to the topmost hit for
    //     legacy GLBs that have no dedicated visual skin.
    //   • The surface profile comes from the first hit that actually carries a
    //     `userData.surface` (the hidden type collider under the skin).
    const skinHit = hits.find(h => h.object?.userData?.visualOnly);
    // A surface "type" hit is any mesh that can yield a profile: an explicit
    // per-mesh `userData.surface` (Blender courses) OR a single vertex-tagged
    // terrain carrying a `userData.surfaceTable` (course editor). This lets the
    // sampler see through decorative geometry (tee markers, flags) to the ground.
    const surfaceHit = hits.find(h => h.object?.userData?.surface || h.object?.userData?.surfaceTable);
    const contact = skinHit ?? hits[0];
    // Prefer an explicit per-mesh surface collider; otherwise resolve from the
    // contact hit itself, which also covers a single vertex-tagged terrain
    // (userData.surfaceTable + per-vertex `_lie`) authored by the course editor.
    const typeHit = surfaceHit ?? contact;

    return {
      point: contact.point,
      normal: this._worldNormal(contact),
      surface: this.surfaceFromHit(typeHit),
      object: typeHit.object
    };
  }

  /**
   * Resolve a normalised surface profile from a raycast intersection.
   *
   * Order of precedence:
   *   1. Per-mesh `userData.surface` (Blender / legacy per-zone-mesh GLBs).
   *   2. Single vertex-tagged terrain: `userData.surfaceTable` + a per-vertex
   *      lie attribute (`_lie` / `_LIE` / `lie`). The lie of the face vertex
   *      nearest the contact point wins (Risk #3: nearest-vertex rule).
   *   3. `DEFAULT_SURFACE` fallback.
   *
   * @param {{object: THREE.Object3D, face?: object, point?: THREE.Vector3}} hit
   * @returns {object} normalised v2 surface (never null)
   */
  surfaceFromHit(hit) {
    const object = hit?.object;
    if (!object) return DEFAULT_SURFACE;

    if (object.userData?.surface) return this._normaliseSurface(object.userData.surface);

    const table = object.userData?.surfaceTable;
    if (table && hit.face && hit.point) {
      const idx = this._lieIndexAt(object, hit);
      const profile = table.byIndex?.[idx];
      if (profile) return this._normaliseSurface(profile);
    }

    return DEFAULT_SURFACE;
  }

  /**
   * Index into the per-vertex lie attribute for the face vertex nearest the
   * (world-space) contact point. Returns 0 if the attribute is absent.
   */
  _lieIndexAt(object, hit) {
    const geom = object.geometry;
    const attr = geom?.getAttribute?.('_lie')
      || geom?.getAttribute?.('_LIE')
      || geom?.getAttribute?.('lie');
    if (!attr || !hit.face) return 0;

    const local = object.worldToLocal(hit.point.clone());
    const pos = geom.getAttribute('position');
    let best = hit.face.a;
    let bestD = Infinity;
    for (const vi of [hit.face.a, hit.face.b, hit.face.c]) {
      const dx = pos.getX(vi) - local.x;
      const dy = pos.getY(vi) - local.y;
      const dz = pos.getZ(vi) - local.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = vi; }
    }
    return Math.round(attr.getX(best));
  }

  /**
   * Look up the surface profile for a known mesh without raycasting.
   * Used during contact resolution when the integrator already knows
   * which mesh the ball hit.
   *
   * @param {THREE.Object3D} object
   * @returns {object} normalised v2 surface (never null)
   */
  getSurface(object) {
    const raw = object?.userData?.surface;
    if (!raw) return DEFAULT_SURFACE;
    return this._normaliseSurface(raw);
  }

  /**
   * Convert any schema version to the v2 shape the integrator expects.
   * Pure function. Called once per contact, not per frame.
   *
   * v1 → v2 changes:
   *   - `spinGrab` is missing → default to DEFAULT_SURFACE.spinGrab (0.30).
   *
   * Future schema bumps land here. Keep this pure and well-tested.
   */
  _normaliseSurface(raw) {
    const version = raw.version ?? 1;
    if (version >= 2) return raw;
    return {
      ...raw,
      version: 2,
      spinGrab: raw.spinGrab ?? DEFAULT_SURFACE.spinGrab
    };
  }

  /**
   * Three.js raycast hits report the face normal in object-local space.
   * Transform to world space using the hit object's normalMatrix.
   */
  _worldNormal(hit) {
    if (!hit.face) return new THREE.Vector3(0, 1, 0);
    const n = hit.face.normal.clone();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
    return n.applyMatrix3(normalMatrix).normalize();
  }
}
