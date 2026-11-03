// Exhaust plumes, smoke, lights and post-processing.
import * as THREE from 'three';
import { stateAt, MOUNT_TOP, T_STAGING, T_LANDING, T_CONTACT } from './sim.js';

const NOISE = /* glsl */`
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
`;

// ---------------------------------------------------------------------------
// Plume cluster: one instanced open cylinder per engine. The shape widens with
// altitude because the air gets thin and the exhaust spreads out.
export class PlumeCluster {
  constructor(layout, { exitR = 0.6, y = 0, intensity = 1 } = {}) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 20, 48, true);
    geo.translate(0, -0.5, 0);
    const n = layout.length;
    this.on = new Float32Array(n);
    const seeds = new Float32Array(n);
    for (let i = 0; i < n; i++) seeds[i] = Math.random();
    geo.setAttribute('aOn', new THREE.InstancedBufferAttribute(this.on, 1));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
    this.uniforms = {
      uTime: { value: 0 }, uLen: { value: 28 }, uExitR: { value: exitR }, uExpand: { value: 0.7 },
      uIntensity: { value: intensity }, uThrottle: { value: 1 }, uCountScale: { value: 1 },
      uCore: { value: new THREE.Color(0xe6ecff) }, uMid: { value: new THREE.Color(0xffb46b) }, uOuter: { value: new THREE.Color(0xff5a1c) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        attribute float aOn; attribute float aSeed;
        uniform float uLen, uExitR, uExpand, uThrottle, uTime;
        varying float vV; varying vec3 vN; varying vec3 vView; varying float vSeed; varying float vAround;
        void main(){
          float v = -position.y;
          float L = uLen * (0.75 + 0.25*uThrottle);
          float r = uExitR * (1.0 + uExpand * pow(v, 0.55) * (L/uExitR) * 0.08);
          r *= 1.0 + 0.07*sin(v * L / (uExitR*3.0) * 6.2831) * (1.0 - v);
          vec3 p = vec3(position.x * r, -v * L, position.z * r) * aOn;
          vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.0);
          vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * vec3(position.x, 0.0, position.z));
          vView = cameraPosition - w.xyz;
          vV = v; vSeed = aSeed; vAround = atan(position.z, position.x);
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime, uIntensity, uLen, uExitR, uCountScale, uThrottle;
        uniform vec3 uCore, uMid, uOuter;
        varying float vV; varying vec3 vN; varying vec3 vView; varying float vSeed; varying float vAround;
        ${NOISE}
        void main(){
          float facing = abs(dot(normalize(vN), normalize(vView)));
          float core = pow(facing, 2.2);
          float along = pow(1.0 - vV, 1.6);
          float start = smoothstep(0.0, 0.015, vV);
          float freq = uLen / (uExitR * 3.0);
          float diamonds = pow(abs(sin(vV * freq * 3.14159)), 12.0) * (1.0 - smoothstep(0.04, 0.38, vV));
          float n = vnoise(vec2(vAround*3.0 + vSeed*10.0, vV*18.0 - uTime*26.0));
          float n2 = vnoise(vec2(vAround*7.0, vV*40.0 - uTime*40.0));
          float I = (core*0.85 + 0.15) * along * start * (0.62 + 0.38*n + 0.15*n2) + diamonds * core * 1.8;
          vec3 col = mix(uOuter, uMid, smoothstep(0.05, 0.45, I));
          col = mix(col, uCore, smoothstep(0.55, 1.1, I));
          gl_FragColor = vec4(col * I * uIntensity * uCountScale * uThrottle, 1.0);
        }`,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.frustumCulled = false;
    const m = new THREE.Matrix4();
    layout.forEach((e, i) => { m.makeTranslation(e.x, y, e.z); this.mesh.setMatrixAt(i, m); });
  }
  setMask(fn) {
    let changed = false;
    for (let i = 0; i < this.on.length; i++) { const v = fn(i) ? 1 : 0; if (this.on[i] !== v) { this.on[i] = v; changed = true; } }
    if (changed) this.mesh.geometry.attributes.aOn.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Soft radial sprite texture for glows
export function glowTexture(inner = 'rgba(255,220,180,1)', mid = 'rgba(255,120,40,0.35)') {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, inner); gr.addColorStop(0.25, mid); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------
// Deterministic smoke. Each particle has a birth time and a launch state, and
// its position is a pure function of mission time. Scrubbing backward works.
const smokeVS = /* glsl */`
  attribute float aBirth; attribute float aLife; attribute vec3 aVel; attribute vec4 aSeed; attribute vec3 aSize;
  uniform float uT, uDrag, uBuoy, uScale, uTurb;
  uniform vec3 uGlowPos; uniform float uGlow, uGlowRange;
  varying float vAlpha; varying float vWarm; varying float vSeed; varying float vK;
  void main(){
    float age = uT - aBirth;
    float k = age / aLife;
    if (age < 0.0 || k > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
    float travel = (1.0 - exp(-uDrag * age)) / uDrag;
    vec3 p = position + aVel * travel;
    p.y += uBuoy * age;
    p += uTurb * sqrt(age) * vec3(sin(age*0.6 + aSeed.x*6.28), 0.4*sin(age*0.45 + aSeed.y*6.28), cos(age*0.5 + aSeed.z*6.28));
    float size = mix(aSize.x, aSize.y, 1.0 - pow(1.0 - k, 2.6));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = min(size * uScale / max(-mv.z, 0.1), 520.0);
    vAlpha = smoothstep(0.0, 0.06, k) * (1.0 - smoothstep(0.45, 1.0, k)) * aSize.z;
    float d = distance(p, uGlowPos);
    vWarm = uGlow * exp(-d / uGlowRange);
    vSeed = aSeed.w; vK = k;
  }`;
const smokeFS = /* glsl */`
  uniform vec3 uCool, uWarm; uniform float uOpacity;
  varying float vAlpha; varying float vWarm; varying float vSeed; varying float vK;
  ${NOISE}
  void main(){
    vec2 pc = gl_PointCoord - 0.5;
    float r = length(pc) * 2.0;
    if (r > 1.0) discard;
    float n = vnoise(pc * 5.0 + vSeed * 40.0) * 0.6 + vnoise(pc * 11.0 - vSeed * 13.0) * 0.4;
    float a = smoothstep(1.0, 0.15, r) * (0.55 + 0.6 * n) * vAlpha * uOpacity;
    float shade = 0.75 + 0.35 * (0.5 - pc.y);  // lighter on top, like skylight
    vec3 col = uCool * shade * mix(1.0, 0.85, vK) + uWarm * clamp(vWarm, 0.0, 3.0);
    gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  }`;

export class Smoke {
  constructor({ count, emit, drag = 0.4, buoy = 1, turb = 3, cool = 0x59606e, warm = 0xff7a32, opacity = 0.8, glowRange = 60 }) {
    const pos = new Float32Array(count * 3), vel = new Float32Array(count * 3);
    const birth = new Float32Array(count), life = new Float32Array(count);
    const seed = new Float32Array(count * 4), size = new Float32Array(count * 3);
    let s = 1234 + count;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < count; i++) {
      const p = emit(rnd, i);
      pos.set(p.pos, i * 3); vel.set(p.vel, i * 3);
      birth[i] = p.birth; life[i] = p.life;
      seed.set([rnd(), rnd(), rnd(), rnd()], i * 4);
      size.set([p.size0, p.size1, p.alpha ?? 1], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aVel', new THREE.BufferAttribute(vel, 3));
    g.setAttribute('aBirth', new THREE.BufferAttribute(birth, 1));
    g.setAttribute('aLife', new THREE.BufferAttribute(life, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 3));
    this.count = count;
    this.uniforms = {
      uT: { value: 0 }, uDrag: { value: drag }, uBuoy: { value: buoy }, uTurb: { value: turb }, uScale: { value: 800 },
      uGlowPos: { value: new THREE.Vector3() }, uGlow: { value: 0 }, uGlowRange: { value: glowRange },
      uCool: { value: new THREE.Color(cool) }, uWarm: { value: new THREE.Color(warm) }, uOpacity: { value: opacity },
    };
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: smokeVS, fragmentShader: smokeFS,
      transparent: true, depthWrite: false,
    }));
    this.points.frustumCulled = false;
  }
  setFraction(f) { this.points.geometry.setDrawRange(0, Math.floor(this.count * f)); }
}

// Engine exit point in world space at mission time t (for emitters).
function tailAt(t, along = -3) {
  const s = stateAt(t);
  const sp = Math.sin(s.pitch), cp = Math.cos(s.pitch);
  return { x: s.x + sp * along, y: s.y + cp * along, z: 0, sp, cp, s };
}

export function buildSmoke(scale = 1) {
  const n = (k) => Math.max(40, Math.round(k * scale));
  const systems = {};

  // Liftoff cloud rolling out from under the mount
  systems.pad = new Smoke({
    count: n(1500), drag: 0.22, buoy: 1.4, turb: 4, opacity: 0.75, glowRange: 90,
    emit: (r) => {
      const birth = -1.5 + 16 * Math.pow(r(), 1.4);
      const a = r() * Math.PI * 2, rad = 4 + r() * 10;
      const sp = (28 + r() * 50) * (1 - Math.max(0, birth) / 22);
      return { birth, life: 30 + r() * 40, pos: [Math.cos(a) * rad, 1.5 + r() * 5, Math.sin(a) * rad],
        vel: [Math.cos(a) * sp, 2 + r() * 9, Math.sin(a) * sp], size0: 8 + r() * 6, size1: 46 + r() * 40 };
    },
  });

  // Ascent trail, dense low down and thinning with altitude
  systems.trail = new Smoke({
    count: n(1000), drag: 0.5, buoy: 0.6, turb: 6, opacity: 0.55, glowRange: 120,
    emit: (r) => {
      const birth = 1 + 75 * Math.pow(r(), 1.5);
      const tp = tailAt(birth, -4);
      const alt = tp.s.y;
      const thin = Math.exp(-alt / 16000);
      const spread = 6 + r() * 10;
      return { birth, life: 30 + r() * 40, pos: [tp.x + (r() - 0.5) * 4, tp.y, (r() - 0.5) * 4],
        vel: [-tp.sp * 40 + (r() - 0.5) * spread, -tp.cp * 40 + (r() - 0.5) * spread, (r() - 0.5) * spread],
        size0: 8 + r() * 6, size1: (40 + r() * 40) * (1 + alt / 6000), alpha: thin };
    },
  });

  // Landing burn exhaust and the cloud kicked up around the mount
  systems.landing = new Smoke({
    count: n(700), drag: 1.1, buoy: 1.0, turb: 3, opacity: 0.38, glowRange: 45,
    emit: (r) => {
      const birth = T_LANDING + 2 + (T_CONTACT - T_LANDING - 2) * Math.pow(r(), 0.7);
      const tp = tailAt(birth, -2);
      return { birth, life: 6 + r() * 10, pos: [tp.x + (r() - 0.5) * 6, tp.y, (r() - 0.5) * 6],
        vel: [(r() - 0.5) * 24, -50 - r() * 30, (r() - 0.5) * 24], size0: 5 + r() * 4, size1: 16 + r() * 18 };
    },
  });
  systems.ground = new Smoke({
    count: n(500), drag: 0.6, buoy: 0.5, turb: 3, opacity: 0.32, glowRange: 70,
    emit: (r) => {
      const birth = 406 + 9 * r();
      const a = r() * Math.PI * 2, rad = r() * 10;
      const sp = 8 + r() * 18;
      return { birth, life: 10 + r() * 12, pos: [Math.cos(a) * rad, 2 + r() * 3, Math.sin(a) * rad],
        vel: [Math.cos(a) * sp, 1 + r() * 3, Math.sin(a) * sp], size0: 6, size1: 22 + r() * 18 };
    },
  });

  // Cold vapor before launch: sheets falling off the frosty tanks, drifting east
  systems.vent = new Smoke({
    count: n(420), drag: 0.6, buoy: -0.9, turb: 1.4, opacity: 0.45, cool: 0xa9b0bb, glowRange: 30,
    emit: (r) => {
      const birth = -64 + 66 * r();
      const hgt = [MOUNT_TOP + 8, MOUNT_TOP + 40, MOUNT_TOP + 68, MOUNT_TOP + 100][Math.floor(r() * 4)];
      const a = r() * Math.PI * 2;
      return { birth, life: 5 + r() * 6, pos: [Math.cos(a) * 4.8, hgt + (r() - 0.5) * 6, Math.sin(a) * 4.8],
        vel: [Math.cos(a) * 3 + 2.5, -0.5, Math.sin(a) * 3], size0: 2 + r() * 2, size1: 10 + r() * 10 };
    },
  });

  // Venting after the catch: vapor puffs from the top of the booster
  systems.post = new Smoke({
    count: n(320), drag: 0.5, buoy: 1.4, turb: 1.5, opacity: 0.45, cool: 0x9aa2ad, glowRange: 30,
    emit: (r) => {
      const birth = T_CONTACT + 0.5 + 60 * r();
      const s = stateAt(birth);
      const a = r() * Math.PI * 2;
      return { birth, life: 5 + r() * 6, pos: [Math.cos(a) * 4.6, s.y + 66 + r() * 3, Math.sin(a) * 4.6],
        vel: [Math.cos(a) * 3 + 2, 1, Math.sin(a) * 3], size0: 2, size1: 12 + r() * 8 };
    },
  });
  return systems;
}

// ---------------------------------------------------------------------------
// Point lights as sprites: sodium lamps and blinking red obstruction lights.
export function buildLightSprites(positions, colorHex, size, blink = false) {
  const g = new THREE.BufferGeometry().setFromPoints(positions);
  const phase = new Float32Array(positions.length).map((_, i) => i * 0.37);
  g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(colorHex) }, uSize: { value: size }, uScale: { value: 800 }, uTime: { value: 0 }, uBlink: { value: blink ? 1 : 0 } },
    vertexShader: /* glsl */`
      attribute float aPhase; uniform float uSize, uScale, uTime, uBlink; varying float vB;
      void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(uSize * uScale / -mv.z, 2.0, 40.0);
        vB = uBlink > 0.5 ? step(0.45, fract(uTime*0.5 + aPhase*0.0)) : 1.0; }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; varying float vB;
      void main(){ float r = length(gl_PointCoord-0.5)*2.0; float a = exp(-r*r*5.0) + 0.6*exp(-r*r*60.0);
        gl_FragColor = vec4(uColor * a * 2.2 * vB, 1.0); }`,
  });
  const p = new THREE.Points(g, mat);
  p.frustumCulled = false;
  return p;
}

// ---------------------------------------------------------------------------
// Post: heat shimmer around the plume, then grade (vignette, grain).
export const ShimmerShader = {
  uniforms: {
    tDiffuse: { value: null }, uA: { value: new THREE.Vector2() }, uB: { value: new THREE.Vector2() },
    uStrength: { value: 0 }, uWidth: { value: 0.05 }, uTime: { value: 0 }, uAspect: { value: 1 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform vec2 uA, uB; uniform float uStrength, uWidth, uTime, uAspect; varying vec2 vUv;
    ${NOISE}
    void main(){
      vec2 p = vUv; p.x *= uAspect;
      vec2 a = uA; a.x *= uAspect; vec2 b = uB; b.x *= uAspect;
      vec2 ab = b - a; float h = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
      float d = length(p - a - ab * h);
      float mask = exp(-pow(d / uWidth, 2.0)) * smoothstep(0.0, 0.15, h) * uStrength;
      vec2 off = vec2(vnoise(vUv * 40.0 + vec2(0.0, -uTime * 3.0)) - 0.5, vnoise(vUv * 36.0 + vec2(uTime * 2.0, -uTime * 4.0)) - 0.5);
      gl_FragColor = texture2D(tDiffuse, vUv + off * mask * 0.012);
    }`,
};

export const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uVignette: { value: 0.9 }, uGrain: { value: 0.035 }, uFlash: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uTime, uVignette, uGrain, uFlash; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 q = vUv - 0.5;
      float v = 1.0 - dot(q, q) * uVignette * 1.6;
      c.rgb *= clamp(v, 0.0, 1.0);
      // cool shadows, warm highlights
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb = mix(c.rgb * vec3(0.92, 0.97, 1.08), c.rgb * vec3(1.05, 1.0, 0.94), smoothstep(0.05, 0.8, l));
      c.rgb += (h(vUv * 1000.0 + fract(uTime) * 100.0) - 0.5) * uGrain * (0.4 + l);
      c.rgb += uFlash * vec3(1.0, 0.7, 0.45);
      gl_FragColor = c;
    }`,
};
