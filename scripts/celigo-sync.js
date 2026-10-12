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
import { runCeligoFlow, runCeligoFlowAndWait } from './lib/celigo.js';
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
  // Never throws past these - a Celigo failure only logs + Slack-alerts. Each flow has its own
  // try/catch so one failing doesn't block the other.
  // Flow 1 must FINISH before flow 2 starts (decision 40): flow 2 reads NetSuite items, and flow 1
  // is what updates them. A Celigo "run" only queues the flow, so wait on its job. Flow 2 still
  // runs if flow 1 fails or takes too long, so NuOrder gets whatever did land.
  try {
    const { job, timedOut } = await runCeligoFlowAndWait(CELIGO_MONDAY_TO_NETSUITE_FLOW_ID);
    if (timedOut) {
      console.warn('Monday-to-NetSuite flow still running after 45 min - starting the NuOrder flow anyway.');
      await sendSlackAlert('Celigo Monday-to-NetSuite flow was still running after 45 minutes; started the NuOrder flow anyway.', {
        source: SOURCE,
      });
    } else {
      console.log(
        `Monday-to-NetSuite flow finished: ${job.status} (${job.numSuccess || 0} succeeded, ${job.numError || 0} errors).`,
      );
      if (String(job.status).toLowerCase() !== 'completed' || job.numError) {
        await sendSlackAlert(
          `Celigo Monday-to-NetSuite flow finished as "${job.status}" with ${job.numError || 0} error(s). Check its run history in Celigo.`,
          { source: SOURCE },
        );
      }
    }
  } catch (err) {
    console.error(`Celigo Monday-to-NetSuite sync flow failed: ${err.message}`);
    await sendSlackAlert(`Celigo Monday-to-NetSuite sync flow failed: ${err.message}`, { source: SOURCE });
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
