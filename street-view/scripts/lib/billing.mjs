// This file centralizes rough Google and OpenAI billing estimates so paid runs can log costs consistently.
const ONE_MILLION = 1_000_000;
const GOOGLE_STREET_VIEW_STATIC_FIRST_TIER_USD_PER_IMAGE = 0.007;
const GOOGLE_STREET_VIEW_STATIC_FREE_MONTHLY_IMAGES = 10_000;

const OPENAI_MODEL_PRICING = [
  {
    prefix: "gpt-5.4-mini",
    input: 0.75,
    cachedInput: 0.075,
    output: 4.5
  },
  {
    prefix: "gpt-5.4-nano",
    input: 0.2,
    cachedInput: 0.02,
    output: 1.25
  },
  {
    prefix: "gpt-5.4",
    input: 2.5,
    cachedInput: 0.25,
    output: 15
  }
];

// OpenAI's vision docs list GPT-5 image token rules. We infer GPT-5.4 uses the same schedule because it is a GPT-5-family model.
const GPT_5_FAMILY_IMAGE_BASE_TOKENS = 70;
const GPT_5_FAMILY_IMAGE_TILE_TOKENS = 140;

function roundUsd(value) {
  return Number(value.toFixed(6));
}

function roundNumber(value) {
  return Number(value.toFixed(3));
}

function scaleToFitWithinBox(width, height, maxWidth, maxHeight) {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: width * scale,
    height: height * scale
  };
}

function computeHighDetailTokens(width, height) {
  const clamped = scaleToFitWithinBox(width, height, 2048, 2048);
  const shortestSide = Math.min(clamped.width, clamped.height);
  const scale = shortestSide === 0 ? 1 : 768 / shortestSide;
  const resized = {
    width: clamped.width * scale,
    height: clamped.height * scale
  };
  const tiles = Math.ceil(resized.width / 512) * Math.ceil(resized.height / 512);
  return GPT_5_FAMILY_IMAGE_BASE_TOKENS + tiles * GPT_5_FAMILY_IMAGE_TILE_TOKENS;
}

export function parseSizeString(size) {
  if (typeof size !== "string") return null;
  const match = size.match(/^(\d+)x(\d+)$/i);
  if (!match) return null;
  return {
    width: Number(match[1]),
    height: Number(match[2])
  };
}

export function getOpenAiModelPricing(model) {
  const resolved = OPENAI_MODEL_PRICING.find((item) => String(model).startsWith(item.prefix));
  return resolved || null;
}

export function estimateGpt5FamilyImageTokens({ width, height, detail }) {
  const normalizedDetail = detail || "auto";
  const highTokens = computeHighDetailTokens(width, height);

  if (normalizedDetail === "low") {
    return {
      detail: normalizedDetail,
      kind: "exact",
      min_tokens: GPT_5_FAMILY_IMAGE_BASE_TOKENS,
      max_tokens: GPT_5_FAMILY_IMAGE_BASE_TOKENS,
      assumption: "Uses the GPT-5-family low-detail fixed image token cost."
    };
  }

  if (normalizedDetail === "high") {
    return {
      detail: normalizedDetail,
      kind: "exact",
      min_tokens: highTokens,
      max_tokens: highTokens,
      assumption: "Uses the GPT-5-family high-detail tile formula."
    };
  }

  return {
    detail: normalizedDetail,
    kind: "range",
    min_tokens: GPT_5_FAMILY_IMAGE_BASE_TOKENS,
    max_tokens: highTokens,
    assumption: "OpenAI may choose low or high image detail when detail=auto."
  };
}

export function estimateOpenAiImageInputCost({ model, imageCount, width, height, detail = "auto", batchMode = false }) {
  const pricing = getOpenAiModelPricing(model);
  if (!pricing || !imageCount || !width || !height) {
    return null;
  }

  const tokenEstimate = estimateGpt5FamilyImageTokens({ width, height, detail });
  const discountMultiplier = batchMode ? 0.5 : 1;
  const minTokens = tokenEstimate.min_tokens * imageCount;
  const maxTokens = tokenEstimate.max_tokens * imageCount;

  return {
    model,
    detail,
    image_count: imageCount,
    width,
    height,
    batch_mode: batchMode,
    pricing_source_note: "Model text-token pricing is from the OpenAI pricing page; image token math is inferred from the GPT-5-family vision docs.",
    rates_usd_per_1m_tokens: {
      input: pricing.input,
      cached_input: pricing.cachedInput,
      output: pricing.output
    },
    image_tokens: {
      kind: tokenEstimate.kind,
      min: minTokens,
      max: maxTokens,
      assumption: tokenEstimate.assumption
    },
    estimated_image_input_cost_usd: {
      min: roundUsd((minTokens / ONE_MILLION) * pricing.input * discountMultiplier),
      max: roundUsd((maxTokens / ONE_MILLION) * pricing.input * discountMultiplier)
    }
  };
}

