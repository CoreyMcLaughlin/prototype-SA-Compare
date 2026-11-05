/**
 * BounceRollSimulator — fixed-timestep, surface-aware terminal-phase physics.
 *
 * Owns the ball from the moment the radar's flight curve ends until the ball
 * comes to rest, is absorbed by water, or is holed in the cup. Replaces the
 * legacy hardcoded "3 diminishing sine-bounces + linear roll" animation in
 * golf-visualiser.js.
 *
 * Algorithm overview (see PRD §4.1 for full pseudocode):
 *
 *   Each step:
 *     1. Air sub-step: integrate gravity into velocity, predict new position.
 *     2. Raycast straight down at predicted (x, z): get ground point + normal.
 *     3. If predicted ball is above ground + radius → still airborne, commit.
 *     4. Otherwise contact: split velocity into normal + tangent components.
 *        - If cup-floor absorb → emit holed event, end simulation.
 *        - If `surface.absorb` (water/OB) → emit water event, end simulation.
 *        - If currently airborne → bounce: reflect normal × restitution,
 *          scale tangent × (1 - friction), apply spin × spinGrab to tangent.
 *        - If currently rolling → decay tangent × (1 - rollResistance × dt),
 *          add slope force (gravity projected onto contact plane).
 *     5. Snap ball to (hit.point + normal × ballRadius) so it sits on surface.
 *     6. If |velocity| < restingThreshold for restingFrames consecutive frames,
 *        emit `golf:rest` and stop.
 *
 * Determinism: fixed dt sub-stepping (default 120 Hz physics inside 60 Hz rAF).
 * No RNG. Same start state → same trajectory across machines.
 *
 * The integrator is decoupled from the DOM: it doesn't import the web component.
 * It exposes events via a simple emitter; the host wires those to DOM events.
 */

import * as THREE from 'three';

/**
 * Default tuning — matches PRD §7. Override via the constructor's `params`.
 *
 * Frozen so accidental in-place mutation by callers doesn't desync future
 * simulations. To override, pass a partial object to the constructor.
 */
export const DEFAULT_PARAMS = Object.freeze({
  gravity: 9.81,
  ballRadius: 0.0214,
  // "At rest" cutoff on the ball's tangential speed. 0.10 m/s ≈ 10 cm/s: a ball
  // is physically still moving but is effectively stopped for gameplay.
  // Lower values (e.g. 0.05) let the ball creep asymptotically for seconds
  // after the shot is visually over, which the Phase-2 verification caught.
  restingThreshold: 0.10,
  restingFrames: 2,
  spinDecayPerBounce: 0.6,
  // Safety cap. Any shot still simulating after this many seconds is declared
  // at rest with reason='max_seconds'. Catches off-map / pathological cases.
  // 10 s is plenty for a realistic golf shot (2-3 s flight + 3-5 s rollout);
  // if we're still simulating at 10 s something has gone wrong.
  maxSimulationSeconds: 10,
  subSteps: 2,
  // Calibration constant for spin → tangential velocity delta (m/s per rev/s).
  // Applied at first-pass as `spin * surface.spinGrab * spinToVelocity` added along
  // the ball's forward tangent direction on each bounce. Backspin (negative spin)
  // therefore subtracts forward velocity, which is the "check on the green" effect.
  // The delta is clamped (see `_bounce`) so backspin can zero the tangent but
  // never reverse direction.
  //
  // Phase-4 calibrated value: 0.1 (m/s per rev/s), tuned against PRD §6 shots.
  // Rough sanity: a 7-iron pitch with 6000 rpm backspin (spin=-100 rev/s) on
  // firm fairway (spinGrab=0.4) produces -100 * 0.4 * 0.1 = -4.0 m/s forward
  // velocity reduction per bounce (pre-clamp) — enough for visible check.
  spinToVelocity: 0.1,
  // Vertical rebound below this (abs m/s) transitions airborne → rolling.
  // Slightly above restingThreshold so we don't pingpong between states.
  rollTransitionVy: 0.15,
  // Phase-4 addition: impact-ploughing coefficient.
  //
  // Rigid-body bounce models under-represent what real turf does to a
  // hard-landing ball: the sod deforms plastically, soaks up extra
  // tangential energy beyond what the static friction coefficient alone
  // accounts for. The effect scales with the normal component of impact
  // velocity (harder landings = bigger divots = more tangent loss).
  //
  // Applied as an additional multiplicative tangent reduction on top of
  // the surface's friction:
  //
  //     tangent_out = tangent_in · (1 - friction) · (1 - min(0.5, |vDotN|·k))
  //
  // where k = ploughPerNormalSpeed (this param). Capped at 0.5 so a
  // single bounce can't kill more than half the remaining tangent on top
  // of friction — prevents a freak high-impact bounce from completely
  // stopping the ball.
  //
  // Phase-4 calibrated value: 0.09 (per m/s of normal impact speed), tuned
  // against PRD §6 (Driver / 7-iron / Pitch) on the firm-fairway test grid.
  // 0 turns the ploughing off and reverts to pure rigid-body behaviour.
  ploughPerNormalSpeed: 0.09,
  // Solid-collider anti-stacking threshold (m/s). When the ball contacts a
  // wall/ramp with |vn| < this value, the normal component is zeroed and no
  // BOUNCE event is emitted — avoids per-frame jitter for a ball pressed
  // against a wall by gravity, slope, or a weak-rebound residual.
  // Analogous to `rollTransitionVy` for the ground, but for any-angle normals.
  colliderRestVn: 0.05
});

