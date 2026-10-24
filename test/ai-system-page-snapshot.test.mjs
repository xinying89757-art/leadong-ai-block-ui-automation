import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSystemPageRestored, categorySystemPageFor } from '../src/ai-system-page-snapshot.mjs';

test('system page restoration requires identical block IDs and order', () => {
  const before = [{ id: 'a', index: 0 }, { id: 'b', index: 1 }];
  assert.equal(assertSystemPageRestored(before, structuredClone(before)), true);
  assert.throws(() => assertSystemPageRestored(before, [{ id: 'b', index: 0 }, { id: 'a', index: 1 }]), /未恢复/);
  assert.throws(() => assertSystemPageRestored(before, [{ id: 'a', index: 0 }]), /未恢复/);
});

test('mixed category combo routes to the first category system page', () => {
  const mapping = { '产品分类': 'Products', '文章分类': 'News' };
  assert.deepEqual(categorySystemPageFor(['产品列表', '产品分类', '文章分类'], mapping), { category: '产品分类', systemPage: 'Products' });
  assert.deepEqual(categorySystemPageFor(['文章分类', '产品分类'], mapping), { category: '文章分类', systemPage: 'News' });
  assert.throws(() => categorySystemPageFor(['产品列表'], mapping), /必须包含/);
});
