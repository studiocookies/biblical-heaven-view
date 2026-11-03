// Interactive pieces that live in the story column.
import { ENGINE_LAYOUT } from './layout.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
};

export function initWidgets({ reduced }) {
  reuseWidget();
  engineWidget();
  compareWidget(reduced);
}

// ---------------------------------------------------------------------------
function reuseWidget() {
  const nL = document.getElementById('nLaunch'), nF = document.getElementById('nFlights');
  const oL = document.getElementById('nLaunchOut'), oF = document.getElementById('nFlightsOut');
  const tN = document.getElementById('throwN'), rN = document.getElementById('reuseN');
  const tG = document.getElementById('throwG'), rG = document.getElementById('reuseG');
  function draw() {
    const L = +nL.value, F = +nF.value, R = Math.ceil(L / F);
    oL.textContent = L; oF.textContent = F; tN.textContent = L; rN.textContent = R;
    tG.innerHTML = '<i></i>'.repeat(L);
    rG.innerHTML = '<i></i>'.repeat(R);
  }
  nL.addEventListener('input', draw); nF.addEventListener('input', draw);
  draw();
}

// ---------------------------------------------------------------------------
const SET_INFO = {
  33: 'Liftoff. All 33 engines fire. It takes every one of them to lift the fully fueled stack.',
  13: 'Boostback and the start of the landing burn. The 3 center engines plus the inner ring of 10. All 13 can swivel to steer.',
  3: 'Final approach and catch. Just the 3 center engines, throttled down, for fine control as the booster slides into the arms.',
};
const RING_INFO = {
  center: 'Center engine, one of 3. Swivels to steer. Runs at liftoff, boostback, and all the way to the catch.',
  inner: 'Inner ring, one of 10. Swivels to steer. Runs at liftoff, boostback, and the first seconds of the landing burn.',
  outer: 'Outer ring, one of 20. Fixed in place, so it cannot steer. On Flight 5 era boosters these fire only for the climb.',
};
function engineWidget() {
  const svg = document.getElementById('engSvg');
  const info = document.getElementById('engInfo');
  el('circle', { cx: 0, cy: 0, r: 4.5, class: 'skirt' }, svg);
  for (const r of [0.95, 2.5, 3.88]) el('circle', { cx: 0, cy: 0, r, class: 'ringguide' }, svg);
  const dots = ENGINE_LAYOUT.map((e, i) => {
    const c = el('circle', { cx: e.x.toFixed(3), cy: e.z.toFixed(3), r: 0.56, class: 'e' }, svg);
    c.addEventListener('click', () => {
      dots.forEach((d) => d.classList.toggle('pick', d === c));
      info.textContent = RING_INFO[e.ring];
    });
    return c;
  });
  el('text', { x: 0, y: 5.05, 'text-anchor': 'middle', class: 'lbl' }, svg).textContent = '9 m diameter, viewed from below';
  const btns = [...document.querySelectorAll('#engines .seg button')];
  function setSet(n) {
    btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.set === String(n))));
    dots.forEach((d, i) => { d.classList.toggle('on', i < n); d.classList.remove('pick'); });
    info.textContent = SET_INFO[n];
  }
  btns.forEach((b) => b.addEventListener('click', () => setSet(+b.dataset.set)));
  setSet(33);
}

