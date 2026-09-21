import { expect, test } from "bun:test";
import { mergeToolActivity } from "./copilot-types";

test("a completion update preserves the real tool title and requested input", () => {
  const input = { command: "Write-Output 'verified'" };
  const pending = mergeToolActivity(undefined, {
    title: "Print verification marker",
    status: "pending",
    input,
  });
  const output = [{ type: "text", text: "verified" }];
  const completed = mergeToolActivity(pending, { status: "completed", output });
  expect(completed).toEqual({
    title: "Print verification marker",
    status: "completed",
    input,
    output,
  });
  expect(pending.status).toBe("pending");
});

test("status-only updates keep the latest tool output", () => {
  const working = mergeToolActivity(undefined, {
    title: "Read process status",
    status: "in_progress",
    output: "Still running",
  });
  expect(mergeToolActivity(working, { status: "failed" })).toEqual({
    ...working,
    status: "failed",
  });
});

test("explicit new output replaces the previous output without losing metadata", () => {
  const previous = mergeToolActivity(undefined, {
    title: "Read process status",
    status: "in_progress",
    output: "Partial output",
  });
  expect(mergeToolActivity(previous, { output: [] })).toEqual({
    ...previous,
    output: [],
  });
});

test("missing initial tool metadata is described without inventing a tool name", () => {
  expect(mergeToolActivity(undefined, { status: "completed" }).title).toBe(
    "Tool call",
  );
});

test("blank update titles do not erase a known tool identity", () => {
  const previous = mergeToolActivity(undefined, {
    title: "Create review artifact",
  });
  expect(
    mergeToolActivity(previous, { title: "  ", status: "completed" }).title,
  ).toBe("Create review artifact");
});
