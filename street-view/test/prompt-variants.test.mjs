// Tests for the prompt variants and the orthophoto geometry.
//
// The comparison these support is only meaningful if two things hold: the baseline variant
// is byte-identical to the prompt every existing run used, and the aerial overlay puts
// "left" and "right" on the sides the schema means. Both are silent failures otherwise —
// a drifted baseline makes every delta meaningless, and a mirrored overlay would teach the
// model to answer confidently with the sides swapped.
import test from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_PROMPT, buildUserPrompt } from "../scripts/lib/assessment-schema.mjs";
import { VARIANTS, getVariant, systemPromptFor, userPromptFor } from "../scripts/lib/prompt-variants.mjs";
import { filterTags, formatTags } from "../scripts/lib/osm-tags.mjs";
import { segmentBbox3765 } from "../scripts/lib/ortho.mjs";

const SEGMENT = {
  segment_id: "1",
  label: "TEST 1",
  street_name: "Ilica",
  length_m: 120,
  width_m: 9,
  area_labels: ["Donji Grad"],
  station_count: 1,
  captures: [{ capture_id: "1-s1-forward", station_index: 0, direction: "forward", heading: 90 }]
};

test("the baseline variant is the untouched prompt", () => {
  // If this ever fails, every previously scored run became incomparable to new ones.
  assert.equal(systemPromptFor(getVariant("sv")), SYSTEM_PROMPT);
  assert.equal(userPromptFor(getVariant("sv"), SEGMENT), buildUserPrompt(SEGMENT));
});

// Anchored to the section headers at line start. A loose /MAP DATA/i also matches the
// baseline's own sentence about the width being "a rough figure from map data", which
// would make this test fail on a correct baseline.
const AERIAL_SECTION = /^AERIAL IMAGE:$/m;
const OSM_SECTION = /^MAP DATA:$/m;

test("the baseline carries no extra-input instructions", () => {
  const p = systemPromptFor(getVariant("sv"));
  assert.doesNotMatch(p, AERIAL_SECTION);
  assert.doesNotMatch(p, OSM_SECTION);
});

test("each variant adds exactly the sections it declares", () => {
  const osm = systemPromptFor(getVariant("sv-osm"));
  assert.match(osm, OSM_SECTION);
  assert.doesNotMatch(osm, AERIAL_SECTION);

  const ortho = systemPromptFor(getVariant("sv-ortho"));
  assert.match(ortho, AERIAL_SECTION);
  assert.doesNotMatch(ortho, OSM_SECTION);

  const both = systemPromptFor(getVariant("sv-osm-ortho"));
  assert.match(both, OSM_SECTION);
  assert.match(both, AERIAL_SECTION);
});

test("the aerial section tells the model to prefer street level on disagreement", () => {
  // The orthophoto is years older than the panoramas. Without this the model would treat
  // an empty 2022 kerb as evidence against cars visible in a newer street-level image.
  assert.match(systemPromptFor(getVariant("sv-ortho")), /TRUST THE STREET VIEW IMAGES/);
});

test("every variant has a distinct prompt_version", () => {
  const versions = Object.values(VARIANTS).map((v) => v.promptVersion);
  assert.equal(new Set(versions).size, versions.length,
    "two variants sharing a prompt_version would be indistinguishable in parking.run");
});

test("missing extras are stated, not silently omitted", () => {
  // "no tags" is itself information; silence would let the model assume they were withheld.
  const u = userPromptFor(getVariant("sv-osm"), SEGMENT, { osmTags: null });
  assert.match(u, /none recorded/);
  const o = userPromptFor(getVariant("sv-ortho"), SEGMENT, { ortho: null });
  assert.match(o, /No orthophoto is available/);
});

test("supplied OSM tags appear in the user prompt, sorted", () => {
  const u = userPromptFor(getVariant("sv-osm"), SEGMENT, {
    osmTags: { sidewalk: "both", highway: "residential" }
  });
  assert.match(u, /highway=residential, sidewalk=both/);
});

// --- OSM tag filtering ---------------------------------------------------------------

test("tag filtering keeps parking-relevant keys and drops noise", () => {
  const t = filterTags({
    highway: "residential", "parking:lane:left": "parallel", sidewalk: "both",
    name: "Ilica", old_name: "X", lit: "yes", "source:date": "2019"
  });
  assert.equal(t.highway, "residential");
  assert.equal(t["parking:lane:left"], "parallel");
  assert.equal(t.sidewalk, "both");
  // name is already in the prompt header; lit and source:date say nothing about parking.
  assert.ok(!("name" in t));
  assert.ok(!("lit" in t));
  assert.ok(!("source:date" in t));
});

test("tag formatting is order-stable", () => {
  // Two runs given the same tags in different object orders must produce the same prompt,
  // or they are not the same experiment.
  const a = formatTags(filterTags({ sidewalk: "both", highway: "residential" }));
  const b = formatTags(filterTags({ highway: "residential", sidewalk: "both" }));
  assert.equal(a, b);
});

test("a segment with no relevant tags yields null, not an empty string", () => {
  assert.equal(filterTags({ name: "Ilica", lit: "yes" }), null);
  assert.equal(formatTags(null), null);
});

// --- orthophoto framing ---------------------------------------------------------------

test("the crop is square and contains the whole segment", () => {
  const coords = [[15.97, 45.80], [15.972, 45.801]];
  const b = segmentBbox3765(coords);
  assert.ok(Math.abs((b.maxX - b.minX) - (b.maxY - b.minY)) < 1e-6, "must be square in ground units");
  for (const [x, y] of b.points) {
    assert.ok(x > b.minX && x < b.maxX, "point inside bbox in x");
    assert.ok(y > b.minY && y < b.maxY, "point inside bbox in y");
  }
});

test("a very short segment is not blown up to a meaningless close-up", () => {
  // A 10 m stub framed tightly would be two kerbstones and no context.
  const b = segmentBbox3765([[15.97, 45.80], [15.9701, 45.80]]);
  assert.ok(b.extentM >= 70, `expected a floor on the extent, got ${b.extentM}`);
});

test("a long segment still gets padding around it", () => {
  const b = segmentBbox3765([[15.97, 45.80], [15.975, 45.80]]);
  const spanM = 0.005 * 111320 * Math.cos(45.8 * Math.PI / 180);
  assert.ok(b.extentM > spanM, "extent must exceed the segment's own length");
});
