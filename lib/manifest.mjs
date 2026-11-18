/**
 * The deployment manifest: a declarative description of which plugins a DSH
 * profile should have, at which exact versions.
 *
 * The point is reproducibility. A profile's package.json records SPECIFIERS
 * (`^0.26.4`, `github:owner/repo#sha`), which resolve differently over time.
 * A manifest records what was actually installed, so a second machine can be
 * brought to the same state instead of merely a similar one.
 *
 * @module dsh-deploy/manifest
 */

import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** Bumped when the on-disk shape changes in a way readers must notice. */
export const MANIFEST_SCHEMA = 1

/** How a dependency resolves, which decides how it is reinstalled. */
export const SOURCE_KINDS = ['registry', 'git', 'tarball', 'link']

/**
 * Classify a recorded dependency value into the source kind that decides how
 * it is reinstalled.
 * @param {string} spec the specifier as recorded in package.json
 * @returns {'registry'|'git'|'tarball'|'link'}
 */
export function classifySource(spec) {
  if (typeof spec !== 'string') return 'registry'
  if (spec.startsWith('link:')) return 'link'
  if (spec.startsWith('file:')) return 'tarball'
  if (spec.startsWith('github:') || spec.startsWith('git+') || spec.startsWith('git:')) return 'git'
  if (/^https?:/.test(spec) && /\.git(#|$)|\/archive\/|codeload/.test(spec)) return 'git'
  return 'registry'
}

/**
 * A stable, content-derived identity for a manifest: two machines that agree
 * on this hash agree on the whole deployment.
 * @param {object} manifest parsed manifest
 * @returns {string} 16 hex characters
 */
export function manifestHash(manifest) {
  const canonical = JSON.stringify({
    schema: manifest.schema,
    profile: manifest.profile,
    plugins: [...(manifest.plugins ?? [])]
      .map((p) => [p.name, p.version, p.source, p.spec])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/**
 * Validate a parsed manifest and collect every problem at once, so a user
 * fixing a hand-edited file sees the whole list instead of one error per run.
 * @param {unknown} raw parsed JSON
 * @returns {{ok: boolean, problems: string[], manifest?: object}}
 */
export function validateManifest(raw) {
  const problems = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, problems: ['manifest must be a JSON object'] }
  }
  const m = /** @type {any} */ (raw)

  if (m.schema !== undefined && m.schema !== MANIFEST_SCHEMA) {
    problems.push(`unsupported manifest schema ${JSON.stringify(m.schema)}; this plugin reads schema ${MANIFEST_SCHEMA}`)
  }
  if (typeof m.profile !== 'string' || m.profile.trim() === '') {
    problems.push('"profile" must be a non-empty string (for example "web")')
  }
  if (!Array.isArray(m.plugins)) {
    problems.push('"plugins" must be an array')
    return { ok: false, problems }
  }

  const seen = new Set()
  m.plugins.forEach((p, i) => {
    const at = `plugins[${i}]`
    if (p === null || typeof p !== 'object') {
      problems.push(`${at} must be an object`)
      return
    }
    if (typeof p.name !== 'string' || p.name.trim() === '') {
      problems.push(`${at}.name must be a non-empty string`)
    } else if (seen.has(p.name)) {
      problems.push(`${at}.name "${p.name}" appears more than once`)
    } else {
      seen.add(p.name)
    }
    if (typeof p.version !== 'string' || p.version.trim() === '') {
      problems.push(`${at}.version must be a non-empty exact version`)
    }
    if (p.source !== undefined && !SOURCE_KINDS.includes(p.source)) {
      problems.push(`${at}.source must be one of ${SOURCE_KINDS.join(', ')}`)
    }
  })

  return problems.length ? { ok: false, problems } : { ok: true, problems, manifest: m }
}

/**
 * Read and validate a manifest file.
 * @param {string} file absolute path
 * @returns {{ok: boolean, problems: string[], manifest?: object, path: string}}
 */
export function readManifestFile(file) {
  if (!existsSync(file)) {
    return { ok: false, problems: [`manifest not found: ${file}`], path: file }
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return { ok: false, problems: [`manifest is not valid JSON: ${error.message}`], path: file }
  }
  return { ...validateManifest(raw), path: file }
}

/**
 * Build a manifest from an installed profile: the export half of the feature.
 * Reads only the profile manifest and each installed package's own metadata;
 * never runs a package manager.
 * @param {string} profileDir absolute profile directory
 * @param {string} profileName profile name recorded in the manifest
 * @returns {{ok: boolean, problems: string[], manifest?: object}}
 */
export function buildManifestFromProfile(profileDir, profileName) {
  const pkgPath = join(profileDir, 'package.json')
  if (!existsSync(pkgPath)) {
    return { ok: false, problems: [`no profile manifest at ${pkgPath}`] }
  }
  let profilePkg
  try {
    profilePkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch (error) {
    return { ok: false, problems: [`profile manifest is not valid JSON: ${error.message}`] }
  }

  const declared = profilePkg.dependencies ?? {}
  const bundles = new Set(profilePkg.dsh?.profile?.bundles ?? [])
  const plugins = []

  for (const [name, spec] of Object.entries(declared)) {
    const source = classifySource(spec)
    let installed = null
    try {
      installed = JSON.parse(readFileSync(join(profileDir, 'node_modules', name, 'package.json'), 'utf8'))
    } catch {
      installed = null
    }
    plugins.push({
      name,
      version: installed?.version ?? null,
      spec,
      source,
      bundle: bundles.has(name),
      installed: installed !== null,
    })
  }

  plugins.sort((a, b) => a.name.localeCompare(b.name))
  // A declared-but-missing package is not a "problem": the diff already reports
  // it as an install. Reporting both made one gap look like two failures.
  const notInstalled = plugins.filter((p) => !p.installed).map((p) => p.name)

  const manifest = {
    schema: MANIFEST_SCHEMA,
    profile: profileName,
    generatedAt: new Date().toISOString(),
    plugins,
  }
  return { ok: true, problems: [], notInstalled, manifest }
}

/**
 * Compare a desired manifest against what a profile currently has.
 * Produces the plan the user reviews before anything is installed.
 * @param {object} desired validated manifest
 * @param {object} current manifest built from the live profile
 * @returns {{install: object[], upgrade: object[], downgrade: object[], remove: object[], unchanged: object[], bundleChanges: object[]}}
 */
export function diffManifests(desired, current) {
  const want = new Map((desired.plugins ?? []).map((p) => [p.name, p]))
  const have = new Map((current.plugins ?? []).map((p) => [p.name, p]))

  const install = []
  const upgrade = []
  const downgrade = []
  const unchanged = []
  const bundleChanges = []

  for (const [name, wantPlugin] of want) {
    const havePlugin = have.get(name)
    if (!havePlugin || !havePlugin.installed) {
      install.push(wantPlugin)
      if (wantPlugin.bundle) bundleChanges.push({ name, change: 'activate-bundle' })
      continue
    }
    if (havePlugin.version === wantPlugin.version) {
      unchanged.push(wantPlugin)
    } else if (compareVersions(wantPlugin.version, havePlugin.version) > 0) {
      upgrade.push({ ...wantPlugin, from: havePlugin.version })
    } else {
      downgrade.push({ ...wantPlugin, from: havePlugin.version })
    }
    if (wantPlugin.bundle === true && havePlugin.bundle === false) {
      bundleChanges.push({ name, change: 'activate-bundle' })
    }
  }

  // A manifest is declarative: anything present but unlisted is reported, not
  // silently removed. Removal stays the user's explicit decision.
  const remove = []
  for (const [name, havePlugin] of have) {
    if (!want.has(name)) remove.push(havePlugin)
  }

  return { install, upgrade, downgrade, remove, unchanged, bundleChanges }
}

/**
 * Numeric-aware comparison of dotted versions; prerelease tags sort before
 * their release. Deliberately small: full semver ranges are not needed because
 * a manifest records exact versions.
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when a < b
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).split('-')
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0)
    return { nums, pre: pre ?? null }
  }
  const A = parse(a)
  const B = parse(b)
  for (let i = 0; i < Math.max(A.nums.length, B.nums.length); i++) {
    const d = (A.nums[i] ?? 0) - (B.nums[i] ?? 0)
    if (d !== 0) return d
  }
  if (A.pre === B.pre) return 0
  if (A.pre === null) return 1
  if (B.pre === null) return -1
  return A.pre.localeCompare(B.pre)
}
