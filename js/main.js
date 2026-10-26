import {
  addSimulatedShot,
  applyMeasurement,
  clearSimulatedShots,
  clubOrder,
  currentSession,
  currentShotsList,
  formatDelta,
  formatMetric,
  getShot,
  historySessions,
  latestShot,
  metricDefs,
  offlineLabel,
  player,
  shotsInSession,
  tourShots,
  views,
} from "./mockData.js";

const root = document.getElementById("app");

const freshVideo = () => ({
  left: { playing: false, progress: 0 },
  right: { playing: false, progress: 0 },
  shell: { playing: false, progress: 0 },
});

const state = {
  screen: "shell",
  selectedShotId: null,
  leftShotId: null,
  rightShotId: null,
  leftView: "trajectory",
  rightView: "tiles",
  shellView: "trajectory",
  pickerSlot: null,
  pickerSource: "session",
  historySessionId: null,
  showDifference: false,
  theme: "dark",
  viewStyle: "chips",
  debugOpen: false,
  shotListOpen: false,
  shotListStyle: "panel",
  video: freshVideo(),
};

let videoTimer = null;
let slideShotList = false;

function activeShotId() {
  return state.selectedShotId || latestShot().id;
}

function slotShot(slot) {
  const id = slot === "left" ? state.leftShotId : state.rightShotId;
  return id ? getShot(id) : null;
}

function slotView(slot) {
  return slot === "left" ? state.leftView : state.rightView;
}

function otherShot(slot) {
  return slotShot(slot === "left" ? "right" : "left");
}

function bothNumeric() {
  const numeric = new Set(["tiles", "table"]);
  return Boolean(
    slotShot("left") &&
      slotShot("right") &&
      numeric.has(state.leftView) &&
      numeric.has(state.rightView),
  );
}

function openCompare() {
  state.screen = "compare";
  state.leftShotId = activeShotId();
  state.rightShotId = null;
  state.leftView = "trajectory";
  state.rightView = "tiles";
  state.pickerSlot = null;
  state.shotListOpen = false;
  state.video = freshVideo();
  stopVideo();
  render();
}

function resetAll() {
  stopVideo();
  clearSimulatedShots();
  const keepScreen = state.screen;
  state.selectedShotId = null;
  state.rightShotId = null;
  state.leftShotId = keepScreen === "compare" ? latestShot().id : null;
  state.leftView = "trajectory";
  state.rightView = "tiles";
  state.shellView = "trajectory";
  state.pickerSlot = null;
  state.pickerSource = "session";
  state.historySessionId = null;
  state.showDifference = false;
  state.theme = "dark";
  state.viewStyle = "chips";
  state.debugOpen = true;
  state.shotListOpen = false;
  state.shotListStyle = "panel";
  state.video = freshVideo();
  render();
}

function stopVideo() {
  state.video.left.playing = false;
  state.video.right.playing = false;
  state.video.shell.playing = false;
  if (videoTimer) {
    clearInterval(videoTimer);
    videoTimer = null;
  }
}

function syncVideoTimer() {
  const playing = state.video.left.playing || state.video.right.playing || state.video.shell.playing;
  if (playing && !videoTimer) videoTimer = setInterval(tickVideo, 100);
  if (!playing && videoTimer) {
    clearInterval(videoTimer);
    videoTimer = null;
  }
}

function tickVideo() {
  ["left", "right", "shell"].forEach((slot) => {
    const clip = state.video[slot];
    if (!clip || !clip.playing) return;
    clip.progress = Math.min(1, clip.progress + 0.02);
    if (clip.progress >= 1) clip.playing = false;
    const bar = root.querySelector(`[data-video-bar="${slot}"]`);
    const button = root.querySelector(`[data-video-toggle="${slot}"]`);
    if (bar) bar.style.width = `${clip.progress * 100}%`;
    if (button) button.textContent = clip.playing ? "Pause" : "Play";
  });
  syncVideoTimer();
}

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sourceLine(shot) {
  if (shot.source === "History") return `History · ${shot.sessionDate}`;
  if (shot.source === "Tour") return `Tour · ${shot.tourPlayer}`;
  return shot.live ? "This session · Shot tracker" : "This session";
}

