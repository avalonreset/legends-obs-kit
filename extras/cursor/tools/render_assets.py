from __future__ import annotations

import math
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
DEMO = ASSETS / "demo"
SCREENSHOTS = ASSETS / "screenshots"

FPS = 24
DURATION = 6.0
WIDTH = 960
HEIGHT = 540
# Render the README demo as a 1080p OBS preview so the default 82px halo remains
# legible after GitHub scales the media down. The runtime defaults still support
# 3840x2160 scenes.
LOGICAL_WIDTH = 1920.0
LOGICAL_HEIGHT = 1080.0
SCALE = WIDTH / LOGICAL_WIDTH


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
    time: float = 0.0
    mouse_x: float | None = None
    mouse_y: float | None = None
    prev_mouse_x: float | None = None
    prev_mouse_y: float | None = None
    vel_x: float = 0.0
    vel_y: float = 0.0
    prev_vel_x: float = 0.0
    prev_vel_y: float = 0.0
    speed_px: float = 0.0
    speed_active: float = 0.0
    spin_velocity: float = 0.0
    spin_phase: float = 0.0
    last_trail_time: float = -999.0
    clicks: list[Click] = field(default_factory=list)
    trails: list[Trail] = field(default_factory=list)
    left_fired: bool = False
    right_fired: bool = False


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
}

