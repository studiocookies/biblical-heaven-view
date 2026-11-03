// Mission model.
// Every value here is an ILLUSTRATIVE approximation built to tell the story
// smoothly. It is not flight telemetry. Event order and rough timing follow the
// Flight 5 webcast era: staging near 74 km, boostback, an unpowered fall steered
// by grid fins, a 13 then 3 engine landing burn, and a catch about 7 minutes in.
//
// World frame: meters. +y is up. +x points east, out over the Gulf of Mexico.
// The launch mount is at the origin. The tower stands at z = -22.

export const BOOSTER_LEN = 71;      // about 71 m (233 ft)
export const BOOSTER_R = 4.5;       // 9 m diameter
export const SHIP_LEN = 50;
export const MOUNT_TOP = 20;        // top of the launch mount table (illustrative)
export const PIN_Y = 62.5;          // catch hard points, height above booster base (illustrative)
export const ARM_CATCH_TOP = MOUNT_TOP + 10 + PIN_Y; // rail height during the catch
export const ARM_RESET_TOP = MOUNT_TOP + PIN_Y;      // rail height when booster sits on the mount
export const TOWER_Z = -22;
export const TOWER_H = 145;         // roughly 145 m

export const T_START = -60;
export const T_LIFTOFF = 0;
export const T_STAGING = 161;
export const T_LANDING = 392;
export const T_THREE = 397.5;
export const T_CONTACT = 413.8;     // pins meet the rails, about 6 min 54 s
export const T_END = 472;

// ---------------------------------------------------------------------------
// Monotone cubic interpolation (Fritsch-Carlson) so curves never overshoot.
function makeCurve(keys) {
  const n = keys.length;
  const xs = keys.map(k => k[0]);
  const ys = keys.map(k => k[1]);
  const d = [];
  const m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  function seg(x) {
    if (x <= xs[0]) return -1;
    if (x >= xs[n - 1]) return n - 1;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    return lo;
  }
  return {
    at(x) {
      const i = seg(x);
      if (i < 0) return ys[0];
      if (i >= n - 1) return ys[n - 1];
      const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] +
        (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    },
    slope(x) {
      const i = seg(x);
      if (i < 0 || i >= n - 1) return 0;
      const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t;
      return ((6 * t2 - 6 * t) * ys[i] + (3 * t2 - 4 * t + 1) * h * m[i] +
        (-6 * t2 + 6 * t) * ys[i + 1] + (3 * t2 - 2 * t) * h * m[i + 1]) / h;
    }
  };
}

// Booster base position: [t, downrange x, base height y]
const TRAJ = [
  [-60, 0, MOUNT_TOP], [0, 0, MOUNT_TOP], [5, 0, 75], [10, 0, 260], [20, 25, 1100],
  [30, 140, 2600], [45, 700, 6000], [62, 2200, 12000], [80, 6000, 20000],
  [100, 15000, 31000], [120, 29000, 44000], [140, 48000, 58000], [161, 72000, 74000],
  [180, 91000, 83000], [200, 99000, 88500], [225, 95000, 91500], [250, 82000, 90000],
  [280, 64000, 81000], [310, 44000, 64000], [340, 24000, 40000], [365, 9500, 18000],
  [382, 2800, 6000], [392, 700, 1700], [400, 150, 450], [406, 38, 160],
  [410, 9, 62], [T_CONTACT, 0, MOUNT_TOP + 10], [420, 0, MOUNT_TOP + 10]
];
const curveX = makeCurve(TRAJ.map(k => [k[0], k[1]]));
const curveY = makeCurve(TRAJ.map(k => [k[0], k[2]]));

// Pitch from vertical, degrees. Positive tips the nose toward +x (downrange).
const curvePitch = makeCurve([
  [-60, 0], [8, 0], [40, 8], [80, 28], [120, 44], [161, 52], [166, 52], [184, -78],
  [224, -78], [244, -14], [262, -3], [392, -2], [399, 6], [406, 5], [411, 1.5], [T_CONTACT, 0], [500, 0]
]);
const curveRoll = makeCurve([[-60, 0], [20, 0], [70, 18], [161, 18], [250, 10], [380, 4], [404, 0], [500, 0]]);

// Chopstick arms: opening angle in degrees and rail-top height.
const curveArmOpen = makeCurve([
  [-60, 40], [405.5, 40], [409, 26], [412.6, 0], [458, 0], [463, 24], [500, 24]
]);
const curveArmTop = makeCurve([
  [-60, ARM_CATCH_TOP], [424, ARM_CATCH_TOP], [452, ARM_RESET_TOP], [464, ARM_RESET_TOP],
  [470, ARM_RESET_TOP + 16], [500, ARM_RESET_TOP + 16]
]);

