import test from 'node:test';
import assert from 'node:assert/strict';
import { l0Smooth } from './l0.js';

test('zero strength returns an independent exact copy', async () => {
  const input = new Float32Array([0.1, 0.2, 0.3]);
  const out = await l0Smooth(input, 1, 1, 0);
  assert.deepEqual(out, input); assert.notEqual(out, input);
});
test('flat colour survives FFT smoothing including non-power-of-two sizes', async () => {
  const input = new Float32Array(7 * 5 * 3);
  for (let i = 0; i < input.length; i++) input[i] = [0.2, 0.5, 0.8][i % 3];
  const out = await l0Smooth(input, 7, 5, 0.001);
  assert.ok(out.every((v, i) => Math.abs(v - input[i]) < 1e-6));
});
test('small checkerboard ripples flatten while preserving mean', async () => {
  const input = new Float32Array(8 * 8 * 3);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) for (let c = 0; c < 3; c++) input[(y * 8 + x) * 3 + c] = 0.5 + ((x + y) % 2 ? 0.01 : -0.01);
  const out = await l0Smooth(input, 8, 8, 0.001);
  assert.ok(out.every(v => Math.abs(v - 0.5) < 0.001));
});
test('cancellation propagates', async () => {
  await assert.rejects(l0Smooth(new Float32Array(12), 2, 2, 0.001, () => { throw new Error('cancelled'); }), /cancelled/);
});
