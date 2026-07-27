import assert from "node:assert/strict";
import test from "node:test";

import {
  expectedReleaseConfirmation,
  validateReleaseChannel,
  validateReleaseConfirmation,
} from "./validate-release-confirmation.mjs";

test("builds the exact publish confirmation phrase from a version", () => {
  assert.equal(expectedReleaseConfirmation("0.1.20"), "PUBLISH v0.1.20");
  assert.equal(expectedReleaseConfirmation("v0.1.20-beta.1"), "PUBLISH v0.1.20-beta.1");
});

test("does not require publish confirmation for dry runs", () => {
  assert.equal(
    validateReleaseConfirmation({
      version: "0.1.20",
      dryRun: "true",
      confirmation: "",
    }).ok,
    true,
  );
});

test("requires stable versions to use latest and prereleases to use a preview channel", () => {
  assert.equal(validateReleaseChannel({ version: "0.1.20", npmDistTag: "latest" }).ok, true);
  assert.equal(validateReleaseChannel({ version: "0.1.20-beta.1", npmDistTag: "beta" }).ok, true);
  assert.equal(validateReleaseChannel({ version: "0.1.20-rc.1", npmDistTag: "next" }).ok, true);

  const prereleaseOnLatest = validateReleaseChannel({
    version: "0.1.20-beta.1",
    npmDistTag: "latest",
  });
  assert.equal(prereleaseOnLatest.ok, false);
  assert.match(prereleaseOnLatest.reason, /cannot use npm dist-tag 'latest'/);

  const stableOnBeta = validateReleaseChannel({ version: "0.1.20", npmDistTag: "beta" });
  assert.equal(stableOnBeta.ok, false);
  assert.match(stableOnBeta.reason, /must use npm dist-tag 'latest'/);
});

test("requires exact publish confirmation before a real release", () => {
  assert.equal(
    validateReleaseConfirmation({
      version: "0.1.20",
      dryRun: "false",
      confirmation: "",
    }).ok,
    false,
  );
  assert.equal(
    validateReleaseConfirmation({
      version: "0.1.20",
      dryRun: "false",
      confirmation: "PUBLISH 0.1.20",
    }).ok,
    false,
  );
  assert.equal(
    validateReleaseConfirmation({
      version: "0.1.20",
      dryRun: "false",
      confirmation: "PUBLISH v0.1.20",
    }).ok,
    true,
  );
});
