import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/media.ts', import.meta.url), 'utf8');
const context = { exports: {} };
vm.createContext(context);
vm.runInContext(ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }), context);
const { applyGarment, buildPrompt } = context.exports;
const garment = (category, accessory) => ({ id: category, name: category, category, accessory, image: 'test.jpg' });

test('selecting a suit replaces separate clothes and retains the accessory', () => {
  const slots = { top: garment('top'), bottom: garment('bottom'), accessory: garment('accessory', '眼镜') };
  applyGarment(slots, garment('suit'));
  assert.deepEqual(Object.keys(slots).sort(), ['accessory', 'suit']);
  assert.equal(slots.accessory.accessory, '眼镜');
});
for (const category of ['top', 'bottom']) test(`${category} selection replaces a suit without removing the accessory`, () => {
  const slots = { suit: garment('suit'), accessory: garment('accessory', '帽子') };
  applyGarment(slots, garment(category));
  assert.equal(slots.suit, undefined);
  assert.equal(slots[category].category, category);
  assert.equal(slots.accessory.accessory, '帽子');
});
test('prompts preserve unselected clothing and permit both selected clothing categories', () => {
  assert.match(buildPrompt([garment('top')], '上衣参考'), /保留原有裤子或裙子/);
  assert.match(buildPrompt([garment('bottom')], '下装参考'), /保留原有上衣及外套/);
  const combination = buildPrompt([garment('top'), garment('bottom')], '两列参考');
  assert.match(combination, /下装按其独立参考图处理/);
  assert.match(combination, /上衣按其独立参考图处理/);
  assert.doesNotMatch(combination, /保留原有上衣及外套|保留原有裤子或裙子/);
});
test('suit and accessory prompts describe a complete outfit and the selected accessory only', () => {
  const prompt = buildPrompt([garment('suit'), garment('accessory', '眼镜')], '第一列套装，第二列眼镜');
  assert.match(prompt, /完整穿上.*整套上衣及下装/);
  assert.match(prompt, /连衣裙、连体衣/);
  assert.match(prompt, /眼镜佩戴到对应位置/);
  assert.match(prompt, /鞋袜及其他未选择的配饰/);
  assert.ok([...prompt].length <= 1024);
  assert.throws(() => buildPrompt([garment('suit'), garment('top')], ''), /不能.*同时试穿/);
});

test('top and accessory combination asks for both items in every frame', () => {
  const prompt = buildPrompt([garment('top'), garment('accessory', '帽子')], '第1列为上衣；第2列为配饰（帽子）');
  assert.match(prompt, /同时穿戴全部已选服饰（上衣、配饰：帽子）/);
  assert.match(prompt, /每个视频画面都保留这套组合，不能只替换其中一件/);
  assert.match(prompt, /保留原有裤子或裙子/);
  assert.ok([...prompt].length <= 1024);
});
