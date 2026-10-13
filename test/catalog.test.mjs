/**
 * Unit tests for the pure removal-planning rules.
 *
 * These are the rules that decide whether a skill may be removed at all, and
 * what exactly would move — so they run without a Cordis context, a filesystem,
 * or a browser.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join, resolve, sep } from 'node:path'

import {
  PROTECTED_PROVIDERS,
  PROTECTED_SOURCES,
  SKILL_FILE_NAME,
  isInside,
  isTrashEntryName,
  planRemoval,
  resolveHarnessHomes,
  samePath,
  trashEntryName,
  trashRoot,
  userSkillRoots,
} from '../lib/catalog.js'

const POSIX = Object.freeze({ caseInsensitive: false, platform: 'linux' })

/** Build a plan-removal input with the platform-independent comparison. */
function plan(input) {
  return planRemoval({ caseInsensitive: false, ...input })
}

test('resolveHarnessHomes prefers environment overrides and falls back to the OS home', () => {
  const homes = resolveHarnessHomes({ DSH_HOME: ' /custom/dsh ', DSH_AGENTS_HOME: '', DSH_BUNDLED_SKILL_DIR: '/bundled' }, '/home/u')
  assert.equal(homes.dshHome, '/custom/dsh')
  assert.equal(homes.agentsHome, join('/home/u', '.agents'))
  assert.equal(homes.bundledSkillDir, '/bundled')

  const defaults = resolveHarnessHomes({}, '/home/u')
  assert.equal(defaults.dshHome, join('/home/u', '.dsh'))
  assert.equal(defaults.agentsHome, join('/home/u', '.agents'))
  assert.equal(defaults.bundledSkillDir, null)
})

test('userSkillRoots lists the DSH root before the shared agents root', () => {
  const homes = { dshHome: join('/h', '.dsh'), agentsHome: join('/h', '.agents') }
  assert.deepEqual(userSkillRoots(homes), [join('/h', '.dsh', 'skills'), join('/h', '.agents', 'skills')])
})

test('trashRoot sits outside every scanned skill root', () => {
  const homes = { dshHome: join('/h', '.dsh'), agentsHome: join('/h', '.agents') }
  const trash = trashRoot(homes)
  assert.equal(trash, join('/h', '.dsh', '.skill-mini-manager', 'trash'))
  for (const root of userSkillRoots(homes)) {
    assert.equal(isInside(trash, root, POSIX), false, `trash must not be inside ${root}`)
  }
})

test('isInside treats a path as inside itself and rejects siblings and prefixes', () => {
  assert.equal(isInside('/a/b', '/a', POSIX), true)
  assert.equal(isInside('/a', '/a', POSIX), true)
  assert.equal(isInside('/a/b/c', '/a/b', POSIX), true)
  assert.equal(isInside('/ab/c', '/a', POSIX), false)
  assert.equal(isInside('/a', '/a/b', POSIX), false)
})

test('samePath folds case only when asked', () => {
  assert.equal(samePath('/A/B', '/a/b', false), false)
  assert.equal(samePath('/A/B', '/a/b', true), true)
})

test('a user directory bundle is removable and yields the bundle, not the file', () => {
  const root = resolve('/h/.dsh/skills')
  const file = join(root, 'demo', SKILL_FILE_NAME)
  const result = plan({ filePath: file, source: 'user-dsh', provider: 'filesystem', roots: [root] })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'bundle')
  assert.equal(result.bundle, join(root, 'demo'))
  assert.equal(result.root, root)
})

test('a flat markdown skill removes exactly that file', () => {
  const root = resolve('/h/.agents/skills')
  const file = join(root, 'flat.md')
  const result = plan({ filePath: file, source: 'user-agents', provider: 'filesystem', roots: [root] })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'file')
  assert.equal(result.bundle, file)
})

test('the removal target never climbs to the whole skills root', () => {
  const root = resolve('/h/.dsh/skills')
  // A bare SKILL.md sitting directly in the root has no bundle directory of its
  // own, so the derived root is the root's parent — not a skill root at all.
  const loose = plan({ filePath: join(root, SKILL_FILE_NAME), source: 'user-dsh', provider: 'filesystem', roots: [root] })
  assert.equal(loose.ok, false)
  assert.equal(loose.reason, 'outside-skill-roots')

  // Even when that parent is declared as a root too, the bundle must not be a
  // root: removing it would take the whole root with it.
  const nested = plan({
    filePath: join(root, SKILL_FILE_NAME),
    source: 'user-dsh',
    provider: 'filesystem',
    roots: [root, resolve('/h/.dsh')],
  })
  assert.equal(nested.ok, false)
  assert.equal(nested.reason, 'unsupported-layout')
})

