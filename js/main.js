import {
  addSimulatedShot,
  applyMeasurement,
  clearSimulatedShots,
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
  tourPlayers,
  views,
} from "./mockData.js";

const root = document.getElementById("app");

const freshClip = () => ({ playing: false, progress: 0, angle: "fo" });
const freshVideo = () => ({
  left: freshClip(),
  right: freshClip(),
  shell: freshClip(),
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
  tourPlayerId: null,
  tourOpen: { Driver: false, Iron: false },
  closeStyle: "icon",
  showDifference: false,
  theme: "dark",
  viewStyle: "chips",
  debugOpen: false,
  shotListOpen: false,
  shotListStyle: "panel",
  hideShotsWithoutVideo: false,
  shotNavStyle: "left",
  frameStyle: "session",
  listMetric: "carry",
  video: freshVideo(),
};

let videoTimer = null;
let slideShotList = false;
let scrollListToShot = false;

const shotListSelector = ".shotlist-scroll, .compare-shotlist-scroll";

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
  state.tourPlayerId = null;
  state.tourOpen = { Driver: false, Iron: false };
  state.closeStyle = "icon";
  state.showDifference = false;
  state.theme = "dark";
  state.viewStyle = "chips";
  state.debugOpen = true;
  state.shotListOpen = false;
  state.shotListStyle = "panel";
  state.hideShotsWithoutVideo = false;
  state.shotNavStyle = "left";
  state.frameStyle = "session";
  state.listMetric = "carry";
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
    applySwing(slot, clip.progress);
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
  return shot.live ? "Current session · Shot tracker" : "Current session";
}

/** Latest shot first. The array from the session is oldest first, so this copies it. */
function newestFirst(shots) {
  return [...shots].reverse();
}

/**
 * The list a compare slot steps through.
 * Current session and history are hit order, latest at the top.
 * A tour player's shots stay in the library order: Driver, then Iron.
 */
function orderedShotsFor(shot) {
  if (!shot) return [];
  if (shot.source === "Tour") {
    const person = tourPlayers.find((item) => item.shots.some((itemShot) => itemShot.id === shot.id));
    if (!person) return [shot];
    return [
      ...person.shots.filter((item) => item.club === "Driver"),
      ...person.shots.filter((item) => item.club !== "Driver"),
    ];
  }
  if (shot.source === "History") {
    const session = historySessions.find((item) => item.id === shot.sessionId);
    return session ? newestFirst(session.shots) : [shot];
  }
  const visible = newestFirst(visibleSessionShots());
  if (visible.some((item) => item.id === shot.id)) return visible;
  const visibleIds = new Set(visible.map((item) => item.id));
  return newestFirst(currentShotsList()).filter((item) => item.id === shot.id || visibleIds.has(item.id));
}

function stepEnds(shot) {
  const list = orderedShotsFor(shot);
  const index = list.findIndex((item) => item.id === shot.id);
  return {
    atTop: index <= 0,
    atBottom: index < 0 || index >= list.length - 1,
  };
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
  const page = document.scrollingElement;
  const pageTop = page ? page.scrollTop : 0;
  const pageLeft = page ? page.scrollLeft : 0;
  const listTops = [...root.querySelectorAll(shotListSelector)].map((el) => el.scrollTop);
  const revealShot = scrollListToShot;
  scrollListToShot = false;

  document.documentElement.dataset.theme = state.theme;
  document.documentElement.dataset.viewStyle = state.viewStyle;
  document.documentElement.dataset.frame = frameOn() ? "on" : "off";
  const slide = slideShotList;
  slideShotList = false;
  parkVisualisers();
  const screen = state.screen === "shell" ? shellHtml() : compareHtml(slide);
  root.innerHTML = withFrame(screen);
  root.insertAdjacentHTML("beforeend", debugHtml());
  mountVisualisers();
  syncVideoTimer();

  if (page) {
    page.scrollTop = pageTop;
    page.scrollLeft = pageLeft;
  }
  root.querySelectorAll(shotListSelector).forEach((el, index) => {
    if (listTops[index] != null) el.scrollTop = listTops[index];
  });
  if (revealShot) revealSelectedShot();
}

