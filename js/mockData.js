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

const currentShots = [
  makeShot({
    id: "ew-7i-1", club: "7-iron", label: "Shot 1",
    carry: 158, total: 166, height: 29, offline: -6,
    ballSpeed: 118, launchAngle: 17.4, launchDirection: -1.1, spinRate: 6840, spinAxis: -3.2,
    landingAngle: 48.1, clubSpeed: 84, attackAngle: -3.6, clubPath: -1.4, faceAngle: -2.2,
    faceToPath: -0.8, dynamicLoft: 22.4, smash: 1.4,
  }),
  makeShot({
    id: "ew-7i-2", club: "7-iron", label: "Shot 2",
    carry: 167, total: 174, height: 31, offline: 4,
    ballSpeed: 122, launchAngle: 16.8, launchDirection: 0.8, spinRate: 6520, spinAxis: 2.4,
    landingAngle: 46.4, clubSpeed: 86, attackAngle: -3.1, clubPath: 1.2, faceAngle: 1.6,
    faceToPath: 0.4, dynamicLoft: 21.6, smash: 1.42,
  }),
  makeShot({
    id: "ew-7i-3", club: "7-iron", label: "Shot 3",
    carry: 163, total: 170, height: 30, offline: 1,
    ballSpeed: 120, launchAngle: 17.1, launchDirection: 0.2, spinRate: 6690, spinAxis: 0.6,
    landingAngle: 47.2, clubSpeed: 85, attackAngle: -3.4, clubPath: 0.3, faceAngle: 0.4,
    faceToPath: 0.1, dynamicLoft: 22.1, smash: 1.41,
  }),
  makeShot({
    id: "ew-pw-1", club: "Pitching wedge", label: "Shot 4",
    carry: 114, total: 119, height: 28, offline: -5,
    ballSpeed: 96, launchAngle: 24.2, launchDirection: -1.4, spinRate: 8420, spinAxis: -2.8,
    landingAngle: 52.6, clubSpeed: 74, attackAngle: -4.8, clubPath: -2.1, faceAngle: -2.6,
    faceToPath: -0.5, dynamicLoft: 32.4, smash: 1.3,
  }),
  makeShot({
    id: "ew-pw-2", club: "Pitching wedge", label: "Shot 5",
    carry: 121, total: 126, height: 30, offline: 3,
    ballSpeed: 99, launchAngle: 23.5, launchDirection: 0.7, spinRate: 8110, spinAxis: 1.9,
    landingAngle: 51.2, clubSpeed: 76, attackAngle: -4.2, clubPath: 1.1, faceAngle: 1.4,
    faceToPath: 0.3, dynamicLoft: 31.2, smash: 1.3,
  }),
  makeShot({
    id: "ew-dr-1", club: "Driver", label: "Shot 6",
    carry: 248, total: 267, height: 28, offline: -11,
    ballSpeed: 152, launchAngle: 12.8, launchDirection: -2.4, spinRate: 2680, spinAxis: -6.1,
    landingAngle: 34.2, clubSpeed: 102, attackAngle: 2.1, clubPath: -2.8, faceAngle: -3.4,
    faceToPath: -0.6, dynamicLoft: 14.2, smash: 1.49,
  }),
  makeShot({
    id: "ew-dr-2", club: "Driver", label: "Shot 7",
    carry: 261, total: 279, height: 32, offline: 7,
    ballSpeed: 158, launchAngle: 13.6, launchDirection: 1.6, spinRate: 2410, spinAxis: 4.4,
    landingAngle: 32.8, clubSpeed: 106, attackAngle: 3.2, clubPath: 2.4, faceAngle: 2.9,
    faceToPath: 0.5, dynamicLoft: 13.4, smash: 1.49,
  }),
  makeShot({
    id: "ew-dr-3", club: "Driver", label: "Shot 8",
    carry: 268, total: 286, height: 31, offline: 2,
    ballSpeed: 161, launchAngle: 13.1, launchDirection: 0.4, spinRate: 2320, spinAxis: 1.2,
    landingAngle: 33.4, clubSpeed: 108, attackAngle: 2.8, clubPath: 0.6, faceAngle: 0.8,
    faceToPath: 0.2, dynamicLoft: 13.8, smash: 1.49,
  }),
];

