// Procedural models. Real proportions where they are public (71 m x 9 m booster,
// 33 engines in a 3 / 10 / 20 layout, about 50 m ship, roughly 145 m tower).
// Small details (arm truss spacing, mount size, fin size) are illustrative.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ENGINE_LAYOUT } from './layout.js';
export { ENGINE_LAYOUT };
import { BOOSTER_LEN, BOOSTER_R, PIN_Y, TOWER_Z, TOWER_H, MOUNT_TOP } from './sim.js';

// ---------------------------------------------------------------------------
// Small helpers
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boxAt(w, h, d, x, y, z, ry = 0, rx = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')),
    new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  return g;
}

// A beam between two points (box with square section).
function beam(a, b, t) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new THREE.BoxGeometry(t, len, t);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(a.clone().lerp(b, 0.5), q, new THREE.Vector3(1, 1, 1)));
  return g;
}

// ---------------------------------------------------------------------------
// Stainless steel skin: ring seams every ~1.8 m, three welds per ring,
// brushed grain, per-ring tone shifts, and heat tint near the engines.
function steelTextures({ seed = 7, length = BOOSTER_LEN, belly = false, w = 512, h = 2048 }) {
  const r = rng(seed);
  const rings = Math.round(length / 1.83);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  const rc = document.createElement('canvas'); rc.width = w; rc.height = h;
  const rg = rc.getContext('2d');
  const ringH = h / rings;
  for (let i = 0; i < rings; i++) {
    const y0 = h - (i + 1) * ringH;
    const tone = 182 + (r() - 0.5) * 22;
    g.fillStyle = `rgb(${tone + 2},${tone + 4},${tone + 7})`;
    g.fillRect(0, y0, w, ringH + 1);
    const rough = 70 + r() * 40;
    rg.fillStyle = `rgb(${rough},${rough},${rough})`;
    rg.fillRect(0, y0, w, ringH + 1);
    // brushed grain
    for (let k = 0; k < 90; k++) {
      const x = r() * w;
      g.fillStyle = r() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
      g.fillRect(x, y0, 1 + r() * 2, ringH);
    }
    // three vertical welds per ring, staggered
    const off = r();
    for (let k = 0; k < 3; k++) {
      const x = ((off + k / 3) % 1) * w;
      g.fillStyle = 'rgba(60,58,56,0.55)'; g.fillRect(x, y0, 2, ringH);
      g.fillStyle = 'rgba(255,240,220,0.18)'; g.fillRect(x + 2, y0, 1, ringH);
      rg.fillStyle = 'rgb(160,160,160)'; rg.fillRect(x - 1, y0, 4, ringH);
    }
    // horizontal seam
    g.fillStyle = 'rgba(40,38,36,0.7)'; g.fillRect(0, y0, w, 2);
    g.fillStyle = 'rgba(255,235,210,0.22)'; g.fillRect(0, y0 + 2, w, 1);
    rg.fillStyle = 'rgb(170,170,170)'; rg.fillRect(0, y0 - 1, w, 4);
  }
  // heat tint: straw and blue bands near the engines, soot toward the base
  const grad = g.createLinearGradient(0, h, 0, h * 0.86);
  grad.addColorStop(0, 'rgba(30,24,20,0.85)');
  grad.addColorStop(0.25, 'rgba(90,70,120,0.35)');
  grad.addColorStop(0.55, 'rgba(170,130,70,0.25)');
  grad.addColorStop(1, 'rgba(170,130,70,0)');
  g.fillStyle = grad; g.fillRect(0, h * 0.86, w, h * 0.14);
  if (!belly) {
    // a faint streak of soot below the fins from hot staging
    const sg = g.createLinearGradient(0, 0, 0, h * 0.12);
    sg.addColorStop(0, 'rgba(40,34,30,0.55)'); sg.addColorStop(1, 'rgba(40,34,30,0)');
    g.fillStyle = sg; g.fillRect(0, 0, w, h * 0.12);
  }
  if (belly) {
    // Ship heat shield: black hexagonal tiles over half the circumference.
    const tile = 7;
    for (let y = 0; y < h; y += tile * 0.87) {
      const row = Math.round(y / (tile * 0.87));
      for (let x = w * 0.5; x < w; x += tile) {
        const xx = x + (row % 2 ? tile / 2 : 0);
        const v = 22 + r() * 12;
        g.fillStyle = `rgb(${v},${v},${v + 2})`;
        g.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = Math.PI / 6 + k * Math.PI / 3;
          g.lineTo(xx + Math.cos(a) * tile * 0.47, y + Math.sin(a) * tile * 0.47);
        }
        g.fill();
        rg.fillStyle = 'rgb(220,220,220)'; rg.fillRect(xx - tile / 2, y - tile / 2, tile, tile);
      }
    }
    // a handful of off-white replacement tiles, like the real thing
    for (let k = 0; k < 40; k++) {
      g.fillStyle = 'rgba(210,205,195,0.9)';
      g.fillRect(w * 0.5 + r() * w * 0.5, r() * h, 6, 5);
    }
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.anisotropy = 8;
  const rough = new THREE.CanvasTexture(rc);
  rough.wrapS = THREE.RepeatWrapping;
  return { map, rough };
}

