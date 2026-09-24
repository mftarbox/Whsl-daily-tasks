// Slack client. Two independent delivery mechanisms for two independent uses:
//   - sendSlackAlert: error/fatal alerts to #whsl_ops_workflow_alerts, via a plain Incoming
//     Webhook (SLACK_ALERTS_WEBHOOK_URL) - text only, never throws (see below).
//   - uploadFileToSlack / postSlackMessage: the Feature 3 drop digest to #wholesale-drops, via
//     Slack's Web API with a bot token (SLACK_BOT_TOKEN) - see the 2026-09-24 note below for why
//     this isn't also a plain webhook.
//
// sendSlackAlert should never throw - a Slack outage or misconfigured webhook should never be
// able to take down the actual automation run; failures there are only ever logged. The bot-token
// functions below are different on purpose: they DO throw on failure, same as any other
// Monday/NetSuite call in this codebase, so the caller's own try/catch (see
// sendDropDigestToSlack in dropped-alert.js) can log + sendSlackAlert about it like every other
// non-fatal failure path.

const ALERTS_WEBHOOK_URL = process.env.SLACK_ALERTS_WEBHOOK_URL;
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

async function postToSlackWebhook(webhookUrl, payload, { envVarName, label }) {
  if (!webhookUrl) {
    console.warn(`${envVarName} not set - skipping ${label}.`);
    return;
  }
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn(`${label} POST failed (${res.status}): ${await res.text()}`);
    }
  } catch (err) {
    console.warn(`${label} failed to send: ${err.message}`);
  }
}

// fatal: true = the whole run is aborting because of this. fatal: false = a single item/order
// failed and was skipped, but the run is continuing. Shelly asked for alerts on both tiers
// (2026-08-08).
//
// source: which workflow sent this alert (added 2026-09-08 when the original single-script
// automation was split into three separate GitHub Actions workflows - see docs/spec.md decision
// 25). Defaults to the original combined workflow's name so nothing breaks if some caller doesn't
// pass one, but every current caller does.
export async function sendSlackAlert(message, { fatal = false, source = 'Wholesale Drops Order Alert' } = {}) {
  const prefix = fatal ? ':red_circle: *FATAL ERROR*' : ':warning: *Error*';
  const text = `${prefix} - ${source} workflow\n${message}`;
  await postToSlackWebhook(ALERTS_WEBHOOK_URL, { text }, { envVarName: 'SLACK_ALERTS_WEBHOOK_URL', label: 'Slack alert' });
}

function requireBotToken() {
  if (!BOT_TOKEN) {
    throw new Error('SLACK_BOT_TOKEN not set');
  }
  return BOT_TOKEN;
}

// Slack's Web API always returns HTTP 200 even on a logical failure - the real signal is the
// `ok` field in the JSON body, with `error` giving the reason. Confirmed via Slack's own docs
// (2026-09-24) that this applies to every method used below.
async function callSlackApi(method, { json, formData } = {}) {
  const token = requireBotToken();
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    },
    body: json ? JSON.stringify(json) : formData,
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(`Slack API ${method} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

// Added 2026-09-24 (Shelly's request: "is there anyway to get the imagery to post w/ the slack
// message?"). The original approach - passing Monday's `assets(ids:).public_url` straight through
// as a Block Kit `image_url` - looked right (confirmed live via curl that the URL is genuinely
// publicly fetchable, correct Content-Type, well under Slack's 3000-char URL limit) but never
// actually rendered. Root cause: that URL is a temporary S3 presigned link, valid only ~1 hour
// (Monday's own schema says so) - by the time anyone actually opens the digest message, it's
// long expired. It's also hard-coded by Monday with `Content-Disposition: attachment`, which
// tells any client "download this," not "display inline" - Slack's own developer blog
// specifically warns against embedding presigned/temporary URLs this way and recommends
// uploading the file directly to Slack instead (the `slack_file` block property), so this
// downloads the image bytes (same fetch(asset.public_url) pattern the original email version
// used) and uploads them into Slack itself via the standard three-step external-upload flow:
// files.getUploadURLExternal -> PUT the bytes to the returned upload_url -> files.completeUploadExternal
// (no channel_id passed - per Slack's docs, omitting it just hosts the file privately in Slack,
// which is exactly what's needed to reference it via `slack_file: { id }` in a message posted
// separately, without also creating a redundant standalone file-share message in the channel).
// Needs the `files:write` bot scope.
export async function uploadFileToSlack(buffer, filename) {
  const { upload_url: uploadUrl, file_id: fileId } = await callSlackApi('files.getUploadURLExternal', {
    formData: new URLSearchParams({ filename, length: String(buffer.length) }),
  });

  const uploadRes = await fetch(uploadUrl, { method: 'POST', body: buffer });
  if (!uploadRes.ok) {
    throw new Error(`Slack file upload PUT failed (${uploadRes.status}): ${await uploadRes.text()}`);
  }

  await callSlackApi('files.completeUploadExternal', { json: { files: [{ id: fileId, title: filename }] } });
  return fileId;
}

// Posts a Block Kit message via chat.postMessage instead of an Incoming Webhook, since webhooks
// can't reference `slack_file` images (they're a plain HTTP POST with no bot identity/token
// behind them for Slack to resolve the file against). Needs the `chat:write` bot scope, and the
// bot user needs to actually be a member of the destination channel (invited via `/invite
// @<bot name>` in Slack) - `chat.postMessage` returns a `not_in_channel` error otherwise.
export async function postSlackMessage(channelId, text, blocks) {
  await callSlackApi('chat.postMessage', { json: { channel: channelId, text, blocks } });
}
