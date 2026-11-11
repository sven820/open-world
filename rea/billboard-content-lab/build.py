# -*- coding: utf-8 -*-
"""把模板 + 离线依赖打包成可双击运行的单文件 HTML。

用法：python build.py
产物：PULSE_内容源实验台.html（file:// 直接打开即可，断网可用）
"""
import base64
import pathlib
import re

BASE = pathlib.Path(__file__).resolve().parent
OUT = BASE / "PULSE_内容源实验台.html"

three = (BASE / "vendor" / "three.module.js").read_text(encoding="utf-8")
bgu = (BASE / "vendor" / "BufferGeometryUtils.js").read_text(encoding="utf-8")
gltf = (BASE / "vendor" / "GLTFLoader.js").read_text(encoding="utf-8")
hls = (BASE / "vendor" / "hls.min.js").read_text(encoding="utf-8")
glb_b64 = base64.b64encode((BASE / "samples" / "demo_pulse.glb").read_bytes()).decode("ascii")
video_b64 = base64.b64encode((BASE / "samples" / "demo_loop.mp4").read_bytes()).decode("ascii")

# source map 注释在 file:// 下会产生无效请求，去掉
hls = re.sub(r"//# sourceMappingURL=.*", "", hls)

for name, src in (("three", three), ("bgu", bgu), ("gltf", gltf), ("hls", hls)):
    if "</script" in src.lower():
        raise RuntimeError("vendor/%s 含 </script，会截断 HTML" % name)

tpl = (BASE / "_template.html").read_text(encoding="utf-8")
html = (tpl
        .replace("__THREE_SRC__", three)
        .replace("__BGU_SRC__", bgu)
        .replace("__GLTF_SRC__", gltf)
        .replace("__HLS_SRC__", hls)
        .replace("__DEMO_GLB_B64__", glb_b64)
        .replace("__DEMO_VIDEO_B64__", video_b64))

# 只检查我们自己的占位符；three.js 源码里自带 __PURE__ / __THREE__ 等注解
left = [p for p in ("__THREE_SRC__", "__BGU_SRC__", "__GLTF_SRC__",
                    "__HLS_SRC__", "__DEMO_GLB_B64__", "__DEMO_VIDEO_B64__") if p in html]
if left:
    raise RuntimeError("未替换的占位符: %s" % left)

OUT.write_text(html, encoding="utf-8")

# 抽出主逻辑供 node --check 做语法体检
m = re.search(r'<script id="app">(.*?)</script>', html, re.S)
if not m:
    raise RuntimeError("找不到 app 脚本块")
(BASE / "_logic_check.js").write_text(m.group(1), encoding="utf-8")

print("output :", OUT.name)
print("bytes  :", OUT.stat().st_size)
print("inline : three %d / bgu %d / gltf %d / hls %d / glb %d / video %d chars"
      % (len(three), len(bgu), len(gltf), len(hls), len(glb_b64), len(video_b64)))
