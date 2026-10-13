/**
 * dsh-skill-mini-manager — pure catalog/removal logic.
 *
 * Everything in this module is a pure function over strings and plain data, so
 * the safety rules that decide "may this skill be removed, and what exactly
 * would be moved" are unit-testable without a Cordis context, a filesystem, or
 * a browser.
 *
 * The one rule that matters: **the browser never names a path**. The client
 * sends a skill NAME; the host re-resolves that name through `ctx.skills` and
 * derives the removal target here. A compromised page therefore cannot ask the
 * plugin to delete an arbitrary file.
 *
 * @module dsh-skill-mini-manager/catalog
 */

import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse as parsePath, resolve, sep } from 'node:path'

/** The directory-bundle marker file every filesystem skill must carry. */
export const SKILL_FILE_NAME = 'SKILL.md'

/** Skill sources this plugin refuses to touch: packaging-owned, not user-owned. */
export const PROTECTED_SOURCES = Object.freeze(['bundled'])

/** Skill providers this plugin refuses to touch: in-process registrations, not files. */
export const PROTECTED_PROVIDERS = Object.freeze(['runtime'])

/** Path segment owned by the harness itself; never a user skill. */
const SYSTEM_SEGMENT = '.system'

/** Trim a value that may be an environment override; empty means unset. */
function trimOrUndefined(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Resolve the two harness homes a filesystem skill provider scans, mirroring
 * `@deepseek-ai/dsh-home-paths` precedence (`$DSH_HOME` then `~/.dsh`) without
 * importing it: this package is distributed outside the harness repo, so it
 * keeps zero `@deepseek-ai/*` runtime imports.
 * @param env - environment mapping; defaults to `process.env`.
 * @param osHome - operating-system home directory; defaults to `os.homedir()`.
 * @returns absolute harness home paths plus the bundled-skill root when declared.
 */
export function resolveHarnessHomes(env = process.env, osHome = homedir()) {
  const dshHome = trimOrUndefined(env.DSH_HOME) ?? join(osHome, '.dsh')
  const agentsHome = trimOrUndefined(env.DSH_AGENTS_HOME) ?? join(osHome, '.agents')
  const bundledSkillDir = trimOrUndefined(env.DSH_BUNDLED_SKILL_DIR)
  return {
    dshHome,
    agentsHome,
    bundledSkillDir: bundledSkillDir === undefined ? null : bundledSkillDir,
  }
}

/**
 * The default user-level skill roots, in the provider's rank order (user-dsh
 * before user-agents). Project roots are deliberately absent: the Settings
 * panel has no workspace, so the page shows what the installation owns.
 * @param homes - result of {@link resolveHarnessHomes}.
 * @returns absolute user skill root paths.
 */
export function userSkillRoots(homes) {
  return [join(homes.dshHome, 'skills'), join(homes.agentsHome, 'skills')]
}

/**
 * Where removed skill bundles are parked. It sits beside the skill roots, never
 * inside one, so the provider's one-level discovery can never see a trashed
 * skill again.
 * @param homes - result of {@link resolveHarnessHomes}.
 * @returns absolute trash root path.
 */
export function trashRoot(homes) {
  return join(homes.dshHome, '.skill-mini-manager', 'trash')
}

/** Case-insensitive when the platform folds path case. */
function fold(value, caseInsensitive) {
  return caseInsensitive ? value.toLowerCase() : value
}

/**
 * Whether two paths name the same location.
 * @param a - first path.
 * @param b - second path.
 * @param caseInsensitive - whether comparison folds case.
 * @returns whether both resolve to the same path.
 */
export function samePath(a, b, caseInsensitive = folds(process.platform)) {
  return fold(resolve(a), caseInsensitive) === fold(resolve(b), caseInsensitive)
}

/** Whether `caseInsensitive` path semantics apply to the running platform. */
function folds(platform) {
  return platform === 'win32' || platform === 'darwin'
}

/**
 * Whether `child` resolves to `parent` or somewhere strictly below it.
 * @param child - candidate descendant path.
 * @param parent - candidate ancestor path.
 * @param options - optional platform override for path-case folding.
 * @returns whether the containment holds.
 */
export function isInside(child, parent, options = {}) {
  const caseInsensitive = options.caseInsensitive ?? folds(process.platform)
  const from = fold(resolve(parent), caseInsensitive)
  const to = fold(resolve(child), caseInsensitive)
  if (from === to) return true
  return to.startsWith(from.endsWith(sep) ? from : from + sep)
}

/** Whether any path segment is the harness-owned `.system` directory. */
function hasSystemSegment(path) {
  return path
    .split(/[\\/]+/)
    .some((segment) => segment.toLowerCase() === SYSTEM_SEGMENT)
}

/** Whether `path` is a filesystem root (`C:\` or `/`) rather than a directory inside one. */
function isVolumeRoot(path) {
  const resolved = resolve(path)
  return parsePath(resolved).root === resolved
}

/**
 * Decide what removing one skill would move, and whether that is allowed.
 *
 * The target is derived from the skill definition's own file path: a
 * `<name>/SKILL.md` bundle yields `<name>/`, a flat `<name>.md` yields that one
 * file. `resourceBase` is deliberately NOT used — for a flat-file skill it is
 * the whole skills root, which would be catastrophic to remove.
 *
 * @param input - the definition's file path plus its reported source/provider.
 * @returns a plan (`ok: true`) or a refusal carrying a machine-readable reason.
 */
export function planRemoval(input) {
  const { filePath, source, provider } = input
  const roots = (Array.isArray(input.roots) ? input.roots : []).filter(
    (candidate) => typeof candidate === 'string' && candidate.length > 0,
  )
  const caseInsensitive = input.caseInsensitive ?? folds(process.platform)
  const compare = { caseInsensitive }

  if (typeof filePath !== 'string' || filePath.length === 0 || !isAbsolute(filePath)) {
    return { ok: false, reason: 'not-on-disk' }
  }
  if (typeof provider === 'string' && PROTECTED_PROVIDERS.includes(provider)) {
    return { ok: false, reason: 'runtime-provider' }
  }
  if (typeof source === 'string' && PROTECTED_SOURCES.includes(source)) {
    return { ok: false, reason: 'bundled-source' }
  }
  if (hasSystemSegment(filePath)) return { ok: false, reason: 'system-owned' }

  const name = basename(filePath)
  let bundle
  let root
  let kind
  if (name === SKILL_FILE_NAME) {
    bundle = dirname(filePath)
    root = dirname(bundle)
    kind = 'bundle'
  } else if (name.toLowerCase().endsWith('.md')) {
    bundle = filePath
    root = dirname(filePath)
    kind = 'file'
  } else {
    return { ok: false, reason: 'unsupported-layout' }
  }

  if (samePath(bundle, root, caseInsensitive)) return { ok: false, reason: 'unsupported-layout' }
  if (isVolumeRoot(root)) return { ok: false, reason: 'unsupported-layout' }
  if (!isInside(bundle, root, compare)) return { ok: false, reason: 'unsupported-layout' }

  const declared = roots.some((candidate) => isInside(root, candidate, compare))
  const skillsNamed = basename(root).toLowerCase() === 'skills'
  if (!declared && !skillsNamed) return { ok: false, reason: 'outside-skill-roots' }

  // The removal target must never be a skill root itself. Without this, a bare
  // `<root>/SKILL.md` whose parent happens to also be declared as a root would
  // nominate the whole root for removal.
  if (roots.some((candidate) => samePath(bundle, candidate, caseInsensitive))) {
    return { ok: false, reason: 'unsupported-layout' }
  }

  return { ok: true, kind, bundle, root }
}

/**
 * Whether a trash directory name is one this plugin may act on. Restore and
 * purge only ever address entries the plugin itself wrote, whose names are
 * `<epoch-ms>-<slug>`.
 * @param entryName - one directory name inside the trash root.
 * @returns whether the name matches the plugin's own trash-entry shape.
 */
export function isTrashEntryName(entryName) {
  return /^\d{10,16}-[a-z0-9][a-z0-9._-]*$/i.test(entryName) && !entryName.includes('..')
}

/**
 * Build a collision-resistant trash entry name for one removed skill.
 * @param skillName - the removed skill's kebab-case name.
 * @param now - removal timestamp in epoch milliseconds.
 * @param nonce - disambiguating suffix, so two removals in one millisecond cannot collide.
 * @returns the directory name to use under the trash root.
 */
export function trashEntryName(skillName, now, nonce) {
  const slug = String(skillName)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return `${Math.trunc(now)}-${slug.length === 0 ? 'skill' : slug}-${nonce}`
}

/**
 * Human-readable summary of one scanned skill bundle, as the catalog reports it.
 * Kept pure: the caller supplies the already-measured numbers.
 * @param input - measured bundle facts.
 * @returns the wire shape the browser renders.
 */
export function bundleFacts(input) {
  return {
    files: input.files ?? null,
    bytes: input.bytes ?? null,
    modifiedAt: input.modifiedAt ?? null,
    truncated: input.truncated === true,
  }
}