function groupsFor(shots) {
  return clubOrder
    .map((club) => ({ club, shots: shots.filter((shot) => shot.club === club) }))
    .filter((group) => group.shots.length);
}

const YD_TO_M = 1 / 1.0936133;
const visualisers = { left: null, right: null, shell: null };
const enginePark = document.getElementById("engine-park");
const trajResize = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const el = entry.target;
    if (el._ready) el._handleResize();
  }
});

function parkVisualisers() {
  for (const el of Object.values(visualisers)) {
    if (el) enginePark.appendChild(el);
  }
}

function measurementFor(shot) {
  if (shot.radar && typeof shot.radar.Carry === "number") {
    return { ...shot.radar, Id: shot.id };
  }
  const carry = shot.carry * YD_TO_M;
  const height = Math.max(shot.height || 1, 1) * YD_TO_M;
  const offline = (shot.offline || 0) * YD_TO_M;
  return {
    Id: shot.id,
    Carry: carry,
    MaxHeight: height,
    LaunchDirection: (Math.atan2(offline, carry || 1) * 180) / Math.PI,
    HangTime: 2 * Math.sqrt((2 * height) / 9.81),
  };
}

function ensureVisualiser(slot) {
  if (visualisers[slot]) return visualisers[slot];
  const el = document.createElement("golf-visualiser");
  el.setAttribute("config", "js/vendor/engine/range-config.json");
  el.setAttribute("embed", "");
  el.setAttribute("persist", "");
  el.addEventListener("golf:ready", () => {
    el.dataset.ready = "1";
    playSlot(slot);
    el._handleResize();
  });
  trajResize.observe(el);
  visualisers[slot] = el;
  return el;
}

function playSlot(slot) {
  const el = visualisers[slot];
  const shot = slot === "shell" ? getShot(activeShotId()) : slotShot(slot);
  if (!el || !shot || el.dataset.ready !== "1") return;
  if (!el.closest("[data-traj-slot]")) return;
  if (el.dataset.playedId === shot.id) return;
  el.dataset.playedId = shot.id;
  el.playMeasurement(measurementFor(shot));
  frameShot(el, shot);
}

function frameShot(el, shot) {
  const origin = el._currentOrigin;
  const forward = el._currentForward;
  if (!origin || !forward || !el._camera || !el._controls) return;
  const carry = Math.max(shot.carry * YD_TO_M, 40);
  const cam = origin.clone().addScaledVector(forward, -carry * 0.42);
  cam.y = origin.y + carry * 0.32;
  const look = origin.clone().addScaledVector(forward, carry * 0.5);
  look.y = origin.y + Math.max(shot.height, 8) * YD_TO_M * 0.45;
  el._camera.position.copy(cam);
  el._controls.target.copy(look);
  el._controls.update();
}

function mountVisualisers() {
  document.querySelectorAll("[data-traj-slot]").forEach((host) => {
    const slot = host.dataset.trajSlot;
    const el = ensureVisualiser(slot);
    host.appendChild(el);
    playSlot(slot);
  });
}

function render() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.dataset.viewStyle = state.viewStyle;
  const slide = slideShotList;
  slideShotList = false;
  parkVisualisers();
  root.innerHTML = state.screen === "shell" ? shellHtml() : compareHtml(slide);
  root.insertAdjacentHTML("beforeend", debugHtml());
  mountVisualisers();
  syncVideoTimer();
  root.querySelector(".shot-row.is-selected")?.scrollIntoView({ block: "nearest" });
}

