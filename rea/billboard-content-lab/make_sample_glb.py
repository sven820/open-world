# -*- coding: utf-8 -*-
"""生成一个轻量的无压缩 GLB，作为内容源实验台的内置 3D 示例素材。

纯标准库实现：13 个彩色立方体组成环形装置，带 POSITION / NORMAL / COLOR_0。
不依赖 Draco / KTX2，GLTFLoader 可直接 parse。
"""
import base64
import colorsys
import json
import math
import pathlib
import struct

OUT = pathlib.Path(__file__).resolve().parent / "samples" / "demo_pulse.glb"

# 立方体 6 个面，每面 4 个顶点（逆时针朝外）+ 面法线
FACES = [
    ([(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)], (0, 0, 1)),
    ([(1, -1, -1), (-1, -1, -1), (-1, 1, -1), (1, 1, -1)], (0, 0, -1)),
    ([(-1, 1, 1), (1, 1, 1), (1, 1, -1), (-1, 1, -1)], (0, 1, 0)),
    ([(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)], (0, -1, 0)),
    ([(1, -1, 1), (1, -1, -1), (1, 1, -1), (1, 1, 1)], (1, 0, 0)),
    ([(-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)], (-1, 0, 0)),
]

positions, normals, colors, indices = [], [], [], []


def hsv_rgb(h, s, v):
    return colorsys.hsv_to_rgb(h, s, v)


def add_box(cx, cy, cz, size, rgb, tilt):
    base = len(positions)
    ct, st = math.cos(tilt), math.sin(tilt)
    for verts, normal in FACES:
        nx = normal[0] * ct - normal[1] * st
        ny = normal[0] * st + normal[1] * ct
        nz = normal[2]
        for vx, vy, vz in verts:
            x, y, z = vx * size, vy * size, vz * size
            # 先绕 Z 轴倾斜，再平移；法线同步旋转，保证光照方向正确
            rx, ry = x * ct - y * st, x * st + y * ct
            positions.append((cx + rx, cy + ry, cz + z))
            normals.append((nx, ny, nz))
            colors.append(rgb)
        indices.extend([base, base + 1, base + 2, base, base + 2, base + 3])
        base += 4


# 环所在平面正对英雄视点：法线 N，平面内水平轴 U，竖直轴 V
N = (-0.7071068, 0.0, -0.7071068)
U = (0.7071068, 0.0, -0.7071068)
V = (0.0, 1.0, 0.0)

# 中心主体
add_box(0, 0, 0, 1.15, hsv_rgb(0.52, 0.90, 0.85), 0.35)
# 环形阵列：沿法线加 0.9 m 前后起伏，避免看起来像一张平面贴纸
for i in range(12):
    a = i / 12 * math.tau
    r = 3.1
    d = 0.9 * math.sin(2 * a)
    px = U[0] * r * math.cos(a) + N[0] * d
    py = V[1] * r * math.sin(a)
    pz = U[2] * r * math.cos(a) + N[2] * d
    add_box(px, py, pz, 0.48, hsv_rgb(0.47 + i / 12 * 0.42, 0.85, 0.95), a)


def pack_floats(seq):
    return b"".join(struct.pack("<fff", *v) for v in seq)


def pack_indices(seq):
    return b"".join(struct.pack("<H", v) for v in seq)


blob_pos = pack_floats(positions)
blob_nrm = pack_floats(normals)
blob_col = pack_floats(colors)
blob_idx = pack_indices(indices)
chunks = [blob_pos, blob_nrm, blob_col, blob_idx]

# 每个 bufferView 按 4 字节对齐
bin_data = bytearray()
offsets = []
for blob in chunks:
    while len(bin_data) % 4:
        bin_data.append(0)
    offsets.append(len(bin_data))
    bin_data.extend(blob)
while len(bin_data) % 4:
    bin_data.append(0)
bin_data = bytes(bin_data)

mins = [min(p[i] for p in positions) for i in range(3)]
maxs = [max(p[i] for p in positions) for i in range(3)]

gltf = {
    "asset": {"version": "2.0", "generator": "PULSE content lab sample"},
    "scene": 0,
    "scenes": [{"nodes": [0]}],
    "nodes": [{"mesh": 0, "name": "PULSE_ring"}],
    "meshes": [{
        "name": "ring",
        "primitives": [{
            "attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2},
            "indices": 3,
            "material": 0,
            "mode": 4,
        }],
    }],
    "materials": [{
        "name": "vertex_color",
        "pbrMetallicRoughness": {
            "baseColorFactor": [1, 1, 1, 1],
            "metallicFactor": 0.15,
            "roughnessFactor": 0.42,
        },
        "doubleSided": True,
    }],
    "accessors": [
        {"bufferView": 0, "componentType": 5126, "count": len(positions),
         "type": "VEC3", "min": mins, "max": maxs},
        {"bufferView": 1, "componentType": 5126, "count": len(normals), "type": "VEC3"},
        {"bufferView": 2, "componentType": 5126, "count": len(colors), "type": "VEC3"},
        {"bufferView": 3, "componentType": 5123, "count": len(indices), "type": "SCALAR"},
    ],
    "bufferViews": [
        {"buffer": 0, "byteOffset": offsets[0], "byteLength": len(blob_pos), "target": 34962},
        {"buffer": 0, "byteOffset": offsets[1], "byteLength": len(blob_nrm), "target": 34962},
        {"buffer": 0, "byteOffset": offsets[2], "byteLength": len(blob_col), "target": 34962},
        {"buffer": 0, "byteOffset": offsets[3], "byteLength": len(blob_idx), "target": 34963},
    ],
    "buffers": [{"byteLength": len(bin_data)}],
}

json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
while len(json_bytes) % 4:
    json_bytes += b" "

total = 12 + 8 + len(json_bytes) + 8 + len(bin_data)
glb = (struct.pack("<III", 0x46546C67, 2, total)
       + struct.pack("<II", len(json_bytes), 0x4E4F534A) + json_bytes
       + struct.pack("<II", len(bin_data), 0x004E4942) + bin_data)

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_bytes(glb)
print("wrote", OUT, len(glb), "bytes")
print("base64 chars", len(base64.b64encode(glb)))
print("vertices", len(positions), "indices", len(indices))
