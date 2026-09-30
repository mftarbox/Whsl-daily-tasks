// Print Title sync (added 2026-09-29, Shelly's request - docs/spec.md decision 35).
//
// Wholesale WIP's "Print Title" (text_mm4mef1k) is copied from WIP2027's "Shopify Title" once,
// by the Monday automation that creates the Wholesale WIP item. After that nothing kept it
// current. This job runs first in .github/workflows/nightly.yml, so the Dropped digest and the
// Catalog "Remove" pulse always use the current title.
//
// Rules:
//   - Only Print Title is checked. No other copied column is touched.
//   - Updated only when WIP2027's Shopify Title is non-blank AND different (whitespace-trimmed).
//     A blank WIP2027 title never wipes a Wholesale WIP title.
//   - WIP2027's Shopify Title (shopify_title__1) is itself a mirror of the WIP Assortment Board.
//     monday's API returns mirror values through `... on MirrorValue { display_value }`.
import { mondayGraphQL } from './lib/monday.js';
import { sendSlackAlert } from './lib/slack.js';
import { getWholesaleWipItems, chunk, WHOLESALE_WIP_BOARD, COL_PRINT_TITLE } from './lib/wholesale-wip.js';

const SOURCE = 'Print Title Sync';
const COL_WIP2027_SHOPIFY_TITLE = 'shopify_title__1';

async function getWip2027ShopifyTitles(wip2027Ids) {
  const titles = {};
  for (const ids of chunk(wip2027Ids, 100)) {
    // limit: 100 is required - without it monday silently returns only 25 items (decision 22).
    const data = await mondayGraphQL(
      `
      query ($ids: [ID!], $col: [String!]) {
        items(ids: $ids, limit: 100) {
          id
          column_values(ids: $col) {
            text
            ... on MirrorValue { display_value }
          }
        }
      }
      `,
      { ids, col: [COL_WIP2027_SHOPIFY_TITLE] },
    );
    for (const item of data.items) {
      const cv = item.column_values[0];
      titles[item.id] = (cv?.display_value ?? cv?.text ?? '').trim();
    }
  }
  return titles;
}

async function setPrintTitle(itemId, title) {
  await mondayGraphQL(
    `
    mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
      change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
    }
    `,
    { boardId: WHOLESALE_WIP_BOARD, itemId, columnId: COL_PRINT_TITLE, value: title },
  );
}

async function main() {
  console.log('Fetching Wholesale WIP items...');
  const wipItems = (await getWholesaleWipItems()).filter((i) => i.wip2027Id);
  const titles = await getWip2027ShopifyTitles([...new Set(wipItems.map((i) => i.wip2027Id))]);

  let updated = 0;
  for (const item of wipItems) {
    const source = titles[item.wip2027Id];
    const current = (item.printTitle || '').trim();
    if (!source || source === current) continue;
    try {
      await setPrintTitle(item.id, source);
      updated++;
      console.log(`  ${item.name}: "${current || '(blank)'}" -> "${source}"`);
    } catch (err) {
      console.error(`  Failed to update Print Title on ${item.name}: ${err.message}`);
      await sendSlackAlert(`Failed to update Print Title on "${item.name}": ${err.message}`, { source: SOURCE });
    }
  }
  console.log(`Checked ${wipItems.length} item(s), updated ${updated}.`);
  console.log('Done.');
}

main().catch(async (err) => {
  console.error('Fatal error:', err);
  await sendSlackAlert(`Fatal error - the run aborted before finishing:\n\`\`\`${err.stack || err.message}\`\`\``, {
    fatal: true,
    source: SOURCE,
  });
  process.exit(1);
});