function sessionShotGroupsHtml() {
  const selectedId = activeShotId();
  return groupsFor(currentShotsList())
    .map(
      (group) => `
        <div class="club-group">
          <div class="club-group-label">
            <span>${esc(group.club)}</span>
            <span class="inert-meta">${group.shots.length}</span>
          </div>
          ${group.shots
            .map((shot) => {
              const on = shot.id === selectedId ? " is-selected" : "";
              return `
                <button class="shot-row${on}" type="button" data-action="select" data-shot="${shot.id}">
                  <span class="ball-dot"></span>
                  <span>${esc(shot.label)}</span>
                  <span class="shot-carry">${shot.carry}</span>
                  <span class="inert-icon" aria-hidden="true">&#9654;</span>
                </button>
              `;
            })
            .join("")}
        </div>
      `,
    )
    .join("");
}

function shellHtml() {
  const selected = getShot(activeShotId());
  return `
    <div class="app-shell">
      <header class="topbar">
        <p class="topbar-product">Shot Analysis</p>
        <p class="topbar-player">${esc(player.name)}</p>
        <p class="topbar-session">${esc(currentSession.name)} · ${esc(currentSession.date)}</p>
      </header>
      <div class="shell-body">
        <aside class="shotlist">
          <div class="shotlist-player">
            <span class="initials">${esc(player.initials)}</span>
            <span>
              <span class="shotlist-name">${esc(player.name)}</span>
              <span class="helper-text">${currentShotsList().length} shots · ${esc(currentSession.detail)}</span>
            </span>
          </div>
          <div class="shotlist-scroll">
            ${sessionShotGroupsHtml()}
          </div>
          <div class="shotlist-bottom">
            <button class="button button--primary compare-launch" type="button" data-action="compare">Compare</button>
            <input class="field" disabled placeholder="Search shots" aria-label="Search shots" />
          </div>
        </aside>
        <section class="shell-stage" aria-label="Selected shot">
          <section class="slot">
            <header class="slot-head">
              <div>
                <h1 class="slot-club">${esc(selected.club)} · ${esc(selected.label)}</h1>
                <p class="helper-text">${esc(sourceLine(selected))}</p>
              </div>
            </header>
            ${viewSwitchHtml("shell", selected.label, state.shellView)}
            <div class="slot-view">${viewHtml("shell", selected, state.shellView)}</div>
          </section>
        </section>
      </div>
    </div>
  `;
}

function compareShotListHtml() {
  if (!state.shotListOpen || state.shotListStyle === "column") return "";
  return `
    <div class="compare-shotlist" id="compare-shot-list" role="region" aria-label="Shot list">
      <div class="compare-shotlist-head">
        <span>
          <span class="shotlist-name">This session</span>
          <span class="helper-text">${currentShotsList().length} shots · ${esc(currentSession.detail)}</span>
        </span>
        <button class="text-button" type="button" data-action="close-shot-list">Close</button>
      </div>
      <div class="compare-shotlist-scroll">
        ${sessionShotGroupsHtml()}
      </div>
    </div>
  `;
}

function compareSideListHtml() {
  return `
    <div class="compare-side">
      <aside class="shotlist" id="compare-shot-list" role="region" aria-label="Shot list">
        <div class="shotlist-player">
          <span class="initials">${esc(player.initials)}</span>
          <span>
            <span class="shotlist-name">${esc(player.name)}</span>
            <span class="helper-text">${currentShotsList().length} shots · ${esc(currentSession.detail)}</span>
          </span>
          <button class="text-button compare-side-close" type="button" data-action="close-shot-list">Close</button>
        </div>
        <div class="shotlist-scroll">
          ${sessionShotGroupsHtml()}
        </div>
        <div class="shotlist-bottom">
          <input class="field" disabled placeholder="Search shots" aria-label="Search shots" />
        </div>
      </aside>
    </div>
  `;
}

