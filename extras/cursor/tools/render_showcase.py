from __future__ import annotations

import argparse
import math
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
DEMO = ASSETS / "demo"


DEFAULTS = {
    "radius": 82.0,
    "thickness": 12.0,
    "glow": 90.0,
    "opacity": 0.92,
    "follow_lag_ms": 255.0,
    "idle_activity": 0.22,
    "speed_limit": 3200.0,
    "click_size": 330.0,
    "click_duration": 0.70,
    "motion_spin": 1.0,
    "motion_decay": 5.5,
    "motion_ticks": 0.85,
    "tick_count": 10,
    "wake_strength": 0.60,
    "trail_strength": 0.55,
    "trail_spacing": 0.030,
    "trail_duration": 0.42,
    "finder_size": 1.90,
}

COLORS = {
    "main": (0, 255, 120),
    "accent": (46, 204, 255),
    "left": (255, 255, 255),
    "right": (255, 46, 199),
    "bg": (5, 8, 10),
    "panel": (8, 13, 16),
    "line": (25, 42, 46),
    "text": (235, 255, 248),
    "muted": (148, 176, 178),
}


@dataclass(frozen=True)
class Section:
    start: float
    end: float
    mode: str
    title: str
    subtitle: str
    click: str | None = None


@dataclass
class Click:
    x: float
    y: float
    t: float
    button: float


@dataclass
class Trail:
    x: float
    y: float
    t: float
    speed: float


@dataclass
class CursorState:
    mouse_x: float | None = None
    mouse_y: float | None = None
    prev_mouse_x: float | None = None
    prev_mouse_y: float | None = None
    vel_x: float = 0.0
    vel_y: float = 0.0
    speed_px: float = 0.0
    speed_active: float = 0.0
    spin_velocity: float = 0.0
    spin_phase: float = 0.0
    last_trail_time: float = -999.0
    clicks: list[Click] = field(default_factory=list)
    trails: list[Trail] = field(default_factory=list)
    fired_clicks: set[str] = field(default_factory=set)


