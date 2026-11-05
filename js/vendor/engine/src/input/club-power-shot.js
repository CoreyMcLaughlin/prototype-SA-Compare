/**
 * Map a Wii-like swing power % onto a synthetic Trackman measurement.
 *
 * Blue (≤100%): carry is a fraction of the selected club. Straight.
 * Red (>100%): carry can exceed club max slightly; random hook/slice.
 */

export const RED_START = 100;
export const MAX_FIRE_PCT = 110;
export const MAX_DISPLAY_PCT = 130;

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * @param {number} powerPct
 * @returns {{ firePct: number, displayPct: number, overswing: boolean }}
 */
export function mapSwingPower(powerPct) {
  const raw = Number(powerPct);
  const pct = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  return {
    firePct: clamp(pct, 0, MAX_FIRE_PCT),
    displayPct: clamp(pct, 0, MAX_DISPLAY_PCT),
    overswing: pct > RED_START,
  };
}

/**
 * @param {{ carry: number, maxHeight?: number, hangTime?: number, launchAngle?: number, curveRange?: number, name?: string, id?: string }} club
 * @param {number} powerPct
 * @param {{ overswing?: boolean, random?: () => number }} [opts]
 */
export function buildClubPowerShot(club, powerPct, opts = {}) {
  if (!club || !Number.isFinite(Number(club.carry))) {
    throw new Error('buildClubPowerShot requires a club with numeric carry');
  }
  const mapped = mapSwingPower(powerPct);
  const overswing = opts.overswing ?? mapped.overswing;
  const random = typeof opts.random === 'function' ? opts.random : Math.random;
  const t = mapped.firePct / 100;
  const vary = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n * t : fallback;
  };

  let launchDirection = 0;
  let curveFactor = 0;
  if (overswing) {
    const extra = clamp((mapped.firePct - RED_START) / (MAX_FIRE_PCT - RED_START), 0, 1);
    const dirSign = random() < 0.5 ? -1 : 1;
    const curveRange = Math.max(Number(club.curveRange) || 0, 0.02);
    launchDirection = dirSign * (5 + extra * 10);
    curveFactor = dirSign * curveRange * (0.5 + extra * 0.5);
  }

  return {
    Id: `swing-${Date.now()}`,
    Carry: Math.max(0, Number(club.carry) * t),
    MaxHeight: Math.max(0.2, vary(club.maxHeight, 20)),
    LaunchAngle: Number.isFinite(Number(club.launchAngle)) ? Number(club.launchAngle) : 15,
    LaunchDirection: launchDirection,
    HangTime: Math.max(0.4, vary(club.hangTime, 4)),
    CurveFactor: curveFactor,
    _isNewShot: true,
    _swingPowerPct: mapped.firePct,
    _swingOverswing: overswing,
  };
}

/**
 * Scale a putt target distance by swing power (metres).
 * @param {number} fullDistance
 * @param {number} powerPct
 */
export function scalePuttDistance(fullDistance, powerPct) {
  const { firePct } = mapSwingPower(powerPct);
  const d = Number(fullDistance);
  const base = Number.isFinite(d) && d > 0 ? d : 0.3;
  return clamp(base * (firePct / 100), 0.3, 40);
}