function compareHtml(slide) {
  const listOpen = state.shotListOpen ? " is-open" : "";
  const column = state.shotListStyle === "column" && state.shotListOpen;
  const frameClass = column && slide ? "compare-frame is-sliding" : "compare-frame";
  return `
    <div class="app-shell">
      <div class="${frameClass}">
        ${column ? compareSideListHtml() : ""}
        <div class="compare-main">
          <header class="topbar">
            <div class="topbar-leading">
              <button class="button" type="button" data-action="exit-compare">Exit compare</button>
              <div class="shotlist-anchor">
                <button class="button${listOpen}" type="button" data-action="toggle-shot-list" aria-expanded="${state.shotListOpen ? "true" : "false"}" aria-controls="compare-shot-list">Shot list</button>
                ${compareShotListHtml()}
              </div>
            </div>
            <p class="topbar-product">Shot Analysis · Compare</p>
            <p class="topbar-player">${esc(player.name)}</p>
            <p class="topbar-session">${esc(currentSession.name)} · ${esc(currentSession.date)}</p>
          </header>
          <div class="compare-body">
            ${slotHtml("left")}
            ${slotHtml("right")}
          </div>
        </div>
      </div>
    </div>
  `;
}

function viewSwitchHtml(slot, shotLabel, view) {
  return `
    <div class="view-switch" role="tablist" aria-label="View for ${esc(shotLabel)}">
      ${views
        .map(([id, label]) => {
          const on = id === view ? " is-on" : "";
          return `<button class="view-button${on}" type="button" data-action="view" data-slot="${slot}" data-view="${id}">${label}</button>`;
        })
        .join("")}
    </div>
  `;
}

function slotHtml(slot) {
  const shot = slotShot(slot);
  const picker = state.pickerSlot === slot ? pickerHtml(slot) : "";
  if (!shot) {
    return `
      <section class="slot slot-empty">
        <div class="empty-copy">
          <h2 class="section-title">Add a shot</h2>
          <p class="helper-text">Choose a shot from this session, a historical session, or the tour player library.</p>
          <button class="button button--primary" type="button" data-action="open-picker" data-slot="${slot}">Change shot</button>
        </div>
        ${picker}
      </section>
    `;
  }

  const view = slotView(slot);
  return `
    <section class="slot">
      <header class="slot-head">
        <div>
          <h2 class="slot-club">${esc(shot.club)} · ${esc(shot.label)}</h2>
          <p class="helper-text">${esc(sourceLine(shot))}</p>
        </div>
        <button class="button" type="button" data-action="open-picker" data-slot="${slot}">Change shot</button>
      </header>
      ${viewSwitchHtml(slot, shot.label, view)}
      <div class="slot-view">${viewHtml(slot, shot, view)}</div>
      ${picker}
    </section>
  `;
}

function viewHtml(slot, shot, view) {
  if (view === "video") return videoHtml(slot, shot);
  if (view === "graph") return graphHtml(shot);
  if (view === "trajectory") return trajectoryBlock(slot, shot);
  if (view === "dispersion") return dispersionHtml(shot);
  if (view === "tiles") return numbersHtml(slot, shot, "tiles");
  return numbersHtml(slot, shot, "table");
}

function videoHtml(slot, shot) {
  const clip = state.video[slot];
  return `
    <div class="video-view">
      <div class="video-frame">
        <p class="video-label">Face-on · ${esc(shot.club)}</p>
        ${golferSvg(shot)}
      </div>
      <div class="video-controls">
        <button class="button" type="button" data-action="video" data-slot="${slot}" data-video-toggle="${slot}">${clip.playing ? "Pause" : "Play"}</button>
        <div class="video-track"><span data-video-bar="${slot}" style="width:${clip.progress * 100}%"></span></div>
      </div>
    </div>
  `;
}

function graphHtml(shot) {
  return `
    <div class="graph-view">
      <p class="helper-text">3D motion</p>
      <div class="view-stage">${golferSvg(shot)}</div>
      <p class="helper-text">This is the 3D motion view for this shot only. It does not change the other shot.</p>
    </div>
  `;
}

