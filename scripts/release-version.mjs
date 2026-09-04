#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverBinaryAssets } from "./binary-assets.mjs";
import { discoverWorkspacePackages } from "./workspace-packages.mjs";

const VERSION = /^v?([0-9]{1,6})\.([0-9]{1,6})\.([0-9]{1,6})$/;
const NPM_PACKAGE_VERSION = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DEPENDENCY_FIELDS = Object.freeze(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]);
const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), "..");

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

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function displayPath(root, path) {
  return relative(root, path).split(sep).join("/") || ".";
}

function uniquePaths(paths) {
  return [...new Set(paths.map((path) => resolve(path)))].sort();
}

function releasePackageLayout(root) {
  const primaryManifests = uniquePaths([
    resolve(root, "package.json"),
    ...discoverWorkspacePackages(root).map((workspace) => resolve(workspace.path, "package.json")),
  ]);
  const primary = new Set(primaryManifests);
  const embeddedManifests = uniquePaths(discoverBinaryAssets(root)
    .filter((asset) => asset.target.split("/").at(-1) === "package.json")
    .map((asset) => asset.source)
    .filter((path) => !primary.has(resolve(path))));
  return Object.freeze({ primaryManifests, embeddedManifests });
}

function readPackageRecords(root) {
  const layout = releasePackageLayout(root);
  const records = [...layout.primaryManifests, ...layout.embeddedManifests].map((path) => {
    const manifest = readJson(path);
    if (typeof manifest.name !== "string" || !manifest.name.trim()) {
      throw new Error(`${displayPath(root, path)} must declare a package name`);
    }
    return { path, manifest };
  });
  const names = new Set();
  for (const { path, manifest } of records) {
    if (names.has(manifest.name)) throw new Error(`Duplicate release package name ${manifest.name} in ${displayPath(root, path)}`);
    names.add(manifest.name);
  }
  return { ...layout, records, names };
}

function assertNpmPackageVersion(version) {
  if (!NPM_PACKAGE_VERSION.test(version)) {
    throw new Error(`Release version ${version} cannot be stored in package.json; use npm-compatible MAJOR.MINOR.PATCH without leading zeroes`);
  }
}

function localDependencyMismatches(record, names, expected, root) {
  const mismatches = [];
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = record.manifest[field];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (names.has(name) && specifier !== expected) {
        mismatches.push(`${displayPath(root, record.path)} ${field}.${name} is ${JSON.stringify(specifier)}; expected ${JSON.stringify(expected)}`);
      }
    }
  }
  return mismatches;
}

function checkLockfile({ path, packageRecords, packageRoot, names, expected, root }) {
  const lock = readJson(path);
  const mismatches = [];
  if (lock.version !== expected) mismatches.push(`${displayPath(root, path)} top-level version is ${JSON.stringify(lock.version)}; expected ${JSON.stringify(expected)}`);
  if (!lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
    mismatches.push(`${displayPath(root, path)} must contain a packages object`);
    return mismatches;
  }
  for (const record of packageRecords) {
    const key = relative(packageRoot, dirname(record.path)).split(sep).join("/");
    const entry = lock.packages[key];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      mismatches.push(`${displayPath(root, path)} is missing package entry ${JSON.stringify(key)}`);
      continue;
    }
    if (entry.version !== expected) {
      mismatches.push(`${displayPath(root, path)} package entry ${JSON.stringify(key)} is ${JSON.stringify(entry.version)}; expected ${JSON.stringify(expected)}`);
    }
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = entry[field];
      if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
      for (const [name, specifier] of Object.entries(dependencies)) {
        if (names.has(name) && specifier !== expected) {
          mismatches.push(`${displayPath(root, path)} package entry ${JSON.stringify(key)} ${field}.${name} is ${JSON.stringify(specifier)}; expected ${JSON.stringify(expected)}`);
        }
      }
    }
  }
  return mismatches;
}

export function checkReleasePackageVersions(root = projectRoot, requestedVersion) {
  const packages = readPackageRecords(root);
  const rootRecord = packages.records.find((record) => record.path === resolve(root, "package.json"));
  const expected = requestedVersion ?? rootRecord?.manifest.version;
  if (typeof expected !== "string" || !expected.trim()) throw new Error("Root package.json must declare a non-empty version");
  assertNpmPackageVersion(expected);

  const mismatches = [];
  for (const record of packages.records) {
    if (record.manifest.version !== expected) {
      mismatches.push(`${displayPath(root, record.path)} is ${JSON.stringify(record.manifest.version)}; expected ${JSON.stringify(expected)}`);
    }
    mismatches.push(...localDependencyMismatches(record, packages.names, expected, root));
  }

  const rootLock = resolve(root, "package-lock.json");
  if (!existsSync(rootLock)) {
    mismatches.push("package-lock.json is missing");
  } else {
    const primaryRecords = packages.records.filter((record) => packages.primaryManifests.includes(record.path));
    mismatches.push(...checkLockfile({
      path: rootLock,
      packageRecords: primaryRecords,
      packageRoot: root,
      names: packages.names,
      expected,
      root,
    }));
  }

  const lockfiles = [rootLock];
  for (const manifestPath of packages.embeddedManifests) {
    const lockPath = resolve(dirname(manifestPath), "package-lock.json");
    if (!existsSync(lockPath)) continue;
    lockfiles.push(lockPath);
    const record = packages.records.find((candidate) => candidate.path === manifestPath);
    mismatches.push(...checkLockfile({
      path: lockPath,
      packageRecords: record ? [record] : [],
      packageRoot: dirname(manifestPath),
      names: packages.names,
      expected,
      root,
    }));
  }

  if (mismatches.length > 0) throw new Error(`Release package versions are not synchronized:\n- ${mismatches.join("\n- ")}`);
  return Object.freeze({ version: expected, manifests: packages.records.length, lockfiles: uniquePaths(lockfiles).length });
}