COLORS = {
    "main": (0, 255, 120),
    "accent": (46, 204, 255),
    "left": (255, 255, 255),
    "right": (255, 46, 199),
    "bg": (5, 8, 10),
}


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    if edge0 == edge1:
        return 1.0 if value >= edge1 else 0.0
    x = clamp((value - edge0) / (edge1 - edge0), 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def ease_in_out(value: float) -> float:
    value = clamp(value, 0.0, 1.0)
    return value * value * (3.0 - 2.0 * value)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def logical(point: tuple[float, float]) -> tuple[float, float]:
    return point[0] / SCALE, point[1] / SCALE


def screen(point: tuple[float, float]) -> tuple[float, float]:
    return point[0] * SCALE, point[1] * SCALE


def target_path(t: float) -> tuple[float, float]:
    points = [
        (0.00, (760.0, 385.0)),
        (0.55, (370.0, 220.0)),
        (1.05, (430.0, 250.0)),
        (1.70, (610.0, 310.0)),
        (2.35, (820.0, 235.0)),
        (2.95, (610.0, 165.0)),
        (3.65, (785.0, 425.0)),
        (4.25, (350.0, 365.0)),
        (5.10, (595.0, 250.0)),
        (6.00, (760.0, 385.0)),
    ]
    for idx in range(len(points) - 1):
        t0, p0 = points[idx]
        t1, p1 = points[idx + 1]
        if t <= t1:
            u = ease_in_out((t - t0) / (t1 - t0))
            return logical((lerp(p0[0], p1[0], u), lerp(p0[1], p1[1], u)))
    return logical(points[-1][1])


def activation_curve(speed_px: float) -> float:
    t = clamp(speed_px / DEFAULTS["speed_limit"], 0.0, 1.0)
    return 1.0 - ((1.0 - t) * (1.0 - t))


def tick_state(state: CursorState, dt: float) -> None:
    state.time += dt
    target_x, target_y = target_path(state.time)

    if state.mouse_x is None or state.mouse_y is None:
        state.mouse_x = target_x
        state.mouse_y = target_y
        state.prev_mouse_x = target_x
        state.prev_mouse_y = target_y
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
    state.spin_velocity = (
        state.spin_velocity * decay
        + (dx / LOGICAL_WIDTH) * DEFAULTS["motion_spin"] * 28.0
    )
    state.spin_phase += state.spin_velocity * dt * 10.0

    dist = math.hypot(dx, dy)
    if (
        state.speed_active > 0.03
        and dist > 2.0
        and state.time - state.last_trail_time >= DEFAULTS["trail_spacing"]
    ):
        state.trails.insert(0, Trail(state.mouse_x, state.mouse_y, state.time, state.speed_active))
        state.trails = state.trails[:8]
        state.last_trail_time = state.time

    if state.time >= 1.18 and not state.left_fired:
        state.clicks.insert(0, Click(state.mouse_x, state.mouse_y, state.time, 1.0))
        state.left_fired = True

    if state.time >= 2.70 and not state.right_fired:
        state.clicks.insert(0, Click(state.mouse_x, state.mouse_y, state.time, 2.0))
        state.right_fired = True

    state.clicks = [
        click for click in state.clicks if state.time - click.t <= DEFAULTS["click_duration"]
    ][:8]
    state.trails = [
        trail for trail in state.trails if state.time - trail.t <= DEFAULTS["trail_duration"]
    ][:8]

    state.prev_vel_x = state.vel_x
    state.prev_vel_y = state.vel_y
    state.prev_mouse_x = state.mouse_x
    state.prev_mouse_y = state.mouse_y


def draw_background() -> Image.Image:
    img = Image.new("RGB", (WIDTH, HEIGHT), COLORS["bg"])
    draw = ImageDraw.Draw(img, "RGBA")

    for x in range(0, WIDTH, 48):
        draw.line((x, 0, x, HEIGHT), fill=(22, 34, 38, 62), width=1)
    for y in range(0, HEIGHT, 48):
        draw.line((0, y, WIDTH, y), fill=(22, 34, 38, 62), width=1)

    draw.rectangle((54, 62, 388, 422), fill=(11, 16, 19, 170), outline=(31, 48, 53, 150), width=1)
    draw.rectangle((432, 86, 903, 454), fill=(7, 13, 17, 160), outline=(31, 48, 53, 140), width=1)
    for idx in range(8):
        y = 116 + idx * 32
        draw.rounded_rectangle((470, y, 870 - idx * 14, y + 8), radius=4, fill=(34, 53, 57, 80))
    for idx in range(5):
        x = 92 + idx * 54
        draw.rectangle((x, 98, x + 34, 382), fill=(22, 36, 39, 72))
    draw.rectangle((0, 486, WIDTH, HEIGHT), fill=(2, 4, 5, 110))
    return img.convert("RGBA")


def draw_ring(
    layer: Image.Image,
    center: tuple[float, float],
    radius: float,
    width: float,
    color: tuple[int, int, int],
    alpha: int,
) -> None:
    if alpha <= 0 or radius <= 0:
        return
    draw = ImageDraw.Draw(layer, "RGBA")
    x, y = center
    r = radius
    draw.ellipse(
        (x - r, y - r, x + r, y + r),
        outline=(*color, int(clamp(alpha, 0, 255))),
        width=max(1, int(width)),
    )


def draw_diamond_ring(
    layer: Image.Image,
    center: tuple[float, float],
    radius: float,
    width: float,
    color: tuple[int, int, int],
    alpha: int,
) -> None:
    if alpha <= 0 or radius <= 0:
        return
    draw = ImageDraw.Draw(layer, "RGBA")
    x, y = center
    points = [(x, y - radius), (x + radius, y), (x, y + radius), (x - radius, y)]
    draw.line(points + [points[0]], fill=(*color, int(clamp(alpha, 0, 255))), width=max(1, int(width)), joint="curve")


def draw_glow(
    img: Image.Image,
    center: tuple[float, float],
    radius: float,
    color: tuple[int, int, int],
    strength: float,
) -> None:
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    for idx in range(10, 0, -1):
        a = int(11 * idx * strength)
        draw_ring(layer, center, radius + idx * 6, 2 + idx * 0.4, color, a)
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(3.2)))


def draw_wake(img: Image.Image, state: CursorState, center: tuple[float, float]) -> None:
    speed_active = state.speed_active
    if speed_active <= 0.04:
        return
    vx = state.vel_x
    vy = state.vel_y
    mag = math.hypot(vx, vy)
    if mag <= 1.0:
        return
    ux, uy = vx / mag, vy / mag
    px, py = -uy, ux
    length = (DEFAULTS["radius"] * (1.35 + speed_active * 1.0)) * SCALE
    half = (DEFAULTS["thickness"] * (1.2 + speed_active * 2.2)) * SCALE
    x, y = center
    tail = (x - ux * length, y - uy * length)
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer, "RGBA")
    points = [
        (x + px * half * 0.7, y + py * half * 0.7),
        (tail[0] + px * half, tail[1] + py * half),
        (tail[0] - px * half, tail[1] - py * half),
        (x - px * half * 0.7, y - py * half * 0.7),
    ]
    draw.polygon(points, fill=(*COLORS["accent"], int(80 * speed_active)))
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(4.0)))


