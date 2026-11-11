/**
 * ColliderSampler — forward-swept solid-collider lookup.
 *
 * Parallel to SurfaceSampler but semantically different:
 *   - SurfaceSampler: casts DOWN to find ground under a point.
 *   - ColliderSampler: casts FORWARD (along velocity) to find walls / ramps /
 *     posts the ball is about to hit from any angle.
 *
 * Detects meshes carrying `userData.collider` and provides a swept-sphere test
 * the integrator runs once per sub-step before the ground-contact check. A
 * collider hit takes precedence over ground contact (collider-first policy,
 * see solid-colliders-prd.md §5.5) — a mesh marked as both `surface` and
 * `collider` is treated as a solid blocker; a separate child mesh should
 * carry the walkable surface.
 *
 * CCD strategy: 5-ray parallel fan along velocity (center + 4 perpendicular
 * offsets of 0.7 × ballRadius). This approximates a swept-sphere for walls
 * thicker than ~0.7 × ballRadius; paper-thin triangles between the rays can
 * still tunnel. True swept-sphere-vs-triangle is v2 if that becomes an issue.
 *
 * Normal-direction contract: raycast normals on arbitrary Blender geometry may
 * point INTO the solid (wrong winding). The runtime defensively flips any
 * normal where `velocity · n > 0` at contact time — the integrator cares about
 * outward normals, not authoring orthodoxy.
 *
 * Usage:
 *   const sampler = new ColliderSampler(sceneRoot);
 *   const hit = sampler.sweptTest(ballCenter, velDir, sweptLen, ballRadius);
 *   if (hit) {
 *     // hit.point / hit.normal / hit.distance / hit.collider / hit.object
 *   }
 */

import * as THREE from 'three';

/**
 * Default collider profile used when a hit mesh has `userData.collider` missing
 * numeric fields. Tuned to "generic painted wood wall" — a plausible mini-golf
 * or driving-range fence. Frozen so callers can't mutate the fallback.
 *
 * spinGrab is 0 for solids: walls don't grab backspin the way turf does, so a
 * ball striking a wall should not have its tangent reduced by spin coupling.
 */
export const DEFAULT_COLLIDER = Object.freeze({
  id: 'unknown_collider',
  type: 'solid',
  restitution: 0.50,
  friction: 0.30,
  spinGrab: 0.0
});

export class ColliderSampler {
  /**
   * @param {THREE.Object3D} sceneRoot - Same root SurfaceSampler uses. Typically
   *   the active scene subtree in a multi-scene GLB so we don't hit hidden walls
   *   from sibling scenes.
   */
  constructor(sceneRoot) {
    this._sceneRoot = sceneRoot;
    this._raycaster = new THREE.Raycaster();
    // GLB-baked collider meshes (scanned from the scene graph).
    this._colliderMeshes = [];
    // Host-registered collider meshes (added at runtime via registerCollider).
    // Kept separate so a scene rescan doesn't blow them away.
    this._runtimeColliders = [];
    this._warnedMeshes = new Set();

    // Reusable scratch vectors — allocated once, reused every sweptTest() call.
    // sweptTest is called up to 120 times per second per shot; allocations
    // would churn the GC during long rollouts.
    this._scratchOrigin = new THREE.Vector3();
    this._scratchRight = new THREE.Vector3();
    this._scratchUpPerp = new THREE.Vector3();
    this._scratchUp = new THREE.Vector3();

    // Five parallel offsets forming a plus-shape around the center ray.
    // 0.7 × radius gives good coverage without being so wide it reports hits
    // the ball's silhouette wouldn't actually touch.
    this._offsets = [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ];

    this._scanScene();
  }

  /**
   * Replace the active scene root and rescan. Call on `golf:scenechange` so
   * only colliders in the visible scene are tested (avoids phantom walls from
   * sibling scenes in multi-scene GLBs).
   */
  setSceneRoot(sceneRoot) {
    this._sceneRoot = sceneRoot;
    this._scanScene();
  }

  /**
   * Re-enumerate collider meshes under the current scene root. Public so hosts
   * adding runtime walls (e.g. a programmatic mini-golf layout) can refresh the
   * list after inserting their meshes into the scene graph.
   */
  rescan() {
    this._scanScene();
  }

  /**
   * @returns {number} total number of currently-registered collider meshes
   *   (scene-scanned plus host-registered). Useful for debug overlays + tests.
   */
  get count() {
    return this._colliderMeshes.length + this._runtimeColliders.length;
  }

  /**
   * Register a collider mesh that lives outside the scanned scene graph
   * (e.g. a programmatic mini-golf wall added to `vis.scene` by the host,
   * or test-fixture geometry). The mesh must have `userData.collider` set —
   * if it doesn't, the default collider profile is used on hit.
   *
   * Idempotent: registering the same mesh twice is a no-op.
   *
   * Forces a matrixWorld update so the first raycast against this mesh
   * sees its final position/rotation, not the pre-transform identity. Hosts
   * often `mesh.position.copy(...)` then `scene.add(mesh)` and immediately
   * fire a shot — without this, THREE's lazy auto-update would leave the
   * wall at the origin until the next render frame.
   */
  registerCollider(mesh) {
    if (!mesh || !mesh.isMesh) return;
    if (this._runtimeColliders.includes(mesh)) return;
    if (this._colliderMeshes.includes(mesh)) return;
    mesh.updateMatrixWorld(true);
    this._runtimeColliders.push(mesh);
  }

  /** Remove a previously-registered runtime collider. */
  unregisterCollider(mesh) {
    const i = this._runtimeColliders.indexOf(mesh);
    if (i >= 0) this._runtimeColliders.splice(i, 1);
  }