SECTIONS = [
    Section(0.0, 2.0, "intro", "Legends OBS Cursor", "4K60 simulated OBS overlay demo"),
    Section(2.0, 5.0, "momentum", "Momentum ticks", "Actual 3840x2160 scale, 82 px halo, floaty follow on"),
    Section(5.0, 8.0, "left", "Left-click ripple", "White circular ripple and radial spokes"),
    Section(8.0, 11.0, "right", "Right-click diamond", "Magenta diamond burst with distinct click language"),
    Section(11.0, 14.0, "comet", "Comet trail mode", "Afterimages reveal direction and speed"),
    Section(14.0, 17.0, "stretch", "Stretch / wake mode", "Velocity stretches the halo and throws a laser wake"),
    Section(17.0, 20.0, "finder", "Finder shake mode", "Direction reversals inflate locator rings"),
    Section(20.0, 22.0, "outro", "Ready for OBS", "Lua filter, embedded shader, backup-first installer"),
]


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def ease_in_out(value: float) -> float:
    value = clamp(value, 0.0, 1.0)
    return value * value * (3.0 - 2.0 * value)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        Path("C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf"),
        Path("C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def active_section(t: float) -> Section:
    for section in SECTIONS:
        if section.start <= t < section.end:
            return section
    return SECTIONS[-1]


def section_progress(section: Section, t: float) -> float:
    return clamp((t - section.start) / max(section.end - section.start, 0.001), 0.0, 1.0)


def normalized_path(mode: str, u: float) -> tuple[float, float]:
    if mode == "finder":
        x = 0.50 + math.sin(u * math.tau * 5.0) * (0.17 * (1.0 - u * 0.2))
        y = 0.50 + math.sin(u * math.tau * 2.0 + 0.8) * 0.12
        return x, y

    paths = {
        "momentum": [(0.70, 0.66), (0.23, 0.30), (0.45, 0.42), (0.72, 0.30), (0.47, 0.62)],
        "left": [(0.30, 0.48), (0.45, 0.50), (0.57, 0.55), (0.68, 0.43)],
        "right": [(0.70, 0.36), (0.52, 0.52), (0.39, 0.42), (0.62, 0.59)],
        "comet": [(0.18, 0.62), (0.33, 0.34), (0.55, 0.66), (0.75, 0.35), (0.83, 0.62)],
        "stretch": [(0.20, 0.42), (0.46, 0.42), (0.78, 0.55), (0.43, 0.66), (0.67, 0.36)],
    }
    points = paths.get(mode, paths["momentum"])
    scaled = u * (len(points) - 1)
    index = min(int(scaled), len(points) - 2)
    local = ease_in_out(scaled - index)
    p0 = points[index]
    p1 = points[index + 1]
    return lerp(p0[0], p1[0], local), lerp(p0[1], p1[1], local)


def target_xy(section: Section, t: float, width: int, height: int) -> tuple[float, float]:
    u = section_progress(section, t)
    x, y = normalized_path(section.mode, u)
    return x * width, y * height


def activation_curve(speed_px: float) -> float:
    t = clamp(speed_px / DEFAULTS["speed_limit"], 0.0, 1.0)
    return 1.0 - ((1.0 - t) * (1.0 - t))


def reset_state(state: CursorState, x: float, y: float) -> None:
    state.mouse_x = x
    state.mouse_y = y
    state.prev_mouse_x = x
    state.prev_mouse_y = y
    state.vel_x = 0.0
    state.vel_y = 0.0
    state.speed_px = 0.0
    state.speed_active = 0.0
    state.spin_velocity = 0.0
    state.trails.clear()
    state.clicks.clear()
    state.last_trail_time = -999.0
    state.fired_clicks.clear()


def update_state(state: CursorState, section: Section, t: float, dt: float, width: int, height: int) -> None:
    target_x, target_y = target_xy(section, t, width, height)
    if state.mouse_x is None or state.mouse_y is None or abs(t - section.start) < dt * 0.75:
        reset_state(state, target_x, target_y)
        return

    lag = DEFAULTS["follow_lag_ms"] / 1000.0
    follow = clamp(1.0 - math.exp(-dt / lag), 0.0, 1.0)
    state.mouse_x += (target_x - state.mouse_x) * follow
    state.mouse_y += (target_y - state.mouse_y) * follow

    dx = state.mouse_x - (state.prev_mouse_x or state.mouse_x)
    dy = state.mouse_y - (state.prev_mouse_y or state.mouse_y)
    vx = dx / dt
    vy = dy / dt
    speed = math.hypot(vx, vy)
    blend = clamp(dt * 12.0, 0.0, 1.0)

    state.vel_x += (vx - state.vel_x) * blend
    state.vel_y += (vy - state.vel_y) * blend
    state.speed_px += (speed - state.speed_px) * blend
    state.speed_active += (activation_curve(state.speed_px) - state.speed_active) * blend

    decay = math.exp(-DEFAULTS["motion_decay"] * dt)
    state.spin_velocity = state.spin_velocity * decay + (dx / max(width, 1)) * DEFAULTS["motion_spin"] * 28.0
    state.spin_phase += state.spin_velocity * dt * 10.0

    mode_allows_trail = section.mode in {"comet", "stretch"}
    dist = math.hypot(dx, dy)
    if (
        mode_allows_trail
        and state.speed_active > 0.03
        and dist > 2.0
        and t - state.last_trail_time >= DEFAULTS["trail_spacing"]
    ):
        state.trails.insert(0, Trail(state.mouse_x, state.mouse_y, t, state.speed_active))
        state.trails = state.trails[:8]
        state.last_trail_time = t

    if section.mode in {"left", "right"}:
        for idx, offset in enumerate((0.82, 1.55, 2.22)):
            click_key = f"{section.mode}-{idx}"
            if t >= section.start + offset and click_key not in state.fired_clicks:
                button = 1.0 if section.mode == "left" else 2.0
                state.clicks.insert(0, Click(state.mouse_x, state.mouse_y, t, button))
                state.fired_clicks.add(click_key)

    state.clicks = [click for click in state.clicks if t - click.t <= DEFAULTS["click_duration"]][:8]
    state.trails = [trail for trail in state.trails if t - trail.t <= DEFAULTS["trail_duration"]][:8]
    state.prev_mouse_x = state.mouse_x
    state.prev_mouse_y = state.mouse_y


def build_background(width: int, height: int) -> Image.Image:
    img = Image.new("RGB", (width, height), COLORS["bg"])
    draw = ImageDraw.Draw(img, "RGBA")

    grid = max(96, width // 40)
    for x in range(0, width, grid):
        draw.line((x, 0, x, height), fill=(20, 32, 36, 70), width=1)
    for y in range(0, height, grid):
        draw.line((0, y, width, y), fill=(20, 32, 36, 70), width=1)

    margin = int(width * 0.055)
    left_w = int(width * 0.35)
    right_x = int(width * 0.45)
    right_w = int(width * 0.47)
    top = int(height * 0.18)
    panel_h = int(height * 0.60)
    draw.rectangle((margin, top, margin + left_w, top + panel_h), fill=(8, 14, 17, 172), outline=(31, 52, 56, 150), width=2)
    draw.rectangle((right_x, top + int(height * 0.04), right_x + right_w, top + panel_h + int(height * 0.04)), fill=(6, 12, 16, 165), outline=(31, 52, 56, 145), width=2)

    bar_w = int(left_w * 0.10)
    for idx in range(5):
        x = margin + int(left_w * 0.12) + idx * int(left_w * 0.16)
        draw.rectangle((x, top + int(panel_h * 0.12), x + bar_w, top + int(panel_h * 0.88)), fill=(18, 30, 33, 92))

    for idx in range(9):
        y = top + int(height * 0.10) + idx * int(height * 0.045)
        line_w = int(right_w * (0.88 - idx * 0.025))
        draw.rounded_rectangle((right_x + int(right_w * 0.08), y, right_x + int(right_w * 0.08) + line_w, y + max(8, height // 160)), radius=8, fill=(30, 50, 53, 92))

    draw.rectangle((0, int(height * 0.91), width, height), fill=(2, 4, 5, 120))
    return img


def draw_text(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, font_obj: ImageFont.ImageFont, fill: tuple[int, int, int, int]) -> None:
    draw.text(xy, text, font=font_obj, fill=fill)


def draw_section_text(img: Image.Image, section: Section, t: float, width: int, height: int, title_font: ImageFont.ImageFont, subtitle_font: ImageFont.ImageFont) -> None:
    draw = ImageDraw.Draw(img, "RGBA")
    progress = section_progress(section, t)
    fade = min(smooth_fade(progress / 0.16), smooth_fade((1.0 - progress) / 0.12))

    if section.mode in {"intro", "outro"}:
        overlay = int(185 * fade)
        draw.rectangle((0, 0, width, height), fill=(0, 0, 0, overlay))
        title_w = draw.textbbox((0, 0), section.title, font=title_font)[2]
        sub_w = draw.textbbox((0, 0), section.subtitle, font=subtitle_font)[2]
        draw_text(draw, ((width - title_w) // 2, int(height * 0.42)), section.title, title_font, (*COLORS["text"], int(255 * fade)))
        draw_text(draw, ((width - sub_w) // 2, int(height * 0.50)), section.subtitle, subtitle_font, (*COLORS["muted"], int(230 * fade)))
        return

    x = int(width * 0.055)
    y = int(height * 0.055)
    pad_x = int(width * 0.018)
    pad_y = int(height * 0.018)
    box_w = int(width * 0.50)
    box_h = int(height * 0.135)
    draw.rounded_rectangle((x, y, x + box_w, y + box_h), radius=18, fill=(4, 9, 11, int(178 * fade)), outline=(50, 85, 84, int(145 * fade)), width=2)
    draw_text(draw, (x + pad_x, y + int(pad_y * 0.55)), section.title, title_font, (*COLORS["text"], int(255 * fade)))
    draw_text(draw, (x + pad_x, y + int(box_h * 0.62)), section.subtitle, subtitle_font, (*COLORS["muted"], int(230 * fade)))

    label = f"Mode: {section.mode.upper()}    Canvas: 3840 x 2160    FPS: 60"
    draw_text(draw, (int(width * 0.055), int(height * 0.935)), label, subtitle_font, (125, 160, 162, int(220 * fade)))


def smooth_fade(value: float) -> float:
    value = clamp(value, 0.0, 1.0)
    return value * value * (3.0 - 2.0 * value)


def draw_ring(draw: ImageDraw.ImageDraw, center: tuple[float, float], radius: float, width: float, color: tuple[int, int, int], alpha: int) -> None:
    if alpha <= 0:
        return
    x, y = center
    draw.ellipse((x - radius, y - radius, x + radius, y + radius), outline=(*color, int(clamp(alpha, 0, 255))), width=max(1, int(width)))


def draw_diamond(draw: ImageDraw.ImageDraw, center: tuple[float, float], radius: float, width: float, color: tuple[int, int, int], alpha: int) -> None:
    if alpha <= 0:
        return
    x, y = center
    points = [(x, y - radius), (x + radius, y), (x, y + radius), (x - radius, y)]
    draw.line(points + [points[0]], fill=(*color, int(clamp(alpha, 0, 255))), width=max(1, int(width)), joint="curve")


def velocity_dir(state: CursorState) -> tuple[float, float]:
    mag = math.hypot(state.vel_x, state.vel_y)
    if mag <= 1.0:
        return 1.0, 0.0
    return state.vel_x / mag, state.vel_y / mag


def draw_wake(draw: ImageDraw.ImageDraw, state: CursorState, center: tuple[float, float], mode: str) -> None:
    speed = state.speed_active
    if speed <= 0.04 or mode not in {"momentum", "comet", "stretch", "finder"}:
        return
    ux, uy = velocity_dir(state)
    px, py = -uy, ux
    strength = 1.0 if mode != "classic" else 0.20
    length = DEFAULTS["radius"] * (1.2 + speed * (2.2 if mode == "stretch" else 1.0))
    half = DEFAULTS["thickness"] * (1.15 + speed * (4.2 if mode == "stretch" else 1.7))
    x, y = center
    tail = (x - ux * length, y - uy * length)
    points = [
        (x + px * half * 0.65, y + py * half * 0.65),
        (tail[0] + px * half, tail[1] + py * half),
        (tail[0] - px * half, tail[1] - py * half),
        (x - px * half * 0.65, y - py * half * 0.65),
    ]
    draw.polygon(points, fill=(*COLORS["accent"], int(74 * speed * strength)))


def draw_trails(draw: ImageDraw.ImageDraw, state: CursorState, t: float, mode: str) -> None:
    if mode not in {"comet", "stretch"}:
        return
    for trail in reversed(state.trails):
        age = t - trail.t
        if age < 0.0 or age > DEFAULTS["trail_duration"]:
            continue
        local = age / DEFAULTS["trail_duration"]
        radius = DEFAULTS["radius"] * (0.68 + trail.speed * 0.30)
        alpha = int(205 * ((1.0 - local) ** 1.35) * trail.speed * DEFAULTS["trail_strength"])
        width = max(4, int(DEFAULTS["thickness"] * 0.55))
        if mode == "stretch":
            alpha = int(alpha * 0.45)
        draw_ring(draw, (trail.x, trail.y), radius, width, COLORS["accent"], alpha)


def draw_clicks(draw: ImageDraw.ImageDraw, state: CursorState, t: float) -> None:
    for click in reversed(state.clicks):
        age = t - click.t
        if age < 0.0 or age > DEFAULTS["click_duration"]:
            continue
        local = age / DEFAULTS["click_duration"]
        center = (click.x, click.y)
        alpha = int(235 * ((1.0 - local) ** 1.12))
        width = DEFAULTS["thickness"] * (0.85 + local)
        if click.button > 1.5:
            color = COLORS["right"]
            radius = DEFAULTS["radius"] * 1.16 + DEFAULTS["click_size"] * 0.78 * local
            draw_diamond(draw, center, radius, width, color, alpha)
            draw_ring(draw, center, DEFAULTS["radius"] * (1.05 + 0.45 * local), DEFAULTS["thickness"] * 1.15, color, int(alpha * 0.78))
            x, y = center
            cross = DEFAULTS["radius"] * 0.92
            draw.line((x - cross, y, x + cross, y), fill=(*color, int(alpha * 0.58)), width=5)
            draw.line((x, y - cross, x, y + cross), fill=(*color, int(alpha * 0.58)), width=5)
        else:
            color = COLORS["left"]
            radius = DEFAULTS["radius"] + DEFAULTS["click_size"] * local
            draw_ring(draw, center, radius, width, color, alpha)
            for idx in range(13):
                theta = state.spin_phase + t * 3.0 + idx * math.tau / 13
                inner = radius * 0.70
                outer = radius * 1.02
                x0 = center[0] + math.cos(theta) * inner
                y0 = center[1] + math.sin(theta) * inner
                x1 = center[0] + math.cos(theta) * outer
                y1 = center[1] + math.sin(theta) * outer
                draw.line((x0, y0, x1, y1), fill=(*color, int(alpha * 0.34)), width=3)


def draw_cursor(img: Image.Image, state: CursorState, section: Section, t: float) -> None:
    if state.mouse_x is None or state.mouse_y is None:
        return
    draw = ImageDraw.Draw(img, "RGBA")
    center = (state.mouse_x, state.mouse_y)
    mode = section.mode
    speed = clamp(state.speed_active, 0.0, 1.0)

    draw_trails(draw, state, t, mode)
    draw_wake(draw, state, center, mode)
    draw_clicks(draw, state, t)

    pulse = 1.0 + math.sin(t * 4.6) * DEFAULTS["idle_activity"] * 0.12
    radius = DEFAULTS["radius"] * pulse
    thickness = DEFAULTS["thickness"]

    if mode == "finder":
        finder = min(1.0, 0.45 + speed * 0.75)
        outer = radius * (1.0 + (DEFAULTS["finder_size"] - 1.0) * finder)
        draw_ring(draw, center, outer, thickness * 0.78, COLORS["main"], int(160 * finder))
        draw_ring(draw, center, outer * 1.34 + math.sin(t * 7.0) * 9.0, thickness * 0.45, COLORS["accent"], int(105 * finder))

    if mode == "stretch":
        ux, uy = velocity_dir(state)
        px, py = -uy, ux
        stretch = 1.0 + speed * 0.85
        samples = 22
        points: list[tuple[float, float]] = []
        for idx in range(samples):
            theta = idx * math.tau / samples
            along = math.cos(theta) * radius * stretch
            side = math.sin(theta) * radius * (1.0 + speed * 0.20)
            points.append((center[0] + ux * along + px * side, center[1] + uy * along + py * side))
        draw.line(points + [points[0]], fill=(*COLORS["main"], 235), width=int(thickness))
    else:
        for idx in range(9, 0, -1):
            draw_ring(draw, center, radius + idx * 11, 3, COLORS["main"], int(8 * idx * DEFAULTS["opacity"]))
        draw_ring(draw, center, radius, thickness, COLORS["main"], int(235 * DEFAULTS["opacity"]))
        draw_ring(draw, center, radius - thickness * 1.1, max(3, thickness * 0.45), COLORS["main"], 60)

    tick_boost = 1.30 if mode == "momentum" else 0.55
    tick_alpha = int(255 * clamp(0.18 * DEFAULTS["idle_activity"] + speed * DEFAULTS["motion_ticks"] * tick_boost, 0.10, 1.0))
    tick_radius = DEFAULTS["radius"] * (1.16 + speed * 0.24)
    for idx in range(DEFAULTS["tick_count"]):
        theta = -state.spin_phase + idx * math.tau / DEFAULTS["tick_count"]
        x = center[0] + math.cos(theta) * tick_radius
        y = center[1] + math.sin(theta) * tick_radius
        dot_r = 6.0 + 4.0 * speed + (idx % 2) * 1.4
        draw.ellipse((x - dot_r, y - dot_r, x + dot_r, y + dot_r), fill=(*COLORS["main"], tick_alpha))

    if math.hypot(state.vel_x, state.vel_y) > 1.0:
        angle = math.atan2(state.vel_y, state.vel_x)
        box = (center[0] - radius * 1.38, center[1] - radius * 1.38, center[0] + radius * 1.38, center[1] + radius * 1.38)
        draw.arc(box, start=math.degrees(angle) - 36, end=math.degrees(angle) + 36, fill=(*COLORS["accent"], int(210 * speed)), width=7)

    anchor = 7
    draw.ellipse((center[0] - anchor, center[1] - anchor, center[0] + anchor, center[1] + anchor), fill=(244, 255, 252, 175))


def render_video(output: Path, width: int, height: int, fps: int, crf: int) -> None:
    DEMO.mkdir(parents=True, exist_ok=True)
    duration = SECTIONS[-1].end
    frames = int(duration * fps)
    dt = 1.0 / fps
    title_font = font(max(42, width // 32), bold=True)
    subtitle_font = font(max(18, width // 90))
    background = build_background(width, height)
    state = CursorState()

    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        f"{width}x{height}",
        "-r",
        str(fps),
        "-i",
        "-",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        str(crf),
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(output),
    ]

    process = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    assert process.stdin is not None
    try:
        for frame_idx in range(frames):
            t = frame_idx / fps
            section = active_section(t)
            update_state(state, section, t, dt, width, height)
            frame = background.copy()
            if section.mode not in {"intro", "outro"}:
                draw_cursor(frame, state, section, t)
            draw_section_text(frame, section, t, width, height, title_font, subtitle_font)
            process.stdin.write(frame.tobytes())
            if frame_idx % max(1, fps * 2) == 0:
                print(f"rendered {frame_idx:04d}/{frames} frames")
    finally:
        process.stdin.close()
    code = process.wait()
    if code != 0:
        raise SystemExit(f"ffmpeg exited with {code}")


def transcode_webm(source: Path, output: Path) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source),
            "-an",
            "-c:v",
            "libvpx-vp9",
            "-b:v",
            "0",
            "-crf",
            "34",
            "-row-mt",
            "1",
            "-tile-columns",
            "2",
            "-cpu-used",
            "4",
            "-pix_fmt",
            "yuv420p",
            str(output),
        ],
        check=True,
    )


def transcode_readme_webp(source: Path, output: Path) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source),
            "-vf",
            "fps=30,scale=1600:-1:flags=lanczos",
            "-loop",
            "0",
            "-c:v",
            "libwebp_anim",
            "-lossless",
            "0",
            "-q:v",
            "78",
            "-compression_level",
            "6",
            "-preset",
            "drawing",
            "-an",
            "-vsync",
            "0",
            str(output),
        ],
        check=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Render the Legends OBS Cursor showcase video.")
    parser.add_argument("--preview", action="store_true", help="Render a faster 1280x720 preview.")
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--crf", type=int, default=23)
    args = parser.parse_args()

    if args.preview:
        width, height, fps = 1280, 720, 30
        output = args.output or (DEMO / "legends-cursor-showcase-preview.mp4")
    else:
        width, height, fps = 3840, 2160, 60
        output = args.output or (DEMO / "legends-cursor-showcase-4k60.mp4")

    render_video(output, width, height, fps, args.crf)
    print(f"wrote {output} ({output.stat().st_size} bytes)")
    if not args.preview:
        webm = output.with_suffix(".webm")
        webp = output.with_name("legends-cursor-showcase.webp")
        transcode_webm(output, webm)
        print(f"wrote {webm} ({webm.stat().st_size} bytes)")
        transcode_readme_webp(output, webp)
        print(f"wrote {webp} ({webp.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