/** Internal state-machine phases. Public API exposes these as event names. */
const PHASE = Object.freeze({
  AIRBORNE: 'airborne',
  ROLLING:  'rolling',
  AT_REST:  'at_rest',
  ABSORBED: 'absorbed',
  HOLED:    'holed'
});

export class BounceRollSimulator {
  /**
   * @param {SurfaceSampler} surfaceSampler - Provides `sampleAt(x, z)` and `getSurface(mesh)`.
   * @param {TriggerDetector} [triggerDetector] - Optional. If provided, triggers
   *   are tested every step and `trigger` events are emitted alongside physics events.
   * @param {object} [params] - Partial override of DEFAULT_PARAMS.
   * @param {ColliderSampler} [colliderSampler] - Optional. If provided, a forward
   *   swept-sphere test runs each sub-step before the ground contact check;
   *   collider hits take precedence (collider-first policy, see PRD §5.5).
   * @param {import('./cup-capture.js').CupCapture|null} [cupCapture] - Optional.
   *   Local ground punch under the pin so the ball can fall into the cup.
   */
  constructor(surfaceSampler, triggerDetector = null, params = {}, colliderSampler = null, cupCapture = null) {
    this._sampler = surfaceSampler;
    this._triggers = triggerDetector;
    this._colliders = colliderSampler;
    this._cup = cupCapture;
    this._params = { ...DEFAULT_PARAMS, ...params };

    this._listeners = new Map();          // event name -> Set<callback>
    this._state = null;                    // populated by start()
    this._trace = [];                      // per-step samples for debug / replay

    // Scratch vectors for the forward-swept test — reused every sub-step to
    // avoid allocating on a hot path.
    this._scratchDir = new THREE.Vector3();
  }

  /**
   * Replace the collider sampler post-construction. Used by the visualiser
   * when the host wires solid colliders after initial GLB load (e.g. runtime
   * mini-golf walls added via direct scene mutation). Passing null disables
   * collider checks entirely.
   */
  setColliderSampler(colliderSampler) {
    this._colliders = colliderSampler;
  }

  /**
   * Replace the cup-capture helper post-construction. Passing null disables
   * the ground punch (Range / scenes without a pin).
   * @param {import('./cup-capture.js').CupCapture|null} cupCapture
   */
  setCupCapture(cupCapture) {
    this._cup = cupCapture;
  }

