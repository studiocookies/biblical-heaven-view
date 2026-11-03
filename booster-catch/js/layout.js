// Engine layout for Super Heavy: 3 center, 10 inner ring, 20 outer ring.
// Kept free of three.js so the story widgets work even if WebGL does not.
export const ENGINE_LAYOUT = (() => {
  const out = [];
  for (let i = 0; i < 3; i++) { const a = Math.PI / 2 + i * 2 * Math.PI / 3; out.push({ x: Math.cos(a) * 0.95, z: Math.sin(a) * 0.95, ring: 'center' }); }
  for (let i = 0; i < 10; i++) { const a = (i + 0.5) * 2 * Math.PI / 10; out.push({ x: Math.cos(a) * 2.5, z: Math.sin(a) * 2.5, ring: 'inner' }); }
  for (let i = 0; i < 20; i++) { const a = i * 2 * Math.PI / 20; out.push({ x: Math.cos(a) * 3.88, z: Math.sin(a) * 3.88, ring: 'outer' }); }
  return out;
})();