function revealSelectedShot() {
  const row = root.querySelector(".shot-row.is-selected");
  if (!row) return;
  const scroller = row.closest(shotListSelector);
  if (!scroller) return;

  const scrollerRect = scroller.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const slack = 1;
  const visible =
    Math.min(rowRect.bottom, scrollerRect.bottom) - Math.max(rowRect.top, scrollerRect.top);
  if (visible > slack) return;

  const sticky = scroller.querySelector(".shotlist-metric");
  const stickyHeight = sticky ? sticky.getBoundingClientRect().height : 0;
  if (rowRect.bottom <= scrollerRect.top + slack) {
    scroller.scrollTop -= scrollerRect.top + stickyHeight - rowRect.top;
  } else if (rowRect.top >= scrollerRect.bottom - slack) {
    scroller.scrollTop += rowRect.bottom - scrollerRect.bottom;
  }
}

function videoMark() {
  return `<svg class="video-mark" viewBox="0 0 16 16" role="img" aria-label="Video recorded"><rect x="1.5" y="4" width="9" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 6.8 L14.2 5 V11 L10.5 9.2 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

function noVideoHtml() {
  return `<div class="view-stage"><p class="no-video">No video was recorded for this shot.</p></div>`;
}

function visibleSessionShots() {
  const shots = currentShotsList();
  if (state.screen === "compare" && state.hideShotsWithoutVideo) {
    return shots.filter((shot) => shot.hasVideo);
  }
  return shots;
}

function listMetricHtml() {
  const options = metricDefs
    .map(([key, label]) => `<option value="${key}"${key === state.listMetric ? " selected" : ""}>${esc(label)}</option>`)
    .join("");
  return `<div class="shotlist-metric"><label class="helper-text" for="shotlist-metric">Show</label><select id="shotlist-metric" class="shotlist-metric-select" aria-label="Value shown in the shot list">${options}</select></div>`;
}

function listValue(shot) {
  const def = metricDefs.find(([key]) => key === state.listMetric) || ["carry", "Carry", "yd", 0];
  const [key, , unit, digits] = def;
  const text = formatMetric(shot[key], digits);
  if (text === "–" || !unit) return text;
  return `${text} ${unit}`;
}

function clubMark(club) {
  const slug = String(club).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `<span class="ball-dot" data-club="${esc(slug)}" title="${esc(club)}"></span>`;
}

function sessionShotRowsHtml() {
  const selectedId = activeShotId();
  return newestFirst(visibleSessionShots())
    .map((shot) => {
      const on = shot.id === selectedId ? " is-selected" : "";
      return `
        <button class="shot-row${on}" type="button" data-action="select" data-shot="${shot.id}">
          ${clubMark(shot.club)}
          <span>${esc(shot.label)}</span>
          <span class="shot-figures">${shot.hasVideo ? videoMark() : ""}<span class="shot-carry">${listValue(shot)}</span></span>
        </button>
      `;
    })
    .join("");
}

/** Hides in compare is the default. Always on keeps the window in both screens. */
function frameOn() {
  if (state.frameStyle === "always") return true;
  return state.screen !== "compare";
}

function withFrame(inner) {
  if (!frameOn()) return inner;
  return `
    <div class="product-frame">
      <div class="product-frame-bar product-frame-bar--top" aria-hidden="true"></div>
      <div class="product-frame-body">${inner}</div>
      <div class="product-frame-bar product-frame-bar--bottom" aria-hidden="true"></div>
    </div>
  `;
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
            ${listMetricHtml()}
            ${sessionShotRowsHtml()}
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
          <span class="shotlist-name">Current session</span>
          <span class="helper-text">${currentShotsList().length} shots · ${esc(currentSession.detail)}</span>
        </span>
        ${closeControl("close-shot-list")}
      </div>
      <div class="compare-shotlist-scroll">
        ${listMetricHtml()}
        ${sessionShotRowsHtml()}
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
          ${closeControl("close-shot-list", "compare-side-close")}
        </div>
        <div class="shotlist-scroll">
          ${listMetricHtml()}
          ${sessionShotRowsHtml()}
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
          <p class="helper-text">Choose a shot from this session, a historical session, or the tour player library.</p>
          <button class="button button--primary" type="button" data-action="open-picker" data-slot="${slot}">Add shot</button>
        </div>
        ${picker}
      </section>
    `;
  }

  const view = slotView(slot);
  const { atTop, atBottom } = stepEnds(shot);
  const prev = `<button class="button" type="button" data-action="step" data-slot="${slot}" data-dir="prev" aria-label="Previous shot"${atTop ? " disabled" : ""}>${chevron("left")}</button>`;
  const next = `<button class="button" type="button" data-action="step" data-slot="${slot}" data-dir="next" aria-label="Next shot"${atBottom ? " disabled" : ""}>${chevron("right")}</button>`;
  const change = `<button class="button" type="button" data-action="open-picker" data-slot="${slot}">Change shot</button>`;
  const arrows = state.shotNavStyle === "split"
    ? `${prev}${change}${next}`
    : `<span class="slot-step">${prev}${next}</span>${change}`;
  return `
    <section class="slot">
      <header class="slot-head">
        <div>
          <h2 class="slot-club">${esc(shot.club)} · ${esc(shot.label)}</h2>
          <p class="helper-text">${esc(sourceLine(shot))}</p>
        </div>
        <div class="slot-shot-nav${state.shotNavStyle === "split" ? "" : " is-left"}">
          ${arrows}
        </div>
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
  if (!shot.hasVideo) return `<div class="video-view">${noVideoHtml()}</div>`;
  const clip = state.video[slot];
  const angle = clip.angle === "dl" ? "dl" : "fo";
  const angleName = angle === "dl" ? "DL" : "FO";
  return `
    <div class="video-view">
      <div class="video-frame">
        <p class="video-label">${angleName} · ${esc(shot.club)}</p>
        ${videoScene(slot, shot, angle, clip.progress)}
      </div>
      <div class="video-controls">
        <div class="video-angle" role="group" aria-label="Camera angle">
          <button type="button" data-action="video-angle" data-slot="${slot}" data-angle="fo" aria-label="Front on" aria-pressed="${angle === "fo" ? "true" : "false"}"${angle === "fo" ? " class=\"on\"" : ""}>FO</button>
          <button type="button" data-action="video-angle" data-slot="${slot}" data-angle="dl" aria-label="Down the line" aria-pressed="${angle === "dl" ? "true" : "false"}"${angle === "dl" ? " class=\"on\"" : ""}>DL</button>
        </div>
        <button class="button" type="button" data-action="video" data-slot="${slot}" data-video-toggle="${slot}">${clip.playing ? "Pause" : "Play"}</button>
        <div class="video-track"><span data-video-bar="${slot}" style="width:${clip.progress * 100}%"></span></div>
      </div>
    </div>
  `;
}

function graphHtml(shot) {
  if (!shot.hasVideo) return `<div class="graph-view">${noVideoHtml()}</div>`;
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

const EMMA_KIT = { shirt: "#1b4f72", trousers: "#243040", cap: "#14384f" };
const TOUR_KITS = [
  { shirt: "#b5523a", trousers: "#2a2422", cap: "#8a3b28" },
  { shirt: "#2f7d57", trousers: "#1e2822", cap: "#1f5a3e" },
  { shirt: "#3e6cb5", trousers: "#22262e", cap: "#2c4e86" },
  { shirt: "#c4893a", trousers: "#2a261e", cap: "#8f6424" },
  { shirt: "#7a4b8a", trousers: "#261e2a", cap: "#583468" },
  { shirt: "#2a8f8a", trousers: "#1c2626", cap: "#1c6662" },
  { shirt: "#a33d55", trousers: "#2a1e22", cap: "#7a2c3e" },
  { shirt: "#5c6b32", trousers: "#22241c", cap: "#414c22" },
];

/** Emma keeps one kit. Each tour player keeps one kit, chosen from their name. */
function kitFor(shot) {
  if (shot.source !== "Tour") return EMMA_KIT;
  const name = shot.tourPlayer || "Tour";
  let n = 0;
  for (let i = 0; i < name.length; i += 1) n = (Math.imul(n, 33) + name.charCodeAt(i)) >>> 0;
  return TOUR_KITS[n % TOUR_KITS.length];
}

function swingPose(progress) {
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  const back = Math.sin((Math.min(p, 0.42) / 0.42) * Math.PI);
  const through = p > 0.42 ? (p - 0.42) / 0.58 : 0;
  return {
    arm: -back * 82 + through * 110,
    torso: -back * 14 + through * 20,
  };
}

function applySwing(slot, progress) {
  const pose = swingPose(progress);
  const torso = root.querySelector(`[data-swing-torso="${slot}"]`);
  const arm = root.querySelector(`[data-swing-arm="${slot}"]`);
  if (torso) {
    const sign = Number(torso.dataset.swingSign) || 1;
    const [x, y] = (torso.dataset.swingPivot || "0 0").split(" ");
    torso.setAttribute("transform", `rotate(${(pose.torso * sign).toFixed(1)} ${x} ${y})`);
  }
  if (arm) {
    const sign = Number(arm.dataset.swingSign) || 1;
    const [x, y] = (arm.dataset.swingPivot || "0 0").split(" ");
    arm.setAttribute("transform", `rotate(${(pose.arm * sign).toFixed(1)} ${x} ${y})`);
  }
}

function videoScene(slot, shot, angle, progress) {
  const kit = kitFor(shot);
  const pose = swingPose(progress);
  const sign = angle === "dl" ? -1 : 1;
  const bay = angle === "dl" ? bayDownTheLine(slot, kit, pose, sign) : bayFrontOn(slot, kit, pose, sign);
  const label = angle === "dl" ? "Down the line" : "Front on";
  return `<svg class="video-scene" viewBox="0 0 640 400" role="img" aria-label="${label} indoor range">${bay}</svg>`;
}

function bayFrontOn(slot, kit, pose, sign) {
  const torso = (pose.torso * sign).toFixed(1);
  const arm = (pose.arm * sign).toFixed(1);
  return `
    <rect width="640" height="400" fill="#14161c"/>
    <rect x="0" y="0" width="70" height="250" fill="#101218"/>
    <rect x="570" y="0" width="70" height="250" fill="#101218"/>
    <rect x="70" y="0" width="500" height="36" fill="#1c1f28"/>
    <rect x="120" y="8" width="90" height="8" rx="2" fill="#f2efe4" opacity="0.85"/>
    <rect x="275" y="8" width="90" height="8" rx="2" fill="#f2efe4" opacity="0.85"/>
    <rect x="430" y="8" width="90" height="8" rx="2" fill="#f2efe4" opacity="0.85"/>
    <rect x="110" y="48" width="420" height="168" rx="6" fill="#243044"/>
    <circle cx="320" cy="132" r="46" fill="none" stroke="#3d5168" stroke-width="2"/>
    <circle cx="320" cy="132" r="22" fill="none" stroke="#3d5168" stroke-width="2"/>
    <circle cx="320" cy="132" r="4" fill="#6d849c"/>
    <polygon points="0,230 640,230 640,400 0,400" fill="#2a2c31"/>
    <rect x="210" y="248" width="220" height="152" rx="8" fill="#1b3a30"/>
    <g class="bay-player" transform="translate(318 300)">
      <ellipse cx="4" cy="36" rx="46" ry="10" fill="#000" opacity="0.35"/>
      <rect x="-22" y="0" width="16" height="48" rx="6" fill="${kit.trousers}"/>
      <rect x="8" y="0" width="16" height="48" rx="6" fill="${kit.trousers}"/>
      <rect x="-24" y="40" width="20" height="8" rx="2" fill="#161616"/>
      <rect x="6" y="40" width="20" height="8" rx="2" fill="#161616"/>
      <g data-swing-torso="${slot}" data-swing-sign="${sign}" data-swing-pivot="0 -20" transform="rotate(${torso} 0 -20)">
        <rect x="-26" y="-78" width="52" height="64" rx="12" fill="${kit.shirt}"/>
        <rect x="-26" y="-78" width="18" height="64" rx="12" fill="#000" opacity="0.16"/>
        <circle cx="0" cy="-98" r="16" fill="#e8c4a8"/>
        <path d="M-17 -104 Q0 -124 17 -104 L15 -94 Q0 -108 -15 -94 Z" fill="${kit.cap}"/>
        <g data-swing-arm="${slot}" data-swing-sign="${sign}" data-swing-pivot="-8 -58" transform="rotate(${arm} -8 -58)">
          <rect x="-14" y="-64" width="12" height="34" rx="6" fill="${kit.shirt}"/>
          <line x1="-8" y1="-32" x2="-36" y2="10" stroke="#d5d8de" stroke-width="3" stroke-linecap="round"/>
          <rect x="-48" y="6" width="18" height="7" rx="1" fill="#f2f2f2" transform="rotate(-28 -39 10)"/>
        </g>
      </g>
      <circle cx="-24" cy="22" r="4.5" fill="#f7f7f7"/>
    </g>
  `;
}

function bayDownTheLine(slot, kit, pose, sign) {
  const torso = (pose.torso * sign).toFixed(1);
  const arm = (pose.arm * sign).toFixed(1);
  return `
    <rect width="640" height="400" fill="#14161c"/>
    <polygon points="70,400 570,400 430,150 210,150" fill="#23262c"/>
    <polygon points="248,400 392,400 356,214 284,214" fill="#1b3a30"/>
    <line x1="320" y1="392" x2="320" y2="186" stroke="#ffffff" stroke-opacity="0.18" stroke-width="2"/>
    <polygon points="210,150 430,150 470,36 170,36" fill="#101218"/>
    <rect x="236" y="52" width="168" height="98" rx="4" fill="#243044"/>
    <circle cx="320" cy="102" r="28" fill="none" stroke="#3d5168" stroke-width="2"/>
    <circle cx="320" cy="102" r="12" fill="none" stroke="#3d5168" stroke-width="2"/>
    <circle cx="320" cy="102" r="3" fill="#6d849c"/>
    <rect x="150" y="0" width="340" height="22" fill="#1c1f28"/>
    <rect x="250" y="4" width="140" height="7" rx="2" fill="#f2efe4" opacity="0.8"/>
    <g class="bay-player" transform="translate(320 292)">
      <ellipse cx="0" cy="48" rx="54" ry="12" fill="#000" opacity="0.35"/>
      <rect x="-18" y="8" width="14" height="52" rx="6" fill="${kit.trousers}"/>
      <rect x="6" y="8" width="14" height="52" rx="6" fill="${kit.trousers}"/>
      <rect x="-20" y="52" width="18" height="8" rx="2" fill="#161616"/>
      <rect x="4" y="52" width="18" height="8" rx="2" fill="#161616"/>
      <g data-swing-torso="${slot}" data-swing-sign="${sign}" data-swing-pivot="0 -8" transform="rotate(${torso} 0 -8)">
        <rect x="-28" y="-70" width="56" height="78" rx="14" fill="${kit.shirt}"/>
        <rect x="6" y="-70" width="22" height="78" rx="12" fill="#000" opacity="0.14"/>
        <circle cx="0" cy="-92" r="18" fill="#e8c4a8"/>
        <path d="M-18 -98 Q0 -120 18 -98 L18 -88 Q0 -102 -18 -88 Z" fill="${kit.cap}"/>
        <g data-swing-arm="${slot}" data-swing-sign="${sign}" data-swing-pivot="4 -28" transform="rotate(${arm} 4 -28)">
          <rect x="-2" y="-40" width="14" height="26" rx="6" fill="${kit.shirt}"/>
          <line x1="6" y1="-16" x2="28" y2="24" stroke="#d5d8de" stroke-width="3" stroke-linecap="round"/>
          <rect x="22" y="20" width="16" height="6" rx="1" fill="#f2f2f2" transform="rotate(18 30 23)"/>
        </g>
      </g>
      <circle cx="34" cy="28" r="4" fill="#f7f7f7"/>
    </g>
  `;
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

function chevron(direction) {
  const turn = { right: 0, down: 90, left: 180 }[direction];
  return `<svg class="chevron" viewBox="0 0 16 16" aria-hidden="true" style="transform:rotate(${turn}deg)"><path d="M6 3.5 L10.5 8 L6 12.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function closeControl(action, extraClass = "") {
  const icon = `<svg class="icon-x" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4 L12 12 M12 4 L4 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  const word = state.closeStyle === "icon" ? "" : "<span>Close</span>";
  const mark = state.closeStyle === "word" ? "" : icon;
  return `<button class="close-control close-control--${state.closeStyle} ${extraClass}" type="button" data-action="${action}" aria-label="Close">${mark}${word}</button>`;
}

function clearTour() {
  state.tourPlayerId = null;
  state.tourOpen = { Driver: false, Iron: false };
}

function pickerHtml(slot) {
  const currentId = slot === "left" ? state.leftShotId : state.rightShotId;
  const labels = { session: "Current session", history: "History", tour: "Tour library" };
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
        ${closeControl("close-picker", "picker-close")}
      </div>
      <div class="picker-list">${pickerRows(currentId)}</div>
    </div>
  `;
}

