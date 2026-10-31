import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createStore, seconds } from '../server/storage.mjs';

test('capture limits reject out-of-range and non-integer durations', () => {
  for (const value of [0, 2, 11, -5, 3.2, 'nope']) assert.throws(() => seconds(value), /3～10/);
  assert.equal(seconds('3'), 3); assert.equal(seconds(10), 10);
});
test('media lookup cannot escape the local output folder', async () => {
  const store = await createStore({ root: resolve('.local/storage-test'), ffmpeg: 'missing-ffmpeg-fixture', ffprobe: 'missing-ffprobe-fixture' });
  await assert.rejects(store.mediaPath('../.env'), /无效/);
  await assert.rejects(store.mediaPath('../../server.mjs'), /无效/);
  await assert.rejects(store.loadClip('../outside'), /无效/);
  assert.equal(store.transcode, false);
});
