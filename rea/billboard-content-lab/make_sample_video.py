# -*- coding: utf-8 -*-
"""生成 2 秒循环示例视频（需 Pillow + ffmpeg），供「视频」内容源离线演示。

用法：py -3 make_sample_video.py
产物：samples/demo_loop.mp4（会被 build.py 以 base64 内联进单文件 HTML）

PNG 帧通过管道直接喂给 ffmpeg，不产生任何临时文件。
"""
import io
import math
import pathlib
import subprocess

from PIL import Image, ImageDraw, ImageFont

BASE = pathlib.Path(__file__).resolve().parent
OUT = BASE / "samples" / "demo_loop.mp4"
W, H, N, FPS = 512, 288, 50, 25


def mix(c1, c2, t):
    return tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))


try:
    font = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 58)
except OSError:
    font = ImageFont.load_default()

OUT.parent.mkdir(exist_ok=True)
cmd = [
    "ffmpeg", "-y", "-loglevel", "error",
    "-f", "image2pipe", "-c:v", "png", "-framerate", str(FPS), "-i", "pipe:0",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "30",
    "-movflags", "+faststart", "-t", "2", str(OUT),
]
proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)

for i in range(N):
    t = i / N
    im = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(im)
    for y in range(H):
        d.line([(0, y), (W, y)], fill=mix((4, 18, 30), (29, 11, 51), y / H))
    for x in range(0, W, 32):
        d.line([(x, 0), (x, H)], fill=(12, 46, 66))
    for y in range(0, H, 32):
        d.line([(0, y), (W, y)], fill=(12, 46, 66))
    for color, phase in (((53, 232, 255), 0.0), ((255, 61, 154), 2.1), ((127, 176, 255), 4.2)):
        a = t * math.tau + phase
        rx = 120 + 34 * math.sin(a)
        ry = 76 + 18 * math.cos(a)
        d.ellipse([W / 2 - rx, H / 2 - ry, W / 2 + rx, H / 2 + ry], outline=color, width=3)
    ang = t * math.tau
    px, py = W / 2 + 150 * math.cos(ang), H / 2 + 92 * math.sin(ang)
    d.ellipse([px - 9, py - 9, px + 9, py + 9], fill=(234, 252, 255))
    d.text((W / 2, H / 2), "PULSE", font=font, anchor="mm", fill=(234, 252, 255))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    proc.stdin.write(buf.getvalue())

proc.stdin.close()
if proc.wait() != 0:
    raise RuntimeError("ffmpeg 编码失败")
print("wrote", OUT, OUT.stat().st_size, "bytes")