function orderedShotRows(shots, currentId) {
  return newestFirst(shots)
    .map((shot) => shotRow(shot, currentId, ""))
    .join("");
}

function pickerRows(currentId) {
  if (state.pickerSource === "session") {
    return orderedShotRows(visibleSessionShots(), currentId);
  }
  if (state.pickerSource === "tour") return tourRows(currentId);
  const session = historySessions.find((item) => item.id === state.historySessionId);
  if (!session) {
    return historySessions
      .map(
        (item) => `
          <button class="picker-session-row" type="button" data-action="history-session" data-session="${item.id}">
            <span class="picker-session-copy">
              <span>${esc(item.name)}</span>
              <span class="helper-text">${esc(item.date)} · ${item.shots.length} shots · ${esc(item.detail)}</span>
            </span>
            ${chevron("right")}
          </button>
        `,
      )
      .join("");
  }
  return `
    <button class="picker-back" type="button" data-action="history-back">${chevron("left")}<span>All sessions</span></button>
    <p class="picker-session">${esc(session.name)} · ${esc(session.date)} · ${session.shots.length} shots</p>
    ${orderedShotRows(session.shots, currentId)}
  `;
}

function tourRows(currentId) {
  const person = tourPlayers.find((item) => item.id === state.tourPlayerId);
  if (!person) {
    return tourPlayers
      .map(
        (item) => `
          <button class="picker-session-row" type="button" data-action="tour-player" data-player="${item.id}">
            <span class="picker-session-copy">
              <span>${esc(item.name)}</span>
              <span class="helper-text">${item.shots.length} ${item.shots.length === 1 ? "shot" : "shots"}</span>
            </span>
            ${chevron("right")}
          </button>
        `,
      )
      .join("");
  }
  const groups = [
    ["Driver", person.shots.filter((shot) => shot.club === "Driver")],
    ["Iron", person.shots.filter((shot) => shot.club !== "Driver")],
  ].filter(([, shots]) => shots.length);
  return `
    <button class="picker-back" type="button" data-action="tour-back">${chevron("left")}<span>All players</span></button>
    <p class="picker-session">${esc(person.name)} · ${person.shots.length} ${person.shots.length === 1 ? "shot" : "shots"}</p>
    ${groups
      .map(([club, shots]) => {
        const open = state.tourOpen[club];
        return `
          <button class="tour-club" type="button" data-action="tour-club" data-club="${club}" aria-expanded="${open ? "true" : "false"}">
            <span>${club} · ${shots.length}</span>
            ${chevron(open ? "down" : "right")}
          </button>
          ${open ? shots.map((shot) => shotRow(shot, currentId, "")).join("") : ""}
        `;
      })
      .join("")}
  `;
}

