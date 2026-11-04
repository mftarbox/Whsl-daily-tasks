// SRBD vs SED Check (added 2026-11-04, Shelly's request - docs/spec.md decision 42).
//
// Every weekday morning, after NetSuite's 1:00 AM Central allocation run, find open wholesale
// sales order lines whose Supply Required By Date (transactionline.requesteddate) does not match
// the order's Sales Effective Date, and post them to #wholesale_orders_issues with a ready-to-run
// Import Assistant file that sets SRBD = SED.
//
// Why it matters: NetSuite sorts demand by SRBD, and Wholesale Hold only looks 12 days past it.
// A line dated before its SED jumps the queue for stock it doesn't need yet; a line dated after
// it can't see supply it should get. Orders created by the SPS EDI feed, by CSV import and by hand
// all arrive with SRBD = order date unless a script fixes it (only Palmetto Moon is fixed today).
//
// Read-only against NetSuite - this job never changes an order.
//
// Import file: Transactions > Sales Order > Update, Overwrite Sublists UNCHECKED, key Internal ID
// + Items sublist "Line". "Line" must be the line's internal id (transactionline.id), NOT the
// display line number (linesequencenumber) - they match on most orders but drift once lines are
// deleted/added, and a wrong key fails the whole order with "Please enter a value for Amount"
// (confirmed 2026-11-04 on MSO-4347 and WSO9019096397).
import fs from 'node:fs';
import { runSuiteQL } from './lib/netsuite.js';
import { sendSlackAlert } from './lib/slack.js';

const SOURCE = 'SRBD vs SED Check';
const WHOLESALE_LOCATION_ID = 14; // Wholesale Warehouse
const WEBHOOK_URL = process.env.WHOLESALE_ORDER_ISSUES_SLACK_WEBHOOK_URL;
const CSV_PATH = 'srbd-sed-fix.csv';
// Rows posted inline as CSV code blocks. Above this, the post links to the run's artifact instead.
const MAX_INLINE_ROWS = 300;
const ROWS_PER_BLOCK = 60; // keeps each Slack message well under its 40k / 3k-per-block limits

const SQL = `
SELECT
  t.id AS internal_id,
  t.tranid AS order_no,
  BUILTIN.DF(t.entity) AS customer,
  BUILTIN.DF(t.createdby) AS created_by,
  t.source AS source,
  TO_CHAR(so.saleseffectivedate, 'MM/DD/YYYY') AS sed,
  TO_CHAR(tl.requesteddate, 'MM/DD/YYYY') AS srbd,
  CASE WHEN tl.requesteddate < so.saleseffectivedate THEN 'early' ELSE 'late' END AS direction,
  tl.id AS line_id,
  i.itemid AS item,
  -tl.quantity AS qty
FROM transaction t
JOIN salesorder so ON so.id = t.id
JOIN transactionline tl ON tl.transaction = t.id
JOIN item i ON i.id = tl.item
WHERE t.type = 'SalesOrd'
  AND t.status IN ('A', 'B', 'D', 'E')
  AND tl.mainline = 'F'
  AND tl.itemtype = 'InvtPart'
  AND tl.isclosed = 'F'
  AND tl.location = ${WHOLESALE_LOCATION_ID}
  AND NVL(tl.quantityshiprecv, 0) < -tl.quantity
  AND so.saleseffectivedate IS NOT NULL
  AND (tl.requesteddate IS NULL OR tl.requesteddate <> so.saleseffectivedate)
ORDER BY customer, t.tranid, tl.id
`;

function todayCentral() {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago' }).format(new Date());
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const header = ['Internal ID', 'Line', 'Supply Required By Date', 'REF Order #', 'REF Customer', 'REF Item', 'REF Old SRBD'];
  const lines = rows.map((r) =>
    [r.internal_id, r.line_id, r.sed, r.order_no, r.customer, r.item, r.srbd || '(blank)'].map(csvCell).join(','),
  );
  return [header.join(','), ...lines].join('\n');
}