def draw_trails(img: Image.Image, state: CursorState) -> None:
    for trail in reversed(state.trails):
        age = state.time - trail.t
        if age < 0.0 or age > DEFAULTS["trail_duration"]:
            continue
        t = age / DEFAULTS["trail_duration"]
        center = screen((trail.x, trail.y))
        radius = DEFAULTS["radius"] * (0.68 + trail.speed * 0.30) * SCALE
        alpha = int(170 * ((1.0 - t) ** 1.35) * trail.speed * DEFAULTS["trail_strength"])
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        draw_ring(layer, center, radius, max(2, DEFAULTS["thickness"] * 0.50 * SCALE), COLORS["accent"], alpha)
        img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(1.4)))


def draw_spokes(
    layer: Image.Image,
    center: tuple[float, float],
    radius: float,
    count: int,
    phase: float,
    color: tuple[int, int, int],
    alpha: int,
) -> None:
    draw = ImageDraw.Draw(layer, "RGBA")
    x, y = center
    for idx in range(count):
        theta = phase + idx * math.tau / count
        inner = radius * 0.72
        outer = radius * 1.05
        p0 = (x + math.cos(theta) * inner, y + math.sin(theta) * inner)
        p1 = (x + math.cos(theta) * outer, y + math.sin(theta) * outer)
        draw.line((p0, p1), fill=(*color, alpha), width=2)


def draw_clicks(img: Image.Image, state: CursorState) -> None:
    for click in reversed(state.clicks):
        age = state.time - click.t
        if age < 0.0 or age > DEFAULTS["click_duration"]:
            continue
        t = age / DEFAULTS["click_duration"]
        center = screen((click.x, click.y))
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        base_alpha = int(235 * ((1.0 - t) ** 1.12))
        thickness = max(2, DEFAULTS["thickness"] * (0.85 + t) * SCALE)
        if click.button > 1.5:
            color = COLORS["right"]
            radius = (DEFAULTS["radius"] * 1.16 + DEFAULTS["click_size"] * 0.78 * t) * SCALE
            draw_diamond_ring(layer, center, radius, thickness, color, base_alpha)
            draw_ring(
                layer,
                center,
                DEFAULTS["radius"] * (1.05 + 0.45 * t) * SCALE,
                DEFAULTS["thickness"] * 1.15 * SCALE,
                color,
                int(base_alpha * 0.76),
            )
            x, y = center
            draw = ImageDraw.Draw(layer, "RGBA")
            cross = DEFAULTS["radius"] * 0.92 * SCALE
            draw.line((x - cross, y, x + cross, y), fill=(*color, int(base_alpha * 0.70)), width=max(2, int(4 * SCALE + 2)))
            draw.line((x, y - cross, x, y + cross), fill=(*color, int(base_alpha * 0.70)), width=max(2, int(4 * SCALE + 2)))
            draw_spokes(layer, center, radius * 0.86, 8, -state.spin_phase - state.time * 2.4, color, int(base_alpha * 0.42))
        else:
            color = COLORS["left"]
            radius = (DEFAULTS["radius"] + DEFAULTS["click_size"] * t) * SCALE
            draw_ring(layer, center, radius, thickness, color, base_alpha)
            draw_spokes(layer, center, radius * 0.90, 13, state.spin_phase + state.time * 3.0, color, int(base_alpha * 0.44))
        img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(0.8)))


