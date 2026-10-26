/**
 * physics-debug.js — opt-in overlays for tuning + regression testing the
 * terminal-phase physics.
 *
 * Three independent overlays, each safe to toggle on its own:
 *
 *   • TrajectoryOverlay  — renders the last shot's sample trace as a polyline
 *                          in the active THREE.Scene (airborne = white,
 *                          rolling = cyan) with red dots at bounce contacts.
 *   • SurfaceTintOverlay — drops a translucent coloured wireframe clone of
 *                          every `userData.surface` mesh in the scene, so
 *                          fairway/rough/bunker boundaries are visually
 *                          obvious while debugging roll behaviour.
 *   • LiveReadout        — a small DOM panel appended to `vis.overlay` that
 *                          shows the live physics state each frame (speed,
 *                          current surface, bounce count, roll distance, …).
 *
 * The aggregator class PhysicsDebug wires the three into the <golf-visualiser>
 * lifecycle; host code never touches the individual classes directly.
 *
 * Design notes
 * ------------
 * All overlays are disposed when detached so re-toggling never leaks GPU
 * memory. SurfaceTintOverlay re-scans on `golf:scenechange` because the
 * active mesh set changes between scenes. LiveReadout polls the simulator
 * state from its host's rAF loop (via a tick callback) instead of listening
 * to events — events are too coarse-grained to drive a live speedometer.
 */

import * as THREE from 'three';

// Per-surface tint colours. Pulled from a palette rather than
// `golf-course-zones.json` to keep the visualiser independent of the
// builder's JSON; overlay is a debug aid, not a visual-spec source of truth.
const SURFACE_TINTS = Object.freeze({
  fairway:          0x4a7c3f,
  fringe:           0x5ea85e,
  green:            0x2d6e2d,
  tee_box:          0x80cc50,
  rough:            0x3d6b34,
  rough_deep:       0x2e5427,
  bunker_fairway:   0xe6dfc4,
  bunker_greenside: 0xddd4b8,
  hazard_water:     0x3a7ca5,
  hazard_lateral:   0x2a5c95,
  driving_range:    0x6aac4f,
  drop_zone:        0x90c870,
  path:             0xb0a899,
  mound:            0x5a7a4a,
  out_of_bounds:    0x8a8a8a,
  penalty_area:     0x9a5a5a,
  spectator_area:   0x7a7a7a,
  test_grid:        0xcccccc
});
const UNKNOWN_TINT = 0xff00ff; // magenta so missing mappings stand out

// -----------------------------------------------------------------------------
// TrajectoryOverlay
// -----------------------------------------------------------------------------

/**
 * Renders `vis.lastShotTrace` as two line segments + bounce dots.
 *
 * Phase is inferred from the sample's surface field + the y-component of its
 * velocity. A cleaner alternative would be to record the phase in each trace
 * entry, but the current simulator doesn't — and making it do so would leak
 * an implementation detail through the trace API. This heuristic works fine
 * because trace entries during rolling always have near-zero vertical
 * velocity (< rollTransitionVy ≈ 0.15 m/s), so any sample with |vy| above
 * that is considered airborne.
 */
class TrajectoryOverlay {
  constructor() {
    this._group = new THREE.Group();
    this._group.name = 'physics-debug-trajectory';
    this._airLine = null;
    this._rollLine = null;
    this._bouncePoints = null;
    this._vis = null;
  }

  attach(vis) {
    this._vis = vis;
    if (vis.scene) vis.scene.add(this._group);

    // Refresh each time a shot finishes — the trace is only final on REST.
    this._onRest = () => this.refresh();
    vis.addEventListener('golf:rest',  this._onRest);
    vis.addEventListener('golf:water', this._onRest);
  }

  detach() {
    if (!this._vis) return;
    this._vis.removeEventListener('golf:rest',  this._onRest);
    this._vis.removeEventListener('golf:water', this._onRest);
    if (this._vis.scene) this._vis.scene.remove(this._group);
    this._disposeAll();
    this._vis = null;
  }

  /** Rebuild from the visualiser's current `lastShotTrace`. */
  refresh() {
    this._disposeAll();
    const trace = this._vis?.lastShotTrace ?? [];
    if (trace.length < 2) return;

    const airPts  = [];
    const rollPts = [];
    const bounces = [];

    for (let i = 0; i < trace.length; i++) {
      const s = trace[i];
      const rolling = Math.abs(s.vel.y) < 0.3;
      if (rolling) rollPts.push(s.pos);
      else         airPts.push(s.pos);

      // Heuristic: a sample where the previous sample's vy was strongly
      // negative and this sample's vy flipped to positive marks a bounce
      // contact. Doesn't mark rest contacts (fine — we don't want to).
      if (i > 0) {
        const prev = trace[i - 1];
        if (prev.vel.y < -0.5 && s.vel.y > 0.1) bounces.push(s.pos);
      }
    }

    if (airPts.length > 1)  this._airLine  = this._makeLine(airPts,  0xffffff, 1);
    if (rollPts.length > 1) this._rollLine = this._makeLine(rollPts, 0x00d0ff, 2);
    if (bounces.length > 0) this._bouncePoints = this._makePoints(bounces, 0xff3355);
  }

