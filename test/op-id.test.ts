import { describe, expect, test } from "bun:test";
import { integrationOpId } from "relembra";

describe("integration op ids", () => {
  test('are "v1:" and the SHA-256 of the JSON tuple', () => {
    // Expected value computed outside relembra:
    // printf '%s' '["host","conv","task","call"]' | shasum -a 256
    expect(integrationOpId("host", "conv", "task", "call")).toBe(
      "v1:24e4180aceb253545ad405388305e5e8a842a9b410f27164ea3a71329d37ad6b",
    );
  });

  test("components that would collide when joined with a delimiter give different ids", () => {
    const joinedLeft = integrationOpId("host", "1", "2", "3:4");
    const joinedRight = integrationOpId("host:1", "2", "3", "4");

    // Positive control: the colon-joined forms really are equal, so only the tuple keeps them apart.
    expect(["host", "1", "2", "3:4"].join(":")).toBe(["host:1", "2", "3", "4"].join(":"));
    expect(joinedLeft).not.toBe(joinedRight);
  });

  test("the same components always give the same id, and any change gives another", () => {
    const id = integrationOpId("host", "conv", "task", "call");

    expect(integrationOpId("host", "conv", "task", "call")).toBe(id);
    expect(integrationOpId("host", "conv", "task", "call-2")).not.toBe(id);
    expect(integrationOpId("host", "conv", "task2", "call")).not.toBe(id);
  });

  test("long components still give an op id within the 256-byte cap", () => {
    const long = "x".repeat(10_000);

    const id = integrationOpId(long, long, long, `${long}é😀`);

    expect(id).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(id).not.toBe(integrationOpId(long, long, long, long));
  });

  test("a component that is not a string is refused", () => {
    expect(() => integrationOpId("host", 1 as unknown as string, "task", "call")).toThrow(
      TypeError,
    );
  });
});
