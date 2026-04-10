// These tests cover the catalog helper that exposes generated review bundles to the static reviewer.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewBundleCatalog,
  isReviewBundleFileName,
  summarizeReviewBundleFile
} from "../scripts/lib/review-bundle-catalog.mjs";

test("isReviewBundleFileName accepts review bundle outputs and rejects the catalog file", () => {
  assert.equal(isReviewBundleFileName("tresnjevka-review-bundle.json"), true);
  assert.equal(isReviewBundleFileName("review-bundle-catalog.json"), false);
  assert.equal(isReviewBundleFileName("openai-analyses.json"), false);
});

test("summarizeReviewBundleFile derives a readable label and path", () => {
  const summary = summarizeReviewBundleFile("tresnjevka-review-bundle.json", {
    generated_at: "2026-04-10T10:00:00.000Z",
    segment_count: 10
  });

  assert.equal(summary.path, "./out/tresnjevka-review-bundle.json");
  assert.equal(summary.segment_count, 10);
  assert.match(summary.label, /Tresnjevka Review Bundle/i);
});

test("buildReviewBundleCatalog sorts newest bundles first", () => {
  const catalog = buildReviewBundleCatalog([
    {
      fileName: "older-review-bundle.json",
      payload: { generated_at: "2026-04-09T10:00:00.000Z", segment_count: 3 }
    },
    {
      fileName: "newer-review-bundle.json",
      payload: { generated_at: "2026-04-10T10:00:00.000Z", segment_count: 5 }
    }
  ]);

  assert.equal(catalog[0].file_name, "newer-review-bundle.json");
  assert.equal(catalog[1].file_name, "older-review-bundle.json");
});
