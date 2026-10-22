export class Input {
  constructor(domElement) {
    this.el = domElement;
    this.downKeys = new Set();
    this.pressedSet = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.panDX = 0;
    this.panDY = 0;
    this.wheelDX = 0;
    this.wheelDY = 0;
    this.locked = false;
    this.dragLook = false;   // true while a mouse button is held → drag-to-look
    this._dragBtn = -1;
    this.onLockChange = null;
    this._onKeyDown = (e) => {
      if (e.repeat) return;
      this.downKeys.add(e.code);
      this.pressedSet.add(e.code);
      // Layout-robust fallback: on some (non-QWERTY) layouts the letter printed
      // on the key maps to a different e.code. Also register the produced letter,
      // so pressing "D" always works regardless of physical key position.
      const ch = e.key && e.key.length === 1 ? e.key.toUpperCase() : "";
      if (ch >= "A" && ch <= "Z") { this.downKeys.add("Key" + ch); this.pressedSet.add("Key" + ch); }
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
    };
    this._onKeyUp = (e) => {
      this.downKeys.delete(e.code);
      const ch = e.key && e.key.length === 1 ? e.key.toUpperCase() : "";
      if (ch >= "A" && ch <= "Z") this.downKeys.delete("Key" + ch);
    };
    this._onMouseMove = (e) => {
      const mx = e.movementX || 0, my = e.movementY || 0;
      if (this.locked) {
        // pointer-locked free look → rotate
        this.mouseDX += mx; this.mouseDY += my;
      } else if (this.dragLook) {
        if (this._dragBtn === 2) {
          // right button drag → rotate the view
          this.mouseDX += mx; this.mouseDY += my;
        } else {
          // left button drag → pan / move the map view
          this.panDX += mx; this.panDY += my;
        }
      }
    };
    this._onMouseDown = (e) => {
      // left (0) or right (2) button held → drag to look around the world
      if (e.button === 0 || e.button === 2) {
        this.dragLook = true;
        this._dragBtn = e.button;
      }
    };
    this._onMouseUp = (e) => {
      if (e.button === this._dragBtn) {
        this.dragLook = false;
        this._dragBtn = -1;
      }
    };
    this._onWheel = (e) => {
      // trackpad two/three-finger swipe → wheel; use for look rotation
      this.wheelDX += e.deltaX;
      this.wheelDY += e.deltaY;
      e.preventDefault();
    };
    this._onLock = () => {
      this.locked = document.pointerLockElement === this.el;
      if (this.onLockChange) this.onLockChange(this.locked);
    };
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    window.addEventListener("mousemove", this._onMouseMove);
    window.addEventListener("mousedown", this._onMouseDown);
    window.addEventListener("mouseup", this._onMouseUp);
    window.addEventListener("wheel", this._onWheel, { passive: false });
    window.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("pointerlockchange", this._onLock);
  }

  down(code) { return this.downKeys.has(code); }
  pressed(code) { return this.pressedSet.has(code); }
  requestLock() { this.el.requestPointerLock?.(); }
  exitLock() { document.exitPointerLock?.(); }

  // clear frame-local pressed flags
  update() {
    this.pressedSet.clear();
    this.wheelDX = 0;
    this.wheelDY = 0;
    this.panDX = 0;
    this.panDY = 0;
  }
}
