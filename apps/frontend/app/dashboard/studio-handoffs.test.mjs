import assert from "node:assert/strict";
import { test } from "node:test";
import { selectHandoffs } from "./studio-handoffs.ts";

test("latest role versions appear first and superseded versions remain inspectable", () => {
  const old = { id: "old", agent: "frontend" };
  const backend = { id: "backend", agent: "backend" };
  const latest = { id: "latest", agent: "frontend" };
  const input = [old, backend, latest];
  assert.deepEqual(selectHandoffs(input), { current: [latest, backend], historical: [old] });
  assert.deepEqual(input, [old, backend, latest]);
});

test("gate-reviewed versions stay visible with newer versions and legacy records work", () => {
  const accepted = { id: "accepted", agent: "frontend" };
  const latest = { id: "latest", agent: "frontend" };
  assert.deepEqual(selectHandoffs([accepted, latest], ["accepted"]).current, [accepted, latest]);
  assert.equal(selectHandoffs([{ agent: "qa" }, { agent: "qa" }]).historical.length, 1);
  assert.deepEqual(selectHandoffs([]), { current: [], historical: [] });
});
