/**
 * Mock shots for Shot Analysis compare.
 * Distances in yards, speeds in mph. Trajectory is drawn from these numbers.
 * The shot tracker replaces the Trajectory view in a later pass.
 */

export const metricDefs = [
  ["ballSpeed", "Ball speed", "mph", 0],
  ["launchAngle", "Launch angle", "°", 1],
  ["launchDirection", "Launch direction", "°", 1],
  ["spinRate", "Spin rate", "rpm", 0],
  ["spinAxis", "Spin axis", "°", 1],
  ["carry", "Carry", "yd", 0],
  ["total", "Total", "yd", 0],
  ["height", "Height", "yd", 0],
  ["landingAngle", "Landing angle", "°", 1],
  ["clubSpeed", "Club speed", "mph", 0],
  ["attackAngle", "Attack angle", "°", 1],
  ["clubPath", "Club path", "°", 1],
  ["faceAngle", "Face angle", "°", 1],
  ["faceToPath", "Face to path", "°", 1],
  ["dynamicLoft", "Dynamic loft", "°", 1],
  ["smash", "Smash factor", "", 2],
];

export const player = {
  name: "Emma Walsh",
  initials: "EW",
};

export const currentSession = {
  id: "range-26-oct",
  name: "Range",
  date: "26 Oct 2026",
  detail: "Driver and irons",
};

function round(n, digits) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function flight(carry, apex, offline) {
  const side = [];
  const top = [];
  const steps = 24;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    side.push([round(carry * t, 1), round(4 * apex * t * (1 - t), 1)]);
    top.push([round(carry * t, 1), round(offline * t * t, 1)]);
  }
  return { side, top };
}

function makeShot(partial) {
  const shot = {
    source: "This session",
    sessionId: currentSession.id,
    sessionName: currentSession.name,
    sessionDate: currentSession.date,
    tourPlayer: null,
    ...partial,
  };
  shot.flight = flight(shot.carry, shot.height, shot.offline);
  return shot;
}

const clubProfiles = {
  Driver: { carry: 252, roll: 18, height: 30, offline: 9, ball: 154, launch: 13.0, spin: 2550, landing: 34, clubSpeed: 104, attack: 2.2, loft: 14.0, smash: 1.48 },
  "3-wood": { carry: 228, roll: 14, height: 28, offline: 8, ball: 142, launch: 11.4, spin: 3480, landing: 38, clubSpeed: 98, attack: -0.6, loft: 15.5, smash: 1.45 },
  "5-iron": { carry: 184, roll: 8, height: 31, offline: 7, ball: 128, launch: 14.6, spin: 5280, landing: 44, clubSpeed: 91, attack: -2.2, loft: 18.8, smash: 1.41 },
  "7-iron": { carry: 162, roll: 7, height: 30, offline: 6, ball: 119, launch: 17.2, spin: 6680, landing: 47, clubSpeed: 85, attack: -3.4, loft: 22.0, smash: 1.4 },
  "Pitching wedge": { carry: 116, roll: 5, height: 29, offline: 5, ball: 97, launch: 24.0, spin: 8300, landing: 52, clubSpeed: 75, attack: -4.6, loft: 32.0, smash: 1.29 },
};

function rngFrom(seed) {
  let n = seed >>> 0;
  return () => {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    return n / 4294967296;
  };
}

function sway(rng, amount, digits = 1) {
  return round((rng() - 0.5) * 2 * amount, digits);
}

function shotFromClub(make, prefix, club, number, rng) {
  const profile = clubProfiles[club];
  const carry = Math.round(profile.carry + sway(rng, club === "Driver" ? 16 : 9, 1));
  const offline = round(sway(rng, profile.offline, 1), 0);
  const ballSpeed = Math.round(profile.ball + sway(rng, 6, 1));
  return make({
    id: `${prefix}-${number}`,
    club,
    label: `Shot ${number}`,
    carry,
    total: carry + Math.round(profile.roll + sway(rng, 3, 1)),
    height: Math.round(profile.height + sway(rng, 3, 1)),
    offline,
    ballSpeed,
    launchAngle: round(profile.launch + sway(rng, 1.4), 1),
    launchDirection: round(offline / 6, 1),
    spinRate: Math.round(profile.spin + sway(rng, 280, 0)),
    spinAxis: round(offline / 2.4, 1),
    landingAngle: round(profile.landing + sway(rng, 1.6), 1),
    clubSpeed: Math.round(profile.clubSpeed + sway(rng, 3, 1)),
    attackAngle: round(profile.attack + sway(rng, 0.8), 1),
    clubPath: round(offline / 4, 1),
    faceAngle: round(offline / 3.4, 1),
    faceToPath: round(sway(rng, 0.6), 1),
    dynamicLoft: round(profile.loft + sway(rng, 0.8), 1),
    smash: round(profile.smash + sway(rng, 0.02), 2),
  });
}

