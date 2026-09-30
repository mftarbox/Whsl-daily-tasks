// Celigo NetSuite Sync workflow: triggers two Celigo flows on-demand, one after the other.
//   1. "Monday to NetSuite" - syncs NetSuite's NuOrder Active / NuOrder Sync checkboxes off
//      whatever Wholesale WIP's "Add to NuOrder" column currently says. This fully replaces that
//      flow's separate Celigo-side schedule (Shelly's call, 2026-08-10).
//   2. "NetSuite Item to NuOrder Product & Size Create/Update" - added 2026-09-08 (Shelly's
//      request, see docs/spec.md decision 26) as a second step in this same workflow, run right
//      after flow 1. Each flow gets its own try/catch (same pattern as everywhere else in this
//      codebase) so a failure in one doesn't block or get masked by the other.
//
// CHANGED 2026-09-29 (Shelly's request, docs/spec.md decision 34): no more `workflow_run` chaining
// or 8pm-Mountain gate. This runs as the LAST job of .github/workflows/nightly.yml, once, after
// every other job has finished (success or failure), so it always sees the final "Add to NuOrder"
// values for the night. It can still be run by itself from the Actions tab.
import { runCeligoFlow } from './lib/celigo.js';
import { sendSlackAlert } from './lib/slack.js';

const SOURCE = 'Celigo NetSuite Sync';

// Celigo's native "Monday to NetSuite" sync flow - grabbed from the flow's URL in integrator.io
// (https://integrator.io/integrations/66f5896552a1b5dd437da348/flowBuilder/<this id>), 2026-08-10.
const CELIGO_MONDAY_TO_NETSUITE_FLOW_ID = '6a7520cb8d2dd2212253f91d';

// "NetSuite Item to NuOrder Product & Size Create/Update" - same integration
// (66f5896552a1b5dd437da348), different flow, added 2026-09-08 per Shelly's request:
// https://integrator.io/integrations/66f5896552a1b5dd437da348/flowBuilder/66e07296960e3ef4199b3c02
const CELIGO_NETSUITE_ITEM_TO_NUORDER_FLOW_ID = '66e07296960e3ef4199b3c02';

async function main() {
  // Never throws past these - a Celigo failure shouldn't affect this workflow's exit code, same
  // convention as every other non-fatal error path across all three scripts (log + Slack alert
  // only, per Shelly's call). Each flow is wrapped independently so one failing doesn't block or
  // mask the other.
  try {
    await runCeligoFlow(CELIGO_MONDAY_TO_NETSUITE_FLOW_ID);
    console.log('Triggered Celigo Monday-to-NetSuite sync flow.');
  } catch (err) {
    console.error(`Failed to trigger Celigo Monday-to-NetSuite sync flow: ${err.message}`);
    await sendSlackAlert(`Failed to trigger Celigo Monday-to-NetSuite sync flow: ${err.message}`, { source: SOURCE });
  }

  try {
    await runCeligoFlow(CELIGO_NETSUITE_ITEM_TO_NUORDER_FLOW_ID);
    console.log('Triggered Celigo NetSuite Item to NuOrder Product & Size Create/Update flow.');
  } catch (err) {
    console.error(`Failed to trigger Celigo NetSuite Item to NuOrder Product & Size Create/Update flow: ${err.message}`);
    await sendSlackAlert(
      `Failed to trigger Celigo NetSuite Item to NuOrder Product & Size Create/Update flow: ${err.message}`,
      { source: SOURCE },
    );
  }

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