function historyShot(session, partial) {
  return makeShot({
    source: "History",
    sessionId: session.id,
    sessionName: session.name,
    sessionDate: session.date,
    ...partial,
  });
}

export const historySessions = [
  { id: "range-12-oct", name: "Range", date: "12 Oct 2026", shots: [] },
  { id: "course-5-oct", name: "Course", date: "5 Oct 2026", shots: [] },
];

historySessions[0].shots = [
  historyShot(historySessions[0], {
    id: "h-dr-1", club: "Driver", label: "Shot 3",
    carry: 239, total: 258, height: 26, offline: -14,
    ballSpeed: 147, launchAngle: 11.4, launchDirection: -3.1, spinRate: 2890, spinAxis: -7.4,
    landingAngle: 36.1, clubSpeed: 100, attackAngle: 0.8, clubPath: -3.6, faceAngle: -4.2,
    faceToPath: -0.6, dynamicLoft: 15.1, smash: 1.47,
  }),
  historyShot(historySessions[0], {
    id: "h-dr-2", club: "Driver", label: "Shot 6",
    carry: 252, total: 270, height: 29, offline: 5,
    ballSpeed: 154, launchAngle: 12.9, launchDirection: 1.2, spinRate: 2540, spinAxis: 3.1,
    landingAngle: 34.6, clubSpeed: 104, attackAngle: 2.4, clubPath: 1.8, faceAngle: 2.2,
    faceToPath: 0.4, dynamicLoft: 14.4, smash: 1.48,
  }),
  historyShot(historySessions[0], {
    id: "h-7i-1", club: "7-iron", label: "Shot 9",
    carry: 154, total: 162, height: 27, offline: -8,
    ballSpeed: 114, launchAngle: 16.2, launchDirection: -1.8, spinRate: 7120, spinAxis: -4.1,
    landingAngle: 49.4, clubSpeed: 82, attackAngle: -4.1, clubPath: -2.4, faceAngle: -3.1,
    faceToPath: -0.7, dynamicLoft: 23.2, smash: 1.39,
  }),
];

historySessions[1].shots = [
  historyShot(historySessions[1], {
    id: "c-dr-1", club: "Driver", label: "Shot 1",
    carry: 255, total: 271, height: 30, offline: 9,
    ballSpeed: 155, launchAngle: 14.2, launchDirection: 2.1, spinRate: 2480, spinAxis: 5.2,
    landingAngle: 33.1, clubSpeed: 105, attackAngle: 3.4, clubPath: 2.8, faceAngle: 3.5,
    faceToPath: 0.7, dynamicLoft: 13.6, smash: 1.48,
  }),
  historyShot(historySessions[1], {
    id: "c-7i-1", club: "7-iron", label: "Shot 4",
    carry: 171, total: 178, height: 32, offline: 2,
    ballSpeed: 124, launchAngle: 17.8, launchDirection: 0.5, spinRate: 6380, spinAxis: 1.4,
    landingAngle: 45.8, clubSpeed: 87, attackAngle: -2.8, clubPath: 0.8, faceAngle: 1.1,
    faceToPath: 0.3, dynamicLoft: 21.2, smash: 1.43,
  }),
  historyShot(historySessions[1], {
    id: "c-pw-1", club: "Pitching wedge", label: "Shot 11",
    carry: 108, total: 113, height: 26, offline: -2,
    ballSpeed: 93, launchAngle: 25.1, launchDirection: -0.6, spinRate: 8680, spinAxis: -1.2,
    landingAngle: 53.4, clubSpeed: 72, attackAngle: -5.1, clubPath: -0.9, faceAngle: -1.1,
    faceToPath: -0.2, dynamicLoft: 33.1, smash: 1.29,
  }),
];

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

export function latestShot() {
  return currentShots[currentShots.length - 1];
}

export function currentShotsList() {
  return currentShots;
}

export function shotsInSession(sessionId, club) {
  return allShots.filter((shot) => shot.sessionId === sessionId && shot.club === club);
}

export const clubOrder = ["Driver", "7-iron", "Pitching wedge"];

export const views = [
  ["video", "Video"],
  ["graph", "Graph"],
  ["trajectory", "Trajectory"],
  ["dispersion", "Dispersion"],
  ["tiles", "Data tiles"],
  ["table", "Table"],
];

export function formatMetric(value, digits) {
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
