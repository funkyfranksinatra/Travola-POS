// tests/floor-state.test.ts — the floor-state translation contract.
//
// These are the rules that decide what a server SEES on the terminal.
// Each case here corresponds to a bug that reached a screenshot:
// merged tables reading as two parties, last night's guests still
// "seated" at open, and rotated tables drifting out of the room.
import { test } from "node:test";
import assert from "node:assert/strict";
import { posState, tileSizePx, rotatedSizePx, latestServiceResetBoundary } from "../lib/floor-geometry.ts";


test("floor status maps to distinct terminal states", () => {
  assert.equal(posState("seated"), "sat");
  assert.equal(posState("dining"), "sat");
  assert.equal(posState("available"), "open");
  // bussing must NOT collapse into "done": one is work still to do,
  // the other is a settled check.
  assert.equal(posState("bussing"), "bussing");
  assert.notEqual(posState("bussing"), "done");
  assert.equal(posState("reserved"), "reserved");
  assert.equal(posState("something-new"), "open"); // unknown = safe default
});

test("tile sizes mirror the floor app's capacity buckets", () => {
  assert.deepEqual(tileSizePx("square", 2), { w: 64, h: 64 });
  assert.deepEqual(tileSizePx("square", 4), { w: 80, h: 80 });
  assert.deepEqual(tileSizePx("square", 8), { w: 96, h: 96 });
  assert.deepEqual(tileSizePx("rectangle", 2), { w: 80, h: 64 });
  assert.deepEqual(tileSizePx("rectangle", 8), { w: 176, h: 64 });
});

test("a rotated table's footprint uses its rotated extents", () => {
  const flat = rotatedSizePx("rectangle", 8, 0); // 176 x 64
  assert.equal(Math.round(flat.w), 176);
  assert.equal(Math.round(flat.h), 64);
  // Turned on its side, width and height swap — ignoring this let a
  // rotated communal table push the room's bounding box off.
  const turned = rotatedSizePx("rectangle", 8, 90);
  assert.equal(Math.round(turned.w), 64);
  assert.equal(Math.round(turned.h), 176);
  // 180° is the same footprint as flat; negatives normalize.
  assert.deepEqual(rotatedSizePx("rectangle", 8, 180), flat);
  assert.deepEqual(rotatedSizePx("rectangle", 8, -90), turned);
});

test("service-reset boundary matches the floor app's rule", () => {
  // Close 22:00 (1320) → boundary is close + 90min = 23:30.
  const evening = new Date(2026, 7, 26, 20, 0, 0); // 8pm, before the tick
  const b1 = latestServiceResetBoundary(evening, 660, 1320);
  assert.equal(b1.getHours(), 23);
  assert.equal(b1.getMinutes(), 30);
  // Before the tick, the boundary belongs to the PREVIOUS day, so
  // tonight's live state stays live.
  assert.equal(b1.getDate(), 25);
  assert.ok(b1 < evening);

  // After the tick, the boundary is tonight — yesterday reads clean.
  const lateNight = new Date(2026, 7, 26, 23, 45, 0);
  const b2 = latestServiceResetBoundary(lateNight, 660, 1320);
  assert.equal(b2.getDate(), 26);
  assert.ok(b2 < lateNight);
});

test("reset boundary falls back sanely when hours are unset", () => {
  const noon = new Date(2026, 7, 26, 12, 0, 0);
  // No hours at all → 4:00 AM.
  const b = latestServiceResetBoundary(noon, null, null);
  assert.equal(b.getHours(), 4);
  assert.equal(b.getMinutes(), 0);
  // Open only → one hour before opening.
  const b2 = latestServiceResetBoundary(noon, 660, null); // 11:00 → 10:00
  assert.equal(b2.getHours(), 10);
});

test("overnight service does not reset mid-shift", () => {
  // Open 17:00 (1020), close 02:00 (120) — the boundary must land after
  // close, not in the middle of the dinner rush.
  const duringService = new Date(2026, 7, 26, 22, 0, 0);
  const b = latestServiceResetBoundary(duringService, 1020, 120);
  assert.ok(b < duringService, "boundary is in the past during service");
  // 02:00 + 90min = 03:30 the next morning.
  assert.equal(b.getHours(), 3);
  assert.equal(b.getMinutes(), 30);
});
