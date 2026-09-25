# Art Direction

Legends OBS Cursor should preserve the original Avalon Reset cursor language by
default. New visuals are welcome, but they should be expressed as optional modes,
sliders, or toggles.

## Default Visual Language

- Neon green primary halo.
- Cyan accent arc.
- Rotating momentum dots around the outside of the cursor.
- Distinct left-click and right-click effects.
- Magenta right-click diamond burst.
- Transparent output suitable for OBS compositing.
- Optional floaty follow that changes motion timing without replacing the art.

## Design Rules

1. Do not replace the default look silently.
2. Do not remove the rotating dots.
3. Do not collapse left-click and right-click into the same treatment.
4. Add experimental visuals as modes.
5. Keep settings names clear enough for OBS users who are editing a live scene.

## Demo Guidance

When documenting visual changes, capture or render at least:

- Momentum ticks during cursor motion.
- Left-click ripple feedback.
- Right-click feedback.
- A normal idle or low-motion state.

The README animation should be generated from the same visual rules as the Lua
filter, not drawn as a separate marketing mockup.
