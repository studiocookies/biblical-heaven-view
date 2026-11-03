// Entry: wires scroll (GSAP ScrollTrigger) to the mission clock, runs the HUD,
// the widgets, the optional sound, and adaptive quality.
import { stateAt, fmtClock, T_CONTACT } from './sim.js';
import { ENGINE_LAYOUT } from './layout.js';
import { initWidgets } from './widgets.js';
import { Sound } from './audio.js';

const gsap = window.gsap;
const ScrollTrigger = window.ScrollTrigger;
const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
let reduced = mq.matches;
const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------------------
// Quality tier: 0 lite, 1 phone, 2 full.
function pickTier() {
  const q = new URLSearchParams(location.search).get('q');
  if (q === 'low') return 0; if (q === 'mid') return 1; if (q === 'high') return 2;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const small = Math.min(screen.width, screen.height) < 700;
  let t = coarse || small ? 1 : 2;
  if ((navigator.hardwareConcurrency || 8) <= 4) t = Math.min(t, 1);
  if (navigator.deviceMemory && navigator.deviceMemory <= 2) t = 0;
  return t;
}

function webglOK() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// Chapter parsing: data-map "p:t,p:t" and data-shots "shot:untilP,..."
const chapters = [...document.querySelectorAll('.chapter')].map((el) => {
  const map = el.dataset.map.split(',').map((s) => s.split(':').map(Number));
  const shots = el.dataset.shots.split(',').map((s) => { const [n, p] = s.split(':'); return { name: n, until: Number(p) }; });
  return { el, id: el.id, map, shots };
});
function mapTime(ch, p) {
  const m = ch.map;
  if (p <= m[0][0]) return m[0][1];
  for (let i = 0; i < m.length - 1; i++) {
    if (p <= m[i + 1][0]) { const k = (p - m[i][0]) / (m[i + 1][0] - m[i][0]); return m[i][1] + (m[i + 1][1] - m[i][1]) * k; }
  }
  return m[m.length - 1][1];
}
function shotFor(ch, p) {
  for (const s of ch.shots) if (p <= s.until) return s.name;
  return ch.shots[ch.shots.length - 1].name;
}

// ---------------------------------------------------------------------------
const clock = { t: -60 };
let targetT = -60;
let currentShot = 'hero', shotLocal = 0, activeId = 'intro';
let world = null;

function onChapter(ch, p) {
  activeId = ch.id;
  targetT = mapTime(ch, p);
  currentShot = shotFor(ch, p);
  // local progress inside the active shot
  const idx = ch.shots.findIndex((s) => s.name === currentShot);
  const from = idx > 0 ? ch.shots[idx - 1].until : 0;
  shotLocal = Math.min(1, Math.max(0, (p - from) / Math.max(0.001, ch.shots[idx].until - from)));
  if (reduced || !gsap) { clock.t = targetT; }
  else gsap.to(clock, { t: targetT, duration: 0.55, ease: 'power2.out', overwrite: true });
  document.body.classList.toggle('dim', ch.id === 'next' || ch.id === 'credits');
  document.body.classList.toggle('slow', ch.id === 'catch');
}

function setupScroll() {
  if (!gsap || !ScrollTrigger) {
    // Fallback if the animation library failed to load: plain scroll math.
    const run = () => {
      const mid = scrollY + innerHeight / 2;
      for (const ch of chapters) {
        const top = ch.el.offsetTop, h = ch.el.offsetHeight;
        if (mid >= top && mid < top + h) { onChapter(ch, (mid - top) / h); break; }
      }
    };
    addEventListener('scroll', run, { passive: true }); run();
    return;
  }
  gsap.registerPlugin(ScrollTrigger);
  for (const ch of chapters) {
    ScrollTrigger.create({
      trigger: ch.el, start: 'top center', end: 'bottom center',
      onUpdate: (self) => onChapter(ch, self.progress),
      onToggle: (self) => { if (self.isActive) onChapter(ch, self.progress); },
    });
  }
  // The first chapter starts already past "top center"; seed it.
  onChapter(chapters[0], 0);
}

// ---------------------------------------------------------------------------
// HUD
const hud = { clock: $('#clock'), phase: $('#phase'), alt: $('#alt'), spd: $('#spd'), engN: $('#engN'), glyph: $('#engGlyph'), scrub: $('#scrub'), ticks: $('#ticks') };
const glyphDots = ENGINE_LAYOUT.map((e) => {
  const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  c.setAttribute('cx', e.x.toFixed(2)); c.setAttribute('cy', e.z.toFixed(2)); c.setAttribute('r', '0.52');
  hud.glyph.appendChild(c); return c;
});
let lastPhase = '', lastSet = '';
function updateHUD(s) {
  hud.clock.textContent = fmtClock(s.t);
  if (s.phase.label !== lastPhase) { hud.phase.textContent = s.phase.label; lastPhase = s.phase.label; }
  const resetPhase = s.t >= 418;
  hud.alt.textContent = resetPhase ? '0.0' : (s.alt / 1000).toFixed(s.alt < 10000 ? 2 : 1);
  hud.spd.textContent = resetPhase ? '0' : Math.round(s.speed * 3.6).toLocaleString('en-US');
  hud.engN.textContent = s.eng.count;
  if (s.eng.set !== lastSet) {
    lastSet = s.eng.set;
    glyphDots.forEach((d, i) => d.classList.toggle('on', s.eng.set === 'all' || (s.eng.set === 'inner' && i < 13) || (s.eng.set === 'center' && i < 3)));
  }
}