function synchronizeManifest(record, names, version) {
  record.manifest.version = version;
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = record.manifest[field];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    for (const name of Object.keys(dependencies)) if (names.has(name)) dependencies[name] = version;
  }
}

function prepareSynchronizedLockfile(path, packageRecords, packageRoot, names, version) {
  if (!existsSync(path)) throw new Error(`${displayPath(packageRoot, path)} is missing`);
  const lock = readJson(path);
  if (!lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
    throw new Error(`${path} must contain a packages object`);
  }
  lock.version = version;
  for (const record of packageRecords) {
    const key = relative(packageRoot, dirname(record.path)).split(sep).join("/");
    const entry = lock.packages[key];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${path} is missing package entry ${JSON.stringify(key)}`);
    entry.version = version;
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = entry[field];
      if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
      for (const name of Object.keys(dependencies)) if (names.has(name)) dependencies[name] = version;
    }
  }
  return { path, lock };
}

export function setReleasePackageVersions(versionInput, root = projectRoot) {
  const version = parseFridayReleaseVersion(versionInput).version;
  assertNpmPackageVersion(version);
  const packages = readPackageRecords(root);
  const primaryRecords = packages.records.filter((record) => packages.primaryManifests.includes(record.path));
  const rootLock = resolve(root, "package-lock.json");
  const lockfiles = [prepareSynchronizedLockfile(rootLock, primaryRecords, root, packages.names, version)];
  for (const manifestPath of packages.embeddedManifests) {
    const lockPath = resolve(dirname(manifestPath), "package-lock.json");
    if (!existsSync(lockPath)) continue;
    const record = packages.records.find((candidate) => candidate.path === manifestPath);
    lockfiles.push(prepareSynchronizedLockfile(lockPath, record ? [record] : [], dirname(manifestPath), packages.names, version));
  }

  // Preflight every manifest and lockfile before writing so structural errors do not leave a partial version bump.
  for (const record of packages.records) synchronizeManifest(record, packages.names, version);
  for (const record of packages.records) writeJson(record.path, record.manifest);
  for (const { path, lock } of lockfiles) writeJson(path, lock);
  const result = checkReleasePackageVersions(root, version);
  return Object.freeze({ ...result, files: uniquePaths([...packages.records.map((record) => record.path), ...lockfiles.map(({ path }) => path)]).map((path) => displayPath(root, path)) });
}

function optionValue(args, option) {
  const index = args.indexOf(option);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function positionalVersion(args) {
  const optionsWithValues = new Set(["--github-output", "--root"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (optionsWithValues.has(argument)) { index += 1; continue; }
    if (!argument.startsWith("--")) return argument;
  }
  return undefined;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath);
if (invoked) {
  try {
    const args = process.argv.slice(2);
    const root = resolve(optionValue(args, "--root") ?? projectRoot);
    const versionInput = positionalVersion(args);
    if (args.includes("--set")) {
      if (!versionInput) throw new Error("--set requires a release version");
      const result = setReleasePackageVersions(versionInput, root);
      process.stdout.write(`Synchronized ${result.manifests} package manifests and ${result.lockfiles} lockfiles to ${result.version}\n`);
    } else if (args.includes("--check-packages")) {
      const requested = versionInput ? parseFridayReleaseVersion(versionInput).version : undefined;
      const result = checkReleasePackageVersions(root, requested);
      process.stdout.write(`Release package versions: PASS (${result.manifests} manifests, ${result.lockfiles} lockfiles, version ${result.version})\n`);
    } else {
      const parsed = parseFridayReleaseVersion(versionInput);
      if (args.includes("--canonical")) {
        process.stdout.write(`${parsed.canonical}\n`);
      } else {
        const output = optionValue(args, "--github-output");
        if (output) {
          appendFileSync(
            output,
            `version=${parsed.version}\ntag=${parsed.tag}\ncanonical=${parsed.canonical}\n`,
          );
        } else {
          process.stdout.write(`${JSON.stringify(parsed)}\n`);
        }
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