function steelMaterial(tex, frostUniform) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: tex.map, roughnessMap: tex.rough,
    metalness: 0.88, roughness: 0.85, envMapIntensity: 1.7,
  });
  if (frostUniform) {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uFrost = frostUniform;
      sh.fragmentShader = 'uniform float uFrost;\n' + sh.fragmentShader
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          float fv = vMapUv.y;
          float band = smoothstep(0.05,0.08,fv)*(1.0-smoothstep(0.57,0.60,fv)) + smoothstep(0.63,0.66,fv)*(1.0-smoothstep(0.88,0.91,fv));
          vec2 cell = floor(vMapUv*vec2(220.0,1100.0));
          float hn = fract(sin(dot(cell, vec2(12.9898,78.233)))*43758.5453);
          float streak = 0.5 + 0.5*sin(vMapUv.x*420.0 + hn*2.0);
          float frostAmt = clamp(band * uFrost * (0.62 + 0.25*hn + 0.13*streak), 0.0, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.80,0.85,0.92), frostAmt);
          roughnessFactor = mix(roughnessFactor, 0.9, frostAmt);`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
          metalnessFactor = mix(metalnessFactor, 0.05, frostAmt);`);
    };
  }
  return mat;
}

function bellGeometry(exitR = 0.6, len = 1.7) {
  const pts = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    pts.push(new THREE.Vector2(0.24 + (exitR - 0.24) * Math.pow(t, 0.7), -t * len));
  }
  pts.unshift(new THREE.Vector2(0.32, 0.5)); // powerhead stub
  return new THREE.LatheGeometry(pts, 24);
}

// Grid fin: a lattice slab sticking straight out from the hull. Flow passes
// through the cells along the booster's long axis.
function gridFinGeometry(L = 4.0, W = 3.0, D = 0.8) {
  const parts = [];
  const f = 0.14;
  parts.push(boxAt(L, D, f, L / 2, 0, -W / 2));
  parts.push(boxAt(L, D, f, L / 2, 0, W / 2));
  parts.push(boxAt(f, D, W, 0, 0, 0));
  parts.push(boxAt(f, D, W, L, 0, 0));
  const step = 0.42, t = 0.045;
  for (let c = -L - W; c < L + W; c += step) {
    for (const sgn of [1, -1]) {
      // line: z = sgn * x + c, clipped to the rectangle
      let x1 = 0, x2 = L;
      const zA = (x) => sgn * x + c;
      // clip so -W/2 <= z <= W/2
      const xa = (-W / 2 - c) * sgn, xb = (W / 2 - c) * sgn;
      x1 = Math.max(x1, Math.min(xa, xb)); x2 = Math.min(x2, Math.max(xa, xb));
      if (x2 - x1 < 0.05) continue;
      const mx = (x1 + x2) / 2, mz = zA(mx);
      const len = (x2 - x1) * Math.SQRT2;
      parts.push(boxAt(len, D * 0.96, t, mx, 0, mz, -sgn * Math.PI / 4));
    }
  }
  return mergeGeometries(parts);
}

