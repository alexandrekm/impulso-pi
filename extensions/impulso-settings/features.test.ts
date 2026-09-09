import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// features.ts resolves CONFIG_DIR (settings.json + package config files)
// at import time — point it at a fresh temp dir first.
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "impulso-cfg-"));
process.env.PI_CODING_AGENT_DIR = CONFIG_DIR;

const {
  FEATURES,
  TABS,
  featuresForTab,
  featureValues,
  getFeatureState,
  setFeatureState,
  settingsPath,
} = await import("./features.ts");

import type { Feature } from "./features.ts";

const settings = () => JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
const config = (name: string) =>
  JSON.parse(readFileSync(join(CONFIG_DIR, name), "utf8")) as Record<string, unknown>;

// Synthetic features exercising every state shape; ids are fake on purpose.
const F = {
  launchOk: {
    kind: "launch",
    id: "l1",
    label: "L",
    tab: "tools",
    group: "g",
    command: "/x",
    description: "",
  } as Feature,
  launchDisplay: {
    kind: "launch",
    id: "l2",
    label: "L2",
    tab: "tools",
    group: "g",
    description: "",
    display: () => "custom-value",
  } as Feature,
  launchThrows: {
    kind: "launch",
    id: "l3",
    label: "L3",
    tab: "tools",
    group: "g",
    description: "",
    display: () => {
      throw new Error("boom");
    },
  } as Feature,
  pkg: {
    kind: "package",
    id: "p1",
    label: "P",
    tab: "tools",
    group: "g",
    spec: "npm:fake-pkg",
    description: "",
  } as Feature,
  local: {
    kind: "local",
    id: "local-ext",
    label: "Lo",
    tab: "tools",
    group: "g",
    description: "",
  } as Feature,
  cfgPicker: {
    kind: "config",
    id: "c1",
    label: "C",
    tab: "tools",
    group: "g",
    configFile: "pkg.json",
    key: "model",
    picker: true,
    description: "",
  } as Feature,
  cfgBool: {
    kind: "config",
    id: "c2",
    label: "C2",
    tab: "tools",
    group: "g",
    configFile: "pkg.json",
    key: "enabled",
    description: "",
  } as Feature,
  cfgBoolDefault: {
    kind: "config",
    id: "c3",
    label: "C3",
    tab: "tools",
    group: "g",
    configFile: "pkg.json",
    key: "flag",
    defaultValue: "on",
    description: "",
  } as Feature,
  cfgEnum: {
    kind: "config",
    id: "c4",
    label: "C4",
    tab: "tools",
    group: "g",
    configFile: "pkg.json",
    key: "mode",
    values: ["", "a", "b"],
    description: "",
  } as Feature,
  cfgNumeric: {
    kind: "config",
    id: "c5",
    label: "C5",
    tab: "tools",
    group: "g",
    configFile: "pkg.json",
    key: "num",
    values: ["1", "2"],
    numeric: true,
    description: "",
  } as Feature,
  setPickerModel: {
    kind: "pi-setting",
    id: "s1",
    label: "S",
    tab: "tools",
    group: "g",
    modelKey: "btw.model",
    picker: true,
    description: "",
  } as Feature,
  setPickerKey: {
    kind: "pi-setting",
    id: "s2",
    label: "S2",
    tab: "tools",
    group: "g",
    key: "freeform.model",
    picker: true,
    description: "",
  } as Feature,
  setPickerNoKey: {
    kind: "pi-setting",
    id: "s3",
    label: "S3",
    tab: "tools",
    group: "g",
    picker: true,
    description: "",
  } as Feature,
  setBool: {
    kind: "pi-setting",
    id: "s4",
    label: "S4",
    tab: "tools",
    group: "g",
    key: "quiet",
    description: "",
  } as Feature,
  setBoolDefault: {
    kind: "pi-setting",
    id: "s5",
    label: "S5",
    tab: "tools",
    group: "g",
    key: "other",
    defaultValue: "on",
    description: "",
  } as Feature,
  setEnum: {
    kind: "pi-setting",
    id: "s6",
    label: "S6",
    tab: "tools",
    group: "g",
    key: "retry",
    values: ["calibrated", "ratio"],
    description: "",
  } as Feature,
} as const;

describe("featureValues", () => {
  test("pi-setting/config with enum values expose them; everything else toggles on/off", () => {
    assert.deepEqual(featureValues(F.setEnum), ["calibrated", "ratio"]);
    assert.deepEqual(featureValues(F.cfgEnum), ["", "a", "b"]);
    assert.deepEqual(featureValues(F.setBool), ["on", "off"]);
    assert.deepEqual(featureValues(F.pkg), ["on", "off"]);
    assert.deepEqual(featureValues(F.launchOk), ["on", "off"]);
  });
});

