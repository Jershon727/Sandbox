/**
 * Canvas confetti, shaped like little playing cards and coloured from the
 * number-card palette so the celebration matches the game it belongs to.
 */

const CARD_COLORS = [
  '#4dd0e1',
  '#45b8ff',
  '#7b8cff',
  '#a97bff',
  '#e072f5',
  '#ff6fae',
  '#ff5a5a',
  '#ff8a3d',
  '#ffbe33',
  '#d3dc45',
  '#66d97a',
  '#2ed6ad',
  '#ffca47',
];

let canvas;
let ctx;
let bits = [];
let raf = 0;
let allowed = true;

export function initFx(el) {
  canvas = el;
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
}

export function setFxEnabled(on) {
  allowed = !!on;
  if (!allowed) stop();
}

function resize() {
  if (!canvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function stop() {
  cancelAnimationFrame(raf);
  raf = 0;
  bits = [];
  if (ctx) ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
}

function spawn(x, y, count, power) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = power * (0.35 + Math.random() * 0.9);
    bits.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - power * 0.55,
      w: 7 + Math.random() * 7,
      h: 10 + Math.random() * 10,
      spin: (Math.random() - 0.5) * 0.3,
      rot: Math.random() * Math.PI,
      color: CARD_COLORS[(Math.random() * CARD_COLORS.length) | 0],
      life: 1,
      drag: 0.985 + Math.random() * 0.01,
    });
  }
}

function frame() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.clearRect(0, 0, w, h);

  for (const b of bits) {
    b.vy += 0.38;
    b.vx *= b.drag;
    b.vy *= 0.995;
    b.x += b.vx;
    b.y += b.vy;
    b.rot += b.spin;
    if (b.y > h + 40) b.life = 0;

    if (b.life > 0) {
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.fillStyle = b.color;
      // A squashed card silhouette reads better than a plain square.
      const r = 2.5;
      const x = -b.w / 2;
      const y = -b.h / 2;
      ctx.beginPath();
      ctx.roundRect(x, y, b.w, b.h, r);
      ctx.fill();
      ctx.restore();
    }
  }

  bits = bits.filter((b) => b.life > 0);
  if (bits.length) raf = requestAnimationFrame(frame);
  else stop();
}

function run() {
  if (!raf) raf = requestAnimationFrame(frame);
}

/** A burst centred on an element — used when a hand hits Flip 7. */
export function burstFrom(el, { count = 46, power = 13 } = {}) {
  if (!allowed || !ctx) return;
  const box = el?.getBoundingClientRect?.();
  const x = box ? box.left + box.width / 2 : window.innerWidth / 2;
  const y = box ? box.top + box.height / 2 : window.innerHeight / 2;
  spawn(x, y, count, power);
  run();
}

/** The full-screen shower for winning the game. */
export function celebrate({ count = 130 } = {}) {
  if (!allowed || !ctx) return;
  const w = window.innerWidth;
  for (let i = 0; i < 3; i++) {
    spawn(w * (0.2 + i * 0.3), window.innerHeight * 0.34, Math.round(count / 3), 15);
  }
  run();
}
