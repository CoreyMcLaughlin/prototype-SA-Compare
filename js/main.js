import {
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
});

const state = {
  screen: "shell",
  selectedShotId: null,
  leftShotId: null,
  rightShotId: null,
  leftView: "trajectory",
  rightView: "tiles",
  pickerSlot: null,
  pickerSource: "session",
  showDifference: false,
  debugOpen: false,
  video: freshVideo(),
};

let videoTimer = null;

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
  state.video = freshVideo();
  stopVideo();
  render();
}

function resetAll() {
  stopVideo();
  const keepScreen = state.screen;
  state.selectedShotId = null;
  state.rightShotId = null;
  state.leftShotId = keepScreen === "compare" ? latestShot().id : null;
  state.leftView = "trajectory";
  state.rightView = "tiles";
  state.pickerSlot = null;
  state.pickerSource = "session";
  state.showDifference = false;
  state.debugOpen = true;
  state.video = freshVideo();
  render();
}

function stopVideo() {
  state.video.left.playing = false;
  state.video.right.playing = false;
  if (videoTimer) {
    clearInterval(videoTimer);
    videoTimer = null;
  }
}

function syncVideoTimer() {
  const playing = state.video.left.playing || state.video.right.playing;
  if (playing && !videoTimer) videoTimer = setInterval(tickVideo, 100);
  if (!playing && videoTimer) {
    clearInterval(videoTimer);
    videoTimer = null;
  }
}