// Engine sets: which ring groups are lit and at what throttle.
// 'all' = 33, 'inner' = 13 (3 center + 10 inner ring), 'center' = 3.
export function engines(t) {
  if (t < -3) return { set: 'none', count: 0, throttle: 0 };
  if (t < 0) return { set: 'all', count: 33, throttle: 0.35 + 0.65 * ((t + 3) / 3) };
  if (t < 52) return { set: 'all', count: 33, throttle: 1 };
  if (t < 72) return { set: 'all', count: 33, throttle: 0.82 };   // throttle down near max Q
  if (t < 159) return { set: 'all', count: 33, throttle: 1 };
  if (t < 170) return { set: 'center', count: 3, throttle: 0.55 }; // hot staging: 30 engines off
  if (t < 174) return { set: 'inner', count: 13, throttle: 0.4 + 0.15 * (t - 170) };
  if (t < 222) return { set: 'inner', count: 13, throttle: 1 };    // boostback
  if (t < 224) return { set: 'center', count: 3, throttle: 0.6 };
  if (t < T_LANDING) return { set: 'none', count: 0, throttle: 0 };
  if (t < T_THREE) return { set: 'inner', count: 13, throttle: 1 };
  if (t < T_CONTACT + 0.15) return { set: 'center', count: 3, throttle: 0.9 - 0.3 * Math.min(1, (t - T_THREE) / 10) };
  return { set: 'none', count: 0, throttle: 0 };
}

export function phaseOf(t) {
  if (t < -3) return { id: 'pad', label: 'On the pad' };
  if (t < 0) return { id: 'ignition', label: 'Engine start' };
  if (t < 10) return { id: 'liftoff', label: 'Liftoff' };
  if (t < 52) return { id: 'ascent', label: 'Ascent' };
  if (t < 72) return { id: 'maxq', label: 'Max Q' };
  if (t < 159) return { id: 'ascent', label: 'Ascent' };
  if (t < 166) return { id: 'staging', label: 'Hot staging' };
  if (t < 174) return { id: 'flip', label: 'Flip' };
  if (t < 224) return { id: 'boostback', label: 'Boostback burn' };
  if (t < 300) return { id: 'coast', label: 'Coast' };
  if (t < T_LANDING) return { id: 'fall', label: 'Fall: grid fin control' };
  if (t < T_THREE) return { id: 'landing13', label: 'Landing burn: 13 engines' };
  if (t < 407) return { id: 'landing3', label: 'Landing burn: 3 engines' };
  if (t < T_CONTACT) return { id: 'catch', label: 'Catch' };
  if (t < 418) return { id: 'caught', label: 'Caught' };
  return { id: 'reset', label: 'Reset (time compressed)' };
}

const DEG = Math.PI / 180;

// Full state at mission time t. Pure function: scrub forward or backward freely.
export function stateAt(t) {
  const s = {};
  s.t = t;
  s.armOpen = curveArmOpen.at(t) * DEG;
  s.armTop = curveArmTop.at(t);

  if (t <= 418) {
    s.x = curveX.at(t);
    s.y = curveY.at(t);
    s.vx = curveX.slope(t);
    s.vy = curveY.slope(t);
    if (t > T_CONTACT && t < 418) {
      // The rails' shock absorbers take up the load: a short, damped dip.
      const k = t - T_CONTACT;
      s.y -= 0.55 * Math.sin(k * 4.2) * Math.exp(-k * 1.6);
    }
  } else {
    // Reset: the booster rides the arms down onto the launch mount.
    s.x = 0; s.vx = 0; s.vy = 0;
    const attachedTop = Math.min(s.armTop, curveArmTop.at(Math.min(t, 457)));
    s.y = Math.max(MOUNT_TOP, attachedTop - PIN_Y);
  }
  s.z = 0;
  s.pitch = curvePitch.at(t) * DEG;
  if (t > 244 && t < 390) s.pitch += Math.sin(t * 0.9) * 1.2 * DEG * Math.min(1, (t - 244) / 10) * Math.min(1, (390 - t) / 10);
  s.roll = curveRoll.at(t) * DEG;
  s.speed = Math.hypot(s.vx, s.vy);           // m/s
  s.alt = Math.max(0, s.y - MOUNT_TOP);         // meters above the pad table (illustrative)
  s.eng = engines(t);
  s.phase = phaseOf(t);

  // Grid fin deflection: gentle steering moves during the fall and landing.
  const finWork = t > 230 && t < T_CONTACT ? 1 : 0;
  s.fin = finWork * (Math.sin(t * 1.3) * 0.18 + Math.sin(t * 3.1 + 1) * 0.07);

  // Ship rides on top until hot staging, then flies away.
  s.shipAttached = t < T_STAGING;
  s.shipVisible = t < 215;
  s.frost = t < 0 ? 1 : t < 161 ? 1 - 0.55 * (t / 161) : Math.max(0, 0.45 - (t - 161) / 120);
  return s;
}

// Ship trajectory after staging: keeps the stack's direction and accelerates away.
const STAGE = { x: curveX.at(T_STAGING), y: curveY.at(T_STAGING), vx: curveX.slope(T_STAGING), vy: curveY.slope(T_STAGING), pitch: curvePitch.at(T_STAGING) * DEG };
export function shipAt(t) {
  if (t < T_STAGING) return null;
  const dt = t - T_STAGING;
  const a = 14 * Math.min(1, dt / 2);
  const along = 0.5 * a * dt * dt;
  return {
    x: STAGE.x + STAGE.vx * dt + Math.sin(STAGE.pitch) * along,
    y: STAGE.y + STAGE.vy * dt + Math.cos(STAGE.pitch) * along,
    pitch: STAGE.pitch - Math.min(dt, 30) * 0.004,
    burning: true,
  };
}

export function fmtClock(t) {
  if (t >= 418) return 'T+ --:--';
  const sign = t < 0 ? '−' : '+';
  const a = Math.abs(t);
  const m = Math.floor(a / 60), sec = a - m * 60;
  const ss = sec.toFixed(1).padStart(4, '0');
  return `T${sign} ${String(m).padStart(2, '0')}:${ss}`;
}
