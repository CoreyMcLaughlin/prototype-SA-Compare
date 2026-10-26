(function () {
  'use strict';

  const FALLBACK_IPS = ['172.30.20.1', '169.254.0.1'];
  const DISCOVERY_TIMEOUT_MS = 5000;
  const DEFAULT_MAX_SHOTS = 200;
  const RECONNECT_ATTEMPTS = 3;
  const RECONNECT_DELAY_MS = 3000;
  const HEARTBEAT_TIMEOUT_MS = 15000;
  const SETUP_RECONCILE_PING_MS = 5000;
  const LOCALSTORAGE_KEY = 'trackman-radar-last-device';
  const UNITS_KEY = 'trackman-radar-units';
  const ENVIRONMENT_KEY = 'trackman-radar-environment';
  const DOT_POS_KEY = 'trackman-radar-dot-pos';
  const DB_NAME = 'trackman-radar';
  const DB_STORE = 'shots';

  const UNIT_PRESETS = [
    { key: 'yds/mph', label: 'yds / mph', distance: 'yds', velocity: 'mph' },
    { key: 'm/mph', label: 'm / mph', distance: 'm', velocity: 'mph' },
    { key: 'yds-ft/mph', label: 'yds·ft / mph', distance: 'yds-ft', velocity: 'mph' },
    { key: 'm/ms', label: 'm / m/s', distance: 'm', velocity: 'm/s' },
    { key: 'yds/ms', label: 'yds / m/s', distance: 'yds', velocity: 'm/s' },
  ];

  const PUTTING_API_MODE = 'Golf.SimulatorPutting';
  const PUTTING_API_MODES = new Set(['Golf.SimulatorPutting', 'Golf.PerformancePutting']);

  function normalizeDesiredEnvironment(value) {
    if (value === 'Golf.Outdoor' || value === 'Outdoor') return 'Golf.Outdoor';
    return 'Golf.Indoor';
  }

  function modeToLabel(apiMode) {
    if (apiMode === 'Golf.Indoor') return 'Indoor';
    if (apiMode === 'Golf.Outdoor') return 'Outdoor';
    if (PUTTING_API_MODES.has(apiMode)) return 'Putting';
    if (typeof apiMode === 'string' && apiMode.startsWith('Golf.')) return apiMode.slice(5);
    return apiMode || 'Unknown';
  }

  class TrackmanRadar extends HTMLElement {

    static get observedAttributes() {
      return ['ip', 'max-shots'];
    }

    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `<style></style><div id="status-dot"></div><div id="modal-root"></div>`;

      this._devices = [];
      this._ws = null;
      this._connectionState = 'disconnected';
      this._connectedDevice = null;
      this._reconnectCount = 0;
      this._reconnectTimer = null;
      this._discoveryTimer = null;
      this._probeSockets = [];
      this._db = null;
      this._lastMeasurementId = null;
      this._units = this._loadSetting(UNITS_KEY, 'yds/mph');
      // Desired Indoor/Outdoor intent (persisted). Never overwritten by GET/SystemState.
      this._desiredEnvironment = normalizeDesiredEnvironment(
        this._loadSetting(ENVIRONMENT_KEY, 'Golf.Indoor')
      );
      // Last confirmed radar MeasurementMode (what the UI shows).
      this._environment = this._desiredEnvironment;
      this._puttingRequested = false;
      this._licensedModes = null;
      this._applySetupInFlight = false;
      this._applySetupQueued = false;
      this._setupReconcileTimer = null;
      this._onClubChange = this._handleClubChange.bind(this);
      this._onEnvironmentUiSync = this._syncEnvironmentToggleUi.bind(this);
      this._sessionId = null;
      this._lastPingTime = 0;
      this._lastPingReconcileAt = 0;
      this._heartbeatTimer = null;
    }

    connectedCallback() {
      this._log('Component attached — scanning for radars');
      this._renderStatusDot('red');
      document.addEventListener('golf:clubchange', this._onClubChange);
      this.addEventListener('trackman:environmentchanged', this._onEnvironmentUiSync);
      this._discover().then(() => {
        if (this._devices.length > 0) {
          this._log(`Radar(s) found — opening connection modal`);
          this.openModal();
        }
      });
    }

    disconnectedCallback() {
      this._log('Component detached — cleaning up');
      document.removeEventListener('golf:clubchange', this._onClubChange);
      this.removeEventListener('trackman:environmentchanged', this._onEnvironmentUiSync);
      if (this._ws) {
        this._ws.onclose = null;
        this._ws.close();
        this._ws = null;
      }
      clearTimeout(this._reconnectTimer);
      clearTimeout(this._discoveryTimer);
      clearTimeout(this._setupReconcileTimer);
      clearInterval(this._heartbeatTimer);
      this._closeProbeSockets();
      this.shadowRoot.getElementById('modal-root').innerHTML = '';
    }

    attributeChangedCallback(name, oldVal, newVal) {
      if (name === 'ip' && newVal && newVal !== oldVal) {
        this._log(`Custom IP attribute set: ${newVal}`);
      }
    }

    // -- Public API ----------------------------------------------------------

    get connectionState() {
      return this._connectionState;
    }

    get connectedDevice() {
      return this._connectedDevice ? { ...this._connectedDevice } : null;
    }

    get units() {
      const preset = UNIT_PRESETS.find((p) => p.key === this._units) || UNIT_PRESETS[0];
      return { key: preset.key, distance: preset.distance, velocity: preset.velocity };
    }

    get environment() {
      return modeToLabel(this._environment);
    }

    setUnits(key) {
      const preset = UNIT_PRESETS.find((p) => p.key === key);
      if (!preset) return;
      this._units = key;
      this._saveSetting(UNITS_KEY, key);
      this._log(`Units changed to ${preset.label}`);
      this.dispatchEvent(new CustomEvent('trackman:unitschanged', {
        detail: { key: preset.key, distance: preset.distance, velocity: preset.velocity },
        bubbles: true,
      }));
    }

    /**
     * Set the user's Indoor/Outdoor intent and apply it to the radar when connected.
     * Persists desired mode even if disconnected (applied on next connect).
     * Fires trackman:environmentchanged only with the confirmed radar mode.
     * @returns {Promise<boolean>} true if the radar confirmed the requested mode
     */
    async setEnvironment(mode) {
      if (mode !== 'Indoor' && mode !== 'Outdoor') return false;
      const apiMode = mode === 'Indoor' ? 'Golf.Indoor' : 'Golf.Outdoor';

      this._desiredEnvironment = apiMode;
      this._saveSetting(ENVIRONMENT_KEY, apiMode);
      this._puttingRequested = false;

      if (!this._connectedDevice || this._connectionState !== 'connected') {
        this._log(`Environment preference queued: ${apiMode} (not connected)`);
        return false;
      }

      return this._applySetup();
    }

    disconnect() {
      this._log('Manual disconnect');
      clearInterval(this._heartbeatTimer);
      const ip = this._connectedDevice && this._connectedDevice.ip;
      if (ip) this._apiLogout(ip);
      if (this._ws) {
        this._ws.onclose = null;
        this._ws.close();
        this._ws = null;
      }
      clearTimeout(this._reconnectTimer);
      this._connectionState = 'disconnected';
      this._connectedDevice = null;
      this._renderStatusDot('red');
      this.dispatchEvent(new CustomEvent('trackman:disconnected', { bubbles: true }));
    }

    async openModal() {
      const hasLiveProbes = this._devices.length > 0 &&
        this._devices.some((d) => d._probeWs && d._probeWs.readyState === WebSocket.OPEN);

      if (hasLiveProbes) {
        this._log('openModal() — reusing existing discovery results');
      } else {
        this._log('openModal() — running fresh discovery');
        await this._discover();
      }
      this._renderModal();
    }

    openSettings() {
      if (this._connectionState !== 'connected') return;
      this._renderSettingsMenu();
    }

    // Show or hide the floating status dot at runtime. Host apps that surface
    // connection status through their own UI (e.g. the golf-visualiser's
    // M-menu Tracker tab) call `setStatusDotVisible(false)` so the two
    // indicators can't drift or duplicate. Mirrors the `hide-status-dot`
    // attribute — the attribute is honoured at paint time, this method is
    // honoured imperatively at any time afterwards.
    setStatusDotVisible(visible) {
      if (visible) {
        this.removeAttribute('hide-status-dot');
        this._renderStatusDot(
          this._connectionState === 'connected' ? 'green' : 'red'
        );
      } else {
        this.setAttribute('hide-status-dot', '');
        this._removeStatusDot();
      }
    }

    async getShots() {
      const db = await this._openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const store = tx.objectStore(DB_STORE);
        const req = store.getAll();
        req.onsuccess = () => {
          const shots = req.result.sort(
            (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
          );
          resolve(shots);
        };
        req.onerror = () => reject(req.error);
      });
    }

    async getLatestShot() {
      const shots = await this.getShots();
      return shots.length > 0 ? shots[0] : null;
    }

    async clearShots() {
      const db = await this._openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        const store = tx.objectStore(DB_STORE);
        const req = store.clear();
        req.onsuccess = () => {
          this._log('Shot history cleared');
          resolve();
        };
        req.onerror = () => reject(req.error);
      });
    }

    // -- Internal: Logging ---------------------------------------------------

    _log(message) {
      console.log(`[TrackmanRadar] ${message}`);
    }

    // -- Internal: Settings persistence --------------------------------------

    _loadSetting(key, fallback) {
      try {
        const val = localStorage.getItem(key);
        return val !== null ? val : fallback;
      } catch (_) {
        return fallback;
      }
    }

    _saveSetting(key, value) {
      try { localStorage.setItem(key, value); } catch (_) {}
    }

    async _apiLogin(ip) {
      this._log(`Logging in to ${ip}...`);
      const res = await fetch(`http://${ip}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          Username: 'admin',
          Password: '',
          Operator: 'trackman-radar',
          Software: 'trackman-radar-component',
          Force: true,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Login failed: ${res.status}`);
      const text = await res.text();
      const sid = text.replace(/^"|"$/g, '');
      this._sessionId = sid;
      this._log(`Logged in, session: ${this._sessionId}`);
    }

    async _apiLogout(ip) {
      if (!this._sessionId) return;
      try {
        await fetch(`http://${ip}/api/logout?Session-Id=${encodeURIComponent(this._sessionId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          signal: AbortSignal.timeout(3000),
        });
        this._log('Logged out from radar');
      } catch (_) {}
      this._sessionId = null;
    }

    async _fetchCurrentSetup(ip) {
      try {
        const res = await fetch(`http://${ip}/api/setup`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const setup = await res.json();
          if (setup.MeasurementMode) {
            const prevLabel = modeToLabel(this._environment);
            this._environment = setup.MeasurementMode;
            // Do NOT write ENVIRONMENT_KEY — radar report must not overwrite user intent.
            this._log(`Current mode from radar: ${setup.MeasurementMode}` +
              (setup.IsMeasuring != null ? `, IsMeasuring=${setup.IsMeasuring}` : ''));
            if (modeToLabel(this._environment) !== prevLabel) {
              this._dispatchEnvironmentChanged(true);
            }
          }
          return setup;
        }
      } catch (err) {
        this._log(`Could not read setup: ${err.message}`);
      }
      return null;
    }

    async _fetchLicensedModes(ip) {
      try {
        const res = await fetch(`http://${ip}/api/licensestatus`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const license = await res.json();
          const modes = license.LicensedMeasurementModes || {};
          this._licensedModes = new Set(
            Object.keys(modes).filter((k) => modes[k] && modes[k].Valid !== false)
          );
          this._log(`Licensed modes: ${[...this._licensedModes].join(', ')}`);
          return;
        }
      } catch (err) {
        this._log(`Could not read license status: ${err.message}`);
      }
      // Fallback: Indoor/Outdoor always assumed available when license fetch fails.
      if (!this._licensedModes) {
        this._licensedModes = new Set(['Golf.Indoor', 'Golf.Outdoor']);
      }
    }

    _isPuttingLicensed() {
      if (!this._licensedModes) return true; // optimistic until we know
      return this._licensedModes.has(PUTTING_API_MODE) ||
        this._licensedModes.has('Golf.PerformancePutting');
    }

    _intendedApiMode() {
      if (this._puttingRequested && this._isPuttingLicensed()) {
        if (this._licensedModes && this._licensedModes.has(PUTTING_API_MODE)) {
          return PUTTING_API_MODE;
        }
        if (this._licensedModes && this._licensedModes.has('Golf.PerformancePutting')) {
          return 'Golf.PerformancePutting';
        }
        return PUTTING_API_MODE;
      }
      return this._desiredEnvironment;
    }

    _dispatchEnvironmentChanged(ok, requestedLabel) {
      const detail = {
        environment: modeToLabel(this._environment),
        ok: ok !== false,
      };
      if (requestedLabel && !detail.ok) {
        detail.requested = requestedLabel;
      }
      this.dispatchEvent(new CustomEvent('trackman:environmentchanged', {
        detail,
        bubbles: true,
      }));
    }

    _setupMatchesIntent(setup) {
      return !!setup &&
        setup.MeasurementMode === this._intendedApiMode() &&
        setup.IsMeasuring === true &&
        setup.SaveDataFiles === false &&
        setup.ExportXmlFiles === false;
    }

    _scheduleSetupReconcile(reason, delayMs = 500) {
      clearTimeout(this._setupReconcileTimer);
      this._setupReconcileTimer = setTimeout(() => {
        this._setupReconcileTimer = null;
        this._reconcileSetup(reason);
      }, delayMs);
    }

    async _reconcileSetup(reason) {
      if (!this._connectedDevice || this._connectionState !== 'connected') return false;
      if (this._applySetupInFlight) {
        this._applySetupQueued = true;
        return false;
      }

      const setup = await this._fetchCurrentSetup(this._connectedDevice.ip);
      if (this._setupMatchesIntent(setup)) {
        this._log(`Setup verified after ${reason}`);
        return true;
      }

      this._log(`Setup drift after ${reason} — re-applying mode/measuring/file flags`);
      return this._applySetup();
    }

    async _syncSetupAfterConnect(ip) {
      const setup = await this._fetchCurrentSetup(ip);
      await this._fetchLicensedModes(ip);
      if (this._setupMatchesIntent(setup)) {
        this._log(`Radar setup already matches intent ${this._intendedApiMode()}`);
        return true;
      }
      this._log(`Re-asserting full setup for ${this._intendedApiMode()}`);
      return this._applySetup();
    }

    /**
     * Single POST path for MeasurementMode + IsMeasuring.
     * Re-asserts user intent (or putting overlay). Returns true on success.
     */
    async _applySetup() {
      if (!this._connectedDevice || this._connectionState !== 'connected') {
        return false;
      }

      if (this._applySetupInFlight) {
        this._applySetupQueued = true;
        return false;
      }

      const ip = this._connectedDevice.ip;
      const apiMode = this._intendedApiMode();
      const requestedLabel = modeToLabel(apiMode);
      this._applySetupInFlight = true;

      try {
        if (!this._sessionId) await this._apiLogin(ip);

        const postSetup = async () => {
          const setupUrl = `http://${ip}/api/setup?Session-Id=${encodeURIComponent(this._sessionId)}`;
          return fetch(setupUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({
              MeasurementMode: apiMode,
              IsMeasuring: true,
              SaveDataFiles: false,
              ExportXmlFiles: false,
            }),
            signal: AbortSignal.timeout(5000),
          });
        };

        let res = await postSetup();
        if (res.status === 403) {
          this._log('Session expired, re-logging in');
          this._sessionId = null;
          await this._apiLogin(ip);
          res = await postSetup();
        }
        if (!res.ok) throw new Error(`Setup POST failed: ${res.status}`);

        const confirmed = await this._fetchCurrentSetup(ip);
        if (!this._setupMatchesIntent(confirmed)) {
          throw new Error('Setup confirmation did not match requested mode/measuring/file flags');
        }

        this._environment = confirmed.MeasurementMode;
        this._log(`Setup confirmed: ${apiMode}, measuring on, TM data/XML files off`);
        this._dispatchEnvironmentChanged(true);
        return true;
      } catch (err) {
        this._log(`Failed to set environment: ${err.message}`);
        this._dispatchEnvironmentChanged(false, requestedLabel);
        return false;
      } finally {
        this._applySetupInFlight = false;
        if (this._applySetupQueued) {
          this._applySetupQueued = false;
          // Re-read all setup fields: intent may have changed while in flight.
          this._scheduleSetupReconcile('queued change', 0);
        }
      }
    }

    _handleClubChange(e) {
      const club = e.detail && e.detail.club;
      const clubId = club && club.id;
      const wantPutting = clubId === 'PT';

      if (wantPutting === this._puttingRequested) return;

      if (wantPutting) {
        if (!this._isPuttingLicensed()) {
          this._log('Putting mode not licensed — ignoring putter selection');
          return;
        }
        this._puttingRequested = true;
        this._log('Putter selected — requesting SimulatorPutting');
      } else {
        this._puttingRequested = false;
        this._log(`Left putter — restoring ${this._desiredEnvironment}`);
      }

      if (this._connectedDevice && this._connectionState === 'connected') {
        this._applySetup();
      }
    }

    _syncEnvironmentToggleUi() {
      const root = this.shadowRoot.getElementById('modal-root');
      if (!root) return;
      const toggle = root.querySelector('.tm-toggle');
      if (!toggle) return;
      const current = this.environment;
      toggle.querySelectorAll('.tm-toggle-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.mode === current);
      });
      let hint = root.querySelector('.tm-env-hint');
      if (current === 'Putting') {
        if (!hint) {
          hint = document.createElement('div');
          hint.className = 'tm-env-hint';
          toggle.parentElement.appendChild(hint);
        }
        hint.textContent = 'Putting mode (putter selected)';
      } else if (hint) {
        hint.remove();
      }
    }

    // -- Internal: Discovery -------------------------------------------------

    _discover() {
      return new Promise((resolve) => {
        this._devices = [];
        this._closeProbeSockets();

        const ips = new Set(FALLBACK_IPS);

        const customIp = this.getAttribute('ip');
        if (customIp) ips.add(customIp.trim());

        try {
          const stored = localStorage.getItem(LOCALSTORAGE_KEY);
          if (stored) {
            const parsed = JSON.parse(stored);
            if (parsed.ip) ips.add(parsed.ip);
          }
        } catch (_) {}

        this._log(`Probing ${ips.size} IP(s): ${[...ips].join(', ')}`);

        let pending = ips.size;
        let resolved = false;

        const probeSettled = () => {
          pending--;
          if (pending <= 0) finish();
        };

        const finish = () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(this._discoveryTimer);

          if (this._devices.length > 0) {
            this._log(`Found ${this._devices.length} radar(s)`);
            this._fetchDeviceNames().then(() => resolve());
          } else {
            this._log('No radar found on network');
            this._closeProbeSockets();
            resolve();
          }
        };

        this._discoveryTimer = setTimeout(finish, DISCOVERY_TIMEOUT_MS);

        for (const ip of ips) {
          try {
            const ws = new WebSocket(`ws://${ip}/ws`);
            this._probeSockets.push(ws);

            ws.onopen = () => {
              if (!this._devices.find((d) => d.ip === ip)) {
                this._devices.push({ ip, name: null, _probeWs: ws });
              }
              ws.onmessage = (event) => {
                try {
                  const data = JSON.parse(event.data);
                  if (data.Type === 'Ping') {
                    ws.send(JSON.stringify({ Type: 'Pong' }));
                  }
                } catch (_) {}
              };
              probeSettled();
            };
            ws.onerror = (err) => {
              this._log(`Probe error for ${ip}: ${err.type || 'unknown'}`);
              probeSettled();
            };
            ws.onclose = (ev) => {
              this._log(`Probe closed for ${ip} (code ${ev.code})`);
            };
          } catch (_) {
            this._log(`Probe failed for ${ip}`);
            probeSettled();
          }
        }

        if (ips.size === 0) finish();
      });
    }

    _closeProbeSockets() {
      for (const ws of this._probeSockets) {
        if (ws !== this._ws) {
          try { ws.close(); } catch (_) {}
        }
      }
      this._probeSockets = [];
    }

    async _fetchDeviceNames() {
      const fetches = this._devices.map(async (device) => {
        try {
          const res = await fetch(`http://${device.ip}/api/systeminfo`, {
            signal: AbortSignal.timeout(3000),
          });
          if (res.ok) {
            const info = await res.json();
            device.name = info.DeviceName || info.Name || null;
          }
        } catch (_) {}
      });
      await Promise.allSettled(fetches);
    }

    // -- Internal: Connection ------------------------------------------------

    _connect(ip) {
      return new Promise((resolve, reject) => {
        this._connectionState = 'connecting';
        this._log(`Connecting to ${ip}...`);

        const device = this._devices.find((d) => d.ip === ip);
        const existingWs = device && device._probeWs;
        const reuse = existingWs && existingWs.readyState === WebSocket.OPEN;
        const ws = reuse ? existingWs : new WebSocket(`ws://${ip}/ws`);

        if (reuse) {
          this._log('Reusing discovery socket');
        }

        const timeout = setTimeout(() => {
          this._connectionState = 'disconnected';
          ws.close();
          reject(new Error('Connection timed out'));
        }, 10000);

        const onReady = () => {
          clearTimeout(timeout);
          this._ws = ws;
          this._reconnectCount = 0;

          ws.send(JSON.stringify({
            Type: 'Subscribe',
            Payload: {
              MessageList: [
                'TrackerState',
                'Measurement',
                'LiveTrajectory',
                'SystemState',
              ],
            },
          }));

          const deviceInfo = device || { ip, name: null };
          this._connectedDevice = { name: deviceInfo.name, ip };
          this._connectionState = 'connected';

          const label = deviceInfo.name || ip;
          this._log(`Connected to ${label}`);

          this.dispatchEvent(new CustomEvent('trackman:connected', {
            detail: { device: { ...this._connectedDevice } },
            bubbles: true,
          }));

          if (deviceInfo._probeWs) deviceInfo._probeWs = null;
          const idx = this._probeSockets.indexOf(ws);
          if (idx > -1) this._probeSockets.splice(idx, 1);
          this._closeProbeSockets();

          try {
            localStorage.setItem(
              LOCALSTORAGE_KEY,
              JSON.stringify({ ip, name: deviceInfo.name })
            );
          } catch (_) {}

          this._startHeartbeat(ip);
          // Await setup sync so reconnect callers see the re-asserted mode.
          this._syncSetupAfterConnect(ip).finally(() => resolve());
        };

        ws.onmessage = (event) => {
          this._handleMessage(event);
        };

        ws.onerror = (err) => {
          clearTimeout(timeout);
          this._connectionState = 'disconnected';
          this._log(`WebSocket error: ${err.message || 'unknown'}`);
          reject(new Error('WebSocket connection failed'));
        };

        ws.onclose = (event) => {
          clearTimeout(timeout);
          if (this._connectionState === 'connected') {
            this._log(`WebSocket closed unexpectedly (code ${event.code})`);
            this._connectionState = 'disconnected';
            this._ws = null;
            this._renderStatusDot('red');
            this._attemptReconnect(ip);
          }
        };

        if (reuse) {
          onReady();
        } else {
          ws.onopen = () => onReady();
        }
      });
    }

    _handleMessage(event) {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (_) {
        return;
      }

      const type = data.Type;

      switch (type) {
        case 'Ping': {
          const now = Date.now();
          this._lastPingTime = now;
          this._ws.send(JSON.stringify({ Type: 'Pong' }));
          // Idle firmware/TPS can rewrite setup without a Measurement or
          // SystemState. Throttle GET-then-POST onto the existing ping.
          if (now - this._lastPingReconcileAt >= SETUP_RECONCILE_PING_MS) {
            this._lastPingReconcileAt = now;
            this._scheduleSetupReconcile('ping', 0);
          }
          break;
        }

        case 'Measurement': {
          const payload = data.Payload || {};
          const shotId = payload.Id || payload.MeasurementId || null;
          const isNewShot = !!(shotId && shotId !== this._lastMeasurementId);

          if (isNewShot) {
            this._lastMeasurementId = shotId;
            this._log(`New measurement: ${shotId}`);
          } else {
            this._log(`Measurement update (${shotId || 'no id'})`);
          }

          this.dispatchEvent(new CustomEvent('trackman:measurement', {
            detail: {
              ...payload,
              _isNewShot: isNewShot,
              _measurementMode: this._environment,
            },
            bubbles: true,
          }));

          if (payload.LaunchData) {
            this.dispatchEvent(new CustomEvent('trackman:launchdata', {
              detail: payload.LaunchData,
              bubbles: true,
            }));
          }

          this._storeShot(data);
          // Some firmware resets mode/measuring/file flags after completing a
          // shot without a useful SystemState. Debounced with TrackComplete.
          this._scheduleSetupReconcile('measurement', 800);
          break;
        }

        case 'TrackerState': {
          const trackerState = data.Payload || {};
          this.dispatchEvent(new CustomEvent('trackman:trackerstate', {
            detail: trackerState,
            bubbles: true,
          }));
          if (trackerState.State === 'TrackComplete') {
            this._scheduleSetupReconcile('TrackComplete', 500);
          }
          break;
        }

        case 'LiveTrajectory':
          this.dispatchEvent(new CustomEvent('trackman:livetrajectory', {
            detail: data.Payload,
            bubbles: true,
          }));
          break;

        case 'Acknowledge':
          this._log('Subscribe acknowledged');
          break;
        case 'SessionOpened':
          this._log('Session opened');
          break;
        case 'SessionClosed':
          this._log('Session closed');
          break;
        case 'SystemState': {
          const sp = data.Payload || {};
          this._log(`SystemState: ${JSON.stringify(sp).slice(0, 120)}`);
          if (sp.MeasurementMode) {
            const prevLabel = modeToLabel(this._environment);
            this._environment = sp.MeasurementMode;
            // Do NOT write ENVIRONMENT_KEY — external (e.g. TPS) mode is actual, not intent.
            if (modeToLabel(this._environment) !== prevLabel) {
              this._dispatchEnvironmentChanged(true);
            }
          }
          const modeDrift = sp.MeasurementMode &&
            sp.MeasurementMode !== this._intendedApiMode();
          if (modeDrift || sp.IsMeasuring === false) {
            this._log(
              `SystemState drift (mode=${sp.MeasurementMode}, measuring=${sp.IsMeasuring}) — reconciling`
            );
            this._scheduleSetupReconcile('SystemState', 100);
          }
          break;
        }

        default:
          this._log(`Unhandled message type: ${type}`);
      }
    }

    // -- Internal: Reconnection ----------------------------------------------

    _attemptReconnect(ip) {
      if (this._reconnectCount >= RECONNECT_ATTEMPTS) {
        this._log('All reconnection attempts failed');
        this._connectedDevice = null;
        this._renderStatusDot('red');
        this.dispatchEvent(new CustomEvent('trackman:disconnected', { bubbles: true }));
        return;
      }

      this._reconnectCount++;
      this._log(`Reconnecting... attempt ${this._reconnectCount}/${RECONNECT_ATTEMPTS}`);

      this._reconnectTimer = setTimeout(async () => {
        try {
          await this._connect(ip);
          this._log('Reconnected successfully');
          this._renderStatusDot('green');
        } catch (_) {
          this._attemptReconnect(ip);
        }
      }, RECONNECT_DELAY_MS);
    }

    _startHeartbeat(ip) {
      clearInterval(this._heartbeatTimer);
      this._lastPingTime = Date.now();
      this._heartbeatTimer = setInterval(() => {
        if (this._connectionState !== 'connected') {
          clearInterval(this._heartbeatTimer);
          return;
        }
        const elapsed = Date.now() - this._lastPingTime;
        if (elapsed > HEARTBEAT_TIMEOUT_MS) {
          this._log(`No ping for ${Math.round(elapsed / 1000)}s — connection dead`);
          clearInterval(this._heartbeatTimer);
          if (this._ws) {
            this._ws.onclose = null;
            this._ws.close();
            this._ws = null;
          }
          this._connectionState = 'disconnected';
          this._renderStatusDot('red');
          this._attemptReconnect(ip);
        }
      }, 5000);
    }

    // -- Internal: IndexedDB Storage -----------------------------------------

    _openDB() {
      if (this._db) return Promise.resolve(this._db);
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(DB_STORE)) {
            db.createObjectStore(DB_STORE, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => {
          this._db = req.result;
          resolve(this._db);
        };
        req.onerror = () => reject(req.error);
      });
    }

    async _storeShot(data) {
      try {
        const payload = data.Payload || {};
        const record = {
          id: payload.Id || payload.MeasurementId || crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          kind: 'Measurement',
          payload,
          reducedAccuracy: payload.ReducedAccuracy || [],
        };

        const db = await this._openDB();
        const tx = db.transaction(DB_STORE, 'readwrite');
        const store = tx.objectStore(DB_STORE);
        store.put(record);
        await new Promise((res, rej) => {
          tx.oncomplete = res;
          tx.onerror = rej;
        });

        await this._pruneShots();
      } catch (err) {
        this._log(`Failed to store shot: ${err.message}`);
      }
    }

    async _pruneShots() {
      const max = parseInt(this.getAttribute('max-shots'), 10) || DEFAULT_MAX_SHOTS;
      const shots = await this.getShots();
      if (shots.length <= max) return;

      const toDelete = shots.slice(max);
      const db = await this._openDB();
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      for (const shot of toDelete) {
        store.delete(shot.id);
      }
      await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror = rej;
      });
    }

    // -- Internal: Status Dot ------------------------------------------------

    _renderStatusDot(color) {
      this._dotColor = color || this._dotColor || 'red';
      const container = this.shadowRoot.getElementById('status-dot');
      container.innerHTML = '';

      // Opt-out: host page can suppress the floating dot entirely, e.g. when
      // the connection status is surfaced elsewhere in the UI (such as the
      // visualiser's M-menu Tracker tab). See README.md → Attributes.
      if (this.hasAttribute('hide-status-dot')) return;

      const style = this.shadowRoot.querySelector('style');
      style.textContent = this._statusDotStyles();

      const dot = document.createElement('div');
      dot.className = `tm-dot tm-dot-${this._dotColor}`;
      dot.title = this._dotColor === 'green' ? 'Radar Settings' : 'Connect to Radar';

      const savedPos = this._loadSetting(DOT_POS_KEY, null);
      if (savedPos) {
        try {
          const pos = JSON.parse(savedPos);
          dot.style.top = pos.top + 'px';
          dot.style.left = pos.left + 'px';
          dot.style.right = 'auto';
        } catch (_) {}
      }

      this._makeDraggable(dot, () => {
        if (this._dotColor === 'green') {
          this._renderSettingsMenu();
        } else {
          this.openModal();
        }
      });

      container.appendChild(dot);
    }

    _makeDraggable(el, onClick) {
      let startX, startY, origX, origY, dragged;

      const onPointerDown = (e) => {
        e.preventDefault();
        dragged = false;
        const rect = el.getBoundingClientRect();
        origX = rect.left;
        origY = rect.top;
        startX = e.clientX;
        startY = e.clientY;
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
      };

      const onPointerMove = (e) => {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragged = true;
        el.style.left = (origX + dx) + 'px';
        el.style.top = (origY + dy) + 'px';
        el.style.right = 'auto';
      };

      const onPointerUp = () => {
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        if (dragged) {
          const rect = el.getBoundingClientRect();
          this._saveSetting(DOT_POS_KEY, JSON.stringify({ top: rect.top, left: rect.left }));
        } else {
          onClick();
        }
      };

      el.addEventListener('pointerdown', onPointerDown);
    }

    _removeStatusDot() {
      const container = this.shadowRoot.getElementById('status-dot');
      container.innerHTML = '';
      const style = this.shadowRoot.querySelector('style');
      style.textContent = '';
    }

    _statusDotStyles() {
      return `
        @keyframes tm-pulse-green {
          0%, 100% { box-shadow: 0 0 0 0 rgba(76, 175, 80, 0.5); }
          50% { box-shadow: 0 0 0 6px rgba(76, 175, 80, 0); }
        }
        @keyframes tm-pulse-red {
          0%, 100% { box-shadow: 0 0 0 0 rgba(244, 67, 54, 0.5); }
          50% { box-shadow: 0 0 0 6px rgba(244, 67, 54, 0); }
        }
        .tm-dot {
          position: fixed; top: 16px; left: 16px;
          width: 14px; height: 14px; border-radius: 50%;
          cursor: pointer;
          z-index: 99998;
          border: 2px solid rgba(255,255,255,0.2);
          touch-action: none;
          user-select: none;
        }
        .tm-dot-green {
          background: #4caf50;
          animation: tm-pulse-green 2s ease-in-out infinite;
        }
        .tm-dot-green:hover {
          transform: scale(1.3);
          animation: none;
          box-shadow: 0 0 0 4px rgba(76, 175, 80, 0.3);
        }
        .tm-dot-red {
          background: #f44336;
          animation: tm-pulse-red 2s ease-in-out infinite;
        }
        .tm-dot-red:hover {
          transform: scale(1.3);
          animation: none;
          box-shadow: 0 0 0 4px rgba(244, 67, 54, 0.3);
        }
      `;
    }

    // -- Internal: Settings Menu ---------------------------------------------

    _renderSettingsMenu() {
      const root = this.shadowRoot.getElementById('modal-root');
      root.innerHTML = '';

      const style = this.shadowRoot.querySelector('style');
      style.textContent = this._statusDotStyles() + this._settingsStyles();

      const overlay = document.createElement('div');
      overlay.className = 'tm-overlay';
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) this._closeSettings();
      });

      const panel = document.createElement('div');
      panel.className = 'tm-settings';

      // Header
      const header = document.createElement('div');
      header.className = 'tm-settings-header';
      const title = document.createElement('h2');
      title.textContent = 'Radar Settings';
      const closeBtn = document.createElement('button');
      closeBtn.className = 'tm-close';
      closeBtn.innerHTML = '&#x2715;';
      closeBtn.addEventListener('click', () => this._closeSettings());
      header.appendChild(title);
      header.appendChild(closeBtn);
      panel.appendChild(header);

      // Device info
      if (this._connectedDevice) {
        const info = document.createElement('div');
        info.className = 'tm-device-info';
        const name = this._connectedDevice.name || this._connectedDevice.ip;
        info.innerHTML = `<span class="tm-connected-badge"></span> ${name}`;
        panel.appendChild(info);
      }

      // Units
      const unitsSection = document.createElement('div');
      unitsSection.className = 'tm-section';
      unitsSection.innerHTML = '<label class="tm-section-label">Units</label>';
      const select = document.createElement('select');
      select.className = 'tm-select';
      UNIT_PRESETS.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.key;
        opt.textContent = p.label;
        if (p.key === this._units) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener('change', () => this.setUnits(select.value));
      unitsSection.appendChild(select);
      panel.appendChild(unitsSection);

      // Environment
      const envSection = document.createElement('div');
      envSection.className = 'tm-section';
      envSection.innerHTML = '<label class="tm-section-label">Environment</label>';
      const toggle = document.createElement('div');
      toggle.className = 'tm-toggle';
      const currentEnv = this.environment;
      ['Indoor', 'Outdoor'].forEach((mode) => {
        const btn = document.createElement('button');
        btn.dataset.mode = mode;
        btn.className = 'tm-toggle-btn' + (mode === currentEnv ? ' active' : '');
        btn.textContent = mode;
        btn.addEventListener('click', () => {
          // Do not optimistically paint — wait for trackman:environmentchanged.
          this.setEnvironment(mode);
        });
        toggle.appendChild(btn);
      });
      envSection.appendChild(toggle);
      if (currentEnv === 'Putting') {
        const hint = document.createElement('div');
        hint.className = 'tm-env-hint';
        hint.textContent = 'Putting mode (putter selected)';
        envSection.appendChild(hint);
      }
      panel.appendChild(envSection);

      // Shot Viewer link
      if (this._connectedDevice) {
        const linkSection = document.createElement('div');
        linkSection.className = 'tm-section';
        const link = document.createElement('a');
        link.className = 'tm-link';
        link.href = `http://${this._connectedDevice.ip}/shotviewer.html`;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Open Shot Viewer';
        link.innerHTML = `<span class="tm-link-icon">&#x2197;</span> Open Shot Viewer`;
        linkSection.appendChild(link);
        panel.appendChild(linkSection);
      }

      // Disconnect
      const sep = document.createElement('hr');
      sep.className = 'tm-separator';
      panel.appendChild(sep);

      const disconnectBtn = document.createElement('button');
      disconnectBtn.className = 'tm-disconnect';
      disconnectBtn.textContent = 'Disconnect';
      disconnectBtn.addEventListener('click', () => {
        this._closeSettings();
        this.disconnect();
      });
      panel.appendChild(disconnectBtn);

      overlay.appendChild(panel);
      root.appendChild(overlay);
    }

    _closeSettings() {
      const root = this.shadowRoot.getElementById('modal-root');
      root.innerHTML = '';
      this._renderStatusDot(this._connectionState === 'connected' ? 'green' : 'red');
    }

    _settingsStyles() {
      return `
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .tm-overlay {
          position: fixed; inset: 0;
          background: rgba(0, 0, 0, 0.7);
          display: flex; align-items: flex-start; justify-content: flex-end;
          padding: 48px 16px 16px;
          z-index: 99999;
          font-family: system-ui, -apple-system, sans-serif;
        }
        .tm-settings {
          background: #111; color: #fff;
          border-radius: 12px; padding: 24px;
          width: 280px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        }
        .tm-settings-header {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 16px;
        }
        .tm-settings-header h2 {
          font-size: 16px; font-weight: 600;
        }
        .tm-close {
          background: none; border: none; color: #666;
          font-size: 18px; cursor: pointer; padding: 4px;
          line-height: 1;
        }
        .tm-close:hover { color: #fff; }
        .tm-device-info {
          display: flex; align-items: center; gap: 8px;
          font-size: 13px; color: #aaa;
          padding: 10px 12px; background: #1a1a1a;
          border-radius: 8px; margin-bottom: 20px;
        }
        .tm-connected-badge {
          display: inline-block; width: 8px; height: 8px;
          border-radius: 50%; background: #4caf50;
          flex-shrink: 0;
        }
        .tm-section {
          margin-bottom: 16px;
        }
        .tm-section-label {
          display: block; font-size: 11px; font-weight: 600;
          color: #666; text-transform: uppercase;
          letter-spacing: 0.5px; margin-bottom: 8px;
        }
        .tm-select {
          width: 100%; background: #1a1a1a; color: #fff;
          border: 1px solid #333; border-radius: 6px;
          padding: 8px 12px; font-size: 13px;
          outline: none; appearance: none;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M2 4l4 4 4-4'/%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 10px center;
          cursor: pointer;
        }
        .tm-select:focus { border-color: #555; }
        .tm-toggle {
          display: flex; border-radius: 6px; overflow: hidden;
          border: 1px solid #333;
        }
        .tm-toggle-btn {
          flex: 1; padding: 8px 0;
          background: #1a1a1a; color: #888;
          border: none; font-size: 13px; font-weight: 500;
          cursor: pointer; transition: all 0.15s;
        }
        .tm-toggle-btn:first-child { border-right: 1px solid #333; }
        .tm-toggle-btn.active {
          background: #2a2a2a; color: #fff;
        }
        .tm-toggle-btn:hover:not(.active) { color: #ccc; }
        .tm-env-hint {
          margin-top: 8px; font-size: 12px; color: #888;
        }
        .tm-link {
          display: flex; align-items: center; gap: 6px;
          color: #6ab0f3; text-decoration: none;
          font-size: 13px; padding: 10px 12px;
          background: #1a1a1a; border-radius: 8px;
          transition: background 0.15s;
        }
        .tm-link:hover { background: #222; }
        .tm-link-icon { font-size: 14px; }
        .tm-separator {
          border: none; border-top: 1px solid #2a2a2a;
          margin: 16px 0;
        }
        .tm-disconnect {
          width: 100%; padding: 10px;
          background: transparent; color: #ff6b6b;
          border: 1px solid #3a2020; border-radius: 6px;
          font-size: 13px; font-weight: 500; cursor: pointer;
          transition: all 0.15s;
        }
        .tm-disconnect:hover {
          background: #2a1515; border-color: #ff6b6b;
        }
      `;
    }

    // -- Internal: Connection Modal UI ---------------------------------------

    _renderModal() {
      const root = this.shadowRoot.getElementById('modal-root');
      root.innerHTML = '';

      const style = this.shadowRoot.querySelector('style');
      style.textContent = this._modalStyles();

      const overlay = document.createElement('div');
      overlay.className = 'tm-overlay';
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) this._closeModal();
      });

      const modal = document.createElement('div');
      modal.className = 'tm-modal';

      const heading = document.createElement('h2');
      heading.textContent = 'Connect to Radar';
      modal.appendChild(heading);

      if (this._devices.length === 0) {
        const empty = document.createElement('p');
        empty.style.cssText = 'color:#888; font-size:13px; margin-bottom:16px;';
        empty.textContent = 'No radars found. Enter an IP address below.';
        modal.appendChild(empty);
      }

      this._devices.forEach((device) => {
        const row = document.createElement('div');
        row.className = 'tm-device';
        if (this._devices.length === 1) row.classList.add('tm-preselect');

        const label = document.createElement('div');
        label.className = 'tm-device-label';
        if (device.name) {
          label.innerHTML = `<strong>${device.name}</strong> &mdash; ${device.ip}`;
        } else {
          label.innerHTML = `<strong>${device.ip}</strong>`;
        }

        const btn = document.createElement('button');
        btn.className = 'tm-btn';
        btn.textContent = 'Connect';
        btn.addEventListener('click', () => this._onConnectClick(btn, device.ip, row));

        row.appendChild(label);
        row.appendChild(btn);
        modal.appendChild(row);
      });

      const sep = document.createElement('hr');
      sep.className = 'tm-separator';
      modal.appendChild(sep);

      const manual = document.createElement('div');
      manual.className = 'tm-manual';

      const manualLabel = document.createElement('label');
      manualLabel.textContent = 'Manual IP';
      const manualInput = document.createElement('input');
      manualInput.type = 'text';
      manualInput.placeholder = '192.168.1.100';
      const manualBtn = document.createElement('button');
      manualBtn.className = 'tm-btn';
      manualBtn.textContent = 'Connect';
      manualBtn.addEventListener('click', () => {
        const ip = manualInput.value.trim();
        if (ip) this._onConnectClick(manualBtn, ip, manual);
      });

      manual.appendChild(manualLabel);
      manual.appendChild(manualInput);
      manual.appendChild(manualBtn);
      modal.appendChild(manual);

      overlay.appendChild(modal);
      root.appendChild(overlay);
    }

    _modalStyles() {
      return `
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .tm-overlay {
          position: fixed; inset: 0;
          background: rgba(0, 0, 0, 0.85);
          display: flex; align-items: center; justify-content: center;
          z-index: 99999;
          font-family: system-ui, -apple-system, sans-serif;
        }
        .tm-modal {
          background: #111; color: #fff;
          border-radius: 12px; padding: 28px 32px;
          min-width: 340px; max-width: 420px; width: 100%;
        }
        .tm-modal h2 {
          font-size: 18px; font-weight: 600; margin-bottom: 20px;
        }
        .tm-device {
          display: flex; align-items: center; justify-content: space-between;
          padding: 12px 14px; border-radius: 8px;
          background: #1a1a1a; margin-bottom: 8px;
        }
        .tm-device.tm-preselect { outline: 1px solid rgba(255,255,255,0.25); }
        .tm-device-label {
          font-size: 14px; line-height: 1.4; color: #ccc;
        }
        .tm-device-label strong { color: #fff; }
        .tm-btn {
          background: #fff; color: #111;
          border: none; border-radius: 6px;
          padding: 8px 18px; font-size: 13px; font-weight: 600;
          cursor: pointer; min-width: 90px; text-align: center;
          position: relative;
        }
        .tm-btn:hover { background: #e0e0e0; }
        .tm-btn:disabled { opacity: 0.5; cursor: default; }
        .tm-separator {
          border: none; border-top: 1px solid #2a2a2a;
          margin: 18px 0;
        }
        .tm-manual {
          display: flex; gap: 10px; align-items: center;
        }
        .tm-manual label { font-size: 12px; color: #888; white-space: nowrap; }
        .tm-manual input {
          flex: 1; background: #1a1a1a; color: #fff;
          border: 1px solid #333; border-radius: 6px;
          padding: 8px 12px; font-size: 13px; outline: none;
        }
        .tm-manual input:focus { border-color: #555; }
        .tm-error {
          color: #ff6b6b; font-size: 12px; margin-top: 6px; padding: 0 14px;
        }
        @keyframes tm-spin {
          to { transform: rotate(360deg); }
        }
        .tm-spinner {
          display: inline-block; width: 16px; height: 16px;
          border: 2px solid #999; border-top-color: #111;
          border-radius: 50%; animation: tm-spin 0.6s linear infinite;
          vertical-align: middle;
        }
        @keyframes tm-check-draw {
          to { stroke-dashoffset: 0; }
        }
        .tm-checkmark {
          display: inline-block; width: 18px; height: 18px; vertical-align: middle;
        }
        .tm-checkmark svg {
          width: 18px; height: 18px;
        }
        .tm-checkmark path {
          stroke: #4caf50; stroke-width: 3; fill: none;
          stroke-dasharray: 24; stroke-dashoffset: 24;
          animation: tm-check-draw 0.35s ease forwards;
        }
      `;
    }

    async _onConnectClick(btn, ip, container) {
      const origText = btn.textContent;
      btn.disabled = true;
      btn.innerHTML = '<span class="tm-spinner"></span>';

      const existingErr = container.parentElement
        ? container.parentElement.querySelector('.tm-error')
        : container.querySelector('.tm-error');
      if (existingErr) existingErr.remove();

      try {
        await this._connect(ip);
        btn.innerHTML = `<span class="tm-checkmark"><svg viewBox="0 0 24 24"><path d="M4 12l6 6L20 6"/></svg></span>`;
        setTimeout(() => this._closeModal(), 1500);
      } catch (err) {
        btn.textContent = origText;
        btn.disabled = false;
        const errEl = document.createElement('div');
        errEl.className = 'tm-error';
        errEl.textContent = err.message || 'Connection failed';
        container.after ? container.after(errEl) : container.parentElement.appendChild(errEl);
      }
    }

    _closeModal() {
      const root = this.shadowRoot.getElementById('modal-root');
      root.innerHTML = '';

      if (this._connectionState === 'connected') {
        this._renderStatusDot('green');
      } else {
        this._renderStatusDot('red');
      }
    }
  }

  customElements.define('trackman-radar', TrackmanRadar);
})();