// ---------------------------------------------------------------------------
// Falcon 9 first stage vs Super Heavy, to scale (2.6 px per meter).
function compareWidget(reduced) {
  const svg = document.getElementById('cmpSvg');
  const S = 2.6, G = 248;
  el('line', { x1: 0, y1: G, x2: 400, y2: G, class: 'gnd' }, svg);

  // Falcon 9 on a drone ship deck
  el('rect', { x: 40, y: G - 6, width: 120, height: 6, class: 'dark' }, svg);
  const f9 = el('g', {}, svg);
  const f9h = 41.2 * S, f9w = 3.7 * S, cx = 100;
  el('rect', { x: cx - f9w / 2, y: G - 6 - f9h, width: f9w, height: f9h, class: 'f9' }, f9);
  el('rect', { x: cx - f9w / 2, y: G - 6 - f9h, width: f9w, height: 6, class: 'dark' }, f9); // interstage
  for (const s of [-1, 1]) {
    el('path', { d: `M${cx + s * f9w / 2} ${G - 6 - 9 * S} L${cx + s * (f9w / 2 + 6.5 * S)} ${G - 6} L${cx + s * (f9w / 2 + 6.5 * S) - s * 2} ${G - 6} L${cx + s * f9w / 2} ${G - 6 - 6 * S} Z`, class: 'dark' }, f9);
    el('rect', { x: cx + s * (f9w / 2) - (s > 0 ? 0 : 5), y: G - 6 - f9h + 4, width: 5, height: 3, class: 'dark' }, f9); // grid fins
  }
  const f9flame = el('path', { d: `M${cx - 3} ${G - 6} Q${cx} ${G + 26} ${cx + 3} ${G - 6} Z`, class: 'flame', opacity: 0 }, f9);
  el('text', { x: cx, y: G + 12, 'text-anchor': 'middle' }, svg).textContent = 'Falcon 9 booster, 41 m';

  // Person for scale
  el('rect', { x: 148, y: G - 6 - 1.8 * S, width: 1.4, height: 1.8 * S, class: 'person' }, svg);
  el('line', { x1: 148.7, y1: G - 16, x2: 148.7, y2: G - 30, class: 'gnd' }, svg);
  el('text', { x: 148.7, y: G - 33, 'text-anchor': 'middle' }, svg).textContent = 'person, 1.8 m';

  // Super Heavy in the tower
  const tx = 330, shx = 272, shw = 9 * S, shh = 71 * S;
  el('rect', { x: shx - 26, y: G - 20 * S * 0.5 - 6, width: 52, height: 26 * 0.5, class: 'dark' }, svg); // mount
  el('rect', { x: tx - 16, y: 0, width: 32, height: G, class: 'tower' }, svg);
  for (let y = G; y > 0; y -= 34) el('path', { d: `M${tx - 16} ${y} L${tx + 16} ${y - 34} M${tx + 16} ${y} L${tx - 16} ${y - 34}`, class: 'tower' }, svg);
  const restBottom = G - 13 - 10 * S; // caught about 10 m above the mount (illustrative)
  const armY = restBottom - 62.5 * S;
  el('rect', { x: shx - shw / 2 - 12, y: armY, width: tx - 16 - (shx - shw / 2 - 12), height: 6, class: 'armc' }, svg);
  const sh = el('g', {}, svg);
  el('rect', { x: shx - shw / 2, y: restBottom - shh, width: shw, height: shh, class: 'sh' }, sh);
  el('rect', { x: shx - shw / 2, y: restBottom - shh, width: shw, height: 2.2 * S, class: 'dark' }, sh);
  el('rect', { x: shx - shw / 2 - 9, y: restBottom - 66 * S, width: shw + 18, height: 3, class: 'dark' }, sh); // grid fins
  el('rect', { x: shx + shw / 2, y: armY - 3, width: 4, height: 3, class: 'ship' }, sh); // hard point
  const shflame = el('path', { d: `M${shx - 4} ${restBottom} Q${shx} ${restBottom + 30} ${shx + 4} ${restBottom} Z`, class: 'flame', opacity: 0 }, sh);
  el('text', { x: shx, y: G + 12, 'text-anchor': 'middle' }, svg).textContent = 'Super Heavy, 71 m';
  el('text', { x: tx, y: 12, 'text-anchor': 'middle' }, svg).textContent = 'tower';

  const btn = document.getElementById('cmpPlay');
  const gsap = window.gsap;
  btn.addEventListener('click', () => {
    if (reduced() || !gsap) {
      btn.textContent = 'Both are shown at rest';
      return;
    }
    const tl = gsap.timeline();
    tl.set([f9flame, shflame], { opacity: 0.9 })
      .fromTo(f9, { y: -140 }, { y: 0, duration: 2.6, ease: 'power3.out' }, 0)
      .fromTo(sh, { y: -150 }, { y: 0, duration: 2.8, ease: 'power3.out' }, 0)
      .to([f9flame, shflame], { opacity: 0, duration: 0.25 }, 2.6);
  });
}
