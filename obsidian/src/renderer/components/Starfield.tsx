import { useEffect, useRef } from 'react';

/** Seeded PRNG so the sky is identical every launch. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A static starfield, optionally with a planetary horizon arc. Painted once per resize —
 * no animation loop, so it costs nothing while idle.
 */
export function Starfield({ density = 1, horizon = false, seed = 42, className = '' }: { density?: number; horizon?: boolean; seed?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const paint = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const rand = mulberry32(seed);
      const count = Math.round(((w * h) / 2600) * density);
      for (let i = 0; i < count; i++) {
        const x = rand() * w;
        const y = rand() * h;
        const r = rand() < 0.94 ? rand() * 0.75 + 0.2 : rand() * 1.1 + 0.8;
        const a = 0.18 + rand() * 0.6;
        const cool = rand() < 0.3;
        ctx.fillStyle = cool ? `rgba(169,223,255,${a})` : `rgba(230,237,243,${a * 0.9})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        if (r > 1.3) {
          ctx.fillStyle = `rgba(169,223,255,${a * 0.12})`;
          ctx.beginPath();
          ctx.arc(x, y, r * 3.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (horizon) {
        // Planet limb: a huge circle whose top edge crosses the lower part of the canvas.
        const R = w * 1.35;
        const cx = w * 0.62;
        const cy = h + R - h * 0.24;
        const body = ctx.createRadialGradient(cx, cy - R * 0.35, R * 0.2, cx, cy, R);
        body.addColorStop(0, '#0b1622');
        body.addColorStop(0.92, '#08111a');
        body.addColorStop(1, '#0c1a28');
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.fill();
        // atmosphere rim
        for (const [width, alpha] of [[1.2, 0.85], [4, 0.28], [14, 0.1], [36, 0.045]] as const) {
          ctx.strokeStyle = `rgba(169,223,255,${alpha})`;
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.arc(cx, cy, R, Math.PI * 1.08, Math.PI * 1.92);
          ctx.stroke();
        }
        // sunrise glint
        const gx = cx - R * Math.cos(Math.PI * 0.36);
        const gy = cy - R * Math.sin(Math.PI * 0.36);
        const glint = ctx.createRadialGradient(gx, gy, 0, gx, gy, w * 0.22);
        glint.addColorStop(0, 'rgba(228,242,255,0.38)');
        glint.addColorStop(0.25, 'rgba(169,223,255,0.12)');
        glint.addColorStop(1, 'rgba(169,223,255,0)');
        ctx.fillStyle = glint;
        ctx.fillRect(0, 0, w, h);
      }
    };
    paint();
    const ro = new ResizeObserver(() => paint());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [density, horizon, seed]);

  return <canvas ref={ref} className={`starfield ${className}`} aria-hidden="true" />;
}

/** Thin orbital rings used as a restrained decorative motif. */
export function OrbitRings({ className = '' }: { className?: string }) {
  return (
    <svg className={`orbit-rings ${className}`} viewBox="0 0 400 400" aria-hidden="true">
      <g fill="none" stroke="rgba(169,223,255,0.16)" strokeWidth="0.8">
        <ellipse cx="200" cy="200" rx="190" ry="64" transform="rotate(-16 200 200)" />
        <ellipse cx="200" cy="200" rx="140" ry="46" transform="rotate(-16 200 200)" strokeDasharray="2 5" />
        <ellipse cx="200" cy="200" rx="92" ry="30" transform="rotate(-16 200 200)" />
      </g>
      <circle cx="200" cy="200" r="20" fill="url(#obs-core)" />
      <circle cx="375" cy="148" r="3" fill="#a9dfff" opacity="0.9" />
      <circle cx="80" cy="236" r="2" fill="#e6edf3" opacity="0.7" />
      <defs>
        <radialGradient id="obs-core" cx="40%" cy="35%" r="70%">
          <stop offset="0" stopColor="#e4e8ec" />
          <stop offset="0.55" stopColor="#7f8c99" />
          <stop offset="1" stopColor="#1b2633" />
        </radialGradient>
      </defs>
    </svg>
  );
}
