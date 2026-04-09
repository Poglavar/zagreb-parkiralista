// This file applies intentional spacing between outbound requests so live runs stay conservative on provider rate limits.
import { setTimeout as delay } from "timers/promises";

export async function waitForRequestGap(delayMs, requestIndex) {
  if (!delayMs || requestIndex <= 0) {
    return;
  }
  await delay(delayMs);
}
