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

const freshGraphClip = () => ({
  category: "ks",
  peaksOpen: true,
  rotation: ["pelvis-turn", "torso-turn"],
  translation: ["pelvis-sway", "torso-sway"],
  progress: 0.62,
});

const freshGraph = () => ({
  left: freshGraphClip(),
  right: freshGraphClip(),
  shell: freshGraphClip(),
});

const state = {
  screen: "shell",
  selectedShotId: null,
  leftShotId: null,
  rightShotId: null,
  leftView: "video",
  rightView: "video",
  shellView: "video",
  pickerSlot: null,
  pickerSource: "session",
  historySessionId: null,
  tourPlayerId: null,
  tourOpen: { Driver: false, Iron: false },
  closeStyle: "icon",
  showDifference: false,
  theme: "dark",
  viewStyle: "segmented",
  panelStyle: "flat",
  debugOpen: false,
  shotListOpen: false,
  shotListStyle: "panel",
  hideShotsWithoutVideo: false,
  shotNavStyle: "left",
  screenRatio: "16-9",
  fontFamily: "open-sans",
  compareSplit: 50,
  listMetric: "carry",
  videoTiles: { shell: false, left: false, right: false },
  video: freshVideo(),
  graph: freshGraph(),
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

function clipShot(slot) {
  if (slot === "shell") return getShot(activeShotId());
  return slotShot(slot);
}

function slotView(slot) {
  return slot === "left" ? state.leftView : state.rightView;
}

function otherShot(slot) {
  return slotShot(slot === "left" ? "right" : "left");
}

function showsNumbers(slot) {
  const view = slotView(slot);
  if (view === "tiles" || view === "table") return true;
  return view === "video" && Boolean(state.videoTiles[slot]);
}

function bothNumeric() {
  return Boolean(slotShot("left") && slotShot("right") && showsNumbers("left") && showsNumbers("right"));
}

function openCompare() {
  state.screen = "compare";
  state.leftShotId = activeShotId();
  state.rightShotId = null;
  state.leftView = "video";
  state.rightView = "video";
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
  state.leftView = "video";
  state.rightView = "video";
  state.shellView = "video";
  state.pickerSlot = null;
  state.pickerSource = "session";
  state.historySessionId = null;
  state.tourPlayerId = null;
  state.tourOpen = { Driver: false, Iron: false };
  state.closeStyle = "icon";
  state.showDifference = false;
  state.theme = "dark";
  state.viewStyle = "segmented";
  state.panelStyle = "flat";
  state.debugOpen = true;
  state.shotListOpen = false;
  state.shotListStyle = "panel";
  state.hideShotsWithoutVideo = false;
  state.shotNavStyle = "left";
  state.screenRatio = "16-9";
  state.fontFamily = "open-sans";
  state.compareSplit = 50;
  state.listMetric = "carry";
  state.videoTiles = { shell: false, left: false, right: false };
  state.video = freshVideo();
  state.graph = freshGraph();
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
    const shot = clipShot(slot);
    const still = root.querySelector(`[data-video-still="${slot}"]`);
    if (shot && still) {
      const next = stillSrc(shot, clip.angle, clip.progress);
      if (still.getAttribute("src") !== next) still.src = next;
    }
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

function stageSize() {
  if (state.screenRatio === "4-3") return { w: 1440, h: 1080 };
  return { w: 1440, h: 810 };
}

function fitStage() {
  const stage = root.querySelector(".ratio-stage");
  if (!stage) return;
  const { w, h } = stageSize();
  const scale = Math.min(window.innerWidth / w, window.innerHeight / h);
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  stage.style.transform = `scale(${scale})`;
  stage.style.left = `${(window.innerWidth - w * scale) / 2}px`;
  stage.style.top = `${(window.innerHeight - h * scale) / 2}px`;
}

function bindSplit() {
  const handle = root.querySelector(".compare-split");
  if (!handle) return;
  const apply = (percent) => {
    const next = Math.min(75, Math.max(25, percent));
    state.compareSplit = Math.round(next);
    const body = handle.parentElement;
    body.style.setProperty("--split-left", `${state.compareSplit}fr`);
    body.style.setProperty("--split-right", `${100 - state.compareSplit}fr`);
    handle.setAttribute("aria-valuenow", String(state.compareSplit));
  };
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      const rect = handle.parentElement.getBoundingClientRect();
      if (!rect.width) return;
      apply(((moveEvent.clientX - rect.left) / rect.width) * 100);
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  });
  handle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    apply(state.compareSplit + (event.key === "ArrowRight" ? 5 : -5));
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
  document.documentElement.dataset.panels = state.panelStyle;
  document.documentElement.dataset.font = state.fontFamily;
  const slide = slideShotList;
  slideShotList = false;
  parkVisualisers();
  const screen = state.screen === "shell" ? shellHtml() : compareHtml(slide);
  root.innerHTML = `<div class="ratio-fit"><div class="ratio-stage">${screen}</div></div>`;
  root.insertAdjacentHTML("beforeend", debugHtml());
  mountVisualisers();
  syncVideoTimer();
  fitStage();
  bindSplit();

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
          <div class="compare-body" style="--split-left:${state.compareSplit}fr; --split-right:${100 - state.compareSplit}fr">
            ${slotHtml("left")}
            <div class="compare-split" role="separator" aria-orientation="vertical" aria-label="Resize the two views" aria-valuemin="25" aria-valuemax="75" aria-valuenow="${state.compareSplit}" tabindex="0"></div>
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
  if (view === "graph") return graphHtml(slot, shot);
  if (view === "trajectory") return trajectoryBlock(slot, shot);
  if (view === "dispersion") return dispersionHtml(shot);
  if (view === "tiles") return numbersHtml(slot, shot, "tiles");
  return numbersHtml(slot, shot, "table");
}

