/* ---------------- 大屏轮播调度 ----------------
 * schedule = [{ idx, duration } ...]，idx 指向内容池条目。
 * 屏幕远离玩家时暂停计时（画面定格在当前帧，零成本待机）。
 * 切换：硬切或经 fade 控制器做 shader 交叉淡入（不重建纹理，只改引用与 uniform）。
 */
export class Playlist {
  constructor(pool, schedule, onSwap, phase = 0, fade = null) {
    this.pool = pool;
    this.schedule = schedule;
    this.onSwap = onSwap;     // (texture) => void
    this.t = phase;           // 相位错开：各屏不同步翻页
    this.cur = 0;
    this.pending = false;
    this.fade = fade;         // { advance(dt) } | null
    this.focus = null;        // 观看者位置 {x,z}（3D 裸眼内容源用），每帧由管理器写入
    this.eye = null;          // 取景相机（3D 裸眼虚拟眼睛），每帧由管理器写入
  }

  /** 立即应用当前条目（构建时调用一次） */
  applyInitial() {
    const item = this.pool[this.schedule[this.cur].idx];
    if (item && item.update) item.update(0, 0, this.focus, this.eye);
    this.onSwap(item.texture);
  }

  update(dt, active) {
    if (!active) return;
    if (this.fade) this.fade.advance(dt);
    // 首次进入视野时把动画内容推进一帧再上屏，避免黑屏/过期帧
    if (this.pending) {
      const item = this.pool[this.schedule[this.cur].idx];
      if (item && item.update) item.update(0, 0, this.focus, this.eye);
      this.onSwap(item.texture);
      this.pending = false;
    }
    this.t += dt;
    const slot = this.schedule[this.cur];
    if (this.t >= slot.duration) {
      this.t -= slot.duration;
      this.cur = (this.cur + 1) % this.schedule.length;
      const next = this.pool[this.schedule[this.cur].idx];
      if (next && next.update) next.update(0, 0, this.focus, this.eye);
      this.onSwap(next.texture);
    }
  }

  /** 从远离切回近处：标记需要刷新当前帧 */
  wake() { this.pending = true; }
}