function block(club, count) {
  return Array.from({ length: count }, () => club);
}

// A range session is hit in club blocks. A course session mixes clubs the way a round does.
const currentRng = rngFrom(26);
const currentShots = block("Pitching wedge", 10)
  .concat(block("7-iron", 16), block("Driver", 16))
  .map((club, index) => shotFromClub(makeShot, "ew-26", club, index + 1, currentRng));

function historyShot(session, partial) {
  return makeShot({
    source: "History",
    sessionId: session.id,
    sessionName: session.name,
    sessionDate: session.date,
    ...partial,
  });
}

function fillSession(session, clubs) {
  const make = (partial) => historyShot(session, partial);
  const rng = rngFrom(session.seed);
  session.shots = clubs.map((club, index) => shotFromClub(make, session.id, club, index + 1, rng));
}

export const historySessions = [
  { id: "range-12-oct", name: "Range", date: "12 Oct 2026", detail: "Driver and irons", seed: 12, shots: [] },
  { id: "course-5-oct", name: "Course", date: "5 Oct 2026", detail: "18 holes", seed: 5, shots: [] },
  { id: "range-21-sep", name: "Range", date: "21 Sep 2026", detail: "Wedges and irons", seed: 21, shots: [] },
];

fillSession(
  historySessions[0],
  block("Pitching wedge", 12).concat(block("7-iron", 14), block("Driver", 12)),
);
fillSession(
  historySessions[1],
  Array.from({ length: 47 }, (_, index) => ["Driver", "5-iron", "7-iron", "Pitching wedge", "3-wood"][index % 5]),
);
fillSession(
  historySessions[2],
  block("Pitching wedge", 18).concat(block("7-iron", 15)),
);

function tourShot(partial) {
  return makeShot({
    source: "Tour",
    sessionId: null,
    sessionName: null,
    sessionDate: null,
    ...partial,
  });
}

export const tourShots = [
  tourShot({
    id: "tour-scottie-dr", club: "Driver", label: "Tee shot", tourPlayer: "Scottie Scheffler",
    carry: 289, total: 308, height: 33, offline: 1,
    ballSpeed: 176, launchAngle: 11.2, launchDirection: 0.2, spinRate: 2280, spinAxis: 0.4,
    landingAngle: 31.6, clubSpeed: 118, attackAngle: -1.2, clubPath: 0.4, faceAngle: 0.5,
    faceToPath: 0.1, dynamicLoft: 12.4, smash: 1.49,
  }),
  tourShot({
    id: "tour-rory-dr", club: "Driver", label: "Tee shot", tourPlayer: "Rory McIlroy",
    carry: 302, total: 324, height: 36, offline: -3,
    ballSpeed: 184, launchAngle: 12.4, launchDirection: -0.6, spinRate: 2460, spinAxis: -1.8,
    landingAngle: 30.4, clubSpeed: 123, attackAngle: -0.4, clubPath: -1.1, faceAngle: -1.4,
    faceToPath: -0.3, dynamicLoft: 11.8, smash: 1.5,
  }),
  tourShot({
    id: "tour-nelly-dr", club: "Driver", label: "Tee shot", tourPlayer: "Nelly Korda",
    carry: 262, total: 278, height: 27, offline: 2,
    ballSpeed: 159, launchAngle: 13.8, launchDirection: 0.5, spinRate: 2380, spinAxis: 1.1,
    landingAngle: 32.2, clubSpeed: 107, attackAngle: 2.2, clubPath: 0.8, faceAngle: 1.0,
    faceToPath: 0.2, dynamicLoft: 14.1, smash: 1.49,
  }),
  tourShot({
    id: "tour-scottie-7", club: "7-iron", label: "Approach", tourPlayer: "Scottie Scheffler",
    carry: 186, total: 193, height: 34, offline: 0,
    ballSpeed: 132, launchAngle: 16.4, launchDirection: 0.1, spinRate: 6120, spinAxis: 0.2,
    landingAngle: 47.8, clubSpeed: 93, attackAngle: -2.4, clubPath: 0.2, faceAngle: 0.2,
    faceToPath: 0, dynamicLoft: 20.6, smash: 1.42,
  }),
  tourShot({
    id: "tour-rory-7", club: "7-iron", label: "Approach", tourPlayer: "Rory McIlroy",
    carry: 194, total: 201, height: 35, offline: -2,
    ballSpeed: 136, launchAngle: 16.9, launchDirection: -0.4, spinRate: 5980, spinAxis: -1.1,
    landingAngle: 46.2, clubSpeed: 96, attackAngle: -2.1, clubPath: -0.6, faceAngle: -0.8,
    faceToPath: -0.2, dynamicLoft: 20.1, smash: 1.42,
  }),
  tourShot({
    id: "tour-nelly-7", club: "7-iron", label: "Approach", tourPlayer: "Nelly Korda",
    carry: 164, total: 171, height: 30, offline: 1,
    ballSpeed: 121, launchAngle: 18.2, launchDirection: 0.3, spinRate: 6740, spinAxis: 0.8,
    landingAngle: 48.6, clubSpeed: 86, attackAngle: -3.2, clubPath: 0.4, faceAngle: 0.6,
    faceToPath: 0.2, dynamicLoft: 22.8, smash: 1.41,
  }),
];

