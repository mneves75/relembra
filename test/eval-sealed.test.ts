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
    expect(git("check-ignore", "-q", "eval/sealed/questions.jsonl").status).toBe(0);
    // Positive control: a file outside eval/sealed/ is not ignored.
    expect(git("check-ignore", "-q", "eval/README.md").status).toBe(1);
  });

  test("nothing under eval/sealed/ is tracked", () => {
    const listed = git("ls-files", "--", "eval/sealed");
    expect(listed.status).toBe(0);
    expect(listed.stdout).toBe("");
    // Positive control: the same listing names a tracked file, so an empty one means none.
    expect(git("ls-files", "--", "eval/README.md").stdout).toBe("eval/README.md\n");
  });
});