function tickVideo() {
  ["left", "right"].forEach((slot) => {
    const clip = state.video[slot];
    if (!clip.playing) return;
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
  return "This session";
}

function groupsFor(shots) {
  return clubOrder
    .map((club) => ({ club, shots: shots.filter((shot) => shot.club === club) }))
    .filter((group) => group.shots.length);
}

function render() {
  root.innerHTML = state.screen === "shell" ? shellHtml() : compareHtml();
  root.insertAdjacentHTML("beforeend", debugHtml());
  syncVideoTimer();
}

function shellHtml() {
  const selected = getShot(activeShotId());
  const groups = groupsFor(currentShotsList());
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
              <span class="helper-text">${esc(currentSession.detail)}</span>
            </span>
          </div>
          <div class="shotlist-scroll">
            ${groups
              .map(
                (group) => `
                  <div class="club-group">
                    <div class="club-group-label">
                      <span>${esc(group.club)}</span>
                      <span class="inert-meta">${group.shots.length}</span>
                    </div>
                    ${group.shots
                      .map((shot) => {
                        const on = shot.id === selected.id ? " is-selected" : "";
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
              .join("")}
          </div>
          <div class="shotlist-bottom">
            <button class="button button--primary compare-launch" type="button" data-action="compare">Compare</button>
            <input class="field" disabled placeholder="Search shots" aria-label="Search shots" />
          </div>
        </aside>
        <section class="shell-stage" aria-label="Shot preview">
          <div class="stage-inert">
            <p class="helper-text">Selected shot</p>
            <h1 class="page-title">${esc(selected.club)} · ${esc(selected.label)}</h1>
            <p class="stage-carry"><span>${selected.carry}</span> yd carry</p>
            ${trajectorySvg(selected)}
            <p class="helper-text">The rest of this screen is here so Compare has a place to live. Use Compare to put this shot next to another.</p>
          </div>
        </section>
      </div>
    </div>
  `;
}

function compareHtml() {
  return `
    <div class="app-shell">
      <header class="topbar">
        <button class="text-button" type="button" data-action="back">Shot list</button>
        <p class="topbar-product">Shot Analysis · Compare</p>
        <p class="topbar-player">${esc(player.name)}</p>
        <p class="topbar-session">${esc(currentSession.name)} · ${esc(currentSession.date)}</p>
      </header>
      <div class="compare-body">
        ${slotHtml("left")}
        ${slotHtml("right")}
      </div>
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
      <div class="view-switch" role="tablist" aria-label="View for ${esc(shot.label)}">
        ${views
          .map(([id, label]) => {
            const on = id === view ? " is-on" : "";
            return `<button class="view-button${on}" type="button" data-action="view" data-slot="${slot}" data-view="${id}">${label}</button>`;
          })
          .join("")}
      </div>
      <div class="slot-view">${viewHtml(slot, shot, view)}</div>
      ${picker}
    </section>
  `;
}

function viewHtml(slot, shot, view) {
  if (view === "video") return videoHtml(slot, shot);
  if (view === "graph") return graphHtml(shot);
  if (view === "trajectory") return trajectoryBlock(shot);
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
      ${golferSvg(shot)}
      <p class="helper-text">This is the 3D motion view for this shot only. It does not change the other shot.</p>
    </div>
  `;
}

function trajectoryBlock(shot) {
  return `
    <div class="trajectory-view">
      ${trajectorySvg(shot)}
      <p class="traj-readout"><span>${shot.carry} yd</span> carry · <span>${shot.height} yd</span> apex</p>
    </div>
  `;
}

function trajectorySvg(shot) {
  const maxOffline = Math.max(Math.abs(shot.offline), 10);
  const side = polyline(shot.flight.side, shot.carry, 120, 100 / Math.max(shot.height, 1));
  const top = polyline(shot.flight.top, shot.carry, 70, -45 / maxOffline);
  return `
    <div class="traj-pair">
      <figure>
        <figcaption>Side</figcaption>
        <svg viewBox="0 0 320 140" role="img" aria-label="Side view of the ball flight">
          <line x1="16" y1="120" x2="304" y2="120" class="traj-ground" />
          <polyline points="${side}" class="traj-line" />
        </svg>
      </figure>
      <figure>
        <figcaption>Top</figcaption>
        <svg viewBox="0 0 320 140" role="img" aria-label="Top view of the ball flight">
          <line x1="16" y1="70" x2="304" y2="70" class="traj-ground" />
          <polyline points="${top}" class="traj-line" />
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
  const target = shot.club === "Driver" ? 265 : shot.club === "7-iron" ? 165 : 115;
  return `
    <div class="dispersion-view">
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
      <p class="traj-readout"><span>${shot.carry} yd</span> carry · ${esc(offlineLabel(shot.offline))}</p>
    </div>
  `;
}

function numbersHtml(slot, shot, kind) {
  const other = otherShot(slot);
  const showDelta = state.showDifference && bothNumeric() && other;
  const rows = metricDefs
    .map(([key, label, unit, digits]) => {
      const delta = showDelta
        ? `<span class="delta">${formatDelta(shot[key] - other[key], digits)}</span>`
        : "";
      if (kind === "tiles") {
        return `<div class="tile"><p class="tile-label">${label}</p><p class="tile-value">${formatMetric(shot[key], digits)}</p><p class="tile-unit">${unit || "&nbsp;"}${delta}</p></div>`;
      }
      const value = `${formatMetric(shot[key], digits)}${unit ? ` ${unit}` : ""}`;
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

function pickerRows(currentId) {
  if (state.pickerSource === "session") {
    return currentShotsList()
      .map((shot) => shotRow(shot, currentId, ""))
      .join("");
  }
  if (state.pickerSource === "tour") {
    return tourShots.map((shot) => shotRow(shot, currentId, shot.tourPlayer)).join("");
  }
  return historySessions
    .map(
      (session) => `
        <p class="picker-session">${esc(session.name)} · ${esc(session.date)}</p>
        ${session.shots.map((shot) => shotRow(shot, currentId, "")).join("")}
      `,
    )
    .join("");
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
                <div class="dl">Number comparison</div>
                <div class="seg">
                  <button class="${own ? "on" : ""}" type="button" data-action="diff" data-diff="off">Own numbers</button>
                  <button class="${own ? "" : "on"}" type="button" data-action="diff" data-diff="on">Show difference</button>
                </div>
                <p class="dbg-cap">Own numbers shows each shot's values only. Show difference adds how this shot differs from the other one, and only when both slots are on Data tiles or Table. The difference is this shot minus the other shot. It is not coloured as better or worse. If either slot is another view, the numbers stay as they are.</p>
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
    state.selectedShotId = target.dataset.shot;
  } else if (action === "compare") {
    openCompare();
    return;
  } else if (action === "back") {
    state.screen = "shell";
    state.pickerSlot = null;
    stopVideo();
  } else if (action === "view") {
    const { slot, view } = target.dataset;
    if (slot === "left") state.leftView = view;
    else state.rightView = view;
    state.video[slot].playing = false;
    state.video[slot].progress = 0;
  } else if (action === "open-picker") {
    state.pickerSlot = target.dataset.slot;
    state.pickerSource = "session";
  } else if (action === "close-picker") {
    state.pickerSlot = null;
  } else if (action === "source") {
    state.pickerSource = target.dataset.source;
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
  } else if (action === "diff") {
    state.showDifference = target.dataset.diff === "on";
  } else if (action === "reset") {
    resetAll();
    return;
  }
  render();
});

render();