export function buildBooster(frostUniform) {
  const group = new THREE.Group();
  group.name = 'booster';
  const tex = steelTextures({ seed: 12 });
  const hullMat = steelMaterial(tex, frostUniform);
  const darkSteel = new THREE.MeshStandardMaterial({ color: 0x5b5753, metalness: 0.85, roughness: 0.5 });
  const sootMat = new THREE.MeshStandardMaterial({ color: 0x1d1b1a, metalness: 0.4, roughness: 0.8 });

  const hullH = BOOSTER_LEN - 2.2;
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(BOOSTER_R, BOOSTER_R, hullH, 72, 1, true), hullMat);
  hull.position.y = hullH / 2;
  group.add(hull);

  // Aft heat shield with engine bays
  const shield = new THREE.Mesh(new THREE.CircleGeometry(BOOSTER_R, 64), sootMat);
  shield.rotation.x = Math.PI / 2; shield.position.y = 0.6;
  group.add(shield);

  // Hot-staging ring: vented section between booster and ship
  const hsrC = document.createElement('canvas'); hsrC.width = 1024; hsrC.height = 64;
  const hg = hsrC.getContext('2d');
  hg.fillStyle = '#8f9296'; hg.fillRect(0, 0, 1024, 64);
  for (let i = 0; i < 48; i++) { hg.fillStyle = '#121212'; hg.fillRect(i * (1024 / 48) + 4, 10, 1024 / 48 - 9, 44); }
  const hsrTex = new THREE.CanvasTexture(hsrC); hsrTex.colorSpace = THREE.SRGBColorSpace; hsrTex.wrapS = THREE.RepeatWrapping;
  const hsr = new THREE.Mesh(new THREE.CylinderGeometry(BOOSTER_R, BOOSTER_R, 2.2, 72, 1, true),
    new THREE.MeshStandardMaterial({ map: hsrTex, metalness: 0.85, roughness: 0.45 }));
  hsr.position.y = hullH + 1.1;
  group.add(hsr);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(BOOSTER_R * 0.98, 48, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xa8abaf, metalness: 0.7, roughness: 0.5 }));
  dome.scale.y = 0.18; dome.position.y = hullH + 0.3;
  group.add(dome);

  // Raceways (cable conduits) and aft chines
  const details = [];
  for (const a of [Math.PI * 0.33, Math.PI * 1.33]) {
    const r = BOOSTER_R + 0.18;
    details.push(boxAt(0.36, hullH - 6, 0.5, Math.cos(a) * r, (hullH) / 2 + 1, Math.sin(a) * r, -a));
  }
  for (const a of [Math.PI * 0.66, Math.PI * 1.66]) {
    const r = BOOSTER_R + 0.35;
    details.push(boxAt(0.7, 16, 0.12, Math.cos(a) * r, 10, Math.sin(a) * r, -a));
  }
  // Catch hard points ("pins") on the +x and -x sides, plus doubler plates
  const pins = [];
  for (const a of [0, Math.PI]) {
    const c = Math.cos(a), s = Math.sin(a);
    pins.push(boxAt(1.15, 0.8, 1.1, c * (BOOSTER_R + 0.55), PIN_Y + 0.4, s * (BOOSTER_R + 0.55), -a));
    pins.push(boxAt(0.6, 0.5, 0.9, c * (BOOSTER_R + 0.3), PIN_Y + 1.0, s * (BOOSTER_R + 0.3), -a, 0, 0.6));
    details.push(boxAt(0.12, 3.2, 2.4, c * (BOOSTER_R + 0.05), PIN_Y + 0.6, s * (BOOSTER_R + 0.05), -a));
  }
  group.add(new THREE.Mesh(mergeGeometries(details), darkSteel));
  const pinMesh = new THREE.Mesh(mergeGeometries(pins), new THREE.MeshStandardMaterial({ color: 0x77736d, metalness: 0.9, roughness: 0.35 }));
  group.add(pinMesh);

  // Four grid fins (Flight 5 era). V3 boosters use three larger, fixed fins.
  const finGeo = gridFinGeometry();
  const finMat = new THREE.MeshStandardMaterial({ color: 0x6c6965, metalness: 0.85, roughness: 0.42, side: THREE.DoubleSide });
  const fins = [];
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + i * Math.PI / 2;
    const mount = new THREE.Group();
    mount.position.set(Math.cos(a) * (BOOSTER_R + 0.35), 65.4, Math.sin(a) * (BOOSTER_R + 0.35));
    mount.rotation.y = -a;
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.6, 1.5), darkSteel);
    housing.position.x = -0.15;
    mount.add(housing);
    const pivot = new THREE.Group();
    pivot.position.x = 0.4;
    pivot.add(new THREE.Mesh(finGeo, finMat));
    mount.add(pivot);
    group.add(mount);
    fins.push(pivot);
  }

  // 33 engine bells
  const bellGeo = bellGeometry();
  const bellMat = new THREE.MeshStandardMaterial({ color: 0x4a4440, metalness: 0.75, roughness: 0.5, side: THREE.DoubleSide });
  const bells = new THREE.InstancedMesh(bellGeo, bellMat, 33);
  const m = new THREE.Matrix4();
  ENGINE_LAYOUT.forEach((e, i) => {
    m.makeTranslation(e.x, 0.3, e.z);
    bells.setMatrixAt(i, m);
  });
  group.add(bells);

  // Nozzle glow discs (switched per engine)
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xffb070, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const glowGeo = new THREE.CircleGeometry(0.56, 20); glowGeo.rotateX(Math.PI / 2);
  const nozzleGlow = new THREE.InstancedMesh(glowGeo, glowMat, 33);
  group.add(nozzleGlow);

  return { group, fins, nozzleGlow, hullMat, enginesY: 0.3 - 1.7 };
}