function range(values) {
  const sorted = [...new Set(values.filter(Boolean))].sort((a, b) => new Date(a) - new Date(b));
  if (!sorted.length) return '(blank)';
  return sorted.length === 1 ? sorted[0] : `${sorted[0]}-${sorted[sorted.length - 1]}`;
}

function summarize(rows) {
  const byCustomer = new Map();
  for (const r of rows) {
    const c = byCustomer.get(r.customer) || { orders: new Set(), lines: 0, units: 0, srbd: [], sed: [], createdBy: new Set() };
    c.orders.add(r.order_no);
    c.lines += 1;
    c.units += Number(r.qty) || 0;
    c.srbd.push(r.srbd);
    c.sed.push(r.sed);
    c.createdBy.add(`${r.created_by || 'unknown'}${r.source ? ` (${r.source})` : ''}`);
    byCustomer.set(r.customer, c);
  }
  return [...byCustomer.entries()].sort((a, b) => b[1].lines - a[1].lines);
}

async function postWebhook(text) {
  if (!WEBHOOK_URL) {
    console.warn('WHOLESALE_ORDER_ISSUES_SLACK_WEBHOOK_URL not set - printing instead of posting.');
    console.log(text);
    return;
  }
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Slack webhook POST failed (${res.status}): ${await res.text()}`);
}

async function main() {
  const today = todayCentral();
  const rows = await runSuiteQL(SQL);
  console.log(`${rows.length} mismatched line(s).`);

  if (!rows.length) {
    await postWebhook(`*SRBD vs SED check - ${today}:* All clear, 0 open wholesale lines where Supply Required By Date doesn't match the Sales Effective Date.`);
    return;
  }

  fs.writeFileSync(CSV_PATH, toCsv(rows));

  const groups = summarize(rows);
  const orderCount = new Set(rows.map((r) => r.order_no)).size;
  const units = rows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
  const early = rows.filter((r) => r.direction === 'early').length;

  const table = [
    'Customer                         Orders  Lines  Units  Line date -> SED',
    ...groups.map(([cust, g]) =>
      `${String(cust).slice(0, 32).padEnd(32)} ${String(g.orders.size).padStart(6)} ${String(g.lines).padStart(6)} ${String(g.units).padStart(6)}  ${range(g.srbd)} -> ${range(g.sed)}`,
    ),
  ].join('\n');
  const creators = [...new Set(groups.flatMap(([, g]) => [...g.createdBy]))].join(', ');
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;

  await postWebhook(
    [
      `*Supply Required By Date ≠ Sales Effective Date - ${today}*`,
      `*${rows.length} open wholesale lines on ${orderCount} orders* (${units} units) don't match. ${early} dated early, ${rows.length - early} dated late.`,
      '```' + table + '```',
      `Created by: ${creators}`,
      'Fix: Import Assistant > Sales Order > Update, *Overwrite Sublists unchecked*, map Internal ID + Items *Line* + Supply Required By Date. Don\'t map REF columns.',
      rows.length > MAX_INLINE_ROWS && runUrl
        ? `Import file (${rows.length} rows, too long to post): download *srbd-sed-fix* from ${runUrl}`
        : 'Import file follows. Copy each block into one .csv (keep the header once).',
    ].join('\n'),
  );

  if (rows.length <= MAX_INLINE_ROWS) {
    const csvLines = toCsv(rows).split('\n');
    const header = csvLines.shift();
    for (let i = 0; i < csvLines.length; i += ROWS_PER_BLOCK) {
      const part = Math.floor(i / ROWS_PER_BLOCK) + 1;
      const parts = Math.ceil(csvLines.length / ROWS_PER_BLOCK);
      const chunk = [header, ...csvLines.slice(i, i + ROWS_PER_BLOCK)].join('\n');
      await postWebhook(`srbd-sed-fix.csv (part ${part} of ${parts})\n\`\`\`${chunk}\`\`\``);
    }
  }
}

main().catch(async (err) => {
  console.error(err);
  await sendSlackAlert(err.stack || err.message, { fatal: true, source: SOURCE });
  process.exit(1);
});
