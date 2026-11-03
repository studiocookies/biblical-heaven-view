# The Catch

An independent, scroll-driven explainer on how SpaceX's Super Heavy booster is
caught by its launch tower's arms, and why that matters for reuse. Not
affiliated with SpaceX.

Open `index.html` through any static file server, for example:

```bash
cd booster-catch && python3 -m http.server 8000
# then visit http://localhost:8000
```

It needs a network connection for Three.js 0.160.0 (jsDelivr), GSAP 3.12.5
with ScrollTrigger (cdnjs), and Google Fonts. There is no build step.

## How it works

- `js/sim.js` is the mission model: a pure function from mission time to
  booster position, attitude, engine set, arm angle and so on. Values are
  illustrative, shaped to follow the Flight 5 sequence (staging near 74 km,
  boostback, unpowered fall, 13 then 3 engine landing burn, catch about
  7 minutes after liftoff).
- `js/main.js` maps scroll position to mission time with GSAP ScrollTrigger.
  Each `<section>` declares `data-map` (scroll progress to mission time) and
  `data-shots` (which camera to use).
- `js/models.js` builds the booster, ship, tower, arms, pad, ground and sky
  procedurally. `js/fx.js` holds the plume shader, the smoke particles (every
  particle is a pure function of mission time, so scrubbing backward works),
  and the heat-shimmer and grade passes.
- Quality steps down automatically on slow devices. Force a tier with
  `?q=low`, `?q=mid` or `?q=high`. `prefers-reduced-motion` (or the clock
  button) holds the camera still and cuts between shots.

## Accuracy

Flight status is a snapshot as of November 3, 2026. Sources are listed in the
page's credits section. HUD altitude, speed and clock come from the simplified
model and are labeled illustrative.
