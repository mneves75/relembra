/**
 * Lets Node run this repository's TypeScript sources directly for the Node smoke test: a relative
 * `./x.js` import inside the repository resolves to `./x.ts` when only the `.ts` file exists, and
 * `relembra`, `relembra/sqlite` and `relembra/testing` resolve to their sources through the
 * `paths` in tsconfig.json, as they do for Bun and tsc (the package exports point at `dist`).
 * Node strips the types itself; nothing is installed. The built library is tested from its packed
 * tarball by `scripts/pack-smoke.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url).href;
const sources: Record<string, readonly string[]> = JSON.parse(
  readFileSync(new URL("tsconfig.json", root), "utf8"),
).compilerOptions.paths;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = Object.hasOwn(sources, specifier) ? sources[specifier]?.[0] : undefined;
    if (source !== undefined) return nextResolve(new URL(source, root).href, context);
    const parent = context.parentURL;
    if (specifier.startsWith(".") && specifier.endsWith(".js") && parent?.startsWith(root)) {
      const target = new URL(specifier, parent);
      const typescript = new URL(target.href.replace(/\.js$/, ".ts"));
      if (!existsSync(fileURLToPath(target)) && existsSync(fileURLToPath(typescript))) {
        return nextResolve(typescript.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
