import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { SurfaceSampler } from './src/physics/surface-sampler.js';
import { ColliderSampler } from './src/physics/collider-sampler.js';
import { TriggerDetector } from './src/physics/trigger-detector.js';
import { BounceRollSimulator } from './src/physics/bounce-roll.js';
import { CupCapture, CUP_DEFAULTS } from './src/physics/cup-capture.js';
import { PhysicsDebug } from './src/physics/physics-debug.js';
import {
  applyClayTerrainLook,
  isClayTerrainCandidate
} from './src/terrain/clay-terrain-look.js';
import { setCupHoleCutOnRoot } from './src/terrain/cup-hole-cut.js';
import { createPhoneSwingHost } from './src/input/phone-swing-host.js';
import { buildClubPowerShot, scalePuttDistance } from './src/input/club-power-shot.js';

/** Horizontal distance (m) at which the flag fades so the cup is readable. */
const PIN_FADE_DIST_M = 2.5;
/** Seconds to lerp flag opacity 1→0 (or back). */
const PIN_FADE_SECONDS = 0.35;

/**
 * Upper bound on a single frame's delta (30 fps). Guards ball animation and
 * physics against hitches and backgrounded tabs, where an unclamped delta
 * would advance the ball metres in one step.
 */
const MAX_FRAME_DT = 1 / 30;

/**
 * Built-in equirect skyboxes shipped next to this module (`engine/sky/`).
 * Apps reference them with `scene.skybox.preset` (e.g. `"light-blue"`).
 * Custom app skies use `scene.skybox.path` relative to the page (`./sky/...`).
 *
 * Each `url` uses a static `new URL(..., import.meta.url)` so Vite emits the
 * JPG into the editor bundle and raw ESM apps resolve next to this script.
 */
export const ENGINE_SKY_PRESETS = {
  'light-blue': {
    id: 'light-blue',
    label: 'Light blue',
    type: 'equirect',
    url: new URL('./sky/light-blue.jpg', import.meta.url).href,
  },
  'deep-blue': {
    id: 'deep-blue',
    label: 'Deep blue',
    type: 'equirect',
    url: new URL('./sky/deep-blue.jpg', import.meta.url).href,
  },
  'light-clouds': {
    id: 'light-clouds',
    label: 'Light clouds',
    type: 'equirect',
    url: new URL('./sky/light-clouds.jpg', import.meta.url).href,
  },
};

/** Resolve a built-in preset id to an absolute URL. */
export function resolveEngineSkyUrl(presetId) {
  const entry = ENGINE_SKY_PRESETS[presetId];
  return entry ? entry.url : null;
}

const DEFAULTS = {
  scene: { scaleFactor: 1.0, background: '#9ec9dc', skybox: null, fog: null },
  // Soft, high-ambient lighting for a matte clay look. Blender scene lights
  // are NOT exported — this config (or app-config.json) is the sole light rig.
  lighting: {
    ambient: { color: '#eaf2f6', intensity: 1.55 },
    directional: { color: '#fff6ea', intensity: 0.28, position: [2, 6, 1] },
    // Hybrid shadows (opt-in per app). Ball uses a cheap fake blob; course
    // props cast via a directional shadow map that updates only when the
    // play focus / lighting changes — not every frame.
    shadows: {
      enabled: false,
      mapSize: 2048,
      cameraSize: 120,
      bias: -0.0005,
      normalBias: 0.02,
      type: 'pcfsoft',          // pcfsoft | pcf | basic
      intensity: 1,             // directional shadow darkness (Three.js light.shadow.intensity)
      lightDistance: 200,       // meters the dir light sits from the focus point
      ball: {
        enabled: true,
        opacity: 0.4,
        scale: 3.0,             // multiplier of ball radius for blob diameter
        maxHeight: 40,          // meters — opacity fades to ~0 as ball rises
      },
      static: {
        enabled: true,
        cast: 'nonTerrain',     // nonTerrain = props/trees cast; terrain receives
      },
    },
  },
  // Prop / vegetation distance culling (not fog). `propsDistance` 0 = off.
  culling: {
    propsDistance: 0,
  },
  camera: {
    fov: 55, near: 0.1, far: 2000,
    transitionDuration: 1.2, followShot: true,
    behindBallOffset: [0, 4, -10],
    // Follow-cam chase tuning (flight + roll). The behind vector is kept
    // horizontal so a near-vertical chip/lob doesn't drop the camera below
    // the ball, and the camera is never allowed below the terrain behind it.
    followBehindDist: 15,      // meters the chase camera sits behind the ball
    followAboveHeight: 5,      // meters the chase camera sits above the ball
    followGroundClearance: 1.5, // min meters the camera stays above the surface
    defaultPosition: [0, 120, 0],
    defaultTarget: [0, 0, 0],
    // When true, the camera frames the current hole's flag: on initial load /
    // position change (unless the position has a calibrated pose), and again
    // ~1s after a shot comes to rest. User drag during the idle window or the
    // transition cancels the auto-aim.
    autoAimAtFlag: true,
    autoAimDelay: 1.0,       // seconds of rest before post-shot re-aim
    autoAimBehindDist: 12,   // meters camera sits behind the ball on ball→flag
    autoAimAboveHeight: 4,   // meters camera sits above the ball
    // Meters the camera's look-at target sits above the ball. Tilts the view
    // upward so tall trajectories (drivers, lofted wedges) stay fully visible
    // without clipping at the top of the viewport. 0 = aim straight at the ball
    // (legacy behaviour).
    autoAimTargetHeight: 5,
    // Dogleg handoff: when a waypoint exists, default aim is the waypoint until
    // the ball enters this radius (metres) or the flag is closer than the
    // waypoint — then sticky pin for the rest of the hole. See
    // `_resolveDefaultAimTarget`.
    waypointHandoffRadius: 60,
    // Click-to-aim within this radius (metres) of the flag counts as "aimed for
    // the green" — sticky pin default for the rest of the hole.
    greenAimRadius: 40,
  },
  tracer: {
    color: '#ffffff', opacity: 0.85, width: 0.4,
    segments: 60, fadeStart: true, maxShots: 5,
    // When true, previous radar shots stored in IndexedDB are redrawn on load.
    // Cache/history clears do not wipe IndexedDB — use clearShots() or set
    // restoreOnLoad: false in app-config to start clean.
    restoreOnLoad: true,
  },
  ball: { radius: 0.2, color: '#ffffff', animationSpeedMultiplier: 1.0 },
  // Short tapered trail behind the moving ball (flight + roll). `enabled`
  // toggles visibility; `time` is how long the path persists in seconds.
  // Distinct from `tracer` (full-arc ribbon, off in follow-cam).
  comet: { enabled: true, time: 0.45, color: '#ffffff' },
  ui: {
    positionSelector: { visible: true, anchor: 'top-left' },
    clearShortcut: 'c',
    defaultScene: null,  // name (e.g. "scene__01__Default") — null picks lowest-numbered scene
  },
  // Renderer-level color response applied to the whole frame. `toneMapping` is
  // one of: none | ACESFilmic | AgX | Neutral | Reinhard | Cineon. `exposure`
  // brightens/darkens the tone-mapped result (ignored when toneMapping is none).
  rendering: { toneMapping: 'none', exposure: 1.0 },
  // How every course mesh is shaded. `style` is one of:
  //   clay      — matte, non-metallic (default, current baseline look)
  //   realistic — keep the GLB's original PBR values (roughness/metalness/maps)
  //   toon      — cel-shaded / banded lighting (see toonSteps)
  //   phong     — classic shiny highlight
  //   basic     — unlit flat color/texture (ignores lighting)
  //   normal    — debug: surface normals mapped to RGB
  // `toonSteps` is the number of light bands, only used when style is "toon".
  shading: { style: 'clay', toonSteps: 4 },
  scenes: {},  // optional { [sceneName]: { camera?, lighting?, scene? } } per-scene overrides
};

// ── Club Bag ─────────────────────────────────────────────────────────────────
//
// DEFAULT_CLUBS is the fallback bag used when `app-config.json` does not
// contain a `bag.clubs` array. Per-instance bags are stored on `this._clubs`
// so different visualisers on the same page can carry different bags.
//
// `dispersion` is the ±1σ carry variation in metres, used both by the
// test-shot variance sampler and (future) the "dispersion" auto-select
// policy. Putter is kept very tight; woods/driver widen with distance.

const DEFAULT_CLUBS = [
  { id: 'PT',     label: 'Putter', name: 'Putter',          carry: 5,   dispersion: 0.5, maxHeight: 0.2, launchAngle: 2,    hangTime: 1.0, curveRange: 0     },
  { id: 'LW',     label: 'LW',     name: 'Lob Wedge',      carry: 15,  dispersion: 3,   maxHeight: 12, launchAngle: 50,   hangTime: 2.2, curveRange: 0.015 },
  { id: 'SW',     label: 'SW',     name: 'Sand Wedge',     carry: 20,  dispersion: 3,   maxHeight: 14, launchAngle: 46,   hangTime: 2.5, curveRange: 0.015 },
  { id: 'GW',     label: 'GW',     name: 'Gap Wedge',      carry: 50,  dispersion: 4,   maxHeight: 20, launchAngle: 40,   hangTime: 3.5, curveRange: 0.02  },
  { id: 'PW',     label: 'PW',     name: 'Pitching Wedge',  carry: 100, dispersion: 6,   maxHeight: 26, launchAngle: 35,   hangTime: 4.8, curveRange: 0.025 },
  { id: '9i',     label: '9i',     name: '9-Iron',          carry: 115, dispersion: 7,   maxHeight: 27, launchAngle: 32,   hangTime: 5.0, curveRange: 0.03  },
  { id: '8i',     label: '8i',     name: '8-Iron',          carry: 130, dispersion: 8,   maxHeight: 27, launchAngle: 29,   hangTime: 5.2, curveRange: 0.03  },
  { id: '7i',     label: '7i',     name: '7-Iron',          carry: 145, dispersion: 9,   maxHeight: 28, launchAngle: 25,   hangTime: 5.4, curveRange: 0.035 },
  { id: '6i',     label: '6i',     name: '6-Iron',          carry: 160, dispersion: 10,  maxHeight: 28, launchAngle: 22,   hangTime: 5.5, curveRange: 0.04  },
  { id: '5i',     label: '5i',     name: '5-Iron',          carry: 175, dispersion: 11,  maxHeight: 27, launchAngle: 19,   hangTime: 5.5, curveRange: 0.04  },
  { id: '4i',     label: '4i',     name: '4-Iron',          carry: 190, dispersion: 12,  maxHeight: 26, launchAngle: 17,   hangTime: 5.5, curveRange: 0.045 },
  { id: '5H',     label: '5H',     name: '5-Hybrid',        carry: 200, dispersion: 13,  maxHeight: 27, launchAngle: 16,   hangTime: 5.6, curveRange: 0.05  },
  { id: '3W',     label: '3W',     name: '3-Wood',          carry: 220, dispersion: 15,  maxHeight: 28, launchAngle: 12,   hangTime: 5.9, curveRange: 0.055 },
  { id: '5W',     label: '5W',     name: '5-Wood',          carry: 235, dispersion: 15,  maxHeight: 29, launchAngle: 10,   hangTime: 6.0, curveRange: 0.055 },
  { id: 'DR',     label: 'Driver', name: 'Driver',          carry: 250, dispersion: 18,  maxHeight: 30, launchAngle: 10.5, hangTime: 6.2, curveRange: 0.06  },
];

/**
 * Optional UI-only bag fields (practice titles / shot columns). Copied through
 * when present so `vis.clubs` / `vis.selectedClub` keep them. Never used by
 * flight physics or the built-in test-shot generator.
 */
const CLUB_UI_FIELDS = [
  'total',
  'ballSpeed',
  'spinRate',
  'landingAngle',
  'fromPin',
  'spinAxis',
  'launchDirection',
  'side',
  'curve',
];

/**
 * Normalise a raw `bag.clubs` entry from config into the internal club shape.
 * Requires at minimum `id` (string) and `carry` (finite number). Missing
 * fields fall back to sensible defaults so partially-populated config entries
 * (e.g. just id + carry + dispersion) still produce usable clubs.
 *
 * Returns null if the entry is invalid and should be skipped.
 */
function normaliseClubEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  const carry = Number(raw.carry);
  if (!Number.isFinite(carry)) return null;

  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const club = {
    id:          raw.id,
    label:       typeof raw.label === 'string' && raw.label ? raw.label : raw.id,
    name:        typeof raw.name  === 'string' && raw.name  ? raw.name  : raw.id,
    carry,
    // Default dispersion: ±5% of carry when absent. Keeps old-style club
    // definitions working without forcing every caller to hand-tune it.
    dispersion:  num(raw.dispersion, Math.max(carry * 0.05, 0.5)),
    maxHeight:   num(raw.maxHeight, Math.max(carry * 0.15, 1)),
    launchAngle: num(raw.launchAngle, 20),
    hangTime:    num(raw.hangTime, 4.0),
    curveRange:  num(raw.curveRange, 0.03),
  };

  for (const key of CLUB_UI_FIELDS) {
    const n = Number(raw[key]);
    if (Number.isFinite(n)) club[key] = n;
  }
  return club;
}

/**
 * Build a per-instance club list from optional config. Falls back to
 * DEFAULT_CLUBS when config is missing/empty or all entries are invalid.
 */
function resolveClubsFromConfig(bagConfig) {
  const raw = bagConfig && Array.isArray(bagConfig.clubs) ? bagConfig.clubs : null;
  if (!raw || raw.length === 0) return DEFAULT_CLUBS.map(c => ({ ...c }));
  const normalised = raw.map(normaliseClubEntry).filter(Boolean);
  if (normalised.length === 0) return DEFAULT_CLUBS.map(c => ({ ...c }));
  return normalised;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Deep-copy trigger `size` so nested `points` arrays are not shared with the GLB. */
function copyTriggerSize(size) {
  if (!size || typeof size !== 'object') return null;
  const out = { ...size };
  if (Array.isArray(size.points)) {
    out.points = size.points.map((p) => (
      Array.isArray(p) ? [Number(p[0]), Number(p[1])] : p
    ));
  }
  return out;
}

function deepMerge(defaults, overrides) {
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    if (
      overrides[key] && typeof overrides[key] === 'object' &&
      !Array.isArray(overrides[key]) &&
      defaults[key] && typeof defaults[key] === 'object' &&
      !Array.isArray(defaults[key])
    ) {
      result[key] = deepMerge(defaults[key], overrides[key]);
    } else {
      result[key] = overrides[key];
    }
  }
  return result;
}

// ── Scene Container GLB Detection ────────────────────────────────────────

/**
 * Parse a zone / hole-scoped mesh name like:
 *   "fairway__01"        -> { zoneId: "fairway", holeNumber: 1, variant: null }
 *   "tee_marker__01__white" -> { zoneId: "tee_marker", holeNumber: 1, variant: "white" }
 */
function parseMeshName(name) {
  const SEP = '__';
  const parts = name.split(SEP);
  if (parts.length < 2 || parts.length > 3) return null;

  const holeNumber = parseInt(parts[1], 10);
  if (isNaN(holeNumber)) return null;

  return {
    zoneId:     parts[0],
    holeNumber,
    variant:    parts[2] || null,
  };
}

/**
 * Parse a scene group name:
 *   "scene__01__Default"             -> { number: 1, label: "Default", raw: ... }
 *   "scene__00__Test_Grid_100x400"   -> { number: 0, label: "Test Grid 100x400", raw: ... }
 * Underscores in the label decode to spaces for display.
 */
function parseSceneName(name) {
  if (!name || typeof name !== 'string') return null;
  const match = name.match(/^scene__(\d+)__(.+)$/);
  if (!match) return null;
  const number = parseInt(match[1], 10);
  if (isNaN(number)) return null;
  const label = match[2].replace(/_/g, ' ').trim();
  if (!label) return null;
  return { number, label, raw: name };
}

/**
 * A GLB passes the scenes contract if:
 *   - it contains a group named "scenes" at any depth,
 *   - with at least one child whose name matches `scene__NN__Label`.
 */
function isSceneContainerGLB(scene) {
  const scenesRoot = scene.getObjectByName('scenes');
  if (!scenesRoot) return false;
  return scenesRoot.children.some((child) => parseSceneName(child.name) !== null);
}

/**
 * Enumerate all well-formed scene groups under the `scenes` root, sorted by number.
 * Returns [{ name, number, label, group }, ...]
 */
function enumerateScenes(scenesRoot) {
  if (!scenesRoot) return [];
  const scenes = [];
  for (const child of scenesRoot.children) {
    const parsed = parseSceneName(child.name);
    if (!parsed) continue;
    scenes.push({ ...parsed, name: parsed.raw, group: child });
  }
  return scenes.sort((a, b) => a.number - b.number);
}

/** Editor `range` or builder `driving_range` — practice-style scene. */
function isRangeCourseType(courseType) {
  return courseType === 'range' || courseType === 'driving_range';
}

/**
 * Resolve per-scene courseType from config.scenes (array or name-keyed object),
 * falling back to the GLB scene group's userData.
 *
 * The GLB is the normal source — the editor stamps `courseType` into node extras
 * at export, so the asset is self-describing and `config.scenes` is usually
 * absent. When it *is* present it wins, so an app can override a hole without
 * re-exporting the course.
 */
function resolveSceneCourseType(configScenes, sceneName, sceneGroup) {
  if (Array.isArray(configScenes)) {
    const meta = configScenes.find(
      (s) => s && (s.id === sceneName || s.name === sceneName)
    );
    if (typeof meta?.courseType === 'string' && meta.courseType) return meta.courseType;
  } else if (configScenes && typeof configScenes === 'object') {
    const entry = configScenes[sceneName];
    if (typeof entry?.courseType === 'string' && entry.courseType) return entry.courseType;
  }

  const fromGroup = sceneGroup?.userData?.courseType;
  if (typeof fromGroup === 'string' && fromGroup) return fromGroup;
  return null;
}

/**
 * @param {THREE.Object3D} courseGroup
 * @param {{ forceStaticCamera?: boolean }} [opts]
 *   When true (editor Range / practice), positions default to Static (followShot false).
 */
function extractCourseData(courseGroup, { forceStaticCamera = false } = {}) {
  const positions = [];
  const holeData = new Map();
  const holes = new Map();
  let hasDrivingRange = false;

  courseGroup.traverse((child) => {
    const parsed = parseMeshName(child.name);
    if (!parsed) return;

    const { zoneId, holeNumber, variant } = parsed;
    if (!holes.has(holeNumber)) {
      holes.set(holeNumber, { teeBox: null, teeMarkers: [], flag: null, cup: null, hasDrivingRange: false });
    }
    const hole = holes.get(holeNumber);

    if (zoneId === 'tee_box' && !hole.teeBox) hole.teeBox = child;
    if (zoneId === 'tee_marker') hole.teeMarkers.push({ node: child, color: variant });
    if (zoneId === 'flag' && !hole.flag) hole.flag = child;
    if (zoneId === 'hole_cup' && !hole.cup) hole.cup = child;
    if (zoneId === 'driving_range') {
      hole.hasDrivingRange = true;
      hasDrivingRange = true;
    }
  });

  const sortedHoles = [...holes.keys()].sort((a, b) => a - b);
  const waypointPos = firstWaypointWorldPosition(courseGroup);

  for (const holeNum of sortedHoles) {
    const hole = holes.get(holeNum);
    holeData.set(holeNum, {
      flagNode: hole.flag || null,
      cupNode: hole.cup || null
    });
    if (!hole.teeBox) continue;

    const teeWorldPos = new THREE.Vector3();
    hole.teeBox.getWorldPosition(teeWorldPos);

    const forward = forwardFromOriginToward(teeWorldPos, hole.flag, waypointPos);

    const followShot = forceStaticCamera ? false : !hole.hasDrivingRange;

    if (hole.teeMarkers.length > 0 && !hole.hasDrivingRange && !forceStaticCamera) {
      for (const marker of hole.teeMarkers) {
        const origin = new THREE.Vector3();
        marker.node.getWorldPosition(origin);

        const colorLabel = marker.color
          ? marker.color.charAt(0).toUpperCase() + marker.color.slice(1)
          : '';

        positions.push({
          id:         `hole${holeNum}-tee${marker.color ? '-' + marker.color : ''}`,
          label:      `Hole ${holeNum}${colorLabel ? ' ' + colorLabel : ''} Tee`,
          origin:     [origin.x, origin.y, origin.z],
          forward:    [forward.x, forward.y, forward.z],
          followShot,
          holeNumber: holeNum,
        });
      }
    } else {
      positions.push({
        id:         `hole${holeNum}-tee`,
        label:      hole.hasDrivingRange
          ? `Hole ${holeNum} Driving Range`
          : forceStaticCamera
            ? `Hole ${holeNum} Range`
            : `Hole ${holeNum} Tee`,
        origin:     [teeWorldPos.x, teeWorldPos.y, teeWorldPos.z],
        forward:    [forward.x, forward.y, forward.z],
        followShot,
        holeNumber: holeNum,
      });
    }
  }

  // Custom scenes: no tee_box — ball starts at Game-logic Spawn markers.
  if (positions.length === 0) {
    const spawns = collectSpawnMarkers(courseGroup);
    const flagNode = holeData.get(1)?.flagNode
      || [...holes.values()].find((h) => h.flag)?.flag
      || null;
    const cupNode = holeData.get(1)?.cupNode
      || [...holes.values()].find((h) => h.cup)?.cup
      || null;
    if (!holeData.has(1)) holeData.set(1, { flagNode, cupNode });
    else {
      const entry = holeData.get(1);
      if (!entry.flagNode && flagNode) entry.flagNode = flagNode;
      if (!entry.cupNode && cupNode) entry.cupNode = cupNode;
    }

    const followShot = !forceStaticCamera;
    for (const spawn of spawns) {
      const origin = new THREE.Vector3();
      spawn.node.getWorldPosition(origin);
      const forward = forwardFromOriginToward(origin, flagNode, waypointPos);
      positions.push({
        id:         `spawn-${spawn.id}`,
        label:      spawn.id,
        origin:     [origin.x, origin.y, origin.z],
        forward:    [forward.x, forward.y, forward.z],
        followShot,
        holeNumber: 1,
      });
    }
  }

  return { positions, holeData, hasDrivingRange };
}

/**
 * First Game-logic waypoint (`userData.marker.group === 'waypoint'`) in a
 * scene subtree, sorted by `data.order`. Preferred over the flag for tee
 * forward / default aim on doglegs; Custom also uses it when there is no pin.
 * @param {THREE.Object3D} root
 * @returns {THREE.Vector3|null}
 */
function firstWaypointWorldPosition(root) {
  if (!root) return null;
  const waypoints = [];
  root.traverse((node) => {
    const block = node.userData?.marker;
    if (!block?.id) return;
    if ((block.group || null) !== 'waypoint') return;
    waypoints.push({
      order: Number(block.data?.order),
      node
    });
  });
  if (!waypoints.length) return null;
  waypoints.sort((a, b) => {
    const aOk = Number.isFinite(a.order);
    const bOk = Number.isFinite(b.order);
    if (aOk && bOk && a.order !== b.order) return a.order - b.order;
    if (aOk && !bOk) return -1;
    if (!aOk && bOk) return 1;
    return String(a.node.name || '').localeCompare(String(b.node.name || ''));
  });
  const out = new THREE.Vector3();
  waypoints[0].node.getWorldPosition(out);
  return out;
}

/**
 * Game-logic spawn markers (`userData.marker.group === 'spawn'`), sorted by id.
 * @param {THREE.Object3D} root
 * @returns {Array<{ id: string, node: THREE.Object3D }>}
 */
function collectSpawnMarkers(root) {
  if (!root) return [];
  const list = [];
  root.traverse((node) => {
    const block = node.userData?.marker;
    if (!block?.id) return;
    if ((block.group || null) !== 'spawn') return;
    list.push({ id: String(block.id), node });
  });
  list.sort((a, b) => a.id.localeCompare(b.id));
  return list;
}

/**
 * Horizontal forward from an origin toward a waypoint (dogleg), else flag, else +Z.
 * @param {THREE.Vector3} origin
 * @param {THREE.Object3D|null} flagNode
 * @param {THREE.Vector3|null} waypointPos
 * @returns {THREE.Vector3}
 */
function forwardFromOriginToward(origin, flagNode, waypointPos) {
  const forward = new THREE.Vector3(0, 0, 1);
  let target = null;
  if (waypointPos) {
    target = waypointPos;
  } else if (flagNode) {
    target = new THREE.Vector3();
    flagNode.getWorldPosition(target);
  }
  if (!target) return forward;
  forward.copy(target).sub(origin);
  forward.y = 0;
  if (forward.lengthSq() > 1e-4) forward.normalize();
  else forward.set(0, 0, 1);
  return forward;
}

function evalPoly(coeffs, t) {
  let sum = 0;
  let tPow = 1;
  for (let i = 0; i < coeffs.length; i++) {
    sum += coeffs[i] * tPow;
    tPow *= t;
  }
  return sum;
}

