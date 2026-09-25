# Credits

Legends OBS Cursor is an Avalon Reset project.

## Original Design

- Original cursor art direction, rotating momentum dots, click language, and OBS use case: Benjamin / Avalon Reset.
- Production packaging, installer hardening, documentation, and optional floaty-follow controls: Avalon Reset with Codex assistance.

## Platform And Runtime

- Built for [OBS Studio](https://obsproject.com/), an open source broadcasting and recording application.
- Runs as an OBS Lua script through OBS scripting support.
- Uses LuaJIT FFI to call the Windows `user32.dll` cursor APIs at runtime.

## Third-Party Code And References

- [`upgradeQ/cursor-skin-fx`](https://github.com/upgradeQ/cursor-skin-fx) was the
  closest technical starting point and reference for OBS-native Lua cursor
  effects. It demonstrated the practical OBS Lua pattern used here: poll the
  Windows cursor through LuaJIT FFI, register an OBS source or filter, and render
  a shader-driven cursor effect inside OBS. It is MIT licensed; its notice is
  preserved in [NOTICE](NOTICE).
- The current Legends OBS Cursor visual language, settings model, installer, and
  packaged release structure are Avalon Reset work, with Codex assistance.

## Research Lineage

- [`sqmw/MFCMouseEffect`](https://github.com/sqmw/MFCMouseEffect) was part of the
  earlier Windows cursor-highlighting research path and became the upstream for
  the private Avalon Reset `AuraClick` port. I do not currently see direct
  MFCMouseEffect source copied into this OBS Lua package, but it should still be
  credited as part of the project history.
- Other cursor visibility tools evaluated during research included PowerToys
  Mouse Utilities, Keyviz, FriskyMouse, PointerFocus, MouseEffects, and OBS input
  overlay options.

## Related Optional Tools

Some local Avalon Reset OBS scenes may also use other OBS filters, such as shader
crop or rounded-corner filters. Those are not bundled in this repository.