export function calculateOpenAiUsageCost({ model, usage, batchMode = false }) {
  const pricing = getOpenAiModelPricing(model);
  if (!pricing || !usage) {
    return null;
  }

  const inputTokens = Number(usage.input_tokens || 0);
  const outputTokens = Number(usage.output_tokens || 0);
  const cachedInputTokens = Number(usage.input_tokens_details?.cached_tokens || 0);
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const discountMultiplier = batchMode ? 0.5 : 1;

  const inputCostUsd =
    (((uncachedInputTokens / ONE_MILLION) * pricing.input) +
      ((cachedInputTokens / ONE_MILLION) * pricing.cachedInput)) *
    discountMultiplier;
  const outputCostUsd = ((outputTokens / ONE_MILLION) * pricing.output) * discountMultiplier;

  return {
    model,
    batch_mode: batchMode,
    rates_usd_per_1m_tokens: {
      input: pricing.input,
      cached_input: pricing.cachedInput,
      output: pricing.output
    },
    usage_tokens: {
      input: inputTokens,
      cached_input: cachedInputTokens,
      uncached_input: uncachedInputTokens,
      output: outputTokens,
      total: Number(usage.total_tokens || inputTokens + outputTokens),
      reasoning: Number(usage.output_tokens_details?.reasoning_tokens || 0)
    },
    estimated_cost_usd: {
      input: roundUsd(inputCostUsd),
      output: roundUsd(outputCostUsd),
      total: roundUsd(inputCostUsd + outputCostUsd)
    }
  };
}

export function summarizeOpenAiCosts(costItems) {
  const totals = {
    input: 0,
    output: 0,
    total: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    uncached_input_tokens: 0
  };

  for (const item of costItems) {
    if (!item) continue;
    totals.input += Number(item.estimated_cost_usd?.input || 0);
    totals.output += Number(item.estimated_cost_usd?.output || 0);
    totals.total += Number(item.estimated_cost_usd?.total || 0);
    totals.input_tokens += Number(item.usage_tokens?.input || 0);
    totals.output_tokens += Number(item.usage_tokens?.output || 0);
    totals.cached_input_tokens += Number(item.usage_tokens?.cached_input || 0);
    totals.uncached_input_tokens += Number(item.usage_tokens?.uncached_input || 0);
  }

  return {
    estimated_cost_usd: {
      input: roundUsd(totals.input),
      output: roundUsd(totals.output),
      total: roundUsd(totals.total)
    },
    usage_tokens: {
      input: Math.round(totals.input_tokens),
      output: Math.round(totals.output_tokens),
      cached_input: Math.round(totals.cached_input_tokens),
      uncached_input: Math.round(totals.uncached_input_tokens),
      total: Math.round(totals.input_tokens + totals.output_tokens)
    }
  };
}

export function estimateGoogleStreetViewImageCost(imageRequestCount) {
  return {
    pricing_source_note: "Street View Static image requests are billable; metadata requests are documented as free.",
    free_monthly_image_threshold: GOOGLE_STREET_VIEW_STATIC_FREE_MONTHLY_IMAGES,
    billable_image_requests: imageRequestCount,
    estimated_cost_usd_if_free_quota_remaining: 0,
    estimated_cost_usd_if_first_paid_tier_applies: roundUsd(
      imageRequestCount * GOOGLE_STREET_VIEW_STATIC_FIRST_TIER_USD_PER_IMAGE
    ),
    first_paid_tier_usd_per_image: GOOGLE_STREET_VIEW_STATIC_FIRST_TIER_USD_PER_IMAGE
  };
}

export function summarizeOpenAiImageEstimate(estimate) {
  if (!estimate) return "no estimate available";
  return `$${roundNumber(estimate.estimated_image_input_cost_usd.min)}-$${roundNumber(estimate.estimated_image_input_cost_usd.max)} image-input estimate`;
}
