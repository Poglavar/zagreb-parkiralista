// This file builds a small catalog of generated review bundles so the static reviewer can open specific runs.
function normalizeTimestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isReviewBundleFileName(fileName) {
  return /review-bundle.*\.json$/i.test(fileName) && fileName !== "review-bundle-catalog.json";
}

export function summarizeReviewBundleFile(fileName, payload) {
  return {
    file_name: fileName,
    path: `./out/${fileName}`,
    generated_at: payload.generated_at || null,
    segment_count: Number(payload.segment_count || payload.segments?.length || 0),
    candidates: payload.candidates || null,
    analyses: payload.analyses || null,
    label: fileName
      .replace(/\.json$/i, "")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase())
  };
}

export function buildReviewBundleCatalog(filePayloadPairs) {
  return filePayloadPairs
    .filter((item) => item?.fileName && item?.payload)
    .map((item) => summarizeReviewBundleFile(item.fileName, item.payload))
    .sort((left, right) => {
      const timeDiff = normalizeTimestamp(right.generated_at) - normalizeTimestamp(left.generated_at);
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return left.file_name.localeCompare(right.file_name);
    });
}
