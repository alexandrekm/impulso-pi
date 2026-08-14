import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isSensitiveDotenv } from "./command-guard.ts";

describe("isSensitiveDotenv", () => {
  test("denies .env and variants", () => {
    assert.equal(isSensitiveDotenv(".env"), true);
    assert.equal(isSensitiveDotenv("apps/api/.env"), true);
    assert.equal(isSensitiveDotenv(".env.local"), true);
    assert.equal(isSensitiveDotenv(".env.production"), true);
  });
  test("allows .env.example and unrelated files", () => {
    assert.equal(isSensitiveDotenv(".env.example"), false);
    assert.equal(isSensitiveDotenv("src/env.ts"), false);
    assert.equal(isSensitiveDotenv("README.md"), false);
  });
});
