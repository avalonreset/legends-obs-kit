# release banner

The shared release face follows the hyperyap reference: black space, a small
red lowercase module name, one gray rule, and a short white description.

- Canvas: 4096 × 1024 (4:1).
- Palette: black `#000000`, red `#FF0000`, white `#FFFFFF`, gray `#666666`.
- Type: Legends Regular, fixed sizes and position across modules.
- Identity: the lowercase repository slug, including `legends-obs-kit`.
- Export: lossless `assets/banner.webp` for the README and `assets/banner.png`.
- Link: the README banner and repository About website point to
  [cto-legends.com](https://cto-legends.com).

From a source checkout, install Pillow in your development environment and run:

```sh
python scripts/render-banner.py --name legends-obs-kit --description "agentic obs control" --font /path/to/Legends-Regular.ttf --output assets/banner
```

Supply the font separately; the renderer does not download or redistribute it.
Keep the fixed typography. Shorten a description that overflows instead of
enlarging the layout, shrinking the text, or adding decoration.
