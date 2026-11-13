# -*- coding: utf-8 -*-
"""批量导出内容源实验台效果图，并顺带抓取页面错误框。

用法：python render_shots.py
"""
import pathlib
import re
import shutil
import subprocess

BASE = pathlib.Path(__file__).resolve().parent
SRC = BASE / "PULSE_内容源实验台.html"
TMP = BASE / "_verify.html"
DESIGN = BASE / "design"
DESIGN.mkdir(exist_ok=True)
shutil.copyfile(SRC, TMP)

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
ARGS = [
    "--headless=new", "--no-sandbox", "--disable-gpu-sandbox",
    "--disable-dev-shm-usage", "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader", "--hide-scrollbars",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1440,900", "--virtual-time-budget=6000",
]
URL = TMP.as_uri()

# (文件名, URL 参数)
SHOTS = [
    # 内容源实验台原有的一组
    ("01_demo_带界面",       "src=demo1",                             False),
    ("02_text_带界面",       "src=text&text=PULSE%0A%E4%BB%BB%E6%84%8F%E5%86%85%E5%AE%B9", False),
    ("03_text_离轴",         "src=text&clean=1",                      True),
    ("04_text_平贴退化",     "src=text&clean=1&flat=1",               True),
    ("05_image_离轴",        "src=image&clean=1",                     True),
    ("06_glb_离轴",          "src=glb&clean=1",                       True),
    ("07_glb_出屏加深",      "src=glb&clean=1&depth=6",               True),
    ("08_demo_俯瞰",         "src=demo1&clean=1&v=aerial",            True),
    ("09_glb_南侧偏角",      "src=glb&clean=1&v=south",               True),
    ("10_video_离轴",        "src=video&clean=1",                     True),
    ("11_hls_待连接",        "src=hls&clean=1",                       True),
    # 补回的旧版控制项 + 3D 演示 2
    ("12_demo2_带界面",      "src=demo2&time=8.2",                    False),
    ("13_demo2_破屏",        "src=demo2&clean=1&time=8.2",            True),
    ("14_demo2_汇聚",        "src=demo2&clean=1&time=1.2",            True),
    ("15_calib_校准片",      "src=calib&clean=1&time=3.0",            True),
    ("16_demo2_白天",        "src=demo2&clean=1&t=day&time=8.2",      True),
    ("17_demo2_黄昏",        "src=demo2&clean=1&t=dusk&time=8.2",     True),
    ("18_辅助线_俯瞰",       "src=demo1&clean=1&helper=1&az=-2.36&el=0.40&dist=95", True),
    ("19_demo2_西侧偏角",    "src=demo2&clean=1&v=west&time=8.2",     True),
    ("20_demo2_实时追踪",    "src=demo2&clean=1&v=south&track=1&time=8.2", True),
    ("21_demo2_平贴对照",    "src=demo2&clean=1&flat=1",              True),
    # 整屏平面：两面屏展开成一张 24 × 8 m 画布
    ("26_整屏平面_文字_带界面", "src=text&plane=1",                     False),
    ("27_整屏平面_文字_最佳视点", "src=text&plane=1&clean=1",           True),
    ("28_整屏平面_图片_偏角",   "src=image&plane=1&clean=1&az=-2.05&el=0.02&dist=36", True),
    ("29_整屏平面_图片_俯瞰",   "src=image&plane=1&clean=1&v=aerial",   True),
    ("30_整屏平面_视频",        "src=video&plane=1&clean=1",            True),
]

# 对最容易出运行时问题的几种源做 DOM 体检
for check in ("src=glb", "src=video", "src=hls", "src=demo2",
              "src=calib", "src=demo2&t=day&time=8.2",
              "src=text&plane=1", "src=image&plane=1&v=south"):
    dom = subprocess.run(
        [CHROME] + ARGS + ["--dump-dom", URL + "?" + check],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=180,
    ).stdout.decode("utf-8", "replace")
    m = re.search(r'<div id="err"[^>]*>(.*?)</div>', dom, re.S)
    err = (m.group(1).strip() if m else "(no #err element)")
    print("=== DOM ERROR CHECK (%s) ===" % check)
    print(err if err else "clean: no runtime errors")
    load = re.search(r'<div id="loading"[^>]*style="([^"]*)"', dom)
    print("loading:", load.group(1) if load else "not found")
print()

for name, query, _ in SHOTS:
    out = DESIGN / (name + ".png")
    subprocess.run(
        [CHROME] + ARGS + ["--screenshot=" + str(out), URL + "?" + query],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180,
    )
    print(name, out.stat().st_size if out.exists() else "FAILED", flush=True)