describe("getFeatureState", () => {
  test("launch features show their display value or 'open →'", () => {
    assert.equal(getFeatureState(F.launchOk), "open →");
    assert.equal(getFeatureState(F.launchDisplay), "custom-value");
    assert.equal(getFeatureState(F.launchThrows), "open →");
  });

  test("package features read settings.json packages[] (string, object, absent)", () => {
    assert.equal(getFeatureState(F.pkg), "off");
    writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:fake-pkg"] }));
    assert.equal(getFeatureState(F.pkg), "on");
    writeFileSync(
      settingsPath,
      JSON.stringify({ packages: [{ source: "npm:fake-pkg", autoload: false }] }),
    );
    assert.equal(getFeatureState(F.pkg), "off");
    writeFileSync(settingsPath, JSON.stringify({ packages: [{ source: "npm:fake-pkg" }] }));
    assert.equal(getFeatureState(F.pkg), "on");
    writeFileSync(settingsPath, JSON.stringify({ packages: "junk" })); // non-array → off
    assert.equal(getFeatureState(F.pkg), "off");
  });

  test("local features read the impulso manifest", () => {
    assert.equal(getFeatureState(F.local), "on");
    writeFileSync(
      join(CONFIG_DIR, "impulso-settings.json"),
      JSON.stringify({ disabled: ["local-ext"] }),
    );
    assert.equal(getFeatureState(F.local), "off");
    writeFileSync(join(CONFIG_DIR, "impulso-settings.json"), JSON.stringify({ disabled: [] }));
  });

  test("config features: picker, bool, bool-with-default, enum fallbacks", () => {
    assert.equal(getFeatureState(F.cfgPicker), ""); // absent → same as main
    assert.equal(getFeatureState(F.cfgBool), "off"); // absent, no default
    assert.equal(getFeatureState(F.cfgBoolDefault), "on"); // absent + default
    writeFileSync(
      join(CONFIG_DIR, "pkg.json"),
      JSON.stringify({ model: "m-1", enabled: true, flag: false, mode: "a", num: 1 }),
    );
    assert.equal(getFeatureState(F.cfgPicker), "m-1");
    assert.equal(getFeatureState(F.cfgBool), "on");
    assert.equal(getFeatureState(F.cfgBoolDefault), "off");
    assert.equal(getFeatureState(F.cfgEnum), "a");
    // enum value not in values[] → defaultValue (unset → first value)
    writeFileSync(join(CONFIG_DIR, "pkg.json"), JSON.stringify({ mode: "zzz" }));
    assert.equal(getFeatureState(F.cfgEnum), "");
  });

  test("pi-setting features: model picker, free-form picker, bool, enum", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ btw: { model: { provider: "litellm", id: "m-x" } } }),
    );
    assert.equal(getFeatureState(F.setPickerModel), "litellm/m-x");
    assert.equal(getFeatureState(F.setPickerModel), "litellm/m-x"); // cached path re-read

    writeFileSync(settingsPath, JSON.stringify({ freeform: { model: "custom-id" } }));
    assert.equal(getFeatureState(F.setPickerKey), "custom-id");
    assert.equal(getFeatureState(F.setPickerNoKey), ""); // misconfigured: degrade to ""

    writeFileSync(settingsPath, JSON.stringify({ quiet: true, other: false, retry: "ratio" }));
    assert.equal(getFeatureState(F.setBool), "on");
    assert.equal(getFeatureState(F.setBoolDefault), "off");
    assert.equal(getFeatureState(F.setEnum), "ratio");

    // enum value outside values[] → defaultValue ?? first value
    writeFileSync(settingsPath, JSON.stringify({ retry: "bogus" }));
    assert.equal(getFeatureState(F.setEnum), "calibrated");
    // absent bool without default → off; absent bool with default "on" → on
    writeFileSync(settingsPath, JSON.stringify({}));
    assert.equal(getFeatureState(F.setBool), "off");
    assert.equal(getFeatureState(F.setBoolDefault), "on");
  });
});

