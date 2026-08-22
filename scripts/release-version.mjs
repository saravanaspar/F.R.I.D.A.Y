#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = /^v?([0-9]{1,6})\.([0-9]{1,6})\.([0-9]{1,6})$/;

function integerComponent(component) {
  return component.replace(/^0+(?=\d)/u, "");
}

function decimalPatchComponent(component) {
  return component.replace(/0+$/u, "") || "0";
}

/**
 * FRIDAY release versions intentionally use decimal-style patch precision.
 * Major/minor are integers; patch keeps leading zero precision and ignores
 * trailing zeroes, so 2.3.4 and 2.3.40 are the same release identity while
 * 2.3.04 and 2.3.00004 remain different identities.
 */
export function parseFridayReleaseVersion(input) {
  const value = String(input ?? "").trim();
  const match = VERSION.exec(value);
  if (!match) {
    throw new Error("Release version must be vMAJOR.MINOR.PATCH with 1-6 digits in each component");
  }
  const exact = match.slice(1);
  const canonicalComponents = [
    integerComponent(exact[0]),
    integerComponent(exact[1]),
    decimalPatchComponent(exact[2]),
  ];
  return Object.freeze({
    tag: value.startsWith("v") ? value : `v${value}`,
    version: value.startsWith("v") ? value.slice(1) : value,
    canonical: canonicalComponents.join("."),
    components: Object.freeze(exact),
    canonicalComponents: Object.freeze(canonicalComponents),
  });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    const parsed = parseFridayReleaseVersion(process.argv[2]);
    if (process.argv.includes("--canonical")) {
      process.stdout.write(`${parsed.canonical}\n`);
    } else {
      const outputIndex = process.argv.indexOf("--github-output");
      if (outputIndex >= 0) {
        const output = process.argv[outputIndex + 1];
        if (!output) throw new Error("--github-output requires a path");
        appendFileSync(
          output,
          `version=${parsed.version}\ntag=${parsed.tag}\ncanonical=${parsed.canonical}\n`,
        );
      } else {
        process.stdout.write(`${JSON.stringify(parsed)}\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