// Timeline: a range input over the story's scroll length, with chapter ticks.
const TICKS = [['liftoff', 'Liftoff'], ['turnaround', 'Staging'], ['fall', 'Fall'], ['landing', 'Landing burn'], ['catch', 'Catch'], ['reset', 'Reset']];
let scrubMax = 1;
function layoutTicks() {
  const half = innerHeight / 2;
  const reset = $('#reset');
  scrubMax = Math.max(1, reset.offsetTop + reset.offsetHeight - half);
  hud.ticks.innerHTML = '';
  for (const [id, label] of TICKS) {
    const el = document.getElementById(id);
    const y = el.offsetTop - half;
    const sp = document.createElement('span');
    sp.textContent = label; sp.dataset.id = id;
    sp.style.left = `${Math.max(0, Math.min(100, (y / scrubMax) * 100))}%`;
    hud.ticks.appendChild(sp);
  }
}
let scrubbing = false;
hud.scrub.addEventListener('input', () => {
  scrubbing = true;
  window.scrollTo({ top: (hud.scrub.value / 1000) * scrubMax, behavior: 'auto' });
});
hud.scrub.addEventListener('change', () => { scrubbing = false; });
hud.scrub.addEventListener('pointerup', () => { scrubbing = false; });
function syncScrub() {
  if (!scrubbing) hud.scrub.value = Math.round(Math.min(1, scrollY / scrubMax) * 1000);
  hud.scrub.setAttribute('aria-valuetext', `${fmtClock(clock.t)}, ${stateAt(clock.t).phase.label}`);
  for (const sp of hud.ticks.children) sp.classList.toggle('on', sp.dataset.id === activeId);
}

// ---------------------------------------------------------------------------
// Camera and toggles
const camBtns = [...document.querySelectorAll('.cam')];
camBtns.forEach((b) => b.addEventListener('click', () => {
  camBtns.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  if (world) world.override = b.dataset.cam;
}));

const motionBtn = $('#motionBtn');
function setReduced(v) {
  reduced = v;
  motionBtn.setAttribute('aria-pressed', String(v));
  if (world) world.reducedMotion = v;
}
setReduced(reduced);
motionBtn.addEventListener('click', () => setReduced(!reduced));
mq.addEventListener?.('change', (e) => setReduced(e.matches));

const sound = new Sound();
const soundBtn = $('#soundBtn');
soundBtn.addEventListener('click', () => {
  const on = soundBtn.getAttribute('aria-pressed') !== 'true';
  soundBtn.setAttribute('aria-pressed', String(on));
  soundBtn.title = on ? 'Sound is on. Click to mute.' : 'Sound is off. Turn it on for synthesized engine and wind sound.';
  sound.setEnabled(on);
});

// ---------------------------------------------------------------------------
// Annotation labels
const tags = [...document.querySelectorAll('.tag')];
const measure = $('#measure'), measureTower = $('#measureTower');
function placeLabels() {
  const showTags = world.override === 'auto' && currentShot === 'closeup';
  const showMeasure = world.override === 'auto' && (currentShot === 'wide' || currentShot === 'pad');
  const A = world.anchors();
  for (const t of tags) {
    const p = world.project(A[t.dataset.anchor]);
    const ok = showTags && p.visible && p.x > 20 && p.x < innerWidth - 80 && p.y > 60 && p.y < innerHeight - 120;
    t.classList.toggle('show', ok);
    if (ok) t.style.transform = `translate(${p.x + 14}px, ${p.y}px) translateY(-50%)`;
  }
  const a = world.project(A.top), b = world.project(A.bottom);
  const mOk = showMeasure && a.visible && b.visible;
  measure.classList.toggle('show', mOk);
  if (mOk) { const x = Math.min(a.x, b.x) - 26; measure.style.transform = `translate(${x}px, ${a.y}px)`; measure.style.height = `${Math.max(0, b.y - a.y)}px`; }
  const ta = world.project(A.towerTop), tb = world.project(A.towerBase);
  const tOk = showMeasure && ta.visible && tb.visible;
  measureTower.classList.toggle('show', tOk);
  if (tOk) { const x = Math.max(ta.x, tb.x) + 34; measureTower.style.transform = `translate(${x}px, ${ta.y}px)`; measureTower.style.height = `${Math.max(0, tb.y - ta.y)}px`; }
}

// ---------------------------------------------------------------------------
async function boot() {
  initWidgets({ reduced: () => reduced });
  setupScroll();
  layoutTicks();
  addEventListener('resize', () => { layoutTicks(); world?.resize(); ScrollTrigger?.refresh(); });
  addEventListener('scroll', syncScrub, { passive: true });

  if (!webglOK()) { document.body.classList.add('no-webgl'); return; }
  let World;
  try { ({ World } = await import('./scene.js')); } catch (e) { console.error(e); document.body.classList.add('no-webgl'); return; }
  let tier = pickTier();
  const pinned = new URLSearchParams(location.search).has('q');
  world = new World($('#scene'), { tier, reducedMotion: reduced });
  world.override = camBtns.find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.cam || 'auto';

  let last = performance.now(), acc = 0, frames = 0, lastDrop = performance.now(), prevT = clock.t;
  function loop(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    world.setMission(clock.t);
    world.setShot(currentShot, shotLocal);
    world.frame(dt);
    const s = world.state;
    updateHUD(s);
    placeLabels();
    sound.update(s, world, prevT);
    prevT = clock.t;
    // adaptive quality: step down if frames run long for a couple of seconds
    acc += dt; frames++;
    if (acc > 2) {
      const avg = acc / frames;
      if (!pinned && avg > 1 / 40 && tier > 0 && now - lastDrop > 4000) { tier--; world.setTier(tier); lastDrop = now; }
      acc = 0; frames = 0;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  syncScrub();
  window.__catch = { world, clock, settle: () => { for (let i = 0; i < 150; i++) world.updateCamera(1 / 60); } };
}
boot();
