// Tests for the model league table. This is the function that decides which LLM we call
// "best", so a wrong confusion matrix or a manner comparison that quietly counts the empty
// spaces would change a real decision while every number still looked plausible.
import test from "node:test";
import assert from "node:assert/strict";
import { scoreRows } from "../scripts/score-run.mjs";

// One scoreable space. model_says_parking mirrors what the SQL produces: true when the run
// has an observation for that space, false when it covered the segment and stayed silent.
function row(over = {}) {
  return {
    run_id: "r1", model: "m", engine: "e", prompt_version: "v2",
    segment_id: "100", side: "left",
    has_parking: true, human_manner: "parallel",
    model_manner: "parallel", model_says_parking: true,
    ...over
  };
}

test("confusion matrix counts each of the four outcomes", () => {
  const [s] = scoreRows([
    row({ segment_id: "1", has_parking: true, model_says_parking: true }),   // TP
    row({ segment_id: "2", has_parking: false, model_says_parking: true, model_manner: "parallel" }),  // FP
    row({ segment_id: "3", has_parking: true, model_says_parking: false, model_manner: null }),        // FN
    row({ segment_id: "4", has_parking: false, model_says_parking: false, model_manner: null })        // TN
  ]);
  assert.equal(s.n, 4);
  assert.equal(s.tp, 1);
  assert.equal(s.fp, 1);
  assert.equal(s.fn, 1);
  assert.equal(s.tn, 1);
  assert.equal(s.precision, 0.5);
  assert.equal(s.recall, 0.5);
  assert.equal(s.f1, 0.5);
  assert.equal(s.accuracy, 0.5);
});

test("manner is scored only where both human and model say parking is present", () => {
  const [s] = scoreRows([
    // Both agree there is parking, manner matches → counted, correct.
    row({ segment_id: "1", human_manner: "perpendicular", model_manner: "perpendicular" }),
    // Both agree, manner differs → counted, wrong.
    row({ segment_id: "2", human_manner: "perpendicular", model_manner: "parallel" }),
    // Human says no parking. Comparing manner here measures nothing and must be excluded,
    // otherwise a model is rewarded for guessing the manner of an empty kerb.
    row({ segment_id: "3", has_parking: false, human_manner: "parallel", model_manner: "parallel" }),
    // Model found nothing, so it has no manner to compare.
    row({ segment_id: "4", model_says_parking: false, model_manner: null })
  ]);
  assert.equal(s.mannerScored, 2);
  assert.equal(s.mannerRight, 1);
  assert.equal(s.mannerAccuracy, 0.5);
});

test("depth bias is negative when the model under-calls the manner", () => {
  // Human says perpendicular (5.5 m band), model says parallel (2.5 m): the recorded strip
  // is 3 m too shallow, so more than half the real parking area is thrown away.
  const [s] = scoreRows([row({ human_manner: "perpendicular", model_manner: "parallel" })]);
  assert.equal(s.mannerScored, 1);
  assert.ok(s.meanDepthBiasM < 0, "under-calling the manner must read as a negative bias");
  assert.equal(Number(s.meanDepthBiasM.toFixed(2)), -3.0);
  assert.equal(Number(s.meanDepthErrM.toFixed(2)), 3.0);
});

test("depth bias is positive when the model over-calls the manner", () => {
  const [s] = scoreRows([row({ human_manner: "parallel", model_manner: "perpendicular" })]);
  assert.ok(s.meanDepthBiasM > 0);
  assert.equal(Number(s.meanDepthBiasM.toFixed(2)), 3.0);
});

test("opposite errors cancel in the bias but not in the absolute error", () => {
  // A model that is wrong in both directions equally has no systematic area bias, but it is
  // not accurate. Reporting only the signed mean would make it look perfect.
  const [s] = scoreRows([
    row({ segment_id: "1", human_manner: "perpendicular", model_manner: "parallel" }),
    row({ segment_id: "2", human_manner: "parallel", model_manner: "perpendicular" })
  ]);
  assert.equal(Number(s.meanDepthBiasM.toFixed(4)), 0);
  assert.equal(Number(s.meanDepthErrM.toFixed(2)), 3.0);
  assert.equal(s.mannerAccuracy, 0);
});

test("runs are scored independently", () => {
  const scores = scoreRows([
    row({ run_id: "a", model: "opus", segment_id: "1" }),
    row({ run_id: "b", model: "kimi", segment_id: "1", model_says_parking: false, model_manner: null })
  ]);
  assert.equal(scores.length, 2);
  const a = scores.find((s) => s.run_id === "a");
  const b = scores.find((s) => s.run_id === "b");
  assert.equal(a.tp, 1);
  assert.equal(b.fn, 1);
  assert.equal(b.recall, 0);
});

test("a run with no positives at all does not report a precision of 1", () => {
  // tp+fp = 0. Dividing would be NaN; reporting 1.0 would make a model that never finds
  // anything look perfectly precise, which is exactly backwards.
  const [s] = scoreRows([
    row({ segment_id: "1", has_parking: true, model_says_parking: false, model_manner: null }),
    row({ segment_id: "2", has_parking: false, model_says_parking: false, model_manner: null })
  ]);
  assert.equal(s.precision, null);
  assert.equal(s.f1, null);
  assert.equal(s.recall, 0);
  assert.equal(s.mannerAccuracy, null);
});