describe("setFeatureState", () => {
  test("package toggle rewrites settings.json packages[]", () => {
    writeFileSync(settingsPath, JSON.stringify({ theme: "mocha", packages: ["npm:other"] }));
    setFeatureState(F.pkg, "on");
    assert.deepEqual(settings().packages, ["npm:other", "npm:fake-pkg"]);
    setFeatureState(F.pkg, "off");
    assert.deepEqual(settings().packages, [
      "npm:other",
      { source: "npm:fake-pkg", autoload: false },
    ]);
    assert.equal((settings() as { theme?: string }).theme, "mocha");
  });

  test("local toggle writes the impulso manifest", () => {
    setFeatureState(F.local, "off");
    assert.deepEqual(JSON.parse(readFileSync(join(CONFIG_DIR, "impulso-settings.json"), "utf8")), {
      disabled: ["local-ext"],
    });
    setFeatureState(F.local, "on");
    assert.deepEqual(JSON.parse(readFileSync(join(CONFIG_DIR, "impulso-settings.json"), "utf8")), {
      disabled: [],
    });
  });

  test("config picker: value written, '' removes the key", () => {
    setFeatureState(F.cfgPicker, "m-9");
    assert.equal(config("pkg.json").model, "m-9");
    setFeatureState(F.cfgPicker, "");
    assert.equal("model" in config("pkg.json"), false);
  });

  test("config bool and numeric-enum writes", () => {
    setFeatureState(F.cfgBool, "on");
    assert.equal(config("pkg.json").enabled, true);
    setFeatureState(F.cfgNumeric, "2");
    assert.equal(config("pkg.json").num, 2); // numeric → Number
    setFeatureState(F.cfgEnum, "");
    assert.equal("mode" in config("pkg.json"), false); // sentinel removes
  });

  test("pi-setting model picker: set, malformed, clear", () => {
    writeFileSync(settingsPath, JSON.stringify({ btw: { model: { thinkingLevel: "high" } } }));
    setFeatureState(F.setPickerModel, "litellm/gpt-x");
    const m = (settings() as { btw?: { model?: Record<string, unknown> } }).btw?.model;
    assert.equal(m?.provider, "litellm");
    assert.equal(m?.id, "gpt-x");
    assert.equal(m?.thinkingLevel, "high"); // clear keeps other keys

    setFeatureState(F.setPickerModel, "noprovider"); // malformed → no-op
    assert.equal((settings() as { btw?: { model?: { id?: string } } }).btw?.model?.id, "gpt-x");

    setFeatureState(F.setPickerModel, ""); // clear drops provider/id, keeps rest
    const m2 = (settings() as { btw?: { model?: Record<string, unknown> } }).btw?.model;
    assert.equal(m2?.provider, undefined);
    assert.equal(m2?.id, undefined);
    assert.equal(m2?.thinkingLevel, "high");
  });

  test("pi-setting free-form picker and plain toggles", () => {
    writeFileSync(settingsPath, JSON.stringify({}));
    setFeatureState(F.setPickerKey, "model-7");
    assert.equal((settings() as { freeform?: { model?: string } }).freeform?.model, "model-7");
    setFeatureState(F.setPickerKey, "");
    // deleteByPath removes the leaf but keeps intermediate objects.
    const after = settings() as { freeform?: { model?: unknown } };
    assert.equal("freeform" in after, true);
    assert.equal("model" in (after.freeform ?? {}), false);

    // Misconfigured picker without a key: no-op, no crash.
    setFeatureState(F.setPickerNoKey, "x");

    setFeatureState(F.setBool, "on");
    assert.equal(settings().quiet, true);
    setFeatureState(F.setEnum, "");
    assert.equal("retry" in settings(), false);
    setFeatureState(F.setEnum, "ratio");
    assert.equal(settings().retry, "ratio");
  });
});

describe("featuresForTab", () => {
  test("groups features by first-seen group order", () => {
    const tabId = TABS[0]!.id;
    const feats = featuresForTab(tabId);
    assert.ok(feats.length > 0);
    const groups: string[] = [];
    for (const f of feats) if (!groups.includes(f.group)) groups.push(f.group);
    const sorted = [...feats].sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group));
    assert.deepEqual(
      feats.map((f) => f.id),
      sorted.map((f) => f.id),
    );
    for (const f of feats) assert.equal(f.tab, tabId);
  });
  test("unknown tab has no features", () => {
    assert.equal(featuresForTab("no-such-tab").length, 0);
  });
});

test("FEATURES/TABS registries are coherent", () => {
  assert.ok(TABS.length > 0);
  assert.ok(FEATURES.length > 0);
  const tabIds = new Set(TABS.map((t) => t.id));
  for (const f of FEATURES) assert.ok(tabIds.has(f.tab), `feature ${f.id} has unknown tab`);
});

process.on("exit", () => rmSync(CONFIG_DIR, { recursive: true, force: true }));
