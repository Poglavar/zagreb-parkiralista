// Prompt variants for the classifier, so "would extra inputs help?" is a measurable
// question rather than an opinion.
//
// Every variant answers the SAME schema over the SAME segments, so runs are directly
// comparable through score-run.mjs. The only thing that differs is what the model is given:
//
//   sv            Street View images only. The baseline — this is prompt v2, unchanged, and
//                 it is what every existing run used.
//   sv-osm        + the segment's OSM tags as text. Nearly free (tens of tokens).
//   sv-ortho      + an annotated orthophoto crop of the segment.
//   sv-osm-ortho  + both.
//
// The variant name is recorded as the run's prompt_version, so a run can always be traced
// back to what it was actually shown.
import { SYSTEM_PROMPT, buildUserPrompt } from "./assessment-schema.mjs";
import { formatTags } from "./osm-tags.mjs";

// Added to the system prompt when an orthophoto is supplied. It has to do two jobs: say
// what the overlay means, and stop the aerial from silently overriding the ground truth
// where the two disagree.
const ORTHO_SYSTEM = `
AERIAL IMAGE:
One additional image is an orthophoto (top-down aerial) of this segment, drawn over with:
- a CYAN LINE tracing this segment's centreline, with an arrowhead at its far end showing
  the direction of travel the left/right labels are relative to,
- "L" marking the segment-LEFT side and "D" marking the segment-RIGHT side,
- a scale bar in metres.

Use it primarily for PARKING MANNER, which is the field it settles best: from above,
perpendicular bays read as a comb of cars at right angles to the kerb, diagonal as a
herringbone, and parallel as a single file along the kerb. The scale bar lets you measure
the depth of the parked strip directly — deeper than about 4 m cannot be parallel parking.

Two cautions, and they matter:
- The aerial and the street-level images were captured YEARS APART. Where they disagree
  about whether cars are present, TRUST THE STREET VIEW IMAGES — they are the more recent
  and more detailed evidence. Use the aerial for geometry, not for occupancy.
- The aerial shows cars parked at one instant. Empty kerb from above does not mean no
  parking, and a full kerb does not by itself mean a designated bay.
`.trim();

const OSM_SYSTEM = `
MAP DATA:
The segment metadata may include OpenStreetMap tags for this street. Treat them as a PRIOR,
not as truth: OSM parking tags in Zagreb are sparse and often stale, and most streets carry
none at all. A tag agreeing with what you see raises confidence; a tag contradicting clear
visual evidence loses to the images. Never report a manner or a side that you cannot also
see, on the strength of a tag alone.
Useful ones: parking:lane:* / parking:* (what the map claims about this kerb), sidewalk
(whether there is a pavement to park on), highway (street class), railway or embedded_rails
(tram tracks — a no-parking signal), oneway and width (which manners physically fit).
`.trim();

export const VARIANTS = {
  sv: {
    name: "sv",
    promptVersion: "v2",
    label: "Street View only (baseline)",
    needsOsm: false,
    needsOrtho: false
  },
  "sv-osm": {
    name: "sv-osm",
    promptVersion: "v3-osm",
    label: "Street View + OSM tags",
    needsOsm: true,
    needsOrtho: false
  },
  "sv-ortho": {
    name: "sv-ortho",
    promptVersion: "v3-ortho",
    label: "Street View + orthophoto",
    needsOsm: false,
    needsOrtho: true
  },
  "sv-osm-ortho": {
    name: "sv-osm-ortho",
    promptVersion: "v3-osm-ortho",
    label: "Street View + OSM tags + orthophoto",
    needsOsm: true,
    needsOrtho: true
  }
};

export function getVariant(name) {
  const v = VARIANTS[name];
  if (!v) throw new Error(`Unknown prompt variant "${name}" (have: ${Object.keys(VARIANTS).join(", ")})`);
  return v;
}

// The system prompt for a variant. The baseline is returned byte-identical to
// SYSTEM_PROMPT — the whole comparison rests on the baseline not having quietly moved.
export function systemPromptFor(variant) {
  const parts = [SYSTEM_PROMPT];
  if (variant.needsOsm) parts.push(OSM_SYSTEM);
  if (variant.needsOrtho) parts.push(ORTHO_SYSTEM);
  return parts.join("\n\n");
}

// The user prompt for a variant, given the per-segment extras.
export function userPromptFor(variant, segment, { osmTags, ortho } = {}) {
  const base = buildUserPrompt(segment);
  const extra = [];

  if (variant.needsOsm) {
    const formatted = formatTags(osmTags);
    // Say so explicitly when there are none. Silence would let the model assume the tags
    // were withheld rather than absent, and "no tags" is itself weak information.
    extra.push(formatted
      ? `OSM tags for this street: ${formatted}`
      : "OSM tags for this street: none recorded.");
  }
  if (variant.needsOrtho) {
    extra.push(ortho
      ? `An orthophoto of this segment is attached (${ortho.label}, about ${ortho.metresPerPixel.toFixed(2)} m per pixel, ${Math.round(ortho.extentM)} m across). The cyan line is this segment; the arrow is the direction the L/D side labels follow.`
      : "No orthophoto is available for this segment — judge from the street-level images alone.");
  }

  return extra.length ? `${base}\n\n${extra.join("\n")}` : base;
}
