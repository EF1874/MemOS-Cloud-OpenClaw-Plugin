import assert from "node:assert/strict";
import test from "node:test";

import {
  expectedReleaseConfirmation,
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
