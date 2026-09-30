// Prebook Expiry (added 2026-09-30, Shelly's request - docs/spec.md decision 39).
//
// Every Wholesale WIP item whose "Remove Prebook Date" (date_mm7py1xm) is today or earlier
// (Mountain time) and that still has Prebook set gets taken off Prebook automatically - the same
// thing the Prebook Period Manager's "end" flow does by hand:
//   - uncheck Prebook, clear Prebook Delivery Start / End Date, clear Remove Prebook Date
//   - set Add to NuOrder = "Update", so the Celigo job later in the same nightly run sends the
//     change to NetSuite / NuOrder.
// Remove Prebook Date is cleared too, so an item prebooked again later can't be taken straight
// back off by a stale date.
import { mondayGraphQL } from './lib/monday.js';
import { sendSlackAlert } from './lib/slack.js';
import {
  getWholesaleWipItems,
  WHOLESALE_WIP_BOARD,
  COL_ADD_TO_NUORDER,
  COL_PREBOOK,
  COL_PREBOOK_START,
  COL_PREBOOK_END,
  COL_PREBOOK_REMOVE,
} from './lib/wholesale-wip.js';

const SOURCE = 'Prebook Expiry';

function todayInMountain() {
  // en-CA formats as YYYY-MM-DD, which compares correctly as a string.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());
}

async function endPrebook(itemId) {
  await mondayGraphQL(
    `
    mutation ($boardId: ID!, $itemId: ID!, $values: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values) { id }
    }
    `,
    {
      boardId: WHOLESALE_WIP_BOARD,
      itemId,
      values: JSON.stringify({
        [COL_PREBOOK]: null,
        [COL_PREBOOK_START]: null,
        [COL_PREBOOK_END]: null,
        [COL_PREBOOK_REMOVE]: null,
        [COL_ADD_TO_NUORDER]: { label: 'Update' },
      }),
    },
  );
}

async function main() {
  const today = todayInMountain();
  console.log(`Today (Mountain): ${today}. Fetching Wholesale WIP items...`);
  const wipItems = await getWholesaleWipItems();

  const due = wipItems.filter((i) => i.prebookRemoveDate && i.prebookRemoveDate <= today && i.hasPrebook);
  console.log(`${due.length} item(s) due to come off Prebook.`);

  let ended = 0;
  for (const item of due) {
    try {
      await endPrebook(item.id);
      ended++;
      console.log(`  ${item.name} (${item.masterSku || 'no Master SKU'}): off Prebook (Remove Prebook Date ${item.prebookRemoveDate}).`);
    } catch (err) {
      console.error(`  Failed to end Prebook on ${item.name}: ${err.message}`);
      await sendSlackAlert(`Failed to take "${item.name}" off Prebook (Remove Prebook Date ${item.prebookRemoveDate}): ${err.message}`, {
        source: SOURCE,
      });
    }
  }
  console.log(`Ended Prebook on ${ended} of ${due.length}.`);
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
