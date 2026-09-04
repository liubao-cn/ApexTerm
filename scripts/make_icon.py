"""生成应用图标（1024×1024 PNG），之后用 `pnpm tauri icon app-icon.png` 派生全部尺寸。

设计（ApexTerm）：macOS 风格圆角方块，深蓝渐变底；主形是一个粗线条的 Λ（Apex：顶点 / 山峰），
一枚发光的绿色终端光标作为字母 A 的横杠——Apex 的首字母 + 终端。

用法：
    python3 scripts/make_icon.py                 # 写到 app-icon.png（默认变体 B）
    python3 scripts/make_icon.py --variant a     # 备选变体 A：光标在 Λ 右下 "Λ_"
    python3 scripts/make_icon.py --out /tmp/x.png
"""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

S = 1024  # 画布
SS = 4  # 超采样倍数，抗锯齿
W = S * SS

BLUE = (91, 141, 239)
BLUE_LIGHT = (128, 176, 255)
GREEN = (61, 190, 122)
GREEN_LIGHT = (110, 226, 160)


def rounded_mask(size: int) -> Image.Image:
    """圆角方块蒙版，四周留 ~9% 透明边距（macOS 图标规范）"""
    margin = int(size * 0.09)
    radius = int(size * 0.225)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((margin, margin, size - margin, size - margin), radius=radius, fill=255)
    return mask


