// Tests for the batch result JSONL parser used by import-openai-batch.mjs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBatchResultsJsonl } from "../scripts/import-openai-batch.mjs";

describe("parseBatchResultsJsonl", () => {
  it("parses a successful result line", () => {
    const assessment = {
      decision: "both",
      confidence: 0.85,
      overall_notes: "Parking on both sides.",
      segment_left: {
        parking_present: true,
        parking_manner: "parallel",
        parking_level: "road_level",
        formality: "formal",
        confidence: 0.9,
        evidence: ["marked bays"]
      },
      segment_right: {
        parking_present: true,
        parking_manner: "parallel",
        parking_level: "sidewalk",
        formality: "informal",
        confidence: 0.7,
        evidence: ["cars on sidewalk"]
      }
    };

    const line = JSON.stringify({
      id: "batch_req_abc",
      custom_id: "segment-525",
      response: {
        status_code: 200,
        body: {
          id: "resp_xyz",
          model: "gpt-5.4",
          output_text: JSON.stringify(assessment),
          usage: {
            input_tokens: 5000,
            output_tokens: 200,
            total_tokens: 5200
          }
        }
      },
      error: null
    });

    const results = parseBatchResultsJsonl(line);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].segment_id, "525");
    assert.equal(results[0].response_id, "resp_xyz");
    assert.equal(results[0].model, "gpt-5.4");
    assert.deepEqual(results[0].assessment, assessment);
    assert.equal(results[0].usage.input_tokens, 5000);
  });

  it("parses an error result line", () => {
    const line = JSON.stringify({
      id: "batch_req_def",
      custom_id: "segment-526",
      response: null,
      error: { message: "Rate limit exceeded" }
    });

    const results = parseBatchResultsJsonl(line);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.equal(results[0].segment_id, "526");
    assert.match(results[0].error, /Rate limit exceeded/);
  });

  it("handles non-200 response status", () => {
    const line = JSON.stringify({
      id: "batch_req_ghi",
      custom_id: "segment-529",
      response: {
        status_code: 400,
        body: { error: { message: "Invalid request" } }
      },
      error: null
    });

    const results = parseBatchResultsJsonl(line);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.equal(results[0].segment_id, "529");
    assert.match(results[0].error, /400/);
  });

  it("handles malformed assessment JSON in response", () => {
    const line = JSON.stringify({
      id: "batch_req_jkl",
      custom_id: "segment-556",
      response: {
        status_code: 200,
        body: {
          id: "resp_bad",
          model: "gpt-5.4",
          output_text: "not valid json {",
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
        }
      },
      error: null
    });

    const results = parseBatchResultsJsonl(line);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /Failed to parse JSON/);
  });

  it("parses multiple lines", () => {
    const assessment = {
      decision: "none",
      confidence: 0.95,
      overall_notes: "No parking.",
      segment_left: {
        parking_present: false,
        parking_manner: "none",
        parking_level: "road_level",
        formality: "unknown",
        confidence: 0.95,
        evidence: []
      },
      segment_right: {
        parking_present: false,
        parking_manner: "none",
        parking_level: "road_level",
        formality: "unknown",
        confidence: 0.95,
        evidence: []
      }
    };

    const lines = [
      JSON.stringify({
        id: "batch_req_1",
        custom_id: "segment-100",
        response: { status_code: 200, body: { id: "r1", model: "gpt-5.4", output_text: JSON.stringify(assessment), usage: { input_tokens: 1000, output_tokens: 50, total_tokens: 1050 } } },
        error: null
      }),
      JSON.stringify({
        id: "batch_req_2",
        custom_id: "segment-200",
        response: null,
        error: { message: "timeout" }
      })
    ].join("\n");

    const results = parseBatchResultsJsonl(lines);
    assert.equal(results.length, 2);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].segment_id, "100");
    assert.equal(results[1].ok, false);
    assert.equal(results[1].segment_id, "200");
  });

  it("extracts text from nested output when output_text is missing", () => {
    const assessment = { decision: "left", confidence: 0.8, overall_notes: "Left side only.", segment_left: { parking_present: true, parking_manner: "parallel", parking_level: "road_level", formality: "formal", confidence: 0.8, evidence: ["marked"] }, segment_right: { parking_present: false, parking_manner: "none", parking_level: "road_level", formality: "unknown", confidence: 0.9, evidence: [] } };

    const line = JSON.stringify({
      id: "batch_req_nested",
      custom_id: "segment-999",
      response: {
        status_code: 200,
        body: {
          id: "resp_nested",
          model: "gpt-5.4",
          output: [
            {
              content: [
                { type: "text", text: JSON.stringify(assessment) }
              ]
            }
          ],
          usage: { input_tokens: 2000, output_tokens: 100, total_tokens: 2100 }
        }
      },
      error: null
    });

    const results = parseBatchResultsJsonl(line);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.deepEqual(results[0].assessment, assessment);
  });
});
