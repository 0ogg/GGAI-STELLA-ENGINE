import assert from "node:assert/strict";
import {
  hasNsfwTag,
  isHourInRange,
  isNsfwIllustration,
  shouldHideDashboardNsfw,
} from "../src/util/dashboard-content-safety";
import { latestMatchingIllustrationVariant } from "../src/util/illustrations";
import type { IllustrationVariant, SessionIllustrations } from "../src/types/media";

const variant = (
  id: string,
  createdAt: number,
  prompt: string,
  tags?: string[]
): IllustrationVariant => ({
  id,
  kind: "ai-illustration",
  sourceNodeId: id,
  path: `assets/${id}.png`,
  createdAt,
  updatedAt: createdAt,
  prompt,
  tags,
});

assert.equal(shouldHideDashboardNsfw(undefined, { isMobile: true, isFocused: false, hour: 12 }), false);
assert.equal(shouldHideDashboardNsfw({ mobile: true }, { isMobile: true, isFocused: true, hour: 12 }), true);
assert.equal(shouldHideDashboardNsfw({ mobile: true }, { isMobile: false, isFocused: true, hour: 12 }), false);
assert.equal(shouldHideDashboardNsfw({ unfocused: true }, { isMobile: false, isFocused: false, hour: 12 }), true);
assert.equal(shouldHideDashboardNsfw({ schedule: true, scheduleStartHour: 9, scheduleEndHour: 18 }, { isMobile: false, isFocused: true, hour: 9 }), true);
assert.equal(shouldHideDashboardNsfw({ schedule: true, scheduleStartHour: 22, scheduleEndHour: 7 }, { isMobile: false, isFocused: true, hour: 2 }), true);
assert.equal(isHourInRange(18, 9, 18), false);
assert.equal(isHourInRange(4, 4, 4), true);

assert.equal(hasNsfwTag(["NSFW"], ""), true);
assert.equal(hasNsfwTag(undefined, "masterpiece, nsfw, 1girl"), true);
assert.equal(hasNsfwTag(undefined, "masterpiece, {nsfw}, 1girl"), true);
assert.equal(hasNsfwTag(undefined, "sfw, newsfwstyle"), false);
assert.equal(isNsfwIllustration(variant("tagged", 1, "safe prompt", ["nsfw"])), true);

const safe = variant("safe", 10, "landscape, sfw");
const unsafe = variant("unsafe", 20, "portrait, nsfw");
const illustrations: SessionIllustrations = {
  schemaVersion: 1,
  nodes: {
    node: {
      activeVariantId: unsafe.id,
      variants: { safe, unsafe },
    },
  },
};
assert.equal(
  latestMatchingIllustrationVariant(illustrations, (item) => !isNsfwIllustration(item))?.id,
  "safe"
);

console.log("dashboard-content-safety: ok");