def rounded_gradient_bg(size: int) -> Image.Image:
    """圆角方块 + 对角渐变，四周留 ~9% 透明边距（macOS 图标规范）"""
    margin = int(size * 0.09)
    radius = int(size * 0.225)
    box = (margin, margin, size - margin, size - margin)

    grad = Image.new("RGBA", (size, size))
    top = (36, 44, 92)  # 左上 偏亮的靛蓝
    bottom = (12, 14, 28)  # 右下 接近黑的深蓝
    px = grad.load()
    for y in range(size):
        t = y / (size - 1)
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        for x in range(size):
            # 稍微向右下再压暗一点，形成对角光感
            k = min(1.0, max(0.0, (x / size) * 0.35))
            px[x, y] = (int(r * (1 - k * 0.35)), int(g * (1 - k * 0.35)), int(b * (1 - k * 0.2)), 255)

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=radius, fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)

    # 顶部高光：淡淡一层白，从上往下消失
    hl = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    hp = hl.load()
    for y in range(margin, size // 2):
        a = int(38 * (1 - (y - margin) / (size // 2 - margin)) ** 2)
        for x in range(size):
            hp[x, y] = (255, 255, 255, a)
    hl_masked = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    hl_masked.paste(hl, (0, 0), mask)
    out = Image.alpha_composite(out, hl_masked)

    # 1px 内描边，让边缘在浅色桌面上也清晰
    stroke = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(stroke).rounded_rectangle(box, radius=radius, outline=(255, 255, 255, 40), width=max(1, size // 512))
    return Image.alpha_composite(out, stroke)


def vertical_gradient(size: int, top: tuple, bottom: tuple, y0: float, y1: float) -> Image.Image:
    """整张画布的竖向渐变，y0..y1 之间从 top 过渡到 bottom"""
    img = Image.new("RGBA", (size, size))
    px = img.load()
    span = max(1.0, y1 - y0)
    for y in range(size):
        t = min(1.0, max(0.0, (y - y0) / span))
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
        for x in range(size):
            px[x, y] = c
    return img


def stroke_polyline(size: int, pts: list, width: float) -> Image.Image:
    """圆头圆角的粗折线，画成 L 蒙版"""
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.line(pts, fill=255, width=int(width), joint="curve")
    for p in pts:
        d.ellipse((p[0] - width / 2, p[1] - width / 2, p[0] + width / 2, p[1] + width / 2), fill=255)
    return m


def glow(img: Image.Image, mask: Image.Image, color: tuple, radius: float, alpha: int) -> None:
    layer = Image.new("RGBA", img.size, color + (0,))
    a = mask.filter(ImageFilter.GaussianBlur(radius)).point(lambda v: min(255, int(v * alpha / 255)))
    layer.putalpha(a)
    img.alpha_composite(layer)


def draw_apex(img: Image.Image, size: int, variant: str) -> None:
    t = size * 0.10  # 线宽
    h = size * 0.42
    top_y = size * 0.27
    base_y = top_y + h
    if variant == "b":
        # 变体 B：Λ 居中
        w = size * 0.54
        cx = size / 2
    else:
        # 变体 A：Λ + 右侧光标作为一个整体居中，光标不能越出圆角方块
        w = size * 0.46
        cur_w = size * 0.13
        gap = t * 0.75
        group_w = w + gap + cur_w
        cx = (size - group_w) / 2 + w / 2
    apex = (cx, top_y)
    left = (cx - w / 2, base_y)
    right = (cx + w / 2, base_y)

    # 投影
    shadow = stroke_polyline(size, [left, apex, right], t)
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    sh.paste((0, 0, 0, 150), (0, int(size * 0.02)), shadow)
    sh = sh.filter(ImageFilter.GaussianBlur(size * 0.014))
    img.alpha_composite(sh)

    # Λ 主体：顶点亮、底部深的蓝色渐变
    body = stroke_polyline(size, [left, apex, right], t)
    grad = vertical_gradient(size, BLUE_LIGHT, BLUE, top_y, base_y)
    grad.putalpha(body)
    img.alpha_composite(grad)

    # 顶点一点高光
    hl = Image.new("L", (size, size), 0)
    ImageDraw.Draw(hl).ellipse((cx - t * 0.32, top_y - t * 0.32, cx + t * 0.32, top_y + t * 0.32), fill=255)
    hl = hl.filter(ImageFilter.GaussianBlur(t * 0.25))
    hl_layer = Image.new("RGBA", img.size, (255, 255, 255, 0))
    hl_layer.putalpha(hl.point(lambda v: int(v * 0.55)))
    img.alpha_composite(hl_layer)

    if variant == "b":
        # 变体 B：光标作为 A 的横杠——一段绿色圆角短杠，居中偏下
        bar_y = top_y + h * 0.66
        bar_w = w * 0.30
        bar_h = t * 0.62
        bar = Image.new("L", (size, size), 0)
        ImageDraw.Draw(bar).rounded_rectangle(
            (cx - bar_w / 2, bar_y - bar_h / 2, cx + bar_w / 2, bar_y + bar_h / 2), radius=bar_h / 2, fill=255
        )
        glow(img, bar, GREEN, t * 0.9, 150)
        layer = Image.new("RGBA", img.size, GREEN_LIGHT + (255,))
        layer.putalpha(bar)
        img.alpha_composite(layer)
    else:
        # 变体 A：Λ 右脚外侧一枚下划线光标 "Λ_"
        cur_h = t * 0.55
        x0 = right[0] + gap
        y0 = base_y - cur_h / 2 + t * 0.12
        cur = Image.new("L", (size, size), 0)
        ImageDraw.Draw(cur).rounded_rectangle((x0, y0, x0 + cur_w, y0 + cur_h), radius=cur_h / 2, fill=255)
        glow(img, cur, GREEN, t * 0.9, 150)
        layer = Image.new("RGBA", img.size, GREEN_LIGHT + (255,))
        layer.putalpha(cur)
        img.alpha_composite(layer)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", choices=["a", "b"], default="b")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    img = rounded_gradient_bg(W)
    # 前景单独画在透明层上，再用圆角蒙版裁掉溢出的光晕
    fg = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    draw_apex(fg, W, args.variant)
    clipped = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    clipped.paste(fg, (0, 0), rounded_mask(W))
    img = Image.alpha_composite(img, clipped)
    img = img.resize((S, S), Image.LANCZOS)
    out = Path(args.out) if args.out else Path(__file__).resolve().parent.parent / "app-icon.png"
    img.save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
