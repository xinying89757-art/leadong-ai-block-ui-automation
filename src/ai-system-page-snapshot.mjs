export async function snapshotSystemPageBlocks(frames) {
  let best = null;
  for (const frame of frames) {
    const area = frame.locator('#backstage-bodyArea').first();
    if (!await area.count().catch(() => 0)) continue;
    const result = await area.evaluate(root => {
      const selectors = ['.backstage-blocksEditor-wrap', '.siteblocks-setting-wrap', '.phoenix2-block-wrap', '.block-container'];
      const found = [...root.querySelectorAll(selectors.join(','))].filter(node => node.getClientRects().length > 0);
      const top = found.filter(node => !node.parentElement?.closest(selectors.join(',')));
      const blocks = top.map((node, index) => ({
        id: node.id || node.getAttribute('data-px2-page-id') || node.getAttribute('data-id') || '',
        classes: typeof node.className === 'string' ? node.className : '', index,
      }));
      return { blocks, complete: blocks.every(block => Boolean(block.id)) };
    }).catch(() => null);
    if (result && (!best || result.blocks.length > best.blocks.length)) best = result;
  }
  if (!best) throw new Error('无法读取系统页面画布区块快照');
  if (!best.complete) throw new Error('系统页面存在缺少稳定 ID 的区块，拒绝变更');
  const ids = best.blocks.map(block => block.id);
  if (new Set(ids).size !== ids.length) throw new Error('系统页面区块 ID 不唯一，拒绝变更');
  return best.blocks;
}

export function assertSystemPageRestored(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`系统页面区块快照未恢复：before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }
  return true;
}

export function countOwnedSystemPageBlocks(snapshot, ownedId) {
  if (!ownedId || !Array.isArray(snapshot?.ids)) return 0;
  return snapshot.ids.filter(id => id === ownedId).length;
}

export function categorySystemPageFor(types, mapping) {
  const category = types.find(type => Object.hasOwn(mapping ?? {}, type));
  if (!category) throw new Error('组合区块必须包含已映射的分类类型');
  return { category, systemPage: mapping[category] };
}
