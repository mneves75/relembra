/**
 * scripts/site/assemble.sh builds what GitHub Pages serves: a commit's site/ tree, plus the video
 * files from the gh-pages branch, each checked against the committed scripts/site/video.sha256,
 * plus .nojekyll. It refuses a video whose bytes differ, and a page pointing at a missing asset.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const script = join(import.meta.dir, "..", "scripts", "site", "assemble.sh");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

/** A repository whose main commit has site/ and the manifest, and whose gh-pages has the video. */
function fixture(options: { video?: string; page?: string } = {}): string {
  const repo = mkdtempSync(join(tmpdir(), "relembra-assemble-"));
  dirs.push(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "test");
  mkdirSync(join(repo, "site", "assets"), { recursive: true });
  mkdirSync(join(repo, "scripts", "site"), { recursive: true });
  const page =
    options.page ?? '<link href="assets/site.css"><video src="assets/video/clip.mp4"></video>';
  writeFileSync(join(repo, "site", "index.html"), page);
  writeFileSync(join(repo, "site", "assets", "site.css"), "body{}");
  writeFileSync(join(repo, "scripts", "site", "video.sha256"), `${sha256("clip")}  clip.mp4\n`);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "main");
  git(repo, "switch", "-q", "--orphan", "gh-pages");
  rmSync(join(repo, "site"), { recursive: true, force: true });
  rmSync(join(repo, "scripts"), { recursive: true, force: true });
  mkdirSync(join(repo, "assets", "video"), { recursive: true });
  writeFileSync(join(repo, "assets", "video", "clip.mp4"), options.video ?? "clip");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "pages");
  git(repo, "update-ref", "refs/remotes/origin/gh-pages", "HEAD");
  git(repo, "switch", "-q", "main");
  return repo;
}

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

function assemble(repo: string) {
  const out = join(repo, "..", `${relative(tmpdir(), repo)}-out`);
  dirs.push(out);
  const run = spawnSync("bash", [script, out], { cwd: repo, encoding: "utf8" });
  return { ...run, out };
}

describe("site assembly", () => {
  test("ships the commit's site/, the checked video and .nojekyll (positive control)", () => {
    const run = assemble(fixture());
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(files(run.out)).toEqual([
      ".nojekyll",
      "assets/site.css",
      "assets/video/clip.mp4",
      "index.html",
    ]);
    expect(readFileSync(join(run.out, "assets", "video", "clip.mp4"), "utf8")).toBe("clip");
  });

  test("ships the committed site/, not the working tree", () => {
    const repo = fixture();
    writeFileSync(join(repo, "site", "index.html"), "uncommitted");
    const run = assemble(repo);
    expect(run.status).toBe(0);
    expect(readFileSync(join(run.out, "index.html"), "utf8")).toContain("clip.mp4");
  });

  test("refuses a video whose bytes differ from video.sha256", () => {
    const run = assemble(fixture({ video: "tampered" }));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("clip.mp4 does not match scripts/site/video.sha256");
  });

  test("refuses a page that points at an asset the site does not ship", () => {
    const run = assemble(fixture({ page: '<img src="assets/missing.png">' }));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("assets/missing.png");
  });

  test("a relative output path means the caller's directory, never the repository root", () => {
    const repo = fixture();
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "site", "local.txt"), "uncommitted work");
    // From sub/, "site" names sub/site, which does not exist; the root's site/ must stay untouched.
    const run = spawnSync("bash", [script, "site"], { cwd: join(repo, "sub"), encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(files(join(repo, "sub", "site"))).toContain("index.html");
    expect(files(join(repo, "site")).sort()).toEqual([
      "assets/site.css",
      "index.html",
      "local.txt",
    ]);
  });

  test("refuses an output directory that already exists", () => {
    const repo = fixture();
    const first = assemble(repo);
    expect(first.status).toBe(0);
    const again = spawnSync("bash", [script, first.out], { cwd: repo, encoding: "utf8" });
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain("already exists");
  });
});
