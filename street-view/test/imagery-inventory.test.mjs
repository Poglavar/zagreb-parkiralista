// Tests for the imagery inventory — the three counts the status map reads.
//
// The bug these exist to prevent already happened once: Vrbani had 271 JPEGs on disk and
// 87 segments reading "never checked" on the map, because the inventory was only ever
// written by the ingest step and that area was fetched but never analysed. The counts must
// stay distinct (a segment Google has no panorama for is not a pending download) and a
// missing preflight must never be recorded as an answer.
import test from "node:test";
import assert from "node:assert/strict";
import { tallyImagery, summariseImagery } from "../scripts/lib/imagery-inventory.mjs";

const CANDIDATES = [
  { segment_id: "10", captures: [{ capture_id: "10-s1-forward" }, { capture_id: "10-s1-reverse" }] },
  { segment_id: "11", captures: [{ capture_id: "11-s1-forward" }] }
];

test("the three counts come from three different sources and stay apart", () => {
  const inv = tallyImagery({
    candidateSegments: CANDIDATES,
    // Google has a panorama for both of segment 10's captures but neither is downloaded;
    // segment 11's single capture is downloaded.
    metadataResults: [
      { segment_id: "10", ok: true, response: { status: "OK" } },
      { segment_id: "10", ok: true, response: { status: "OK" } },
      { segment_id: "11", ok: true, response: { status: "OK" } }
    ],
    imageRecords: [{ capture_id: "11-s1-forward", ok: true, image_path: "out/x.jpg" }]
  });
  const byId = Object.fromEntries(inv.map((i) => [i.segment_id, i]));
  assert.deepEqual(byId["10"], { segment_id: "10", capture_count: 2, covered_count: 2, image_count: 0 });
  assert.deepEqual(byId["11"], { segment_id: "11", capture_count: 1, covered_count: 1, image_count: 1 });
});

test("a capture Google has no panorama for is not counted as covered", () => {
  // If ZERO_RESULTS counted, the segment would look permanently fetchable and the area
  // could never go green however many times it was fetched.
  const inv = tallyImagery({
    candidateSegments: [CANDIDATES[1]],
    metadataResults: [{ segment_id: "11", ok: true, response: { status: "ZERO_RESULTS" } }],
    imageRecords: []
  });
  assert.equal(inv[0].covered_count, 0);
  assert.equal(summariseImagery(inv).fetchable, 0, "nothing to fetch where there is no panorama");
});

test("a failed image download does not count as an image on disk", () => {
  const inv = tallyImagery({
    candidateSegments: [CANDIDATES[1]],
    metadataResults: [{ segment_id: "11", ok: true, response: { status: "OK" } }],
    imageRecords: [{ capture_id: "11-s1-forward", ok: false, error: "429" }]
  });
  assert.equal(inv[0].image_count, 0);
  assert.equal(summariseImagery(inv).fetchable, 1, "a panorama exists and we do not have it");
});

test("image records are attributed by base segment id, not by capture id", () => {
  // capture ids are "<segment>-s<station>-<direction>"; getting this wrong scattered every
  // station of a street across separate rows that no segment could ever match.
  const inv = tallyImagery({
    candidateSegments: [{ segment_id: "10", captures: [{}, {}, {}] }],
    metadataResults: [],
    imageRecords: [
      { capture_id: "10-s1-forward", ok: true, image_path: "a.jpg" },
      { capture_id: "10-s2-forward", ok: true, image_path: "b.jpg" },
      { capture_id: "10-s2-reverse", ok: true, image_path: "c.jpg" }
    ]
  });
  assert.equal(inv.length, 1);
  assert.equal(inv[0].segment_id, "10");
  assert.equal(inv[0].image_count, 3);
});

test("an explicit segment_id on the image record wins over parsing the capture id", () => {
  const inv = tallyImagery({
    candidateSegments: [{ segment_id: "10", captures: [{}] }],
    imageRecords: [{ capture_id: "weird-id", segment_id: "10", ok: true, image_path: "a.jpg" }],
    metadataResults: []
  });
  assert.equal(inv[0].image_count, 1);
});

test("the inventory is sorted, so two passes over one area produce the same statement", () => {
  const inv = tallyImagery({
    candidateSegments: [{ segment_id: "9", captures: [] }, { segment_id: "10", captures: [] }, { segment_id: "11", captures: [] }],
    imageRecords: [],
    metadataResults: []
  });
  assert.deepEqual(inv.map((i) => i.segment_id), ["10", "11", "9"]);
});

test("a segment appearing only in images still lands in the inventory", () => {
  // Otherwise a fetch that outran its candidates file would silently drop rows.
  const inv = tallyImagery({
    candidateSegments: [],
    imageRecords: [{ capture_id: "77-s1-forward", ok: true, image_path: "a.jpg" }],
    metadataResults: []
  });
  assert.equal(inv.length, 1);
  assert.equal(inv[0].segment_id, "77");
  assert.equal(inv[0].capture_count, 0);
});
