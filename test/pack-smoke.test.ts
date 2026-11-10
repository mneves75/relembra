/**
 * scripts/pack-smoke.ts --tarball: Node and Bun each install and run one supplied archive, which
 * stays as it was, and nothing is rebuilt. The archive is packed from a copy of the sources under
 * .scratch, so this never writes the checkout's dist/ while the gate packs from it. The copy sits
 * inside the repository so its build resolves the same node_modules.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { NO_RELEASE_TOOLING } from "./platform-support.js";

const ROOT = join(import.meta.dir, "..");
const SMOKE = join(ROOT, "scripts", "pack-smoke.ts");
mkdirSync(join(ROOT, ".scratch"), { recursive: true });
const copy = mkdtempSync(join(ROOT, ".scratch", "pack-smoke-test-"));
afterAll(() => rmSync(copy, { recursive: true, force: true }));

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
/**
 * npm reads npm_config_* as flags, and a `bun run` parent would pass its own. HOME is the copy's,
 * so npm keeps its cache there: the archive has no dependencies, and nothing reaches ~/.npm.
 */
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_config_")),
  ),
  HOME: join(copy, "home"),
};
let tarball = "";

beforeAll(() => {
  for (const path of [
    "src",
    "package.json",
    "tsconfig.json",
    "tsconfig.build.json",
    "README.md",
    "LICENSE",
    "docs/FORMAT.md",
  ]) {
    cpSync(join(ROOT, path), join(copy, path), { recursive: true });
  }
  const build = spawnSync(
    join(ROOT, "node_modules", ".bin", "tsc"),
    ["-p", join(copy, "tsconfig.build.json")],
    {
      encoding: "utf8",
    },
  );
  if (build.status !== 0) throw new Error(`tsc: ${build.stdout}${build.stderr}`);
  mkdirSync(join(copy, "out"));
  const pack = spawnSync(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", join(copy, "out")],
    {
      cwd: copy,
      encoding: "utf8",
      env,
    },
  );
  if (pack.status !== 0) throw new Error(`npm pack: ${pack.stderr}`);
  const [file] = readdirSync(join(copy, "out"));
  tarball = join(copy, "out", file as string);
}, 120_000);

describe.skipIf(NO_RELEASE_TOOLING)("scripts/pack-smoke.ts --tarball", () => {
  test("Node and Bun install and run the same archive, unchanged, without building", () => {
    const before = sha256(tarball);
    for (const [runtime, name] of [
      ["node", "node"],
      [process.execPath, "bun"],
    ] as const) {
      const run = spawnSync(runtime, [SMOKE, "--tarball", tarball], {
        encoding: "utf8",
        env,
        timeout: 180_000,
      });
      expect(run.stderr).not.toContain("npm error");
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(`pack smoke passed on ${name}`);
      expect(run.stdout).toContain(`${tarball}, sha256 ${before}`);
      // `npm run build` announces itself; with a supplied archive nothing is built or packed.
      expect(`${run.stdout}${run.stderr}`).not.toContain("> relembra@");
    }
    expect(sha256(tarball)).toBe(before);
  }, 360_000);

  test("the archive ships no CLI sources: the CLI is a native binary, not an export", () => {
    const listed = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
    expect(listed.status).toBe(0);
    const entries = listed.stdout.split("\n").filter(Boolean);
    // Positive control: the library itself is there.
    expect(entries).toContain("package/dist/index.js");
    expect(entries.filter((entry) => entry.startsWith("package/dist/cli/"))).toEqual([]);
  });

  test("a missing or broken archive fails", () => {
    const missing = join(copy, "absent.tgz");
    const absent = spawnSync("node", [SMOKE, "--tarball", missing], { encoding: "utf8", env });
    expect(absent.status).not.toBe(0);
    expect(absent.stderr).toContain(missing);
    const broken = join(copy, "broken.tgz");
    writeFileSync(broken, "not a tarball\n");
    const garbage = spawnSync("node", [SMOKE, "--tarball", broken], {
      encoding: "utf8",
      env,
      timeout: 120_000,
    });
    expect(garbage.status).not.toBe(0);
    expect(`${garbage.stdout}${garbage.stderr}`).not.toContain("pack smoke passed");
  }, 180_000);
});
