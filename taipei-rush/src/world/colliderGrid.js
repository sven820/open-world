// 城市碰撞网格：把矩形碰撞体按 24m 格子做空间哈希，
// 供玩家/行人推挤（resolve）、相机遮挡（blocked）与楼顶掠过抬升（topAt）查询。

export class ColliderGrid {
  constructor(cell = 24) {
    this.cell = cell;
    this.map = new Map();
  }
  key(ix, iz) { return ix * 73856093 ^ iz * 19349663; }
  // top：碰撞体顶面高度（米）。相机遮挡检测用它判断"从楼顶上方掠过"不算遮挡；
  // 不传时视为无限高。地面碰撞（resolve）不使用该值。
  add(x0, z0, x1, z1, top = Infinity) {
    const c = this.cell;
    const i0 = Math.floor(x0 / c), i1 = Math.floor(x1 / c);
    const j0 = Math.floor(z0 / c), j1 = Math.floor(z1 / c);
    const rec = [x0, z0, x1, z1, top];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = this.key(i, j);
      let arr = this.map.get(k);
      if (!arr) { arr = []; this.map.set(k, arr); }
      arr.push(rec);
    }
  }
  resolve(p, r) {
    const c = this.cell;
    const i0 = Math.floor((p.x - r) / c), i1 = Math.floor((p.x + r) / c);
    const j0 = Math.floor((p.z - r) / c), j1 = Math.floor((p.z + r) / c);
    const seen = new Set();
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const arr = this.map.get(this.key(i, j));
      if (!arr) continue;
      for (const b of arr) {
        if (seen.has(b)) continue;
        seen.add(b);
        const [x0, z0, x1, z1] = b;
        const nx = Math.max(x0, Math.min(p.x, x1));
        const nz = Math.max(z0, Math.min(p.z, z1));
        let dx = p.x - nx, dz = p.z - nz;
        const d2 = dx * dx + dz * dz;
        if (d2 < r * r) {
          if (d2 > 1e-6) {
            const d = Math.sqrt(d2);
            p.x = nx + (dx / d) * r;
            p.z = nz + (dz / d) * r;
          } else {
            // inside: push out on nearest face
            const pl = p.x - x0, pr = x1 - p.x, pt = p.z - z0, pb = z1 - p.z;
            const m = Math.min(pl, pr, pt, pb);
            if (m === pl) p.x = x0 - r;
            else if (m === pr) p.x = x1 + r;
            else if (m === pt) p.z = z0 - r;
            else p.z = z1 + r;
          }
        }
      }
    }
    return p;
  }
  // point-vs-building test (used for third-person camera collision)
  // y：查询点高度。高于该碰撞体顶面时不算遮挡（相机从楼顶上方掠过）。
  blocked(x, z, r, y = -Infinity) {
    const c = this.cell;
    const i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c);
    const j0 = Math.floor((z - r) / c), j1 = Math.floor((z + r) / c);
    // 复用去重数组：相机遮挡每帧会调用几十次，避免每次分配 Set
    const seen = this._seen || (this._seen = []);
    seen.length = 0;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const arr = this.map.get(this.key(i, j));
      if (!arr) continue;
      for (const b of arr) {
        if (seen.indexOf(b) !== -1) continue;
        seen.push(b);
        if (y > b[4]) continue;
        const [x0, z0, x1, z1] = b;
        if (x > x0 && x < x1 && z > z0 && z < z1) return true;
        const nx = Math.max(x0, Math.min(x, x1));
        const nz = Math.max(z0, Math.min(z, z1));
        const dx = x - nx, dz = z - nz;
        if (dx * dx + dz * dz < r * r) return true;
      }
    }
    return false;
  }

  // 该点（含半径 r）覆盖范围内最高的碰撞体顶面；没有则返回 0。
  // 相机平移进楼群时用它把镜头抬到楼顶上方（越过楼飞，而不是穿进去）。
  topAt(x, z, r) {
    const c = this.cell;
    const i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c);
    const j0 = Math.floor((z - r) / c), j1 = Math.floor((z + r) / c);
    const seen = this._seenTop || (this._seenTop = []);
    seen.length = 0;
    let top = 0;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const arr = this.map.get(this.key(i, j));
      if (!arr) continue;
      for (const b of arr) {
        if (seen.indexOf(b) !== -1) continue;
        seen.push(b);
        const t = b[4];
        if (!Number.isFinite(t) || t <= top) continue;
        const [x0, z0, x1, z1] = b;
        const nx = Math.max(x0, Math.min(x, x1));
        const nz = Math.max(z0, Math.min(z, z1));
        const dx = x - nx, dz = z - nz;
        if (dx * dx + dz * dz < r * r) top = t;
      }
    }
    return top;
  }
}
