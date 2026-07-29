#!/usr/bin/env node

import { appendFileSync } from "node:fs";
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
  const prereleaseIdentifier = isPrerelease
    ? String(parsed.prerelease[0] || "").toLowerCase()
    : "";
  const expectedNpmDistTag = isPrerelease
    ? ["alpha", "beta", "next"].includes(prereleaseIdentifier)
      ? prereleaseIdentifier
      : "next"
    : "latest";

  if (tag !== expectedNpmDistTag) {
    return {
      ok: false,
      reason: isPrerelease
        ? `prerelease version ${cleanVersion(version)} must use npm dist-tag '${expectedNpmDistTag}'; got '${tag}'.`
        : `stable version ${cleanVersion(version)} must use npm dist-tag 'latest'; got '${tag}'.`,
    };
  }

  return {
    ok: true,
    release_channel: isPrerelease ? "prerelease" : "stable",
    prerelease_identifier: prereleaseIdentifier,
    expected_npm_dist_tag: expectedNpmDistTag,
    github_release_prerelease: isPrerelease,
    docs_sync_expected: !isPrerelease,
    reason: isPrerelease
      ? `prerelease version will publish on npm '${tag}', create a GitHub Prerelease, and skip formal Docs sync.`
      : "stable version will publish on npm 'latest', create a published GitHub Release, and enter formal Docs sync.",
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
  if (env.GITHUB_OUTPUT) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      [
        `release_channel=${channel.release_channel}`,
        `prerelease_identifier=${channel.prerelease_identifier}`,
        `npm_dist_tag=${channel.expected_npm_dist_tag}`,
        `github_release_prerelease=${channel.github_release_prerelease}`,
        `docs_sync_expected=${channel.docs_sync_expected}`,
        "",
      ].join("\n"),
      "utf8",
    );
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