function trajectoryBlock(slot, shot) {
  return `
    <div class="trajectory-view">
      <div class="trajectory-host" data-traj-slot="${slot}"></div>
      <p class="traj-readout"><span>${shot.carry} yd</span> carry · <span>${shot.height} yd</span> apex</p>
    </div>
  `;
}

function trajectorySvg(shot) {
  const { flight } = shot;
  const afterSide = (flight.after && flight.after.side) || [];
  const afterTop = (flight.after && flight.after.top) || [];
  const xMax = Math.max(...flight.side.map((p) => p[0]), ...afterSide.map((p) => p[0]), 1);
  const apex = Math.max(...flight.side.map((p) => p[1]), 1);
  const maxOffline = Math.max(
    ...flight.top.map((p) => Math.abs(p[1])),
    ...afterTop.map((p) => Math.abs(p[1])),
    10,
  );
  const sideLine = polyline(flight.side, xMax, 120, 100 / apex);
  const topLine = polyline(flight.top, xMax, 70, -45 / maxOffline);
  const sideAfter = afterSide.length ? polyline(afterSide, xMax, 120, 100 / apex) : "";
  const topAfter = afterTop.length ? polyline(afterTop, xMax, 70, -45 / maxOffline) : "";
  return `
    <div class="traj-pair">
      <figure>
        <figcaption>Side</figcaption>
        <svg viewBox="0 0 320 140" role="img" aria-label="Side view of the ball flight">
          <line x1="16" y1="120" x2="304" y2="120" class="traj-ground" />
          ${sideAfter ? `<polyline points="${sideAfter}" class="traj-after" />` : ""}
          <polyline points="${sideLine}" class="traj-line" />
        </svg>
      </figure>
      <figure>
        <figcaption>Top</figcaption>
        <svg viewBox="0 0 320 140" role="img" aria-label="Top view of the ball flight">
          <line x1="16" y1="70" x2="304" y2="70" class="traj-ground" />
          ${topAfter ? `<polyline points="${topAfter}" class="traj-after" />` : ""}
          <polyline points="${topLine}" class="traj-line" />
        </svg>
      </figure>
    </div>
  `;
}

