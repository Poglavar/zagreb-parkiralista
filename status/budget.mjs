// How much of this month's free Google Street View Static quota has been spent, according
// to Google rather than to our own artifacts.
//
// This used to count JPEGs on disk. That could never be right: the same API key is used by
// zagreb-zgrade-datiranje, so half the month's spend leaves no file in this repo at all. In
// July 2026 this repo held 3,718 images while Google had billed 7,362 requests — the
// difference was the other project. The quota is per-key, so only Google can see the total.
//
// Two things make the query non-obvious, and both were wrong on the first attempt:
//
//   * `request_count` for the Street View service lumps the FREE metadata endpoint together
//     with the billable image endpoint. In August 2026 that was 5,142 metadata calls against
//     3,969 image calls — reading the total would overstate spend by 2.3x. The
//     `resource.labels.method` label separates them.
//   * Only 2xx counts. A request that returns an error code (our fetcher sends
//     `return_error_code=true`, so "no imagery here" is a 404) is not billed. Counting 2xx
//     alone reconciled to the request against our own manifests.
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Street View Static, Essentials tier: 10,000 free calls per month, then $7 per 1,000.
export const FREE_MONTHLY_REQUESTS = 10_000;
export const USD_PER_1000 = 7;

// Google Maps Platform bills on Pacific Time, so the month rolls over there, not here. On
// the first or last day of a month a local-time boundary would put requests in the wrong
// month and either hide spend or invent it.
const BILLING_TIME_ZONE = "America/Los_Angeles";

// The Cloud project the Maps API key belongs to. Not a secret — it appears in every console
// URL — so it is versioned here rather than hidden in .env.
const DEFAULT_PROJECT = "cogent-calling-385120";

const SERVICE = "street-view-image-backend.googleapis.com";
export const IMAGE_METHOD = "google.maps.StreetView.Http";
export const METADATA_METHOD = "google.maps.StreetViewMetadata.Http";

// Raised when Google cannot be reached or the credentials are not usable. The caller turns
// this into a visible "unavailable" rather than a number, because a budget that silently
// reads zero when authentication lapses is worse than no budget at all.
export class BudgetUnavailable extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "BudgetUnavailable";
    this.cause = cause;
  }
}

// "2026-08" for the month a timestamp falls in, in the billing time zone.
export function billingMonth(date, timeZone = BILLING_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit"
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year").value;
  const month = parts.find((p) => p.type === "month").value;
  return `${year}-${month}`;
}

// "2026-08-02" for the day a timestamp falls in, in the billing time zone.
export function billingDay(date, timeZone = BILLING_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
}

// The Monitoring query window for the billing month containing `now`: from midnight Pacific
// on the 1st up to now. Walking back from `now` rather than constructing a date avoids
// having to know the Pacific UTC offset, which changes with daylight saving.
export function monthWindow(now, timeZone = BILLING_TIME_ZONE) {
  const month = billingMonth(now, timeZone);
  let start = new Date(now.getTime());
  while (billingMonth(new Date(start.getTime() - 86_400_000), timeZone) === month) {
    start = new Date(start.getTime() - 86_400_000);
  }
  // Now inside the first day of the month; walk back to its local midnight.
  const firstDay = billingDay(start, timeZone);
  while (billingDay(new Date(start.getTime() - 3_600_000), timeZone) === firstDay) {
    start = new Date(start.getTime() - 3_600_000);
  }
  start = new Date(Math.floor(start.getTime() / 3_600_000) * 3_600_000);
  return { month, startTime: start.toISOString(), endTime: new Date(now.getTime()).toISOString() };
}

