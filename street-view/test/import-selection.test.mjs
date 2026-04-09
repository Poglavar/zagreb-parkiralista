// These tests cover the reusable segment-selection importer used for neighborhood batch runs.
import test from "node:test";
import assert from "node:assert/strict";
import { buildSelectedFeatures } from "../scripts/import-road-width-selection.mjs";

const SOURCE = {
  segmentLines: [
    {
      id: "1",
      w: 8.5,
      len: 120,
      b: "7-9m",
      l1: ["TREŠNJEVKA - SJEVER"],
      l2: ["Zagreb"],
      l3: ["Trešnjevka - sjever", "Pongračevo"],
      c: [
        [15.98, 45.81],
        [15.981, 45.811]
      ]
    }
  ]
};

test("buildSelectedFeatures maps source geometry and labels into GeoJSON features", () => {
  const features = buildSelectedFeatures(SOURCE, [
    {
      segmentId: "1",
      label: "Batch segment 1",
      notes: "Sample selection."
    }
  ]);

  assert.equal(features.length, 1);
  assert.equal(features[0].properties.segment_id, "1");
  assert.equal(features[0].properties.label, "Batch segment 1");
  assert.deepEqual(features[0].properties.l3, ["Trešnjevka - sjever", "Pongračevo"]);
  assert.deepEqual(features[0].geometry.coordinates, SOURCE.segmentLines[0].c);
});

test("buildSelectedFeatures throws on missing source segments", () => {
  assert.throws(
    () => buildSelectedFeatures(SOURCE, [{ segmentId: "999", label: "Missing", notes: "No source row." }]),
    /Missing selected segment ids/
  );
});