  /** Update tunables mid-session. Caller passes a partial; defaults stay. */
  setParams(partial) {
    this._params = { ...this._params, ...partial };
  }

  getParams() {
    return { ...this._params };
  }

  /**
   * Begin simulating from the given initial state.
   *
   * @param {object} init
   * @param {THREE.Vector3} init.position - Worldspace landing point (with y on surface).
   * @param {THREE.Vector3} init.velocity - Worldspace velocity at landing (m/s).
   * @param {number} [init.spin=0] - Signed scalar (rev/s). Positive = topspin, negative = backspin.
   * @param {number} [init.bounceIndex=0] - Useful when chaining replays.
   * @param {'airborne'|'rolling'} [init.phase='airborne'] - Start airborne (default
   *   flight handoff) or already rolling (ground putts that skip the air phase).
   */
  start(init) {
    const startRolling = init.phase === 'rolling' || init.phase === PHASE.ROLLING;
    const surface = this._sampler.sampleAt(init.position.x, init.position.z)?.surface ?? null;
    this._state = {
      phase: startRolling ? PHASE.ROLLING : PHASE.AIRBORNE,
      position: init.position.clone(),
      velocity: init.velocity.clone(),
      spin: init.spin ?? 0,
      bounceIndex: init.bounceIndex ?? 0,
      restFramesAccrued: 0,
      elapsed: 0,
      totalDistance: 0,
      totalAirTime: 0,
      totalRollTime: 0,
      lastPosition: init.position.clone()
    };
    this._trace = [];
    this._emit('land', {
      position: this._state.position.clone(),
      velocity: this._state.velocity.clone(),
      surface
    });
    // Putting / ground-roll starts skip the airborne bounce path, so emit
    // roll-start immediately so hosts that listen for the terminal-phase
    // transition still see a coherent event sequence.
    if (startRolling) {
      this._emit('roll-start', {
        position: this._state.position.clone(),
        velocity: this._state.velocity.clone(),
        surface
      });
    }
  }

  /**
   * Advance the simulation by `dtTotal` seconds, sub-stepping internally
   * to maintain a fixed physics timestep regardless of frame jitter.
   *
   * Call this from the host's rAF loop with the rAF-provided delta.
   * Returns `true` while still running, `false` once at rest / absorbed.
   *
   * @param {number} dtTotal
   * @returns {boolean}
   */
  step(dtTotal) {
    if (!this._state) return false;
    if (this._isFinished()) return false;

    const dt = dtTotal / this._params.subSteps;
    for (let i = 0; i < this._params.subSteps; i++) {
      this._advance(dt);
      if (this._isFinished()) return false;
    }
    return true;
  }

  /** Force-stop and emit `rest` immediately. Used by the safety hard-cap. */
  stop(reason = 'manual') {
    if (!this._state || this._isFinished()) return;
    this._state.phase = PHASE.AT_REST;
    this._emitRest(reason);
  }

  /**
   * Read-only snapshot of the current state. The visualiser drives the ball
   * mesh from `state.position`; no extra setter needed.
   */
  get state() {
    return this._state;
  }

  /** Per-step samples since the last `start()`. Useful for trajectory polylines. */
  get trace() {
    return this._trace;
  }

  // ---------------------------------------------------------------------------
  // Event emitter (intentionally minimal — no DOM dependency)
  // ---------------------------------------------------------------------------

