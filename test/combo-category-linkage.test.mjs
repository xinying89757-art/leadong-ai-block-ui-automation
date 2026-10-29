import test from 'node:test';import assert from 'node:assert/strict';import{assertCategoryContent,categoryTarget}from'../src/combo-category-linkage.mjs';
const expected=[{id:'a',name:'测试内容1'},{id:'b',name:'测试内容2'}],before=[...expected,{id:'c',name:'其他分类内容'}];
test('分类核对要求完整集合相等，允许后台排序不同',()=>{assert.equal(assertCategoryContent([...expected].reverse(),expected,before).passed,true);});
test('混入其他分类、缺少内容和重复内容均失败',()=>{for(const actual of [[expected[0]],[...expected,before[2]],[expected[0],expected[0]]])assert.throws(()=>assertCategoryContent(actual,expected,before));});
test('相同标题却稳定ID不同、后台同名歧义或无可区分筛选均拒绝通过',()=>{assert.throws(()=>assertCategoryContent([{id:'wrong',name:'测试内容1'},expected[1]],expected,before),/ID/);assert.throws(()=>assertCategoryContent(expected,[expected[0],expected[0]],before),/歧义/);assert.throws(()=>assertCategoryContent(expected,expected,expected),/筛选变化/);});
test('分类URL只接受本站HTTP或HTTPS',()=>{assert.equal(categoryTarget('/1-gl.html','http://example.com').pathname,'/1-gl.html');assert.throws(()=>categoryTarget('https://other.test/','http://example.com'),/本站/);assert.throws(()=>categoryTarget('javascript:void(0)','http://example.com'));});
