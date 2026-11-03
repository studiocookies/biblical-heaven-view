// Scene controller: builds the world, places the camera, renders each frame.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { stateAt, shipAt, BOOSTER_LEN, MOUNT_TOP, TOWER_Z, PIN_Y, T_CONTACT } from './sim.js';
import { buildBooster, buildShip, buildTower, buildPad, buildGround, buildSky, ENGINE_LAYOUT } from './models.js';
import { PlumeCluster, buildSmoke, buildLightSprites, glowTexture, ShimmerShader, GradeShader } from './fx.js';

const SUN_DIR = new THREE.Vector3(-0.92, -0.012, 0.38).normalize();
const LIGHT_DIR = new THREE.Vector3(-0.9, 0.12, 0.42).normalize();
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();

export class World {
  constructor(canvas, { tier = 2, reducedMotion = false } = {}) {
    this.canvas = canvas;
    this.tier = tier;
    this.reducedMotion = reducedMotion;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: tier >= 2, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, 600000);
    this.scene.fog = new THREE.FogExp2(0x3b3f52, 0.0004);
    this.hazeCool = new THREE.Color(0x2e3550);
    this.hazeWarm = new THREE.Color(0xb86a40);

    this.frost = { value: 1 };
    this.build();
    this.buildPost();

    this.shotWeights = new Map();
    this.shot = 'hero';
    this.shotLocal = 0;
    this.override = 'auto';
    this.time = 0;
    this.missionT = -60;
    this.state = stateAt(-60);
    this.labelTargets = {};
    this.resize();
  }

  build() {
    const s = this.scene;
    this.sky = buildSky();
    this.sky.material.uniforms.uSun.value.copy(SUN_DIR);
    s.add(this.sky);
    this.ground = buildGround();
    this.ground.material.uniforms.uSun.value.copy(SUN_DIR);
    s.add(this.ground);

    this.hemi = new THREE.HemisphereLight(0x5d6d96, 0x2a1f18, 0.75);
    s.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffa565, 0.8);
    this.sun.position.copy(LIGHT_DIR).multiplyScalar(1000);
    s.add(this.sun); s.add(this.sun.target);
    this.plumeLight = new THREE.PointLight(0xff8a3c, 0, 600, 1.6);
    s.add(this.plumeLight);
    // Pad floodlights: warm sodium light washing the catch zone and the mount.
    this.flood = new THREE.PointLight(0xffb066, 1400, 140, 1.7);
    this.flood.position.set(26, 104, 18);
    s.add(this.flood);
    const flood2 = new THREE.PointLight(0xffb066, 900, 120, 1.7);
    flood2.position.set(30, 30, 30);
    s.add(flood2);

    // Environment for reflections: render the sky into a PMREM cube.
    const pm = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const envSky = buildSky();
    envSky.material.uniforms.uSun.value.copy(SUN_DIR);
    envSky.scale.setScalar(100);
    envScene.add(envSky);
    const groundDisk = new THREE.Mesh(new THREE.CircleGeometry(90, 32), new THREE.MeshBasicMaterial({ color: 0x0c0d10 }));
    groundDisk.rotation.x = -Math.PI / 2; groundDisk.position.y = -3;
    envScene.add(groundDisk);
    this.scene.environment = pm.fromScene(envScene, 0.02).texture;
    pm.dispose();

    const pad = buildPad();
    s.add(pad.group);
    this.padLights = buildLightSprites(pad.lights, 0xffa74d, 2.4);
    s.add(this.padLights);

    this.tower = buildTower();
    s.add(this.tower.group);
    this.redLights = buildLightSprites(this.tower.redLights, 0xff2a1a, 2.0, true);
    s.add(this.redLights);

    this.booster = buildBooster(this.frost);
    s.add(this.booster.group);
    this.boosterPlume = new PlumeCluster(ENGINE_LAYOUT, { exitR: 0.6, y: this.booster.enginesY });
    this.booster.group.add(this.boosterPlume.mesh);

    this.baseGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.baseGlow.position.y = this.booster.enginesY - 3;
    this.booster.group.add(this.baseGlow);

    this.ship = buildShip();
    this.ship.group.rotation.y = Math.PI * 0.8;
    s.add(this.ship.group);
    const shipEng = [];
    for (let i = 0; i < 3; i++) { const a = i * 2 * Math.PI / 3; shipEng.push({ x: Math.cos(a) * 1.1, z: Math.sin(a) * 1.1 }); }
    for (let i = 0; i < 3; i++) { const a = Math.PI / 3 + i * 2 * Math.PI / 3; shipEng.push({ x: Math.cos(a) * 3.0, z: Math.sin(a) * 3.0 }); }
    this.shipPlume = new PlumeCluster(shipEng, { exitR: 0.9, y: this.ship.enginesY, intensity: 1.1 });
    this.shipPlume.setMask(() => true);
    this.ship.group.add(this.shipPlume.mesh);
    this.shipGlow = new THREE.Sprite(this.baseGlow.material.clone());
    this.shipGlow.position.y = -3;
    this.ship.group.add(this.shipGlow);

    const frac = [0.25, 0.5, 1][this.tier];
    this.smoke = buildSmoke(frac);
    for (const k in this.smoke) s.add(this.smoke[k].points);
  }

  buildPost() {
    this.composer = null;
    if (this.tier === 0) return;
    const c = new EffectComposer(this.renderer);
    c.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.85, 0.65, 0.82);
    c.addPass(this.bloom);
    if (this.tier >= 2) { this.shimmer = new ShaderPass(ShimmerShader); c.addPass(this.shimmer); }
    this.grade = new ShaderPass(GradeShader);
    c.addPass(this.grade);
    c.addPass(new OutputPass());
    this.composer = c;
  }

  setTier(tier) {
    if (tier === this.tier) return;
    this.tier = tier;
    const frac = [0.25, 0.5, 1][tier];
    for (const k in this.smoke) this.smoke[k].setFraction(frac);
    if (this.composer) { this.composer.dispose?.(); }
    this.buildPost();
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    const dprCap = [1, 1.25, 1.75][this.tier];
    this.dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Lens shift: keep the subject clear of the story column.
    if (w > 900) this.camera.setViewOffset(w, h, -w * 0.15, 0, w, h);
    else this.camera.setViewOffset(w, h, 0, h * 0.14, w, h);
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(this.dpr);
      this.composer.setSize(w, h);
      this.bloom.resolution.set(w * this.dpr / 2, h * this.dpr / 2);
      if (this.shimmer) this.shimmer.uniforms.uAspect.value = w / h;
    }
    this.viewH = h * this.dpr;
    this.w = w; this.h = h;
  }

  // -------------------------------------------------------------------------
  setMission(t) { this.missionT = t; }
  setShot(name, local) { this.shot = name; this.shotLocal = local; }

  applyState(s) {
    const b = this.booster.group;
    b.position.set(s.x, s.y, s.z);
    b.rotation.set(0, 0, 0);
    b.rotateZ(-s.pitch);         // tip the nose toward +x
    b.rotateY(s.roll);
    for (const f of this.booster.fins) f.rotation.x = s.fin;
    this.frost.value = s.frost;

    // Engines
    const set = s.eng.set;
    const lit = (i) => set === 'all' || (set === 'inner' && i < 13) || (set === 'center' && i < 3);
    this.boosterPlume.setMask(lit);
    const altF = Math.min(1, Math.max(0, (s.y - 2000) / 40000));
    const pu = this.boosterPlume.uniforms;
    pu.uThrottle.value = s.eng.throttle;
    pu.uLen.value = 26 + altF * 70;
    pu.uExpand.value = 0.7 + altF * 7;
    pu.uCountScale.value = (s.eng.count > 13 ? 0.55 : s.eng.count > 3 ? 0.8 : 1.15) * (1 - 0.6 * altF);
    const m = new THREE.Matrix4(), sc = new THREE.Vector3();
    for (let i = 0; i < 33; i++) {
      const e = ENGINE_LAYOUT[i], on = lit(i) ? 1 : 0;
      m.compose(V(e.x, this.booster.enginesY + 0.15, e.z), new THREE.Quaternion(), sc.setScalar(on));
      this.booster.nozzleGlow.setMatrixAt(i, m);
    }
    this.booster.nozzleGlow.instanceMatrix.needsUpdate = true;
    const power = s.eng.count === 0 ? 0 : (s.eng.count / 33) * 0.6 + 0.4;
    const glowSize = s.eng.count === 0 ? 0 : (s.eng.count > 13 ? 34 : s.eng.count > 3 ? 22 : 13) * (1 + altF * 0.6);
    this.baseGlow.scale.setScalar(glowSize);
    this.baseGlow.material.opacity = power * s.eng.throttle * (1 - 0.55 * altF);
    b.updateMatrixWorld(true);
    const tail = this.booster.group.localToWorld(V(0, this.booster.enginesY - 6, 0));
    this.tailWorld = tail;
    const nearGround = Math.exp(-Math.max(0, s.y - MOUNT_TOP) / 900);
    this.plumeLight.position.copy(tail);
    this.plumeLight.intensity = power * s.eng.throttle * 9000 * (0.25 + 0.75 * nearGround);
    this.plumeLight.distance = 900;

    // Ship
    const sh = this.ship.group;
    sh.visible = s.shipVisible;
    if (s.shipAttached) {
      sh.position.copy(this.booster.group.localToWorld(V(0, BOOSTER_LEN + 0.05, 0)));
      sh.quaternion.copy(this.booster.group.quaternion);
      sh.rotateY(Math.PI * 0.8);
      this.shipPlume.mesh.visible = false; this.shipGlow.visible = false;
    } else {
      const p = shipAt(s.t);
      if (p) {
        sh.position.set(p.x, p.y, 0);
        sh.rotation.set(0, 0, 0); sh.rotateZ(-p.pitch); sh.rotateY(Math.PI * 0.8);
        this.shipPlume.mesh.visible = true; this.shipGlow.visible = true;
        const shipAlt = Math.min(1, p.y / 40000);
        this.shipPlume.uniforms.uLen.value = 60 + shipAlt * 60;
        this.shipPlume.uniforms.uExpand.value = 6;
        this.shipGlow.scale.setScalar(30);
        this.shipGlow.material.opacity = 0.5;
        this.shipPlume.uniforms.uCountScale.value = 0.45;
      }
    }

    // Tower arms and carriage
    this.tower.carriage.position.y = s.armTop;
    for (const a of this.tower.arms) a.pivot.rotation.y = a.side * s.armOpen;

    // Smoke clocks and plume light on smoke
    for (const k in this.smoke) {
      const u = this.smoke[k].uniforms;
      u.uT.value = s.t;
      u.uGlowPos.value.copy(tail);
      u.uGlow.value = power * s.eng.throttle * 1.6;
    }
    const gu = this.ground.material.uniforms;
    gu.uGlowPos.value.copy(tail);
    gu.uGlow.value = power * s.eng.throttle * nearGround;

    // Lighting: high up, the booster is still in sunlight after the ground has gone dark.
    const sunlit = Math.min(1, Math.max(0, (s.y - 300) / 9000));
    this.sun.intensity = 0.55 + 2.6 * sunlit;
    this.sun.position.copy(LIGHT_DIR).multiplyScalar(1000).add(b.position);
    this.sun.target.position.copy(b.position);
  }

  // -------------------------------------------------------------------------
  // Camera shots. Each returns {pos, look, fov}. Blending by weights avoids lag
  // while still giving smooth cuts between chapters.
  shotPose(name, s, L) {
    const B = V(s.x, s.y + 35, 0);
    const alt = s.y;
    const t = this.time;
    const drift = this.reducedMotion ? 0 : 1;
    switch (name) {
      case 'hero': return { pos: V(250 - 30 * L * drift, 16 + 4 * L, 360 - 60 * L * drift), look: V(-10, 72, -12), fov: 38 };
      case 'approach': return { pos: V(170 - 90 * L, 10 + 4 * L, 250 - 110 * L), look: V(-6, 66 + 6 * L, -10), fov: 40 };
      case 'liftoff': {
        const up = Math.min(alt - MOUNT_TOP, 400);
        return { pos: V(95, 6, 140), look: V(0, 50 + up * 0.85, -4), fov: 46 - Math.min(16, up / 20) };
      }
      case 'chase': {
        const k = Math.min(1, alt / 30000);
        const d = 150 + 90 * k;
        return { pos: V(B.x - d * 0.55, B.y - d * (0.42 - 0.75 * k), d * 0.95), look: V(B.x + 8, B.y + 6, 0), fov: 44 };
      }
      case 'side': return { pos: V(B.x + 30, B.y + 25, 210), look: V(B.x - 10, B.y + 5, 0), fov: 46 };
      case 'fall': {
        const k = Math.min(1, Math.max(0, (alt - 4000) / 60000));
        return { pos: V(B.x + 70, B.y + 60 + 60 * k, 120 + 40 * k), look: V(B.x - 4, B.y - 30, 0), fov: 46 };
      }
      case 'towerup': return { pos: V(9, 152, TOWER_Z + 8), look: V(B.x * 0.85, Math.max(B.y, 120), 0), fov: Math.max(11, Math.min(60, 2 * Math.atan(110 / Math.max(1, Math.hypot(B.x, B.y - 150))) * 180 / Math.PI)) };
      case 'arm': {
        // Tower-level camera on the carriage corner, looking across the arms.
        return { pos: V(-10.5, s.armTop + 5.5, TOWER_Z + 8.5), look: V(s.x * 0.6, Math.min(Math.max(s.y + 52, s.armTop - 3), s.armTop + 40), 0), fov: 62 };
      }
      case 'wide': return { pos: V(78 + 10 * L * drift, 5, 112 - 8 * L * drift), look: V(-4, 76, -12), fov: 52 };
      case 'top': return { pos: V(5, s.armTop + 44, 13), look: V(0, s.armTop, -3), fov: 52 };
      case 'closeup': return { pos: V(17, s.armTop + 3.5, 10), look: V(4.2, s.armTop + 1.6, 0), fov: 42 };
      case 'pad': return { pos: V(150 - 20 * L * drift, 34, 190), look: V(-6, 55, -12), fov: 38 };
      case 'orbit': {
        const a = 0.7 + (this.reducedMotion ? 0 : t * 0.025) + L * 0.8;
        return { pos: V(Math.cos(a) * 240, 40 + 20 * L, Math.sin(a) * 240), look: V(0, 70, -10), fov: 38 };
      }
      // user camera modes
      case 'u-chase': {
        const near = alt < 3000;
        return near ? { pos: V(B.x + 70, B.y - 10, 120), look: B.clone(), fov: 44 } : this.shotPose('chase', s, L);
      }
      case 'u-tower': {
        const cam = V(7, 150, TOWER_Z + 7);
        const dist = Math.max(1, cam.distanceTo(B));
        const fov = Math.max(0.25, Math.min(60, 2 * Math.atan(70 / dist) * 180 / Math.PI));
        return { pos: cam, look: B.clone(), fov };
      }
      case 'u-top': return { pos: V(B.x + 4, B.y + 160 + Math.min(alt, 2000) * 0.05, 30), look: V(B.x, B.y - 20, 0), fov: 50 };
    }
    return { pos: V(200, 30, 300), look: V(0, 60, 0), fov: 40 };
  }

  updateCamera(dt) {
    const target = this.override === 'auto' ? this.shot : 'u-' + this.override;
    const w = this.shotWeights;
    if (!w.has(target)) w.set(target, 0);
    let k = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 3.2);
    // Shots kilometers apart would sweep through empty sky: cut instead.
    if (this._lastPos) {
      const goal = this.shotPose(target, this.state, this.shotLocal).pos;
      if (goal.distanceTo(this._lastPos) > 2500) k = 1;
    }
    let total = 0;
    for (const [name, val] of w) {
      const goal = name === target ? 1 : 0;
      const nv = val + (goal - val) * k;
      if (nv < 0.002 && goal === 0) w.delete(name); else { w.set(name, nv); total += nv; }
    }
    const s = this.state;
    const pos = V(0, 0, 0), look = V(0, 0, 0); let fov = 0;
    for (const [name, val] of w) {
      const p = this.shotPose(name, s, name === this.shot ? this.shotLocal : this.shotLocal);
      const f = val / total;
      pos.addScaledVector(p.pos, f); look.addScaledVector(p.look, f); fov += p.fov * f;
    }
    // Camera shake near the pad at liftoff and at the catch
    if (!this.reducedMotion) {
      const nearPad = Math.exp(-pos.distanceTo(V(0, 30, 0)) / 300);
      const shake = (s.eng.count > 13 ? s.eng.throttle * 0.5 : 0) * nearPad + (s.t > T_CONTACT && s.t < T_CONTACT + 1 ? 0.25 * (1 - (s.t - T_CONTACT)) : 0);
      pos.x += Math.sin(this.time * 47) * shake; pos.y += Math.sin(this.time * 39 + 1) * shake;
    }
    this.camera.position.copy(pos);
    this._lastPos = pos.clone();
    this.camera.lookAt(look);
    this.camera.fov = fov;
    const dist = pos.distanceTo(look);
    this.camera.near = Math.min(Math.max(0.3, dist * 0.02), 30);
    this.camera.far = Math.max(60000, pos.y * 9 + 120000);
    this.camera.updateProjectionMatrix();
  }

  project(v) {
    tmpA.copy(v).project(this.camera);
    return { x: (tmpA.x * 0.5 + 0.5) * this.w, y: (-tmpA.y * 0.5 + 0.5) * this.h, visible: tmpA.z < 1 && tmpA.z > -1 };
  }

  // World points for the annotation labels
  anchors() {
    const g = this.booster.group;
    return {
      pin: g.localToWorld(V(BOOSTER_R_PIN, PIN_Y + 0.4, 0)),
      fin: g.localToWorld(V(5.6, 65.4, 4.6)),
      rail: V(5.4, this.state.armTop - 0.3, -6.5),
      hsr: g.localToWorld(V(3.0, BOOSTER_LEN - 1.0, 3.6)),
      top: g.localToWorld(V(0, BOOSTER_LEN, 0)),
      bottom: g.localToWorld(V(0, 0, 0)),
      towerTop: V(0, 147, TOWER_Z),
      towerBase: V(0, 0, TOWER_Z),
    };
  }

  frame(dt) {
    this.time += dt;
    const s = stateAt(this.missionT);
    this.state = s;
    this.applyState(s);
    this.updateCamera(dt);

    const cam = this.camera;
    this.sky.position.copy(cam.position);
    this.sky.scale.setScalar(cam.far * 0.9);
    this.sky.material.uniforms.uAlt.value = cam.position.y;
    const camAlt = Math.max(0, cam.position.y);
    const dens = 0.00016 * Math.exp(-camAlt / 7000) + 0.0000035;
    this.scene.fog.density = dens;
    const gu = this.ground.material.uniforms;
    gu.uCam.value.copy(cam.position);
    gu.uDensity.value = dens;
    gu.uHaze.value.copy(this.hazeCool);
    gu.uHazeWarm.value.copy(this.hazeWarm);
    gu.uTime.value = this.time;

    const scale = this.viewH / (2 * Math.tan(cam.fov * Math.PI / 360));
    for (const k in this.smoke) this.smoke[k].uniforms.uScale.value = scale;
    for (const lp of [this.padLights, this.redLights]) { lp.material.uniforms.uScale.value = scale; lp.material.uniforms.uTime.value = this.time; }
    this.boosterPlume.uniforms.uTime.value = this.time;
    this.shipPlume.uniforms.uTime.value = this.time;

    if (this.composer) {
      if (this.shimmer) {
        const on = s.eng.count > 0 ? 1 : 0;
        const a = this.project(this.booster.group.localToWorld(V(0, this.booster.enginesY, 0)));
        const b = this.project(this.booster.group.localToWorld(V(0, this.booster.enginesY - this.boosterPlume.uniforms.uLen.value * 1.4, 0)));
        const su = this.shimmer.uniforms;
        su.uA.value.set(a.x / this.w, 1 - a.y / this.h);
        su.uB.value.set(b.x / this.w, 1 - b.y / this.h);
        const segLen = Math.hypot(b.x - a.x, b.y - a.y) / this.h;
        su.uWidth.value = Math.max(0.02, Math.min(0.25, segLen * 0.25));
        su.uStrength.value = on && a.visible ? (this.reducedMotion ? 0.4 : 1) : 0;
        su.uTime.value = this.time;
      }
      this.grade.uniforms.uTime.value = this.time;
      this.grade.uniforms.uGrain.value = this.reducedMotion ? 0.02 : 0.035;
      this.composer.render(dt);
    } else {
      this.renderer.render(this.scene, cam);
    }
  }
}

const BOOSTER_R_PIN = 5.1;
