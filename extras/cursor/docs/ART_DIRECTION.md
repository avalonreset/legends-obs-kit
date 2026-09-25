# Art Direction

Legends OBS Cursor default is the **three-color sandwich ring** so it stays
readable on both light and dark backgrounds.

## Default Visual Language

- Outer / middle / inner rings share the **same stroke thickness**
- Outer ring: **black** (`#000000`)
- Middle ring: **Legends red** (`#FF0000` pure channel red only)
- Inner ring: **white** (`#FFFFFF`)
- Glow / haze: **Legends red** (same middle family)
- Momentum ticks: **12** discrete dots, cycling **white → black → Legends red**
- Trails / wake / finder: **Legends red** by default
- Left-click: white ripple language
- Right-click: Legends red (not magenta)
- Transparent output suitable for OBS compositing
- Optional floaty follow that changes motion timing without replacing the art

## Palette law

Only these three colors in the default cursor chrome:

| Role | Color |
|------|--------|
| Outer sandwich | black |
| Middle sandwich + glow | Legends red `#FF0000` |
| Inner sandwich + ticks | white |

No green. No cyan. No magenta. No near-reds (`#ED101C`, etc.).

## Design Rules

1. Do not reintroduce green/cyan as the default look.
2. Keep red in the **middle** of the sandwich.
3. Keep distinct left-click and right-click treatments.
4. Add experimental visuals as modes.
5. Keep settings names clear enough for OBS users who are editing a live scene.

## Demo Guidance

When documenting visual changes, capture or render at least:

- Sandwich ring idle on a dark background.
- Sandwich ring idle on a light background.
- Momentum ticks during cursor motion.
- Left-click and right-click feedback.

The README animation should be generated from the same visual rules as the Lua
filter, not drawn as a separate marketing mockup.