function videoHtml(slot, shot) {
  if (!shot.hasVideo) return `<div class="video-view">${noVideoHtml()}</div>`;
  const clip = state.video[slot];
  const angle = clip.angle === "dl" ? "dl" : "fo";
  const open = Boolean(state.videoTiles[slot]);
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
        <button class="button video-tiles-toggle" type="button" data-action="video-tiles" data-slot="${slot}" aria-expanded="${open ? "true" : "false"}" aria-label="${open ? "Hide data tiles" : "Show data tiles"}">${chevron(open ? "up" : "down")}</button>
      </div>
      ${open ? `<div class="video-tiles">${tileMarkup(slot, shot)}</div>` : ""}
    </div>
  `;
}

const GRAPH_X0 = 52;
const GRAPH_X1 = 700;
const GRAPH_Y0 = 16;
const GRAPH_Y1 = 468;
const GRAPH_PARTS = {
  pelvis: { label: "Pelvis", color: "#e23b3b" },
  torso: { label: "Upper torso", color: "#3d9a5f" },
  head: { label: "Head", color: "#4c86e8" },
  arm: { label: "Lead arm", color: "#6b5bd2" },
  club: { label: "Club head", color: "#ec691a" },
  posture: { label: "Posture", color: "#e2b93b" },
};
const ROTATION_PARAMS = [
  { id: "turn", label: "Turn", dash: "solid" },
  { id: "bend", label: "Bend", dash: "dashed" },
  { id: "tilt", label: "Tilt", dash: "dotted" },
];
const TRANSLATION_PARAMS = [
  { id: "sway", label: "Sway", dash: "solid" },
  { id: "thrust", label: "Thrust", dash: "dashed" },
  { id: "lift", label: "Lift", dash: "dotted" },
];
const POSTURE_PARAMS = [
  { id: "tilt", label: "Tilt", dash: "solid", color: "#e2b93b" },
  { id: "bend", label: "Bend", dash: "dashed", color: "#7ec8e3" },
];
function shotSeed(shot) {
  return [...String(shot.id)].reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

function graphX(t) {
  return GRAPH_X0 + t * (GRAPH_X1 - GRAPH_X0);
}

function graphY(value, yMin, yMax) {
  const span = yMax - yMin || 1;
  const t = (value - yMin) / span;
  return GRAPH_Y1 - t * (GRAPH_Y1 - GRAPH_Y0);
}

function sampleCurve(item, t) {
  const main = Math.exp(-((t - item.at) ** 2) / (2 * 0.075 ** 2));
  const dip = Math.exp(-((t - (item.at - 0.16)) ** 2) / (2 * 0.045 ** 2));
  return item.peak * main - Math.abs(item.peak) * 0.22 * dip;
}

function ksSeries(shot) {
  const seed = shotSeed(shot);
  const pelvis = 420 + (seed % 50);
  const torso = pelvis + 210 + (seed % 30);
  const arm = torso + 190 + (seed % 40);
  const club = Math.min(1080, arm + 240 + (seed % 60));
  return [
    { key: "pelvis", label: "Pelvis", color: GRAPH_PARTS.pelvis.color, dash: "solid", peak: pelvis, at: 0.4, unit: "°/s" },
    { key: "torso", label: "Upper torso", color: GRAPH_PARTS.torso.color, dash: "solid", peak: torso, at: 0.5, unit: "°/s" },
    { key: "arm", label: "Lead arm", color: GRAPH_PARTS.arm.color, dash: "solid", peak: arm, at: 0.6, unit: "°/s" },
    { key: "club", label: "Club head", color: GRAPH_PARTS.club.color, dash: "solid", peak: club, at: 0.7, unit: "°/s" },
  ];
}

function paramDefs(category, segment) {
  if (segment === "posture") return category === "rotation" ? POSTURE_PARAMS : [];
  return category === "rotation" ? ROTATION_PARAMS : TRANSLATION_PARAMS;
}

function paramKey(segment, id) {
  return `${segment}-${id}`;
}

function selectedSeries(shot, clip) {
  const seed = shotSeed(shot);
  const keys = clip.category === "rotation" ? clip.rotation : clip.translation;
  return keys.map((key) => {
    const [segment, id] = key.split("-");
    const defs = paramDefs(clip.category, segment);
    const def = defs.find((item) => item.id === id) || { label: id, dash: "solid" };
    const part = GRAPH_PARTS[segment] || GRAPH_PARTS.pelvis;
    const color = def.color || part.color;
    const sign = (seed + key.length) % 2 === 0 ? 1 : -1;
    const mag = clip.category === "translation" ? 2 + (seed % 4) : 18 + (seed % 20);
    const at = 0.34 + ((seed + key.charCodeAt(0)) % 28) / 100;
    const label = `${part.label} ${def.label}`;
    return {
      key,
      label,
      color,
      dash: def.dash,
      peak: sign * mag * (segment === "club" ? 1 : 1),
      at,
      unit: clip.category === "translation" ? "in" : "°",
    };
  });
}

function visibleSeries(shot, clip) {
  if (clip.category === "ks") return ksSeries(shot);
  return selectedSeries(shot, clip);
}

function axisFor(series, category) {
  if (category === "ks") return { min: -400, max: 1000 };
  let min = 0;
  let max = 0;
  series.forEach((item) => {
    for (let i = 0; i <= 40; i += 1) {
      const value = sampleCurve(item, i / 40);
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  });
  if (max - min < 8) {
    min -= 8;
    max += 8;
  }
  const pad = (max - min) * 0.18;
  return { min: min - pad, max: max + pad };
}

function curvePoints(item, axis) {
  const pts = [];
  for (let i = 0; i <= 64; i += 1) {
    const t = i / 64;
    pts.push(`${graphX(t).toFixed(1)},${graphY(sampleCurve(item, t), axis.min, axis.max).toFixed(1)}`);
  }
  return pts.join(" ");
}

function dashAttr(dash) {
  if (dash === "dashed") return 'stroke-dasharray="7 4"';
  if (dash === "dotted") return 'stroke-dasharray="2 3"';
  return "";
}

function axisTicks(axis) {
  const ticks = [];
  for (let i = 0; i <= 4; i += 1) {
    const value = axis.max - ((axis.max - axis.min) * i) / 4;
    ticks.push({ value, y: graphY(value, axis.min, axis.max) });
  }
  return ticks;
}

function formatTick(value, category) {
  if (category === "ks") return String(Math.round(value));
  return Math.abs(value) >= 10 ? value.toFixed(0) : value.toFixed(1);
}

function graphChart(shot, clip) {
  const series = visibleSeries(shot, clip);
  const axis = axisFor(series, clip.category);
  const x = graphX(clip.progress);
  const guides = [
    ["P5", 0.22],
    ["P6", 0.36],
    ["P7", 0.5],
    ["P8", 0.64],
    ["P9", 0.78],
  ];
  const lines = series
    .map((item) => `<polyline points="${curvePoints(item, axis)}" fill="none" stroke="${item.color}" stroke-width="2.5" ${dashAttr(item.dash)} stroke-linejoin="round" stroke-linecap="round" />`)
    .join("");
  const bills = series
    .map((item) => {
      const value = sampleCurve(item, clip.progress);
      const y = graphY(value, axis.min, axis.max);
      return `<g data-billboard="${item.key}" transform="translate(${(x + 8).toFixed(1)} ${(y - 14).toFixed(1)})"><rect width="78" height="18" rx="2" fill="var(--surface-card)" stroke="${item.color}" /><text x="6" y="13" fill="var(--content-primary)" font-size="11">${Math.round(value)} ${item.unit}</text></g>`;
    })
    .join("");
  const ticks = axisTicks(axis)
    .map((tick) => `<text x="4" y="${(tick.y + 4).toFixed(1)}" fill="var(--content-secondary)" font-size="11">${formatTick(tick.value, clip.category)}</text>`)
    .join("");
  const pLabels = guides
    .map(([label, t]) => `<text x="${graphX(t)}" y="492" text-anchor="middle" fill="var(--content-secondary)" font-size="11">${label}</text><line x1="${graphX(t)}" y1="${GRAPH_Y0}" x2="${graphX(t)}" y2="${GRAPH_Y1}" stroke="var(--stroke-subtle)" stroke-dasharray="2 4" />`)
    .join("");
  const empty = series.length ? "" : `<text x="360" y="250" text-anchor="middle" fill="var(--content-secondary)" font-size="14">Turn on a parameter</text>`;
  return `
    <svg class="graph-svg" viewBox="0 0 720 508" role="img" aria-label="Motion graph">
      <line x1="${GRAPH_X0}" y1="${graphY(0, axis.min, axis.max)}" x2="${GRAPH_X1}" y2="${graphY(0, axis.min, axis.max)}" stroke="var(--stroke-subtle)" />
      ${pLabels}
      ${ticks}
      ${lines}
      ${empty}
      <line class="graph-playhead" x1="${x}" y1="${GRAPH_Y0}" x2="${x}" y2="${GRAPH_Y1}" stroke="var(--content-primary)" stroke-width="1.5" />
      ${bills}
    </svg>
  `;
}

function peakRows(series) {
  return series
    .map((item, index) => {
      const previous = series[index - 1];
      const gain = previous ? item.peak - previous.peak : null;
      const factor = previous && previous.peak ? item.peak / previous.peak : null;
      const gainText = gain == null ? "–" : `${gain > 0 ? "+" : ""}${Math.round(gain)}`;
      const factorText = factor == null ? "–" : factor.toFixed(2);
      return `<tr><th scope="row"><span class="graph-swatch" style="background:${item.color}"></span>${item.label}</th><td>${Math.round(item.peak)} °/s</td><td>${gainText}</td><td>${factorText}</td></tr>`;
    })
    .join("");
}

function peakBadges(series) {
  return [...series]
    .sort((a, b) => a.at - b.at)
    .map((item) => `<span class="graph-badge" style="background:${item.color}">${item.label}</span>`)
    .join("");
}

function chipGroup(slot, clip, segment) {
  const defs = paramDefs(clip.category, segment);
  if (!defs.length) return "";
  const selected = clip.category === "rotation" ? clip.rotation : clip.translation;
  const part = GRAPH_PARTS[segment];
  const chips = defs
    .map((def) => {
      const key = paramKey(segment, def.id);
      const on = selected.includes(key) ? " is-on" : "";
      const color = def.color || part.color;
      return `<button class="graph-chip${on}" type="button" data-action="graph-chip" data-slot="${slot}" data-key="${key}" data-dash="${def.dash}" style="--line:${color}">${def.label}</button>`;
    })
    .join("");
  return `
    <div class="graph-segment">
      <button class="graph-segment-name" type="button" data-action="graph-segment" data-slot="${slot}" data-segment="${segment}">${part.label}</button>
      ${chips}
    </div>
  `;
}

function graphHtml(slot, shot) {
  const clip = state.graph[slot];
  const categories = [
    ["ks", "Kinematic sequence"],
    ["rotation", "Rotations"],
    ["translation", "Translations"],
  ];
  const tabs = categories
    .map(([id, label]) => {
      const on = clip.category === id ? " is-on" : "";
      return `<button class="graph-tab${on}" type="button" data-action="graph-category" data-slot="${slot}" data-category="${id}">${label}</button>`;
    })
    .join("");
  const chips = clip.category === "ks"
    ? ""
    : `<div class="graph-chips">${["head", "torso", "pelvis", "posture"].map((segment) => chipGroup(slot, clip, segment)).join("")}</div>`;
  const peaks = clip.category === "ks"
    ? (() => {
        const series = ksSeries(shot);
        const open = clip.peaksOpen;
        return `
          <div class="graph-peaks">
            <button class="graph-peaks-toggle" type="button" data-action="graph-peaks" data-slot="${slot}" aria-expanded="${open ? "true" : "false"}">
              ${chevron(open ? "down" : "right")}
              <span>${open ? "Peak speeds" : "Peak order"}</span>
              ${open ? "" : `<span class="graph-badges">${peakBadges(series)}</span>`}
            </button>
            ${open ? `<table class="graph-peak-table"><thead><tr><th scope="col"></th><th scope="col">Peak speed</th><th scope="col">Speed gain</th><th scope="col">Gain factor</th></tr></thead><tbody>${peakRows(series)}</tbody></table>` : ""}
          </div>
        `;
      })()
    : "";
  return `
    <div class="graph-view" data-graph-slot="${slot}">
      <div class="graph-tabs" role="tablist" aria-label="Graph category">${tabs}</div>
      ${chips}
      <div class="graph-plot">
        ${peaks}
        ${graphChart(shot, clip)}
      </div>
      <label class="graph-scrub">
        <span class="helper-text">Swing position</span>
        <input type="range" min="0" max="1" step="0.01" value="${clip.progress}" data-graph-scrub="${slot}" aria-label="Swing position" />
      </label>
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

function normalizedMetric(shot, key) {
  const value = shot[key];
  if (value == null || Number.isNaN(Number(value))) return null;
  const seed = [...String(shot.id)].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const sign = seed % 2 === 0 ? 1 : -1;
  const step = (seed % 3) + 1;
  if (key === "spinRate") return value + sign * step * 35;
  if (key === "smash") return value + sign * step * 0.01;
  if (key === "carry" || key === "total" || key === "height" || key === "ballSpeed" || key === "clubSpeed") {
    return value + sign * step;
  }
  return value + sign * step * 0.2;
}

function metricText(value, unit, digits) {
  if (value == null || Number.isNaN(Number(value))) return "–";
  return `${formatMetric(value, digits)}${unit ? ` ${unit}` : ""}`;
}

function tileMarkup(slot, shot) {
  const other = slot === "shell" ? null : otherShot(slot);
  const showDelta = Boolean(other) && state.showDifference && bothNumeric();
  return metricDefs
    .map(([key, label, unit, digits]) => {
      const comparable = showDelta && shot[key] != null && other[key] != null;
      const delta = comparable
        ? `<span class="delta">${formatDelta(shot[key] - other[key], digits)}</span>`
        : "";
      return `<div class="tile"><p class="tile-label">${label}</p><p class="tile-value">${formatMetric(shot[key], digits)}</p><p class="tile-unit">${unit || "&nbsp;"}${delta}</p></div>`;
    })
    .join("");
}

function numbersHtml(slot, shot, kind) {
  const other = slot === "shell" ? null : otherShot(slot);
  const showDelta = Boolean(other) && state.showDifference && bothNumeric();
  if (kind === "tiles") return `<div class="tile-grid">${tileMarkup(slot, shot)}</div>`;
  const heads = metricDefs.map(([, label]) => `<th scope="col">${label}</th>`).join("");
  const cells = (useNormalized) =>
    metricDefs
      .map(([key, , unit, digits]) => {
        const raw = useNormalized ? normalizedMetric(shot, key) : shot[key];
        const comparable = showDelta && raw != null && (useNormalized ? normalizedMetric(other, key) : other[key]) != null;
        const otherRaw = comparable ? (useNormalized ? normalizedMetric(other, key) : other[key]) : null;
        const delta = comparable ? `<span class="delta">${formatDelta(raw - otherRaw, digits)}</span>` : "";
        return `<td>${metricText(raw, unit, digits)}${delta}</td>`;
      })
      .join("");
  return `
    <div class="data-table">
      <table>
        <thead>
          <tr><th scope="col"></th>${heads}</tr>
        </thead>
        <tbody>
          <tr><th scope="row">Actual</th>${cells(false)}</tr>
          <tr><th scope="row">Normalized</th>${cells(true)}</tr>
        </tbody>
      </table>
    </div>
  `;
}

const TOUR_KITS = ["rust", "green", "blue", "gold"];

/** Emma keeps navy. Each tour player keeps one of the other kits, chosen from their name. */
function kitFor(shot) {
  if (shot.source !== "Tour") return "navy";
  const name = shot.tourPlayer || "Tour";
  let n = 0;
  for (let i = 0; i < name.length; i += 1) n = (Math.imul(n, 33) + name.charCodeAt(i)) >>> 0;
  return TOUR_KITS[n % TOUR_KITS.length];
}

function stillMoment(progress) {
  const p = Number(progress) || 0;
  return p >= 0.2 && p < 0.65 ? "top" : "address";
}

function stillSrc(shot, angle, progress) {
  const view = angle === "dl" ? "dl" : "fo";
  return `images/video/${view}-${kitFor(shot)}-${stillMoment(progress)}.jpg`;
}

function videoScene(slot, shot, angle, progress) {
  const label = angle === "dl" ? "Down the line" : "Front on";
  return `<img class="video-still" data-video-still="${slot}" src="${stillSrc(shot, angle, progress)}" alt="${label} indoor range">`;
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
  const turn = { right: 0, down: 90, left: 180, up: -90 }[direction];
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
                ${dbgLabel("View selector", "Segmented is the default and joins the six views into one control with equal-width options. Chips are separate rounded pills. Only the look of the view switch changes. Each slot keeps its current view.")}
                <div class="seg">
                  <button class="${state.viewStyle === "segmented" ? "on" : ""}" type="button" data-action="view-style" data-style-value="segmented">Segmented</button>
                  <button class="${state.viewStyle === "chips" ? "on" : ""}" type="button" data-action="view-style" data-style-value="chips">Chips</button>
                </div>
              </div>
              <div class="dbg-grp">
                ${dbgLabel("Panel style", "Flat is the default. Slots and other content panels keep a border but have square corners and no padding around them, so the views get more room. Rounded brings back the rounded corners and padding. Buttons, view switches and the video still do not change.")}
                <div class="seg">
                  <button class="${state.panelStyle === "flat" ? "on" : ""}" type="button" data-action="panel-style" data-panel-style="flat">Flat</button>
                  <button class="${state.panelStyle === "rounded" ? "on" : ""}" type="button" data-action="panel-style" data-panel-style="rounded">Rounded</button>
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
                ${dbgLabel("Shot arrows", "Left puts both arrows on the left of Change shot. Either side puts one arrow on each side. Both still move to the shot above or below.")}
                <div class="seg">
                  <button class="${state.shotNavStyle === "left" ? "on" : ""}" type="button" data-action="shot-nav" data-nav-style="left">Left</button>
                  <button class="${state.shotNavStyle === "split" ? "on" : ""}" type="button" data-action="shot-nav" data-nav-style="split">Either side</button>
                </div>
              </div>
              <div class="dbg-grp">
                ${dbgLabel("Screen shape", "16:9 is the default wide frame. 4:3 is a taller frame. The prototype scales to fit the window and keeps that shape, with empty space around it when the window does not match.")}
                <div class="seg">
                  <button class="${state.screenRatio === "16-9" ? "on" : ""}" type="button" data-action="screen-ratio" data-ratio="16-9">16:9</button>
                  <button class="${state.screenRatio === "4-3" ? "on" : ""}" type="button" data-action="screen-ratio" data-ratio="4-3">4:3</button>
                </div>
              </div>
              <div class="dbg-grp">
                ${dbgLabel("Typeface", "One typeface is used for the whole prototype, including the large numbers. Open Sans is the default.")}
                <div class="seg">
                  <button class="${state.fontFamily === "open-sans" ? "on" : ""}" type="button" data-action="font" data-font="open-sans">Open Sans</button>
                  <button class="${state.fontFamily === "work-sans" ? "on" : ""}" type="button" data-action="font" data-font="work-sans">Work Sans</button>
                  <button class="${state.fontFamily === "lora" ? "on" : ""}" type="button" data-action="font" data-font="lora">Lora</button>
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
  } else if (action === "video-tiles") {
    const slot = target.dataset.slot;
    if (slot === "shell" || slot === "left" || slot === "right") state.videoTiles[slot] = !state.videoTiles[slot];
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
  } else if (action === "panel-style") {
    const next = target.dataset.panelStyle;
    if (next === "flat" || next === "rounded") state.panelStyle = next;
  } else if (action === "theme") {
    state.theme = target.dataset.themeValue;
  } else if (action === "hide-video") {
    state.hideShotsWithoutVideo = target.dataset.hideVideo === "on";
  } else if (action === "screen-ratio") {
    const next = target.dataset.ratio;
    if (next === "16-9" || next === "4-3") state.screenRatio = next;
  } else if (action === "font") {
    const next = target.dataset.font;
    if (next === "open-sans" || next === "work-sans" || next === "lora") state.fontFamily = next;
  } else if (action === "shot-nav") {
    const next = target.dataset.navStyle;
    if (next === "left" || next === "split") state.shotNavStyle = next;
  } else if (action === "close-style") {
    const next = target.dataset.closeStyle;
    if (next === "icon" || next === "both" || next === "word") state.closeStyle = next;
  } else if (action === "diff") {
    state.showDifference = target.dataset.diff === "on";
  } else if (action === "graph-category") {
    const clip = state.graph[target.dataset.slot];
    const next = target.dataset.category;
    if (clip && (next === "ks" || next === "rotation" || next === "translation")) clip.category = next;
  } else if (action === "graph-peaks") {
    const clip = state.graph[target.dataset.slot];
    if (clip) clip.peaksOpen = !clip.peaksOpen;
  } else if (action === "graph-chip") {
    const clip = state.graph[target.dataset.slot];
    const key = target.dataset.key;
    if (clip && key && clip.category !== "ks") {
      const list = clip.category === "rotation" ? clip.rotation : clip.translation;
      const index = list.indexOf(key);
      if (index >= 0) list.splice(index, 1);
      else list.push(key);
    }
  } else if (action === "graph-segment") {
    const clip = state.graph[target.dataset.slot];
    const segment = target.dataset.segment;
    if (clip && segment && clip.category !== "ks") {
      const ids = paramDefs(clip.category, segment).map((item) => paramKey(segment, item.id));
      const list = clip.category === "rotation" ? clip.rotation : clip.translation;
      const allOn = ids.length > 0 && ids.every((id) => list.includes(id));
      if (allOn) {
        ids.forEach((id) => {
          const index = list.indexOf(id);
          if (index >= 0) list.splice(index, 1);
        });
      } else {
        ids.forEach((id) => {
          if (!list.includes(id)) list.push(id);
        });
      }
    }
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

root.addEventListener("input", (event) => {
  const scrub = event.target.closest("[data-graph-scrub]");
  if (!scrub) return;
  const slot = scrub.dataset.graphScrub;
  const clip = state.graph[slot];
  if (!clip) return;
  clip.progress = Number(scrub.value);
  const shot = clipShot(slot);
  if (!shot) return;
  const host = scrub.closest("[data-graph-slot]");
  if (!host) return;
  const series = visibleSeries(shot, clip);
  const axis = axisFor(series, clip.category);
  const x = graphX(clip.progress);
  const line = host.querySelector(".graph-playhead");
  if (line) {
    line.setAttribute("x1", x);
    line.setAttribute("x2", x);
  }
  series.forEach((item) => {
    const node = host.querySelector(`[data-billboard="${item.key}"]`);
    if (!node) return;
    const value = sampleCurve(item, clip.progress);
    const y = graphY(value, axis.min, axis.max);
    node.setAttribute("transform", `translate(${(x + 8).toFixed(1)} ${(y - 14).toFixed(1)})`);
    const text = node.querySelector("text");
    if (text) text.textContent = `${Math.round(value)} ${item.unit}`;
  });
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

window.addEventListener("resize", fitStage);
