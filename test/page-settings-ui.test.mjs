import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { LeadongEditor } from '../src/editor.mjs';

test('页面设置只读当前可见弹窗，监听真实提交，回读请求和业务回执', async () => {
  let businessFail = false, requests = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/phoenix/page/setting') {
      requests += 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(businessFail ? { error: { message: 'failure' } } : { success: { pageTitle: 'New page', pageId: 'new-page-id' } }));
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<input id="wrong-title" value="Old page"><button onclick="window.wrong=true">确定</button>
      <div class="backstage-dialog" style="display:none"><strong>页面设置</strong><input name="page.pageTitle" value="Hidden page"></div>
      <div id="backstage-dialog-managePages" class="backstage-dialog"><strong>页面设置</strong>
      <input id="pageTitle" name="page.pageTitle"><input id="pageUrl" name="page.pageUrl">
      <a class="page_function_setting_submit" onclick="fetch('/phoenix/page/setting',{method:'POST',body:new URLSearchParams({'page.pageTitle':document.querySelector('#pageTitle').value,'page.pageUrl':document.querySelector('#pageUrl').value})})">确定</a></div>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const editor = new LeadongEditor(page, { selectors: { pageCreateResponseUrlIncludes: '/phoenix/page/setting' }, timeouts: { actionMs: 2000 } });
    const descriptor = { name: 'New page', path: '/new-page' };
    const modal = await editor.pageSettingsDialog();
    await editor.fillPageSettings(modal, descriptor);
    const receipt = await editor.submitPageSettings(modal, descriptor);
    assert.equal(receipt.id, 'new-page-id'); assert.equal(receipt.request_confirmed, true);
    assert.equal(await page.locator('#wrong-title').inputValue(), 'Old page');
    assert.equal(await page.evaluate(() => window.wrong), undefined);
    businessFail = true;
    await assert.rejects(editor.submitPageSettings(modal, descriptor), /业务失败/);
    assert.equal(requests, 2); // No automatic re-submit on business failure.
    await modal.locator('#pageTitle').fill('Wrong page');
    await assert.rejects(editor.submitPageSettings(modal, descriptor), /回读不一致/);
    assert.equal(requests, 2);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
