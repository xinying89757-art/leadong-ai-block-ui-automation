import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHttpsUpgradeHosts, httpsUpgradeHosts, upgradeHttpUrl, rewriteUpgradeLocation, previewFailureStatus } from '../src/network-https-upgrade.mjs';
test('HTTPS allowlist defaults off, parses commas, deduplicates and permits explicit empty override', () => {
  assert.deepEqual(httpsUpgradeHosts({}, {}), []);
  assert.deepEqual(parseHttpsUpgradeHosts(' a.example, B.example,a.example, '), ['a.example','b.example']);
  assert.deepEqual(httpsUpgradeHosts({network:{httpsUpgradeHosts:['a.example']}},{LEADONG_HTTPS_UPGRADE_HOSTS:''}), []);
  for (const value of ['https://a.example','*.example','a.example/path','a.example@b.example']) assert.throws(()=>parseHttpsUpgradeHosts(value));
});
test('only HTTP URLs on exact allowlisted hosts are upgraded; path/query/fragment survive', () => {
  assert.equal(upgradeHttpUrl('http://a.example/p?q=1#f',['a.example']),'https://a.example/p?q=1#f');
  for (const url of ['https://a.example/p','http://other.example/p','http://sub.a.example/p','/relative']) assert.equal(upgradeHttpUrl(url,['a.example']),url);
});
test('Location rewrite is case insensitive and preserves unrelated response headers and redirects', () => {
  assert.deepEqual(rewriteUpgradeLocation({Location:'http://a.example/p',other:'same'},['a.example']),{Location:'https://a.example/p',other:'same'});
  for (const location of ['/relative','http://other.example/p']) assert.equal(rewriteUpgradeLocation({location},['a.example']).location,location);
});
test('only HTTP connection/navigation timeouts are classified as environment blocks', () => {
  assert.equal(previewFailureStatus(new Error('net::ERR_CONNECTION_TIMED_OUT'),['https://a','http://a']),'blocked-environment');
  assert.equal(previewFailureStatus(new Error('Timeout 100ms exceeded'),['http://a']),'blocked-environment');
  assert.equal(previewFailureStatus(new Error('Preview missing heading'),['http://a']),'failed');
  assert.equal(previewFailureStatus(new Error('Timeout'),['https://a']),'failed');
});
test('context proxy preserves method, headers, binary post body, status/body and disables redirects', async () => {
  const {installHttpsUpgrade}=await import('../src/network-https-upgrade.mjs');
  let predicate, handler, fetched, fulfilled, disposed=false;
  const body=Buffer.from([0,1,255]);
  const response={status:()=>302,headers:()=>({location:'http://a.example/final','content-type':'application/octet-stream'}),body:async()=>body,dispose:async()=>{disposed=true;}};
  const context={route:async(p,h)=>{predicate=p;handler=h;},request:{fetch:async(url,options)=>{fetched={url,options};return response;}}};
  await installHttpsUpgrade(context,[]);assert.equal(handler,undefined);
  await installHttpsUpgrade(context,['a.example']);
  assert.equal(predicate(new URL('http://a.example/post')),true);
  assert.equal(predicate(new URL('http://b.example/post')),false);
  const headers={'content-type':'application/octet-stream','x-fixture':'value'};
  await handler({request:()=>({url:()=> 'http://a.example/post?q=1',method:()=> 'POST',allHeaders:async()=>headers,postDataBuffer:()=>body}),fulfill:async value=>{fulfilled=value;}});
  assert.equal(fetched.url,'https://a.example/post?q=1');
  assert.equal(fetched.options.method,'POST');assert.deepEqual(fetched.options.headers,headers);assert.equal(fetched.options.data,body);assert.equal(fetched.options.maxRedirects,0);
  assert.equal(fulfilled.status,302);assert.equal(fulfilled.headers.location,'https://a.example/final');assert.equal(fulfilled.body,body);assert.equal(disposed,true);
});
test('configuration host array and environment override resolve independently of process state', () => {
  assert.deepEqual(httpsUpgradeHosts({network:{httpsUpgradeHosts:['A.example','a.example']}},{}),['a.example']);
  assert.deepEqual(httpsUpgradeHosts({network:{httpsUpgradeHosts:['a.example']}},{LEADONG_HTTPS_UPGRADE_HOSTS:'b.example,c.example'}),['b.example','c.example']);
});
