/**
 * Builds site/assets/relembra.js: the library and its in-memory store as one classic script (an
 * IIFE, so the page also works opened from the file system), with `node:crypto` and `node:util`
 * replaced by the stand-ins beside this file. Run with `bun run build:site`; test/site.test.ts
 * fails while the committed file differs from a fresh build.
 */
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const target = fileURLToPath(new URL("../../site/assets/relembra.js", import.meta.url));

export async function buildSiteBundle(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [`${here}entry.ts`],
    target: "browser",
    format: "iife",
    minify: true,
    plugins: [
      {
        name: "browser-stand-ins",
        setup(build) {
          build.onResolve({ filter: /^node:crypto$/ }, () => ({ path: `${here}crypto.ts` }));
          build.onResolve({ filter: /^node:util$/ }, () => ({ path: `${here}util.ts` }));
        },
      },
    ],
  });
  const [output] = result.outputs;
  if (!result.success || output === undefined) {
    throw new AggregateError(result.logs, "the site bundle did not build");
  }
  const header = "/* relembra (MIT), bundled from src/ by scripts/site/build.ts. Do not edit. */\n";
  return header + (await output.text());
}

if (import.meta.main) {
  const bundle = await buildSiteBundle();
  await Bun.write(target, bundle);
  console.log(`site/assets/relembra.js: ${bundle.length} bytes`);
}
