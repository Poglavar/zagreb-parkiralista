// These tests cover the rough billing helpers used to estimate Street View and OpenAI run costs.
import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateOpenAiUsageCost,
  estimateGoogleStreetViewImageCost,
  estimateOpenAiImageInputCost,
  parseSizeString
} from "../scripts/lib/billing.mjs";

test("parseSizeString reads width and height", () => {
  assert.deepEqual(parseSizeString("640x640"), { width: 640, height: 640 });
  assert.equal(parseSizeString("bad"), null);
});

test("estimateOpenAiImageInputCost returns a range for auto detail", () => {
  const estimate = estimateOpenAiImageInputCost({
    model: "gpt-5.4",
    imageCount: 4,
    width: 640,
    height: 640,
    detail: "auto"
  });

  assert.equal(estimate.image_tokens.kind, "range");
  assert.ok(estimate.image_tokens.min < estimate.image_tokens.max);
  assert.ok(estimate.estimated_image_input_cost_usd.max > estimate.estimated_image_input_cost_usd.min);
});

test("calculateOpenAiUsageCost respects cached input pricing", () => {
  const cost = calculateOpenAiUsageCost({
    model: "gpt-5.4",
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      total_tokens: 1200,
      input_tokens_details: { cached_tokens: 100 },
      output_tokens_details: { reasoning_tokens: 10 }
    }
  });

  assert.equal(cost.usage_tokens.cached_input, 100);
  assert.equal(cost.usage_tokens.uncached_input, 900);
  assert.ok(cost.estimated_cost_usd.total > 0);
});

test("estimateGoogleStreetViewImageCost reports billable request count", () => {
  const estimate = estimateGoogleStreetViewImageCost(40);
  assert.equal(estimate.billable_image_requests, 40);
  assert.ok(estimate.estimated_cost_usd_if_first_paid_tier_applies > 0);
});
