import FFT from 'fft.js';

// Runs in the inference worker. fft.js is radix-2: extend the right/bottom
// edges to powers of two, solve globally, then crop. On power-of-two images
// this uses the same periodic boundary condition as denoise.py. Other sizes
// have a different boundary condition; this is not pixel-identical to NumPy.
export async function l0Smooth(rgb, width, height, lam, check = () => {}, onProgress = () => {}) {
  if (!Number.isFinite(lam) || lam < 0) throw new Error('Invalid L0 strength');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || rgb.length !== width * height * 3) throw new Error('Invalid RGB image');
  if (lam === 0) return rgb.slice();
  const w = 2 ** Math.ceil(Math.log2(Math.max(2, width)));
  const h = 2 ** Math.ceil(Math.log2(Math.max(2, height)));
  const n = w * h;
  const fx = new FFT(w), fy = new FFT(h);
  const row = new Float64Array(w * 2), rowOut = new Float64Array(w * 2);
  const col = new Float64Array(h * 2), colOut = new Float64Array(h * 2);
  function transform(a, inverse = false) {
    for (let y = 0; y < h; y++) {
      row.set(a.subarray(y * w * 2, (y + 1) * w * 2));
      if (inverse) fx.inverseTransform(rowOut, row); else fx.transform(rowOut, row);
      a.set(rowOut, y * w * 2);
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) { col[y * 2] = a[(y * w + x) * 2]; col[y * 2 + 1] = a[(y * w + x) * 2 + 1]; }
      if (inverse) fy.inverseTransform(colOut, col); else fy.transform(colOut, col);
      for (let y = 0; y < h; y++) { a[(y * w + x) * 2] = colOut[y * 2]; a[(y * w + x) * 2 + 1] = colOut[y * 2 + 1]; }
    }
  }
  const s = Array.from({ length: 3 }, () => new Float32Array(n));
  const original = Array.from({ length: 3 }, () => new Float64Array(n * 2));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const src = (Math.min(y, height - 1) * width + Math.min(x, width - 1)) * 3;
    for (let c = 0; c < 3; c++) original[c][(y * w + x) * 2] = s[c][y * w + x] = rgb[src + c];
  }
  for (const a of original) transform(a);
  const otf = new Float64Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) otf[y * w + x] = 4 - 2 * Math.cos(2 * Math.PI * x / w) - 2 * Math.cos(2 * Math.PI * y / h);
  const dx = Array.from({ length: 3 }, () => new Float32Array(n));
  const dy = Array.from({ length: 3 }, () => new Float32Array(n));
  const work = new Float64Array(n * 2);
  const iterations = Math.max(0, Math.ceil(Math.log2(1e5 / (2 * lam))));
  let iteration = 0;
  for (let beta = 2 * lam; beta < 1e5; beta *= 2) {
    check();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, right = y * w + ((x + 1) % w), below = ((y + 1) % h) * w + x;
      let energy = 0;
      for (let c = 0; c < 3; c++) {
        const a = s[c][right] - s[c][i], b = s[c][below] - s[c][i];
        dx[c][i] = a; dy[c][i] = b; energy += a * a + b * b;
      }
      if (energy < lam / beta) for (let c = 0; c < 3; c++) dx[c][i] = dy[c][i] = 0;
    }
    for (let c = 0; c < 3; c++) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        work[i * 2] = dx[c][y * w + ((x + w - 1) % w)] - dx[c][i] + dy[c][((y + h - 1) % h) * w + x] - dy[c][i];
        work[i * 2 + 1] = 0;
      }
      transform(work);
      for (let i = 0; i < n; i++) {
        const den = 1 + beta * otf[i];
        work[i * 2] = (original[c][i * 2] + beta * work[i * 2]) / den;
        work[i * 2 + 1] = (original[c][i * 2 + 1] + beta * work[i * 2 + 1]) / den;
      }
      transform(work, true);
      for (let i = 0; i < n; i++) s[c][i] = work[i * 2];
    }
    onProgress(++iteration / iterations);
    // Allow worker cancellation messages to be delivered between iterations.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  check();
  const result = new Float32Array(rgb.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) result[(y * width + x) * 3 + c] = Math.max(0, Math.min(1, s[c][y * w + x]));
  return result;
}