function shotRow(shot, currentId, extra) {
  const on = shot.id === currentId ? " is-selected" : "";
  const detail = extra ? `${extra} · ` : "";
  return `
    <button class="picker-row${on}" type="button" data-action="choose" data-shot="${shot.id}">
      ${clubMark(shot.club)}
      <span class="picker-row-copy">
        <span>${esc(shot.club)} · ${esc(shot.label)}</span>
        <span class="helper-text">${esc(detail)}${shot.carry} yd carry · ${shot.ballSpeed} mph</span>
      </span>
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
                ${dbgLabel("Studio frame", "Hides in compare shows the Performance Studio window on the main screen and removes it in Compare, so Compare can use the full window. Always on keeps that window around both screens, so Compare has less height. Nothing in the window can be clicked.")}
                <div class="seg">
                  <button class="${state.frameStyle === "session" ? "on" : ""}" type="button" data-action="frame-style" data-frame-style="session">Hides in compare</button>
                  <button class="${state.frameStyle === "always" ? "on" : ""}" type="button" data-action="frame-style" data-frame-style="always">Always on</button>
                </div>
              </div>
              <div class="dbg-grp">
                ${dbgLabel("Shot arrows", "Left puts both arrows on the left of Change shot. Either side puts one arrow on each side. Both still move to the shot above or below.")}
                <div class="seg">
                  <button class="${state.shotNavStyle === "left" ? "on" : ""}" type="button" data-action="shot-nav" data-nav-style="left">Left</button>
                  <button class="${state.shotNavStyle === "split" ? "on" : ""}" type="button" data-action="shot-nav" data-nav-style="split">Either side</button>
                </div>
              </div>
              <div class="dbg-grp">
                ${dbgLabel("Close control", "Icon only shows an X. Icon and word shows the X and the word Close. Word only shows Close. Closing still does the same thing.")}
                <div class="seg">
                  <button class="${state.closeStyle === "icon" ? "on" : ""}" type="button" data-action="close-style" data-close-style="icon">Icon</button>
                  <button class="${state.closeStyle === "both" ? "on" : ""}" type="button" data-action="close-style" data-close-style="both">Icon and word</button>
                  <button class="${state.closeStyle === "word" ? "on" : ""}" type="button" data-action="close-style" data-close-style="word">Word</button>
                </div>
              </div>
              <div class="dbg-grp">
                ${dbgLabel("Shots without video", "Show all keeps every session shot in the lists. Hide in compare removes session shots that have no video from the Compare shot list and from Change shot, Current session. The main screen still shows them. History and the tour library stay. A shot already in a slot stays there.")}
                <div class="seg">
                  <button class="${state.hideShotsWithoutVideo ? "" : "on"}" type="button" data-action="hide-video" data-hide-video="off">Show all</button>
                  <button class="${state.hideShotsWithoutVideo ? "on" : ""}" type="button" data-action="hide-video" data-hide-video="on">Hide in compare</button>
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
    scrollListToShot = true;
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
  } else if (action === "step") {
    const slot = target.dataset.slot;
    const shot = slot === "left" || slot === "right" ? slotShot(slot) : null;
    const list = shot ? orderedShotsFor(shot) : [];
    const index = shot ? list.findIndex((item) => item.id === shot.id) : -1;
    const next = list[index + (target.dataset.dir === "prev" ? -1 : 1)];
    if (next && !target.disabled) {
      if (slot === "left") state.leftShotId = next.id;
      else state.rightShotId = next.id;
      state.video[slot].playing = false;
      state.video[slot].progress = 0;
    }
  } else if (action === "open-picker") {
    state.pickerSlot = target.dataset.slot;
    state.pickerSource = "session";
    state.historySessionId = null;
    clearTour();
  } else if (action === "close-picker") {
    state.pickerSlot = null;
  } else if (action === "source") {
    state.pickerSource = target.dataset.source;
    state.historySessionId = null;
    clearTour();
  } else if (action === "history-session") {
    state.historySessionId = target.dataset.session;
  } else if (action === "history-back") {
    state.historySessionId = null;
  } else if (action === "tour-player") {
    state.tourPlayerId = target.dataset.player;
    state.tourOpen = { Driver: false, Iron: false };
  } else if (action === "tour-back") {
    clearTour();
  } else if (action === "tour-club") {
    const club = target.dataset.club;
    if (club === "Driver" || club === "Iron") state.tourOpen[club] = !state.tourOpen[club];
  } else if (action === "choose") {
    if (state.pickerSlot === "left") state.leftShotId = target.dataset.shot;
    if (state.pickerSlot === "right") state.rightShotId = target.dataset.shot;
    state.video[state.pickerSlot].playing = false;
    state.video[state.pickerSlot].progress = 0;
    state.pickerSlot = null;
  } else if (action === "video-angle") {
    const clip = state.video[target.dataset.slot];
    const angle = target.dataset.angle;
    if (clip && (angle === "fo" || angle === "dl")) clip.angle = angle;
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
  } else if (action === "hide-video") {
    state.hideShotsWithoutVideo = target.dataset.hideVideo === "on";
  } else if (action === "frame-style") {
    const next = target.dataset.frameStyle;
    if (next === "session" || next === "always") state.frameStyle = next;
  } else if (action === "shot-nav") {
    const next = target.dataset.navStyle;
    if (next === "left" || next === "split") state.shotNavStyle = next;
  } else if (action === "close-style") {
    const next = target.dataset.closeStyle;
    if (next === "icon" || next === "both" || next === "word") state.closeStyle = next;
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

root.addEventListener("change", (event) => {
  const select = event.target.closest(".shotlist-metric-select");
  if (!select) return;
  if (metricDefs.some(([key]) => key === select.value)) state.listMetric = select.value;
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
