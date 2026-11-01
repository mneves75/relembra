/**
 * The leaky synthetic candidate: the perfect oracle plus one planted forbidden memory on each
 * chosen surface. Its retrieval is perfect, so only the leak check can fail it.
 * Usage: bun eval/candidates/leaky.ts <set-dir> [surface:form ...]
 *   surface: find | brief | wake; form: id | text. Default: every surface in both forms.
 */
import { readSet } from "../set.js";
import { createOracle, type Leak, type LeakForm, type LeakSurface } from "./oracle.js";
import { serve } from "./serve.js";

const SURFACES: readonly LeakSurface[] = ["find", "brief", "wake"];
const FORMS: readonly LeakForm[] = ["id", "text"];

export function parseLeaks(specs: readonly string[]): Leak[] {
  if (specs.length === 0)
    return SURFACES.flatMap((surface) => FORMS.map((form) => ({ surface, form })));
  return specs.map((spec) => {
    const [surface, form] = spec.split(":");
    if (!SURFACES.includes(surface as LeakSurface) || !FORMS.includes(form as LeakForm)) {
      throw new Error(`bad leak ${spec}: expected surface:form`);
    }
    return { surface: surface as LeakSurface, form: form as LeakForm };
  });
}

if (import.meta.main) {
  const [dir, ...specs] = process.argv.slice(2);
  if (dir === undefined) throw new Error("usage: leaky.ts <set-dir> [surface:form ...]");
  await serve(createOracle(readSet(dir), { name: "leaky", leaks: parseLeaks(specs) }));
}