// ---------------------------------------------------------------------------
export function buildShip() {
  const group = new THREE.Group();
  const tex = steelTextures({ seed: 30, length: 50, belly: true });
  const mat = steelMaterial(tex, null);
  const barrelH = 34;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 4.5, barrelH, 72, 1, true), mat);
  barrel.position.y = barrelH / 2;
  group.add(barrel);
  // ogive nose
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const r = 4.5 * Math.sqrt(Math.max(0, 1 - t * t * 0.985));
    pts.push(new THREE.Vector2(Math.max(r, 0.2), barrelH + t * 16));
  }
  const nose = new THREE.Mesh(new THREE.LatheGeometry(pts, 72), mat);
  group.add(nose);
  const flapMat = new THREE.MeshStandardMaterial({ color: 0x232325, metalness: 0.2, roughness: 0.75 });
  const flaps = [];
  // Flaps sit where the black tiles meet bare steel (the belly faces -x here).
  for (const sz of [1, -1]) {
    flaps.push(boxAt(0.45, 10, 3.8, -0.8, 7, sz * (4.5 + 1.8)));
    flaps.push(boxAt(0.35, 6, 2.3, -0.8, 41.5, sz * (3.6 + 1.0), 0, -sz * 0.25));
  }
  group.add(new THREE.Mesh(mergeGeometries(flaps), flapMat));
  const shield = new THREE.Mesh(new THREE.CircleGeometry(4.5, 48), new THREE.MeshStandardMaterial({ color: 0x1b1a19, roughness: 0.8 }));
  shield.rotation.x = Math.PI / 2; shield.position.y = 0.2;
  group.add(shield);
  return { group, enginesY: -1.2 };
}

