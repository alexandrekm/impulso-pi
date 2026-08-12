// Pure logic shared by the installer (scripts/install.mjs) and CI
// (scripts/check-json.mjs): JSONC stripping, profiles.jsonc loading, schema
// validation, resource classification, and tag->profile matching.
// Zero dependencies — Node standard library only.

import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

/**
 * Strip // line comments and /* block comments *​/ and trailing commas
 * (allowed in JSONC, rejected by JSON.parse) from JSONC text, leaving valid
 * JSON. Strings (including "//" inside them) are preserved.
 */
export function stripJsonc(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  // Next significant (non-whitespace, non-comment) char at or after pos.
  const nextSignificant = (pos) => {
    let j = pos;
    while (j < n) {
      const ch = text[j];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        j++;
        continue;
      }
      if (ch === "/" && text[j + 1] === "/") {
        j += 2;
        while (j < n && text[j] !== "\n") j++;
        continue;
      }
      if (ch === "/" && text[j + 1] === "*") {
        j += 2;
        while (j < n && !(text[j] === "*" && text[j + 1] === "/")) j++;
        j += 2;
        continue;
      }
      return ch;
    }
    return "";
  };
  while (i < n) {
    const c = text[i];
    // String literal — copy verbatim, respecting escapes.
    if (c === '"') {
      out += c;
      i++;
      while (i < n) {
        const ch = text[i];
        out += ch;
        i++;
        if (ch === "\\") {
          if (i < n) {
            out += text[i];
            i++;
          }
          continue;
        }
        if (ch === '"') break;
      }
      continue;
    }
    // Line comment.
    if (c === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    // Block comment.
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2; // skip closing */
      continue;
    }
    // Trailing comma before ] or } — drop it.
    if (c === ",") {
      if (nextSignificant(i + 1) === "]" || nextSignificant(i + 1) === "}") {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** Load and parse a JSONC profiles.jsonc. Throws on invalid JSON. */
export function loadProfiles(profilesPath) {
  const raw = readFileSync(profilesPath, "utf8");
  return JSON.parse(stripJsonc(raw));
}

/** Classify a profiles.jsonc resource key into a kind. */
export function classify(key) {
  if (key.startsWith("npm:")) return "npm";
  if (key.startsWith("extensions/")) return "file";
  if (key.startsWith("skills/")) return "skill";
  throw new Error(`Unknown resource key (not npm:/extensions//skills/): ${key}`);
}

/** Does the on-disk resource exist for a non-npm key? */
export function resourceExists(repoDir, key) {
  const kind = classify(key);
  if (kind === "npm") return true;
  const rel = kind === "skill" ? key.replace(/\/$/, "") : key;
  return existsSync(join(repoDir, rel));
}

/**
 * Destination of a non-npm resource, relative to the profile dir. File
 * resources may declare an explicit "dest" (e.g. a nested extension config
 * path); otherwise files flatten to extensions/<basename> and skills to
 * skills/<name>.
 */
export function relDestPath(key, entry) {
  const kind = classify(key);
  if (kind === "file") return entry?.dest || join("extensions", basename(key));
  return join("skills", basename(key.replace(/\/$/, "")));
}

/**
 * Resolve dest collisions among selected non-npm resource keys: when several
 * keys share a dest, tag-specific (non-core) keys beat core ones; remaining
 * ties go to the alphabetically-first key (this happens on --base, which
 * selects every resource). onShadow(loser, winner, dest) is called for each
 * dropped key. Returns the winning keys in their original order.
 */
export function resolveFileKeys(keys, resources, onShadow) {
  const byDest = new Map();
  for (const k of keys) {
    const d = relDestPath(k, resources[k]);
    if (!byDest.has(d)) byDest.set(d, []);
    byDest.get(d).push(k);
  }
  const winnerSet = new Set();
  for (const [d, group] of byDest) {
    if (group.length === 1) {
      winnerSet.add(group[0]);
      continue;
    }
    const specific = group.filter((k) => !(resources[k].tags || []).includes("core"));
    const pool = (specific.length ? specific : group).sort();
    winnerSet.add(pool[0]);
    for (const loser of group) {
      if (loser !== pool[0]) onShadow?.(loser, pool[0], d);
    }
  }
  return keys.filter((k) => winnerSet.has(k));
}

/**
 * Resource keys that belong on a profile with the given declared tags.
 * "core" is implicit on every profile.
 */
export function resourcesForProfile(profileTags, resources) {
  return Object.keys(resources).filter((k) => {
    const tags = resources[k].tags || [];
    return tags.includes("core") || tags.some((t) => profileTags.includes(t));
  });
}

/** Validate profiles.jsonc structure; returns an array of error strings. */
export function validateProfiles(profiles, repoDir) {
  const errors = [];
  const tags = profiles.tags;
  if (!Array.isArray(tags)) {
    errors.push('top-level "tags" must be an array');
    return errors; // nothing else is safe to check
  }
  const tagSet = new Set(tags);
  if (!tagSet.has("core")) errors.push('tags must include "core"');

  const groups = profiles.groups || {};
  const profs = profiles.profiles || {};
  const resources = profiles.resources || {};

  if (typeof groups !== "object" || Array.isArray(groups)) {
    errors.push('"groups" must be an object');
  } else {
    for (const [g, members] of Object.entries(groups)) {
      if (!Array.isArray(members)) {
        errors.push(`group "${g}" must be an array`);
        continue;
      }
      for (const m of members) {
        if (!(m in profs)) errors.push(`group "${g}" references unknown profile "${m}"`);
      }
    }
  }

  if (typeof profs !== "object" || Array.isArray(profs)) {
    errors.push('"profiles" must be an object');
  } else {
    for (const [name, p] of Object.entries(profs)) {
      const pt = p?.tags;
      if (!Array.isArray(pt)) {
        errors.push(`profile "${name}" .tags must be an array`);
        continue;
      }
      for (const t of pt) {
        if (!tagSet.has(t)) errors.push(`profile "${name}" has unknown tag "${t}"`);
        if (t === "core") errors.push(`profile "${name}" must not list "core" (it is implicit)`);
      }
    }
  }

  const settings = profiles.settings;
  if (settings !== undefined) {
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      errors.push('"settings" must be an object');
    } else if ("packages" in settings) {
      errors.push('"settings" must not contain "packages" (use npm: resources instead)');
    }
  }

  if (typeof resources !== "object" || Array.isArray(resources)) {
    errors.push('"resources" must be an object');
  } else {
    for (const key of Object.keys(resources)) {
      let kind;
      try {
        kind = classify(key);
      } catch (e) {
        errors.push(e.message);
        continue;
      }
      if (kind !== "npm" && !resourceExists(repoDir, key)) {
        errors.push(`resource "${key}" not found on disk`);
      }
      const tags = resources[key]?.tags;
      if (!Array.isArray(tags)) {
        errors.push(`resource "${key}" .tags must be an array`);
        continue;
      }
      for (const t of tags) {
        if (!tagSet.has(t)) errors.push(`resource "${key}" has unknown tag "${t}"`);
      }
      const dest = resources[key]?.dest;
      if (dest !== undefined) {
        if (kind !== "file") {
          errors.push(`resource "${key}" .dest is only allowed on extensions/ file resources`);
        } else if (
          typeof dest !== "string" ||
          !dest ||
          dest.startsWith("/") ||
          dest.split("/").includes("..")
        ) {
          errors.push(`resource "${key}" .dest must be a relative path inside the profile dir`);
        }
      }
    }
  }

  return errors;
}
