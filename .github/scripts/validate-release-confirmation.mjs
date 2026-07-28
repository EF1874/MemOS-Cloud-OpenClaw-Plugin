#!/usr/bin/env node

import { cleanVersion, parseSemver } from "../../lib/semver.js";

export function expectedReleaseConfirmation(version) {
  const versionWithoutPrefix = cleanVersion(version);
  return `PUBLISH v${versionWithoutPrefix}`;
}

export function validateReleaseChannel({ version, npmDistTag }) {
  const parsed = parseSemver(version);
  const tag = String(npmDistTag || "").trim();
  if (!parsed) {
    return {
      ok: false,
      reason: `version must be a valid SemVer value; got '${String(version || "").trim()}'.`,
    };
  }
  if (!tag) {
    return { ok: false, reason: "npm dist-tag is required." };
  }

  const isPrerelease = parsed.prerelease.length > 0;
  if (isPrerelease && tag === "latest") {
    return {
      ok: false,
      reason:
        `prerelease version ${cleanVersion(version)} cannot use npm dist-tag 'latest'; ` +
        "use beta, next, alpha, or another non-latest preview channel.",
    };
  }
  if (!isPrerelease && tag !== "latest") {
    return {
      ok: false,
      reason:
        `stable version ${cleanVersion(version)} must use npm dist-tag 'latest'; ` +
        `got '${tag}'. This workflow does not support promoting a stable version from '${tag}' later.`,
    };
  }

  return {
    ok: true,
    reason: isPrerelease
      ? `prerelease version and npm dist-tag '${tag}' are compatible.`
      : "stable version and npm dist-tag 'latest' are compatible.",
  };
}

export function validateReleaseConfirmation({ version, dryRun, confirmation }) {
  const isDryRun = String(dryRun ?? "true").trim().toLowerCase() === "true";
  const expected = expectedReleaseConfirmation(version);

  if (isDryRun) {
    return {
      ok: true,
      expected,
      reason: "dry_run=true; publish confirmation is not required.",
    };
  }

  if (String(confirmation || "").trim() === expected) {
    return {
      ok: true,
      expected,
      reason: "publish confirmation accepted.",
    };
  }

  return {
    ok: false,
    expected,
    reason:
      "dry_run=false would publish to npm and create a published GitHub Release; " +
      `publish_confirmation must exactly equal '${expected}'.`,
  };
}

export function main(env = process.env) {
  const channel = validateReleaseChannel({
    version: env.RELEASE_VERSION,
    npmDistTag: env.NPM_DIST_TAG,
  });
  if (!channel.ok) {
    throw new Error(channel.reason);
  }

  const result = validateReleaseConfirmation({
    version: env.RELEASE_VERSION,
    dryRun: env.DRY_RUN,
    confirmation: env.PUBLISH_CONFIRMATION,
  });

  if (!result.ok) {
    throw new Error(result.reason);
  }

  console.log(channel.reason);
  console.log(result.reason);
  if (result.expected) {
    console.log(`Expected confirmation: ${result.expected}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error?.message || String(error)}`);
    process.exitCode = 1;
  }
}
