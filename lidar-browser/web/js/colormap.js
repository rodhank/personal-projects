// 256-entry RGB lookup tables for depth visualisation.

function fromStops(stops) {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k], [t1, c1] = stops[k + 1];
    const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0 || 1)));
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(c0[c] + (c1[c] - c0[c]) * f);
  }
  return lut;
}

// Google "Turbo" polynomial approximation.
function turbo() {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    const r = 0.13572138 + x * (4.61539260 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))));
    const g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))));
    const b = 0.10667330 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))));
    lut[i * 3] = Math.max(0, Math.min(255, Math.round(r * 255)));
    lut[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
    lut[i * 3 + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
  }
  return lut;
}

export const COLORMAPS = {
  turbo: turbo(),
  inferno: fromStops([[0, [0, 0, 4]], [0.25, [87, 16, 110]], [0.5, [188, 55, 84]], [0.75, [249, 142, 9]], [1, [252, 255, 164]]]),
  viridis: fromStops([[0, [68, 1, 84]], [0.25, [59, 82, 139]], [0.5, [33, 145, 140]], [0.75, [94, 201, 98]], [1, [253, 231, 37]]]),
  gray: fromStops([[0, [255, 255, 255]], [1, [20, 20, 20]]]),
};

export const MESH_CLASS_COLORS = [
  [0.62, 0.62, 0.62], // none
  [0.30, 0.55, 0.95], // wall
  [0.35, 0.80, 0.35], // floor
  [0.95, 0.90, 0.35], // ceiling
  [0.95, 0.55, 0.20], // table
  [0.85, 0.30, 0.85], // seat
  [0.35, 0.90, 0.95], // window
  [0.90, 0.30, 0.30], // door
];
export const MESH_CLASS_NAMES = ['none', 'wall', 'floor', 'ceiling', 'table', 'seat', 'window', 'door'];

export const PLANE_COLORS = {
  wall: 0x4d8cf2, floor: 0x59cc59, ceiling: 0xf2e659, table: 0xf28c33,
  seat: 0xd94dd9, window: 0x59e6f2, door: 0xe64d4d, none: 0x9e9e9e,
};
