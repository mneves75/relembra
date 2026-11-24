/**
 * What npm would publish must be public, at the version the library reports, from the repository
 * npm's provenance and trusted publishing match against, and a prerelease must never become the
 * `latest` dist-tag. scripts/pack-check.ts applies it to package.json before every pack.
 */
export const REPOSITORY_URL = "git+https://github.com/mneves75/relembra.git";

export interface Manifest {
  readonly private?: unknown;
  readonly version?: unknown;
  readonly tag?: unknown;
  readonly repository?: { readonly url?: unknown } | string;
  readonly publishConfig?: { readonly access?: unknown; readonly tag?: unknown };
}

const VALID_DIST_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// npm rejects dist-tags that parse as SemVer versions or ranges (npm dist-tag caveats).
const SEMVER_DIST_TAG = /^v?(?:\d+|[xX])(?:\.(?:\d+|[xX])){0,2}(?:[-+].*)?$/;

export function publishProblems(manifest: Manifest, libraryVersion: string): string[] {
  const problems: string[] = [];
  if (manifest.private === true) problems.push("package.json is private");
  if (manifest.version !== libraryVersion) {
    problems.push(
      `package.json version ${String(manifest.version)} differs from RELEMBRA_VERSION ${libraryVersion}`,
    );
  }
  const url =
    manifest.repository !== null && typeof manifest.repository === "object"
      ? manifest.repository.url
      : undefined;
  if (url !== REPOSITORY_URL) problems.push(`repository.url is not ${REPOSITORY_URL}`);
  if (manifest.publishConfig?.access !== "public") {
    problems.push("publishConfig.access is not public");
  }
  // npm publishes under `manifest.tag` before publishConfig.tag or the --tag argument.
  if (manifest.tag !== undefined) {
    problems.push("package.json has a top-level tag, which overrides publishConfig.tag");
  }
  const prerelease = typeof manifest.version === "string" && manifest.version.includes("-");
  const tag = manifest.publishConfig?.tag;
  if (
    tag !== undefined &&
    (typeof tag !== "string" || !VALID_DIST_TAG.test(tag) || SEMVER_DIST_TAG.test(tag))
  ) {
    problems.push("publishConfig.tag must be a single valid npm dist-tag");
  } else if (prerelease && (typeof tag !== "string" || tag === "latest")) {
    problems.push("a prerelease must publish under a dist-tag other than latest");
  } else if (!prerelease && tag !== undefined && tag !== "latest") {
    problems.push(`a stable release must publish under latest, not ${tag}`);
  }
  return problems;
}