// ---------------------------------------------------------------------------
// Tower, carriage and chopstick arms.
export function buildTower() {
  const group = new THREE.Group();
  const W = 12, half = W / 2;
  const secH = 13, nSec = 11;
  const steel = new THREE.MeshStandardMaterial({ color: 0x4d5257, metalness: 0.55, roughness: 0.62 });
  const cols = [], braces = [];
  for (let s = 0; s < nSec; s++) {
    const y0 = s * secH, y1 = y0 + secH;
    for (const [cx, cz] of [[-half, -half], [half, -half], [half, half], [-half, half]]) {
      cols.push(boxAt(1.0, secH, 1.0, cx, (y0 + y1) / 2, cz + TOWER_Z));
    }
    const ring = [[-half, -half], [half, -half], [half, half], [-half, half]];
    for (let k = 0; k < 4; k++) {
      const [ax, az] = ring[k], [bx, bz] = ring[(k + 1) % 4];
      const A = new THREE.Vector3(ax, y1, az + TOWER_Z), B = new THREE.Vector3(bx, y1, bz + TOWER_Z);
      braces.push(beam(A, B, 0.6));
      const A0 = new THREE.Vector3(ax, y0, az + TOWER_Z), B0 = new THREE.Vector3(bx, y0, bz + TOWER_Z);
      braces.push(beam(A0, B, 0.32));
      braces.push(beam(B0, A, 0.32));
      // mid strut
      braces.push(beam(new THREE.Vector3(ax, (y0 + y1) / 2, az + TOWER_Z), new THREE.Vector3(bx, (y0 + y1) / 2, bz + TOWER_Z), 0.25));
    }
    // service grating platform every other section
    if (s % 2 === 1) braces.push(boxAt(W - 1, 0.18, W - 1, 0, y1 - 0.4, TOWER_Z));
  }
  // stair and elevator cores inside
  cols.push(boxAt(2.4, nSec * secH, 2.4, -2.2, nSec * secH / 2, TOWER_Z + 2));
  braces.push(boxAt(2.0, nSec * secH, 1.6, 2.6, nSec * secH / 2, TOWER_Z - 2.5));
  const topY = nSec * secH;
  // crown: drawworks housing and the lightning mast
  cols.push(boxAt(9, 4, 9, 0, topY + 2, TOWER_Z));
  braces.push(beam(new THREE.Vector3(0, topY + 4, TOWER_Z), new THREE.Vector3(0, TOWER_H + 14, TOWER_Z), 0.35));
  const towerMesh = new THREE.Mesh(mergeGeometries([...cols, ...braces]), steel);
  group.add(towerMesh);

  // Ship quick-disconnect arm, swung clear
  const qd = new THREE.Group();
  qd.position.set(half, 112, TOWER_Z + half);
  qd.rotation.y = 1.25;
  const qdParts = [];
  for (let i = 0; i < 6; i++) {
    qdParts.push(boxAt(0.4, 0.4, 3.3, 0.0, 0, i * 3.3 + 1.6));
    qdParts.push(boxAt(0.4, 0.4, 3.3, 0.0, 3, i * 3.3 + 1.6));
    qdParts.push(beam(new THREE.Vector3(0, 0, i * 3.3), new THREE.Vector3(0, 3, i * 3.3 + 3.3), 0.22));
  }
  qd.add(new THREE.Mesh(mergeGeometries(qdParts), steel));
  group.add(qd);

  // ---- Carriage with two chopstick arms. Arms extend along +z from the tower face.
  const carriage = new THREE.Group();
  const cParts = [];
  const ch = 10, co = half + 1.4;
  for (const [cx, cz] of [[-co, -co], [co, -co], [co, co], [-co, co]]) cParts.push(boxAt(1.3, ch, 1.3, cx, -ch / 2 + 1, cz + TOWER_Z));
  for (const yy of [1, -ch / 2 + 1, -ch + 1]) {
    cParts.push(boxAt(co * 2 + 1.3, 1.0, 1.0, 0, yy, TOWER_Z - co));
    cParts.push(boxAt(co * 2 + 1.3, 1.0, 1.0, 0, yy, TOWER_Z + co));
    cParts.push(boxAt(1.0, 1.0, co * 2, -co, yy, TOWER_Z));
    cParts.push(boxAt(1.0, 1.0, co * 2, co, yy, TOWER_Z));
  }
  const carMat = new THREE.MeshStandardMaterial({ color: 0x5c6166, metalness: 0.6, roughness: 0.55 });
  carriage.add(new THREE.Mesh(mergeGeometries(cParts), carMat));

  const armLen = 30, armDepth = 3.6;
  function armGeometry(innerSign) {
    const p = [];
    p.push(boxAt(1.1, 0.75, armLen, 0, -0.55, armLen / 2));               // top chord
    p.push(boxAt(1.1, 0.75, armLen - 3, 0, -armDepth, (armLen - 3) / 2));   // bottom chord
    for (let z = 0; z <= armLen - 3; z += 3) {
      p.push(boxAt(0.45, armDepth - 0.5, 0.45, 0, -armDepth / 2 - 0.3, z));
      if (z + 3 <= armLen - 3) p.push(beam(new THREE.Vector3(0, -armDepth, z), new THREE.Vector3(0, -0.6, z + 3), 0.28));
    }
    p.push(beam(new THREE.Vector3(0, -armDepth, armLen - 3), new THREE.Vector3(0, -0.6, armLen), 0.35));
    // root hinge block
    p.push(boxAt(2.2, armDepth + 1.4, 2.6, 0, -armDepth / 2, 0.6));
    return mergeGeometries(p);
  }
  function railGeometry(innerSign) {
    // Catch rail on the inner top edge: where the hard points land.
    const p = [];
    p.push(boxAt(0.7, 0.32, 20, innerSign * 0.1, -0.16, 17));
    for (let z = 8; z <= 26; z += 2) p.push(boxAt(0.8, 0.1, 0.2, innerSign * 0.1, 0.03, z));
    return mergeGeometries(p);
  }
  const armMat = new THREE.MeshStandardMaterial({ color: 0x8a8e92, metalness: 0.6, roughness: 0.48 });
  const railMat = new THREE.MeshStandardMaterial({ color: 0xc7c2b8, metalness: 0.8, roughness: 0.3 });
  const arms = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 5.45, 0, TOWER_Z + half);
    const arm = new THREE.Mesh(armGeometry(-side), armMat);
    pivot.add(arm);
    const rail = new THREE.Mesh(railGeometry(-side), railMat);
    pivot.add(rail);
    // Shock absorber trolley that the hard point sits on
    const trolley = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.35, 2.4), new THREE.MeshStandardMaterial({ color: 0x2c2d2f, metalness: 0.5, roughness: 0.6 }));
    trolley.position.set(-side * 0.1, -0.05, 16);
    pivot.add(trolley);
    // hydraulic actuator from carriage to arm
    const act = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 6, 10), carMat);
    act.rotation.z = Math.PI / 2; act.position.set(-side * 2.6, -1.8, 2.2);
    pivot.add(act);
    carriage.add(pivot);
    arms.push({ pivot, side });
  }
  group.add(carriage);

  // Obstruction lights (red) on the crown and the corners
  const red = [];
  for (const [cx, cz] of [[-half, -half], [half, -half], [half, half], [-half, half]]) red.push(new THREE.Vector3(cx, topY + 0.8, cz + TOWER_Z));
  red.push(new THREE.Vector3(0, TOWER_H + 14.5, TOWER_Z));
  for (const yy of [52, 91]) red.push(new THREE.Vector3(half, yy, TOWER_Z + half), new THREE.Vector3(-half, yy, TOWER_Z + half));

  return { group, carriage, arms, redLights: red };
}

