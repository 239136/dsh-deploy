/**
 * dsh-deploy — declarative deployment manifests for DSH profiles.
 *
 * Two tools, deliberately split by risk:
 *
 * - `dsh_deploy_plan` is read-only. It reads a manifest, reads what this
 *   profile actually has, and reports the difference. It installs nothing, so
 *   it is safe to run before deciding.
 * - `dsh_deploy_apply` changes the profile. It is the only tool that runs a
 *   package manager, and it refuses anything the plan stage would reject.
 *
 * @module dsh-deploy
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

import {
  MANIFEST_SCHEMA,
  buildManifestFromProfile,
  diffManifests,
  manifestHash,
  readManifestFile,
  validateManifest,
} from './manifest.mjs'

export const name = 'deploy'
export const inject = ['tools']

/** Tool names, kept together because the plan/apply pair must stay in sync. */
const PLAN_TOOL = 'dsh_deploy_plan'
const APPLY_TOOL = 'dsh_deploy_apply'
const EXPORT_TOOL = 'dsh_deploy_export'

/**
 * Resolve the profile directory this plugin is running inside.
 *
 * The profile is the anchor for everything here: its package.json is both the
 * thing being compared and the thing being changed. `profileContext` is
 * optional rather than injected so this plugin still mounts on a host that
 * does not publish it; the fallback walks up from this file to the profile
 * root, which is where node_modules/<this package> lives.
 *
 * @param {any} ctx cordis context
 * @returns {string} absolute profile directory
 */
export function resolveProfileDir(ctx) {
  const fromService = ctx?.profileContext?.dir
  if (typeof fromService === 'string' && existsSync(join(fromService, 'package.json'))) {
    return fromService
  }
  // <profile>/node_modules/dsh-deploy/lib/index.js -> <profile>
  const here = dirname(fileURLToPath(import.meta.url))
  const candidate = resolve(here, '..', '..', '..')
  if (existsSync(join(candidate, 'package.json'))) return candidate
  throw new Error('dsh-deploy: cannot locate the profile directory')
}

/**
 * Read the profile's own package.json.
 * @param {string} profileDir
 * @returns {any}
 */
function readProfilePackage(profileDir) {
  return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
}

/**
 * Render a plan as the model-facing text. Terse on purpose: the counts matter,
 * and the per-name lines only for the categories that are non-empty.
 * @param {object} plan result of {@link buildPlan}
 * @returns {string}
 */
export function renderPlan(plan) {
  const lines = []
  lines.push(`manifest ${plan.manifestPath}`)
  lines.push(`  hash ${plan.hash}  profile "${plan.profile}"  ${plan.counts.desired} desired / ${plan.counts.current} installed`)
  if (plan.alreadyMatches) {
    lines.push('  this profile already matches the manifest')
  }
  const section = (title, items, fmt) => {
    if (!items.length) return
    lines.push(`  ${title} (${items.length}):`)
    for (const item of items.slice(0, 40)) lines.push('    ' + fmt(item))
    if (items.length > 40) lines.push(`    ... and ${items.length - 40} more`)
  }
  section('install', plan.install, (p) => `+ ${p.name}@${p.version} [${p.source}]`)
  section('upgrade', plan.upgrade, (p) => `^ ${p.name} ${p.from} -> ${p.version}`)
  section('downgrade', plan.downgrade, (p) => `v ${p.name} ${p.from} -> ${p.version}`)
  section('not in manifest (left alone)', plan.remove, (p) => `- ${p.name}@${p.version ?? '?'}`)
  section('bundle activation', plan.bundleChanges, (b) => `* ${b.name}`)
  if (plan.problems.length) {
    lines.push(`  problems (${plan.problems.length}):`)
    for (const p of plan.problems.slice(0, 20)) lines.push('    ! ' + p)
  }
  return lines.join('\n')
}