/** Maps [yards, value] pairs into the 320 x 140 drawing box. */
function polyline(points, xMax, baseline, perUnit) {
  return points
    .map(([x, v]) => {
      const px = 16 + (x / Math.max(xMax, 1)) * 288;
      const py = baseline - v * perUnit;
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(" ");
}

function dispersionHtml(shot) {
  const mates =
    shot.source === "Tour"
      ? []
      : shotsInSession(shot.sessionId, shot.club).filter((item) => item.id !== shot.id);
  const marks = [...mates.map((item) => ({ ...item, faint: true })), { ...shot, faint: false }];
  const fixedTargets = { Driver: 265, "7-iron": 165, "Pitching wedge": 115 };
  const target =
    fixedTargets[shot.club] || Math.round(marks.reduce((sum, m) => sum + m.carry, 0) / marks.length);
  return `
    <div class="dispersion-view">
      <div class="view-stage">
      <svg viewBox="0 0 280 280" role="img" aria-label="Dispersion of the shot against the target">
        <circle cx="140" cy="140" r="88" class="disp-ring" />
        <circle cx="140" cy="140" r="44" class="disp-ring" />
        <line x1="140" y1="20" x2="140" y2="260" class="traj-ground" />
        <line x1="20" y1="140" x2="260" y2="140" class="traj-ground" />
        <circle cx="140" cy="140" r="5" class="disp-target" />
        ${marks
          .map((item) => {
            const x = Math.max(12, Math.min(268, 140 + item.offline * 4));
            const y = Math.max(12, Math.min(268, 140 - (item.carry - target) * 3));
            const cls = item.faint ? "disp-mate" : "disp-shot";
            return `<circle cx="${x}" cy="${y}" r="${item.faint ? 4 : 6}" class="${cls}" />`;
          })
          .join("")}
        </svg>
      </div>
      <p class="traj-readout"><span>${shot.carry} yd</span> carry · ${esc(offlineLabel(shot.offline))}</p>
    </div>
  `;
}

function numbersHtml(slot, shot, kind) {
  const other = slot === "shell" ? null : otherShot(slot);
  const showDelta = Boolean(other) && state.showDifference && bothNumeric();
  const rows = metricDefs
    .map(([key, label, unit, digits]) => {
      const comparable = showDelta && shot[key] != null && other[key] != null;
      const delta = comparable
        ? `<span class="delta">${formatDelta(shot[key] - other[key], digits)}</span>`
        : "";
      if (kind === "tiles") {
        return `<div class="tile"><p class="tile-label">${label}</p><p class="tile-value">${formatMetric(shot[key], digits)}</p><p class="tile-unit">${unit || "&nbsp;"}${delta}</p></div>`;
      }
      const value = shot[key] == null ? "–" : `${formatMetric(shot[key], digits)}${unit ? ` ${unit}` : ""}`;
      return `<div class="table-row"><span>${label}</span><span class="table-value">${value}${delta}</span></div>`;
    })
    .join("");
  return kind === "tiles"
    ? `<div class="tile-grid">${rows}</div>`
    : `<div class="data-table">${rows}</div>`;
}

function golferSvg(shot) {
  const tilt = Math.max(-18, Math.min(18, shot.attackAngle * 3));
  return `
    <svg class="golfer" viewBox="0 0 220 180" role="img" aria-label="Player and club">
      <line x1="20" y1="160" x2="200" y2="160" class="traj-ground" />
      <g transform="translate(108 78) rotate(${tilt})">
        <circle cx="0" cy="-48" r="12" class="body" />
        <line x1="0" y1="-36" x2="0" y2="18" class="body-line" />
        <line x1="0" y1="-8" x2="34" y2="16" class="body-line" />
        <line x1="34" y1="16" x2="62" y2="48" class="club" />
        <line x1="0" y1="18" x2="-16" y2="58" class="body-line" />
        <line x1="0" y1="18" x2="14" y2="58" class="body-line" />
      </g>
    </svg>
  `;
}

function pickerHtml(slot) {
  const currentId = slot === "left" ? state.leftShotId : state.rightShotId;
  const labels = { session: "This session", history: "History", tour: "Tour library" };
  return `
    <div class="picker">
      <div class="picker-head">
        <div class="view-switch">
          ${["session", "history", "tour"]
            .map((source) => {
              const on = state.pickerSource === source ? " is-on" : "";
              return `<button class="view-button${on}" type="button" data-action="source" data-source="${source}">${labels[source]}</button>`;
            })
            .join("")}
        </div>
        <button class="text-button picker-close" type="button" data-action="close-picker">Close</button>
      </div>
      <div class="picker-list">${pickerRows(currentId)}</div>
    </div>
  `;
}

function groupedShotRows(shots, currentId) {
  return groupsFor(shots)
    .map(
      (group) => `
        <p class="picker-session">${esc(group.club)} · ${group.shots.length}</p>
        ${group.shots.map((shot) => shotRow(shot, currentId, "")).join("")}
      `,
    )
    .join("");
}

function pickerRows(currentId) {
  if (state.pickerSource === "session") {
    return groupedShotRows(currentShotsList(), currentId);
  }
  if (state.pickerSource === "tour") {
    return tourShots.map((shot) => shotRow(shot, currentId, shot.tourPlayer)).join("");
  }
  const session = historySessions.find((item) => item.id === state.historySessionId);
  if (!session) {
    return historySessions
      .map(
        (item) => `
          <button class="picker-session-row" type="button" data-action="history-session" data-session="${item.id}">
            <span>${esc(item.name)}</span>
            <span class="helper-text">${esc(item.date)} · ${item.shots.length} shots · ${esc(item.detail)}</span>
          </button>
        `,
      )
      .join("");
  }
  return `
    <button class="picker-back" type="button" data-action="history-back">All sessions</button>
    <p class="picker-session">${esc(session.name)} · ${esc(session.date)} · ${session.shots.length} shots</p>
    ${groupedShotRows(session.shots, currentId)}
  `;
}

function shotRow(shot, currentId, extra) {
  const on = shot.id === currentId ? " is-selected" : "";
  const detail = extra ? `${extra} · ` : "";
  return `
    <button class="picker-row${on}" type="button" data-action="choose" data-shot="${shot.id}">
      <span>${esc(shot.club)} · ${esc(shot.label)}</span>
      <span class="helper-text">${esc(detail)}${shot.carry} yd carry · ${shot.ballSpeed} mph</span>
    </button>
  `;
}

// Every debug control gets its label and its explanation through this helper.
// The explanation shows when the info icon is hovered or focused, so it takes no space.
function dbgLabel(label, caption) {
  return `
    <div class="dl-row">
      <span class="dl">${esc(label)}</span>
      <span class="dbg-info" tabindex="0" aria-label="${esc(label)}: ${esc(caption)}">
        <span class="dbg-info-icon" aria-hidden="true">i</span>
        <span class="dbg-tip" role="tooltip">${esc(caption)}</span>
      </span>
    </div>
  `;
}

function debugHtml() {
  const own = !state.showDifference;
  return `
    <div class="dbg-layer">
      <button class="dbg-fab" type="button" data-action="debug-toggle" title="Prototype controls">&#9874;</button>
      ${
        state.debugOpen
          ? `
            <div class="dbg-pop">
              <div class="dh">Prototype controls <span class="ver">v0.1</span></div>
              <div class="dbg-grp">
                ${dbgLabel("Theme", "Dark is the default look. Light swaps the page, slots, shot list and text to light greys. The orange stays the same. Nothing else changes, so both slots keep their shots and views.")}
                <div class="seg">
                  <button class="${state.theme === "light" ? "on" : ""}" type="button" data-action="theme" data-theme-value="light">Light</button>
                  <button class="${state.theme === "dark" ? "on" : ""}" type="button" data-action="theme" data-theme-value="dark">Dark</button>
                </div>
              </div>
              <div class="dbg-grp">
                ${dbgLabel("View selector", "Chips are separate rounded pills. Segmented joins the six views into one control with equal-width options. Only the look of the view switch changes. Each slot keeps its current view.")}
                <div class="seg">
                  <button class="${state.viewStyle === "chips" ? "on" : ""}" type="button" data-action="view-style" data-style-value="chips">Chips</button>
                  <button class="${state.viewStyle === "segmented" ? "on" : ""}" type="button" data-action="view-style" data-style-value="segmented">Segmented</button>
                </div>
              </div>
              <div class="dbg-grp">
                ${dbgLabel("Number comparison", "Own numbers shows each shot's values only. Show difference adds how this shot differs from the other one, and only when both slots are on Data tiles or Table. The difference is this shot minus the other shot. It is not coloured as better or worse. If either slot is another view, the numbers stay as they are.")}
                <div class="seg">
                  <button class="${own ? "on" : ""}" type="button" data-action="diff" data-diff="off">Own numbers</button>
                  <button class="${own ? "" : "on"}" type="button" data-action="diff" data-diff="on">Show difference</button>
                </div>
              </div>
              <div class="dbg-grp">
                ${dbgLabel("Shot list", "Panel opens the list over Compare and the slots stay the same width. Side column brings the list in from the left on the same layer and the slots get narrower.")}
                <div class="seg">
                  <button class="${state.shotListStyle === "panel" ? "on" : ""}" type="button" data-action="shot-list-style" data-list-style="panel">Panel</button>
                  <button class="${state.shotListStyle === "column" ? "on" : ""}" type="button" data-action="shot-list-style" data-list-style="column">Side column</button>
                </div>
              </div>
              <div class="dbg-grp">
                ${dbgLabel("Take a new shot", "This adds one simulated shot to the current session and selects it outside Compare. It does not replace a shot already in a Compare slot.")}
                <button class="dbg-btn" type="button" data-action="new-shot">Take a new shot</button>
              </div>
              <button class="dbg-btn danger" type="button" data-action="reset">Reset all state</button>
            </div>
          `
          : ""
      }
    </div>
  `;
}

root.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const { action } = target.dataset;

  if (action === "select") {
    const nextId = target.dataset.shot;
    if (nextId !== activeShotId()) {
      state.video.shell.playing = false;
      state.video.shell.progress = 0;
    }
    state.selectedShotId = nextId;
  } else if (action === "compare") {
    openCompare();
    return;
  } else if (action === "exit-compare") {
    state.screen = "shell";
    state.pickerSlot = null;
    state.shotListOpen = false;
    stopVideo();
  } else if (action === "toggle-shot-list") {
    state.shotListOpen = !state.shotListOpen;
    if (state.shotListOpen && state.shotListStyle === "column") slideShotList = true;
  } else if (action === "close-shot-list") {
    state.shotListOpen = false;
  } else if (action === "shot-list-style") {
    const next = target.dataset.listStyle;
    if (next === "panel" || next === "column") {
      if (next === "column" && state.shotListOpen && state.shotListStyle !== "column") slideShotList = true;
      state.shotListStyle = next;
    }
  } else if (action === "view") {
    const { slot, view } = target.dataset;
    if (slot === "left") state.leftView = view;
    else if (slot === "right") state.rightView = view;
    else state.shellView = view;
    if (state.video[slot]) {
      state.video[slot].playing = false;
      state.video[slot].progress = 0;
    }
  } else if (action === "open-picker") {
    state.pickerSlot = target.dataset.slot;
    state.pickerSource = "session";
    state.historySessionId = null;
  } else if (action === "close-picker") {
    state.pickerSlot = null;
  } else if (action === "source") {
    state.pickerSource = target.dataset.source;
    state.historySessionId = null;
  } else if (action === "history-session") {
    state.historySessionId = target.dataset.session;
  } else if (action === "history-back") {
    state.historySessionId = null;
  } else if (action === "choose") {
    if (state.pickerSlot === "left") state.leftShotId = target.dataset.shot;
    if (state.pickerSlot === "right") state.rightShotId = target.dataset.shot;
    state.video[state.pickerSlot].playing = false;
    state.video[state.pickerSlot].progress = 0;
    state.pickerSlot = null;
  } else if (action === "video") {
    const clip = state.video[target.dataset.slot];
    if (clip.progress >= 1) clip.progress = 0;
    clip.playing = !clip.playing;
  } else if (action === "debug-toggle") {
    state.debugOpen = !state.debugOpen;
  } else if (action === "view-style") {
    state.viewStyle = target.dataset.styleValue;
  } else if (action === "theme") {
    state.theme = target.dataset.themeValue;
  } else if (action === "diff") {
    state.showDifference = target.dataset.diff === "on";
  } else if (action === "new-shot") {
    const shot = addSimulatedShot();
    if (state.screen !== "compare") {
      state.video.shell.playing = false;
      state.video.shell.progress = 0;
      state.selectedShotId = shot.id;
    }
  } else if (action === "reset") {
    resetAll();
    return;
  }
  render();
});

/* Shot tracker: every radar shot lands in the current session, under "Radar". */
const radar = document.querySelector("trackman-radar");
if (radar) {
  radar.addEventListener("trackman:measurement", (event) => {
    if (applyMeasurement(event.detail)) render();
  });
}

render();
