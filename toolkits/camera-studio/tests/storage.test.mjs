import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
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
test('material edits persist for built-in and custom materials and can be reset', async () => {
  const root = resolve('.local/storage-edit-test'); await rm(root, { recursive: true, force: true });
  const store = await createStore({ root, ffmpeg: 'missing-ffmpeg-fixture', ffprobe: 'missing-ffprobe-fixture' });
  const png = Buffer.alloc(200, 1);
  // 预置素材：只覆盖名称、提示词和图片，id 必须合法。
  await assert.rejects(store.editBuiltin('../x', { name: 'a', prompt: 'b' }, Buffer.alloc(0), ''), /无效素材编号/);
  await assert.rejects(store.editBuiltin('hat', { name: '', prompt: 'b' }, Buffer.alloc(0), ''), /名称/);
  await assert.rejects(store.editBuiltin('hat', { name: 'a', prompt: 'x'.repeat(1025) }, Buffer.alloc(0), ''), /1024/);
  await assert.rejects(store.editBuiltin('hat', { name: 'a', prompt: 'b' }, png, 'image/gif'), /PNG/);
  await store.editBuiltin('hat', { name: '新帽子', prompt: '戴上帽子' }, Buffer.alloc(0), '');
  assert.deepEqual(await store.edits(), { hat: { name: '新帽子', prompt: '戴上帽子' } });
  await store.editBuiltin('hat', { name: '新帽子', prompt: '戴上帽子2' }, png, 'image/png');
  const edit = (await store.edits()).hat; assert.equal(edit.prompt, '戴上帽子2'); assert.match(edit.image, /^\/media\/material-edits\/hat\/image-\d+\.png$/);
  assert.ok((await store.mediaPath(edit.image.slice(7))).size === 200);
  await store.resetBuiltin('hat'); assert.deepEqual(await store.edits(), {});
  // 自定义素材：原地修改，换图后旧图删除。
  const material = await store.saveMaterial(png, 'image/png', { name: '旧名', category: '场景', prompt: '旧提示词' });
  const changed = await store.editCustom(material.id, { name: '新名', prompt: '新提示词' }, png, 'image/jpeg');
  assert.equal(changed.name, '新名'); assert.equal(changed.prompt, '新提示词'); assert.equal(changed.category, '场景'); assert.match(changed.image, /\.jpg$/);
  assert.equal((await store.materials()).length, 1);
  await assert.rejects(store.editCustom('not-an-id', { name: 'a', prompt: 'b' }, Buffer.alloc(0), ''), /无效素材编号/);
});
