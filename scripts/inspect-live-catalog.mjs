/**
 * Live layered-catalog probe (manual diagnostic, not part of `node --test`).
 *
 * The first shipped version of this plugin read `ctx.skills.snapshot()` from the
 * global layer only, and reported an empty catalog on a stock web profile. The
 * reason is composition, not a bug in the registry: `dsh-web-app`'s patch
 * DISABLES the host `skill-filesystem` row because "presets own local
 * discovery", so every user skill is registered into an agent preset's scope
 * layer and the global layer is genuinely empty.
 *
 * This script proves that against the real `@deepseek-ai/dsh-skill` and
 * `@deepseek-ai/dsh-skill-filesystem` packages, on the machine's real installed
 * skills, without booting DSH and without mounting a preset roster:
 *
 *   1. it mounts the provider at the root — the host-plane arrangement the web
 *      profile disables — so the global layer is populated and can be read;
 *   2. it mints a scope, mounts a second provider INSIDE that scope, and reads
 *      again through `snapshot({ scope })`. That scoped read is what the plugin's
 *      fix performs once per preset, and it must surface the scope's skills.
 *
 * It only READS: nothing is moved, deleted, or written, and DSH is untouched.
 *
 * Usage:
 *   node scripts/inspect-live-catalog.mjs [profileDir]
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

import { planRemoval, resolveHarnessHomes, trashRoot, userSkillRoots } from '../lib/catalog.js'

const profileDir = process.argv[2] ?? join(homedir(), '.dsh', 'profiles', 'web')
const require = createRequire(join(profileDir, 'package.json'))

/** Import an installed package by resolving it from the profile. */
async function load(specifier) {
  return import(pathToFileURL(require.resolve(specifier)).href)
}

const { Context } = await load('@deepseek-ai/cordis')
const { createScope } = await load('@deepseek-ai/dsh-scope')
const skillRegistry = await load('@deepseek-ai/dsh-skill')
const skillFilesystem = await load('@deepseek-ai/dsh-skill-filesystem')

const homes = resolveHarnessHomes()
const roots = userSkillRoots(homes)

const ctx = new Context()
ctx.plugin(skillRegistry.default)

const deadline = Date.now() + 10_000
while (ctx.get('skills') === undefined) {
  if (Date.now() > deadline) throw new Error('skill registry never became available')
  await new Promise((resolve) => setTimeout(resolve, 20))
}

/** A skill's removal plan, as the plugin's `planRemoval` computes it. */
function planFor(definition) {
  const plan = planRemoval({
    filePath: definition?.path,
    source: definition?.source,
    provider: definition?.provider,
    roots,
  })
  return { removable: plan.ok, wouldRemove: plan.ok ? plan.bundle : null, blocked: plan.ok ? null : plan.reason }
}

/** Describe every skill one registry view serves. */
async function report(options) {
  const snapshot = await ctx.skills.snapshot(options)
  const skills = []
  for (const summary of snapshot.skills) {
    const definition = await ctx.skills.get(summary.name, options)
    skills.push({
      name: summary.name,
      description: summary.description,
      path: definition?.path ?? null,
      ...planFor(definition),
    })
  }
  return { complete: snapshot.complete, skillCount: snapshot.skills.length, skills }
}

// --- 1. the GLOBAL layer, which a stock web profile leaves empty ---
const emptyGlobal = await report({})

ctx.plugin(skillFilesystem)
await new Promise((resolve) => setTimeout(resolve, 300))

// --- 2. the global layer WITH a host-plane provider, for reference ---
const populatedGlobal = await report({})

// --- 3. a scoped read: mount a provider inside a minted scope, as a preset does ---
const scopeKey = { probe: 'standing-preset' }
const scoped = createScope(ctx, scopeKey)
scoped.ctx.plugin(skillFilesystem)
await new Promise((resolve) => setTimeout(resolve, 300))

const scopedView = await report({ scope: scopeKey })

process.stdout.write(
  `${JSON.stringify(
    {
      dshHome: homes.dshHome,
      scannedRoots: roots,
      trashRoot: trashRoot(homes),
      globalLayerWithoutHostProvider: emptyGlobal,
      globalLayerWithHostProvider: populatedGlobal,
      presetScopeLayer: scopedView,
      verdict:
        scopedView.skillCount > 0
          ? 'CONFIRMED: a scoped read serves the installed skills, so reading one slot per preset is what the page must do'
          : 'INCONCLUSIVE: the scoped read found nothing either — investigate before trusting the fix',
    },
    null,
    2,
  )}\n`,
)

// The provider's filesystem watchers keep the loop alive, so shutdown is
// explicit rather than left to natural exit.
try {
  await scoped.dispose()
  await (ctx.stop?.() ?? Promise.resolve())
} catch {
  /* a diagnostic script has nothing to salvage from a noisy teardown */
}
process.exit(0)