// Pure: reduce a Monitoring timeSeries response to billable and free request counts.
// Exported separately from the HTTP call so the arithmetic — which is where the expensive
// mistakes live — can be tested against a captured response with no network and no auth.
export function tallyRequests(response, timeZone = BILLING_TIME_ZONE) {
  let billable = 0;
  let metadata = 0;
  let errors = 0;
  const days = new Map();

  for (const series of response?.timeSeries || []) {
    const method = series.resource?.labels?.method;
    const cls = series.metric?.labels?.response_code_class;
    for (const point of series.points || []) {
      const n = Number(point.value?.int64Value ?? point.value?.doubleValue ?? 0);
      if (!Number.isFinite(n)) continue;
      if (method === METADATA_METHOD) {
        if (cls === "2xx") metadata += n;
        continue;
      }
      if (method !== IMAGE_METHOD) continue;
      if (cls !== "2xx") {
        // Not billed, but a spike here means the fetcher is being rejected — worth surfacing.
        errors += n;
        continue;
      }
      billable += n;
      const day = billingDay(new Date(point.interval.endTime), timeZone);
      days.set(day, (days.get(day) || 0) + n);
    }
  }

  return {
    billable,
    metadata,
    errors,
    by_day: [...days.entries()]
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day))
  };
}

// Pure: the money arithmetic, given a request count.
export function summariseUsage({ used, month, freeQuota = FREE_MONTHLY_REQUESTS, usdPer1000 = USD_PER_1000 }) {
  const remaining = Math.max(0, freeQuota - used);
  const overage = Math.max(0, used - freeQuota);
  return {
    month,
    time_zone: BILLING_TIME_ZONE,
    used,
    free_quota: freeQuota,
    remaining,
    overage,
    // Only the requests past the free quota cost anything. Reporting the whole month's
    // spend as billable would make a free month look expensive.
    cost_usd: Number(((overage / 1000) * usdPer1000).toFixed(2)),
    usd_per_1000: usdPer1000,
    pct_used: freeQuota > 0 ? Math.min(100, (100 * used) / freeQuota) : 0
  };
}

// An OAuth token for the Monitoring API. The Maps API key cannot read Monitoring, so this
// borrows the gcloud login. That is fine here because the status server is local-only; a
// deployed copy would want a service account with roles/monitoring.viewer instead.
async function accessToken() {
  const bin = process.env.GCLOUD_BIN || "gcloud";
  try {
    const { stdout } = await execFileAsync(bin, ["auth", "print-access-token"], { timeout: 20_000 });
    const token = stdout.trim();
    if (!token) throw new Error("gcloud returned an empty token");
    return token;
  } catch (err) {
    throw new BudgetUnavailable(
      `no Google credentials — run \`gcloud auth login\` (${err.message.split("\n")[0]})`, err);
  }
}

async function queryTimeSeries({ projectId, token, startTime, endTime }) {
  const params = new URLSearchParams({
    filter: `metric.type="serviceruntime.googleapis.com/api/request_count" ` +
            `AND resource.type="consumed_api" AND resource.labels.service="${SERVICE}"`,
    "interval.startTime": startTime,
    "interval.endTime": endTime,
    "aggregation.alignmentPeriod": "3600s",
    "aggregation.perSeriesAligner": "ALIGN_SUM",
    "aggregation.crossSeriesReducer": "REDUCE_SUM"
  });
  // groupByFields repeats; URLSearchParams needs one append per value.
  params.append("aggregation.groupByFields", "resource.labels.method");
  params.append("aggregation.groupByFields", "metric.labels.response_code_class");

  const url = `https://monitoring.googleapis.com/v3/projects/${projectId}/timeSeries?${params}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new BudgetUnavailable(`Monitoring API returned HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

export async function streetViewBudget({
  now = new Date(),
  projectId = process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT
} = {}) {
  const { month, startTime, endTime } = monthWindow(now);
  const token = await accessToken();
  const response = await queryTimeSeries({ projectId, token, startTime, endTime });
  const tally = tallyRequests(response);

  return {
    ...summariseUsage({ used: tally.billable, month }),
    // Named so a reader knows this covers every project sharing the key, not just this repo.
    source: "google-cloud-monitoring",
    project: projectId,
    metadata_requests: tally.metadata,
    error_requests: tally.errors,
    by_day: tally.by_day,
    checked_at: endTime
  };
}