function smoothstep(t) {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

// ── Component ───────────────────────────────────────────────────────────────

class GolfVisualiser extends HTMLElement {

  static get observedAttributes() {
    return ['config'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this._config = null;
    this._scene = null;
    this._camera = null;
    this._renderer = null;
    this._controls = null;
    this._glbModel = null;
    this._raycaster = new THREE.Raycaster();
    this._mouse = new THREE.Vector2();

    // Shot state
    this._tracers = [];       // { group, curve, points }
    this._activeBall = null;  // { mesh, curve, ribbon, progress, duration }
    this._phoneSwingHost = null;
    this._teeBall = null;     // static ball mesh at tee position
    this._ballShadow = null;  // fake blob shadow plane under the ball
    this._ballShadowTexture = null;
    this._shadowFocus = null; // last XZ focus used for the static shadow camera
    this._selectedPosition = null;
    this._currentOrigin = null;  // live ball origin — updated after rest (or reset to tee on water)
    this._currentForward = null; // live forward — rotated by arrow keys in follow mode
    this._exactShotMode = false; // click-to-land mode
    this._lastRenderedShotId = null; // track which shot ID we've rendered

    // Club bag — per-instance so different visualisers can carry different
    // bags. Populated from `config.bag.clubs` in _loadConfig; seeded to the
    // default bag so code that runs before config-load (guards, getters)
    // still sees a valid list.
    this._clubs = DEFAULT_CLUBS.map(c => ({ ...c }));
    // Auto-select policy for club picking. "reach" = shortest club whose
    // carry >= distance-to-target. "off" = never auto-suggest. Other policy
    // strings are reserved for future work (nearest, dispersion). Overridden
    // from config.bag.autoSelect in _loadConfig.
    this._autoSelectPolicy = 'off';
    this._selectedClubId = 'PW';
    // True after the user (or host via setSelectedClub) picks a club. While
    // set, auto-select will not overwrite the choice — so a manual LW on the
    // green can actually be fired. Cleared when the ball rests or the tee /
    // position changes, so the next lie gets a fresh suggestion.
    this._clubManualOverride = false;

    // Camera mode: 'static' or 'follow' — null means use position config default
    this._cameraMode = null;

    // Camera transition state
    this._cameraTransition = null; // { from, to, fromTarget, toTarget, elapsed, duration, _isAutoAim? }

    // Auto-aim-at-flag state. Timer accumulates while the ball is at rest post-
    // shot; once it exceeds autoAimDelay we trigger a transition toward the
    // flag. User drag on OrbitControls cancels both the pending timer and any
    // in-flight auto-aim transition. See _cancelAutoAim / _aimCameraAtFlag.
    this._autoAimPending = false;
    this._restIdleTimer = 0;

    // User-specified aim override. When non-null, camera auto-aim re-frames
    // toward this XZ point instead of the hole's flag. The flag itself is
    // unaffected (it stays where it is for distance calculations, HUD, etc.);
    // this is purely a "where should the camera look" concept. Cleared via
    // clearAimTarget() or by switching to a different hole.
    //
    // Stored as a THREE.Vector3 so callers can pass {x, z} or a Vector3.
    this._aimTarget = null;

    // Sticky "player chose the green" for doglegs. Set when setAimTarget lands
    // within greenAimRadius of the flag; cleared on position / scene change.
    // While true, default aim prefers the pin over the waypoint.
    this._doglegPreferPin = false;

    // Animation — dirty-flag loop: rAF only while busy or a wake requested.
    this._animFrameId = null;
    this._clock = new THREE.Clock();
    this._needsRender = false;
    this._discardNextDelta = false;
    this._ballShadowGroundCache = null;
    this._inAnimateFrame = false;
    this._onVisibilityChange = this._handleVisibilityChange.bind(this);

    // Keyboard movement state
    this._keysPressed = new Set();
    this._moveSpeed = 2.0;  // units per second

    // Authored-course state
    this._isSceneContainerModel = false;
    this._holeData = null;
    this._cupCapture = null;
    // Pin fade: materials cloned on first use; opacity lerped toward target.
    this._pinFadeOpacity = 1;
    this._pinFadeMaterials = null; // Array<{ mat, baseOpacity }> | null
    this._pinFadeFlagNode = null;
    this._ballHoled = false;

    // Multi-scene state
    this._scenesRoot = null;        // THREE.Group named "scenes"
    this._sceneList = [];           // [{ name, number, label, group }, ...]
    this._activeSceneName = null;   // string or null
    this._activeSceneCourseType = null; // e.g. 'par4' | 'range' from config / userData
    this._activeSceneIsRange = false;   // Range / driving_range — Static + always re-tee
    this._baseConfig = null;        // snapshot of config before any scene overrides
    this._pendingSetScene = null;   // name queued via setScene() before GLB is ready
    this._ready = false;            // connectedCallback completed


    // HUD-only preview: hide the WebGL canvas so designers/devs can focus on
    // the overlay web layer. Session-only (not persisted). Camera → HUD menu.
    this._hudOnly = false;

    // Distance culling of vegetation (`veg_*` nodes). Rebuilt per scene.
    this._cullableProps = null;
    this._propCullActive = false;
    this._propCullWorldPos = new THREE.Vector3();

    this._configPath = null;  // for saving

    // Physics (surface-aware bounce & roll). Instantiated after GLB load, when
    // we have a scene root to sample against. Null-checked at call sites so the
    // component is usable before the GLB resolves. See PRD: surface-aware-bounce-roll-prd.md
    this._surfaceSampler = null;
    this._colliderSampler = null;
    this._simulator = null;
    this._physicsDebug = null;           // lazily instantiated on first toggle
    this._physicsDebugFlags = false;     // last-set flags — replayed after GLB load

    // Bound handlers
    this._onMeasurement = this._handleMeasurement.bind(this);
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onKeyUp = this._handleKeyUp.bind(this);
    this._onExactShotClick = this._handleExactShotClick.bind(this);
    this._onResize = this._handleResize.bind(this);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async connectedCallback() {
    if (this._ready) {
      this._handleResize();
      return;
    }
    if (this._booting) return;
    this._booting = true;
    this._log('Component attached');
    this._renderShadowDOM();

    try {
      await this._loadConfig();
      await this._initScene();
      await this._loadGLB();
      this._initControls();

      this._buildMenu();
      const lastPosId = this._loadSetting(this._lastPositionStorageKey());
      const startPos = (lastPosId && this._config.positions.find(p => p.id === lastPosId))
        || this._config.positions[0];
      if (startPos) this._selectPosition(startPos);
      this._startRenderLoop();
      this._bindEvents();
      await this._restoreShots();
      this._ready = true;
      this.dispatchEvent(new CustomEvent('golf:ready', {
        bubbles: true,
        composed: true,
        detail: {
          scenes: this.scenes,
          activeScene: this.activeScene,
        },
      }));
      this._log('Ready');
    } catch (err) {
      this._log(`Init failed: ${err.message}`);
      console.error(err);
      const loadingEl = this.shadowRoot?.getElementById('loading');
      const loadingLabel = this.shadowRoot?.getElementById('loading-label');
      if (loadingLabel) loadingLabel.textContent = `Failed to load: ${err.message}`;
      if (loadingEl) {
        const bar = this.shadowRoot.getElementById('loading-bar');
        bar?.classList.remove('indeterminate');
        // Keep overlay visible so the failure is readable (not a silent black screen).
      }
    }
  }

  disconnectedCallback() {
    // Compare re-renders the page around this view. Keep the course loaded.
    if (this.hasAttribute('persist')) return;
    this._log('Component detached — cleaning up');
    if (this._animFrameId) cancelAnimationFrame(this._animFrameId);
    this._animFrameId = null;
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    document.removeEventListener('trackman:measurement', this._onMeasurement);
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('resize', this._onResize);
    this._unbindTrackerListeners();
    this._phoneSwingHost?.dispose?.();
    this._phoneSwingHost = null;
    this._disposeBallShadow();
    if (this._ballShadowTexture) {
      this._ballShadowTexture.dispose();
      this._ballShadowTexture = null;
    }
    if (this._skyboxTexture) {
      this._skyboxTexture.dispose();
      this._skyboxTexture = null;
    }
    if (this._renderer) this._renderer.dispose();
    if (this._controls) this._controls.dispose();
    this._clearTracers();
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (name === 'config' && newVal !== oldVal) {
      this._log(`Config attribute changed to: ${newVal}`);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Play one shot in this view only. Used by compare so the other slot
   * does not also animate it. Distances are metres, the same as radar data.
   */
  playMeasurement(detail) {
    if (!this._ready || !detail) return false;
    this._clearTracers();
    this._lastRenderedShotId = null;
    this._handleMeasurement({ detail: { ...detail, _isNewShot: true } });
    return true;
  }

  get overlay() {
    return this.shadowRoot.getElementById('overlay');
  }

  get selectedPosition() {
    return this._selectedPosition ? { ...this._selectedPosition } : null;
  }

  get positions() {
    return this._config ? this._config.positions.map(p => ({ ...p })) : [];
  }

  /**
   * All clubs known to the visualiser. Each entry is a shallow copy, safe to
   * mutate by the caller. Ordered wedge → driver, matching the in-menu list.
   *
   * @returns {Array<{id:string,label:string,name:string,carry:number,dispersion:number,maxHeight:number,launchAngle:number,hangTime:number,curveRange:number}>}
   */
  get clubs() {
    return this._clubs.map(c => ({ ...c }));
  }

  /**
   * The currently-selected club. Used by the built-in test-shot generator
   * (Space) and exposed so app-logic layers can show "expected carry",
   * drive caddy hints, or filter target distances. Returns a shallow copy;
   * mutating it does not change the selection — use `setSelectedClub(id)`.
   *
   * @returns {{id:string,label:string,name:string,carry:number,dispersion:number,maxHeight:number,launchAngle:number,hangTime:number,curveRange:number}|null}
   */
  get selectedClub() {
    const club = this._clubs.find(c => c.id === this._selectedClubId);
    return club ? { ...club } : null;
  }

  /**
   * Change the active club by id (e.g. `"7i"`, `"DR"`). Updates the built-in
   * menu highlight (if the menu has been rendered) and dispatches
   * `golf:clubchange` so HUDs can react. No-op if `id` does not match a
   * known club.
   *
   * Dispatches `golf:clubchange` on the `<golf-visualiser>` element with
   * `detail: { club, previous }` — both full club objects (or `null`).
   *
   * @param {string} id
   * @returns {boolean} true if a matching club was found, false otherwise.
   */
  setSelectedClub(id) {
    const club = this._clubs.find(c => c.id === id);
    if (!club) return false;
    // Host / API selection counts as a manual pick — don't let the next
    // auto-suggest immediately steal it back.
    this._clubManualOverride = true;
    if (club.id === this._selectedClubId) return true;
    this._setSelectedClubId(club.id);
    return true;
  }

  _setSelectedClubId(nextId) {
    const prev = this._clubs.find(c => c.id === this._selectedClubId) || null;
    const next = this._clubs.find(c => c.id === nextId) || null;
    this._selectedClubId = nextId;

    const clubList = this.shadowRoot?.querySelector('.club-list');
    if (clubList) {
      clubList.querySelectorAll('.club-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.clubId === nextId);
      });
    }

    this.dispatchEvent(new CustomEvent('golf:clubchange', {
      bubbles: true,
      composed: true,
      detail: {
        club: next ? { ...next } : null,
        previous: prev ? { ...prev } : null,
      },
    }));
  }

  /**
   * Pick the club the bag recommends for a given XZ distance, using the
   * configured auto-select policy.
   *
   * The "reach" policy compares the nearest undershoot club against the
   * nearest overshoot club and picks whichever has the smaller carry delta.
   * Ties and near-ties break toward the shorter club — "rather play it
   * short" — which is the right default when the bag has big gaps (e.g. a
   * 50 m GW and a 100 m PW picked for 56 m should play the GW six metres
   * short, not the PW forty-four metres long).
   *
   * Edge cases:
   *   - Distance < every club's carry → shortest club (first overshoot).
   *   - Distance > every club's carry → longest club (fallback, furthest
   *     we can reach).
   *   - Putter participates naturally: at 2 m PT (delta 3) beats LW
   *     (delta 13). At 10 m LW (delta 5) and PT (delta 5) tie → short-bias
   *     hands it to PT. Callers wanting to force a chip over a long putt
   *     should set the club manually.
   *
   * Returns null when auto-select is disabled, `distance` is not finite,
   * or the bag is empty.
   *
   * @param {number} distance  XZ distance from ball to target, in metres.
   * @returns {object|null} The recommended club (shallow copy) or null.
   * @private
   */
  _suggestClubForDistance(distance) {
    if (!Number.isFinite(distance)) return null;
    if (this._autoSelectPolicy !== 'reach') return null;
    if (this._clubs.length === 0) return null;

    const sorted = [...this._clubs].sort((a, b) => a.carry - b.carry);

    // Longest club whose carry is ≤ distance (the best "play it short" pick).
    let under = null;
    for (const c of sorted) {
      if (c.carry <= distance) under = c;
      else break;
    }
    // Shortest club whose carry is ≥ distance (the best "reach it" pick).
    const over = sorted.find(c => c.carry >= distance) || null;

    if (!under) return over ? { ...over } : null;
    if (!over)  return { ...under };
    if (under === over) return { ...under };

    const underDelta = distance - under.carry;
    const overDelta  = over.carry - distance;
    // `<=` biases the short club on ties — the user stated preference.
    return underDelta <= overDelta ? { ...under } : { ...over };
  }

  /**
   * True when the ball is sitting on a putting surface (green or fringe).
   * Checks both the mesh-name zone id and the stamped surface.id so a
   * naming mismatch still forces putter behaviour.
   *
   * @returns {boolean}
   * @private
   */
  _isPuttingLie() {
    const lie = this.getBallLie();
    const zone = lie?.zone;
    const surfaceId = lie?.surface?.id;
    return zone === 'green' || zone === 'fringe'
      || surfaceId === 'green' || surfaceId === 'fringe';
  }

  /**
   * True when the next Fire / Exact shot should use the ground-roll putt
   * path: putting lie **and** the putter is the selected club. A manual
   * pick of any other club (menu or `setSelectedClub`) launches that club
   * with a lofted shot instead.
   *
   * @returns {boolean}
   * @private
   */
  _shouldFirePutt() {
    return this._isPuttingLie() && this._selectedClubId === 'PT';
  }

  /**
   * Re-run the auto-select policy against the current ball origin and aim
   * target (aim override when set, otherwise the flag), and swap the active
   * club to the recommendation when one exists.
   *
   * On green/fringe lies the putter (`PT`) is forced when present in the
   * bag — distance-based reach is skipped. Elsewhere the reach policy runs
   * as before.
   *
   * Skips entirely while `_clubManualOverride` is set (user/host picked a
   * club) so that choice can be fired. Callers that represent a new lie
   * (rest, tee/position change) clear the override before invoking this.
   *
   * Silently skips when auto-select is off, the ball has no known origin,
   * no target is known (non-putting lies), or the recommended club is
   * already selected (`_setSelectedClubId` short-circuits the no-op case
   * anyway, but we skip early to avoid spurious work).
   *
   * Fires `golf:clubchange` indirectly via `_setSelectedClubId` when the
   * selection actually changes — existing HUDs / menu highlight update for
   * free.
   *
   * @private
   */
  _runAutoClubSuggest() {
    if (this._autoSelectPolicy !== 'reach') return;
    if (!this._currentOrigin) return;
    // Honour a manual menu / API club pick until the next rest or tee change.
    if (this._clubManualOverride) return;

    // Putting surfaces always take the putter when the bag has one.
    if (this._isPuttingLie()) {
      const pt = this._clubs.find(c => c.id === 'PT');
      if (!pt || pt.id === this._selectedClubId) return;
      this._setSelectedClubId(pt.id);
      return;
    }

    const target = this._resolveDefaultAimTarget();
    if (!target) return;
    const distance = this.getDistanceTo(target);
    if (!Number.isFinite(distance)) return;
    const pick = this._suggestClubForDistance(distance);
    if (!pick || pick.id === this._selectedClubId) return;
    this._setSelectedClubId(pick.id);
  }

  // ── Engine access (advanced) ──────────────────────────────────────────────
  // Exposed for extensions like <golf-minimap> that need to render additional
  // views of the same scene. Mutating these objects directly can break the
  // visualiser — prefer the high-level API where possible. Add-ons should
  // render on their own THREE.Layer (see addRenderCallback).

  /** The Three.js Scene graph. Mutate with care. */
  get scene() { return this._scene; }

  /** The WebGLRenderer driving the main canvas. */
  get renderer() { return this._renderer; }

  /** The primary PerspectiveCamera. Read-only usage recommended. */
  get camera() { return this._camera; }

  /**
   * Register a callback invoked once per frame AFTER the main render pass.
   * Useful for inset viewports (e.g. minimap), post-effects or overlays that
   * need GPU access. Signature: (renderer, scene, camera) => void.
   *
   * Each callback is responsible for restoring any renderer state it changes
   * (viewport, scissor, clear color) before returning.
   *
   * @param {(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) => void} fn
   */
  addRenderCallback(fn) {
    if (typeof fn !== 'function') return;
    (this._renderCallbacks ??= []).push(fn);
    // One paint so inset views (minimap) appear without waiting for a drag.
    this.requestRender();
  }

  /** Remove a callback previously registered with addRenderCallback. */
  removeRenderCallback(fn) {
    if (!this._renderCallbacks) return;
    this._renderCallbacks = this._renderCallbacks.filter(f => f !== fn);
  }

  /**
   * Register a callback invoked once per frame BEFORE the main render pass.
   * Use for scene objects that must be positioned/scaled for the current
   * frame (e.g. an app-owned distance marker). Signature:
   * `(renderer, scene, camera, dt) => void`.
   *
   * Continuous overlays (animated dashes, etc.) should call `requestRender()`
   * each frame they need while active — the main loop sleeps when idle.
   *
   * @param {(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, dt: number) => void} fn
   */
  addPreRenderCallback(fn) {
    if (typeof fn !== 'function') return;
    (this._preRenderCallbacks ??= []).push(fn);
    this.requestRender();
  }

  /**
   * Wake the render loop for at least one frame. Safe to call often.
   * Used when the scene changes while idle (menu, resize, shot, camera).
   */
  requestRender() {
    this._needsRender = true;
    this._ensureRenderLoop();
  }

  /** Remove a callback previously registered with addPreRenderCallback. */
  removePreRenderCallback(fn) {
    if (!this._preRenderCallbacks) return;
    this._preRenderCallbacks = this._preRenderCallbacks.filter(f => f !== fn);
  }

  /**
   * Public scene descriptor: { name, number, label, courseType, lengthM }.
   *
   * `courseType` comes from config.scenes, falling back to the GLB scene
   * group's userData. `lengthM` is the authored hole length stamped into the
   * GLB at export — null for GLBs exported before that existed, in which case
   * hosts can measure tee → pin themselves.
   */
  _scenePublic(entry) {
    if (!entry) return null;
    const scenesMeta = this._baseConfig?.scenes ?? this._config?.scenes;
    const courseType = resolveSceneCourseType(scenesMeta, entry.name, entry.group);
    const lengthM = Number(entry.group?.userData?.holeLengthM);
    return {
      name: entry.name,
      number: entry.number,
      label: entry.label,
      courseType: courseType ?? null,
      lengthM: Number.isFinite(lengthM) && lengthM > 0 ? lengthM : null,
    };
  }

  /**
   * Course name stamped onto the GLB's root `scenes` group at export.
   * Null for GLBs exported before that existed.
   * @returns {string|null}
   */
  get courseName() {
    const name = this._scenesRoot?.userData?.courseName;
    return typeof name === 'string' && name ? name : null;
  }

  /**
   * All scenes discovered in the loaded GLB, sorted by scene number.
   * Empty array if no GLB is loaded or the GLB isn't a scene-container.
   */
  get scenes() {
    return this._sceneList.map((entry) => this._scenePublic(entry));
  }

  /**
   * The currently active scene, or null if no GLB / no scenes / not yet ready.
   */
  get activeScene() {
    if (!this._activeSceneName) return null;
    const entry = this._sceneList.find(s => s.name === this._activeSceneName);
    return this._scenePublic(entry);
  }

  selectPosition(id) {
    if (!this._config) return;
    const pos = this._config.positions.find(p => p.id === id);
    if (pos) this._selectPosition(pos);
  }

  /**
   * Surface-aware bounce & roll tunables. Returns a shallow copy of the
   * active params merged with the defaults — safe to mutate and pass back
   * via the setter.
   *
   * Keys (see DEFAULT_PARAMS in src/physics/bounce-roll.js):
   *   gravity, ballRadius, restingThreshold, restingFrames,
   *   spinDecayPerBounce, maxSimulationSeconds, subSteps,
   *   spinToVelocity, rollTransitionVy.
   *
   * Returns `null` before the simulator has been instantiated (pre-GLB-load).
   */
  get physicsParams() {
    if (!this._simulator) return null;
    return this._simulator.getParams();
  }

  /**
   * Partial update — unspecified keys keep their current values. Applies
   * immediately; next shot uses the new values. Silently no-ops if the
   * simulator isn't ready (e.g. called before the GLB resolves).
   */
  set physicsParams(partial) {
    if (!this._simulator || !partial) return;
    this._simulator.setParams(partial);
  }

  /**
   * Per-sub-step samples from the most recent terminal-phase simulation.
   * Read-only; each entry: `{ pos, vel, surface, dt }`. Useful for debug
   * overlays, regression assertions, or replay tooling. Empty array before
   * the first shot.
   */
  get lastShotTrace() {
    return this._simulator ? this._simulator.trace : [];
  }

  /**
   * Re-scan the active scene for solid colliders (meshes with
   * `userData.collider`). Call after mutating the GLB subtree. No-op before
   * the GLB has loaded. For runtime-added walls that live OUTSIDE the GLB
   * subtree, use `registerCollider(mesh)` instead — rescanColliders only
   * walks the scene-root subtree.
   *
   * @returns {number} the total number of collider meshes now registered
   *   (scanned + runtime), or 0 if the sampler is not yet instantiated.
   */
  rescanColliders() {
    if (!this._colliderSampler) return 0;
    this._colliderSampler.rescan();
    return this._colliderSampler.count;
  }

  /**
   * Register a runtime solid collider. The mesh must carry `userData.collider`
   * with at least `{ id }`; missing numeric fields fall back to
   * DEFAULT_COLLIDER (restitution=0.5, friction=0.3).
   *
   * Use this for walls / ramps / posts the host adds directly to
   * `vis.scene` at runtime (e.g. programmatic mini-golf layouts or test
   * fixtures). GLB-baked colliders are discovered automatically and do not
   * need to be registered.
   *
   * No-op before the GLB has loaded.
   */
  registerCollider(mesh) {
    if (!this._colliderSampler) return;
    this._colliderSampler.registerCollider(mesh);
  }

  /** Unregister a runtime collider. See `registerCollider`. */
  unregisterCollider(mesh) {
    if (!this._colliderSampler) return;
    this._colliderSampler.unregisterCollider(mesh);
  }

  /**
   * Physics debug overlays. Accepts:
   *
   *   vis.physicsDebug = true           // all three overlays on
   *   vis.physicsDebug = false          // all off (default)
   *   vis.physicsDebug = { trajectory: true, surfaceTint: false, readout: true }
   *
   * Overlays are opt-in and zero-cost when off. The setter is idempotent
   * and safe to call before the GLB has loaded — flags are re-applied
   * once the simulator is instantiated. Reading returns the current flag
   * object so callers can inspect without mutating.
   */
  get physicsDebug() {
    return this._physicsDebug ? this._physicsDebug.getFlags() : { trajectory: false, surfaceTint: false, readout: false };
  }

  set physicsDebug(flagsOrBool) {
    this._physicsDebugFlags = flagsOrBool;
    this._applyPhysicsDebug();
  }

  _applyPhysicsDebug() {
    const flags = this._physicsDebugFlags;
    const wantAny = flags === true
      || (flags && typeof flags === 'object'
          && (flags.trajectory || flags.surfaceTint || flags.readout));

    if (!wantAny) {
      if (this._physicsDebug) this._physicsDebug.detach();
      return;
    }

    // Scene/simulator not ready yet → flags will be re-applied on golf:ready.
    if (!this._scene || !this._simulator) return;

    if (!this._physicsDebug) this._physicsDebug = new PhysicsDebug();
    if (this._physicsDebug._vis) this._physicsDebug.setFlags(flags);
    else this._physicsDebug.attach(this, flags);
  }

  /**
   * Switch to the given scene by name (e.g. "scene__02__Driving_Range").
   * If called before the GLB is loaded, the request is queued and applied on load.
   *
   * @returns {boolean} true if the scene was found and activated (or queued), false otherwise.
   */
  setScene(sceneName) {
    if (!sceneName || typeof sceneName !== 'string') return false;

    // Pre-load: queue it and apply once _loadGLB finishes enumerating scenes
    if (!this._scenesRoot) {
      this._pendingSetScene = sceneName;
      this._log(`setScene queued (GLB not yet loaded): ${sceneName}`);
      return true;
    }

    return this._activateScene(sceneName, { initial: false });
  }

  clearTracers() {
    this._clearTracers();
  }

  /**
   * Clear on-screen tracers and wipe shot history from IndexedDB so a reload
   * does not restore them. Position switches only call clearTracers().
   * @returns {Promise<void>}
   */
  async clearShots() {
    this._clearTracers();
    const radar = document.querySelector('trackman-radar');
    if (radar && typeof radar.clearShots === 'function') {
      try {
        await radar.clearShots();
        this._log('Shot history cleared (scene + IndexedDB)');
      } catch (err) {
        this._log(`Failed to clear IndexedDB shot history: ${err.message}`);
      }
    }
  }

  /**
   * Live ball XZ for lie / distance queries: in-flight or rolling mesh, then
   * the seated tee ball, then the committed shot origin. Prefer this over
   * `_currentOrigin` alone — that stays frozen from launch until after rest.
   * @returns {THREE.Vector3|null}
   * @private
   */
  _ballSamplePosition() {
    return (
      this._activeBall?.mesh?.position ||
      this._teeBall?.position ||
      this._currentOrigin ||
      null
    );
  }

  /**
   * What is under the ball right now?
   *
   * Samples at the live ball position (active ball → tee ball → shot origin)
   * so UI and club auto-select match the status hint and bounce/roll physics.
   * `_currentOrigin` alone is frozen from launch until after `golf:rest`, so
   * using it here left the Lie HUD stuck on the previous lie.
   *
   * Returns both views of the hit mesh:
   *   - `zone` / `holeNumber` — the semantic label parsed from the mesh name
   *     (`fairway`, `green`, `bunker_greenside`, `rough`, …). Useful for UI
   *     text and rule logic ("is the ball on the green?").
   *   - `surface` — the normalised physics profile from `userData.surface`
   *     (`friction`, `restitution`, `rollResistance`, `absorb`, `spinGrab`).
   *     Populated whenever the surface sampler is ready; `null` otherwise.
   *     Same shape as the `surface` field on `golf:land` / `golf:bounce` /
   *     `golf:rest` events, so app logic can share a single code path.
   *
   * Returns `{ zone: 'unknown', holeNumber: null, surface: null }` if no
   * geometry is under the ball or the GLB hasn't finished loading.
   *
   * @returns {{ zone: string, holeNumber: number|null, surface: object|null }}
   */
  getBallLie() {
    const pos = this._ballSamplePosition();
    if (!pos || !this._glbModel) {
      return { zone: 'unknown', holeNumber: null, surface: null };
    }

    // Prefer SurfaceSampler — same path as `_updateSurfaceReadout` / physics.
    if (this._surfaceSampler) {
      const hit = this._surfaceSampler.sampleAt(pos.x, pos.z, 300);
      if (!hit) {
        return { zone: 'unknown', holeNumber: null, surface: null };
      }
      const hitObject = hit.object;
      const parsed = hitObject ? parseMeshName(hitObject.name) : null;
      const surface = hit.surface || null;
      const surfId = surface?.id;
      const zone = parsed
        ? parsed.zoneId
        : (surfId && surfId !== 'unknown_firm_ground' ? surfId : 'unknown');
      return {
        zone,
        holeNumber: parsed ? parsed.holeNumber : null,
        surface,
      };
    }

    // Sampler not ready yet — raycast the GLB the same way as before.
    const origin = new THREE.Vector3(pos.x, 500, pos.z);
    const down = new THREE.Vector3(0, -1, 0);
    this._raycaster.set(origin, down);
    const hits = this._raycaster.intersectObject(this._groundRoot(), true);
    if (hits.length === 0) {
      return { zone: 'unknown', holeNumber: null, surface: null };
    }
    // The visible skin carries no surface type — report the labelled collider
    // beneath it (or a single vertex-tagged terrain's surfaceTable), falling
    // back to the topmost hit for skin-less legacy GLBs.
    const typeHit = hits.find(h => h.object && h.object.userData && (h.object.userData.surface || h.object.userData.surfaceTable)) || hits[0];
    const hitObject = typeHit.object;
    const parsed = parseMeshName(hitObject.name);
    const surface = null;
    // For a single-mesh terrain the node name isn't a zone, so fall back to the
    // resolved lie id (e.g. 'green' / 'fringe') — keeps putting auto-select and
    // lie-based rules working the same as on multi-mesh courses.
    const zone = parsed
      ? parsed.zoneId
      : 'unknown';
    return {
      zone,
      holeNumber: parsed ? parsed.holeNumber : null,
      surface,
    };
  }

  getDistanceToFlag() {
    if (!this._ballSamplePosition() || !this._holeData) return null;
    const flagPos = this.getFlagPosition();
    if (!flagPos) return null;
    return this.getDistanceTo(flagPos);
  }

  /**
   * Flat (XZ-plane) distance in metres from the current ball position to an
   * arbitrary world-space point. Generalises `getDistanceToFlag()` so app
   * logic can measure to an aim marker, a trigger, or any custom target.
   *
   * Accepts:
   *   - `THREE.Vector3` — full world-space vector (Y ignored)
   *   - `{ x, z }` — plain object with XZ coords
   *   - `[x, y, z]` or `[x, z]` — tuple form
   *
   * Returns `null` if the ball has no known origin (pre-position-select),
   * or if `point` cannot be interpreted.
   *
   * @param {THREE.Vector3|{x:number,z:number}|[number,number]|[number,number,number]} point
   * @returns {number|null}
   */
  getDistanceTo(point) {
    const from = this._ballSamplePosition();
    if (!from || !point) return null;

    let x, z;
    if (Array.isArray(point)) {
      if (point.length === 2)      { x = point[0]; z = point[1]; }
      else if (point.length >= 3)  { x = point[0]; z = point[2]; }
      else                          return null;
    } else if (typeof point.x === 'number' && typeof point.z === 'number') {
      x = point.x;
      z = point.z;
    } else {
      return null;
    }

    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const dx = x - from.x;
    const dz = z - from.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /**
   * World-space position of the flag for the currently selected hole.
   *
   * Unlike `getDistanceToFlag()` (which is anchored to the current ball
   * origin), this returns the absolute flag location and is therefore the
   * correct target for minimaps, caddies, aim assist, and anything else
   * that needs to know "where is the pin".
   *
   * @returns {THREE.Vector3|null}
   */
  getFlagPosition() {
    if (!this._holeData) return null;
    const pos = this._selectedPosition;
    if (!pos || !pos.holeNumber) return null;
    const hole = this._holeData.get(pos.holeNumber);
    if (!hole || !hole.flagNode) return null;
    const out = new THREE.Vector3();
    hole.flagNode.getWorldPosition(out);
    return out;
  }

  /**
   * Point CupCapture at the active hole's cup (or clear when none).
   * Called on scene activate and position change.
   */
  _syncCupCapture() {
    if (!this._cupCapture) return;
    this._restorePinFade(true);

    const holeNum = this._selectedPosition?.holeNumber;
    const hole = (holeNum != null && this._holeData) ? this._holeData.get(holeNum) : null;
    const cupNode = hole?.cupNode || null;
    const flagNode = hole?.flagNode || null;
    if (!cupNode && !flagNode) {
      this._cupCapture.clear();
      this._applyTerrainCupHoleCut();
      return;
    }

    const center = new THREE.Vector3();
    (cupNode || flagNode).getWorldPosition(center);

    let id = `hole_cup_${String(holeNum ?? 1).padStart(2, '0')}`;
    let holeNumber = holeNum ?? 1;
    if (cupNode) {
      cupNode.traverse((obj) => {
        const t = obj.userData?.trigger;
        if (!t?.id) return;
        id = t.id;
        if (t.data?.holeNumber != null) holeNumber = t.data.holeNumber;
      });
    }

    this._cupCapture.setCup({
      center,
      rimY: center.y,
      radius: CUP_DEFAULTS.radius,
      depth: CUP_DEFAULTS.depth,
      id,
      holeNumber
    });
    this._applyTerrainCupHoleCut();
  }

  /**
   * GPU-discard the green inside the cup so the sunken well (and ball) show.
   */
  _applyTerrainCupHoleCut() {
    const root = this._gameObjectsRoot || this._glbModel;
    const cup = this._cupCapture?.cup;
    if (!root || !cup) {
      setCupHoleCutOnRoot(root, null);
      return;
    }
    setCupHoleCutOnRoot(root, {
      x: cup.x,
      z: cup.z,
      radius: this._cupCapture.radius
    });
  }

  /**
   * Older courses may lack `userData.collider` on cup walls. Stamp defaults so
   * lip-outs work without forcing authors to rebuild the pin.
   */
  _ensureCupWallColliders(root) {
    if (!root) return;
    let stamped = false;
    root.traverse((obj) => {
      if (!obj.isMesh || obj.name !== 'cup_walls') return;
      if (obj.userData?.collider) return;
      const triggerId = obj.userData?.trigger?.id || 'hole_cup';
      obj.userData.collider = {
        id: `${triggerId}_walls`,
        type: 'solid',
        restitution: 0.35,
        friction: 0.2
      };
      stamped = true;
    });
    if (stamped && this._colliderSampler) {
      this._colliderSampler.rescan();
    }
  }

  _resolveActiveFlagNode() {
    const holeNum = this._selectedPosition?.holeNumber;
    if (holeNum == null || !this._holeData) return null;
    return this._holeData.get(holeNum)?.flagNode || null;
  }

  /**
   * Clone flag materials once so opacity fades don't mutate shared GLB mats.
   * Fades pole + cloth only — never the cup.
   */
  _preparePinFadeMaterials(flagNode) {
    const entries = [];
    flagNode.traverse((obj) => {
      if (!obj.isMesh || !obj.material) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      const cloned = mats.map((m) => {
        const c = m.clone();
        c.transparent = true;
        // Keep depthWrite while mostly opaque to avoid green sorting fights;
        // drop it when nearly invisible so the ball isn't occluded by a ghost pin.
        c.depthWrite = true;
        entries.push({ mat: c, baseOpacity: c.opacity ?? 1 });
        return c;
      });
      obj.material = Array.isArray(obj.material) ? cloned : cloned[0];
    });
    this._pinFadeMaterials = entries;
    this._pinFadeFlagNode = flagNode;
    this._pinFadeOpacity = 1;
  }

  _applyPinFadeOpacity() {
    if (!this._pinFadeMaterials) return;
    const o = this._pinFadeOpacity;
    for (const { mat, baseOpacity } of this._pinFadeMaterials) {
      mat.opacity = baseOpacity * o;
      mat.depthWrite = o > 0.15;
      mat.needsUpdate = true;
    }
  }

  /**
   * @param {boolean} [snap=false] - if true, jump to full opacity immediately
   */
  _restorePinFade(snap = false) {
    if (snap) this._pinFadeOpacity = 1;
    this._applyPinFadeOpacity();
  }

  /**
   * Fade the flag when the ball is within PIN_FADE_DIST_M of the cup during
   * bounce/roll (and while seated after a holed shot). Cup stays fully visible.
   */
  _updatePinFade(dt) {
    const flagNode = this._resolveActiveFlagNode();
    if (!flagNode || !this._cupCapture?.active) {
      if (this._pinFadeOpacity < 1) {
        this._pinFadeOpacity = 1;
        this._applyPinFadeOpacity();
      }
      return;
    }
    if (this._pinFadeFlagNode !== flagNode || !this._pinFadeMaterials) {
      this._preparePinFadeMaterials(flagNode);
    }

    let ballXZ = null;
    if (this._activeBall?.mesh) {
      ballXZ = this._activeBall.mesh.position;
    } else if (this._currentOrigin) {
      ballXZ = this._currentOrigin;
    }

    let target = 1;
    if (ballXZ) {
      const dist = this._cupCapture.distanceXZ(ballXZ.x, ballXZ.z);
      const ab = this._activeBall;
      const rollingOrDone = ab && (
        ab.phase === 'simulator'
        || ab.phase === 'simulator-done'
        || this._simulator?.state?.phase === 'holed'
      );
      const seatedHoled = !ab && this._ballHoled;
      if ((rollingOrDone || seatedHoled) && dist <= PIN_FADE_DIST_M) {
        target = 0;
      }
    }

    const step = Math.max(dt, 0) / PIN_FADE_SECONDS;
    if (this._pinFadeOpacity < target) {
      this._pinFadeOpacity = Math.min(target, this._pinFadeOpacity + step);
    } else if (this._pinFadeOpacity > target) {
      this._pinFadeOpacity = Math.max(target, this._pinFadeOpacity - step);
    }
    this._applyPinFadeOpacity();
  }

  // ── Game objects (markers + trigger volumes) ─────────────────────────────

  /**
   * @typedef {object} GameObject
   * @property {string} id       - Author-assigned id (`userData.*.id`), unique per scene
   * @property {'marker'|'trigger'} type - Position-only marker, or a sensor volume
   * @property {string|null} tag - Author-assigned group (`userData.*.group`)
   * @property {object} data     - Opaque author payload; the engine never reads it
   * @property {string|null} shape - Trigger volumes only: 'box' | 'cylinder' | 'sphere'
   * @property {object|null} size  - Trigger volumes only: authored dimensions in metres
   * @property {THREE.Vector3} position - World-space position
   * @property {THREE.Object3D} object  - The scene node, for custom maths
   */

  /**
   * Every game object in the **active** scene.
   *
   * These are the things a designer placed in the course editor's Game logic
   * tool (or stamped in Blender): markers for positions worth referencing, and
   * trigger volumes for regions worth reacting to. The engine indexes them but
   * assigns them no meaning — `tag` and `data` are the app's vocabulary.
   *
   * Scoped to the active scene on purpose, matching trigger behaviour: hole 2's
   * objects are not visible to hole 1's rules.
   *
   * @param {{ type?: 'marker'|'trigger'|'platform', tag?: string }} [filter]
   * @returns {GameObject[]}
   */
  listGameObjects(filter = {}) {
    const all = this._ensureGameObjectIndex();
    const { type, tag } = filter;
    if (!type && !tag) return all.slice();
    return all.filter((o) => (!type || o.type === type) && (!tag || o.tag === tag));
  }

  /**
   * One game object by its authored id, or `null`.
   * @param {string} id
   * @returns {GameObject|null}
   */
  getObjectById(id) {
    if (!id) return null;
    this._ensureGameObjectIndex();
    return this._gameObjectsById.get(String(id)) || null;
  }

  /**
   * Every game object sharing a tag — the usual way to drive game rules
   * ("all the score zones", "the waypoint route") without hardcoding ids.
   * @param {string} tag
   * @returns {GameObject[]}
   */
  getObjectsByTag(tag) {
    if (!tag) return [];
    return this._ensureGameObjectIndex().filter((o) => o.tag === String(tag));
  }

  /** Drop the cached index (active scene changed, or the host mutated the GLB). */
  rescanGameObjects() {
    this._gameObjects = null;
    this._gameObjectsById = null;
    return this._ensureGameObjectIndex().length;
  }

  /**
   * Build the id/tag index over the active scene subtree. Cached until a scene
   * change or an explicit `rescanGameObjects()`, since authored objects are
   * static for the lifetime of a scene.
   */
  _ensureGameObjectIndex() {
    if (this._gameObjects) return this._gameObjects;
    const root = this._gameObjectsRoot || this._glbModel || null;
    const list = [];
    const byId = new Map();
    if (root) {
      // World matrices may still be stale right after load — positions we hand
      // out have to be final, not identity-relative.
      root.updateWorldMatrix(true, true);
      root.traverse((node) => {
        const ud = node.userData;
        if (!ud) return;
        for (const [key, type] of [
          ['trigger', 'trigger'],
          ['marker', 'marker'],
          ['platform', 'platform']
        ]) {
          const block = ud[key];
          if (!block || !block.id) continue;
          const obj = this._describeGameObject(node, type, block);
          if (byId.has(obj.id)) {
            this._log(`Duplicate game object id "${obj.id}" — keeping the first; ids must be unique per scene`);
            continue;
          }
          byId.set(obj.id, obj);
          list.push(obj);
        }
      });
    }
    this._gameObjects = list;
    this._gameObjectsById = byId;
    return list;
  }

  /** @returns {GameObject} */
  _describeGameObject(node, type, block) {
    return {
      id: String(block.id),
      type,
      tag: block.group ?? null,
      // Copied so app code can't corrupt the scene by editing what it reads.
      data: { ...(block.data || {}) },
      shape: block.shape ?? null,
      size: block.size ? copyTriggerSize(block.size) : null,
      position: node.getWorldPosition(new THREE.Vector3()),
      object: node
    };
  }

  /**
   * Sample the GLB ground height at a world XZ point. Casts a ray straight
   * down from far above and returns the terrain Y. Useful for elevation
   * deltas in HUDs (aim vs. ball, target vs. tee, etc.).
   *
   * Reuses the same raycaster + scene tree as `getBallLie()` and the
   * physics step, so results agree with what the simulator sees. Props that
   * stand on the course (flagsticks, trees, tee markers) are skipped — a
   * naive first-hit sample at the pin returns the top of the flagstick, not
   * the green.
   *
   * @param {number} x  World X in metres
   * @param {number} z  World Z in metres
   * @returns {number|null}  Ground Y in metres, or `null` when the ray
   *                         misses the GLB (off-course) or the model isn't
   *                         loaded yet.
   */
  getGroundYAt(x, z) {
    const root = this._groundRoot();
    if (!root || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    this._raycaster.set(
      new THREE.Vector3(x, 1000, z),
      new THREE.Vector3(0, -1, 0),
    );
    const hits = this._raycaster.intersectObject(root, true);
    if (!hits.length) return null;
    const ground = hits.find((h) => {
      const ud = h.object?.userData || {};
      return !!(ud.visualOnly || ud.surface || ud.surfaceTable);
    });
    return (ground || hits[0]).point.y;
  }

  /**
   * Override the aim point the camera (and any listening HUD, e.g. the
   * minimap) targets. Until `clearAimTarget()` is called this point replaces
   * the flag for camera auto-aim — the flag itself is untouched.
   *
   * The Y coordinate is ignored; aim is a ground-plane concept. Pass a number
   * or leave `y` as `null` to keep the call site terse.
   *
   * Dispatches `golf:aimchange` on `document` with `detail: { x, z }`.
   *
   * @param {number} x  World X of the aim point.
   * @param {number} z  World Z of the aim point.
   * @param {object} [opts]
   * @param {boolean} [opts.animate=true] — animate the camera transition.
   */
  setAimTarget(x, z, opts = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    this._aimTarget = new THREE.Vector3(x, 0, z);

    // Manual aim away from the dogleg waypoint = player chose their own path.
    // Forget the waypoint for the rest of this hole (survives post-rest
    // clearAimTarget). Aiming near the waypoint itself still counts as
    // playing the bend, so that does not latch. Also latch when the click
    // lands near the green (covers holes with no waypoint).
    const waypoint = this._firstWaypointPosition();
    const flag = this.getFlagPosition();
    const greenR = Number(this._config?.camera?.greenAimRadius);
    const nearR = Number.isFinite(greenR) ? greenR : 40;
    const near = (p) => {
      if (!p) return false;
      const dx = x - p.x;
      const dz = z - p.z;
      return dx * dx + dz * dz <= nearR * nearR;
    };
    if (waypoint) {
      if (!near(waypoint)) this._doglegPreferPin = true;
    } else if (near(flag)) {
      this._doglegPreferPin = true;
    }

    // Re-orient the shot axis so the next trackman measurement flies toward
    // the aim (trackman payloads are *relative* to _currentForward — left
    // untouched the ball would keep firing along the tee direction, which
    // was the symptom behind the bug report).
    this._rotateForwardToward(this._aimTarget);

    document.dispatchEvent(new CustomEvent('golf:aimchange', {
      detail: { x, z },
    }));
    // Explicit user intent — swing the camera regardless of the
    // `autoAimAtFlag` config toggle, which only governs *automatic*
    // re-aims after rest.
    this._aimCameraAtTargetXZ(this._aimTarget, {
      origin: this._currentOrigin || undefined,
      animate: opts.animate !== false,
    });
    // Aim moved → re-evaluate club suggestion against the new distance.
    // Runs after camera aim so the user sees the suggestion update settle
    // together with the camera transition.
    this._runAutoClubSuggest();
  }

  /**
   * Drop any aim override so the camera falls back to the default target
   * (sticky green / waypoint handoff / pin — see `_resolveDefaultAimTarget`).
   * Fires `golf:aimchange` with `detail: null` so listeners (e.g. the
   * minimap) can remove their aim marker / reset framing.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.animate=true] — animate back to default aim.
   */
  clearAimTarget(opts = {}) {
    if (!this._aimTarget) return;
    this._aimTarget = null;
    document.dispatchEvent(new CustomEvent('golf:aimchange', { detail: null }));

    const target = this._resolveDefaultAimTarget();
    if (target) {
      // Restore the shot axis so the next swing fires toward the pin /
      // first waypoint from wherever the ball currently sits.
      this._rotateForwardToward(target);

      // Returning to default aim is still an explicit user action, so bypass
      // the autoAimAtFlag gate and drive the swing through the unconditional
      // helper.
      this._aimCameraAtTargetXZ(target, {
        origin: this._currentOrigin || undefined,
        animate: opts.animate !== false,
      });
    }
    // Aim cleared → target reverted to flag/waypoint, so re-evaluate the bag.
    this._runAutoClubSuggest();
  }

  /**
   * Rotate `_currentForward` so it points from the current ball position
   * toward `target` (XZ plane, Y ignored). No-op if the ball sits exactly on
   * the target. Used by both aim overrides and post-rest flag re-aim so the
   * trackman → world transform always reflects the *current* shot direction.
   * @private
   */
  _rotateForwardToward(target) {
    if (!target) return;
    const origin = this._currentOrigin;
    if (!origin) return;
    const dx = target.x - origin.x;
    const dz = target.z - origin.z;
    if (dx * dx + dz * dz < 1e-4) return;
    this._currentForward = new THREE.Vector3(dx, 0, dz).normalize();
  }

  /**
   * Current aim override, or `null` if the camera is tracking the flag.
   *
   * @returns {{x: number, z: number} | null}
   */
  getAimTarget() {
    if (!this._aimTarget) return null;
    return { x: this._aimTarget.x, z: this._aimTarget.z };
  }

  /**
   * Resolved default aim (same target as camera auto-aim / distance marker).
   * Includes a `source` so hosts can show whether play is aiming at a dogleg
   * waypoint, the pin, or a click override.
   *
   * @returns {{ x: number, z: number, source: 'override'|'waypoint'|'flag' } | null}
   */
  getDefaultAimTarget() {
    const target = this._resolveDefaultAimTarget();
    if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.z)) {
      return null;
    }
    const x = target.x;
    const z = target.z;
    const near = (a, b, eps = 0.35) => {
      if (!a || !b) return false;
      const dx = a.x - b.x;
      const dz = a.z - b.z;
      return dx * dx + dz * dz <= eps * eps;
    };

    if (this._aimTarget && near(this._aimTarget, target)) {
      return { x, z, source: 'override' };
    }
    const waypoint = this._firstWaypointPosition();
    if (waypoint && near(waypoint, target)) {
      return { x, z, source: 'waypoint' };
    }
    const flag = this.getFlagPosition();
    if (flag && near(flag, target)) {
      return { x, z, source: 'flag' };
    }
    // Sticky green / handoff without a readable flag still reports pin intent.
    if (this._doglegPreferPin) return { x, z, source: 'flag' };
    if (waypoint) return { x, z, source: 'waypoint' };
    return { x, z, source: 'flag' };
  }

  // ── Shadow DOM ────────────────────────────────────────────────────────────

  _renderShadowDOM() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          height: 100%;
          position: relative;
          overflow: hidden;
        }
        :host([embed]) #move-hint { display: none; }
        #container {
          width: 100%;
          height: 100%;
          position: relative;
        }
        canvas {
          display: block;
          width: 100%;
          height: 100%;
        }
        canvas.hud-only-hidden {
          visibility: hidden;
          pointer-events: none;
        }
        #container.hud-only {
          background: #0a0a0a;
        }
        #overlay {
          position: absolute;
          top: 0; left: 0; right: 0; bottom: 0;
          pointer-events: none;
          z-index: 10;
        }
        #loading {
          position: absolute;
          top: 0; left: 0; right: 0; bottom: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          background: rgba(0,0,0,0.85);
          z-index: 20;
          font-family: system-ui, -apple-system, sans-serif;
          color: #ccc;
          transition: opacity 0.4s;
        }
        #loading.hidden { opacity: 0; pointer-events: none; }
        #loading-bar-track {
          width: 240px;
          height: 4px;
          background: #333;
          border-radius: 2px;
          margin-top: 12px;
          overflow: hidden;
        }
        #loading-bar {
          height: 100%;
          width: 0%;
          background: #fff;
          border-radius: 2px;
          transition: width 0.2s;
        }
        /* Vercel Brotli on .glb often strips Content-Length → total=0 in Three.js */
        #loading-bar.indeterminate {
          width: 35% !important;
          transition: none;
          animation: loading-indeterminate 1.1s ease-in-out infinite;
        }
        @keyframes loading-indeterminate {
          0%   { transform: translateX(-120%); }
          100% { transform: translateX(320%); }
        }
        .menu-panel {
          position: absolute;
          top: 16px; left: 16px;
          z-index: 15;
          background: rgba(0,0,0,0.75);
          border-radius: 10px;
          min-width: 200px;
          max-width: 340px;
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 13px;
          color: #ccc;
          pointer-events: auto;
          display: none;
          overflow: hidden;
        }
        .menu-panel.visible { display: block; }
        .menu-panel.look-active { min-width: 300px; }
        .menu-content {
          max-height: min(70vh, 560px);
          overflow-y: auto;
          scrollbar-width: thin;
          scrollbar-color: rgba(255,255,255,0.2) transparent;
        }
        .menu-tabs {
          display: flex;
          border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .menu-tab {
          flex: 1;
          padding: 10px 8px;
          text-align: center;
          cursor: pointer;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.4px;
          text-transform: uppercase;
          white-space: nowrap;
          color: #555;
          transition: color 0.15s, background 0.15s;
          border-bottom: 2px solid transparent;
        }
        .menu-tab:hover { color: #aaa; background: rgba(255,255,255,0.05); }
        .menu-tab.active { color: #fff; border-bottom-color: #fff; }
        /* Static bullet used on the Trackman tab. Colour reflects radar state
           via .red / .green / .grey. No animation. Applied inline with the
           label; size is controlled by font-size, not box dimensions. */
        .menu-tab-dot {
          display: inline;
          margin-right: 4px;
          font-size: 14px;
          line-height: 1;
          vertical-align: baseline;
          color: #666;
          transition: color 0.2s;
        }
        .menu-tab-dot.red   { color: #f44336; }
        .menu-tab-dot.green { color: #4caf50; }
        .menu-tab-dot.grey  { color: #666; }
        .tab-content { display: none; padding: 6px 0; }
        .tab-content.active { display: block; }
        .menu-item {
          padding: 6px 14px;
          cursor: pointer;
          transition: background 0.15s;
        }
        .menu-item:hover { background: rgba(255,255,255,0.1); }
        .menu-item.active { color: #fff; background: rgba(255,255,255,0.15); }
        .menu-action {
          display: block;
          padding: 6px 14px;
          cursor: pointer;
          transition: background 0.15s;
          color: #888;
          font-size: 12px;
        }
        .menu-action:hover { background: rgba(255,255,255,0.1); }
        .menu-action.on { color: #0f0; }
        .menu-action.disabled { color: #444; cursor: default; }
        .menu-action.disabled:hover { background: none; }
        .club-section-label {
          padding: 6px 14px 2px;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: #666;
        }
        .club-list {
          max-height: 240px;
          overflow-y: auto;
          scrollbar-width: thin;
          scrollbar-color: rgba(255,255,255,0.2) transparent;
        }
        .club-list::-webkit-scrollbar { width: 4px; }
        .club-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 2px; }
        .club-item {
          padding: 4px 14px;
          cursor: pointer;
          font-size: 12px;
          color: #888;
          transition: background 0.15s, color 0.15s;
          display: flex;
          justify-content: space-between;
        }
        .club-item:hover { background: rgba(255,255,255,0.08); color: #bbb; }
        .club-item.selected { color: #0ff; background: rgba(0,255,255,0.08); }
        .club-item .club-distance { color: inherit; opacity: 0.6; font-size: 11px; }
        .club-item.selected .club-distance { opacity: 0.8; }
        .menu-separator {
          border-top: 1px solid rgba(255,255,255,0.08);
          margin: 4px 0;
        }
        .phone-swing { padding-bottom: 8px; }
        .phone-swing-summary {
          cursor: pointer;
          list-style: none;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .phone-swing-summary::-webkit-details-marker { display: none; }
        .phone-swing-summary::before { content: '▸'; margin-right: 6px; color: #555; }
        .phone-swing[open] .phone-swing-summary::before { content: '▾'; }
        .phone-swing-summary-hint {
          text-transform: none;
          letter-spacing: 0;
          font-size: 11px;
          color: #9ad;
          margin-left: auto;
        }
        .phone-swing-help {
          padding: 4px 14px 6px;
          font-size: 11px;
          line-height: 1.4;
          color: #888;
        }
        .phone-swing-reqs { color: #666; }
        .phone-swing-row {
          display: flex;
          gap: 12px;
          padding: 4px 14px 8px;
          align-items: stretch;
        }
        .phone-swing-qr {
          width: 132px;
          height: 132px;
          background: #fff;
          border-radius: 6px;
          overflow: hidden;
          flex-shrink: 0;
        }
        .phone-swing-qr svg { display: block; }
        .phone-swing-side { display: flex; align-items: stretch; }
        .phone-swing-meter {
          width: 14px;
          border-radius: 4px;
          background: #222;
          position: relative;
          overflow: hidden;
          border: 1px solid #333;
        }
        .phone-swing-meter-fill {
          position: absolute;
          left: 0; right: 0; bottom: 0;
          height: 0%;
          background: #3b9eff;
        }
        .phone-swing-meter-fill.red { background: #e55; }
        .phone-swing-meter-redline {
          position: absolute;
          left: 0; right: 0;
          bottom: calc(100% * 100 / 130);
          height: 1px;
          background: #fff8;
        }
        .phone-swing-status, .phone-swing-last {
          padding: 0 14px;
          font-size: 12px;
          color: #9ad;
        }
        .phone-swing-url {
          padding: 4px 14px 8px;
          font-size: 11px;
          color: #8fd;
          word-break: break-all;
          user-select: text;
          -webkit-user-select: text;
        }
        .tracker-status {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 14px 10px;
          font-size: 12px;
          color: #ccc;
        }
        .tracker-status-dot {
          width: 10px; height: 10px;
          border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.15);
          flex-shrink: 0;
        }
        .tracker-status-dot.red   { background: #f44336; }
        .tracker-status-dot.green { background: #4caf50; }
        .tracker-status-dot.grey  { background: #666; }
        .tracker-status-name { color: #fff; font-weight: 500; }
        .tracker-select-wrap { padding: 0 14px 8px; }
        .tracker-select {
          width: 100%;
          background: rgba(255,255,255,0.06);
          color: #ddd;
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 6px;
          padding: 6px 8px;
          font-size: 12px;
          font-family: inherit;
          outline: none;
        }
        .tracker-select:focus { border-color: rgba(255,255,255,0.3); }
        .tracker-toggle {
          display: flex; gap: 4px;
          padding: 0 14px 8px;
        }
        .tracker-toggle-btn {
          flex: 1;
          background: rgba(255,255,255,0.06);
          color: #aaa;
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 6px;
          padding: 5px 0;
          font-size: 12px;
          font-family: inherit;
          cursor: pointer;
          transition: background 0.15s, color 0.15s, border-color 0.15s;
        }
        .tracker-toggle-btn:hover { background: rgba(255,255,255,0.1); color: #ddd; }
        .tracker-toggle-btn.active { background: rgba(0,255,255,0.1); color: #0ff; border-color: rgba(0,255,255,0.3); }
        .tracker-empty {
          padding: 10px 14px;
          font-size: 12px;
          color: #666;
          line-height: 1.45;
        }
        .look-scroll {
          max-height: min(70vh, 560px);
          overflow-y: auto;
          scrollbar-width: thin;
          scrollbar-color: rgba(255,255,255,0.2) transparent;
        }
        .look-scroll::-webkit-scrollbar { width: 4px; }
        .look-scroll::-webkit-scrollbar-thumb {
          background: rgba(255,255,255,0.2);
          border-radius: 2px;
        }
        .look-row {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 4px 14px;
          min-height: 28px;
        }
        .look-row-label {
          flex: 0 0 88px;
          font-size: 11px;
          color: #888;
        }
        .look-row-value {
          flex: 0 0 40px;
          font-size: 10px;
          color: #666;
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
        .look-slider {
          flex: 1;
          min-width: 0;
          accent-color: #0ff;
          height: 18px;
        }
        .look-color {
          flex: 1;
          min-width: 0;
          height: 24px;
          padding: 0;
          border: 1px solid rgba(255,255,255,0.15);
          border-radius: 4px;
          background: transparent;
          cursor: pointer;
        }
        .look-select {
          flex: 1;
          min-width: 0;
          background: rgba(255,255,255,0.06);
          color: #ddd;
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 6px;
          padding: 5px 8px;
          font-size: 12px;
          font-family: inherit;
          outline: none;
        }
        .look-select:focus { border-color: rgba(255,255,255,0.3); }
        .look-actions {
          display: flex;
          gap: 6px;
          padding: 6px 14px 8px;
        }
        .look-actions .menu-action {
          flex: 1;
          padding: 6px 8px;
          text-align: center;
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 6px;
        }
        .look-hint {
          padding: 2px 14px 8px;
          font-size: 10px;
          color: #555;
          line-height: 1.35;
        }
        #status-note {
          position: absolute;
          bottom: 16px;
          right: 16px;
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 12px;
          color: rgba(255,255,255,0.4);
          z-index: 15;
          pointer-events: none;
        }
        #move-hint {
          position: absolute;
          bottom: 16px;
          left: 16px;
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 11px;
          color: rgba(255,255,255,0.3);
          z-index: 15;
          pointer-events: none;
        }
      </style>
      <div id="container">
        <div id="loading">
          <div id="loading-label">Loading course…</div>
          <div id="loading-bar-track"><div id="loading-bar"></div></div>
        </div>
        <div id="overlay" part="overlay"></div>
        <div id="menu-panel" class="menu-panel"></div>
        <div id="status-note"></div>
        <div id="move-hint">Lie: — · Menu = M</div>
      </div>
    `;
  }

  // ── Config ────────────────────────────────────────────────────────────────

  async _loadConfig() {
    this._configPath = this.getAttribute('config');
    if (!this._configPath) throw new Error('Missing config attribute');

    // In-memory embeds (e.g. the course editor's in-place Play mode) hand us a
    // `blob:` or `data:` config URL. A query string is invalid on those schemes
    // and makes fetch() reject, so only append the cache-buster to real URLs.
    const isInMemory = /^(blob:|data:)/i.test(this._configPath);
    const cacheBust = isInMemory
      ? this._configPath
      : `${this._configPath}${this._configPath.includes('?') ? '&' : '?'}_=${Date.now()}`;
    this._log(`Loading config from ${this._configPath}`);
    const res = await fetch(cacheBust);
    if (!res.ok) throw new Error(`Config fetch failed: ${res.status}`);
    const raw = await res.json();

    this._config = {
      scene: { ...DEFAULTS.scene, ...raw.scene },
      lighting: deepMerge(DEFAULTS.lighting, raw.lighting || {}),
      camera: { ...DEFAULTS.camera, ...raw.camera },
      culling: deepMerge(DEFAULTS.culling, raw.culling || {}),
      tracer: { ...DEFAULTS.tracer, ...raw.tracer },
      ball: { ...DEFAULTS.ball, ...raw.ball },
      comet: { ...DEFAULTS.comet, ...raw.comet },
      ui: deepMerge(DEFAULTS.ui, raw.ui || {}),
      rendering: { ...DEFAULTS.rendering, ...raw.rendering },
      shading: { ...DEFAULTS.shading, ...raw.shading },
      bag: raw.bag && typeof raw.bag === 'object' ? raw.bag : null,
      positions: raw.positions || [],
      scenes: raw.scenes && typeof raw.scenes === 'object' ? raw.scenes : {},
    };

    // Resolve the bag into a normalised per-instance list. When the config
    // omits `bag` the default bag is kept and auto-select stays off (preserving
    // legacy embeds that never opted in). When `bag` is present but `autoSelect`
    // is missing, default to "reach".
    this._clubs = resolveClubsFromConfig(this._config.bag);
    if (this._config.bag) {
      const policy = this._config.bag.autoSelect;
      this._autoSelectPolicy = (policy === 'off' || policy === 'reach') ? policy : 'reach';
    } else {
      this._autoSelectPolicy = 'off';
    }
    // Ensure the currently-selected club still exists after a bag swap.
    if (!this._clubs.find(c => c.id === this._selectedClubId)) {
      const fallback = this._clubs.find(c => c.id === 'PW') || this._clubs[0];
      if (fallback) this._selectedClubId = fallback.id;
    }

    // Snapshot the clean config so per-scene overrides always compose on the baseline,
    // not on top of the previously-active scene's overrides.
    this._baseConfig = JSON.parse(JSON.stringify(this._config));

    // Positions are merged later per-scene inside _activateScene (for scene-container GLBs)
    // or here for legacy flat configs.
    if (this._config.positions.length > 0) {
      this._mergeStoredPositions();
    }
  }

  _mergeStoredPositions() {
    try {
      const key = this._positionsStorageKey();
      const stored = localStorage.getItem(key);
      if (!stored) return;
      const savedPositions = JSON.parse(stored);
      if (!Array.isArray(savedPositions)) return;

      // Add saved positions that don't already exist in config (by id)
      const existingIds = new Set(this._config.positions.map(p => p.id));
      for (const pos of savedPositions) {
        if (!existingIds.has(pos.id)) {
          this._config.positions.push(pos);
          existingIds.add(pos.id);
        }
      }
      this._log(`Restored ${savedPositions.length} position(s) from ${key}`);
    } catch (e) {
      this._log(`Failed to restore positions from localStorage: ${e.message}`);
    }
  }

  _savePositionsToStorage() {
    try {
      // Save all positions (including ones from config file, so we have the full set)
      const key = this._positionsStorageKey();
      localStorage.setItem(key, JSON.stringify(this._config.positions));
    } catch (e) {
      this._log(`Failed to save positions to localStorage: ${e.message}`);
    }
  }

  _positionsStorageKey() {
    const scope = this._activeSceneName || 'global';
    return `golf-visualiser:positions:${scope}`;
  }

  _lastPositionStorageKey() {
    const scope = this._activeSceneName || 'global';
    return `golf-visualiser:last-position:${scope}`;
  }

  // ── Multi-Scene ────────────────────────────────────────────────────────────

  /**
   * Make `sceneName` the active scene: toggle visibility, re-extract positions,
   * apply per-scene config overrides, rebuild menu, and dispatch `golf:scenechange`.
   *
   * @param {string} sceneName — e.g. "scene__01__Default"
   * @param {object} [opts]
   * @param {boolean} [opts.initial=false] — true for the first activation during _loadGLB.
   *        Initial activation skips tracer clearing, menu rebuild, and camera reset
   *        because those systems are not yet wired up; the caller in connectedCallback
   *        handles them after _loadGLB resolves.
   */
  _activateScene(sceneName, { initial = false } = {}) {
    const entry = this._sceneList.find((s) => s.name === sceneName);
    if (!entry) {
      this._log(`Scene not found: ${sceneName}. Available: [${this._sceneList.map(s => s.name).join(', ')}]`);
      return false;
    }

    const previous = this._activeSceneName;

    // Visibility toggle — exactly one scene visible at a time.
    for (const s of this._sceneList) {
      s.group.visible = (s.name === sceneName);
    }
    this._activeSceneName = sceneName;
    // New hole/scene — drop sticky "aimed for green" from the previous hole.
    this._doglegPreferPin = false;

    const scenesMeta = this._baseConfig?.scenes ?? this._config?.scenes;
    const courseType = resolveSceneCourseType(scenesMeta, sceneName, entry.group);
    this._activeSceneCourseType = courseType;
    const forceStaticCamera = isRangeCourseType(courseType);

    // Narrow the physics sampler to just the active scene subtree. Cheaper than
    // traversing the full GLB every raycast, and mirrors the visibility model.
    if (this._surfaceSampler) {
      this._surfaceSampler.setSceneRoot(entry.group);
    }
    if (this._colliderSampler) {
      this._colliderSampler.setSceneRoot(entry.group);
    }
    // Re-scan sensors for the active scene subtree (so scene B's cup doesn't fire
    // while scene A is live). scanScene replaces GLB-baked triggers each call.
    // Trigger bounds are cached at registration, so world matrices must be
    // final first — right after load they may still be identity.
    entry.group.updateWorldMatrix(true, true);
    this._ensureCupWallColliders(entry.group);
    if (this._triggerDetector) {
      this._triggerDetector.scanScene(entry.group);
    }
    // Marker / trigger lookups (`getObjectById` and friends) follow the same
    // active-scene scoping as the detector.
    this._gameObjectsRoot = entry.group;
    this._gameObjects = null;
    this._gameObjectsById = null;

    // Extract positions from the active scene subtree only — scene B's tee_box__01
    // must not collide with scene A's.
    const { positions: extracted, holeData, hasDrivingRange } = extractCourseData(
      entry.group,
      { forceStaticCamera }
    );
    this._activeSceneIsRange = forceStaticCamera || !!hasDrivingRange;
    this._holeData = holeData;
    this._syncCupCapture();
    this._config.positions = extracted.length
      ? extracted
      : (this._baseConfig?.positions || []);
    this._mergeStoredPositions();
    this._log(
      `Scene activated: ${sceneName} — ${extracted.length} position(s) extracted`
      + (this._activeSceneIsRange ? ' (range: static + re-tee)' : '')
    );

    // Per-scene camera / lighting / background overrides
    this._applySceneOverrides(sceneName);

    if (!initial) {
      this._clearTracers();
      // Re-select a sensible position for the new scene
      const lastPosId = this._loadSetting(this._lastPositionStorageKey());
      const startPos = (lastPosId && this._config.positions.find(p => p.id === lastPosId))
        || this._config.positions[0];
      if (startPos) {
        this._selectPosition(startPos);
      } else {
        // Empty scene (e.g. test grid with no zones yet) — still rebuild menu so the
        // Scenes tab reflects the new active scene.
        this._buildMenu();
      }
    }

    this._invalidatePropCullCache();
    this._dispatchSceneChange(previous, entry);
    return true;
  }

  /**
   * Deep-merge `config.scenes[sceneName]` into the baseline config, then apply the
   * relevant pieces (background, lights, camera) to the live THREE objects. Keeps
   * positions from the just-extracted scene subtree (not overridden).
   */
  _applySceneOverrides(sceneName) {
    if (!this._baseConfig) return;

    const scenePositions = this._config.positions;  // preserve — already scene-scoped
    const sceneOverrides = (this._baseConfig.scenes && this._baseConfig.scenes[sceneName]) || {};

    // Rebuild from baseline so the previous scene's overrides don't leak into this one
    const merged = {
      scene:    deepMerge(this._baseConfig.scene,    sceneOverrides.scene    || {}),
      lighting: deepMerge(this._baseConfig.lighting, sceneOverrides.lighting || {}),
      camera:   deepMerge(this._baseConfig.camera,   sceneOverrides.camera   || {}),
      culling:  deepMerge(DEFAULTS.culling, this._baseConfig.culling || {}),
      tracer:   this._baseConfig.tracer,
      ball:     this._baseConfig.ball,
      comet:   this._baseConfig.comet || { ...DEFAULTS.comet },
      ui:       this._baseConfig.ui,
      rendering: deepMerge(this._baseConfig.rendering, sceneOverrides.rendering || {}),
      shading:  this._baseConfig.shading,
      bag:     this._baseConfig.bag,
      scenes:   this._baseConfig.scenes,
      positions: scenePositions,
    };
    this._config = merged;

    // Apply to live THREE objects
    if (this._scene) {
      void this._applyBackground(merged.scene);
      this._applyFog(merged.scene);
    }
    this._applyCameraFar();
    this._invalidatePropCullCache();
    // Tone mapping is cheap to re-apply per scene; material-style re-swap on
    // scene change is intentionally out of scope for this pass (styles are set
    // once at GLB load).
    this._applyToneMapping(merged.rendering);
    if (this._ambientLight) {
      this._ambientLight.color.set(merged.lighting.ambient.color);
      this._ambientLight.intensity = merged.lighting.ambient.intensity;
    }
    if (this._directionalLight) {
      this._directionalLight.color.set(merged.lighting.directional.color);
      this._directionalLight.intensity = merged.lighting.directional.intensity;
      // Position is applied via _refreshStaticShadows (focus + offset) when
      // shadows are on; otherwise keep the legacy absolute position.
      const shadowsOn = !!(merged.lighting.shadows && merged.lighting.shadows.enabled
        && merged.lighting.shadows.static && merged.lighting.shadows.static.enabled);
      if (!shadowsOn) {
        this._directionalLight.position.set(...merged.lighting.directional.position);
      }
    }
    this._applyShadowConfig();
    if (this._camera) {
      this._camera.fov = merged.camera.fov;
      this._camera.near = merged.camera.near;
      this._camera.far = merged.camera.far;
      this._camera.updateProjectionMatrix();
    }
    this._invalidateBallShadowGroundCache();
    this.requestRender();
  }

  _dispatchSceneChange(previousEntry, currentEntry) {
    const previous = typeof previousEntry === 'string'
      ? this._scenePublic(this._sceneList.find(s => s.name === previousEntry))
      : this._scenePublic(previousEntry);
    this.dispatchEvent(new CustomEvent('golf:scenechange', {
      bubbles: true,
      composed: true,
      detail: {
        scene: this._scenePublic(currentEntry),
        previous,
      },
    }));
  }

  // ── Physics event bridge ──────────────────────────────────────────────────

  /**
   * Wire internal simulator events to DOM CustomEvents on the component.
   * See PRD §4.4 for payload contracts. Consumers listen on the
   * `<golf-visualiser>` element directly.
   *
   * Events (all bubble + composed so hosts can listen at document level):
   *   golf:land        — flight phase ended, ball just touched ground
   *   golf:bounce      — each subsequent airborne→ground contact
   *   golf:roll-start  — rebound too weak to leave surface, now rolling
   *   golf:rest        — ball came to rest
   *   golf:water       — ball absorbed (water hazard, OB)
   *   golf:holed       — ball captured by the cup (stays in hole; not a re-tee)
   *   golf:trigger     — non-physics sensor tripped (Phase 3)
   */
  _wireSimulatorEvents() {
    if (!this._simulator) return;
    const forward = (name) => (payload) => {
      this.dispatchEvent(new CustomEvent(`golf:${name}`, {
        bubbles: true,
        composed: true,
        detail: payload,
      }));
    };
    this._simulator.on('land',       forward('land'));
    this._simulator.on('bounce',     forward('bounce'));
    this._simulator.on('roll-start', forward('roll-start'));
    this._simulator.on('rest',       forward('rest'));
    this._simulator.on('water',      forward('water'));
    this._simulator.on('holed',      forward('holed'));
    this._simulator.on('trigger',    forward('trigger'));
  }

  // ── Three.js Scene ────────────────────────────────────────────────────────

  async _initScene() {
    const container = this.shadowRoot.getElementById('container');
    const { scene: sceneCfg, lighting, camera: camCfg } = this._config;

    // Renderer
    this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this._renderer.setPixelRatio(window.devicePixelRatio);
    this._renderer.setSize(container.clientWidth, container.clientHeight);
    this._renderer.outputColorSpace = THREE.SRGBColorSpace;
    this._applyToneMapping(this._config.rendering);
    container.insertBefore(this._renderer.domElement, container.firstChild);
    if (this._hudOnly) this._applyHudOnly();

    // Scene — solid color first, then optional skybox texture + fog
    this._scene = new THREE.Scene();
    await this._applyBackground(sceneCfg);
    this._applyFog(sceneCfg);

    // Camera
    const aspect = container.clientWidth / container.clientHeight;
    this._camera = new THREE.PerspectiveCamera(camCfg.fov, aspect, camCfg.near, camCfg.far);
    this._camera.position.set(...camCfg.defaultPosition);
    this._camera.lookAt(...camCfg.defaultTarget);

    // Lights — keep refs so per-scene overrides can retune them without rebuilding
    this._ambientLight = new THREE.AmbientLight(lighting.ambient.color, lighting.ambient.intensity);
    this._scene.add(this._ambientLight);

    this._directionalLight = new THREE.DirectionalLight(lighting.directional.color, lighting.directional.intensity);
    this._directionalLight.position.set(...lighting.directional.position);
    this._scene.add(this._directionalLight);
    this._scene.add(this._directionalLight.target);

    this._applyShadowConfig();
  }

  // ── Shadows ────────────────────────────────────────────────────────────────
  //
  // Hybrid model (see Three.js shadows manual):
  //   • Ball — fake blob plane under the ball, updated every frame (cheap).
  //   • Course — one directional shadow map; autoUpdate=false so static
  //     casters only re-render when the play focus / lighting changes.
  // Apps opt in via lighting.shadows.enabled in app-config.json.

  _getShadowsConfig() {
    const lighting = (this._config && this._config.lighting) || {};
    return deepMerge(DEFAULTS.lighting.shadows, lighting.shadows || {});
  }

  _applyShadowConfig() {
    if (!this._renderer || !this._directionalLight) return;
    const cfg = this._getShadowsConfig();
    const useMaps = !!(cfg.enabled && cfg.static && cfg.static.enabled);
    const types = {
      pcfsoft: THREE.PCFSoftShadowMap,
      pcf: THREE.PCFShadowMap,
      basic: THREE.BasicShadowMap, // === 0 — must not use `||` fallback
    };
    const typeKey = String(cfg.type || 'pcfsoft').toLowerCase();
    // BasicShadowMap is 0; `types[key] || PCFSoft` would always pick soft.
    const nextType = useMaps
      ? (Object.prototype.hasOwnProperty.call(types, typeKey)
        ? types[typeKey]
        : THREE.PCFSoftShadowMap)
      : null;
    // Shadow filter is a shader #define — changing renderer.shadowMap.type alone
    // does nothing until materials recompile (needsUpdate).
    const typeChanged = this._appliedShadowMapType !== nextType;
    const enabledChanged = this._appliedShadowMapsEnabled !== useMaps;

    this._renderer.shadowMap.enabled = useMaps;
    if (useMaps) {
      this._renderer.shadowMap.type = nextType;
      // Static casters: do not rebuild the map every frame.
      this._renderer.shadowMap.autoUpdate = false;
      this._renderer.shadowMap.needsUpdate = true;
    }

    const light = this._directionalLight;
    light.castShadow = useMaps;
    if (useMaps) {
      const size = Math.max(256, Math.round(Number(cfg.mapSize) || 2048));
      // Three.js keeps the first allocated shadow map; dispose so mapSize
      // changes (e.g. Look tab) take effect on the next render.
      if (light.shadow.map
          && (light.shadow.map.width !== size || light.shadow.map.height !== size)) {
        light.shadow.map.dispose();
        light.shadow.map = null;
      }
      light.shadow.mapSize.set(size, size);
      light.shadow.bias = Number(cfg.bias) || 0;
      light.shadow.normalBias = Number(cfg.normalBias) || 0;
      const intensity = Number(cfg.intensity);
      light.shadow.intensity = Number.isFinite(intensity) ? intensity : 1;
      const half = Math.max(1, Number(cfg.cameraSize) || 120);
      light.shadow.camera.left = -half;
      light.shadow.camera.right = half;
      light.shadow.camera.top = half;
      light.shadow.camera.bottom = -half;
      light.shadow.camera.near = 0.5;
      light.shadow.camera.far = Math.max(100, (Number(cfg.lightDistance) || 200) * 2.5);
      light.shadow.camera.updateProjectionMatrix();
    }

    if (cfg.enabled && cfg.ball && cfg.ball.enabled) {
      this._ensureBallShadow();
    } else {
      this._disposeBallShadow();
    }

    if (this._glbModel) {
      this._applyMeshShadowFlags(this._glbModel);
      const focus = this._currentOrigin || this._controls?.target || new THREE.Vector3();
      this._refreshStaticShadows(focus);
    }

    if (typeChanged || enabledChanged) {
      this._invalidateShadowPrograms();
    }
    this._appliedShadowMapType = nextType;
    this._appliedShadowMapsEnabled = useMaps;
  }

  /** Force material recompile so a new shadowMap.type takes effect. */
  _invalidateShadowPrograms() {
    const roots = [this._scene, this._glbModel].filter(Boolean);
    const seen = new Set();
    for (const root of roots) {
      root.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (!m || seen.has(m)) continue;
          seen.add(m);
          m.needsUpdate = true;
        }
      });
    }
  }

  /**
   * Mark terrain as receive-only and props/trees as cast-only (or clear both
   * when shadows are off). Hidden physics colliders are skipped.
   */
  _applyMeshShadowFlags(root) {
    if (!root) return;
    const cfg = this._getShadowsConfig();
    const useMaps = !!(cfg.enabled && cfg.static && cfg.static.enabled);

    let hasSkin = false;
    root.traverse((c) => {
      if (c.isMesh && c.userData && c.userData.visualOnly) hasSkin = true;
    });

    root.traverse((child) => {
      if (!child.isMesh) return;
      const ud = child.userData || {};

      // Hidden physics collider — not drawn, never participates in shadows.
      if (hasSkin && ud.surface && !ud.visualOnly) {
        child.castShadow = false;
        child.receiveShadow = false;
        return;
      }

      if (!useMaps) {
        child.castShadow = false;
        child.receiveShadow = false;
        return;
      }

      const isTerrain = !!(ud.visualOnly || ud.surface);
      if (cfg.static.cast === 'nonTerrain') {
        child.receiveShadow = isTerrain;
        child.castShadow = !isTerrain;
      } else {
        // Fallback: everything receives and casts.
        child.receiveShadow = true;
        child.castShadow = true;
      }
    });
  }

  /**
   * Recenter the directional light + ortho shadow camera on `focus` and request
   * a one-shot shadow-map rebuild. No-op when static maps are disabled.
   */
  _refreshStaticShadows(focus) {
    const cfg = this._getShadowsConfig();
    if (!cfg.enabled || !cfg.static || !cfg.static.enabled) return;
    if (!this._directionalLight || !this._renderer) return;

    const center = focus && focus.isVector3
      ? focus
      : new THREE.Vector3(focus?.x || 0, focus?.y || 0, focus?.z || 0);

    const dir = this._config.lighting.directional.position;
    const offset = new THREE.Vector3(dir[0], dir[1], dir[2]);
    if (offset.lengthSq() < 1e-6) offset.set(1, 3, 2);
    offset.normalize().multiplyScalar(Math.max(10, Number(cfg.lightDistance) || 200));

    this._directionalLight.position.set(
      center.x + offset.x,
      center.y + offset.y,
      center.z + offset.z
    );
    this._directionalLight.target.position.copy(center);
    this._directionalLight.target.updateMatrixWorld();

    const half = Math.max(1, Number(cfg.cameraSize) || 120);
    const cam = this._directionalLight.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.updateProjectionMatrix();

    this._shadowFocus = center.clone();
    this._renderer.shadowMap.needsUpdate = true;
    this.requestRender();
  }

  _createBlobShadowTexture() {
    if (this._ballShadowTexture) return this._ballShadowTexture;
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.25)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this._ballShadowTexture = tex;
    return tex;
  }

  _ensureBallShadow() {
    const cfg = this._getShadowsConfig();
    if (!cfg.enabled || !cfg.ball || !cfg.ball.enabled || !this._scene) {
      this._disposeBallShadow();
      return;
    }
    if (this._ballShadow) return this._ballShadow;

    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: this._createBlobShadowTexture(),
      transparent: true,
      depthWrite: false,
      opacity: cfg.ball.opacity ?? 0.4,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 1;
    mesh.name = 'ball-blob-shadow';
    this._scene.add(mesh);
    this._ballShadow = mesh;
    return mesh;
  }

  _disposeBallShadow() {
    if (!this._ballShadow) return;
    this._scene?.remove(this._ballShadow);
    this._ballShadow.geometry.dispose();
    this._ballShadow.material.dispose();
    this._ballShadow = null;
  }

  /**
   * Seat / fade the blob under the visible tee or in-flight ball.
   */
  _updateBallShadow() {
    const cfg = this._getShadowsConfig();
    if (!cfg.enabled || !cfg.ball || !cfg.ball.enabled) {
      if (this._ballShadow) this._ballShadow.visible = false;
      return;
    }

    const shadow = this._ensureBallShadow();
    if (!shadow) return;

    let ballPos = null;
    if (this._activeBall && this._activeBall.mesh) {
      ballPos = this._activeBall.mesh.position;
    } else if (this._teeBall && this._teeBall.visible) {
      ballPos = this._teeBall.position;
    }

    if (!ballPos) {
      shadow.visible = false;
      return;
    }

    const radius = this._config.ball.radius;
    const scale = Math.max(0.1, (Number(cfg.ball.scale) || 3) * radius * 2);
    // Prefer the surface under the ball's feet so bunker/water overlays in a
    // pit get the blob — not a higher fairway/green skin at the same XZ.
    const footY = ballPos.y - radius;
    const groundY = this._cachedBallShadowGroundY(ballPos.x, ballPos.z, footY);
    const height = Math.max(0, footY - groundY);
    const maxH = Math.max(0.1, Number(cfg.ball.maxHeight) || 40);
    const fade = 1 - Math.min(1, height / maxH);
    const baseOpacity = Number(cfg.ball.opacity) ?? 0.4;

    // When essentially on the ground, pin the blob to the ball feet so tiny
    // sample mismatches don't float the shadow onto the lip above a bunker.
    const shadowY = (height < 0.08 ? footY : groundY) + 0.01;
    shadow.position.set(ballPos.x, shadowY, ballPos.z);
    shadow.scale.set(scale, scale, 1);
    shadow.material.opacity = baseOpacity * (0.2 + 0.8 * fade);
    shadow.visible = fade > 0.02;
  }

  /**
   * Cache ground Y under a stationary ball so idle frames skip the full-scene
   * raycast. Cleared when the tee/scene moves (`_invalidateBallShadowGroundCache`).
   */
  _cachedBallShadowGroundY(x, z, footY) {
    const cache = this._ballShadowGroundCache;
    const eps = 1e-4;
    if (
      cache
      && Math.abs(cache.x - x) < eps
      && Math.abs(cache.z - z) < eps
      && Math.abs(cache.footY - footY) < eps
    ) {
      return cache.groundY;
    }
    const groundY = this._getGroundHeight(x, z, footY);
    this._ballShadowGroundCache = { x, z, footY, groundY };
    return groundY;
  }

  _invalidateBallShadowGroundCache() {
    this._ballShadowGroundCache = null;
  }

  /**
   * Apply renderer-level tone mapping + exposure from `config.rendering`.
   * `toneMapping` maps a config string to a THREE constant; unknown/`none`
   * values fall back to NoToneMapping. Safe to call repeatedly (e.g. on scene
   * change) — it only mutates renderer state.
   */
  _applyToneMapping(rendering) {
    if (!this._renderer || !rendering) return;
    const modes = {
      none: THREE.NoToneMapping,
      acesfilmic: THREE.ACESFilmicToneMapping,
      agx: THREE.AgXToneMapping,
      neutral: THREE.NeutralToneMapping,
      reinhard: THREE.ReinhardToneMapping,
      cineon: THREE.CineonToneMapping,
    };
    const key = String(rendering.toneMapping || 'none').toLowerCase();
    this._renderer.toneMapping = modes[key] ?? THREE.NoToneMapping;
    const exposure = Number(rendering.exposure);
    this._renderer.toneMappingExposure = Number.isFinite(exposure) ? exposure : 1.0;
  }

  /**
   * Apply `scene.background` (solid color) and optional `scene.skybox` texture.
   * Prefer `skybox.preset` (engine built-ins in `engine/sky/`). Else `path` /
   * `faces` for app-owned assets. Types: equirect, hdr, exr, cube. When skybox
   * is absent or fails to load, the solid color remains. Backdrop-only by
   * default; set `skybox.environment: true` for IBL via scene.environment.
   */
  async _applyBackground(sceneCfg) {
    if (!this._scene || !sceneCfg) return;

    if (this._skyboxTexture) {
      this._skyboxTexture.dispose();
      this._skyboxTexture = null;
    }
    this._scene.environment = null;

    const fallback = sceneCfg.background || DEFAULTS.scene.background;
    this._scene.background = new THREE.Color(fallback);

    const skybox = sceneCfg.skybox;
    if (!skybox || typeof skybox !== 'object') return;

    let type = skybox.type || 'color';
    let loadUrl = skybox.path || null;

    if (skybox.preset) {
      const entry = ENGINE_SKY_PRESETS[skybox.preset];
      if (!entry) {
        this._log(`Unknown skybox.preset "${skybox.preset}" — using solid background`);
        return;
      }
      type = entry.type || 'equirect';
      loadUrl = resolveEngineSkyUrl(skybox.preset);
    }

    if (type === 'color') return;

    const token = (this._skyboxLoadToken = (this._skyboxLoadToken || 0) + 1);

    const loadTexture = (loader, url) => new Promise((resolve, reject) => {
      loader.load(url, resolve, undefined, reject);
    });

    try {
      let texture = null;

      if (type === 'equirect') {
        if (!loadUrl) throw new Error('skybox.preset or skybox.path required for type "equirect"');
        texture = await loadTexture(new THREE.TextureLoader(), loadUrl);
        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.colorSpace = THREE.SRGBColorSpace;
      } else if (type === 'hdr') {
        if (!loadUrl) throw new Error('skybox.path required for type "hdr"');
        texture = await loadTexture(new RGBELoader(), loadUrl);
        texture.mapping = THREE.EquirectangularReflectionMapping;
      } else if (type === 'exr') {
        if (!loadUrl) throw new Error('skybox.path required for type "exr"');
        texture = await loadTexture(new EXRLoader(), loadUrl);
        texture.mapping = THREE.EquirectangularReflectionMapping;
      } else if (type === 'cube') {
        const faces = skybox.faces;
        if (!Array.isArray(faces) || faces.length !== 6) {
          throw new Error('skybox.faces must be an array of 6 image paths for type "cube"');
        }
        texture = await new Promise((resolve, reject) => {
          new THREE.CubeTextureLoader().load(faces, resolve, undefined, reject);
        });
        texture.colorSpace = THREE.SRGBColorSpace;
      } else {
        throw new Error(`Unknown skybox.type: ${type}`);
      }

      if (token !== this._skyboxLoadToken) {
        texture.dispose();
        return;
      }

      this._skyboxTexture = texture;
      this._scene.background = texture;
      if (skybox.environment === true) {
        this._scene.environment = texture;
      }
      this._log(`Skybox applied (${skybox.preset ? `preset:${skybox.preset}` : type})`);
    } catch (e) {
      if (token !== this._skyboxLoadToken) return;
      this._log(`Skybox load failed — using solid background: ${e.message || e}`);
    }
  }

  /**
   * Apply optional `scene.fog` (THREE.Fog or FogExp2). Omit / null disables fog.
   * Fog tints geometry toward a solid color — match `fog.color` to `background`
   * (or a horizon-like solid) for a clean fade, especially with a skybox texture.
   *
   * linear: { type: "linear", color, near, far }
   * exp2:   { type: "exp2", color, density }
   *         aliases for type: "exponential", "density"
   *
   * FogExp2 density is in world units (metres here). Tiny values like the
   * three.js manual's 0.1 are for unit-scale demos — for a golf course try
   * ~0.002–0.006 (higher = thicker haze).
   */
  _applyFog(sceneCfg) {
    if (!this._scene || !sceneCfg) return;

    const fogCfg = sceneCfg.fog;
    if (!fogCfg || typeof fogCfg !== 'object') {
      this._scene.fog = null;
      return;
    }

    // Prefer an explicit type; if only `density` is present, treat as exp2.
    let type = (fogCfg.type || '').toLowerCase();
    if (!type) {
      type = Number.isFinite(Number(fogCfg.density)) ? 'exp2' : 'linear';
    }
    if (type === 'exponential' || type === 'density') type = 'exp2';

    const color = fogCfg.color || sceneCfg.background || DEFAULTS.scene.background;

    try {
      if (type === 'linear') {
        const near = Number(fogCfg.near);
        const far = Number(fogCfg.far);
        if (!Number.isFinite(near) || !Number.isFinite(far)) {
          throw new Error('fog.near and fog.far are required for type "linear"');
        }
        this._scene.fog = new THREE.Fog(color, near, far);
      } else if (type === 'exp2') {
        const density = Number(fogCfg.density);
        if (!Number.isFinite(density)) {
          throw new Error('fog.density (number) is required for type "exp2" — e.g. 0.004');
        }
        this._scene.fog = new THREE.FogExp2(color, density);
      } else {
        throw new Error(`Unknown fog.type: ${fogCfg.type} (use "linear" or "exp2")`);
      }
      this._log(`Fog applied (${type})`);
    } catch (e) {
      this._scene.fog = null;
      this._log(`Fog config invalid — disabled: ${e.message || e}`);
    }
  }

  // ── Shading ─────────────────────────────────────────────────────────────────
  //
  // Apply a config-driven shading style to every visible course mesh. The
  // default `clay` style forces a matte response (full roughness, no metal, no
  // specular highlight); other styles swap the material type (toon/basic/normal)
  // or preserve the GLB's PBR values (realistic). vertexColors is enabled when
  // COLOR_0 is present so the plugin's soft edge blends show up. Blender lights
  // never reach the runtime — only this material pass + `lighting` config matter.
  //
  // Single-skin courses split *rendering* from *surface typing* — but the ball
  // must still rest on the surface you can SEE:
  //   • `userData.visualOnly` meshes (the continuous vertex-painted skin) are
  //     the only ground the player sees AND the geometry the ball sits on. They
  //     stay raycastable so ground-height / contact rays land on the skin.
  //   • Meshes carrying `userData.surface` are hidden physics-type colliders.
  //     We keep `object.visible` true (this Three build skips raycasts on hidden
  //     objects) but set the *material* invisible so they're never drawn. They
  //     exist only to label which surface (fairway/green/rough…) sits under a
  //     given point; the sampler reads the skin for geometry and the collider
  //     beneath for the surface profile (see SurfaceSampler.sampleAt).
  //   • Everything else (flag, cup, tee markers) renders normally.
  // Legacy GLBs without a skin have no `visualOnly` mesh and their zone meshes
  // still render (this only hides colliders when a skin is present alongside).

  /**
   * Build (and cache) a stepped gradient map for toon shading. `steps` bands of
   * luminance mapped through a nearest-filtered 1D texture, giving hard cel
   * bands. See https://threejs.org/docs/#api/en/materials/MeshToonMaterial
   */
  _toonGradientMap(steps) {
    const n = Math.max(2, Math.min(16, Math.round(Number(steps) || 4)));
    if (this._toonGradient && this._toonGradient.userData.steps === n) return this._toonGradient;
    if (this._toonGradient) this._toonGradient.dispose();
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++) data[i] = Math.round((i / (n - 1)) * 255);
    const tex = new THREE.DataTexture(data, n, 1, THREE.RedFormat);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    tex.userData = { steps: n };
    this._toonGradient = tex;
    return tex;
  }

  /**
   * Return a material reflecting the requested `style` for one source material.
   * `clay`/`realistic` mutate in place; `toon`/`phong`/`basic`/`normal` return a
   * new material carrying over color/map/opacity so the swap is visually safe.
   */
  _styleMaterial(mat, style, hasVertexColor, gradientMap) {
    if (!mat) return mat;
    const vc = hasVertexColor;
    // Cutout billboards (trees/bushes) rely on alphaTest. Dropping it when
    // swapping to toon/phong leaves full quads that depth-fight and look broken.
    const common = (m) => {
      if (mat.color && m.color) m.color.copy(mat.color);
      if ('map' in m) m.map = mat.map || null;
      if ('alphaMap' in m) m.alphaMap = mat.alphaMap || null;
      m.transparent = mat.transparent;
      m.opacity = mat.opacity;
      m.side = mat.side;
      if ('alphaTest' in m) m.alphaTest = Number(mat.alphaTest) || 0;
      if ('depthWrite' in m && 'depthWrite' in mat) m.depthWrite = mat.depthWrite;
      if (vc) m.vertexColors = true;
      m.needsUpdate = true;
      return m;
    };

    switch (style) {
      case 'realistic':
        // Keep the GLB's authored PBR values untouched; just surface vertex colors.
        if (vc) mat.vertexColors = true;
        mat.needsUpdate = true;
        return mat;
      case 'toon':
        return common(new THREE.MeshToonMaterial({ gradientMap }));
      case 'phong':
        return common(new THREE.MeshPhongMaterial());
      case 'basic':
        return common(new THREE.MeshBasicMaterial());
      case 'normal': {
        const m = new THREE.MeshNormalMaterial();
        m.side = mat.side;
        if ('alphaTest' in mat) m.alphaTest = Number(mat.alphaTest) || 0;
        return m;
      }
      case 'clay':
      default:
        if ('roughness' in mat) mat.roughness = 1;
        if ('metalness' in mat) mat.metalness = 0;
        if ('specularIntensity' in mat) mat.specularIntensity = 0;
        if (vc) mat.vertexColors = true;
        mat.needsUpdate = true;
        return mat;
    }
  }

  _applyShading(root) {
    if (!root) return;
    const style = (this._config && this._config.shading && this._config.shading.style) || 'clay';
    const gradientMap = style === 'toon'
      ? this._toonGradientMap(this._config.shading.toonSteps)
      : null;

    const hasSkin = (() => {
      let found = false;
      root.traverse((c) => { if (c.isMesh && c.userData && c.userData.visualOnly) found = true; });
      return found;
    })();

    root.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      const ud = child.userData || {};
      const hasVertexColor = !!(child.geometry && child.geometry.attributes && child.geometry.attributes.color);

      // Cache the GLB's original material(s) the first time we see this mesh so
      // re-applying a style always starts from the pristine source (a swap to
      // e.g. `normal` would otherwise discard the original and can't restore).
      if (child.userData.__srcMaterial === undefined) {
        child.userData.__srcMaterial = child.material;
      }
      const src = child.userData.__srcMaterial;
      const isArray = Array.isArray(src);
      const mats = isArray ? src : [src];

      // Hidden physics collider — keep raycastable, stop drawing it. Leave the
      // original material (just invisible); no need to restyle what's not drawn.
      if (hasSkin && ud.surface && !ud.visualOnly) {
        for (const m of mats) { if (m) { m.visible = false; m.needsUpdate = true; } }
        child.material = isArray ? mats : mats[0];
        return;
      }

      // The skin AND everything else visible (flag/cup/tee) get the chosen style.
      // The skin stays raycastable so contact rays hit what's drawn.
      const styled = mats.map(m => this._styleMaterial(m, style, hasVertexColor, gradientMap));
      child.material = isArray ? styled : styled[0];

      // Clay-plus: soft albedo × vertex colors + world-XZ mottling on skins.
      // Applied after style swap so toon/phong/clay materials all get the look.
      if (isClayTerrainCandidate(child) && style !== 'normal') {
        applyClayTerrainLook(child);
      }
    });

    // Pin cloth always reads as Trackman orange (#EC691A), independent of
    // shading style / dim clay lighting (legacy GLBs often bake pure red).
    this._applyTrackmanFlagColors(root);
    // Clay / style swap may replace onBeforeCompile — re-apply cup hole discard.
    this._applyTerrainCupHoleCut();
  }

  /**
   * Force saturated flag-cloth materials to unlit Trackman orange. Skips the
   * grey/white pole (low saturation). Updates `__srcMaterial` so later
   * shading passes don't restore a baked red.
   */
  _applyTrackmanFlagColors(root) {
    if (!root) return;
    const ORANGE = 0xEC691A;
    root.traverse((node) => {
      const parsed = parseMeshName(node.name);
      if (!parsed || parsed.zoneId !== 'flag') return;
      node.traverse((mesh) => {
        if (!mesh.isMesh || !mesh.material) return;
        const isArray = Array.isArray(mesh.material);
        const mats = isArray ? mesh.material : [mesh.material];
        let changed = false;
        const next = mats.map((mat) => {
          if (!mat || !mat.color) return mat;
          const { r, g, b } = mat.color;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const sat = max < 1e-6 ? 0 : (max - min) / max;
          if (sat < 0.25) return mat; // pole / neutral metal
          changed = true;
          return new THREE.MeshBasicMaterial({
            color: ORANGE,
            side: mat.side ?? THREE.DoubleSide,
            transparent: !!mat.transparent,
            opacity: mat.opacity ?? 1,
            fog: false
          });
        });
        if (!changed) return;
        mesh.material = isArray ? next : next[0];
        mesh.userData.__srcMaterial = mesh.material;
      });
    });
  }

  // ── GLB Loading ───────────────────────────────────────────────────────────

  _loadGLB() {
    return new Promise((resolve, reject) => {
      const loader = new GLTFLoader();
      const loadingBar = this.shadowRoot.getElementById('loading-bar');
      const loadingEl = this.shadowRoot.getElementById('loading');
      const loadingLabel = this.shadowRoot.getElementById('loading-label');
      const glbPath = this._config.scene.glbPath;
      const scale = this._config.scene.scaleFactor;

      this._log(`Loading GLB from ${glbPath}`);

      loader.load(
        glbPath,
        (gltf) => {
          try {
            // Download finished — Range.glb shading/activation can take seconds
            // on the main thread with no further progress events.
            if (loadingLabel) loadingLabel.textContent = 'Preparing course…';
            loadingBar?.classList.remove('indeterminate');
            if (loadingBar) loadingBar.style.width = '100%';

            this._glbModel = gltf.scene;
            if (scale !== 1.0) this._glbModel.scale.setScalar(scale);
            this._applyShading(this._glbModel);
            this._applyMeshShadowFlags(this._glbModel);
            this._scene.add(this._glbModel);

            // Physics: instantiate the sampler against the whole GLB root. Hidden
            // scenes are skipped automatically by Three.js raycasting (it respects
            // `.visible`), so multi-scene GLBs are safe with a single root.
            // On `_activateScene` we still narrow the root to the active subtree
            // to avoid even traversing hidden branches for every sample.
            this._surfaceSampler = new SurfaceSampler(this._glbModel);
            this._colliderSampler = new ColliderSampler(this._glbModel);
            // Non-physics sensors (userData.trigger). Populated per active scene in
            // _activateScene; fires `golf:trigger` when the ball enters a volume
            // (e.g. the hole cup) so host apps can run mechanics.
            this._triggerDetector = new TriggerDetector();
            // Local ground punch under the pin — ball can fall into the cup.
            this._cupCapture = new CupCapture();
            this._simulator = new BounceRollSimulator(
              this._surfaceSampler,
              this._triggerDetector,
              { ballRadius: this._config.ball.radius },
              this._colliderSampler,
              this._cupCapture
            );
            this._wireSimulatorEvents();

            // If the host set vis.physicsDebug before the GLB resolved, the
            // overlays were queued — replay now that scene + simulator exist.
            this._applyPhysicsDebug();

            if (isSceneContainerGLB(this._glbModel)) {
              this._scenesRoot = this._glbModel.getObjectByName('scenes');
              this._sceneList = enumerateScenes(this._scenesRoot);
              this._isSceneContainerModel = true;
              this._log(`Scene-container GLB detected: ${this._sceneList.length} scene(s) — [${this._sceneList.map(s => s.name).join(', ')}]`);

              // Pick initial active scene: config preference, queued setScene, or lowest-numbered
              const queued = this._pendingSetScene;
              this._pendingSetScene = null;
              const preferred = queued
                || this._config.ui.defaultScene
                || (this._sceneList[0] && this._sceneList[0].name);
              if (preferred) {
                this._activateScene(preferred, { initial: true });
              }
            } else {
              this._log('Warning: GLB has no "scenes" root with scene__NN__Label children. Multi-scene features disabled. Re-export from the Course Editor.');
              // No scene subtrees to narrow to — sensors and game-object lookups
              // both work off the whole model.
              this._glbModel.updateWorldMatrix(true, true);
              this._ensureCupWallColliders(this._glbModel);
              this._triggerDetector.scanScene(this._glbModel);
              this._gameObjectsRoot = this._glbModel;
              this._gameObjects = null;
              this._gameObjectsById = null;
              const focus = this._currentOrigin || this._controls?.target || new THREE.Vector3();
              this._refreshStaticShadows(focus);
            }

            loadingEl.classList.add('hidden');
            this._log('GLB loaded');
            resolve();
          } catch (err) {
            this._log(`GLB setup failed: ${err.message}`);
            if (loadingLabel) loadingLabel.textContent = `Failed to load: ${err.message}`;
            loadingBar?.classList.remove('indeterminate');
            reject(err);
          }
        },
        (progress) => {
          if (progress.total > 0) {
            loadingBar?.classList.remove('indeterminate');
            const pct = Math.round((progress.loaded / progress.total) * 100);
            if (loadingBar) loadingBar.style.width = `${pct}%`;
          } else if (progress.loaded > 0) {
            // No Content-Length (common when CDN Brotli's the GLB) — animate.
            loadingBar?.classList.add('indeterminate');
          }
        },
        (err) => {
          this._log(`GLB load failed: ${err.message}`);
          if (loadingLabel) loadingLabel.textContent = `Failed to load: ${err.message}`;
          loadingBar?.classList.remove('indeterminate');
          reject(err);
        }
      );
    });
  }

  // ── Controls ──────────────────────────────────────────────────────────────

  _initControls() {
    this._controls = new OrbitControls(this._camera, this._renderer.domElement);
    this._controls.enableDamping = true;
    this._controls.dampingFactor = 0.08;
    this._controls.maxPolarAngle = Math.PI * 0.95; // allow looking nearly straight up
    this._controls.minPolarAngle = 0.05;            // and nearly straight down
    this._controls.target.set(...this._config.camera.defaultTarget);
    this._controls.update();

    // User-initiated drag/zoom cancels any pending or in-flight auto-aim so
    // the camera obeys the user rather than yanking itself away mid-gesture.
    this._controls.addEventListener('start', () => {
      this._cancelAutoAim();
      this.requestRender();
    });
    this._controls.addEventListener('change', () => this.requestRender());
    this._controls.addEventListener('end', () => this.requestRender());
  }

  // ── Surface raycast (Exact Shot) ──────────────────────────────────────────

  _raycastSurface(e) {
    const canvas = this._renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    this._mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this._raycaster.setFromCamera(this._mouse, this._camera);
    return this._raycaster.intersectObject(this._glbModel, true);
  }

  // ── HUD-only preview (public API) ─────────────────────────────────────────

  /**
   * Hide or show the 3D canvas so the overlay web HUD can be previewed alone.
   * Menu, overlay, and status chrome stay visible. Session-only — not written
   * to localStorage. Wired to **Camera → HUD → Show HUD only**.
   *
   * Dispatches `golf:hudonlychange` on this element (`detail.enabled`,
   * bubbles + composed) so apps can react.
   *
   * @param {boolean} enabled
   */
  setHudOnly(enabled) {
    const next = !!enabled;
    if (this._hudOnly === next) return;
    this._hudOnly = next;
    this._applyHudOnly();
    this.dispatchEvent(new CustomEvent('golf:hudonlychange', {
      detail: { enabled: this._hudOnly },
      bubbles: true,
      composed: true,
    }));
    this._log(`HUD-only: ${this._hudOnly ? 'ON' : 'OFF'}`);
    if (this._hudOnly) {
      if (this._animFrameId) {
        cancelAnimationFrame(this._animFrameId);
        this._animFrameId = null;
      }
    } else {
      this.requestRender();
    }
  }

  /**
   * Whether the 3D canvas is currently hidden for HUD-only preview.
   * @returns {boolean}
   */
  getHudOnly() {
    return !!this._hudOnly;
  }

  _applyHudOnly() {
    const canvas = this._renderer && this._renderer.domElement;
    const container = this.shadowRoot && this.shadowRoot.getElementById('container');
    if (canvas) canvas.classList.toggle('hud-only-hidden', this._hudOnly);
    if (container) container.classList.toggle('hud-only', this._hudOnly);
    const btn = this.shadowRoot && this.shadowRoot.getElementById('hud-only-btn');
    if (btn) btn.classList.toggle('on', this._hudOnly);
  }

  /**
   * First authored waypoint (marker tag `waypoint`), sorted by `data.order`.
   * Dogleg default aim on Par; also used when Custom has no pin.
   * @returns {THREE.Vector3|null}
   * @private
   */
  _firstWaypointPosition() {
    const root = this._gameObjectsRoot || this._glbModel || null;
    // Prefer the live index (keeps tag/order API consistent); fall back to a
    // direct scene walk if the index has not been built yet.
    const waypoints = this.listGameObjects({ type: 'marker', tag: 'waypoint' });
    if (waypoints.length) {
      waypoints.sort((a, b) => {
        const ao = Number(a.data?.order);
        const bo = Number(b.data?.order);
        const aOk = Number.isFinite(ao);
        const bOk = Number.isFinite(bo);
        if (aOk && bOk && ao !== bo) return ao - bo;
        if (aOk && !bOk) return -1;
        if (!aOk && bOk) return 1;
        return String(a.id).localeCompare(String(b.id));
      });
      const pos = waypoints[0].position;
      return pos ? pos.clone() : null;
    }
    return firstWaypointWorldPosition(root);
  }

  /**
   * Default play target:
   *   aim override → sticky pin → waypoint (until handoff) → pin → null.
   *
   * Handoff to the pin is sticky for the rest of the hole once either:
   *   - the ball enters `camera.waypointHandoffRadius` of the waypoint, or
   *   - the flag is closer to the ball than the waypoint (past the bend).
   * Without the sticky latch, a drive past the bend leaves the bubble and
   * aim flips back to the waypoint behind the player.
   *
   * Shared by the distance marker, camera auto-aim, club suggest, and putts.
   * @returns {{ x: number, y?: number, z: number }|null}
   * @private
   */
  _resolveDefaultAimTarget() {
    if (this._aimTarget) return this._aimTarget;

    const flag = this.getFlagPosition();
    const waypoint = this._firstWaypointPosition();

    if (this._doglegPreferPin) {
      return flag || waypoint;
    }

    if (waypoint && this._currentOrigin) {
      const ox = this._currentOrigin.x;
      const oz = this._currentOrigin.z;
      const dxW = waypoint.x - ox;
      const dzW = waypoint.z - oz;
      const distW2 = dxW * dxW + dzW * dzW;

      const handoff = Number(this._config?.camera?.waypointHandoffRadius);
      const radius = Number.isFinite(handoff) ? handoff : 60;
      const nearWaypoint = distW2 <= radius * radius;

      // Past the bend: flag closer than waypoint (e.g. drove over the corner
      // without lingering inside the handoff bubble).
      let pastBend = false;
      if (flag) {
        const dxF = flag.x - ox;
        const dzF = flag.z - oz;
        pastBend = (dxF * dxF + dzF * dzF) < distW2;
      }

      if (nearWaypoint || pastBend) {
        this._doglegPreferPin = true;
        return flag || waypoint;
      }
      return waypoint;
    }

    if (waypoint) return waypoint;
    return flag;
  }

  // ── Menu ───────────────────────────────────────────────────────────────────

  _buildMenu() {
    const panel = this.shadowRoot.getElementById('menu-panel');
    panel.innerHTML = '';
    if (!this._activeTab) this._activeTab = 'shots';
    panel.classList.toggle('look-active', this._activeTab === 'look');

    // Tab bar — text labels, with a simple coloured bullet on the Trackman
    // tab. `hasStatusDot` prepends a <span> the tracker code
    // (_updateTrackerIndicator) finds via [data-role="tracker-dot"] and
    // recolours grey/red/green.
    const tabs = document.createElement('div');
    tabs.className = 'menu-tabs';
    const tabDefs = [
      { id: 'shots',   label: 'Shots' },
      { id: 'camera',  label: 'Camera' },
      { id: 'places',  label: 'Places' },
      { id: 'look',    label: 'Look', tooltip: 'Fog, light, shadows, shading, sky' },
      { id: 'tracker', label: 'Trackman', hasStatusDot: true, tooltip: 'Shot Tracker' },
    ];
    for (const def of tabDefs) {
      const tab = document.createElement('div');
      tab.className = 'menu-tab' + (this._activeTab === def.id ? ' active' : '');
      if (def.hasStatusDot) {
        const dot = document.createElement('span');
        dot.className = 'menu-tab-dot grey';
        dot.dataset.role = 'tracker-dot';
        dot.textContent = '\u2022';
        tab.appendChild(dot);
        tab.appendChild(document.createTextNode(def.label));
      } else {
        tab.textContent = def.label;
      }
      tab.title = def.tooltip || def.label;
      tab.dataset.tab = def.id;
      tab.addEventListener('click', () => this._switchTab(def.id));
      tabs.appendChild(tab);
    }
    panel.appendChild(tabs);

    // Tab content containers
    const content = document.createElement('div');
    content.className = 'menu-content';

    content.appendChild(this._buildShotsTab());
    content.appendChild(this._buildCameraTab());
    content.appendChild(this._buildPlacesTab());
    content.appendChild(this._buildLookTab());
    content.appendChild(this._buildTrackerTab());

    panel.appendChild(content);

    // Ensure the tracker dot and tooltip reflect reality as soon as the menu
    // is (re)built, and that we're subscribed to the radar's events.
    this._bindTrackerListeners();
    this._updateTrackerIndicator();
  }

  // Unified "Places" tab — merges the old Scenes + Positions tabs so the user
  // picks a scene (when the GLB has more than one) and then a hole within
  // that scene in a single click path. `setScene()` rebuilds the menu, so
  // switching scenes refreshes the Holes list below automatically.
  _buildPlacesTab() {
    const div = document.createElement('div');
    div.className = 'tab-content' + (this._activeTab === 'places' ? ' active' : '');
    div.dataset.tab = 'places';

    // Scene selector — only meaningful with >1 scene. Single-scene GLBs skip
    // this section entirely so the tab stays a plain Holes list.
    if (this._sceneList && this._sceneList.length > 1) {
      const sceneLabel = document.createElement('div');
      sceneLabel.className = 'club-section-label';
      sceneLabel.textContent = 'Scene';
      div.appendChild(sceneLabel);

      for (const scene of this._sceneList) {
        const item = document.createElement('div');
        item.className = 'menu-item' + (scene.name === this._activeSceneName ? ' active' : '');
        item.dataset.sceneName = scene.name;

        const nameSpan = document.createElement('span');
        nameSpan.textContent = scene.label;
        const numberBadge = document.createElement('span');
        numberBadge.textContent = `#${String(scene.number).padStart(2, '0')}`;
        numberBadge.style.color = '#666';
        numberBadge.style.marginLeft = '8px';
        numberBadge.style.fontSize = '11px';

        item.appendChild(nameSpan);
        item.appendChild(numberBadge);
        item.addEventListener('click', () => {
          if (scene.name === this._activeSceneName) return;
          this.setScene(scene.name);
        });
        div.appendChild(item);
      }

      const sep = document.createElement('div');
      sep.className = 'menu-separator';
      div.appendChild(sep);
    }

    // Holes / positions within the active scene.
    const posLabel = document.createElement('div');
    posLabel.className = 'club-section-label';
    posLabel.textContent = 'Holes';
    div.appendChild(posLabel);

    const positions = (this._config && this._config.positions) || [];
    if (positions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'menu-action disabled';
      empty.textContent = 'No positions in this scene';
      div.appendChild(empty);
    } else {
      for (const pos of positions) {
        const item = document.createElement('div');
        item.className = 'menu-item' + (this._selectedPosition && this._selectedPosition.id === pos.id ? ' active' : '');
        item.textContent = pos.label;
        item.dataset.id = pos.id;
        item.addEventListener('click', () => this._selectPosition(pos));
        div.appendChild(item);
      }
    }

    return div;
  }

  // ── Tracker tab ────────────────────────────────────────────────────────────
  //
  // Surfaces the <trackman-radar> connection state and controls inside the
  // M-menu. The visualiser has NO hard dependency on shot-tracker — we only
  // consume the public API (`connectionState`, `connectedDevice`, `units`,
  // `environment`, `setUnits`, `setEnvironment`, `disconnect`, `openModal`)
  // and the public events (`trackman:connected`, `trackman:disconnected`,
  // `trackman:unitschanged`, `trackman:environmentchanged`). If no radar
  // component is on the page the tab shows a friendly empty state and the
  // tab's status dot stays grey.

  _findRadar() {
    return document.querySelector('trackman-radar');
  }

  _buildTrackerTab() {
    const div = document.createElement('div');
    div.className = 'tab-content' + (this._activeTab === 'tracker' ? ' active' : '');
    div.dataset.tab = 'tracker';

    const radar = this._findRadar();
    if (!radar) {
      const empty = document.createElement('div');
      empty.className = 'tracker-empty';
      empty.textContent = 'Shot tracker component not loaded. Include <trackman-radar> in the page to see connection status and radar controls here.';
      div.appendChild(empty);
      return div;
    }

    const state = radar.connectionState || 'disconnected';
    const isConnected = state === 'connected';
    const device = radar.connectedDevice;

    // Status row (mirrors the tab's dot colour)
    const status = document.createElement('div');
    status.className = 'tracker-status';
    const dot = document.createElement('span');
    dot.className = 'tracker-status-dot ' + (isConnected ? 'green' : 'red');
    status.appendChild(dot);
    const statusText = document.createElement('span');
    if (isConnected) {
      const name = (device && (device.name || device.ip)) || 'Radar';
      statusText.innerHTML = `Connected · <span class="tracker-status-name">${this._escapeHtml(name)}</span>`;
    } else if (state === 'connecting') {
      statusText.textContent = 'Connecting…';
    } else {
      statusText.textContent = 'Disconnected';
    }
    status.appendChild(statusText);
    div.appendChild(status);

    if (!isConnected) {
      // Hide the Connect action while a connection attempt is already in
      // flight — the modal is doing its thing and a second click would just
      // re-trigger discovery.
      if (state !== 'connecting') {
        const connectBtn = document.createElement('div');
        connectBtn.className = 'menu-action';
        connectBtn.textContent = 'Connect to Radar';
        connectBtn.style.color = '#0ff';
        connectBtn.addEventListener('click', () => {
          if (typeof radar.openModal === 'function') radar.openModal();
        });
        div.appendChild(connectBtn);
      }
      return div;
    }

    // --- Connected UI ---

    // Units
    const unitsLabel = document.createElement('div');
    unitsLabel.className = 'club-section-label';
    unitsLabel.textContent = 'Units';
    div.appendChild(unitsLabel);

    const unitsWrap = document.createElement('div');
    unitsWrap.className = 'tracker-select-wrap';
    const select = document.createElement('select');
    select.className = 'tracker-select';
    const unitPresets = [
      { key: 'yds/mph',     label: 'yds / mph' },
      { key: 'm/mph',       label: 'm / mph' },
      { key: 'yds-ft/mph',  label: 'yds·ft / mph' },
      { key: 'm/ms',        label: 'm / m/s' },
      { key: 'yds/ms',      label: 'yds / m/s' },
    ];
    const currentKey = (radar.units && radar.units.key) || 'yds/mph';
    for (const p of unitPresets) {
      const opt = document.createElement('option');
      opt.value = p.key;
      opt.textContent = p.label;
      if (p.key === currentKey) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      if (typeof radar.setUnits === 'function') radar.setUnits(select.value);
    });
    unitsWrap.appendChild(select);
    div.appendChild(unitsWrap);

    // Environment
    const envLabel = document.createElement('div');
    envLabel.className = 'club-section-label';
    envLabel.textContent = 'Environment';
    div.appendChild(envLabel);

    const envToggle = document.createElement('div');
    envToggle.className = 'tracker-toggle';
    const currentEnv = radar.environment || 'Indoor';
    for (const mode of ['Indoor', 'Outdoor']) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tracker-toggle-btn' + (mode === currentEnv ? ' active' : '');
      btn.textContent = mode;
      btn.addEventListener('click', () => {
        // Do not optimistically paint — `_updateTrackerIndicator` rebuilds
        // this tab on `trackman:environmentchanged` with the confirmed mode.
        if (typeof radar.setEnvironment === 'function') radar.setEnvironment(mode);
      });
      envToggle.appendChild(btn);
    }
    div.appendChild(envToggle);

    if (currentEnv === 'Putting') {
      const puttingHint = document.createElement('div');
      puttingHint.className = 'tracker-env-hint';
      puttingHint.textContent = 'Putting mode (putter selected)';
      puttingHint.style.cssText = 'font-size:12px;color:#888;margin-top:6px;';
      div.appendChild(puttingHint);
    }

    // Shot Viewer link
    if (device && device.ip) {
      const link = document.createElement('a');
      link.className = 'menu-action';
      link.textContent = '↗ Open Shot Viewer';
      link.href = `http://${device.ip}/shotviewer.html`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.style.color = '#0ff';
      link.style.textDecoration = 'none';
      div.appendChild(link);
    }

    // Disconnect
    const sep = document.createElement('div');
    sep.className = 'menu-separator';
    div.appendChild(sep);

    const disconnectBtn = document.createElement('div');
    disconnectBtn.className = 'menu-action';
    disconnectBtn.textContent = 'Disconnect';
    disconnectBtn.style.color = '#f88';
    disconnectBtn.addEventListener('click', () => {
      if (typeof radar.disconnect === 'function') radar.disconnect();
    });
    div.appendChild(disconnectBtn);

    return div;
  }

  _updateTrackerIndicator() {
    const panel = this.shadowRoot && this.shadowRoot.getElementById('menu-panel');
    if (!panel) return;

    const radar = this._findRadar();
    const tabEl = panel.querySelector('.menu-tab[data-tab="tracker"]');
    if (!tabEl) return;

    const dotEl = tabEl.querySelector('[data-role="tracker-dot"]');
    const state = radar ? radar.connectionState : null;
    const isConnected = state === 'connected';

    // Dot colour
    if (dotEl) {
      dotEl.classList.remove('red', 'green', 'grey');
      if (!radar) dotEl.classList.add('grey');
      else dotEl.classList.add(isConnected ? 'green' : 'red');
    }

    // Dynamic tooltip
    if (!radar) {
      tabEl.title = 'Shot Tracker — Not loaded';
    } else if (isConnected) {
      const d = radar.connectedDevice;
      const name = (d && (d.name || d.ip)) || 'radar';
      tabEl.title = `Shot Tracker — Connected: ${name}`;
    } else if (state === 'connecting') {
      tabEl.title = 'Shot Tracker — Connecting…';
    } else {
      tabEl.title = 'Shot Tracker — Disconnected';
    }

    // If the tab is currently visible, re-render its body so the controls
    // (Connect button vs Units/Env/Disconnect) reflect the new state.
    if (this._activeTab === 'tracker') {
      const oldBody = panel.querySelector('.tab-content[data-tab="tracker"]');
      if (oldBody && oldBody.parentElement) {
        const fresh = this._buildTrackerTab();
        oldBody.parentElement.replaceChild(fresh, oldBody);
      }
    }
  }

  _bindTrackerListeners() {
    if (this._trackerListenersBound) return;
    this._trackerListenersBound = true;

    // When the visualiser is on the page, the Tracker tab in the M-menu is
    // the single source of truth for radar status — suppress the floating
    // dot so we never show two indicators at once. Safe to call on pages
    // that already opted in via the `hide-status-dot` attribute (no-op).
    const radar = this._findRadar();
    if (radar && typeof radar.setStatusDotVisible === 'function') {
      radar.setStatusDotVisible(false);
    }

    this._onTrackerEvent = () => this._updateTrackerIndicator();
    document.addEventListener('trackman:connected',          this._onTrackerEvent);
    document.addEventListener('trackman:disconnected',       this._onTrackerEvent);
    document.addEventListener('trackman:unitschanged',       this._onTrackerEvent);
    document.addEventListener('trackman:environmentchanged', this._onTrackerEvent);
  }

  _unbindTrackerListeners() {
    if (!this._trackerListenersBound) return;
    this._trackerListenersBound = false;
    document.removeEventListener('trackman:connected',          this._onTrackerEvent);
    document.removeEventListener('trackman:disconnected',       this._onTrackerEvent);
    document.removeEventListener('trackman:unitschanged',       this._onTrackerEvent);
    document.removeEventListener('trackman:environmentchanged', this._onTrackerEvent);
  }

  _escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  _switchTab(tabId) {
    this._activeTab = tabId;
    const panel = this.shadowRoot.getElementById('menu-panel');
    panel.classList.toggle('look-active', tabId === 'look');

    // Update tab highlights
    panel.querySelectorAll('.menu-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tabId);
    });

    // Show/hide content
    panel.querySelectorAll('.tab-content').forEach(c => {
      c.classList.toggle('active', c.dataset.tab === tabId);
    });

    // Tracker body may be stale (built at menu-open with older state) — rebuild
    // when the user switches to it so controls reflect the current radar.
    if (tabId === 'tracker') this._updateTrackerIndicator();
  }

  // ── Look tab (live visual tweaks) ──────────────────────────────────────────
  //
  // Session-only fog / light / shadow / tone / shading / skybox controls.
  // Mutates this._config then calls the same private apply helpers used on
  // scene switch. Copy JSON → clipboard for pasting into app-config.json.

  static get LOOK_SKY_PRESETS() {
    return Object.values(ENGINE_SKY_PRESETS).map((p) => ({
      id: p.id,
      label: p.label,
    }));
  }

  _cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  _getLookSnapshot() {
    const cfg = this._config || {};
    const scene = cfg.scene || {};
    return {
      scene: {
        background: scene.background ?? DEFAULTS.scene.background,
        skybox: this._cloneJson(scene.skybox ?? null),
        fog: this._cloneJson(scene.fog ?? null),
      },
      lighting: this._cloneJson(cfg.lighting || DEFAULTS.lighting),
      rendering: this._cloneJson(cfg.rendering || DEFAULTS.rendering),
      shading: this._cloneJson(cfg.shading || DEFAULTS.shading),
      comet: this._cloneJson(cfg.comet || DEFAULTS.comet),
      camera: { far: Number(cfg.camera?.far) || DEFAULTS.camera.far },
      culling: this._cloneJson(cfg.culling || DEFAULTS.culling),
    };
  }

  _applyLookVisuals(kinds) {
    const set = kinds instanceof Set ? kinds : new Set(kinds || []);
    const sceneCfg = this._config && this._config.scene;
    if (set.has('background') && sceneCfg) void this._applyBackground(sceneCfg);
    if (set.has('fog') && sceneCfg) this._applyFog(sceneCfg);
    if (set.has('camera')) this._applyCameraFar();
    if (set.has('culling')) this._updatePropCulling(true);
    if (set.has('tone')) this._applyToneMapping(this._config.rendering);
    if (set.has('lights')) this._applyLookLights();
    if (set.has('shadows')) this._applyShadowConfig();
    if (set.has('shading') && this._glbModel) this._applyShading(this._glbModel);
    if (set.has('comet')) this._applyCometLook();
    this.requestRender();
  }

  /**
   * Public: apply an editor "look" block live (scene / lighting / rendering /
   * shading / comet / camera / culling), mirroring what the built-in LOOK menu
   * does. Used by the course editor's Play-mode Environment panel so changes
   * preview instantly. `kinds` optionally limits which visual groups re-apply
   * (background|fog|camera|culling|tone|lights|shadows|shading|comet);
   * omit to apply everything.
   */
  setLook(look, kinds) {
    if (!look || !this._config) return;
    this._ensureLookConfigShapes();
    const cfg = this._config;
    if (look.scene) {
      if (look.scene.background !== undefined) cfg.scene.background = look.scene.background;
      if ('skybox' in look.scene) cfg.scene.skybox = look.scene.skybox ? this._cloneJson(look.scene.skybox) : null;
      if ('fog' in look.scene) cfg.scene.fog = look.scene.fog ? this._cloneJson(look.scene.fog) : null;
    }
    if (look.lighting) this._deepAssignLook(cfg.lighting, look.lighting);
    if (look.rendering) this._deepAssignLook(cfg.rendering, look.rendering);
    if (look.shading) this._deepAssignLook(cfg.shading, look.shading);
    if (look.comet) this._deepAssignLook(cfg.comet, look.comet);
    if (look.camera) this._deepAssignLook(cfg.camera, look.camera);
    if (look.culling) this._deepAssignLook(cfg.culling, look.culling);
    const all = ['background', 'fog', 'camera', 'culling', 'tone', 'lights', 'shadows', 'shading', 'comet'];
    this._applyLookVisuals(new Set(Array.isArray(kinds) && kinds.length ? kinds : all));
  }

  _deepAssignLook(target, source) {
    if (!target || !source) return;
    for (const k of Object.keys(source)) {
      const sv = source[k];
      if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
        if (!target[k] || typeof target[k] !== 'object') target[k] = {};
        this._deepAssignLook(target[k], sv);
      } else {
        target[k] = sv;
      }
    }
  }

  _applyLookLights() {
    const lighting = (this._config && this._config.lighting) || {};
    const ambient = lighting.ambient || DEFAULTS.lighting.ambient;
    const directional = lighting.directional || DEFAULTS.lighting.directional;

    if (this._ambientLight) {
      this._ambientLight.color.set(ambient.color);
      this._ambientLight.intensity = Number(ambient.intensity) || 0;
    }
    if (this._directionalLight) {
      this._directionalLight.color.set(directional.color);
      this._directionalLight.intensity = Number(directional.intensity) || 0;
      const shadows = this._getShadowsConfig();
      const shadowsOn = !!(shadows.enabled && shadows.static && shadows.static.enabled);
      const pos = Array.isArray(directional.position) ? directional.position : [1, 3, 2];
      if (!shadowsOn) {
        this._directionalLight.position.set(pos[0], pos[1], pos[2]);
      } else {
        const focus = this._currentOrigin || this._controls?.target || new THREE.Vector3();
        this._refreshStaticShadows(focus);
      }
    }
  }

  _ensureLookConfigShapes() {
    if (!this._config) return;
    if (!this._config.scene) this._config.scene = {};
    if (!this._config.lighting) this._config.lighting = this._cloneJson(DEFAULTS.lighting);
    if (!this._config.lighting.ambient) {
      this._config.lighting.ambient = this._cloneJson(DEFAULTS.lighting.ambient);
    }
    if (!this._config.lighting.directional) {
      this._config.lighting.directional = this._cloneJson(DEFAULTS.lighting.directional);
    }
    if (!this._config.lighting.shadows) {
      this._config.lighting.shadows = this._cloneJson(DEFAULTS.lighting.shadows);
    }
    const sh = this._config.lighting.shadows;
    if (!sh.ball) sh.ball = this._cloneJson(DEFAULTS.lighting.shadows.ball);
    if (!sh.static) sh.static = this._cloneJson(DEFAULTS.lighting.shadows.static);
    if (!this._config.rendering) this._config.rendering = this._cloneJson(DEFAULTS.rendering);
    if (!this._config.shading) this._config.shading = this._cloneJson(DEFAULTS.shading);
    if (!this._config.comet) this._config.comet = this._cloneJson(DEFAULTS.comet);
    if (!this._config.camera) this._config.camera = this._cloneJson(DEFAULTS.camera);
    if (!this._config.culling) this._config.culling = this._cloneJson(DEFAULTS.culling);
    if (!Number.isFinite(Number(this._config.culling.propsDistance))) {
      this._config.culling.propsDistance = DEFAULTS.culling.propsDistance;
    }
  }

  /** Apply `camera.far` draw distance (hard clip — not fog). */
  _applyCameraFar() {
    if (!this._camera || !this._config?.camera) return;
    const far = Number(this._config.camera.far);
    if (!Number.isFinite(far) || far < 1) return;
    this._camera.far = far;
    this._camera.updateProjectionMatrix();
  }

  _invalidatePropCullCache() {
    // Restore visibility before dropping the list so nothing stays hidden.
    if (this._cullableProps) {
      for (const o of this._cullableProps) o.visible = true;
    }
    this._cullableProps = null;
    this._propCullActive = false;
  }

  /**
   * Collect vegetation roots (`veg_*` / userData.vegetation) under the active
   * scene (or whole GLB). Cheap to rebuild on scene switch.
   */
  _collectCullableProps() {
    let root = this._glbModel;
    if (this._activeSceneName && this._sceneList?.length) {
      const entry = this._sceneList.find((s) => s.name === this._activeSceneName);
      if (entry?.group) root = entry.group;
    }
    const list = [];
    if (!root) {
      this._cullableProps = list;
      return;
    }
    root.traverse((o) => {
      if (!o?.name) return;
      if (/^veg_/i.test(o.name) || o.userData?.vegetation === true) {
        // Prefer the veg group root — skip nested flagged meshes.
        if (o.parent && (/^veg_/i.test(o.parent.name) || o.parent.userData?.vegetation)) return;
        list.push(o);
      }
    });
    this._cullableProps = list;
  }

  /**
   * Hide vegetation beyond `culling.propsDistance`. Pass `force=true` after a
   * config change so enabling/disabling refreshes immediately.
   */
  _updatePropCulling(force = false) {
    const dist = Number(this._config?.culling?.propsDistance);
    const enabled = Number.isFinite(dist) && dist > 0;
    if (!enabled) {
      if (this._propCullActive || force) {
        if (!this._cullableProps) this._collectCullableProps();
        for (const o of this._cullableProps || []) o.visible = true;
        this._propCullActive = false;
      }
      return;
    }
    if (!this._cullableProps) this._collectCullableProps();
    if (!this._camera || !this._cullableProps.length) return;
    this._propCullActive = true;
    const cam = this._camera.position;
    const d2 = dist * dist;
    const wp = this._propCullWorldPos;
    for (const o of this._cullableProps) {
      o.getWorldPosition(wp);
      const dx = wp.x - cam.x;
      const dy = wp.y - cam.y;
      const dz = wp.z - cam.z;
      o.visible = (dx * dx + dy * dy + dz * dz) <= d2;
    }
  }

  _applyCometLook() {
    const cfg = this._config?.comet || DEFAULTS.comet;
    const color = cfg.color || DEFAULTS.comet.color;
    const ab = this._activeBall;
    if (!ab?.comet?.mesh) return;
    if (ab.comet.mesh.material?.uniforms?.uColor) {
      ab.comet.mesh.material.uniforms.uColor.value.set(color);
    }
    if (cfg.enabled === false) {
      ab.comet.mesh.visible = false;
      ab.comet.history.length = 0;
    }
  }

  _lookSection(parent, title) {
    const label = document.createElement('div');
    label.className = 'club-section-label';
    label.textContent = title;
    parent.appendChild(label);
    return label;
  }

  _lookSeparator(parent) {
    const sep = document.createElement('div');
    sep.className = 'menu-separator';
    parent.appendChild(sep);
    return sep;
  }

  _lookSlider(parent, { label, min, max, step, value, format, onInput }) {
    const row = document.createElement('div');
    row.className = 'look-row';
    const lab = document.createElement('div');
    lab.className = 'look-row-label';
    lab.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'look-slider';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    const val = document.createElement('div');
    val.className = 'look-row-value';
    const fmt = format || ((n) => String(n));
    val.textContent = fmt(Number(input.value));
    input.addEventListener('input', () => {
      const n = Number(input.value);
      val.textContent = fmt(n);
      onInput(n);
    });
    row.appendChild(lab);
    row.appendChild(input);
    row.appendChild(val);
    parent.appendChild(row);
    return row;
  }

  _lookSelect(parent, { label, options, value, onChange }) {
    const row = document.createElement('div');
    row.className = 'look-row';
    const lab = document.createElement('div');
    lab.className = 'look-row-label';
    lab.textContent = label;
    const select = document.createElement('select');
    select.className = 'look-select';
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === value) o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener('change', () => onChange(select.value));
    row.appendChild(lab);
    row.appendChild(select);
    parent.appendChild(row);
    return row;
  }

  _lookColor(parent, { label, value, onChange }) {
    const row = document.createElement('div');
    row.className = 'look-row';
    const lab = document.createElement('div');
    lab.className = 'look-row-label';
    lab.textContent = label;
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'look-color';
    // <input type="color"> needs #rrggbb
    let hex = String(value || '#ffffff');
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
      try {
        hex = '#' + new THREE.Color(hex).getHexString();
      } catch (_) {
        hex = '#ffffff';
      }
    }
    input.value = hex;
    input.addEventListener('input', () => onChange(input.value));
    row.appendChild(lab);
    row.appendChild(input);
    parent.appendChild(row);
    return row;
  }

  _lookToggle(parent, { label, value, onChange }) {
    const row = document.createElement('div');
    row.className = 'look-row';
    const lab = document.createElement('div');
    lab.className = 'look-row-label';
    lab.textContent = label;
    const wrap = document.createElement('div');
    wrap.className = 'tracker-toggle';
    wrap.style.padding = '0';
    wrap.style.flex = '1';
    for (const [on, text] of [[true, 'On'], [false, 'Off']]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tracker-toggle-btn' + ((!!value) === on ? ' active' : '');
      btn.textContent = text;
      btn.addEventListener('click', () => {
        if ((!!value) === on) return;
        onChange(on);
      });
      wrap.appendChild(btn);
    }
    row.appendChild(lab);
    row.appendChild(wrap);
    parent.appendChild(row);
    return row;
  }

  _rebuildLookTab() {
    const panel = this.shadowRoot && this.shadowRoot.getElementById('menu-panel');
    if (!panel) return;
    const old = panel.querySelector('.tab-content[data-tab="look"]');
    if (!old || !old.parentElement) return;
    old.parentElement.replaceChild(this._buildLookTab(), old);
  }

  _buildLookTab() {
    const div = document.createElement('div');
    div.className = 'tab-content' + (this._activeTab === 'look' ? ' active' : '');
    div.dataset.tab = 'look';

    this._ensureLookConfigShapes();
    const snap = this._getLookSnapshot();
    const fog = snap.scene.fog;
    const fogOn = !!(fog && typeof fog === 'object');
    let fogType = fogOn ? String(fog.type || 'linear').toLowerCase() : 'linear';
    if (fogType === 'exponential' || fogType === 'density') fogType = 'exp2';
    const shadows = snap.lighting.shadows || DEFAULTS.lighting.shadows;
    const skybox = snap.scene.skybox;
    const skyType = (skybox && skybox.type) || 'color';
    const skyPreset = (skybox && skybox.preset) || '';
    const skyPath = (skybox && skybox.path) || '';
    const shadingStyle = (snap.shading && snap.shading.style) || 'clay';

    const scroll = document.createElement('div');
    scroll.className = 'look-scroll';

    // Actions
    const actions = document.createElement('div');
    actions.className = 'look-actions';
    const copyBtn = document.createElement('div');
    copyBtn.className = 'menu-action';
    copyBtn.textContent = 'Copy JSON';
    copyBtn.title = 'Copy scene/lighting/rendering/shading/comet JSON for app-config.json';
    copyBtn.addEventListener('click', () => this._copyLookConfig(copyBtn));
    const resetBtn = document.createElement('div');
    resetBtn.className = 'menu-action';
    resetBtn.textContent = 'Reset';
    resetBtn.title = 'Restore look settings from loaded app-config';
    resetBtn.addEventListener('click', () => this._resetLookSettings());
    actions.appendChild(copyBtn);
    actions.appendChild(resetBtn);
    scroll.appendChild(actions);
    const hint = document.createElement('div');
    hint.className = 'look-hint';
    hint.textContent = 'Live preview only. Copy JSON, then paste into app-config.json to keep.';
    scroll.appendChild(hint);

    // ── Fog ──────────────────────────────────────────────────────────────
    this._lookSection(scroll, 'Fog');
    this._lookToggle(scroll, {
      label: 'Enabled',
      value: fogOn,
      onChange: (on) => {
        if (on) {
          const backup = this._lookFogBackup || {
            type: 'linear', color: '#9FBBC3', near: 25, far: 220,
          };
          this._config.scene.fog = this._cloneJson(backup);
        } else {
          if (this._config.scene.fog) {
            this._lookFogBackup = this._cloneJson(this._config.scene.fog);
          }
          this._config.scene.fog = null;
        }
        this._applyLookVisuals(['fog']);
        this._rebuildLookTab();
      },
    });
    if (fogOn) {
      this._lookSelect(scroll, {
        label: 'Type',
        value: fogType === 'exp2' ? 'exp2' : 'linear',
        options: [
          { value: 'linear', label: 'Linear' },
          { value: 'exp2', label: 'Exp2' },
        ],
        onChange: (type) => {
          const prev = this._config.scene.fog || {};
          if (type === 'exp2') {
            this._config.scene.fog = {
              type: 'exp2',
              color: prev.color || '#9FBBC3',
              density: Number.isFinite(Number(prev.density)) ? Number(prev.density) : 0.004,
            };
          } else {
            this._config.scene.fog = {
              type: 'linear',
              color: prev.color || '#9FBBC3',
              near: Number.isFinite(Number(prev.near)) ? Number(prev.near) : 25,
              far: Number.isFinite(Number(prev.far)) ? Number(prev.far) : 220,
            };
          }
          this._applyLookVisuals(['fog']);
          this._rebuildLookTab();
        },
      });
      this._lookColor(scroll, {
        label: 'Color',
        value: fog.color || '#9FBBC3',
        onChange: (c) => {
          this._config.scene.fog.color = c;
          this._applyLookVisuals(['fog']);
        },
      });
      if (fogType === 'exp2') {
        this._lookSlider(scroll, {
          label: 'Density',
          min: 0.0005, max: 0.02, step: 0.0005,
          value: Number(fog.density) || 0.004,
          format: (n) => n.toFixed(4),
          onInput: (n) => {
            this._config.scene.fog.density = n;
            this._applyLookVisuals(['fog']);
          },
        });
      } else {
        this._lookSlider(scroll, {
          label: 'Near',
          min: 0, max: 500, step: 1,
          value: Number(fog.near) || 25,
          format: (n) => String(Math.round(n)),
          onInput: (n) => {
            this._config.scene.fog.near = n;
            this._applyLookVisuals(['fog']);
          },
        });
        this._lookSlider(scroll, {
          label: 'Far',
          min: 10, max: 2000, step: 5,
          value: Number(fog.far) || 220,
          format: (n) => String(Math.round(n)),
          onInput: (n) => {
            this._config.scene.fog.far = n;
            this._applyLookVisuals(['fog']);
          },
        });
      }
    }

    // ── Draw distance (hard clip + prop cull — not fog) ──────────────────
    this._lookSeparator(scroll);
    this._lookSection(scroll, 'Draw distance');
    const hintDraw = document.createElement('div');
    hintDraw.className = 'look-hint';
    hintDraw.textContent = 'Hard clip / hide — no color tint (unlike fog).';
    scroll.appendChild(hintDraw);
    this._lookSlider(scroll, {
      label: 'Camera far',
      min: 100, max: 4000, step: 50,
      value: Number(snap.camera?.far) || DEFAULTS.camera.far,
      format: (n) => `${Math.round(n)} m`,
      onInput: (n) => {
        this._config.camera.far = n;
        this._applyLookVisuals(['camera']);
      },
    });
    this._lookSlider(scroll, {
      label: 'Cull props',
      min: 0, max: 500, step: 10,
      value: Number(snap.culling?.propsDistance) || 0,
      format: (n) => (n <= 0 ? 'Off' : `${Math.round(n)} m`),
      onInput: (n) => {
        if (!this._config.culling) this._config.culling = { ...DEFAULTS.culling };
        this._config.culling.propsDistance = n;
        this._applyLookVisuals(['culling']);
      },
    });

    // ── Lighting ─────────────────────────────────────────────────────────
    this._lookSeparator(scroll);
    this._lookSection(scroll, 'Lighting');
    const amb = snap.lighting.ambient;
    const dir = snap.lighting.directional;
    this._lookColor(scroll, {
      label: 'Ambient',
      value: amb.color,
      onChange: (c) => {
        this._config.lighting.ambient.color = c;
        this._applyLookVisuals(['lights']);
      },
    });
    this._lookSlider(scroll, {
      label: 'Amb. int.',
      min: 0, max: 3, step: 0.05,
      value: Number(amb.intensity) || 0,
      format: (n) => n.toFixed(2),
      onInput: (n) => {
        this._config.lighting.ambient.intensity = n;
        this._applyLookVisuals(['lights']);
      },
    });
    this._lookColor(scroll, {
      label: 'Sun',
      value: dir.color,
      onChange: (c) => {
        this._config.lighting.directional.color = c;
        this._applyLookVisuals(['lights']);
      },
    });
    this._lookSlider(scroll, {
      label: 'Sun int.',
      min: 0, max: 3, step: 0.05,
      value: Number(dir.intensity) || 0,
      format: (n) => n.toFixed(2),
      onInput: (n) => {
        this._config.lighting.directional.intensity = n;
        this._applyLookVisuals(['lights']);
      },
    });
    const pos = Array.isArray(dir.position) ? dir.position.slice() : [1, 3, 2];
    while (pos.length < 3) pos.push(0);
    for (const [axis, idx] of [['Dir X', 0], ['Dir Y', 1], ['Dir Z', 2]]) {
      this._lookSlider(scroll, {
        label: axis,
        min: -10, max: 10, step: 0.1,
        value: Number(pos[idx]) || 0,
        format: (n) => n.toFixed(1),
        onInput: (n) => {
          const p = this._config.lighting.directional.position;
          if (!Array.isArray(p)) this._config.lighting.directional.position = [1, 3, 2];
          this._config.lighting.directional.position[idx] = n;
          this._applyLookVisuals(['lights']);
        },
      });
    }

    // ── Shadows ──────────────────────────────────────────────────────────
    this._lookSeparator(scroll);
    this._lookSection(scroll, 'Shadows');
    this._lookToggle(scroll, {
      label: 'Enabled',
      value: !!shadows.enabled,
      onChange: (on) => {
        this._config.lighting.shadows.enabled = on;
        this._applyLookVisuals(['shadows', 'lights']);
        this._rebuildLookTab();
      },
    });
    if (shadows.enabled) {
      this._lookSelect(scroll, {
        label: 'Type',
        value: String(shadows.type || 'pcfsoft').toLowerCase(),
        options: [
          { value: 'pcfsoft', label: 'PCF Soft' },
          { value: 'pcf', label: 'PCF' },
          { value: 'basic', label: 'Basic' },
        ],
        onChange: (type) => {
          this._config.lighting.shadows.type = type;
          this._applyLookVisuals(['shadows']);
        },
      });
      this._lookSelect(scroll, {
        label: 'Map size',
        value: String(shadows.mapSize || 2048),
        options: [
          { value: '512', label: '512' },
          { value: '1024', label: '1024' },
          { value: '2048', label: '2048' },
          { value: '4096', label: '4096' },
        ],
        onChange: (v) => {
          this._config.lighting.shadows.mapSize = Number(v);
          this._applyLookVisuals(['shadows']);
        },
      });
      this._lookSlider(scroll, {
        label: 'Intensity',
        min: 0, max: 2, step: 0.05,
        value: Number.isFinite(Number(shadows.intensity)) ? Number(shadows.intensity) : 1,
        format: (n) => n.toFixed(2),
        onInput: (n) => {
          this._config.lighting.shadows.intensity = n;
          this._applyLookVisuals(['shadows']);
        },
      });
      this._lookSlider(scroll, {
        label: 'Camera',
        min: 20, max: 400, step: 5,
        value: Number(shadows.cameraSize) || 120,
        format: (n) => String(Math.round(n)),
        onInput: (n) => {
          this._config.lighting.shadows.cameraSize = n;
          this._applyLookVisuals(['shadows']);
        },
      });
      this._lookSlider(scroll, {
        label: 'Bias',
        min: -0.01, max: 0.01, step: 0.0001,
        value: Number(shadows.bias) || 0,
        format: (n) => n.toFixed(4),
        onInput: (n) => {
          this._config.lighting.shadows.bias = n;
          this._applyLookVisuals(['shadows']);
        },
      });
      this._lookSlider(scroll, {
        label: 'N. bias',
        min: 0, max: 0.1, step: 0.001,
        value: Number(shadows.normalBias) || 0,
        format: (n) => n.toFixed(3),
        onInput: (n) => {
          this._config.lighting.shadows.normalBias = n;
          this._applyLookVisuals(['shadows']);
        },
      });
      this._lookToggle(scroll, {
        label: 'Static map',
        value: !!(shadows.static && shadows.static.enabled),
        onChange: (on) => {
          this._config.lighting.shadows.static.enabled = on;
          this._applyLookVisuals(['shadows', 'lights']);
        },
      });
      this._lookToggle(scroll, {
        label: 'Ball blob',
        value: !!(shadows.ball && shadows.ball.enabled),
        onChange: (on) => {
          this._config.lighting.shadows.ball.enabled = on;
          this._applyLookVisuals(['shadows']);
          this._rebuildLookTab();
        },
      });
      if (shadows.ball && shadows.ball.enabled) {
        this._lookSlider(scroll, {
          label: 'Blob opac.',
          min: 0, max: 1, step: 0.01,
          value: Number(shadows.ball.opacity) || 0,
          format: (n) => n.toFixed(2),
          onInput: (n) => {
            this._config.lighting.shadows.ball.opacity = n;
            // Read every frame — no apply needed, but ensure config is live.
          },
        });
        this._lookSlider(scroll, {
          label: 'Blob scale',
          min: 0.5, max: 10, step: 0.1,
          value: Number(shadows.ball.scale) || 3,
          format: (n) => n.toFixed(1),
          onInput: (n) => {
            this._config.lighting.shadows.ball.scale = n;
          },
        });
      }
    }

    // ── Rendering ────────────────────────────────────────────────────────
    this._lookSeparator(scroll);
    this._lookSection(scroll, 'Rendering');
    const tone = String((snap.rendering && snap.rendering.toneMapping) || 'none');
    this._lookSelect(scroll, {
      label: 'Tone map',
      value: tone,
      options: [
        { value: 'none', label: 'None' },
        { value: 'ACESFilmic', label: 'ACES Filmic' },
        { value: 'AgX', label: 'AgX' },
        { value: 'Neutral', label: 'Neutral' },
        { value: 'Reinhard', label: 'Reinhard' },
        { value: 'Cineon', label: 'Cineon' },
      ],
      onChange: (v) => {
        this._config.rendering.toneMapping = v;
        this._applyLookVisuals(['tone']);
        this._rebuildLookTab();
      },
    });
    if (tone.toLowerCase() !== 'none') {
      this._lookSlider(scroll, {
        label: 'Exposure',
        min: 0.1, max: 3, step: 0.05,
        value: Number(snap.rendering.exposure) || 1,
        format: (n) => n.toFixed(2),
        onInput: (n) => {
          this._config.rendering.exposure = n;
          this._applyLookVisuals(['tone']);
        },
      });
    }

    // ── Shading ──────────────────────────────────────────────────────────
    this._lookSeparator(scroll);
    this._lookSection(scroll, 'Shading');
    this._lookSelect(scroll, {
      label: 'Style',
      value: shadingStyle,
      options: [
        { value: 'clay', label: 'Clay' },
        { value: 'toon', label: 'Toon' },
        { value: 'realistic', label: 'Realistic' },
        { value: 'phong', label: 'Phong' },
        { value: 'basic', label: 'Basic' },
        { value: 'normal', label: 'Normal' },
      ],
      onChange: (style) => {
        this._config.shading.style = style;
        this._applyLookVisuals(['shading']);
        this._rebuildLookTab();
      },
    });
    if (shadingStyle === 'toon') {
      const steps = Math.max(2, Math.min(16, Math.round(Number(snap.shading.toonSteps) || 4)));
      this._lookSlider(scroll, {
        label: 'Toon steps',
        min: 2, max: 16, step: 1,
        value: steps,
        format: (n) => String(Math.round(n)),
        onInput: (n) => {
          this._config.shading.toonSteps = Math.round(n);
          this._applyLookVisuals(['shading']);
        },
      });
    }

    // ── Comet (ball trail) ───────────────────────────────────────────────
    this._lookSeparator(scroll);
    this._lookSection(scroll, 'Comet');
    const comet = snap.comet || DEFAULTS.comet;
    const cometOn = comet.enabled !== false;
    this._lookToggle(scroll, {
      label: 'Enabled',
      value: cometOn,
      onChange: (on) => {
        this._config.comet.enabled = on;
        this._applyLookVisuals(['comet']);
        this._rebuildLookTab();
      },
    });
    if (cometOn) {
      this._lookColor(scroll, {
        label: 'Color',
        value: comet.color || DEFAULTS.comet.color,
        onChange: (c) => {
          this._config.comet.color = c;
          this._applyLookVisuals(['comet']);
        },
      });
      this._lookSlider(scroll, {
        label: 'Time',
        min: 0, max: 2, step: 0.05,
        value: Number.isFinite(Number(comet.time)) ? Number(comet.time) : DEFAULTS.comet.time,
        format: (n) => `${n.toFixed(2)} s`,
        onInput: (n) => {
          this._config.comet.time = n;
          this._applyLookVisuals(['comet']);
        },
      });
    }

    // ── Sky / background ─────────────────────────────────────────────────
    this._lookSeparator(scroll);
    this._lookSection(scroll, 'Skybox');
    this._lookColor(scroll, {
      label: 'BG color',
      value: snap.scene.background || '#87CEEB',
      onChange: (c) => {
        this._config.scene.background = c;
        // Only re-apply solid bg when no texture skybox, or when type is color.
        const sb = this._config.scene.skybox;
        if (!sb || sb.type === 'color') {
          this._applyLookVisuals(['background']);
        } else if (this._scene && !this._skyboxTexture) {
          this._scene.background = new THREE.Color(c);
        }
      },
    });
    this._lookSelect(scroll, {
      label: 'Type',
      value: skyType === 'equirect' || skyType === 'hdr' || skyType === 'exr' || skyType === 'cube'
        ? (skyType === 'equirect' ? 'equirect' : skyType)
        : 'color',
      options: [
        { value: 'color', label: 'Solid color' },
        { value: 'equirect', label: 'Skybox' },
      ],
      onChange: (type) => {
        if (type === 'color') {
          this._config.scene.skybox = null;
        } else {
          const prev = this._config.scene.skybox || {};
          const preset = prev.preset || GolfVisualiser.LOOK_SKY_PRESETS[0]?.id || 'light-blue';
          this._config.scene.skybox = {
            type: 'equirect',
            preset,
            environment: !!prev.environment,
          };
        }
        this._applyLookVisuals(['background']);
        this._rebuildLookTab();
      },
    });
    if (skyType !== 'color' && skybox) {
      const presets = GolfVisualiser.LOOK_SKY_PRESETS.slice();
      const options = presets.map((p) => ({ value: p.id, label: p.label }));
      if (skyPath && !skyPreset) {
        options.unshift({
          value: '__custom__',
          label: skyPath.split('/').pop() || skyPath,
        });
      }
      const selectValue = skyPreset || (skyPath ? '__custom__' : (presets[0]?.id || 'light-blue'));
      this._lookSelect(scroll, {
        label: 'Preset',
        value: selectValue,
        options,
        onChange: (id) => {
          if (id === '__custom__') return;
          this._config.scene.skybox = {
            type: 'equirect',
            preset: id,
            environment: !!(this._config.scene.skybox && this._config.scene.skybox.environment),
          };
          this._applyLookVisuals(['background']);
          this._rebuildLookTab();
        },
      });
      this._lookToggle(scroll, {
        label: 'IBL env',
        value: !!skybox.environment,
        onChange: (on) => {
          if (!this._config.scene.skybox || typeof this._config.scene.skybox !== 'object') return;
          this._config.scene.skybox.environment = on;
          this._applyLookVisuals(['background']);
        },
      });
    }

    div.appendChild(scroll);
    return div;
  }

  async _copyLookConfig(btn) {
    const json = JSON.stringify(this._getLookSnapshot(), null, 2);
    const label = btn ? btn.textContent : null;
    try {
      await navigator.clipboard.writeText(json);
      if (btn) {
        btn.textContent = 'Copied!';
        btn.style.color = '#0f0';
        setTimeout(() => {
          btn.textContent = label || 'Copy JSON';
          btn.style.color = '';
        }, 1200);
      }
      this._log('Look config copied to clipboard');
    } catch (e) {
      if (btn) {
        btn.textContent = 'Copy failed';
        btn.style.color = '#f88';
        setTimeout(() => {
          btn.textContent = label || 'Copy JSON';
          btn.style.color = '';
        }, 1500);
      }
      this._log(`Look copy failed: ${e.message || e}`);
    }
  }

  _resetLookSettings() {
    const base = this._baseConfig;
    if (!base || !this._config) return;

    this._config.scene.background = base.scene.background ?? DEFAULTS.scene.background;
    this._config.scene.skybox = this._cloneJson(base.scene.skybox ?? null);
    this._config.scene.fog = this._cloneJson(base.scene.fog ?? null);
    this._config.lighting = deepMerge(DEFAULTS.lighting, this._cloneJson(base.lighting || {}));
    this._config.rendering = deepMerge(DEFAULTS.rendering, this._cloneJson(base.rendering || {}));
    this._config.shading = deepMerge(DEFAULTS.shading, this._cloneJson(base.shading || {}));
    this._config.comet = { ...DEFAULTS.comet, ...(base.comet || {}) };
    this._config.camera = deepMerge(DEFAULTS.camera, this._cloneJson(base.camera || {}));
    this._config.culling = deepMerge(DEFAULTS.culling, this._cloneJson(base.culling || {}));
    this._lookFogBackup = null;

    this._applyLookVisuals(['background', 'fog', 'camera', 'culling', 'tone', 'lights', 'shadows', 'shading', 'comet']);
    this._rebuildLookTab();
    this._log('Look settings reset to loaded config');
  }

  _buildCameraTab() {
    const div = document.createElement('div');
    div.className = 'tab-content' + (this._activeTab === 'camera' ? ' active' : '');
    div.dataset.tab = 'camera';

    const label = document.createElement('div');
    label.className = 'club-section-label';
    label.textContent = 'Camera Mode';
    div.appendChild(label);

    const modes = [
      { id: 'follow',  label: 'Follow Shot' },
      { id: 'static',  label: 'Static' },
      { id: 'freefly', label: 'Free Fly (F)' },
    ];

    const current = this._getEffectiveCameraMode();

    for (const mode of modes) {
      const item = document.createElement('div');
      item.className = 'club-item' + (mode.id === current ? ' selected' : '');
      item.dataset.mode = mode.id;

      const nameSpan = document.createElement('span');
      nameSpan.textContent = mode.label;
      item.appendChild(nameSpan);

      item.addEventListener('click', () => {
        // Route through the free-fly toggle so the pre-mode is captured and
        // the Shortcuts-tab button stays in lock-step. Plain follow/static
        // selections still go through the direct assignment path.
        if (mode.id === 'freefly') {
          if (this._cameraMode !== 'freefly') this._toggleFreeFly();
        } else {
          if (this._cameraMode === 'freefly') this._preFreeFlyMode = null;
          this._cameraMode = mode.id;
          this._log(`Camera mode: ${mode.id}`);
          this._buildMenu();
        }
      });

      div.appendChild(item);
    }

    // Separator + HUD section
    const sep = document.createElement('div');
    sep.className = 'menu-separator';
    div.appendChild(sep);

    const hudLabel = document.createElement('div');
    hudLabel.className = 'club-section-label';
    hudLabel.textContent = 'HUD';
    div.appendChild(hudLabel);

    // HUD-only preview — hide the 3D canvas; overlay + menu stay.
    const hudOnlyBtn = document.createElement('div');
    hudOnlyBtn.id = 'hud-only-btn';
    hudOnlyBtn.className = 'menu-action' + (this.getHudOnly() ? ' on' : '');
    hudOnlyBtn.textContent = 'Show HUD only';
    hudOnlyBtn.title = 'Hide the 3D view and keep the overlay web HUD for layout preview';
    hudOnlyBtn.addEventListener('click', () => {
      this.setHudOnly(!this.getHudOnly());
    });
    div.appendChild(hudOnlyBtn);

    return div;
  }

  _buildShotsTab() {
    const div = document.createElement('div');
    div.className = 'tab-content' + (this._activeTab === 'shots' ? ' active' : '');
    div.dataset.tab = 'shots';

    // Exact shot toggle
    const exactBtn = document.createElement('div');
    exactBtn.id = 'exact-shot-btn';
    exactBtn.className = 'menu-action';
    exactBtn.textContent = this._exactShotMode ? 'Exact Shot: On (K)' : 'Exact Shot: Off (K)';
    if (this._exactShotMode) exactBtn.style.color = '#0ff';
    exactBtn.addEventListener('click', () => this._toggleExactShot());
    div.appendChild(exactBtn);

    const sep = document.createElement('div');
    sep.className = 'menu-separator';
    div.appendChild(sep);

    // Fire test shot
    const shotBtn = document.createElement('div');
    shotBtn.className = 'menu-action';
    shotBtn.textContent = 'Fire Test Shot (Space)';
    shotBtn.style.color = '#fa0';
    shotBtn.addEventListener('click', () => this._fireTestShot());
    div.appendChild(shotBtn);

    // Clear shots — scene tracers + IndexedDB history (so reload stays clean)
    const clearBtn = document.createElement('div');
    clearBtn.className = 'menu-action';
    clearBtn.textContent = 'Clear Shots';
    clearBtn.addEventListener('click', () => { this.clearShots(); });
    div.appendChild(clearBtn);

    const swingSep = document.createElement('div');
    swingSep.className = 'menu-separator';
    div.appendChild(swingSep);

    if (!this.hasAttribute('embed')) {
      if (!this._phoneSwingHost) this._phoneSwingHost = createPhoneSwingHost(this);
      this._phoneSwingHost.mount(div);
    }

    // Club selector
    const clubSep = document.createElement('div');
    clubSep.className = 'menu-separator';
    div.appendChild(clubSep);

    const clubLabel = document.createElement('div');
    clubLabel.className = 'club-section-label';
    clubLabel.textContent = 'Club';
    div.appendChild(clubLabel);

    const clubList = document.createElement('div');
    clubList.className = 'club-list';

    for (const club of this._clubs) {
      const item = document.createElement('div');
      item.className = 'club-item' + (club.id === this._selectedClubId ? ' selected' : '');
      item.dataset.clubId = club.id;

      const nameSpan = document.createElement('span');
      nameSpan.textContent = club.label;

      const distSpan = document.createElement('span');
      distSpan.className = 'club-distance';
      distSpan.textContent = `${club.carry}m`;

      item.appendChild(nameSpan);
      item.appendChild(distSpan);

      item.addEventListener('click', () => {
        // Menu pick sticks until rest / tee change so Fire / Exact Shot
        // launch this club even on green/fringe (instead of auto-putter).
        this._clubManualOverride = true;
        this._setSelectedClubId(club.id);
      });

      clubList.appendChild(item);
    }

    div.appendChild(clubList);

    // Scroll selected club into view after render
    requestAnimationFrame(() => {
      const sel = clubList.querySelector('.club-item.selected');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    });

    return div;
  }

  _selectPosition(pos) {
    this._selectedPosition = pos;
    this._clearTracers();
    this._cancelAutoAim();

    // Aim overrides / sticky green are meaningful only for the hole we set
    // them on — clear when the position changes so the camera reverts to
    // flag/waypoint aim. Fires aimchange(null) so HUD listeners (minimap)
    // can remove their aim marker.
    this._doglegPreferPin = false;
    if (this._aimTarget) {
      this._aimTarget = null;
      document.dispatchEvent(new CustomEvent('golf:aimchange', { detail: null }));
    }

    // Update UI highlight. Scope to position rows (`[data-id]`) so the scene
    // rows in the Places tab (which carry `[data-scene-name]` instead) keep
    // their own active state intact.
    const items = this.shadowRoot.querySelectorAll('.menu-item[data-id]');
    items.forEach(item => {
      item.classList.toggle('active', item.dataset.id === pos.id);
    });

    const origin = new THREE.Vector3(...pos.origin);
    const hasCalibratedPose = !!(pos.cameraPosition && pos.cameraTarget);

    if (hasCalibratedPose) {
      // Use exact saved camera pose from calibration — calibrated poses win
      // over auto-aim so hand-tuned framings are preserved.
      this._camera.position.set(...pos.cameraPosition);
      this._controls.target.set(...pos.cameraTarget);
    } else {
      // Fallback: compute from behindBallOffset + forward direction
      const camCfg = this._config.camera;
      const offset = new THREE.Vector3(...camCfg.behindBallOffset);
      const forward = new THREE.Vector3(...pos.forward).normalize();
      const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
      const up = new THREE.Vector3(0, 1, 0);

      this._camera.position.copy(origin)
        .add(right.clone().multiplyScalar(offset.x))
        .add(up.clone().multiplyScalar(offset.y))
        .add(forward.clone().multiplyScalar(offset.z));
      this._controls.target.copy(origin);
    }

    this._controls.update();
    this._saveSetting(this._lastPositionStorageKey(), pos.id);

    // Set live origin/forward and place tee ball
    this._currentOrigin = origin.clone();
    this._ballHoled = false;
    this._syncCupCapture();
    this._currentForward = new THREE.Vector3(...pos.forward).normalize();
    this._placeTeeBall(origin);
    this._refreshStaticShadows(origin);

    // Reset camera mode override so position default takes effect
    this._cameraMode = null;
    this._buildMenu();

    // New tee / position → fresh club suggestion (drop any prior manual pick).
    this._clubManualOverride = false;

    // Auto-aim the camera at the current flag when enabled (and there's no
    // calibrated pose to respect). Snap rather than animate — the position
    // just changed, so there's no prior pose worth lerping from.
    if (!hasCalibratedPose) {
      this._aimCameraAtFlag({ origin, animate: false });
    } else {
      // Calibrated pose: skip the camera swing but still update the bag —
      // ball origin just changed so the stored club may no longer fit.
      this._runAutoClubSuggest();
    }

    this._log(`Position selected: ${pos.label}`);
  }

  // ── Ground Height ─────────────────────────────────────────────────────────

  /**
   * Raycast root for ground sampling: the active scene subtree when the GLB
   * holds several scenes, else the whole model.
   *
   * Three's raycaster does NOT skip `visible === false` objects, so casting
   * against `_glbModel` also hits hidden holes. Their terrain can sit metres
   * above the active one, which reports a bogus ground height and makes the
   * ball land, seat, and cast its shadow at the wrong Y. Mirrors the root the
   * surface/collider samplers are narrowed to in `_selectScene`.
   */
  _groundRoot() {
    if (this._activeSceneName && this._sceneList?.length) {
      const entry = this._sceneList.find((s) => s.name === this._activeSceneName);
      if (entry?.group) return entry.group;
    }
    return this._glbModel;
  }

  /**
   * Downward ground sample at (x, z).
   *
   * @param {number} x
   * @param {number} z
   * @param {number} [nearY] - When set (e.g. ball feet), return the highest
   *   ground hit at or below this Y. Needed for bunker/water overlays in a
   *   depression: a naive "first visualOnly" can miss the sand plane or pick
   *   a higher skin and seat the blob shadow on the lip/grass above the ball.
   */
  _getGroundHeight(x, z, nearY) {
    const root = this._groundRoot();
    if (!root) return 0;
    const origin = new THREE.Vector3(x, 500, z);
    const down = new THREE.Vector3(0, -1, 0);
    this._raycaster.set(origin, down);
    const hits = this._raycaster.intersectObject(root, true);
    if (!hits.length) return 0;

    const isGround = (h) => {
      const ud = h.object?.userData || {};
      return !!(ud.visualOnly || ud.surface || ud.surfaceTable);
    };
    const groundHits = hits.filter(isGround);
    const pool = groundHits.length ? groundHits : hits;

    if (Number.isFinite(nearY)) {
      // Hits are nearest-first (highest first). First hit still under the ball
      // is the support surface the blob/shadow should sit on.
      const slack = 0.2;
      const support = pool.find((h) => h.point.y <= nearY + slack);
      if (support) return support.point.y;
    }

    // Default: visible skin when present, else topmost hit.
    const skin = pool.find((h) => h.object?.userData?.visualOnly);
    return (skin || pool[0]).point.y;
  }

  /**
   * Raise `pos.y` so the follow camera never dips below the visible surface
   * beneath it (e.g. a chip launch or a landing on a steep upslope). Mutates
   * and returns the passed vector. No-ops when there's no GLB to sample
   * against (`_getGroundHeight` returns 0 in that case).
   */
  _clampCameraAboveGround(pos) {
    if (!this._glbModel) return pos;
    const clearance = this._config.camera.followGroundClearance ?? 1.5;
    const groundY = this._getGroundHeight(pos.x, pos.z);
    if (Number.isFinite(groundY)) {
      pos.y = Math.max(pos.y, groundY + clearance);
    }
    return pos;
  }

  // ── Camera Mode ────────────────────────────────────────────────────────────

  _getEffectiveCameraMode() {
    if (this._cameraMode) return this._cameraMode;
    // Default from position config, then global config
    if (this._selectedPosition && this._selectedPosition.followShot !== undefined) {
      return this._selectedPosition.followShot ? 'follow' : 'static';
    }
    return this._config.camera.followShot ? 'follow' : 'static';
  }

  _toggleCameraMode() {
    const current = this._getEffectiveCameraMode();
    this._cameraMode = current === 'static' ? 'follow' : 'static';
    this._buildMenu();
    this._log(`Camera mode: ${this._cameraMode}`);
  }

  // Free fly — a transient third camera mode. Enter: remember the mode we
  // were in, set `_cameraMode = 'freefly'` so none of the follow/static
  // branches in _update* fire (they gate on equality with 'follow', not
  // inequality), and leave OrbitControls + WASD/Q/E free. Exit: restore the
  // previous mode. Called from the Shortcuts button, the Camera-tab radio,
  // the F key, and automatically from the shot-firing path.
  _toggleFreeFly() {
    if (this._cameraMode === 'freefly') {
      this._cameraMode = this._preFreeFlyMode || null;
      this._preFreeFlyMode = null;
      this._log('Free fly: off');
    } else {
      this._preFreeFlyMode = this._cameraMode || this._getEffectiveCameraMode();
      this._cameraMode = 'freefly';
      this._log('Free fly: on');
    }
    this._buildMenu();
  }

  // ── Auto-Aim at Flag ───────────────────────────────────────────────────────

  /**
   * Drop any pending / in-flight auto-aim transition. Called from the
   * OrbitControls 'start' hook (user drag), when a new shot fires, and when
   * the user explicitly selects a different position.
   */
  _cancelAutoAim() {
    if (this._autoAimPending) this._autoAimPending = false;
    this._restIdleTimer = 0;
    if (this._cameraTransition && this._cameraTransition._isAutoAim) {
      this._cameraTransition = null;
    }
  }

  /**
   * Frame the current hole's flag from an "over-the-shoulder" position: camera
   * is placed behind the ball along the ball→flag horizontal line, slightly
   * elevated, looking at the ball. Because camera, ball, and flag are colinear
   * on XZ, the pin stays visible just past the ball.
   *
   * Opts:
   *   origin   THREE.Vector3  — anchor point (defaults to current ball origin).
   *   animate  boolean        — true (default) lerps via _cameraTransition;
   *                             false snaps immediately.
   *
   * No-op if autoAimAtFlag is disabled, no flag exists for the active hole,
   * or the ball sits directly on top of the flag.
   */
  _aimCameraAtFlag(opts = {}) {
    if (!this._config || !this._config.camera.autoAimAtFlag) {
      // Camera auto-aim is disabled, but the bag-auto-select policy is
      // independent — still re-evaluate the club against the current
      // target so the suggestion tracks position/origin changes.
      this._runAutoClubSuggest();
      return;
    }

    // Aim override → flag → first waypoint. On Range with none of those, a
    // point downrange along the shot forward keeps practice framing useful.
    let target = this._resolveDefaultAimTarget();
    if (!target && this._activeSceneIsRange && this._currentForward) {
      const origin = (opts.origin && opts.origin.clone())
        || (this._currentOrigin && this._currentOrigin.clone());
      if (origin) {
        target = origin.clone().add(
          this._currentForward.clone().setY(0).normalize().multiplyScalar(150)
        );
      }
    }
    if (!target) return;
    // Keep the shot axis aligned with whatever we framed (pin or waypoint).
    this._rotateForwardToward(target);
    this._aimCameraAtTargetXZ(target, opts);
    this._runAutoClubSuggest();
  }

  /**
   * Core camera-aim routine: swing the main camera to sit behind the ball
   * along the ball→target horizontal line, slightly elevated, looking at
   * the ball. Always runs — not gated by `autoAimAtFlag` — because explicit
   * user intent (e.g. click-to-aim) must take precedence over the auto-aim
   * config toggle.
   *
   * @param {THREE.Vector3 | {x:number, z:number}} target — world-space target.
   * @param {object} [opts]
   * @param {THREE.Vector3} [opts.origin]   — anchor point (defaults to ball).
   * @param {boolean}      [opts.animate=true] — lerp vs snap.
   */
  _aimCameraAtTargetXZ(target, opts = {}) {
    if (!target) return;
    if (!this._config) return;

    const origin = (opts.origin && opts.origin.clone())
      || (this._currentOrigin && this._currentOrigin.clone())
      || this._camera.position.clone();

    const dir = new THREE.Vector3(target.x - origin.x, 0, target.z - origin.z);
    if (dir.lengthSq() < 1e-4) return; // ball is on the target — nothing to aim at
    dir.normalize();

    const camCfg = this._config.camera;
    const behindDist = camCfg.autoAimBehindDist ?? 12;
    const aboveHeight = camCfg.autoAimAboveHeight ?? 4;
    const targetHeight = camCfg.autoAimTargetHeight ?? 0;

    const toPos = origin.clone()
      .addScaledVector(dir, -behindDist)
      .add(new THREE.Vector3(0, aboveHeight, 0));
    // Raise the look-at above the ball so the camera tilts upward and tall
    // shot trajectories stay in frame rather than clipping at the top.
    const toTarget = origin.clone().add(new THREE.Vector3(0, targetHeight, 0));

    if (opts.animate === false) {
      this._camera.position.copy(toPos);
      this._controls.target.copy(toTarget);
      this._controls.update();
      return;
    }

    this._cameraTransition = {
      from: this._camera.position.clone(),
      to: toPos,
      fromTarget: this._controls.target.clone(),
      toTarget,
      elapsed: 0,
      duration: camCfg.transitionDuration,
      _isAutoAim: true,
    };
  }

  // ── Tee Ball ───────────────────────────────────────────────────────────────

  /**
   * Place the static ball used between shots.
   * @param {THREE.Vector3} origin
   * @param {{ exact?: boolean }} [opts] - When `exact` is true, `origin` is
   *   already a ball-center pose (physics rest) — do not re-raycast. Re-seating
   *   after bunker/water overlays can pick a different visualOnly skin (e.g.
   *   fairway lip vs sand plane) and looks like a post-rest hop.
   */
  _placeTeeBall(origin, opts = {}) {
    // Remove old tee ball
    if (this._teeBall) {
      this._scene.remove(this._teeBall);
      this._teeBall.geometry.dispose();
      this._teeBall.material.dispose();
      this._teeBall = null;
    }

    const radius = this._config.ball.radius;
    const geo = new THREE.SphereGeometry(radius, 16, 12);
    const mat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    this._teeBall = new THREE.Mesh(geo, mat);
    if (opts.exact) {
      this._teeBall.position.copy(origin);
    } else {
      // Seat on the visible surface: a stored tee origin sits at its node pivot
      // (often y≈0), but the sculpted skin can be well above/below that. Raycast
      // the ground so the ball never sinks into (or floats over) what's drawn.
      const groundY = this._getGroundHeight(origin.x, origin.z);
      const seatY = Number.isFinite(groundY) ? groundY : origin.y;
      this._teeBall.position.set(origin.x, seatY + radius, origin.z);
    }
    this._scene.add(this._teeBall);
    this._invalidateBallShadowGroundCache();
    this.requestRender();
  }

  // ── Event Binding ─────────────────────────────────────────────────────────

  _bindEvents() {
    if (!this.hasAttribute('embed')) {
      document.addEventListener('trackman:measurement', this._onMeasurement);
      document.addEventListener('keydown', this._onKeyDown);
      document.addEventListener('keyup', this._onKeyUp);
    }
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    window.addEventListener('resize', this._onResize);
  }

  _handleVisibilityChange() {
    if (document.hidden) {
      if (this._animFrameId) {
        cancelAnimationFrame(this._animFrameId);
        this._animFrameId = null;
      }
      // Clock keeps ticking while hidden — drop the huge delta on resume.
      this._discardNextDelta = true;
      return;
    }
    this.requestRender();
  }

  _handleKeyDown(e) {
    if (!this._config) return;

    const key = e.key.toLowerCase();

    // Toggle menu with M
    if (key === 'm') {
      const panel = this.shadowRoot.getElementById('menu-panel');
      panel.classList.toggle('visible');
      this.requestRender();
      return;
    }

    // Reset camera to position default
    if (key === 'r') {
      if (this._selectedPosition) {
        this._selectPosition(this._selectedPosition);
        this._log('Camera reset to position');
      }
      return;
    }

    // Toggle exact shot with K
    if (key === 'k') {
      this._toggleExactShot();
      this.requestRender();
      return;
    }

    // Fire test shot with Space
    if (e.key === ' ') {
      this._fireTestShot();
      e.preventDefault();
      return;
    }

    // Toggle fullscreen with F
    if (key === 'f' && !e.shiftKey) {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
      this.requestRender();
      return;
    }

    // Toggle free fly with Shift+F
    if (key === 'f' && e.shiftKey) {
      this._toggleFreeFly();
      this.requestRender();
      return;
    }

    // Movement keys
    const moveKeys = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'q', 'e'];
    if (moveKeys.includes(key)) {
      this._keysPressed.add(key);
      e.preventDefault();
      this.requestRender();
    }
  }

  _handleKeyUp(e) {
    this._keysPressed.delete(e.key.toLowerCase());
    // One more frame so damping / last pose settle after WASD release.
    this.requestRender();
  }

  _handleResize() {
    const container = this.shadowRoot.getElementById('container');
    if (!container || !this._renderer) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
    this._renderer.setSize(w, h);
    this.requestRender();
  }

  // ── Measurement Handling ──────────────────────────────────────────────────

  _handleMeasurement(e) {
    const detail = e.detail || {};
    const shotId = detail.Id || detail.MeasurementId || null;
    this._log(`Measurement received: id=${shotId} isNew=${detail._isNewShot} carry=${detail.Carry} maxH=${detail.MaxHeight} hasBallTraj=${!!(detail.BallTrajectory)}`);

    // Accept if it's a new shot, OR if we haven't rendered this shot ID yet (late join)
    const isNew = detail._isNewShot || (shotId && shotId !== this._lastRenderedShotId);
    if (!isNew) {
      this._log(`Skipping refinement for ${shotId}`);
      return;
    }

    const measurementMode = detail._measurementMode || detail.MeasurementMode;
    const isPuttingMeasurement =
      measurementMode === 'Golf.SimulatorPutting' ||
      measurementMode === 'Golf.PerformancePutting';
    const puttBallSpeed = Number(detail.BallSpeed ?? detail.LaunchData?.BallSpeed);
    const puttLaunchDirection = Number(
      detail.LaunchDirection ?? detail.LaunchData?.LaunchDirection ?? 0
    );
    // TM4 putting modes send launch-only first (BallSpeed + LaunchDirection),
    // then refine with a Kind:"Roll" polynomial. Only the launch values are
    // used: the Roll fit measures the physical hitting mat, which is 2-4x
    // slower than the virtual green and would cut putts short.
    if (isPuttingMeasurement && Number.isFinite(puttBallSpeed) && puttBallSpeed > 0) {
      const started = this._startPuttRoll(null, {
        speed: puttBallSpeed,
        launchDirection: Number.isFinite(puttLaunchDirection) ? puttLaunchDirection : 0,
      });
      if (started) {
        this._lastRenderedShotId = shotId;
        this._log(
          `Live putt started: speed=${puttBallSpeed.toFixed(2)}m/s ` +
          `dir=${puttLaunchDirection.toFixed(1)}°`
        );
      }
      return;
    }

    const points = this._extractTrajectoryPoints(detail);
    if (!points || points.length < 2) {
      this._log('Warning: no valid trajectory data — skipping shot. Keys: ' + Object.keys(detail).join(', '));
      return;
    }

    this._lastRenderedShotId = shotId;
    this._log(`Shot trajectory: ${points.length} points, hangTime=${detail.HangTime}`);
    const worldPoints = this._transformToWorld(points);
    const spin = this._extractSpinScalar(detail);
    this._addTracer(worldPoints, detail.HangTime || 5, spin);
  }

  /**
   * Convert radar spin to a signed scalar for the physics simulator.
   *
   * Radar reports `SpinRate` (rpm, magnitude) and `SpinAxis` (degrees; 0° = pure
   * backspin, 180° = pure topspin, 90°/270° = pure sidespin). v1 physics only
   * consumes a signed scalar (positive = topspin, negative = backspin). Side
   * components are dropped until v2.
   *
   *   spin = (rpm / 60) · (-cos(axisDeg)) rev/s
   *
   *     axis=0°   → -rpm/60  (backspin)     — "check up on greens"
   *     axis=180° → +rpm/60  (topspin)      — "runs out through fairway"
   *     axis=90°  →  0                        — pure sidespin ignored
   */
  _extractSpinScalar(detail) {
    const rpm = Number(detail?.SpinRate);
    if (!Number.isFinite(rpm) || rpm === 0) return 0;
    const axisDeg = Number(detail?.SpinAxis) || 0;
    const cosAxis = Math.cos(axisDeg * Math.PI / 180);
    return -(rpm / 60) * cosAxis;
  }

  // ── Trajectory Extraction ─────────────────────────────────────────────────

  _extractTrajectoryPoints(payload) {
    // Try BallTrajectory polynomial first
    const trajectory = payload.BallTrajectory;
    if (trajectory && Array.isArray(trajectory)) {
      const flight = trajectory.find(seg => seg.Kind === 'Flight');
      if (flight && flight.XFit && flight.YFit && flight.ZFit && flight.ValidTimeInterval) {
        return this._samplePolynomial(flight);
      }
    }

    // Fallback: compute parabolic arc from summary fields
    return this._computeFallbackArc(payload);
  }

  _samplePolynomial(segment) {
    const segments = this._config.tracer.segments;
    const [t0, t1] = segment.ValidTimeInterval;
    const points = [];

    for (let i = 0; i < segments; i++) {
      const t = t0 + (i / (segments - 1)) * (t1 - t0);
      points.push(new THREE.Vector3(
        evalPoly(segment.XFit, t),
        evalPoly(segment.YFit, t),
        evalPoly(segment.ZFit, t)
      ));
    }
    return points;
  }

  _computeFallbackArc(payload) {
    const carry = payload.Carry;
    const maxHeight = payload.MaxHeight;
    const launchDir = payload.LaunchDirection || 0;
    const curveFactor = payload.CurveFactor || 0;

    if (!carry || !maxHeight) return null;

    const segments = this._config.tracer.segments;
    const dirRad = (launchDir * Math.PI) / 180;
    const points = [];

    for (let i = 0; i < segments; i++) {
      const t = i / (segments - 1);
      const x = carry * t;
      const y = 4 * maxHeight * t * (1 - t);
      const z = carry * Math.tan(dirRad) * t + curveFactor * carry * t * t;
      points.push(new THREE.Vector3(x, y, z));
    }
    return points;
  }

  // ── Coordinate Transform ──────────────────────────────────────────────────

  _transformToWorld(points) {
    if (!this._selectedPosition) return points;

    const origin = this._currentOrigin || new THREE.Vector3(...this._selectedPosition.origin);
    const forward = this._currentForward || new THREE.Vector3(...this._selectedPosition.forward).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(forward, up).normalize();

    return points.map(p => {
      return origin.clone()
        .add(forward.clone().multiplyScalar(p.x))
        .add(up.clone().multiplyScalar(p.y))
        .add(right.clone().multiplyScalar(p.z));
    });
  }

  // ── Tracer Rendering ──────────────────────────────────────────────────────

  /**
   * Walk the scripted flight path segment-by-segment and return the first
   * intersection with a solid collider, or `null` if the arc is clear.
   *
   * The flight phase is a pre-baked polyline (not a physics integration), so
   * without this pre-scan a ball aimed at a wall would tunnel straight
   * through it during animation. Running a per-segment raycast against the
   * collider sampler catches the hit before playback starts.
   *
   * On hit, returns `{ truncatedPoints, truncatedHangTime, handoff }`:
   *   - truncatedPoints: the flight polyline cut to the segment that hits,
   *     with the final point replaced by a pre-impact position pulled back
   *     one ballRadius along the inbound direction (so the simulator's first
   *     sub-step has clearance to detect the contact cleanly).
   *   - truncatedHangTime: proportionally scaled so the animation duration
   *     matches the shortened arc.
   *   - handoff: `{ position, velocity }` passed through to the ball
   *     animation and used at progress=1 to spawn the simulator AIRBORNE at
   *     the intercept point with the pre-impact velocity. The simulator's
   *     own forward-swept collider test then reflects the ball via its
   *     shared `_collide()` contact resolver — no duplicated physics here.
   *
   * No-op when no collider sampler is wired or the scene has no colliders.
   */
  _preScanFlightForColliders(worldPoints, hangTime) {
    if (!this._colliderSampler || this._colliderSampler.count === 0) return null;
    if (!worldPoints || worldPoints.length < 2) return null;

    const ballRadius = this._config.ball.radius;
    const scratchDir = new THREE.Vector3();

    for (let i = 0; i < worldPoints.length - 1; i++) {
      const a = worldPoints[i];
      const b = worldPoints[i + 1];
      scratchDir.subVectors(b, a);
      const segLen = scratchDir.length();
      if (segLen < 1e-6) continue;
      scratchDir.multiplyScalar(1 / segLen);

      // Sweep `from=a` along `dir` for the segment length plus one ball
      // radius so we don't miss a wall whose face sits just past b.
      const hit = this._colliderSampler.sweptTest(a, scratchDir, segLen + ballRadius, ballRadius);
      if (!hit) continue;

      // Pull back from the exact hit point by one ballRadius along the
      // inbound direction so the ball hasn't penetrated the wall at handoff.
      const pullback = hit.distance - ballRadius;
      const safeT = Math.max(0, pullback) / segLen;

      // Position at handoff: along the segment.
      const handoffPos = new THREE.Vector3(
        a.x + (b.x - a.x) * safeT,
        a.y + (b.y - a.y) * safeT,
        a.z + (b.z - a.z) * safeT
      );

      // Velocity at handoff: derived from the segment's spatial delta over
      // its share of total hangTime. The polyline is uniformly sampled in
      // time by the ballistic-arc generator (see _computeFallbackArc), so
      // every segment covers an equal 1/N fraction of the flight.
      const segmentCount = worldPoints.length - 1;
      const sliceSeconds = Math.max(1e-3, hangTime / segmentCount);
      const handoffVel = new THREE.Vector3(
        (b.x - a.x) / sliceSeconds,
        (b.y - a.y) / sliceSeconds,
        (b.z - a.z) / sliceSeconds
      );

      // Truncate the polyline so the ball animation visibly stops at the wall.
      const truncatedPoints = worldPoints.slice(0, i + 1);
      truncatedPoints.push(handoffPos);

      // Scale hangTime by the fraction of flight that actually plays.
      const playedFraction = (i + safeT) / segmentCount;
      const truncatedHangTime = hangTime * Math.max(0.05, playedFraction);

      return {
        truncatedPoints,
        truncatedHangTime,
        handoff: { position: handoffPos, velocity: handoffVel, collider: hit.collider }
      };
    }

    return null;
  }

  /**
   * Walk the scripted flight path and find where the ball centre first meets
   * the terrain (groundY + ballRadius). The baked parabola is tee-relative and
   * ignores hills, so without this the end-of-flight handoff used to teleport
   * Y onto the surface and immediately run a full restitution bounce — an
   * extra non-physical bump.
   *
   * Mirrors `_preScanFlightForColliders`: truncate the polyline, scale
   * hangTime, and return a handoff just *above* contact with segment velocity
   * so the simulator's first airborne step falls into contact once.
   *
   * Returns `null` when the arc never reaches the ground (downhill — the
   * curve ends above terrain and the sim can fall naturally).
   */
  _preScanFlightForTerrain(worldPoints, hangTime) {
    // Use the physics sampler, not `_getGroundHeight`: the latter returns 0
    // (not null) when the ray misses, which reads as "ground at sea level" and
    // would truncate the flight at launch.
    const sampler = this._surfaceSampler;
    if (!sampler) return null;
    if (!worldPoints || worldPoints.length < 2) return null;

    const ballRadius = this._config.ball.radius;
    /** Keep handoff slightly above contact so the first sim step detects it. */
    const CLEARANCE_EPS = 0.02;
    const segmentCount = worldPoints.length - 1;

    const groundAt = (x, z) => {
      const hit = sampler.sampleAt(x, z, 300);
      return hit ? hit.point.y : null;
    };

    let groundA = groundAt(worldPoints[0].x, worldPoints[0].z);

    for (let i = 0; i < segmentCount; i++) {
      const a = worldPoints[i];
      const b = worldPoints[i + 1];
      const groundB = groundAt(b.x, b.z);

      // Only a descending segment can be the landing. Skipping ascending ones
      // keeps the launch intact — at the tee the ball already sits one radius
      // above ground, so an equality test there would truncate immediately.
      const descending = b.y < a.y;
      const crosses = descending
        && groundA != null && groundB != null
        && a.y > groundA + ballRadius
        && b.y <= groundB + ballRadius;

      if (!crosses) {
        groundA = groundB;
        continue;
      }

      // Refine t along the segment where the ball centre meets clearance.
      let tLo = 0;
      let tHi = 1;
      for (let iter = 0; iter < 6; iter++) {
        const tMid = 0.5 * (tLo + tHi);
        const mx = a.x + (b.x - a.x) * tMid;
        const my = a.y + (b.y - a.y) * tMid;
        const mz = a.z + (b.z - a.z) * tMid;
        const g = groundAt(mx, mz);
        if (g == null) { tHi = tMid; continue; }
        if (my > g + ballRadius) tLo = tMid;
        else tHi = tMid;
      }
      let t = 0.5 * (tLo + tHi);

      // Pull back along the inbound segment so we spawn just above contact.
      const segLen = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      if (segLen > 1e-6) {
        t = Math.max(0, t - CLEARANCE_EPS / segLen);
      }

      const handoffPos = new THREE.Vector3(
        a.x + (b.x - a.x) * t,
        a.y + (b.y - a.y) * t,
        a.z + (b.z - a.z) * t
      );
      const gH = groundAt(handoffPos.x, handoffPos.z);
      if (gH != null) {
        const minY = gH + ballRadius + CLEARANCE_EPS;
        if (handoffPos.y < minY) handoffPos.y = minY;
      }

      const sliceSeconds = Math.max(1e-3, hangTime / segmentCount);
      const handoffVel = new THREE.Vector3(
        (b.x - a.x) / sliceSeconds,
        (b.y - a.y) / sliceSeconds,
        (b.z - a.z) / sliceSeconds
      );

      const truncatedPoints = worldPoints.slice(0, i + 1);
      truncatedPoints.push(handoffPos.clone());
      const playedFraction = (i + t) / segmentCount;
      const truncatedHangTime = hangTime * Math.max(0.05, playedFraction);

      return {
        truncatedPoints,
        truncatedHangTime,
        handoff: { position: handoffPos, velocity: handoffVel }
      };
    }

    return null;
  }

  _addTracer(worldPoints, hangTime, spin = 0) {
    // Real radar shots route through here; test shots also land here after
    // `_fireTestShot` dispatches a synthetic `trackman:measurement`. Exit
    // free fly the moment a shot starts so the follow/static camera takes
    // over for the flight.
    if (this._cameraMode === 'freefly') this._toggleFreeFly();

    const cfg = this._config.tracer;
    const isFollow = this._getEffectiveCameraMode() === 'follow';

    // Pre-scan the scripted flight path for solid-collider intersections. The
    // flight phase is a baked parabola (no physics step), so a ball flying
    // straight at a wall would tunnel through it unless we catch the
    // collision here. If an intercept is found, truncate the flight at the
    // hit, shrink hangTime proportionally, and stash a handoff marker the
    // ball-animation end-of-flight branch uses to spawn the simulator with
    // the correct pre-impact position + velocity instead of the normal
    // ground-landing handoff.
    //
    // No-op when no collider sampler is wired (pre-GLB or host disabled it)
    // or when the trajectory has no segment that intersects a collider.
    //
    // When the arc is clear of walls, pre-scan terrain next: the tee-relative
    // parabola often meets hills mid-flight. Truncating there avoids a Y-snap
    // + immediate bounce at progress=1 (the "extra bump"). Collider wins if
    // both would truncate — walls take priority over ground.
    let flightColliderHandoff = null;
    const intercept = this._preScanFlightForColliders(worldPoints, hangTime);
    if (intercept) {
      worldPoints = intercept.truncatedPoints;
      hangTime = intercept.truncatedHangTime;
      flightColliderHandoff = intercept.handoff;
    } else {
      const terrain = this._preScanFlightForTerrain(worldPoints, hangTime);
      if (terrain) {
        worldPoints = terrain.truncatedPoints;
        hangTime = terrain.truncatedHangTime;
        flightColliderHandoff = terrain.handoff;
      }
    }

    // Cache the most recent sampled trajectory so consumers (e.g. the
    // minimap) can query it after mount / on demand.
    this._lastTrajectoryPoints = worldPoints;

    // Publish a high-level event with world-space points. The raw
    // `trackman:measurement` payload contains polynomial fits that aren't
    // directly plottable; this event gives overlays a ready-to-render array.
    this.dispatchEvent(new CustomEvent('golf:trajectory', {
      bubbles: true,
      composed: true,
      detail: { points: worldPoints, hangTime, spin },
    }));

    // In follow mode: no tracer, just animate the ball
    if (isFollow) {
      const curve = new THREE.CatmullRomCurve3(worldPoints);
      this._startBallAnimation(curve, hangTime, null, cfg, spin, flightColliderHandoff);
      return;
    }

    // Static mode: build tracer ribbon
    // FIFO: remove oldest if at max
    while (this._tracers.length >= cfg.maxShots) {
      const oldest = this._tracers.shift();
      this._scene.remove(oldest.group);
      oldest.group.traverse(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
    }

    const group = new THREE.Group();
    const curve = new THREE.CatmullRomCurve3(worldPoints);

    // Build ribbon with all vertices collapsed to start — revealed progressively
    const ribbon = this._buildRibbon(curve, cfg, true);
    group.add(ribbon);
    this._scene.add(group);

    const tracerEntry = { group, curve, points: worldPoints, ribbon };
    this._tracers.push(tracerEntry);

    // Start ball + tracer animation together
    this._startBallAnimation(curve, hangTime, ribbon, cfg, spin, flightColliderHandoff);
  }

  _buildRibbon(curve, cfg, collapsed) {
    const count = cfg.segments;
    const halfWidth = cfg.width / 2;
    const positions = new Float32Array(count * 2 * 3);
    const alphas = new Float32Array(count * 2);
    const indices = [];

    const curvePoints = curve.getPoints(count - 1);
    const startPoint = curvePoints[0];

    for (let i = 0; i < count; i++) {
      const p = collapsed ? startPoint : curvePoints[i];
      const t = i / (count - 1);

      const tangent = curve.getTangentAt(Math.min(t, 0.999));
      const up = new THREE.Vector3(0, 1, 0);
      const side = new THREE.Vector3().crossVectors(tangent, up).normalize().multiplyScalar(halfWidth);

      const i6 = i * 6;
      positions[i6]     = p.x - side.x;
      positions[i6 + 1] = p.y - side.y;
      positions[i6 + 2] = p.z - side.z;
      positions[i6 + 3] = p.x + side.x;
      positions[i6 + 4] = p.y + side.y;
      positions[i6 + 5] = p.z + side.z;

      // Fade only the first 10% of the arc, then full opacity
      let alpha;
      if (collapsed) {
        alpha = 0;
      } else if (cfg.fadeStart && t < 0.1) {
        alpha = cfg.opacity * (t / 0.1);
      } else {
        alpha = cfg.opacity;
      }
      alphas[i * 2] = alpha;
      alphas[i * 2 + 1] = alpha;
    }

    for (let i = 0; i < count - 1; i++) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices.push(a, b, c, b, d, c);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    // Store curve data on geometry for progressive reveal
    geometry.userData = { curve, curvePoints, count, halfWidth, cfg };

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uColor: { value: new THREE.Color(cfg.color) },
      },
      vertexShader: `
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(uColor, vAlpha);
        }
      `,
    });

    return new THREE.Mesh(geometry, material);
  }

  /** Reveal ribbon vertices up to the given progress (0–1) */
  _updateRibbonProgress(ribbon, progress) {
    const geo = ribbon.geometry;
    const { curve, curvePoints, count, halfWidth, cfg } = geo.userData;
    const posAttr = geo.getAttribute('position');
    const alphaAttr = geo.getAttribute('alpha');
    const revealedCount = Math.floor(progress * (count - 1)) + 1;

    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);

      if (i < revealedCount) {
        const p = curvePoints[i];
        const tangent = curve.getTangentAt(Math.min(t, 0.999));
        const up = new THREE.Vector3(0, 1, 0);
        const side = new THREE.Vector3().crossVectors(tangent, up).normalize().multiplyScalar(halfWidth);

        posAttr.setXYZ(i * 2,     p.x - side.x, p.y - side.y, p.z - side.z);
        posAttr.setXYZ(i * 2 + 1, p.x + side.x, p.y + side.y, p.z + side.z);

        const alpha = (cfg.fadeStart && t < 0.1) ? (cfg.opacity * (t / 0.1)) : cfg.opacity;
        alphaAttr.setX(i * 2, alpha);
        alphaAttr.setX(i * 2 + 1, alpha);
      } else {
        // Collapse unrevealed vertices to the last revealed point
        const lastP = curvePoints[revealedCount - 1];
        posAttr.setXYZ(i * 2,     lastP.x, lastP.y, lastP.z);
        posAttr.setXYZ(i * 2 + 1, lastP.x, lastP.y, lastP.z);
        alphaAttr.setX(i * 2, 0);
        alphaAttr.setX(i * 2 + 1, 0);
      }
    }

    posAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
  }

  // ── Ball Animation ────────────────────────────────────────────────────────

  _createComet() {
    const count = 28;
    const positions = new Float32Array(count * 2 * 3);
    const alphas = new Float32Array(count * 2);
    const indices = [];
    for (let i = 0; i < count - 1; i++) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices.push(a, b, c, b, d, c);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
    geometry.setIndex(indices);

    const color = (this._config?.comet?.color) || DEFAULTS.comet.color;
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uColor: { value: new THREE.Color(color) },
      },
      vertexShader: `
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(uColor, vAlpha);
        }
      `,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;

    return {
      mesh,
      history: [],
      elapsed: 0,
      count,
      _tmpA: new THREE.Vector3(),
      _tmpB: new THREE.Vector3(),
      _tmpC: new THREE.Vector3(),
      _tmpSide: new THREE.Vector3(),
      _tmpView: new THREE.Vector3(),
      _tmpUp: new THREE.Vector3(0, 1, 0),
    };
  }

  _disposeComet(ab) {
    if (!ab?.comet) return;
    const { mesh } = ab.comet;
    if (mesh) {
      if (mesh.parent) mesh.parent.remove(mesh);
      else if (this._scene) this._scene.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) mesh.material.dispose();
    }
    ab.comet = null;
  }

  _teardownActiveBall() {
    if (!this._activeBall) return;
    this._disposeComet(this._activeBall);
    this._scene.remove(this._activeBall.mesh);
    this._activeBall.mesh.geometry.dispose();
    this._activeBall.mesh.material.dispose();
    this._activeBall = null;
  }

  /**
   * Sample history at absolute time `t` (linear between stored points).
   * History is oldest→newest; returns null if empty.
   */
  _sampleCometHistory(history, t, out) {
    if (!history.length) return null;
    if (t <= history[0].t) {
      out.set(history[0].x, history[0].y, history[0].z);
      return out;
    }
    const last = history[history.length - 1];
    if (t >= last.t) {
      out.set(last.x, last.y, last.z);
      return out;
    }
    for (let i = 1; i < history.length; i++) {
      const a = history[i - 1];
      const b = history[i];
      if (t <= b.t) {
        const span = Math.max(b.t - a.t, 1e-6);
        const u = (t - a.t) / span;
        out.set(
          a.x + (b.x - a.x) * u,
          a.y + (b.y - a.y) * u,
          a.z + (b.z - a.z) * u,
        );
        return out;
      }
    }
    out.set(last.x, last.y, last.z);
    return out;
  }

  _updateComet(ab, dt) {
    const comet = ab?.comet;
    if (!comet || !ab.mesh) return;

    const cfg = this._config?.comet || DEFAULTS.comet;
    const trailTime = Math.max(0, Number(cfg.time) || 0);
    if (cfg.enabled === false || trailTime <= 0.001) {
      comet.mesh.visible = false;
      comet.history.length = 0;
      return;
    }

    comet.elapsed += dt;
    const pos = ab.mesh.position;
    const hist = comet.history;
    const last = hist.length ? hist[hist.length - 1] : null;
    // Keep a dense enough trail without unbounded growth on long rolls.
    if (!last || pos.distanceToSquared(comet._tmpA.set(last.x, last.y, last.z)) > 1e-6) {
      hist.push({ x: pos.x, y: pos.y, z: pos.z, t: comet.elapsed });
    } else {
      last.t = comet.elapsed;
      last.x = pos.x;
      last.y = pos.y;
      last.z = pos.z;
    }

    const cutoff = comet.elapsed - trailTime;
    while (hist.length > 1 && hist[0].t < cutoff) hist.shift();

    if (hist.length < 2) {
      comet.mesh.visible = false;
      return;
    }

    const geo = comet.mesh.geometry;
    const posAttr = geo.getAttribute('position');
    const alphaAttr = geo.getAttribute('alpha');
    const count = comet.count;
    // Head width matches ball diameter (half-width = radius).
    const ballR = Number(this._config?.ball?.radius);
    const halfMax = Number.isFinite(ballR) && ballR > 0 ? ballR : DEFAULTS.ball.radius;
    const now = comet.elapsed;
    const tipT = Math.max(hist[0].t, now - trailTime);

    for (let i = 0; i < count; i++) {
      // i=0 tip (oldest), i=count-1 head (ball)
      const u = i / (count - 1);
      const sampleT = tipT + (now - tipT) * u;
      const p = this._sampleCometHistory(hist, sampleT, comet._tmpA);

      // Tangent from neighboring samples along the trail.
      const tPrev = tipT + (now - tipT) * Math.max(0, (i - 1) / (count - 1));
      const tNext = tipT + (now - tipT) * Math.min(1, (i + 1) / (count - 1));
      this._sampleCometHistory(hist, tPrev, comet._tmpB);
      this._sampleCometHistory(hist, tNext, comet._tmpC);
      const tangent = comet._tmpC.sub(comet._tmpB);
      if (tangent.lengthSq() < 1e-10) tangent.set(0, 0, 1);
      else tangent.normalize();

      // Project camera right onto the plane perpendicular to the trail so the
      // ribbon keeps on-screen width even when the follow-cam looks along the path.
      comet._tmpView.setFromMatrixColumn(this._camera.matrixWorld, 0);
      const side = comet._tmpSide.copy(comet._tmpView)
        .addScaledVector(tangent, -comet._tmpView.dot(tangent));
      if (side.lengthSq() < 1e-10) side.crossVectors(comet._tmpUp, tangent);
      if (side.lengthSq() < 1e-10) side.set(1, 0, 0);
      else side.normalize();
      // Wider + opaquer at the ball; slim transparent tip at the end.
      const taper = u * u;
      const half = halfMax * taper;
      side.multiplyScalar(half);

      const i6 = i * 6;
      posAttr.array[i6]     = p.x - side.x;
      posAttr.array[i6 + 1] = p.y - side.y;
      posAttr.array[i6 + 2] = p.z - side.z;
      posAttr.array[i6 + 3] = p.x + side.x;
      posAttr.array[i6 + 4] = p.y + side.y;
      posAttr.array[i6 + 5] = p.z + side.z;

      const alpha = 0.95 * taper;
      alphaAttr.array[i * 2] = alpha;
      alphaAttr.array[i * 2 + 1] = alpha;
    }

    posAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
    geo.computeBoundingSphere();
    comet.mesh.visible = true;
  }

  _attachComet(ab) {
    if (!ab || ab.comet) return;
    ab.comet = this._createComet();
    this._scene.add(ab.comet.mesh);
  }

  _startBallAnimation(curve, hangTime, ribbon, tracerCfg, spin = 0, flightColliderHandoff = null) {
    // Remove previous ball if still animating
    this._teardownActiveBall();

    // A new shot supersedes any pending post-rest auto-aim. The follow-cam
    // logic below will take over the camera for the duration of flight+roll.
    this._cancelAutoAim();

    // Fresh shot → allow sensors (e.g. hole cup) to fire again this shot.
    if (this._triggerDetector) this._triggerDetector.resetHysteresis();
    this._ballHoled = false;
    this._restorePinFade(true);

    const ballCfg = this._config.ball;
    const geometry = new THREE.SphereGeometry(ballCfg.radius, 16, 12);
    const material = new THREE.MeshBasicMaterial({ color: ballCfg.color });
    const mesh = new THREE.Mesh(geometry, material);

    const startPoint = curve.getPointAt(0);
    mesh.position.copy(startPoint);
    this._scene.add(mesh);

    // Hide tee ball while shot is in flight
    if (this._teeBall) this._teeBall.visible = false;

    this._activeBall = {
      mesh,
      curve,
      ribbon: this._getEffectiveCameraMode() === 'follow' ? null : ribbon,
      phase: 'flight',
      progress: 0,
      // Consumed by the first render pass so the launch is drawn from the tee.
      startPending: true,
      duration: hangTime * ballCfg.animationSpeedMultiplier,
      hangTimeRaw: hangTime,           // real-world seconds — used to derive landing velocity
      spin,                             // signed rev/s — fed to simulator on handoff
      landingPos: null,
      rollDir: null,
      // When non-null, flight was truncated by a solid collider or by terrain
      // meeting (_preScanFlightForColliders / _preScanFlightForTerrain). The
      // progress=1 branch starts the simulator AIRBORNE at this pose with the
      // pre-impact velocity so the first contact is a single physics bounce —
      // not a Y-snap onto the surface.
      flightColliderHandoff,
      // Legacy hardcoded bounce fields — retained so any stale references don't
      // crash during transition; simulator path below supersedes them.
      bounceHeight: 0,
      rollDist: 0,
      comet: null,
    };
    this._attachComet(this._activeBall);
    this.requestRender();
  }

  // ── Camera Follow ─────────────────────────────────────────────────────────

  _startCameraFollow(worldPoints) {
    if (!this._selectedPosition) return;

    const followShot = this._selectedPosition.followShot !== undefined
      ? this._selectedPosition.followShot
      : this._config.camera.followShot;

    if (!followShot) return;

    const camCfg = this._config.camera;
    const origin = new THREE.Vector3(...this._selectedPosition.origin);
    const forward = new THREE.Vector3(...this._selectedPosition.forward).normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const offset = new THREE.Vector3(...camCfg.behindBallOffset);

    const targetPos = origin.clone()
      .add(right.clone().multiplyScalar(offset.x))
      .add(up.clone().multiplyScalar(offset.y))
      .add(forward.clone().multiplyScalar(offset.z));

    this._cameraTransition = {
      from: this._camera.position.clone(),
      to: targetPos,
      fromTarget: this._controls.target.clone(),
      toTarget: origin.clone(),
      elapsed: 0,
      duration: camCfg.transitionDuration,
    };
  }

  // ── Tracers Management ────────────────────────────────────────────────────

  _clearTracers() {
    for (const tracer of this._tracers) {
      this._scene.remove(tracer.group);
      tracer.group.traverse(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
    }
    this._tracers = [];

    this._teardownActiveBall();
  }

  // ── Session Restore ───────────────────────────────────────────────────────

  async _restoreShots() {
    const radar = document.querySelector('trackman-radar');
    if (!radar || typeof radar.getShots !== 'function') {
      this._updateStatusNote('No radar');
      this._log('No <trackman-radar> element found — running without radar');
      return;
    }

    if (this._config.tracer.restoreOnLoad === false) {
      this._log('Shot restore skipped (tracer.restoreOnLoad=false)');
      return;
    }

    try {
      const shots = await radar.getShots();
      this._log(`Found ${shots.length} shot(s) in IndexedDB`);
      const maxRestore = this._config.tracer.maxShots;
      const recent = shots.slice(0, maxRestore);
      let restored = 0;

      for (const shot of recent.reverse()) {
        const payload = shot.payload || shot;
        this._log(`Restore attempt: carry=${payload.Carry} maxH=${payload.MaxHeight} hasBallTraj=${!!(payload.BallTrajectory)} keys=${Object.keys(payload).join(',')}`);
        const points = this._extractTrajectoryPoints(payload);
        if (points && points.length >= 2) {
          const worldPoints = this._transformToWorld(points);
          this._addStaticTracer(worldPoints);
          restored++;
        } else {
          this._log('  → skipped (no valid trajectory)');
        }
      }

      if (restored > 0) {
        this._log(`Restored ${restored} shot(s) from history`);
      }
    } catch (err) {
      this._log(`Failed to restore shots: ${err.message}`);
    }
  }

  _addStaticTracer(worldPoints) {
    const cfg = this._config.tracer;

    while (this._tracers.length >= cfg.maxShots) {
      const oldest = this._tracers.shift();
      this._scene.remove(oldest.group);
      oldest.group.traverse(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
    }

    const group = new THREE.Group();
    const curve = new THREE.CatmullRomCurve3(worldPoints);
    const ribbon = this._buildRibbon(curve, cfg);
    group.add(ribbon);
    this._scene.add(group);

    this._tracers.push({ group, curve, points: worldPoints });
  }

  // ── Lie readout ─────────────────────────────────────────────────────────
  //
  // Shows the lie currently under the ball (same SurfaceSampler path physics
  // uses), throttled to a few times a second. Hint bar: Lie + Menu shortcut.

  _updateSurfaceReadout(dt) {
    this._surfaceReadoutTimer = (this._surfaceReadoutTimer || 0) + dt;
    if (this._surfaceReadoutTimer < 0.15) return;
    this._surfaceReadoutTimer = 0;

    const hint = this.shadowRoot && this.shadowRoot.getElementById('move-hint');
    if (!hint) return;

    let label = '—';
    const pos = this._activeBall ? this._activeBall.mesh.position : this._currentOrigin;
    if (pos && this._surfaceSampler) {
      const hit = this._surfaceSampler.sampleAt(pos.x, pos.z, 300);
      if (hit) {
        const parsed = parseMeshName(hit.object.name);
        const surfId = hit.surface ? hit.surface.id : null;
        // Single-mesh terrain nodes aren't zones — prefer the resolved lie id.
        const zone = parsed
          ? parsed.zoneId
          : (surfId && surfId !== 'unknown_firm_ground' ? surfId : (hit.object.name || 'unknown'));
        label = surfId && surfId !== zone ? `${zone} (${surfId})` : zone;
      } else {
        label = 'off-map';
      }
    }

    const next = `Lie: ${label} · Menu = M`;
    if (hint.textContent !== next) hint.textContent = next;
  }

  // ── Render Loop ───────────────────────────────────────────────────────────

  /**
   * True while something must keep stepping every frame (shot, camera tween,
   * WASD, auto-aim wait, pin fade, OrbitControls damping).
   */
  _isRenderBusy() {
    if (this._activeBall) return true;
    if (this._cameraTransition) return true;
    if (this._keysPressed.size > 0) return true;
    if (this._autoAimPending) return true;
    const o = this._pinFadeOpacity;
    if (o > 0.001 && o < 0.999) return true;
    return false;
  }

  _ensureRenderLoop() {
    if (this._animFrameId != null) return;
    if (document.hidden || this._hudOnly) return;
    // Restarting after a pause: clock kept ticking — drop the accumulated gap.
    // Mid-frame wakes (e.g. corridor dash calling requestRender) must keep dt.
    if (!this._inAnimateFrame) this._discardNextDelta = true;
    this._animFrameId = requestAnimationFrame(() => this._animateFrame());
  }

  _startRenderLoop() {
    this.requestRender();
  }

  _animateFrame() {
    this._animFrameId = null;
    this._inAnimateFrame = true;

    try {
      if (document.hidden || this._hudOnly) {
        this._needsRender = false;
        return;
      }

      if (!this._isRenderBusy() && !this._needsRender) return;

      // Clamp the frame delta. A backgrounded tab or a GC/asset hitch hands us
      // a delta of 100 ms — seconds, which would step the ball metres along its
      // arc in one frame (visible teleport, and the physics can tunnel through
      // terrain). Better to run a hitch slightly slow than to skip geometry.
      let dt = this._clock.getDelta();
      if (this._discardNextDelta) {
        this._discardNextDelta = false;
        dt = 0;
      }
      dt = Math.min(dt, MAX_FRAME_DT);

      this._needsRender = false;

    // Ball + tracer animation
    if (this._activeBall) {
      const ab = this._activeBall;
      const isFollow = this._getEffectiveCameraMode() === 'follow';
      // Draw the first frame at progress 0 so the arc starts on the tee. The
      // shot's own setup (curve, geometry, HUD, `golf:trajectory` listeners)
      // runs between two rendered frames, so charging that time to the first
      // step would launch the ball several metres downrange before it is
      // ever drawn — the start of the flight appears cropped.
      if (ab.startPending) ab.startPending = false;
      else ab.progress += dt / ab.duration;

      if (ab.phase === 'flight' && ab.progress >= 1) {
        // Flight phase done. Hand off to the surface-aware physics simulator
        // (src/physics/bounce-roll.js) for the terminal bounce & roll phase.
        // See PRD §4 & §8 for the handoff contract.
        //
        // Handoff paths:
        //   A) Pre-scan handoff — collider wall or terrain crossing
        //      (_preScanFlightForColliders / _preScanFlightForTerrain).
        //      Start AIRBORNE just above contact with segment velocity.
        //   B) Fallback — arc never met the ground (e.g. downhill). Keep
        //      the curve end Y; only lift if still penetrating so the first
        //      sim step falls into contact once (no on-surface seat snap).
        let landingPoint;
        let landingVelocity;

        if (ab.flightColliderHandoff) {
          landingPoint = ab.flightColliderHandoff.position.clone();
          landingVelocity = ab.flightColliderHandoff.velocity.clone();
        } else {
          landingPoint = ab.curve.getPointAt(1).clone();
          const groundY = this._getGroundHeight(landingPoint.x, landingPoint.z);
          const ballRadius = this._config.ball.radius;
          const CLEARANCE_EPS = 0.02;
          if (Number.isFinite(groundY)) {
            const minY = groundY + ballRadius + CLEARANCE_EPS;
            if (landingPoint.y < minY) landingPoint.y = minY;
          }

          // Derive landing velocity from the curve's last slice. The curve is
          // parameterised 0→1 over `hangTimeRaw` real seconds, so a 5% slice
          // covers 0.05 × hangTime seconds of world time.
          const pNear = ab.curve.getPointAt(0.95);
          const pEnd = ab.curve.getPointAt(1);
          const sliceSeconds = Math.max(0.05 * (ab.hangTimeRaw || 5), 0.01);
          landingVelocity = pEnd.clone().sub(pNear).divideScalar(sliceSeconds);
        }

        // Remember roll direction (horizontal) for follow-cam aim during sim.
        const rollDir = landingVelocity.clone();
        rollDir.y = 0;
        if (rollDir.lengthSq() > 1e-6) rollDir.normalize();
        else rollDir.set(0, 0, 1);
        ab.rollDir = rollDir;
        ab.landingPos = landingPoint.clone();

        // Finalize ribbon in static mode — flight is visually done.
        if (!isFollow && ab.ribbon) {
          this._updateRibbonProgress(ab.ribbon, 1);
        }

        // Hand off to simulator. If it isn't ready yet (GLB still loading,
        // or non-scene-container GLB), we keep the old static-drop behaviour:
        // snap ball to ground and end the shot after a beat.
        if (this._simulator) {
          this._simulator.start({
            position: landingPoint,
            velocity: landingVelocity,
            spin: ab.spin ?? 0
          });
          ab.phase = 'simulator';
        } else {
          this._log('Physics simulator unavailable — snapping ball to landing point.');
          ab.phase = 'simulator-done';
          ab.mesh.position.copy(landingPoint);
        }
      }

      if (ab.phase === 'simulator') {
        // Physics owns the ball. Step the fixed-timestep integrator with this
        // frame's dt; simulator internally sub-steps to maintain determinism.
        const stillRunning = this._simulator.step(dt);
        const simPos = this._simulator.state.position;
        ab.mesh.position.copy(simPos);
        this._updateComet(ab, dt);

        // Follow-cam: chase the ball along its current direction of travel
        // until rest. Reuse the stored rollDir on near-zero velocity to avoid
        // jitter when the ball slows down. Freeze near/inside the cup so the
        // chase camera does not dive into the hole on a hole-out.
        if (isFollow) {
          const cupDist = this._cupCapture?.distanceXZ?.(simPos.x, simPos.z);
          const cupR = this._cupCapture?.cup?.radius ?? 0.054;
          const nearCup = Number.isFinite(cupDist) && cupDist < cupR * 4;
          if (!nearCup && this._simulator.state.phase !== 'holed') {
            const vel = this._simulator.state.velocity;
            const dir = ab.rollDir.clone();
            if (vel.lengthSq() > 0.01) {
              dir.set(vel.x, 0, vel.z);
              if (dir.lengthSq() > 1e-6) dir.normalize();
              else dir.copy(ab.rollDir);
              ab.rollDir.copy(dir);
            }
            const camCfg = this._config.camera;
            const idealPos = simPos.clone()
              .add(new THREE.Vector3(0, camCfg.followAboveHeight, 0))
              .sub(dir.multiplyScalar(camCfg.followBehindDist));
            // On a steep landing the terrain behind the ball can sit above the
            // camera; keep the camera above the surface so it never clips
            // below the hill.
            this._clampCameraAboveGround(idealPos);
            this._camera.position.lerp(idealPos, 0.05);
            this._controls.target.lerp(simPos, 0.05);
          }
        }

        if (!stillRunning) {
          ab.phase = 'simulator-done';
        }
      } else if (ab.phase === 'simulator-done') {
        // Simulator terminated (rest, water, or holed). Finalise origin, tear
        // down the animated ball, and place a static ball for the next shot.
        //
        // • Rest (fairway / green / bunker / …): keep playing from the
        //   resting point — must update even when not in follow-cam, or the
        //   ball snaps back to the previous tee after every shot.
        // • Absorb (water / OB): emit golf:water for apps; default here is
        //   re-tee at the selected position (drop / penalty later).
        // • Holed: emit golf:holed; keep the ball in the cup (do not re-tee).
        // Prefer simulator pose — mesh should match, but this is authoritative.
        const finalPos = this._simulator?.state?.position?.clone?.()
          ?? ab.mesh.position.clone();
        const phase = this._simulator?.state?.phase;
        const absorbed = phase === 'absorbed';
        const holed = phase === 'holed';
        if (holed) this._ballHoled = true;
        // Range / driving_range: always re-tee at the selected spawn (practice).
        // Holes advance to the landing lie unless the ball was absorbed (water/OB).
        // Holed stays at the cup.
        const retee = (absorbed || this._activeSceneIsRange) && !holed;
        if (retee) {
          const tee = this._selectedPosition?.origin;
          this._currentOrigin = tee
            ? new THREE.Vector3(tee[0], tee[1], tee[2])
            : (this._currentOrigin?.clone() ?? finalPos);
        } else {
          this._currentOrigin = finalPos.clone();
        }
        this._teardownActiveBall();
        // Rest / holed on a hole: keep exact physics pose (no re-seat hop).
        // Re-tee (water / Range): ground-raycast at the tee XZ.
        this._placeTeeBall(this._currentOrigin, { exact: !retee });
        if (this._teeBall) this._teeBall.visible = true;
        // Ball may have travelled far from the previous shadow-camera focus.
        this._refreshStaticShadows(this._currentOrigin);

        // Drop the previous shot's manual club pick so the new lie can
        // auto-select (e.g. putter on green). Must run before either
        // clearAimTarget or the explicit suggest below — both call
        // `_runAutoClubSuggest`, which honours the override flag.
        this._clubManualOverride = false;

        if (holed) {
          // Ball is in the cup — do not re-aim (that swings the camera into
          // a look-down-the-hole framing). Keep the last chase pose until
          // the app advances via screen transition / scene change.
          this._autoAimPending = false;
          this._restIdleTimer = 0;
          if (this._aimTarget) this.clearAimTarget({ animate: false });
        } else {
          // Reset any click-to-aim override the user set for this shot. The
          // next swing uses default aim (waypoint / pin handoff / sticky
          // green) from the new lie — `clearAimTarget` also rotates
          // `_currentForward` toward that target so the trackman axis follows.
          if (this._aimTarget) {
            this.clearAimTarget({ animate: true });
          } else {
            // No user override, but the ball has moved — realign the shot
            // axis so the next measurement fires toward the pin / waypoint
            // rather than whatever direction the previous shot was travelling.
            const defaultTarget = this._resolveDefaultAimTarget();
            if (defaultTarget) this._rotateForwardToward(defaultTarget);
            // Ball origin changed → re-evaluate club pick. `clearAimTarget`
            // handles the other branch via its own suggest call. Post-rest
            // auto-aim would also trigger this eventually, but we want the
            // bag updated immediately even when auto-aim is disabled.
            this._runAutoClubSuggest();
          }

          // Arm auto-aim: wait autoAimDelay seconds of rest, then re-frame the
          // flag. Per-frame accumulator below actually fires the transition.
          if (this._config.camera.autoAimAtFlag) {
            this._autoAimPending = true;
            this._restIdleTimer = 0;
          }
        }
      } else if (ab.phase === 'flight') {
        const ballPos = ab.curve.getPointAt(ab.progress);
        ab.mesh.position.copy(ballPos);
        this._updateComet(ab, dt);

        // Progressive ribbon reveal — only in static mode
        if (!isFollow && ab.ribbon) {
          this._updateRibbonProgress(ab.ribbon, ab.progress);
        }

        // Follow camera — smooth chase behind ball
        if (isFollow && ab.progress > 0.01) {
          const camCfg = this._config.camera;
          // Use only the HORIZONTAL component of the trajectory tangent for
          // the "behind" offset. On a near-vertical chip/lob the full 3D
          // tangent points up, which would otherwise place the camera below
          // the ball (and under the ground). Fall back to the last good
          // horizontal direction (or shot forward) when the tangent is
          // effectively vertical.
          const tangent = ab.curve.getTangentAt(ab.progress);
          const flatDir = new THREE.Vector3(tangent.x, 0, tangent.z);
          if (flatDir.lengthSq() > 1e-6) {
            flatDir.normalize();
            ab.chaseDir = (ab.chaseDir || new THREE.Vector3()).copy(flatDir);
          } else if (ab.chaseDir) {
            flatDir.copy(ab.chaseDir);
          } else if (this._currentForward) {
            flatDir.copy(this._currentForward).setY(0).normalize();
            ab.chaseDir = flatDir.clone();
          } else {
            flatDir.set(0, 0, 1);
          }

          const idealPos = ballPos.clone()
            .sub(flatDir.clone().multiplyScalar(camCfg.followBehindDist))
            .add(new THREE.Vector3(0, camCfg.followAboveHeight, 0));
          this._clampCameraAboveGround(idealPos);

          const easeIn = smoothstep(Math.min(ab.progress / 0.2, 1));
          const lerpFactor = 0.02 + easeIn * 0.06;

          this._camera.position.lerp(idealPos, lerpFactor);
          this._controls.target.lerp(ballPos, lerpFactor);
        }
      }
    }

    // Auto-aim delay: once the ball has come to rest we wait out autoAimDelay
    // seconds of idle time, then re-frame the flag. Any active ball, running
    // camera transition, or user drag (cleared via _cancelAutoAim) aborts.
    if (this._autoAimPending && !this._activeBall && !this._cameraTransition) {
      this._restIdleTimer += dt;
      const delay = this._config.camera.autoAimDelay ?? 1.0;
      if (this._restIdleTimer >= delay) {
        this._autoAimPending = false;
        this._restIdleTimer = 0;
        this._aimCameraAtFlag({ origin: this._currentOrigin, animate: true });
      }
    }

    // Camera transition
    if (this._cameraTransition) {
      const ct = this._cameraTransition;
      ct.elapsed += dt;
      const t = smoothstep(ct.elapsed / ct.duration);

      this._camera.position.lerpVectors(ct.from, ct.to, t);
      this._controls.target.lerpVectors(ct.fromTarget, ct.toTarget, t);

      if (ct.elapsed >= ct.duration) {
        this._camera.position.copy(ct.to);
        this._controls.target.copy(ct.toTarget);
        this._cameraTransition = null;
      }
    }

    // Keyboard movement
    if (this._keysPressed.size > 0) {
      this._processMovement(dt);
    }

    // OrbitControls.update() returns true while damping still moves the camera.
    const controlsMoved = !!(this._controls && this._controls.update());
    this._updatePinFade(dt);
    this._updateSurfaceReadout(dt);
    this._updateBallShadow();
    this._updatePropCulling();

    // Pre-render hook for add-ons that must update scene objects before the
    // main pass (e.g. app-owned distance marker). Runs after engine updates.
    if (this._preRenderCallbacks && this._preRenderCallbacks.length > 0) {
      for (const cb of this._preRenderCallbacks) {
        try {
          cb(this._renderer, this._scene, this._camera, dt);
        } catch (err) {
          console.error('[GolfVisualiser] pre-render callback error:', err);
        }
      }
    }

    this._renderer.render(this._scene, this._camera);

    // Post-render hook for add-ons (minimap, overlays, post-effects).
    // Each callback must restore any renderer state it mutates.
    if (this._renderCallbacks && this._renderCallbacks.length > 0) {
      for (const cb of this._renderCallbacks) {
        try {
          cb(this._renderer, this._scene, this._camera);
        } catch (err) {
          console.error('[GolfVisualiser] render callback error:', err);
        }
      }
    }

    // Keep looping while still busy, damping, or something woke us mid-frame.
    if ((this._isRenderBusy() || controlsMoved || this._needsRender) && this._animFrameId == null) {
      this._animFrameId = requestAnimationFrame(() => this._animateFrame());
    }
    } finally {
      this._inAnimateFrame = false;
    }
  }

  // ── Exact Shot Mode ────────────────────────────────────────────────────────

  _toggleExactShot() {
    this._exactShotMode = !this._exactShotMode;
    const btn = this.shadowRoot.getElementById('exact-shot-btn');
    const canvas = this._renderer.domElement;

    if (this._exactShotMode) {
      if (btn) { btn.textContent = 'Exact Shot: On (K)'; btn.style.color = '#0ff'; }
      canvas.addEventListener('click', this._onExactShotClick);
      canvas.style.cursor = 'crosshair';
      this._log('Exact shot mode ON — click where you want the ball to land');
    } else {
      if (btn) { btn.textContent = 'Exact Shot: Off (K)'; btn.style.color = ''; }
      canvas.removeEventListener('click', this._onExactShotClick);
      canvas.style.cursor = '';
      this._log('Exact shot mode OFF');
    }
  }

  _handleExactShotClick(e) {
    if (!this._exactShotMode || !this._glbModel || this._activeBall) return;
    const intersects = this._raycastSurface(e);
    if (intersects.length === 0) return;

    const target = intersects[0].point;
    const origin = this._currentOrigin || new THREE.Vector3(...this._selectedPosition.origin);

    // Compute distance and height difference
    const dx = target.x - origin.x;
    const dz = target.z - origin.z;
    const carry = Math.sqrt(dx * dx + dz * dz);
    const heightDiff = target.y - origin.y;

    // Face the click target for both lofted and putting paths.
    if (carry >= 1e-4) {
      this._currentForward = new THREE.Vector3(dx, 0, dz).normalize();
    }

    // On green/fringe with the putter selected, Exact Shot is a ground-roll
    // putt to the click point. A manually chosen non-putter launches lofted.
    if (this._shouldFirePutt()) {
      if (carry < 0.3) return; // too close for a meaningful putt
      this._log(`Exact putt: ${carry.toFixed(1)}m to [${target.x.toFixed(1)}, ${target.z.toFixed(1)}]`);
      this._startPuttRoll({ x: target.x, z: target.z });
      return;
    }

    if (carry < 1) return; // too close for a lofted exact shot

    // Compute a natural arc: peak height scales with distance
    const maxHeight = Math.max(carry * 0.2, 10) + Math.max(0, -heightDiff);
    const hangTime = Math.sqrt(carry / 20) * 2; // rough physics feel

    // Build trajectory points in Trackman space (X=forward, Y=up, Z=side)
    // For exact shot, we build world points directly
    const segments = this._config.tracer.segments;
    const worldPoints = [];

    for (let i = 0; i < segments; i++) {
      const t = i / (segments - 1);
      const x = origin.x + dx * t;
      const z = origin.z + dz * t;
      const y = origin.y + heightDiff * t + 4 * maxHeight * t * (1 - t);
      worldPoints.push(new THREE.Vector3(x, y, z));
    }

    this._log(`Exact shot: ${carry.toFixed(0)}m to [${target.x.toFixed(1)}, ${target.z.toFixed(1)}]`);

    // Fire the shot using the world points directly (skip _transformToWorld)
    const cfg = this._config.tracer;
    const isFollow = this._getEffectiveCameraMode() === 'follow';

    if (isFollow) {
      const curve = new THREE.CatmullRomCurve3(worldPoints);
      this._startBallAnimation(curve, hangTime, null, cfg);
    } else {
      // Static mode with tracer
      while (this._tracers.length >= cfg.maxShots) {
        const oldest = this._tracers.shift();
        this._scene.remove(oldest.group);
        oldest.group.traverse(child => {
          if (child.geometry) child.geometry.dispose();
          if (child.material) child.material.dispose();
        });
      }

      const group = new THREE.Group();
      const curve = new THREE.CatmullRomCurve3(worldPoints);
      const ribbon = this._buildRibbon(curve, cfg, true);
      group.add(ribbon);
      this._scene.add(group);
      this._tracers.push({ group, curve, points: worldPoints, ribbon });
      this._startBallAnimation(curve, hangTime, ribbon, cfg);
    }
  }

  // ── Test Shot ──────────────────────────────────────────────────────────────

  /**
   * Ground-only putt when the ball lies on green/fringe.
   *
   * Skips the scripted flight arc and starts BounceRollSimulator already in
   * the rolling phase with a horizontal speed sized so flat-surface Coulomb
   * friction roughly reaches the aim distance:
   *   v = √(v_rest² + 2 · μ · g · d)
   *
   * Used by Fire Test Shot and Exact Shot (K). Reuses the same `_activeBall`
   * `phase: 'simulator'` render-loop path as a normal flight handoff, so
   * rest → origin update → club suggest is shared.
   *
   * @param {{x:number,z:number}|THREE.Vector3|null} [targetOverride]
   *   Optional ground target (Exact Shot click). When omitted, uses the
   *   current aim override or flag.
   * @param {{speed:number,launchDirection:number}|null} [liveLaunch]
   *   TM4 live putt. Speed is m/s; direction is degrees relative to the
   *   current shot-forward. Synthetic putts omit this and size speed from
   *   target distance.
   * @returns {boolean} true when rolling simulation started
   * @private
   */
  _startPuttRoll(targetOverride = null, liveLaunch = null) {
    if (!this._currentOrigin || !this._currentForward) {
      this._log('Putt skipped — no ball origin / forward.');
      return false;
    }
    if (!this._simulator) {
      this._log('Putt skipped — physics simulator unavailable.');
      return false;
    }

    if (this._cameraMode === 'freefly') this._toggleFreeFly();

    // Ensure the bag UI reflects putter for this lie.
    const pt = this._clubs.find(c => c.id === 'PT');
    if (pt && this._selectedClubId !== pt.id) this._setSelectedClubId(pt.id);

    const hasLiveLaunch = Number.isFinite(liveLaunch?.speed) && liveLaunch.speed > 0;
    let targetX = null;
    let targetZ = null;
    if (!hasLiveLaunch) {
      if (targetOverride && Number.isFinite(targetOverride.x) && Number.isFinite(targetOverride.z)) {
        targetX = targetOverride.x;
        targetZ = targetOverride.z;
      } else {
        const fallback = this._resolveDefaultAimTarget();
        if (fallback) { targetX = fallback.x; targetZ = fallback.z; }
      }
    }

    let distance = (targetX != null)
      ? this.getDistanceTo({ x: targetX, z: targetZ })
      : null;

    const lie = this.getBallLie();
    const mu = Number.isFinite(lie?.surface?.rollResistance)
      ? lie.surface.rollResistance
      : 0.06;
    const g = 9.81;
    const restingThreshold = this._simulator.getParams?.()?.restingThreshold ?? 0.10;
    let speed;
    if (hasLiveLaunch) {
      speed = liveLaunch.speed;
      // Distance is only an overlay hint; physics still uses measured speed.
      distance = Math.max(
        0.3,
        (speed * speed - restingThreshold * restingThreshold) /
          (2 * Math.max(mu, 1e-4) * g)
      );
    } else {
      if (!Number.isFinite(distance) || distance < 0.3) distance = 0.3;
      // Flat-ground Coulomb: stops when |v| ≤ restingThreshold, so size speed
      // for that terminal speed rather than absolute zero.
      speed = Math.sqrt(
        restingThreshold * restingThreshold + 2 * Math.max(mu, 1e-4) * g * distance
      );
    }
    if (distance > 40) distance = 40;

    // Live TM4 direction is relative to shot-forward. Synthetic putts prefer
    // their target and otherwise use shot-forward.
    let dir;
    if (hasLiveLaunch) {
      const forward = this._currentForward.clone();
      forward.y = 0;
      if (forward.lengthSq() < 1e-8) forward.set(0, 0, 1);
      else forward.normalize();
      const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
      const angle = (Number(liveLaunch.launchDirection) || 0) * Math.PI / 180;
      dir = forward.multiplyScalar(Math.cos(angle))
        .add(right.multiplyScalar(Math.sin(angle)));
    } else if (targetX != null) {
      dir = new THREE.Vector3(
        targetX - this._currentOrigin.x,
        0,
        targetZ - this._currentOrigin.z,
      );
    } else {
      dir = this._currentForward.clone();
      dir.y = 0;
    }
    if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1);
    else dir.normalize();
    this._currentForward.copy(dir);

    const groundY = this._getGroundHeight(this._currentOrigin.x, this._currentOrigin.z);
    const ballRadius = this._config.ball.radius;
    const startPos = new THREE.Vector3(
      this._currentOrigin.x,
      groundY + ballRadius,
      this._currentOrigin.z,
    );
    const velocity = dir.clone().multiplyScalar(speed);

    // Tear down any in-flight ball and cancel pending auto-aim, same as
    // `_startBallAnimation` before a new shot.
    this._teardownActiveBall();
    this._cancelAutoAim();

    const ballCfg = this._config.ball;
    const geometry = new THREE.SphereGeometry(ballCfg.radius, 16, 12);
    const material = new THREE.MeshBasicMaterial({ color: ballCfg.color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(startPos);
    this._scene.add(mesh);
    if (this._teeBall) this._teeBall.visible = false;

    this._activeBall = {
      mesh,
      curve: null,
      ribbon: null,
      phase: 'simulator',
      progress: 1,
      duration: 1,
      hangTimeRaw: 0,
      spin: 0,
      landingPos: startPos.clone(),
      rollDir: dir.clone(),
      flightColliderHandoff: null,
      bounceHeight: 0,
      rollDist: 0,
      comet: null,
    };
    this._attachComet(this._activeBall);
    this.requestRender();

    // Optional ground polyline for overlays that listen to golf:trajectory.
    const endHint = startPos.clone().add(dir.clone().multiplyScalar(distance));
    endHint.y = this._getGroundHeight(endHint.x, endHint.z) + ballRadius;
    this._lastTrajectoryPoints = [startPos.clone(), endHint];
    this.dispatchEvent(new CustomEvent('golf:trajectory', {
      bubbles: true,
      composed: true,
      detail: { points: this._lastTrajectoryPoints, hangTime: 0, spin: 0, putt: true },
    }));

    this._simulator.start({
      position: startPos,
      velocity,
      spin: 0,
      phase: 'rolling',
    });

    this._log(
      `${hasLiveLaunch ? 'Live putt' : 'Putt'} fired: dist=${distance.toFixed(1)}m ` +
      `speed=${speed.toFixed(2)}m/s μ=${mu.toFixed(3)} lie=${lie?.zone || 'unknown'}`,
    );
    return true;
  }

  _fireTestShot() {
    // Free fly is transient — any shot snaps the camera back to the mode the
    // user was actually in (follow/static). Real radar shots route through
    // `_handleMeasurement` → `_addTracer`, which also calls this on the real
    // shot path via the auto-aim reset below; keeping the exit here covers
    // both test shots and the manual menu "Fire Test Shot" button.
    if (this._cameraMode === 'freefly') this._toggleFreeFly();

    // On green/fringe with the putter selected, fire a ground-roll putt.
    // If the user manually picked another club (menu / setSelectedClub),
    // launch that club as a lofted synthetic measurement instead.
    if (this._shouldFirePutt()) {
      this._startPuttRoll();
      return;
    }

    const club = this._clubs.find(c => c.id === this._selectedClubId)
      || this._clubs.find(c => c.id === 'PW')
      || this._clubs[0];
    if (!club) return;

    const vary = (v, pct) => v + v * (Math.random() - 0.5) * 2 * pct;
    const dirSign = Math.random() < 0.5 ? -1 : 1;
    const curveFactor = dirSign * Math.random() * club.curveRange;

    // Carry is sampled as a Gaussian around `club.carry` with σ =
    // `club.dispersion` (metres), clamped to ±3σ so the occasional extreme
    // tail never produces a negative / ridiculous carry. This replaces the
    // old hardcoded ±8% variance and lets the bag config tune dispersion
    // per club (tight wedges, wide woods).
    const sampleCarry = () => {
      const sigma = Math.max(Number(club.dispersion) || 0, 0);
      if (sigma === 0) return club.carry;
      // Box-Muller: two uniforms → one standard-normal sample.
      const u1 = Math.max(Math.random(), 1e-9);
      const u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const clampedZ = Math.max(-3, Math.min(3, z));
      return Math.max(0, club.carry + sigma * clampedZ);
    };

    const payload = {
      Id: `test-${Date.now()}`,
      Carry: sampleCarry(),
      MaxHeight: vary(club.maxHeight, 0.12),
      LaunchAngle: vary(club.launchAngle, 0.08),
      LaunchDirection: (Math.random() - 0.5) * 4,
      HangTime: vary(club.hangTime, 0.08),
      CurveFactor: curveFactor,
      _isNewShot: true,
    };

    this._log(`${club.name} fired: carry=${payload.Carry.toFixed(1)}m dir=${payload.LaunchDirection.toFixed(1)}° curve=${curveFactor.toFixed(3)}`);

    document.dispatchEvent(new CustomEvent('trackman:measurement', {
      detail: payload,
      bubbles: true,
    }));
  }

  /**
   * Fire a Wii-like club shot from phone-swing power %. Space-bar test shots
   * stay on `_fireTestShot` (Gaussian dispersion around the club).
   * @param {{ powerPct: number, overswing?: boolean }} opts
   */
  fireClubPowerShot(opts = {}) {
    const powerPct = Number(opts.powerPct);
    if (!Number.isFinite(powerPct)) return;
    if (this._activeBall) return;

    if (this._cameraMode === 'freefly') this._toggleFreeFly();

    if (this._shouldFirePutt()) {
      this._startPowerPutt(powerPct);
      return;
    }

    const club = this._clubs.find(c => c.id === this._selectedClubId)
      || this._clubs.find(c => c.id === 'PW')
      || this._clubs[0];
    if (!club) return;

    const payload = buildClubPowerShot(club, powerPct, { overswing: opts.overswing });
    this._log(`${club.name} swing: ${payload._swingPowerPct.toFixed(0)}% carry=${payload.Carry.toFixed(1)}m${payload._swingOverswing ? ' RED' : ''}`);
    document.dispatchEvent(new CustomEvent('trackman:measurement', {
      detail: payload,
      bubbles: true,
    }));
  }

  _startPowerPutt(powerPct) {
    const fallback = this._resolveDefaultAimTarget();
    if (!this._currentOrigin || !this._currentForward) {
      this._log('Putt skipped — no ball origin / forward.');
      return;
    }
    let dir = this._currentForward.clone();
    dir.y = 0;
    if (fallback) {
      dir.set(fallback.x - this._currentOrigin.x, 0, fallback.z - this._currentOrigin.z);
    }
    if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1);
    else dir.normalize();

    const full = fallback
      ? this.getDistanceTo({ x: fallback.x, z: fallback.z })
      : 5;
    const dist = scalePuttDistance(full, powerPct);
    this._startPuttRoll({
      x: this._currentOrigin.x + dir.x * dist,
      z: this._currentOrigin.z + dir.z * dist,
    });
  }

  // ── Keyboard Movement ──────────────────────────────────────────────────────

  _processMovement(dt) {
    // In follow mode with no ball in flight: left/right aim the shot direction
    // But not when exact shot mode is active — use free movement instead
    if (this._getEffectiveCameraMode() === 'follow' && !this._activeBall && this._currentForward
        && !this._exactShotMode) {
      this._processAimRotation(dt);
      return;
    }

    const speed = this._moveSpeed * dt * 60;
    const forward = new THREE.Vector3();
    this._camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();

    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const move = new THREE.Vector3();

    if (this._keysPressed.has('w') || this._keysPressed.has('arrowup'))    move.add(forward);
    if (this._keysPressed.has('s') || this._keysPressed.has('arrowdown'))  move.sub(forward);
    if (this._keysPressed.has('a') || this._keysPressed.has('arrowleft'))  move.sub(right);
    if (this._keysPressed.has('d') || this._keysPressed.has('arrowright')) move.add(right);
    if (this._keysPressed.has('q'))  move.y -= 1;
    if (this._keysPressed.has('e'))  move.y += 1;

    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed);
      this._camera.position.add(move);
      this._controls.target.add(move);
    }
  }

  _processAimRotation(dt) {
    const rotSpeed = 1.2 * dt;
    let angle = 0;

    if (this._keysPressed.has('arrowleft')  || this._keysPressed.has('a')) angle += rotSpeed;
    if (this._keysPressed.has('arrowright') || this._keysPressed.has('d')) angle -= rotSpeed;

    if (angle === 0) return;

    // Rotate forward vector around Y axis
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const fx = this._currentForward.x;
    const fz = this._currentForward.z;
    this._currentForward.x = fx * cos - fz * sin;
    this._currentForward.z = fx * sin + fz * cos;
    this._currentForward.normalize();

    // Rotate camera around the ball at fixed offset
    const origin = this._currentOrigin;
    const offset = this._camera.position.clone().sub(origin);
    const offsetDist = Math.sqrt(offset.x * offset.x + offset.z * offset.z);
    const offsetY = offset.y;

    // Place camera directly behind ball along the negative forward direction
    const camPos = origin.clone()
      .sub(this._currentForward.clone().multiplyScalar(offsetDist))
      .add(new THREE.Vector3(0, offsetY, 0));

    this._camera.position.copy(camPos);
    this._controls.target.copy(origin);
  }

  // ── Status ────────────────────────────────────────────────────────────────

  _updateStatusNote(text) {
    const el = this.shadowRoot.getElementById('status-note');
    if (el) el.textContent = text;
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  _loadSetting(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  _saveSetting(key, value) {
    try { localStorage.setItem(key, value); } catch (_) {}
  }

  // ── Logging ───────────────────────────────────────────────────────────────

  _log(message) {
    console.log(`[GolfVisualiser] ${message}`);
  }
}

customElements.define('golf-visualiser', GolfVisualiser);