const allShots = [
  ...currentShots,
  ...historySessions.flatMap((session) => session.shots),
  ...tourShots,
];

const byId = new Map(allShots.map((shot) => [shot.id, shot]));

export function getShot(id) {
  return byId.get(id) || null;
}

/* ------------------------------------------------------------------ */
/* Shot tracker: live shots from a Trackman 4 radar                    */
/* Radar values are metres and m/s. The prototype shows yards and mph. */
/* ------------------------------------------------------------------ */

const M_TO_YD = 1.0936133;
const MS_TO_MPH = 2.2369363;

const pendingMeasurements = new Map();

function evalFit(coeffs, t) {
  let value = 0;
  for (let i = coeffs.length - 1; i >= 0; i -= 1) value = value * t + coeffs[i];
  return value;
}

function sampleSegment(segment, steps) {
  const [t0, t1] = segment.TimeInterval || segment.ValidTimeInterval || [0, 0];
  const side = [];
  const top = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = t0 + ((t1 - t0) * i) / steps;
    const x = evalFit(segment.XFit || [0], t) * M_TO_YD;
    const y = Math.max(0, evalFit(segment.YFit || [0], t) * M_TO_YD);
    const z = evalFit(segment.ZFit || [0], t) * M_TO_YD;
    side.push([round(x, 1), round(y, 1)]);
    top.push([round(x, 1), round(z, 1)]);
  }
  return { side, top };
}

/** Real flight and bounce/roll from the radar's polynomial fits. Null when there is no usable flight. */
function flightFromTracker(segments, carryYd) {
  if (!Array.isArray(segments)) return null;
  const flightSegment = segments.find((s) => s.Kind === "Flight" && s.XFit && s.YFit && s.ZFit);
  if (!flightSegment) return null;
  const main = sampleSegment(flightSegment, 48);
  const endX = main.side[main.side.length - 1][0];
  if (!Number.isFinite(endX) || endX < carryYd * 0.75 || endX > carryYd * 1.25) return null;

  const after = { side: [], top: [] };
  segments
    .filter((s) => (s.Kind === "Bounce" || s.Kind === "Roll") && s.XFit && s.YFit && s.ZFit)
    .forEach((segment) => {
      const part = sampleSegment(segment, 12);
      after.side.push(...part.side);
      after.top.push(...part.top);
    });
  return { side: main.side, top: main.top, after, tracked: true };
}

function pick(value, scale = 1, digits = 1) {
  return typeof value === "number" && Number.isFinite(value) ? round(value * scale, digits) : null;
}

function shotFromMeasurement(m, existing) {
  const carry = pick(m.Carry, M_TO_YD, 0);
  const height = pick(m.MaxHeight, M_TO_YD, 0) ?? 0;
  const offline = pick(m.CarrySide, M_TO_YD, 0) ?? 0;
  const base = existing || {
    id: `live-${m.Id}`,
    club: "Radar",
    label: `Shot ${currentShots.length + 1}`,
    source: "This session",
    sessionId: currentSession.id,
    sessionName: currentSession.name,
    sessionDate: currentSession.date,
    tourPlayer: null,
    live: true,
  };
  const shot = {
    ...base,
    carry,
    total: pick(m.Total, M_TO_YD, 0),
    height,
    offline,
    ballSpeed: pick(m.BallSpeed, MS_TO_MPH, 0),
    launchAngle: pick(m.LaunchAngle),
    launchDirection: pick(m.LaunchDirection),
    spinRate: pick(m.SpinRate, 1, 0),
    spinAxis: pick(m.SpinAxis),
    landingAngle: m.LandingAngle == null ? null : pick(Math.abs(m.LandingAngle)),
    clubSpeed: pick(m.ClubSpeed, MS_TO_MPH, 0),
    attackAngle: pick(m.AttackAngle),
    clubPath: pick(m.ClubPath),
    faceAngle: pick(m.FaceAngle),
    faceToPath: pick(m.FaceToPath),
    dynamicLoft: pick(m.DynamicLoft),
    smash: pick(m.SmashFactor, 1, 2),
    radar: {
      Carry: m.Carry,
      MaxHeight: m.MaxHeight,
      LaunchDirection: m.LaunchDirection,
      HangTime: m.HangTime,
      LaunchAngle: m.LaunchAngle,
      CurveFactor: m.CurveFactor,
      SpinRate: m.SpinRate,
      SpinAxis: m.SpinAxis,
      BallTrajectory: m.BallTrajectory,
    },
  };
  shot.flight = flightFromTracker(m.BallTrajectory, carry) || flight(carry, height, offline);
  return shot;
}

