// Tests for the Street View spend figure.
//
// This number is what someone looks at before pressing "Skini snimke", so the ways it can be
// wrong all cost real money. The fixture is a real captured Cloud Monitoring response for
// August 2026, and the anchor test asserts it reduces to 3,969 — the count that reconciled
// exactly against the pipeline's own image manifests. If the parser ever starts counting the
// free metadata endpoint again, that test goes red rather than the budget quietly tripling.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  tallyRequests, summariseUsage, billingMonth, billingDay, monthWindow,
  streetViewBudget, BudgetUnavailable, FREE_MONTHLY_REQUESTS,
  IMAGE_METHOD, METADATA_METHOD
} from "../budget.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const AUGUST = JSON.parse(readFileSync(path.join(here, "fixtures-monitoring-august.json"), "utf8"));

// Builds a Monitoring-shaped response without hand-writing the nesting every time.
function series(method, cls, points) {
  return {
    metric: { labels: { response_code_class: cls }, type: "serviceruntime.googleapis.com/api/request_count" },
    resource: { type: "consumed_api", labels: { method } },
    points: points.map(([endTime, n]) => ({
      interval: { startTime: endTime, endTime }, value: { int64Value: String(n) }
    }))
  };
}

test("the real August response reduces to the count that matched our manifests", () => {
  // 3,969 is what street-view's own image manifests recorded as newly fetched for August
  // 2026, summed across all 20 areas. The extra 1 is a single hand-made request issued while
  // building this — proof the metric is exact to the individual call, not a rounded estimate.
  const t = tallyRequests(AUGUST);
  assert.equal(t.billable, 3969 + 1);
});

test("free metadata calls are never counted as spend", () => {
  // Reading request_count without splitting on method reported 9,111 for August — 2.3x the
  // real bill — because the metadata endpoint dominates it. It is free and unlimited.
  const t = tallyRequests(AUGUST);
  assert.ok(t.metadata > t.billable, "the fixture should have more metadata calls than image calls");

  const onlyMetadata = tallyRequests({
    timeSeries: [series(METADATA_METHOD, "2xx", [["2026-08-02T20:00:00Z", 5000]])]
  });
  assert.equal(onlyMetadata.billable, 0, "5,000 metadata calls must cost nothing");
  assert.equal(onlyMetadata.metadata, 5000);
});

test("requests that returned an error are not billed, but are still reported", () => {
  // Our fetcher sends return_error_code=true, so "no imagery here" comes back 404 and Google
  // does not charge for it. Counting it would invent spend; hiding it entirely would mask a
  // fetcher that has started being rejected.
  const t = tallyRequests({
    timeSeries: [
      series(IMAGE_METHOD, "2xx", [["2026-08-02T20:00:00Z", 100]]),
      series(IMAGE_METHOD, "4xx", [["2026-08-02T20:00:00Z", 40]]),
      series(IMAGE_METHOD, "5xx", [["2026-08-02T20:00:00Z", 2]])
    ]
  });
  assert.equal(t.billable, 100);
  assert.equal(t.errors, 42);
});

test("an unknown method is ignored rather than counted as images", () => {
  // Google can add methods to this service; a new one must not silently become spend.
  const t = tallyRequests({
    timeSeries: [series("google.maps.SomethingNew.Http", "2xx", [["2026-08-02T20:00:00Z", 999]])]
  });
  assert.equal(t.billable, 0);
});

test("a month with no usage reads zero instead of crashing", () => {
  // Monitoring returns a body with no timeSeries key at all when nothing matched.
  for (const empty of [{}, { timeSeries: [] }, null, undefined]) {
    const t = tallyRequests(empty);
    assert.equal(t.billable, 0);
    assert.deepEqual(t.by_day, []);
  }
});

test("daily buckets follow Google's billing time zone", () => {
  // 2026-08-03T05:00Z is still 2 August in Los Angeles, so it belongs to the 2nd.
  const t = tallyRequests({
    timeSeries: [series(IMAGE_METHOD, "2xx", [
      ["2026-08-03T05:00:00Z", 10],
      ["2026-08-03T08:00:00Z", 5]
    ])]
  });
  assert.deepEqual(t.by_day, [{ day: "2026-08-02", count: 10 }, { day: "2026-08-03", count: 5 }]);
});

test("only the requests past the free allowance cost anything", () => {
  const under = summariseUsage({ used: 3969, month: "2026-08" });
  assert.equal(under.remaining, FREE_MONTHLY_REQUESTS - 3969);
  assert.equal(under.overage, 0);
  assert.equal(under.cost_usd, 0, "a month inside the free tier must not report a bill");

  const over = summariseUsage({ used: 12000, month: "2026-08" });
  assert.equal(over.overage, 2000);
  assert.equal(over.cost_usd, 14, "2000 past the allowance at $7/1000");
  assert.equal(over.remaining, 0);
});

test("the month boundary follows Google's billing time zone, not the local one", () => {
  assert.equal(billingMonth(new Date("2026-08-01T03:00:00Z")), "2026-07");
  assert.equal(billingMonth(new Date("2026-08-01T08:00:00Z")), "2026-08");
  assert.equal(billingDay(new Date("2026-08-03T05:00:00Z")), "2026-08-02");
});

test("the query window starts at local midnight on the 1st, in both DST and standard time", () => {
  // Getting this wrong pulls in the tail of the previous month, whose spend the free
  // allowance has already been reset past.
  const summer = monthWindow(new Date("2026-08-05T12:00:00Z"));
  assert.equal(summer.month, "2026-08");
  assert.equal(summer.startTime, "2026-08-01T07:00:00.000Z", "PDT is UTC-7");

  const winter = monthWindow(new Date("2026-01-15T12:00:00Z"));
  assert.equal(winter.month, "2026-01");
  assert.equal(winter.startTime, "2026-01-01T08:00:00.000Z", "PST is UTC-8");

  // Hours into the month, the window must not run backwards into the previous one.
  const justAfterRollover = monthWindow(new Date("2026-08-01T08:00:00Z"));
  assert.equal(justAfterRollover.startTime, "2026-08-01T07:00:00.000Z");
});

test("missing credentials fail loudly instead of reporting zero spend", async () => {
  // A budget bar reading "0 / 10,000" because nobody is logged in would invite exactly the
  // spending it exists to prevent, so this must throw rather than degrade.
  const previous = process.env.GCLOUD_BIN;
  process.env.GCLOUD_BIN = path.join(here, "no-such-gcloud-binary");
  try {
    await assert.rejects(
      () => streetViewBudget({ now: new Date("2026-08-05T12:00:00Z") }),
      (err) => {
        assert.ok(err instanceof BudgetUnavailable, `expected BudgetUnavailable, got ${err.name}`);
        assert.match(err.message, /gcloud auth login/);
        return true;
      }
    );
  } finally {
    if (previous === undefined) delete process.env.GCLOUD_BIN;
    else process.env.GCLOUD_BIN = previous;
  }
});