  _makeLine(points, color, linewidth) {
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const mat  = new THREE.LineBasicMaterial({ color, linewidth, depthTest: false });
    const line = new THREE.Line(geom, mat);
    line.renderOrder = 999;
    this._group.add(line);
    return line;
  }

  _makePoints(points, color) {
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const mat  = new THREE.PointsMaterial({ color, size: 0.25, sizeAttenuation: true, depthTest: false });
    const pts  = new THREE.Points(geom, mat);
    pts.renderOrder = 1000;
    this._group.add(pts);
    return pts;
  }

  _disposeAll() {
    for (const obj of [this._airLine, this._rollLine, this._bouncePoints]) {
      if (!obj) continue;
      this._group.remove(obj);
      obj.geometry?.dispose();
      obj.material?.dispose();
    }
    this._airLine = this._rollLine = this._bouncePoints = null;
  }
}

// -----------------------------------------------------------------------------
// SurfaceTintOverlay
// -----------------------------------------------------------------------------

/**
 * Walks the active scene and overlays a translucent coloured clone of every
 * mesh that carries `userData.surface`. Tints by surface id using
 * SURFACE_TINTS. Rebuilds on `golf:scenechange`.
 *
 * We clone the mesh geometry (reference, no copy) and give it a NEW material
 * so toggling the overlay doesn't touch the originals. The clone is parented
 * off the overlay group, matrix-inherited from the original's world matrix so
 * animated scenes would work too (none today, but cheap correctness).
 */
class SurfaceTintOverlay {
  constructor() {
    this._group = new THREE.Group();
    this._group.name = 'physics-debug-surface-tint';
    this._vis = null;
  }

  attach(vis) {
    this._vis = vis;
    if (vis.scene) vis.scene.add(this._group);
    this.refresh();

    this._onSceneChange = () => this.refresh();
    vis.addEventListener('golf:scenechange', this._onSceneChange);
    vis.addEventListener('golf:ready',       this._onSceneChange);
  }

  detach() {
    if (!this._vis) return;
    this._vis.removeEventListener('golf:scenechange', this._onSceneChange);
    this._vis.removeEventListener('golf:ready',       this._onSceneChange);
    if (this._vis.scene) this._vis.scene.remove(this._group);
    this._disposeAll();
    this._vis = null;
  }

  refresh() {
    this._disposeAll();
    const root = this._findSurfaceRoot();
    if (!root) return;

    root.traverse((obj) => {
      if (!obj.isMesh || !obj.userData?.surface?.id) return;
      const color = SURFACE_TINTS[obj.userData.surface.id] ?? UNKNOWN_TINT;
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      const clone = new THREE.Mesh(obj.geometry, mat);
      obj.updateWorldMatrix(true, false);
      clone.applyMatrix4(obj.matrixWorld);
      // Lift 2 mm above the original so it wins the depth fight without
      // z-fighting artefacts at shallow camera angles.
      clone.position.y += 0.002;
      clone.renderOrder = 500;
      this._group.add(clone);
    });
  }

  _findSurfaceRoot() {
    const vis = this._vis;
    if (!vis) return null;
    // Prefer the active scene container; fall back to the whole GLB model.
    const activeName = vis.activeScene?.name;
    if (activeName && vis._scenesRoot) {
      const active = vis._scenesRoot.getObjectByName(activeName);
      if (active) return active;
    }
    return vis._glbModel ?? null;
  }

  _disposeAll() {
    for (const child of [...this._group.children]) {
      this._group.remove(child);
      child.material?.dispose();
      // Note: geometry is shared with the original mesh — do NOT dispose.
    }
  }
}

// -----------------------------------------------------------------------------
// LiveReadout
// -----------------------------------------------------------------------------

/**
 * Tiny DOM panel showing live physics state.
 *
 * Updates itself via requestAnimationFrame rather than event-driven so the
 * speed/roll-distance fields tick smoothly each frame during a shot.
 */
class LiveReadout {
  constructor() {
    this._el = null;
    this._vis = null;
    this._rafId = null;
    this._stats = { bounces: 0, rollDist: 0, totalDist: 0, lastPos: null };
  }