test('bundled and runtime skills are refused', () => {
  const root = resolve('/h/.dsh/skills')
  const file = join(root, 'demo', SKILL_FILE_NAME)
  const bundled = plan({ filePath: file, source: 'bundled', provider: 'filesystem', roots: [root] })
  assert.equal(bundled.ok, false)
  assert.equal(bundled.reason, 'bundled-source')
  const runtime = plan({ filePath: file, source: 'user-dsh', provider: 'runtime', roots: [root] })
  assert.equal(runtime.ok, false)
  assert.equal(runtime.reason, 'runtime-provider')
})

test('the protected lists are exactly what the plugin claims', () => {
  assert.deepEqual([...PROTECTED_SOURCES], ['bundled'])
  assert.deepEqual([...PROTECTED_PROVIDERS], ['runtime'])
})

test('anything under a .system segment is refused', () => {
  const root = resolve('/h/.dsh/skills')
  const file = join(root, '.system', 'demo', SKILL_FILE_NAME)
  const result = plan({ filePath: file, source: 'user-dsh', provider: 'filesystem', roots: [root] })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'system-owned')
})

test('a skill outside every known root is refused even when the layout looks right', () => {
  const root = resolve('/h/.dsh/skills')
  const file = resolve('/elsewhere/loose/demo', SKILL_FILE_NAME)
  const result = plan({ filePath: file, source: 'user-dsh', provider: 'filesystem', roots: [root] })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'outside-skill-roots')
})

test('a custom root that is not literally named "skills" is accepted only when declared', () => {
  const custom = resolve('/opt/team-skills')
  const file = join(custom, 'demo', SKILL_FILE_NAME)
  assert.equal(plan({ filePath: file, source: 'custom', provider: 'filesystem', roots: [] }).reason, 'outside-skill-roots')
  const declared = plan({ filePath: file, source: 'custom', provider: 'filesystem', roots: [custom] })
  assert.equal(declared.ok, true)
  assert.equal(declared.bundle, join(custom, 'demo'))
})

test('a directory literally named "skills" is accepted without a declared root', () => {
  const file = join(resolve('/somewhere/skills'), 'demo', SKILL_FILE_NAME)
  const result = plan({ filePath: file, source: 'project-dsh', provider: 'filesystem', roots: [] })
  assert.equal(result.ok, true)
})

test('a skill definition with no usable path is reported as not-on-disk', () => {
  for (const filePath of [undefined, null, '', 'relative/SKILL.md']) {
    const result = plan({ filePath, source: 'user-dsh', provider: 'filesystem', roots: [] })
    assert.equal(result.ok, false, `expected refusal for ${JSON.stringify(filePath)}`)
    assert.equal(result.reason, 'not-on-disk')
  }
})

test('a non-markdown leaf file is refused as an unsupported layout', () => {
  const root = resolve('/h/.dsh/skills')
  const result = plan({ filePath: join(root, 'demo', 'notes.txt'), source: 'user-dsh', provider: 'filesystem', roots: [root] })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unsupported-layout')
})

test('a volume root is never accepted as a skill root', () => {
  const volume = resolve(sep)
  const result = plan({ filePath: join(volume, SKILL_FILE_NAME), source: 'user-dsh', provider: 'filesystem', roots: [volume] })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unsupported-layout')
})

test('non-string root entries are ignored rather than throwing', () => {
  const root = resolve('/h/.dsh/skills')
  const file = join(root, 'demo', SKILL_FILE_NAME)
  const result = plan({ filePath: file, source: 'user-dsh', provider: 'filesystem', roots: [null, 7, '', root] })
  assert.equal(result.ok, true)
})

test('isTrashEntryName accepts only names this plugin writes', () => {
  assert.equal(isTrashEntryName('1750000000000-demo-a1b2c3'), true)
  assert.equal(isTrashEntryName('1750000000000-flat.md-dead'), true)
  assert.equal(isTrashEntryName('demo'), false)
  assert.equal(isTrashEntryName('1750000000000-../escape'), false)
  assert.equal(isTrashEntryName('175-unterminated'), false)
  assert.equal(isTrashEntryName(''), false)
})

test('trashEntryName is slugged, bounded and collision-resistant by nonce', () => {
  const first = trashEntryName('My Skill!', 1750000000000, 'aaaaaa')
  const second = trashEntryName('My Skill!', 1750000000000, 'bbbbbb')
  assert.equal(first, '1750000000000-my-skill-aaaaaa')
  assert.notEqual(first, second)
  assert.equal(isTrashEntryName(first), true)
  assert.equal(isTrashEntryName(second), true)
  assert.equal(isTrashEntryName(trashEntryName('///', 1750000000000, 'cccccc')), true)
  assert.ok(trashEntryName('x'.repeat(400), 1750000000000, 'dddddd').length < 120)
})