// ---------------------------------------------------------------------------
export function buildPad() {
  const group = new THREE.Group();
  const concreteC = document.createElement('canvas'); concreteC.width = concreteC.height = 1024;
  const g = concreteC.getContext('2d');
  const r = rng(4);
  g.fillStyle = '#8a8780'; g.fillRect(0, 0, 1024, 1024);
  for (let i = 0; i < 6000; i++) { const v = 110 + r() * 50; g.fillStyle = `rgba(${v},${v - 2},${v - 6},0.12)`; g.fillRect(r() * 1024, r() * 1024, 2 + r() * 6, 2 + r() * 6); }
  g.strokeStyle = 'rgba(40,38,34,0.35)'; g.lineWidth = 2;
  for (let i = 0; i <= 1024; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 1024); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(1024, i); g.stroke(); }
  // scorch around the mount
  const sc = g.createRadialGradient(512, 512, 10, 512, 512, 260);
  sc.addColorStop(0, 'rgba(18,16,14,0.95)'); sc.addColorStop(0.5, 'rgba(30,26,22,0.55)'); sc.addColorStop(1, 'rgba(30,26,22,0)');
  g.fillStyle = sc; g.fillRect(0, 0, 1024, 1024);
  const concrete = new THREE.CanvasTexture(concreteC); concrete.colorSpace = THREE.SRGBColorSpace; concrete.anisotropy = 8;
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(260, 260), new THREE.MeshStandardMaterial({
    map: concrete, roughness: 0.92, metalness: 0.0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  }));
  apron.rotation.x = -Math.PI / 2; apron.position.set(-20, 0.05, -10);
  group.add(apron);

  // Launch mount: a square table with a round hole, on six legs
  const steel = new THREE.MeshStandardMaterial({ color: 0x5a5d60, metalness: 0.6, roughness: 0.6 });
  const shape = new THREE.Shape();
  shape.moveTo(-10, -10); shape.lineTo(10, -10); shape.lineTo(10, 10); shape.lineTo(-10, 10); shape.lineTo(-10, -10);
  const hole = new THREE.Path(); hole.absarc(0, 0, 5.3, 0, Math.PI * 2, true); shape.holes.push(hole);
  const table = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 3.4, bevelEnabled: false, curveSegments: 48 }), steel);
  table.rotation.x = -Math.PI / 2; table.position.y = MOUNT_TOP - 3.4;
  group.add(table);
  const legs = [];
  for (const [x, z] of [[-8.6, -8.6], [8.6, -8.6], [-8.6, 8.6], [8.6, 8.6], [-9.2, 0], [9.2, 0]]) legs.push(boxAt(2.4, MOUNT_TOP - 3.4, 2.4, x, (MOUNT_TOP - 3.4) / 2, z));
  // hold-down clamps around the ring
  for (let i = 0; i < 20; i++) { const a = i / 20 * Math.PI * 2; legs.push(boxAt(0.7, 1.4, 1.1, Math.cos(a) * 5.0, MOUNT_TOP + 0.6, Math.sin(a) * 5.0, -a)); }
  group.add(new THREE.Mesh(mergeGeometries(legs), steel));
  // water-cooled steel plate under the mount
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(13, 13, 0.5, 48), new THREE.MeshStandardMaterial({ color: 0x2b2a28, metalness: 0.8, roughness: 0.4 }));
  plate.position.y = 0.3;
  group.add(plate);

  // Tank farm and a few service buildings to the west
  const tankMat = new THREE.MeshStandardMaterial({ color: 0xb9bcbe, metalness: 0.5, roughness: 0.45 });
  const tanks = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) {
    const g2 = new THREE.CylinderGeometry(4.2, 4.2, 26, 32); g2.translate(-118 - i * 11, 13, 44 + j * 12);
    tanks.push(g2);
  }
  for (let i = 0; i < 6; i++) { const g3 = new THREE.CylinderGeometry(2.0, 2.0, 22, 20); g3.rotateZ(Math.PI / 2); g3.translate(-110, 2.4 + (i % 2) * 4.2, -50 - Math.floor(i / 2) * 5); tanks.push(g3); }
  group.add(new THREE.Mesh(mergeGeometries(tanks), tankMat));
  const bld = new THREE.MeshStandardMaterial({ color: 0x3f4247, roughness: 0.8 });
  group.add(new THREE.Mesh(mergeGeometries([
    boxAt(30, 9, 18, -150, 4.5, -20), boxAt(14, 6, 10, -70, 3, -70), boxAt(8, 4, 30, 60, 2, -80),
  ]), bld));

  // Sodium light positions: pad perimeter poles, road west, tank farm
  const lights = [];
  for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; lights.push(new THREE.Vector3(Math.cos(a) * 70 - 10, 22, Math.sin(a) * 70 - 10)); }
  for (let i = 0; i < 30; i++) lights.push(new THREE.Vector3(-150 - i * 60, 9, 20 + Math.sin(i * 0.7) * 6));
  for (let i = 0; i < 10; i++) lights.push(new THREE.Vector3(-115 - (i % 5) * 10, 28, 40 + Math.floor(i / 5) * 20));
  const poles = lights.slice(0, 12).map(p => boxAt(0.4, p.y, 0.4, p.x, p.y / 2, p.z));
  group.add(new THREE.Mesh(mergeGeometries(poles), steel));
  return { group, lights };
}

