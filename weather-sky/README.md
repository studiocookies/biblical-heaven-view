# Overhead

A live, 3D sky that shows the weather where you are right now. Open
`index.html` in a browser and allow location. That's the whole setup: no
API keys and no build step.

## What's real

- **Sun and moon** are placed from your latitude, longitude and the clock.
  The moon is drawn in its actual phase. The stars rotate with sidereal time.
- **Clouds** are raymarched through a 3D noise volume. Their cover, thickness
  and darkness come from the current cloud cover and weather code, and they
  drift with the live wind direction and speed.
- **Rain, snow, fog and lightning** switch on from the WMO weather code,
  precipitation and visibility.
- **Temperature** sets a slight color grade: cold readings push the image
  blue, hot ones push it warm, and on very hot days the horizon shimmers.
- **The 48-hour strip** at the bottom lets you scrub through the forecast. The
  sky changes to show each hour's forecast weather and sun position.

Weather comes from [Open-Meteo](https://open-meteo.com) (free, no key). The
place name comes from BigDataCloud's free reverse-geocoder.

## Controls

- Drag the sky to look around. Double-click to hand the camera back to the
  auto-framing.
- Drag the strip (or focus it and press ←/→) to move through time.
- **Skies** previews other weather over your real time of day.
- **Place** searches for any city.

## URL options

`?lat=…&lon=…&name=…` pins a location. `?sky=storm` starts on a preview
(`clear`, `fair`, `overcast`, `rain`, `storm`, `snow`, `fog`). `?t=6` starts
6 hours ahead. `?q=0.5` fixes the render scale if the automatic scaling
struggles on your GPU.