  attach(vis) {
    this._vis = vis;
    this._el = document.createElement('div');
    this._el.className = 'physics-debug-readout';
    Object.assign(this._el.style, {
      position: 'absolute',
      bottom: '12px',
      left: '12px',
      padding: '10px 12px',
      background: 'rgba(0, 0, 0, 0.72)',
      color: '#e6f0ff',
      font: '11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
      borderRadius: '8px',
      pointerEvents: 'none',
      zIndex: '50',
      minWidth: '220px',
      backdropFilter: 'blur(6px)',
      WebkitBackdropFilter: 'blur(6px)'
    });
    this._el.textContent = 'physics: idle';
    vis.overlay?.appendChild(this._el);

    // Bounce / roll-distance stats are event-driven; instantaneous speed
    // + surface are frame-driven.
    this._onLand       = () => { this._stats = { bounces: 0, rollDist: 0, totalDist: 0, lastPos: null }; };
    this._onBounce     = (e) => { this._stats.bounces = e.detail.bounceIndex ?? (this._stats.bounces + 1); };
    vis.addEventListener('golf:land',   this._onLand);
    vis.addEventListener('golf:bounce', this._onBounce);

    const tick = () => {
      this._render();
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  detach() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    if (this._vis) {
      this._vis.removeEventListener('golf:land',   this._onLand);
      this._vis.removeEventListener('golf:bounce', this._onBounce);
    }
    this._el?.remove();
    this._el = null;
    this._vis = null;
  }

  _render() {
    const vis = this._vis;
    if (!vis || !this._el) return;
    const sim = vis._simulator;
    const st  = sim?.state;

    if (!st) {
      this._el.textContent = 'physics: idle';
      return;
    }

    const v = st.velocity;
    const speed = Math.hypot(v.x, v.y, v.z);
    const pos = st.position;

    // Accumulate roll distance per frame while rolling.
    if (st.phase === 'rolling') {
      if (this._stats.lastPos) {
        const dx = pos.x - this._stats.lastPos.x;
        const dz = pos.z - this._stats.lastPos.z;
        this._stats.rollDist += Math.hypot(dx, dz);
      }
      this._stats.lastPos = { x: pos.x, z: pos.z };
    }

    // Total distance tracked by the simulator (air + roll).
    this._stats.totalDist = st.totalDistance ?? this._stats.totalDist;

    const hit = vis._surfaceSampler?.sampleAt?.(pos.x, pos.z);
    const surf = hit?.surface;
    const surfTxt = surf
      ? `${surf.id} f=${surf.friction} e=${surf.restitution} rr=${surf.rollResistance}`
      : '—';

    this._el.innerHTML = [
      `<strong style="color:#7ee0ff">phase</strong> ${st.phase}`,
      `<strong style="color:#7ee0ff">speed</strong> ${speed.toFixed(2)} m/s`,
      `<strong style="color:#7ee0ff">surface</strong> ${surfTxt}`,
      `<strong style="color:#7ee0ff">bounces</strong> ${this._stats.bounces}`,
      `<strong style="color:#7ee0ff">roll</strong> ${this._stats.rollDist.toFixed(1)} m`,
      `<strong style="color:#7ee0ff">total</strong> ${this._stats.totalDist.toFixed(1)} m`
    ].join('<br>');
  }
}

// -----------------------------------------------------------------------------
// PhysicsDebug aggregator
// -----------------------------------------------------------------------------

const DEFAULT_FLAGS = Object.freeze({
  trajectory:  true,
  surfaceTint: true,
  readout:     true
});

/**
 * Owns the three overlays and exposes a single attach/detach/setFlags API
 * to the visualiser. Flags are independent booleans — flipping one toggles
 * the matching overlay without touching the others.
 */
export class PhysicsDebug {
  constructor() {
    this._vis = null;
    this._flags = { ...DEFAULT_FLAGS };
    this._overlays = {
      trajectory:  new TrajectoryOverlay(),
      surfaceTint: new SurfaceTintOverlay(),
      readout:     new LiveReadout()
    };
    this._attached = { trajectory: false, surfaceTint: false, readout: false };
  }

  attach(vis, flags) {
    this._vis = vis;
    if (flags !== undefined) this.setFlags(flags);
    else this._applyFlags();
  }

  detach() {
    for (const key of Object.keys(this._overlays)) {
      if (this._attached[key]) {
        this._overlays[key].detach();
        this._attached[key] = false;
      }
    }
    this._vis = null;
  }

  /**
   * Accepts either `true` / `false` (all-on / all-off) or a partial
   * `{ trajectory, surfaceTint, readout }` object; unspecified keys keep
   * their current state.
   */
  setFlags(flagsOrBool) {
    if (flagsOrBool === true)  this._flags = { trajectory: true,  surfaceTint: true,  readout: true  };
    else if (flagsOrBool === false) this._flags = { trajectory: false, surfaceTint: false, readout: false };
    else if (flagsOrBool && typeof flagsOrBool === 'object') this._flags = { ...this._flags, ...flagsOrBool };
    this._applyFlags();
  }

  getFlags() {
    return { ...this._flags };
  }

  _applyFlags() {
    if (!this._vis) return;
    for (const key of Object.keys(this._overlays)) {
      const want = !!this._flags[key];
      const have = this._attached[key];
      if (want && !have) {
        this._overlays[key].attach(this._vis);
        this._attached[key] = true;
      } else if (!want && have) {
        this._overlays[key].detach();
        this._attached[key] = false;
      }
    }
  }
}