// ---------------------------------------------------------------------------
// Ground: tidal flats to the west, the Gulf to the east. All in a shader.
export function buildGround() {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uCam: { value: new THREE.Vector3() },
      uSun: { value: new THREE.Vector3() },
      uHaze: { value: new THREE.Color() },
      uHazeWarm: { value: new THREE.Color() },
      uDensity: { value: 0.0001 },
      uGlowPos: { value: new THREE.Vector3() },
      uGlow: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec3 vW;
      void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      uniform vec3 uCam; uniform vec3 uSun; uniform vec3 uHaze; uniform vec3 uHazeWarm; uniform float uDensity;
      uniform vec3 uGlowPos; uniform float uGlow; uniform float uTime;
      varying vec3 vW;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
      float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*n(p); p*=2.03; a*=0.5; } return s; }
      void main(){
        vec2 p = vW.xz;
        float shore = 1500.0 + 900.0*(fbm(vec2(p.y*0.00025, 3.1))-0.5) + 160.0*(fbm(vec2(p.y*0.003, 7.0))-0.5);
        float sea = smoothstep(shore-30.0, shore+30.0, p.x);
        float flats = fbm(p*0.0011);
        float lagoon = smoothstep(0.56, 0.6, fbm(p*0.0004 + 11.0)) * (1.0 - sea);
        vec3 mud = mix(vec3(0.050,0.046,0.040), vec3(0.11,0.10,0.08), flats);
        mud = mix(mud, vec3(0.06,0.07,0.05), smoothstep(0.4,0.7,fbm(p*0.004)));
        vec3 beach = vec3(0.20,0.18,0.15);
        float beachBand = smoothstep(shore-140.0, shore-60.0, p.x) * (1.0 - sea);
        vec3 land = mix(mud, beach, beachBand);
        vec3 V = normalize(uCam - vW);
        float fres = pow(1.0 - max(V.y, 0.0), 4.0);
        vec3 water = mix(vec3(0.012,0.022,0.035), mix(uHaze, uHazeWarm, 0.35), 0.15 + 0.75*fres);
        float ripple = n(p*0.05 + uTime*0.05)*0.04;
        water += ripple;
        vec3 col = mix(land, water, max(sea, lagoon));
        // dusk ambient
        col *= 0.9;
        // plume light on the ground
        float d = distance(vW, uGlowPos);
        col += vec3(1.0,0.55,0.25) * uGlow * 220.0 / (d*d*0.02 + 60.0);
        // distance haze, thinner with camera altitude
        float dist = length(uCam - vW);
        float f = 1.0 - exp(-dist * uDensity);
        vec3 hz = mix(uHaze, uHazeWarm, clamp(dot(normalize(vW - uCam).xz, normalize(uSun.xz))*0.5+0.5, 0.0, 1.0)*0.6);
        col = mix(col, hz, f);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(900000, 900000, 1, 1), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = -5;
  return mesh;
}

