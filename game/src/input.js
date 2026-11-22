// ============================================================================
// SOLMARA UNDERTOW — input.js
// Keyboard + mouse state with edge detection (pressed this frame), mouse
// position in canvas space, and click capture for shooting / UI buttons.
// ============================================================================

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();       // currently held (by e.code)
    this.pressedSet = new Set(); // pressed since last frame
    this.mouse = { x: 0, y: 0, down: false, clicked: false };

    window.addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
      if (!e.repeat) { this.keys.add(e.code); this.pressedSet.add(e.code); }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse.down = false; });

    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.mouse.x = (e.clientX - r.left) * (canvas.width / r.width);
      this.mouse.y = (e.clientY - r.top) * (canvas.height / r.height);
    });
    canvas.addEventListener('mousedown', () => {
      this.mouse.down = true;
      this.mouse.clicked = true;
    });
    window.addEventListener('mouseup', () => { this.mouse.down = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  down(...codes) { return codes.some((c) => this.keys.has(c)); }
  pressed(...codes) { return codes.some((c) => this.pressedSet.has(c)); }

  // Movement axis from WASD / arrows: {x:-1..1, y:-1..1}
  axis() {
    let x = 0, y = 0;
    if (this.down('KeyA', 'ArrowLeft')) x -= 1;
    if (this.down('KeyD', 'ArrowRight')) x += 1;
    if (this.down('KeyW', 'ArrowUp')) y -= 1;
    if (this.down('KeyS', 'ArrowDown')) y += 1;
    return { x, y };
  }

  // Call once at the end of each frame.
  postUpdate() {
    this.pressedSet.clear();
    this.mouse.clicked = false;
  }
}
