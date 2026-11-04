# Wholesale WIP Nightly Automation

Everything that happens automatically to an item on the **Wholesale WIP** Monday board after it
leaves WIP2027. One GitHub Actions workflow, **Wholesale WIP Nightly**, runs it all every night
(02:00 UTC = 8pm Mountain in summer, 7pm in winter) or whenever someone clicks **Run workflow**.

Plain-language walkthrough for the ops team: *Wholesale WIP Automation — How It Works* (Claude Docs).
Full design history and platform gotchas: [`docs/spec.md`](docs/spec.md).

## The nightly run, in order

| # | Job | What it does |
|---|-----|--------------|
| 1 | Print Title Sync | Copies WIP2027 **Shopify Title** onto Wholesale WIP **Print Title** when it changed. Never blanks a title. |
| 2 | NuOrder Imagery Export | Every item whose WIP2027 **NuOrder Images Exported** box is unchecked: uploads its WIP2027 images to Dropbox `/NuOrder Imagery/{Master SKU}-01…`, then checks the box. |
| 3 | Dropped Rework Alert | Items with **WHSL Planning Indicator = Dropped** and **Rework Alert Sent** unchecked: Add to NuOrder → Remove, Catalog/NuOrder L10 "Remove" item, #wholesale-drops post, NetSuite open-order match → Sales Ops L10 close-items CSV + Wholesale Sales L10 item per order, then checks Rework Alert Sent. Also resets Rework Alert Sent on anything no longer Dropped. |
| 4 | Prebook Expiry | Items whose **Remove Prebook Date** is today or earlier (Mountain) and still on Prebook: unchecks Prebook, clears the three Prebook dates, sets Add to NuOrder → Update. |
| 5 | Celigo NetSuite Sync | Runs Celigo "Monday → NetSuite" (NuOrder Active on/off from Add to NuOrder), then "NetSuite Item → NuOrder Product & Size". |

Separate schedule (not part of the nightly run): **SRBD vs SED Check** — weekdays 13:41 UTC (7:41am Central in winter, 8:41am in summer), after NetSuite's 1:00 AM allocation run. Finds open wholesale SO lines whose Supply Required By Date doesn't match the Sales Effective Date and posts them to **#wholesale_orders_issues** with a ready-to-run Import Assistant file (`srbd-sed-fix.csv`; also saved as a run artifact for 14 days). Read-only against NetSuite.

Jobs 2, 3 and 4 run side by side after 1. Job 5 runs last. Every job runs even if an earlier one
failed. Errors post to **#whsl_ops_workflow_alerts**.

## Running things by hand

Actions tab → pick a workflow → **Run workflow**.

- **Wholesale WIP Nightly** — everything, in order. Use this by default.
- **SRBD vs SED Check** — run any time to get the current mismatch list posted.
- **Print Title Sync / NuOrder Imagery Export / Dropped Rework Alert / Prebook Expiry / Celigo NetSuite Sync** — just
  that one job. Handy after fixing a single problem (e.g. an image added). Run Celigo afterwards if
  you changed Add to NuOrder.

## Files

- `.github/workflows/nightly.yml` — the schedule and job order
- `.github/workflows/*.yml` — one per job (callable by the nightly run, or run alone)
- `scripts/*.js` — one script per job; `scripts/lib/` — shared Monday, NetSuite, Slack, Dropbox, Celigo clients
- `state/state.json` — NetSuite order # → Wholesale Sales L10 item id (so a second drop adds a comment instead of a duplicate)
- `state/drops.json` — drops whose one-time notifications already went out (so a retry doesn't re-post)

## Secrets (Settings → Secrets and variables → Actions)

`MONDAY_API_TOKEN`, `NETSUITE_ACCOUNT_ID`, `NETSUITE_CONSUMER_KEY`, `NETSUITE_CONSUMER_SECRET`,
`NETSUITE_TOKEN_ID`, `NETSUITE_TOKEN_SECRET`, `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`,
`DROPBOX_REFRESH_TOKEN`, `CELIGO_API_TOKEN`, `SLACK_ALERTS_WEBHOOK_URL`, `WHOLESALE_DROPS_SLACK_WEBHOOK_URL`, `WHOLESALE_ORDER_ISSUES_SLACK_WEBHOOK_URL` (Incoming Webhook bound to #wholesale_orders_issues, for SRBD vs SED Check)
