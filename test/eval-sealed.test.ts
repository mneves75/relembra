import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const git = (...args: string[]) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
const inWorkTree = git("rev-parse", "--is-inside-work-tree").stdout.trim() === "true";

// Ticket 18: a sealed set of real questions is scored locally (eval/README.md, "A sealed set")
// and never committed, since real questions carry personal data.
(inWorkTree ? describe : describe.skip)("the sealed eval set stays out of the repository", () => {
  test("git ignores eval/sealed/", () => {
    // Positive control first: a file there would be ignored, so the empty listing below means
    // something.
    expect(git("check-ignore", "-q", "eval/sealed/questions.jsonl").status).toBe(0);
    expect(git("check-ignore", "-q", "eval/README.md").status).toBe(1);
  });

  test("nothing under eval/sealed/ is tracked", () => {
    const listed = git("ls-files", "--", "eval/sealed");
    expect(listed.status).toBe(0);
    expect(listed.stdout).toBe("");
  });
});