def draw_cursor(img: Image.Image, state: CursorState) -> None:
    if state.mouse_x is None or state.mouse_y is None:
        return
    center = screen((state.mouse_x, state.mouse_y))
    speed = clamp(state.speed_active, 0.0, 1.0)
    pulse = 1.0 + math.sin(state.time * 4.6) * DEFAULTS["idle_activity"] * 0.12
    radius = DEFAULTS["radius"] * pulse * SCALE
    thickness = DEFAULTS["thickness"] * SCALE
    tick_radius = DEFAULTS["radius"] * (1.16 + speed * 0.24) * SCALE

    draw_wake(img, state, center)
    draw_trails(img, state)
    draw_clicks(img, state)
    draw_glow(img, center, radius + DEFAULTS["glow"] * 0.20 * SCALE, COLORS["main"], 0.62)

    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw_ring(layer, center, radius, thickness, COLORS["main"], int(235 * DEFAULTS["opacity"]))
    draw_ring(layer, center, radius - thickness * 1.1, max(1.0, thickness * 0.45), COLORS["main"], 55)

    tick_alpha = int(
        255
        * clamp(
            0.18 * DEFAULTS["idle_activity"] + speed * DEFAULTS["motion_ticks"] * 1.30,
            0.12,
            1.0,
        )
    )
    draw = ImageDraw.Draw(layer, "RGBA")
    for idx in range(DEFAULTS["tick_count"]):
        theta = -state.spin_phase + idx * math.tau / DEFAULTS["tick_count"]
        x = center[0] + math.cos(theta) * tick_radius
        y = center[1] + math.sin(theta) * tick_radius
        dot_r = (6.0 + 4.0 * speed + (idx % 2) * 1.4) * SCALE * 1.8
        draw.ellipse((x - dot_r, y - dot_r, x + dot_r, y + dot_r), fill=(*COLORS["main"], tick_alpha))

    vx, vy = state.vel_x, state.vel_y
    if math.hypot(vx, vy) > 1:
        angle = math.atan2(vy, vx)
        arc_box = (
            center[0] - radius * 1.38,
            center[1] - radius * 1.38,
            center[0] + radius * 1.38,
            center[1] + radius * 1.38,
        )
        draw.arc(
            arc_box,
            start=math.degrees(angle) - 36,
            end=math.degrees(angle) + 36,
            fill=(*COLORS["accent"], int(210 * speed)),
            width=max(2, int(5 * SCALE * 2.0)),
        )

    anchor_r = 6
    draw.ellipse(
        (center[0] - anchor_r, center[1] - anchor_r, center[0] + anchor_r, center[1] + anchor_r),
        fill=(244, 255, 252, 170),
    )
    img.alpha_composite(layer)


def render_frame(state: CursorState) -> Image.Image:
    img = draw_background()
    draw_cursor(img, state)
    return img.convert("RGB")


def render_demo() -> dict[str, Path]:
    DEMO.mkdir(parents=True, exist_ok=True)
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)

    frame_count = int(DURATION * FPS)
    dt = 1.0 / FPS
    state = CursorState()
    outputs: dict[str, Path] = {
        "webp": DEMO / "legends-cursor-demo.webp",
        "gif": DEMO / "legends-cursor-demo.gif",
        "momentum": SCREENSHOTS / "momentum-ticks.png",
        "left": SCREENSHOTS / "left-click-ripple.png",
        "right": SCREENSHOTS / "right-click-diamond.png",
    }
    still_times = {
        "momentum": 2.12,
        "left": 1.34,
        "right": 2.88,
    }

    with tempfile.TemporaryDirectory(prefix="legends-cursor-frames-") as temp_name:
        temp = Path(temp_name)
        frames: list[Image.Image] = []
        for index in range(frame_count):
            tick_state(state, dt)
            frame = render_frame(state)
            frames.append(frame)
            frame.save(temp / f"frame_{index:04d}.png")
            for key, still_time in still_times.items():
                if abs(state.time - still_time) < dt / 2:
                    frame.save(outputs[key], "PNG", optimize=True)

        if shutil.which("ffmpeg"):
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-framerate",
                    str(FPS),
                    "-i",
                    str(temp / "frame_%04d.png"),
                    "-loop",
                    "0",
                    "-c:v",
                    "libwebp_anim",
                    "-lossless",
                    "0",
                    "-q:v",
                    "82",
                    "-compression_level",
                    "6",
                    "-preset",
                    "drawing",
                    "-an",
                    "-vsync",
                    "0",
                    str(outputs["webp"]),
                ],
                check=True,
            )
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-framerate",
                    str(FPS),
                    "-i",
                    str(temp / "frame_%04d.png"),
                    "-vf",
                    "fps=16,scale=840:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3",
                    "-loop",
                    "0",
                    str(outputs["gif"]),
                ],
                check=True,
            )
        else:
            frames[0].save(
                outputs["gif"],
                save_all=True,
                append_images=frames[1:],
                duration=int(1000 / FPS),
                loop=0,
                optimize=True,
            )

    return outputs


def main() -> None:
    outputs = render_demo()
    for kind, path in outputs.items():
        print(f"{kind}: {path.relative_to(ROOT)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