  /**
   * Swept-sphere test: casts a 5-ray fan along `dir` from `from`, returns the
   * closest intersection with any `userData.collider` mesh, or `null`.
   *
   * @param {THREE.Vector3} from - Ball center at start of the sub-step.
   * @param {THREE.Vector3} dir - Unit velocity direction.
   * @param {number} distance - Sweep length in metres. Typically
   *   `|velocity| * dt + ballRadius` so we catch contacts inside the
   *   predicted step plus the ball's leading hemisphere.
   * @param {number} radius - Ball radius. Perpendicular offsets are
   *   `0.7 * radius` away from the central ray.
   * @returns {?{
   *   point: THREE.Vector3,
   *   normal: THREE.Vector3,
   *   distance: number,
   *   object: THREE.Mesh,
   *   collider: object
   * }}
   */
  sweptTest(from, dir, distance, radius) {
    const totalCount = this._colliderMeshes.length + this._runtimeColliders.length;
    if (totalCount === 0) return null;
    if (distance <= 0) return null;

    // Orthonormal basis perpendicular to dir. Pick a safe reference up vector
    // to avoid a near-parallel cross product when dir is vertical.
    if (Math.abs(dir.y) < 0.9) {
      this._scratchUp.set(0, 1, 0);
    } else {
      this._scratchUp.set(1, 0, 0);
    }
    this._scratchRight.crossVectors(dir, this._scratchUp).normalize();
    this._scratchUpPerp.crossVectors(this._scratchRight, dir).normalize();

    const rawRadius = radius * 0.7;
    let best = null;

    for (const [rx, ry] of this._offsets) {
      this._scratchOrigin
        .copy(from)
        .addScaledVector(this._scratchRight, rx * rawRadius)
        .addScaledVector(this._scratchUpPerp, ry * rawRadius);

      this._raycaster.set(this._scratchOrigin, dir);
      this._raycaster.far = distance;
      // Test both scene-scanned and runtime-registered collider meshes.
      // intersectObjects already sorts by distance, so we only need to
      // inspect hits[0] from each list.
      if (this._colliderMeshes.length) {
        const hits = this._raycaster.intersectObjects(this._colliderMeshes, false);
        if (hits.length && (best === null || hits[0].distance < best.distance)) {
          best = hits[0];
        }
      }
      if (this._runtimeColliders.length) {
        const hits = this._raycaster.intersectObjects(this._runtimeColliders, false);
        if (hits.length && (best === null || hits[0].distance < best.distance)) {
          best = hits[0];
        }
      }
    }

    if (!best) return null;

    return {
      point: best.point,
      normal: this._worldNormal(best),
      distance: best.distance,
      object: best.object,
      collider: this.getCollider(best.object)
    };
  }

  /**
   * Look up the collider profile for a known mesh without raycasting. Used
   * during contact resolution when the integrator already has the hit mesh.
   *
   * @param {THREE.Object3D} object
   * @returns {object} normalised collider (never null)
   */
  getCollider(object) {
    const raw = object?.userData?.collider;
    if (!raw) return DEFAULT_COLLIDER;
    return this._validate(raw, object);
  }

  // ---------------------------------------------------------------------------

  _scanScene() {
    this._colliderMeshes.length = 0;
    if (!this._sceneRoot) return;
    // Force world-matrix refresh on the whole subtree so the first raycast
    // after a scene change sees fully-resolved collider transforms. THREE
    // would update these lazily on the next render, but a shot fired in the
    // same frame as the scene load would otherwise hit identity-positioned
    // meshes.
    this._sceneRoot.updateMatrixWorld(true);
    this._sceneRoot.traverse((obj) => {
      if (obj.isMesh && obj.userData?.collider) {
        this._colliderMeshes.push(obj);
      }
    });
  }

  /**
   * Coerce a raw userData.collider into a well-shaped profile, warning once
   * per mesh about missing numeric fields. Typos in Blender custom properties
   * (e.g. "restition") silently fall back to the default — the warning tells
   * authors which mesh is misconfigured without crashing the sim.
   */
  _validate(raw, mesh) {
    const profile = {
      id:          typeof raw.id          === 'string' ? raw.id          : DEFAULT_COLLIDER.id,
      type:        typeof raw.type        === 'string' ? raw.type        : DEFAULT_COLLIDER.type,
      restitution: typeof raw.restitution === 'number' ? raw.restitution : DEFAULT_COLLIDER.restitution,
      friction:    typeof raw.friction    === 'number' ? raw.friction    : DEFAULT_COLLIDER.friction,
      spinGrab:    typeof raw.spinGrab    === 'number' ? raw.spinGrab    : DEFAULT_COLLIDER.spinGrab
    };

    if (!this._warnedMeshes.has(mesh)) {
      const missing = [];
      if (typeof raw.restitution !== 'number') missing.push('restitution');
      if (typeof raw.friction    !== 'number') missing.push('friction');
      if (missing.length) {
        const name = mesh?.name || '<unnamed>';
        console.warn(
          `[ColliderSampler] mesh "${name}" userData.collider missing ` +
          `numeric field(s): ${missing.join(', ')} — using defaults ` +
          `(restitution=${DEFAULT_COLLIDER.restitution}, friction=${DEFAULT_COLLIDER.friction})`
        );
      }
      this._warnedMeshes.add(mesh);
    }

    return profile;
  }

  _worldNormal(hit) {
    if (!hit.face) return new THREE.Vector3(0, 1, 0);
    const n = hit.face.normal.clone();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
    return n.applyMatrix3(normalMatrix).normalize();
  }
}