  on(event, callback) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(callback);
    return () => this._listeners.get(event)?.delete(callback);
  }

  _emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const cb of set) cb(payload);
  }

  // ---------------------------------------------------------------------------
  // Integrator
  // ---------------------------------------------------------------------------

  /**
   * One sub-step of the integrator. See PRD §4.1 for the reference algorithm.
   *
   * Flow:
   *   1. Safety cap: stop if we've been simulating for too long (runaway guard).
   *   2. Integrate gravity into velocity (applies in rolling too — it's what
   *      pulls the ball down-slope and transitions roll→airborne off ledges).
   *   3. Predict next position.
   *   4. Raycast straight down under the predicted (x, z). No hit = off-map;
   *      commit predicted and let the safety cap handle termination.
   *   5. Penetration check: if predicted.y > ground + radius, ball is in air.
   *      Commit predicted. If we were rolling (rolled off a ledge), transition
   *      back to airborne so the next ground contact registers as a bounce.
   *   6. Otherwise we have contact this sub-step.
   *      - If cup-floor absorb → emit holed + end.
   *      - If surface absorbs (water/OB) → emit water + end.
   *      - Else resolve contact (bounce or roll based on current phase).
   *   7. Rest detection + trigger scan.
   *   8. Append a trace sample for debug / replay.
   */
  _advance(dt) {
    const st = this._state;

    // Safety cap — catches any pathological case (off-map, jitter, etc.)
    st.elapsed += dt;
    if (st.elapsed > this._params.maxSimulationSeconds) {
      this.stop('max_seconds');
      return;
    }

    // Gravity. Applied every sub-step regardless of phase — during rolling the
    // tangent-projection in _roll() strips the normal component back out.
    st.velocity.y -= this._params.gravity * dt;

    // Forward swept-sphere test for solid colliders (walls, ramps, posts).
    // Runs BEFORE the ground-contact check: a collider-first policy means a
    // ball that would otherwise pass through a wall bounces off it instead,
    // regardless of whether the mesh is also marked as a walkable surface.
    // See solid-colliders-prd.md §5.5.
    const speedSq = st.velocity.lengthSq();
    if (this._colliders && speedSq > 1e-6) {
      const speed = Math.sqrt(speedSq);
      this._scratchDir.copy(st.velocity).multiplyScalar(1 / speed);
      const sweptLen = speed * dt + this._params.ballRadius;
      const solidHit = this._colliders.sweptTest(
        st.position, this._scratchDir, sweptLen, this._params.ballRadius
      );
      if (solidHit) {
        this._collide(solidHit);
        this._checkRest();
        this._accumulatePathCounters(dt);
        this._trace.push({
          pos: st.position.clone(),
          vel: st.velocity.clone(),
          surface: null,
          collider: solidHit.collider,
          dt
        });
        this._scanTriggers();
        return;
      }
    }

    // Predict
    const predicted = st.position.clone().addScaledVector(st.velocity, dt);

    // Sample ground under predicted, then punch a local hole under the pin
    // when CupCapture is wired (green is continuous; without this the ball
    // never falls into the decorative cup).
    const hit = this._sampler.sampleAt(predicted.x, predicted.z);
    if (!hit) {
      // Off-map: commit the predicted position and keep falling. The safety
      // cap will eventually stop us. This is a pathological case for normal
      // golf use (shot went off the edge of the world).
      st.position.copy(predicted);
      this._accumulatePathCounters(dt);
      this._trace.push({ pos: predicted.clone(), vel: st.velocity.clone(), surface: null, dt });
      return;
    }
    if (this._cup) {
      const horizSpeed = Math.hypot(st.velocity.x, st.velocity.z);
      this._cup.patchSample(hit, predicted.x, predicted.z, { horizontalSpeed: horizSpeed });
    }

    const groundY = hit.point.y + this._params.ballRadius;
    const airGap = predicted.y - groundY;

    if (st.phase === PHASE.AIRBORNE) {
      // Classic airborne test: predicted sample point above ground → still flying.
      if (airGap > 0) {
        st.position.copy(predicted);
        this._accumulatePathCounters(dt);
        this._trace.push({ pos: predicted.clone(), vel: st.velocity.clone(), surface: hit.surface, dt });
        this._scanTriggers();
        return;
      }
    } else {
      // Rolling: the ball is surface-attached. Tiny positive airGaps happen
      // constantly on triangulated terrain because the raycast normal jitters
      // by a few degrees between adjacent tris, which injects a tiny y-component
      // into vTangent that gravity then amplifies. We must NOT flip to airborne
      // on those — that oscillation would cause the ball to endlessly
      // bounce→roll→bounce and never rest. Only flip when we've clearly left
      // the surface (rolled off a real ledge or been kicked upward).
      //
      // Cup punch: the floor is only ~14 cm below the rim — smaller than the
      // normal ledge threshold — so allow a smaller gap to go airborne when
      // the sample was punched, otherwise the ball teleports to the floor.
      const LEDGE_GAP = hit._cupFloor
        ? this._params.ballRadius * 0.5
        : this._params.ballRadius * 10;  // 10 × ball radius ≈ 21 cm
      const UPWARD_KICK = 0.3;                          // m/s of genuine lift
      if (airGap > LEDGE_GAP || st.velocity.y > UPWARD_KICK) {
        st.phase = PHASE.AIRBORNE;
        st.position.copy(predicted);
        this._accumulatePathCounters(dt);
        this._trace.push({ pos: predicted.clone(), vel: st.velocity.clone(), surface: hit.surface, dt });
        this._scanTriggers();
        return;
      }
      // Otherwise: clamp the predicted drift and resolve as rolling contact.
    }

    // Contact this sub-step
    const surface = hit.surface;
    if (surface?.absorb) {
      if (hit._cupFloor || surface.id === 'hole_cup') {
        this._handleHoled(hit);
      } else {
        this._handleAbsorb(hit);
      }
      return;
    }
    this._resolveContact(hit, surface, dt);
    this._checkRest();
    this._accumulatePathCounters(dt);
    this._trace.push({ pos: st.position.clone(), vel: st.velocity.clone(), surface, dt });
    this._scanTriggers();
  }

  /**
   * Split incoming velocity into normal (against hit.normal) and tangent
   * components, delegate to bounce or roll handler, then snap position to the
   * surface so the next sub-step starts from a clean on-surface state (no
   * accumulating penetration).
   */
  _resolveContact(hit, surface, dt) {
    const st = this._state;
    const n = hit.normal;
    const vDotN = st.velocity.dot(n); // typically negative — ball moving into surface
    const vNormal = n.clone().multiplyScalar(vDotN);
    const vTangent = st.velocity.clone().sub(vNormal);

    if (st.phase === PHASE.AIRBORNE) {
      // If the incoming impact is weaker than what would produce a meaningful
      // rebound, skip the bounce math and drop straight into rolling. Avoids
      // machine-gun mini-bounces as the ball decays toward rest (seen during
      // Phase-2 verification: 300+ fake bounces at ~0.07 m/s post-rebound).
      //
      // We deliberately do NOT emit `roll-start` here: this branch fires every
      // time the ball micro-hops on bumpy terrain, which would spam consumers.
      // The canonical roll-start emission lives in `_bounce` and fires once
      // per "real" airborne→rolling transition (rebound fell below threshold).
      const minBounceVdotN = this._params.rollTransitionVy / Math.max(surface.restitution, 1e-3);
      if (-vDotN < minBounceVdotN) {
        st.phase = PHASE.ROLLING;
        this._roll(hit, surface, vTangent, dt);
      } else {
        this._bounce(hit, surface, vTangent, vDotN);
      }
    } else {
      this._roll(hit, surface, vTangent, dt);
    }

    // Snap to surface so the next sub-step doesn't re-detect this same
    // penetration. Ball sits centered one radius along the normal.
    st.position.copy(hit.point).addScaledVector(n, this._params.ballRadius);
  }

  /**
   * Airborne → ground contact: reflect normal component with restitution,
   * scale tangent by (1 - friction), apply spin-grab delta along the ball's
   * forward direction.
   *
   * Sign convention for state.spin (rev/s):
   *   positive = topspin  → adds forward velocity on bounce (amplifies roll)
   *   negative = backspin → subtracts forward velocity (ball checks up)
   */
  _bounce(hit, surface, vTangent, vDotN) {
    const st = this._state;
    const params = this._params;

    // Tangent loses energy to friction. On top of the surface-level friction
    // coefficient we apply an impact-ploughing factor that scales with the
    // normal component of impact velocity — hard landings dig into real turf
    // and bleed additional tangential energy. Capped at 0.5 so a single
    // bounce can't kill more than half the remaining tangent on top of
    // friction. See DEFAULT_PARAMS.ploughPerNormalSpeed for the full
    // physical motivation.
    const ploughLoss = Math.min(0.5, Math.abs(vDotN) * params.ploughPerNormalSpeed);
    const newTangent = vTangent.multiplyScalar((1 - surface.friction) * (1 - ploughLoss));

    // Normal reflects (vDotN is negative, so -vDotN is positive; restitution < 1 bleeds energy)
    const normalOut = -vDotN * surface.restitution;
    const newVel = newTangent.clone().addScaledVector(hit.normal, normalOut);

    // Spin-grab: apply a forward-tangent delta proportional to spin × spinGrab.
    // Backspin (negative spin) → negative delta → ball slows forward (checks up).
    // Topspin (positive spin) → positive delta → ball runs out.
    //
    // The delta is clamped so backspin can reduce tangent toward zero but
    // never REVERSE the ball's direction of travel. Physically, static
    // friction at the contact patch can stop the ball relative to the
    // ground but cannot push it faster backward than it was going forward;
    // uncapped, a 4000 rpm pitch would actually roll backward because the
    // spin-derived delta can exceed the post-friction tangent speed.
    const tangentSpeed = newTangent.length();
    if (tangentSpeed > 1e-6) {
      const tangentDir = newTangent.clone().multiplyScalar(1 / tangentSpeed);
      const rawDelta = st.spin * (surface.spinGrab ?? 0) * params.spinToVelocity;
      const clampedDelta = rawDelta < 0
        ? Math.max(rawDelta, -tangentSpeed)  // backspin — can zero tangent, not reverse
        : rawDelta;                          // topspin — add freely (ball accelerates forward)
      newVel.addScaledVector(tangentDir, clampedDelta);
    }

    st.velocity.copy(newVel);
    st.spin *= params.spinDecayPerBounce;
    st.bounceIndex++;

    this._emit('bounce', {
      position: hit.point.clone(),
      velocity: newVel.clone(),
      surface,
      collider: null,
      bounceIndex: st.bounceIndex,
      spin: st.spin
    });

    // If the rebound is too weak to meaningfully leave the surface, enter roll
    if (Math.abs(newVel.y) < params.rollTransitionVy) {
      st.phase = PHASE.ROLLING;
      this._emit('roll-start', {
        position: hit.point.clone(),
        velocity: newVel.clone(),
        surface
      });
    }
  }

  /**
   * Solid-collider contact: reflect off an arbitrary-normal wall / ramp face.
   *
   * Uses the same normal/tangent split as `_bounce()` but:
   *   - no gravity-plough term (walls don't deform plastically the way turf does)
   *   - no spin-grab coupling by default (`spinGrab: 0` in DEFAULT_COLLIDER —
   *     hard walls don't grab spin, though authored values can override this)
   *   - defensive normal flip (Blender winding may report an inward-facing
   *     normal; the integrator always wants an outward-pointing n)
   *   - anti-stacking short-circuit (weak normal impacts zero out rather than
   *     producing a spam of low-energy BOUNCE events)
   *   - position correction snaps the ball one radius along n out of the wall
   *
   * After a collider contact the ball remains in its current phase (AIRBORNE or
   * ROLLING). A wall hit during rolling just redirects the roll; the ball
   * doesn't go airborne because of it unless a later sub-step says so.
   */
  _collide(hit) {
    const st = this._state;
    const params = this._params;
    const collider = hit.collider;

    // Defensive normal flip: if the incoming velocity dot the reported normal
    // is positive, the ball is moving AWAY from the surface but the raycast
    // still hit it — the normal is pointing into the solid (inverted winding).
    // Flip it so n points outward, toward the ball.
    let n = hit.normal;
    let vDotN = st.velocity.dot(n);
    if (vDotN > 0) {
      n = n.clone().negate();
      vDotN = -vDotN;
    }

    // Anti-stacking: if the ball is barely moving into the wall (|vn| tiny),
    // don't produce a BOUNCE event and don't reflect — just cancel the
    // inward component and snap the ball to rest against the wall. This
    // prevents the per-frame jitter that would otherwise spam events as
    // gravity/slope keeps pushing a stationary ball into the wall.
    if (-vDotN < params.colliderRestVn) {
      st.velocity.addScaledVector(n, -vDotN);                      // zero vn
      st.position.copy(hit.point).addScaledVector(n, params.ballRadius);
      return;
    }

    const vNormal = n.clone().multiplyScalar(vDotN);
    const vTangent = st.velocity.clone().sub(vNormal);

    // Tangent loses energy to friction (no plough on walls).
    const newTangent = vTangent.multiplyScalar(1 - collider.friction);

    // Normal reflects with restitution (vDotN is negative; -vDotN is positive).
    const normalOut = -vDotN * collider.restitution;
    const newVel = newTangent.clone().addScaledVector(n, normalOut);

    // Optional spin-grab (defaults to 0 for solids). Same clamp rule as ground:
    // backspin can zero the tangent against the wall but never reverse it.
    const spinGrab = collider.spinGrab ?? 0;
    if (spinGrab !== 0) {
      const tangentSpeed = newTangent.length();
      if (tangentSpeed > 1e-6) {
        const tangentDir = newTangent.clone().multiplyScalar(1 / tangentSpeed);
        const rawDelta = st.spin * spinGrab * params.spinToVelocity;
        const clampedDelta = rawDelta < 0
          ? Math.max(rawDelta, -tangentSpeed)
          : rawDelta;
        newVel.addScaledVector(tangentDir, clampedDelta);
      }
    }

    st.velocity.copy(newVel);
    st.bounceIndex++;

    // Position correction: sit one radius along the outward normal from the
    // hit point. Prevents the next sub-step's swept-test from re-detecting the
    // same penetration.
    st.position.copy(hit.point).addScaledVector(n, params.ballRadius);

    this._emit('bounce', {
      position: hit.point.clone(),
      velocity: newVel.clone(),
      surface: null,
      collider,
      bounceIndex: st.bounceIndex,
      spin: st.spin
    });
  }

  /**
   * Rolling along a surface.
   *
   * Model: constant-deceleration Coulomb friction, not exponential decay.
   *
   *   dv/dt = -μ · g         (opposite to motion direction)
   *   Δv     = μ · g · dt
   *
   * `rollResistance` is interpreted as the rolling-friction coefficient μ.
   * This produces realistic, bounded rollout: a 5 m/s ball on fairway
   * (μ=0.12) decelerates at 1.18 m/s² and stops in 4.2 s after ~10.6 m,
   * which matches real golf.
   *
   * Previous implementation (`tangent *= 1 - μ·dt`) was exponential decay
   * that never actually reaches zero — balls rolled ~1.5× their real
   * distance and never triggered the rest threshold cleanly.
   *
   * Slope force: the in-plane component of gravity (pulls the ball
   * down-slope). Added AFTER the friction subtraction so friction can't
   * undo the slope acceleration on a balanced slope — that would freeze
   * a ball mid-slope, which is wrong; a ball on a steep enough tilt
   * should accelerate down even with friction.
   */
  _roll(hit, surface, vTangent, dt) {
    const speed = vTangent.length();
    const decel = surface.rollResistance * this._params.gravity * dt;
    if (speed > decel) {
      vTangent.multiplyScalar((speed - decel) / speed);
    } else {
      vTangent.set(0, 0, 0);
    }

    const slope = this._slopeForce(hit.normal, dt);
    vTangent.add(slope);

    this._state.velocity.copy(vTangent);
  }

  /**
   * Gravity projected onto the contact plane.
   *
   * g_vec - (g_vec · n) * n  →  the component of gravity lying in the plane.
   * Multiplied by dt to yield a velocity increment, matching the Δv = a·Δt
   * integration style used elsewhere in the integrator.
   *
   * On a flat plane (n = +Y) this returns the zero vector.
   */
  _slopeForce(normal, dt) {
    const g = new THREE.Vector3(0, -this._params.gravity, 0);
    const along = g.clone().addScaledVector(normal, -g.dot(normal));
    return along.multiplyScalar(dt);
  }

  /**
   * Bookkeeping per sub-step: path length, air vs roll time split.
   * Exposed via the `golf:rest` event payload for post-shot stats.
   */
  _accumulatePathCounters(dt) {
    const st = this._state;
    const step = st.position.clone().sub(st.lastPosition);
    st.totalDistance += step.length();
    st.lastPosition.copy(st.position);
    if (st.phase === PHASE.AIRBORNE) st.totalAirTime += dt;
    else if (st.phase === PHASE.ROLLING) st.totalRollTime += dt;
  }

  /**
   * Run trigger detection if a detector is wired. Emit `trigger` per new entry.
   * Phase-3-safe: the detector is optional; if `null`, this is a no-op.
   */
  _scanTriggers() {
    if (!this._triggers) return;
    const fired = this._triggers.testStep(
      this._state.position,
      this._params.ballRadius,
      this._state.velocity
    );
    if (!fired || fired.length === 0) return;
    for (const payload of fired) this._emit('trigger', payload);
  }

  _handleAbsorb(hit) {
    this._state.phase = PHASE.ABSORBED;
    this._state.position.copy(hit.point);
    this._emit('water', {
      position: hit.point.clone(),
      velocity: this._state.velocity.clone(),
      surface: hit.surface
    });
  }

  /**
   * Ball contacted the cup floor (ground punch + absorb surface). Distinct
   * from water so the host can keep the ball in the cup instead of re-teeing.
   */
  _handleHoled(hit) {
    const st = this._state;
    st.phase = PHASE.HOLED;
    // Seat the ball centre on the floor (hit.point is the floor contact).
    const r = this._params.ballRadius;
    const n = hit.normal || new THREE.Vector3(0, 1, 0);
    st.position.copy(hit.point).addScaledVector(n, r);
    st.velocity.set(0, 0, 0);
    const cup = this._cup?.cup ?? null;
    this._emit('holed', {
      position: st.position.clone(),
      velocity: new THREE.Vector3(0, 0, 0),
      surface: hit.surface,
      cup: cup
        ? { id: cup.id, holeNumber: cup.holeNumber }
        : { id: 'hole_cup', holeNumber: null }
    });
  }

  _checkRest() {
    const st = this._state;
    // In rolling phase, gravity keeps injecting a small y-component into
    // velocity between contacts (it's stripped back out by _roll but only
    // after this check). Measure only the tangential (horizontal-ish) speed
    // so the ball can actually come to rest on a real surface.
    const speedSq = st.phase === PHASE.ROLLING
      ? st.velocity.x * st.velocity.x + st.velocity.z * st.velocity.z
      : st.velocity.lengthSq();
    if (speedSq < this._params.restingThreshold ** 2) {
      st.restFramesAccrued++;
      if (st.restFramesAccrued >= this._params.restingFrames) {
        st.phase = PHASE.AT_REST;
        this._emitRest('threshold');
      }
    } else {
      st.restFramesAccrued = 0;
    }
  }

  _emitRest(reason) {
    this._emit('rest', {
      reason,
      position: this._state.position.clone(),
      surface: this._sampler.sampleAt(this._state.position.x, this._state.position.z)?.surface ?? null,
      totalDistance: this._state.totalDistance,
      totalAirTime: this._state.totalAirTime,
      totalRollTime: this._state.totalRollTime
    });
  }

  _isFinished() {
    return this._state.phase === PHASE.AT_REST
      || this._state.phase === PHASE.ABSORBED
      || this._state.phase === PHASE.HOLED;
  }
}

export const PHYSICS_PHASES = PHASE;