/**
 * Feed one radar measurement in. Launch-only messages are held back until a
 * carry arrives, because a shot without a carry cannot be drawn.
 * Returns the shot when it was created or updated, otherwise null.
 */
export function applyMeasurement(payload) {
  const id = payload && payload.Id;
  if (!id) return null;
  const merged = { ...(pendingMeasurements.get(id) || {}), ...payload };
  pendingMeasurements.set(id, merged);
  if (typeof merged.Carry !== "number" || merged.Carry <= 0) return null;

  const key = `live-${id}`;
  const existing = byId.get(key) || null;
  const shot = shotFromMeasurement(merged, existing);
  if (existing) {
    const index = currentShots.indexOf(existing);
    currentShots[index] = shot;
  } else {
    currentShots.push(shot);
  }
  byId.set(key, shot);
  return shot;
}

const simulatedShotIds = new Set();

function nextSessionShotNumber() {
  let max = 0;
  for (const shot of currentShots) {
    const match = /^Shot (\d+)$/.exec(shot.label);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/** One Driver for the current session. Numbers vary on every call. No radar data, so the arc is drawn from carry, height, and offline. */
export function addSimulatedShot() {
  const number = nextSessionShotNumber();
  const previous = currentShots[currentShots.length - 1];
  let shot = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    shot = shotFromClub(makeShot, "sim", "Driver", number, Math.random);
    const same =
      previous &&
      shot.carry === previous.carry &&
      shot.height === previous.height &&
      shot.offline === previous.offline;
    if (!same) break;
  }
  if (previous && shot.carry === previous.carry) {
    const delta = shot.carry < 270 ? 1 : -1;
    shot.carry += delta;
    shot.total += delta;
    shot.flight = flight(shot.carry, shot.height, shot.offline);
  }
  currentShots.push(shot);
  allShots.push(shot);
  byId.set(shot.id, shot);
  simulatedShotIds.add(shot.id);
  return shot;
}

/** Drops shots added by Take a new shot. The original mock session stays. */
export function clearSimulatedShots() {
  if (!simulatedShotIds.size) return;
  for (let i = currentShots.length - 1; i >= 0; i -= 1) {
    if (simulatedShotIds.has(currentShots[i].id)) currentShots.splice(i, 1);
  }
  for (let i = allShots.length - 1; i >= 0; i -= 1) {
    if (simulatedShotIds.has(allShots[i].id)) allShots.splice(i, 1);
  }
  for (const id of simulatedShotIds) byId.delete(id);
  simulatedShotIds.clear();
}

export function latestShot() {
  return currentShots[currentShots.length - 1];
}

export function currentShotsList() {
  return currentShots;
}

export function shotsInSession(sessionId, club) {
  return allShots.filter((shot) => shot.sessionId === sessionId && shot.club === club);
}

// "Radar" shots come from the shot tracker. The radar does not report which club was used.
export const clubOrder = ["Radar", "Driver", "3-wood", "5-iron", "7-iron", "Pitching wedge"];

export const views = [
  ["video", "Video"],
  ["graph", "Graph"],
  ["trajectory", "Trajectory"],
  ["dispersion", "Dispersion"],
  ["tiles", "Data tiles"],
  ["table", "Table"],
];

export function formatMetric(value, digits) {
  if (value == null) return "–";
  return Number(value).toFixed(digits);
}

export function formatDelta(value, digits) {
  const rounded = Number(value.toFixed(digits));
  if (rounded === 0) return Number(0).toFixed(digits);
  const text = Math.abs(rounded).toFixed(digits);
  return rounded > 0 ? `+${text}` : `−${text}`;
}

export function offlineLabel(yards) {
  const amount = Math.abs(Math.round(yards));
  if (amount === 0) return "On target";
  return yards > 0 ? `${amount} yd right` : `${amount} yd left`;
}
