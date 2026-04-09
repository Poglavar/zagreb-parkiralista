<!-- This README explains the self-contained Street View proof of concept and how to run it. -->
# Street View POC

This folder contains a self-contained proof of concept for segment-level curbside parking detection from street-level imagery.

The goal is to validate four things without touching the rest of the repo:

1. Can we take real road segments and derive stable capture points?
2. Can Google Street View be used as a stable capture provider?
3. Can `gpt-5.4` classify parking behavior from those images well enough for a review loop?
4. Can we close the loop locally with file outputs plus a static human-review UI?

## Recommendation

- Use the **Street View Static API** as the primary capture provider.
- Use **Google Maps panorama URLs** only as a QA fallback, not as the main automation path.
- Use **OpenAI `gpt-5.4`** first for semantic classification.
- Do **not** start with SAM for this phase. SAM is better for later geometry refinement, not for the first yes/no/left/right/formal/informal decision.
- Keep a deliberate gap between outbound calls. The live scripts now default to **1,000ms** spacing between API requests.

Why:

- The Static API has a free metadata endpoint, deterministic camera parameters, and no browser consent wall.
- Browser-driven Google Maps immediately runs into consent UI and brittle DOM automation.
- `gpt-5.4` is better matched to this task because the first problem is semantic scene understanding, not pixel-perfect segmentation.
- SAM only becomes attractive later if we decide we need curb masks, sidewalk masks, or parked-car masks to refine polygons.

## Pricing and Provider Notes

- Google Street View Static API bills **per panorama request**.
- Google documents **up to 10,000 free API calls per SKU per month**, then pay-as-you-go.
- The current Google developer pricing snippet for **Static Street View** shows **$7.00 per 1,000 panoramas** for the first volume tier and **$5.60 per 1,000** for the next tier.
- Google states that **Street View metadata requests are free** and do not consume image quota.
- OpenAI currently lists **GPT-5.4 input at $2.50 / 1M tokens** and **output at $15.00 / 1M tokens**, and notes that the **Batch API saves 50%** on inputs and outputs.

For this POC, the intended production flow is:

1. Generate segment capture candidates.
2. Preflight every capture with free Street View metadata.
3. Fetch only metadata-valid images.
4. Run `gpt-5.4` on the valid image sets.
5. Send only uncertain or high-impact cases into human review.

The paid-call scripts now log billing summaries:

- `fetch-street-view-images.mjs` logs the number of billable Google image requests and the first-tier cost if you are outside the free monthly threshold.
- `analyze-openai.mjs` logs an image-input cost estimate before the run and records actual token-usage cost estimates from the API response after each call.
- If you want tighter OpenAI cost control, run `analyze-openai.mjs --image-detail low` so image-token cost stays predictable.

## Folder Layout

```text
street-view/
├── data/
│   └── demo-selection.mjs          # demo segment IDs pulled from zagreb-road-widths
├── scripts/
│   ├── lib/
│   │   ├── geo.mjs                 # geometry helpers
│   │   ├── io.mjs                  # JSON/text helpers
│   │   └── parking.mjs             # curb-strip polygon builders
│   ├── import-road-width-demo.mjs  # import a few trimmed segments
│   ├── prepare-candidates.mjs      # derive stations, headings, URLs, preview polygons
│   ├── fetch-street-view-metadata.mjs
│   ├── fetch-street-view-images.mjs
│   ├── analyze-openai.mjs
│   ├── build-parking-areas.mjs
│   ├── build-review-bundle.mjs
│   └── mock-run.mjs                # offline demo path with placeholder images + mock AI
├── review.html
├── review.css
├── review.js
└── test/
```

## Quick Start

### Offline demo

This uses real trimmed road segments from `zagreb-road-widths`, but generates placeholder images and mock AI output so the review loop can be opened immediately.

```sh
cd street-view
npm run mock:run
npm run serve
```

Then open `http://localhost:8015/review.html`.

### Real segment prep

```sh
cd street-view
npm run prepare:demo
```

This writes:

- `data/demo-segments.geojson`
- `out/candidates.json`

### Live metadata + image capture

Add a key first:

```sh
export GOOGLE_MAPS_API_KEY=...
```

Then:

```sh
cd street-view
npm run fetch:metadata
npm run fetch:images
```

Both scripts default to `--delay-ms 1000`.

This writes:

- `out/street-view-metadata.json`
- `out/images/*.jpg`

### Live OpenAI analysis

Add a key first:

```sh
export OPENAI_API_KEY=...
```

Then:

```sh
cd street-view
npm run analyze:openai
npm run build:polygons
npm run build:bundle
```

The OpenAI script defaults to `--delay-ms 1000` and `--image-detail auto`. Use `--image-detail low` if you want lower and more predictable image-input costs.

This writes:

- `out/openai-analyses.json`
- `out/parking-areas.geojson`
- `out/review-bundle.json`

## Review UI

The review UI is intentionally static.

- It loads `out/review-bundle.json`.
- It stores local overrides in `localStorage`.
- It can export those overrides as JSON.
- Those overrides can then be fed back into `build-parking-areas.mjs` with `--overrides`.

This keeps the POC file-based while still proving the human-review loop.

## Current Limits

- Demo segment imports come from `zagreb-road-widths`, which gives trimmed segment geometry and width but not clean street names.
- Very long or curved roads are split into multiple capture stations, but this is still a heuristic.
- Curb polygons are intentionally approximate bands along the segment side, not cadastral-grade geometry.
- The browser-driven Google Maps path is documented as a fallback only; the implementation favors the official Static API.

## Sources

- Google Street View Static API usage and billing:
  https://developers.google.com/maps/documentation/streetview/usage-and-billing
- Google Street View request format:
  https://developers.google.com/maps/documentation/streetview/request-streetview
- Google Street View metadata:
  https://developers.google.com/maps/documentation/streetview/metadata
- Google Maps URLs:
  https://developers.google.com/maps/documentation/urls/get-started
- Google Maps Platform pricing:
  https://mapsplatform.google.com/pricing/
- Google pricing snippet with Static Street View tier values:
  https://developers.google.com/maps/billing-and-pricing/pricing-old
- OpenAI API pricing:
  https://openai.com/api/pricing/