/**
 * Compute the plan for one manifest against one profile. Pure apart from
 * reading the profile and the manifest; never mutates anything.
 * @param {string} manifestPath absolute path to the manifest file
 * @param {string} profileDir absolute profile directory
 * @param {string} profileName profile name used in the generated manifest
 * @returns {object}
 */
export function buildPlan(manifestPath, profileDir, profileName) {
  const read = readManifestFile(manifestPath)
  if (!read.ok) {
    return { ok: false, manifestPath, problems: read.problems, install: [], upgrade: [], downgrade: [], remove: [], unchanged: [], bundleChanges: [] }
  }
  const desired = read.manifest
  const built = buildManifestFromProfile(profileDir, profileName)
  const current = built.manifest ?? { plugins: [] }

  const diff = diffManifests(desired, current)
  const problems = [...built.problems]
  if (desired.profile && desired.profile !== profileName) {
    problems.push(`manifest targets profile "${desired.profile}" but this host runs "${profileName}"`)
  }

  return {
    ok: true,
    manifestPath,
    profile: profileName,
    hash: manifestHash(desired),
    counts: { desired: desired.plugins.length, current: current.plugins.length },
    alreadyMatches: diff.install.length === 0 && diff.upgrade.length === 0
      && diff.downgrade.length === 0 && diff.bundleChanges.length === 0,
    problems,
    ...diff,
  }
}

/**
 * The specifier to hand to `pnpm add` for one manifest entry.
 * Registry and git entries pin the version; local entries keep their path.
 * @param {object} plugin manifest entry
 * @returns {string}
 */
export function specFor(plugin) {
  if (plugin.spec && (plugin.source === 'link' || plugin.source === 'tarball')) {
    return plugin.spec
  }
  if (plugin.source === 'git' && plugin.spec) {
    return plugin.spec
  }
  return plugin.version ? `${plugin.name}@${plugin.version}` : plugin.name
}

/**
 * Apply a plan: install the missing and changed packages through the profile's
 * own package manager, then report what the profile looks like afterwards.
 *
 * Bundle activation is NOT done here. `dsh plugin add` performs it, and doing
 * it by hand would race that code path; instead this reports which bundles the
 * user still needs to activate and lets them use the supported route.
 *
 * @param {object} plan result of {@link buildPlan}
 * @param {string} profileDir absolute profile directory
 * @param {{run?: Function}} [options] injectable command runner for tests
 * @returns {{ok: boolean, steps: object[], error?: string}}
 */
export function applyPlan(plan, profileDir, options = {}) {
  const run = options.run ?? ((cmd, argv, cwd) => execFileSync(cmd, argv, {
    cwd, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'],
  }))

  if (!plan.ok) return { ok: false, steps: [], error: 'plan has problems; fix the manifest first' }

  const targets = [...plan.install, ...plan.upgrade, ...plan.downgrade]
  const steps = []
  if (targets.length === 0) {
    return { ok: true, steps, note: 'nothing to install' }
  }

  // One pnpm invocation for the whole set: it resolves the group together,
  // which matters when two entries share a peer dependency.
  const specs = targets.map(specFor)
  try {
    const output = run('pnpm', ['add', ...specs], profileDir)
    steps.push({ action: 'pnpm add', specs, ok: true, output: String(output).slice(-2000) })
  } catch (error) {
    steps.push({ action: 'pnpm add', specs, ok: false, output: String(error.stderr ?? error.message).slice(-2000) })
    return { ok: false, steps, error: 'package manager failed; profile left as pnpm left it' }
  }

  return { ok: true, steps, bundlesPending: plan.bundleChanges.map((b) => b.name) }
}

/**
 * Register the tools.
 * @param {any} ctx cordis context
 * @param {{profile?: string, manifestPath?: string}} [config]
 */
