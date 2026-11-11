/**
 * TriggerDetector — non-physics collision sensors for game-engine use cases.
 *
 * Surfaces (`userData.surface`) shape the ball's motion; triggers
 * (`userData.trigger`) just emit events when the ball volume overlaps them.
 * Two distinct kinds of "collidable" — separation of concerns is intentional:
 *
 *   - Surface  → physics-active, ball bounces off it.
 *   - Trigger  → non-blocking sensor, ball passes through, host reacts to event.
 *
 * A single mesh CAN have both (e.g. a green that fires "ball-on-green" events
 * for stat tracking while still bouncing the ball normally).
 *
 * Triggers come from two places:
 *   1. Baked in the GLB: the builder stamps `userData.trigger` on a mesh.
 *   2. Registered at runtime: host calls `registerRuntime(meshOrName, data)`.
 *      Useful for game scenarios where the targets are added after load.
 *
 * Hysteresis: a trigger only re-fires after the ball has fully exited and
 * re-entered. This prevents per-frame event spam when the ball rolls slowly
 * across a wide trigger volume.
 *
 * Bounding-volume strategy: each trigger gets a `THREE.Box3` computed once
 * at registration. Per-step test is a sphere-vs-AABB intersection — cheap
 * enough to run for hundreds of triggers at 120 Hz.
 */

import * as THREE from 'three';

/**
 * @typedef {object} TriggerEntry
 * @property {string} id            - Stable identifier from userData.trigger.id
 * @property {string} [group]       - Optional grouping for engine consumers
 * @property {object} [data]        - Opaque payload — host-defined
 * @property {THREE.Object3D} object - The trigger mesh
 * @property {THREE.Box3} bounds    - Cached worldspace AABB
 * @property {boolean} ballInside   - Hysteresis state — true while ball overlaps
 */

export class TriggerDetector {
  constructor() {
    /** @type {Map<THREE.Object3D, TriggerEntry>} */
    this._entries = new Map();
    this._sphere = new THREE.Sphere();
  }

  /**
   * Walk a scene root and register every object with `userData.trigger`.
   * Call on initial load and on `golf:scenechange`.
   *
   * Baked entries from a previous scan are dropped first: entries are keyed by
   * object, so without this a scene switch would leave hole 1's triggers armed
   * while hole 2 is live. Runtime-registered triggers survive.
   */
  scanScene(rootGroup) {
    for (const [obj, entry] of this._entries) {
      if (entry._source === 'baked') this._entries.delete(obj);
    }
    if (!rootGroup) return;
    rootGroup.traverse((obj) => {
      if (!obj.userData?.trigger) return;
      this._register(obj, obj.userData.trigger, 'baked');
    });
  }

  /**
   * Register a runtime trigger (not GLB-baked). Useful for game targets that
   * are added after course load.
   *
   * @param {THREE.Object3D} object
   * @param {object} triggerData - { id, group?, data? }
   */
  registerRuntime(object, triggerData) {
    this._register(object, triggerData, 'runtime');
  }

  /**
   * Remove a trigger by mesh reference or by id.
   *
   * TODO(phase-3): support removal-by-id lookup.
   */
  unregister(objectOrId) {
    if (typeof objectOrId === 'string') {
      // TODO(phase-3): scan map for matching id
      for (const [obj, entry] of this._entries) {
        if (entry.id === objectOrId) {
          this._entries.delete(obj);
          return true;
        }
      }
      return false;
    }
    return this._entries.delete(objectOrId);
  }

  /**
   * Test the ball volume against every registered trigger and return any
   * that the ball *just entered* this frame (hysteresis: a trigger that
   * was already overlapped on the previous frame is suppressed).
   *
   * @param {THREE.Vector3} ballPosition
   * @param {number} ballRadius
   * @param {THREE.Vector3} ballVelocity
   * @returns {Array<object>} payload-ready event objects (one per newly-entered trigger)
   */
  testStep(ballPosition, ballRadius, ballVelocity) {
    this._sphere.set(ballPosition, ballRadius);
    const fired = [];

    for (const entry of this._entries.values()) {
      const inside = entry.bounds.intersectsSphere(this._sphere);

      if (inside && !entry.ballInside) {
        // Newly entered → fire.
        fired.push({
          trigger: { id: entry.id, group: entry.group, data: entry.data },
          position: ballPosition.clone(),
          velocity: ballVelocity.clone(),
          ballRadius,
          hitObject: entry.object
        });
      }
      entry.ballInside = inside;
    }

    return fired;
  }

  /**
   * Reset hysteresis (call on new shot start). Otherwise a ball coming to
   * rest inside a trigger keeps `ballInside = true` and the next shot
   * starting elsewhere never fires the trigger again.
   */
  resetHysteresis() {
    for (const entry of this._entries.values()) entry.ballInside = false;
  }

  /** Total trigger count (for debug HUD). */
  get count() {
    return this._entries.size;
  }

  _register(object, triggerData, source) {
    if (!triggerData || !triggerData.id) return;

    const bounds = new THREE.Box3().setFromObject(object);
    this._entries.set(object, {
      id: triggerData.id,
      group: triggerData.group ?? null,
      data: triggerData.data ?? {},
      object,
      bounds,
      ballInside: false,
      _source: source
    });
  }
}