// ---------------------------------------------------------------------------
// Dusk sky. No starfield: it is still too bright for stars near the horizon.
export function buildSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false,
    uniforms: { uSun: { value: new THREE.Vector3() }, uAlt: { value: 0 } },
    vertexShader: /* glsl */`varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = vec4(p.xy, p.w*0.99999, p.w); }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSun; uniform float uAlt; varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir);
        float altF = clamp(uAlt / 60000.0, 0.0, 1.0);
        float dip = -sqrt(2.0 * max(uAlt,0.0) / 6.371e6);
        float hh = d.y - dip;
        float az = dot(normalize(d.xz + 1e-5), normalize(uSun.xz)) * 0.5 + 0.5;
        vec3 zenith = mix(vec3(0.020,0.034,0.078), vec3(0.003,0.005,0.014), altF);
        vec3 warm = vec3(1.05,0.45,0.18);
        vec3 belt = vec3(0.34,0.24,0.36);  // pink-violet band opposite the sunset
        vec3 horizon = mix(belt, warm, pow(az, 3.0));
        float up = pow(clamp(hh, 0.0, 1.0), mix(0.42, 0.25, altF));
        vec3 col = mix(horizon, zenith, smoothstep(0.0, mix(0.55, 0.18, altF), up));
        // Earth's shadow rising in the east
        col = mix(col, vec3(0.06,0.075,0.12), (1.0-az) * smoothstep(0.07, 0.0, hh) * 0.75);
        float s = max(dot(d, normalize(uSun)), 0.0);
        col += vec3(1.0,0.42,0.14) * pow(s, 6.0) * 0.9 + vec3(1.0,0.66,0.38) * pow(s, 60.0) * 1.6;
        // thin bright limb when high up
        col += warm * exp(-abs(hh) * 160.0) * altF * (0.3 + 0.7*az);
        if (hh < 0.0) col = mix(horizon * 0.35, vec3(0.025,0.03,0.04), smoothstep(0.0, -0.12, hh));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return mesh;
}
