/**
 * CupCapture — local ground punch under the pin so the ball can fall into
 * the cup without remeshing the heightfield.
 *
 * Terrain cells are ~1–1.5 m; the cup is ~30 cm across. Punching vertices
 * would create a crater. Instead, when the ball's XZ is inside the cup
 * cylinder we replace the green sample with a synthetic cup-floor hit.
 * Crossing the rim creates a real air gap → gravity drops the ball in.
 * A matching GPU discard (`cup-hole-cut.js`) hides the green so the well shows.
 *
 * Soft capture assist: a nearly-stopped ball just outside the rim is pulled
 * into the punch so lip-rests finish cleanly (classic golf-game feel).
 *
 * Dimensions match the editor pin in `editor/src/project/template.js`.
 */

import * as THREE from 'three';

export const CUP_DEFAULTS = Object.freeze({
  // ~30 cm opening — ball Ø ~9 cm; readable on the green and easy to putt into.
  // Keep in sync with editor `buildFlagAndCupNodes` CUP_R / CUP_DEPTH.
  radius: 0.15,
  depth: 0.18,
  assistRadiusMul: 1.2,
  assistSpeed: 0.35,
  // Surface profile used for the synthetic cup-floor hit. absorb:true so
  // BounceRollSimulator can terminate as HOLED (not water).
  floorSurface: Object.freeze({
    id: 'hole_cup',
    version: 1,
    friction: 0.9,
    restitution: 0.05,
    rollResistance: 0.95,
    absorb: true,
    spinGrab: 0
  })
});

const _up = new THREE.Vector3(0, 1, 0);

export class CupCapture {
  constructor(defaults = {}) {
    this._radius = defaults.radius ?? CUP_DEFAULTS.radius;
    this._depth = defaults.depth ?? CUP_DEFAULTS.depth;
    this._assistRadiusMul = defaults.assistRadiusMul ?? CUP_DEFAULTS.assistRadiusMul;
    this._assistSpeed = defaults.assistSpeed ?? CUP_DEFAULTS.assistSpeed;
    this._floorSurface = defaults.floorSurface ?? CUP_DEFAULTS.floorSurface;

    /** @type {{ x: number, y: number, z: number, rimY: number, id: string|null, holeNumber: number|null } | null} */
    this._cup = null;
  }

  /**
   * @param {{ center: THREE.Vector3|{x:number,y:number,z:number}, rimY?: number, radius?: number, depth?: number, id?: string, holeNumber?: number } | null} desc
   */
  setCup(desc) {
    if (!desc || !desc.center) {
      this._cup = null;
      return;
    }
    const c = desc.center;
    this._cup = {
      x: c.x,
      y: c.y,
      z: c.z,
      rimY: Number.isFinite(desc.rimY) ? desc.rimY : c.y,
      id: desc.id ?? null,
      holeNumber: desc.holeNumber ?? null
    };
    if (Number.isFinite(desc.radius)) this._radius = desc.radius;
    if (Number.isFinite(desc.depth)) this._depth = desc.depth;
  }

  clear() {
    this._cup = null;
  }

  get active() {
    return this._cup != null;
  }

  get cup() {
    return this._cup;
  }

  get radius() {
    return this._radius;
  }

  get depth() {
    return this._depth;
  }

  /**
   * Horizontal distance from (x,z) to cup center, or Infinity if no cup.
   * @param {number} x
   * @param {number} z
   */
  distanceXZ(x, z) {
    if (!this._cup) return Infinity;
    const dx = x - this._cup.x;
    const dz = z - this._cup.z;
    return Math.hypot(dx, dz);
  }

  /**
   * If (x,z) is inside the cup (or soft-assist zone at low speed), replace
   * the green ground sample with a synthetic cup-floor hit.
   *
   * @param {object|null} hit - SurfaceSampler hit (mutated in place when punched)
   * @param {number} x
   * @param {number} z
   * @param {{ horizontalSpeed?: number }} [opts]
   * @returns {object|null} the (possibly patched) hit
   */
  patchSample(hit, x, z, opts = {}) {
    if (!this._cup || !hit) return hit;

    const dist = this.distanceXZ(x, z);
    const speed = opts.horizontalSpeed ?? 0;
    const assistR = this._radius * this._assistRadiusMul;

    let punch = dist <= this._radius;
    if (!punch && dist <= assistR && speed < this._assistSpeed) {
      punch = true;
    }
    if (!punch) return hit;

    const floorY = this._cup.rimY - this._depth;
    hit.point = hit.point instanceof THREE.Vector3
      ? hit.point.set(x, floorY, z)
      : new THREE.Vector3(x, floorY, z);
    hit.normal = hit.normal instanceof THREE.Vector3
      ? hit.normal.copy(_up)
      : _up.clone();
    hit.surface = this._floorSurface;
    hit._cupFloor = true;
    return hit;
  }
}