export function apply(ctx, config = {}) {
  const profileName = config.profile ?? 'web'
  const defaultManifest = () => config.manifestPath
    ?? join(homedir(), '.dsh', 'dsh-deploy.manifest.json')

  let cachedProfileDir = null
  const profileDir = () => {
    if (cachedProfileDir === null) cachedProfileDir = resolveProfileDir(ctx)
    return cachedProfileDir
  }

  ctx.tools.register({
    name: PLAN_TOOL,
    description: [
      '读取一份 DSH 部署清单（JSON），与本机 profile 实际安装的插件逐项比对，报告差异。只读，不安装任何东西。',
      '清单记录每个插件的精确版本与来源（registry / git / tarball / link），因此比对结果是可复现的，而不是"大概一致"。',
      '先跑这个，看清楚会装什么、升什么、降什么，再决定要不要 apply。',
      '不传 manifestPath 时读取 ~/.dsh/dsh-deploy.manifest.json。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        manifestPath: { type: 'string', description: '清单文件的绝对路径；省略则用默认位置。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: value.ok ? renderPlan(value) : 'plan failed:\n' + (value.problems ?? []).join('\n') }]
      },
    },
    async execute(args) {
      const path = args?.manifestPath ? resolve(String(args.manifestPath)) : defaultManifest()
      return buildPlan(path, profileDir(), profileName)
    },
  })

  ctx.tools.register({
    name: EXPORT_TOOL,
    description: [
      '把本机 profile 当前实际安装的插件导出成一份清单文件，供另一台机器导入。',
      '记录的是每个插件已安装的精确版本和来源，不是 package.json 里的版本范围，因此另一台机器能装出同一套版本。',
      '只读取 profile，不安装、不修改任何东西。不传 outPath 时写到 ~/.dsh/dsh-deploy.manifest.json。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        outPath: { type: 'string', description: '清单输出路径；省略则用默认位置。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        if (!value.ok) return [{ type: 'text', text: 'export failed:\n' + (value.problems ?? []).join('\n') }]
        return [{
          type: 'text',
          text: `exported ${value.count} plugins -> ${value.path}\n  hash ${value.hash}`,
        }]
      },
    },
    async execute(args) {
      const dir = profileDir()
      const built = buildManifestFromProfile(dir, profileName)
      if (!built.manifest) return { ok: false, problems: built.problems }
      const outPath = args?.outPath ? resolve(String(args.outPath)) : defaultManifest()
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, JSON.stringify(built.manifest, null, 2) + '\n')
      return {
        ok: true,
        path: outPath,
        count: built.manifest.plugins.length,
        hash: manifestHash(built.manifest),
      }
    },
  })

  ctx.tools.register({
    name: APPLY_TOOL,
    description: [
      '按清单把本机 profile 装成清单描述的状态：安装缺失的、调整版本不一致的插件。',
      '这是本插件唯一会改动 profile 的工具，执行前会重新算一次计划并拒绝有问题的清单。',
      '它不删除清单外的插件（那是你的决定，不会被静默执行），也不手工登记 bundle——bundle 激活走 dsh plugin 的受支持路径。',
      '安装过程走 profile 自己的 pnpm，因此锁文件与版本策略和平时装插件一致。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        manifestPath: { type: 'string', description: '清单文件的绝对路径；省略则用默认位置。' },
        dryRun: { type: 'boolean', description: '只算计划不安装，默认 false。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        const lines = [value.ok ? 'apply: ok' : 'apply: failed']
        if (value.note) lines.push('  ' + value.note)
        if (value.error) lines.push('  error: ' + value.error)
        for (const s of value.steps ?? []) {
          lines.push(`  ${s.action} ${s.ok ? 'ok' : 'FAILED'}: ${(s.specs ?? []).join(' ')}`)
        }
        if (value.bundlesPending?.length) {
          lines.push('  bundles to activate via dsh plugin: ' + value.bundlesPending.join(', '))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const path = args?.manifestPath ? resolve(String(args.manifestPath)) : defaultManifest()
      const dir = profileDir()
      const plan = buildPlan(path, dir, profileName)
      if (args?.dryRun) return { ok: plan.ok, dryRun: true, plan, steps: [], note: 'dry run; nothing installed' }
      return applyPlan(plan, dir)
    },
  })
}

export default { name, inject, apply }
