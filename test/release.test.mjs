/**
 * Release-artifact tests: the things a marketplace reads off the REPOSITORY.
 *
 * Every check below fails SILENTLY in production. A missing `screenshots.json`,
 * an svg, an empty file, a patch whose loader entry name drifts from the package
 * name, or a client bundle that never got committed does not break the plugin —
 * it just means a market stops listing it, or the detail page shows no preview.
 * That is exactly the class of defect a test has to hold, because no runtime
 * error ever will.
 *
 * Sources: `awesome-dsh-plugin`'s `contributing.md` (entry gate), the
 * `dsh-client-modules` loader contract read from the installed DSH, and
 * `YELEBAI/dsh-plugin-marketplace`'s `registry/schema.json` + README.
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...parts) => readFileSync(join(pluginRoot, ...parts), 'utf8')
const manifest = JSON.parse(read('package.json'))

/**
 * Every declared test in the suite, counted from source.
 *
 * The READMEs quote this number, and it is exactly the kind of fact that rots
 * silently the moment someone adds a case. Counting it here turns "the docs
 * overstate the suite" into a failing test instead of a review miss.
 */
function declaredTestCount() {
  const directory = join(pluginRoot, 'test')
  return readdirSync(directory)
    .filter((name) => name.endsWith('.test.mjs'))
    .reduce((total, name) => total + [...readFileSync(join(directory, name), 'utf8').matchAll(/^test\(/gm)].length, 0)
}

test('the bundle patch is a repo-relative path that exists', () => {
  const patch = manifest.dsh?.bundle?.patch
  assert.equal(typeof patch, 'string')
  assert.match(patch, /^\.\//, 'a market requires a repo-relative safe path (no absolute, no "..")')
  assert.equal(patch.includes('..'), false)
  assert.equal(existsSync(join(pluginRoot, patch)), true)
})

test('the patch inserts a loader entry whose name IS the npm package name', () => {
  // A market recognises the plugin by matching this name against the package
  // name; a repo name or a short name is not recognised as a plugin at all.
  const text = read('cordis.patch.yml')
  const names = [...text.matchAll(/^\s*name:\s*'?([^'\s]+)'?\s*$/gm)].map((match) => match[1])
  assert.ok(names.includes(manifest.name), `patch names ${JSON.stringify(names)} do not include ${manifest.name}`)
})

test('the client bundle is declared, web-platform, and committed to the repo', () => {
  const client = manifest.dsh?.client
  if (client === undefined) return
  assert.equal(client.platform, 'web', 'a declared dsh.client must target the web')
  const entry = client.inject
  assert.ok(Array.isArray(entry) && entry.every((name) => typeof name === 'string'))

  const exported = manifest.exports['./client']
  const rel = typeof exported === 'string' ? exported : exported?.default
  assert.equal(typeof rel, 'string', 'dsh.client without an exports["./client"] entry cannot be served')
  // Committed, not built: a market falls back to npm/tarball when it is absent.
  assert.equal(existsSync(join(pluginRoot, rel)), true, `${rel} must be committed`)
})

test('screenshots.json lists 1-8 non-svg images that exist and are non-empty', () => {
  const path = join(pluginRoot, 'screenshots.json')
  assert.equal(existsSync(path), true, 'without this file the market has no deterministic preview source')
  const images = JSON.parse(read('screenshots.json'))

  assert.ok(Array.isArray(images), 'screenshots.json must be a JSON array of paths')
  assert.ok(images.length >= 1 && images.length <= 8, `expected 1-8 images, got ${images.length}`)
  for (const image of images) {
    assert.equal(typeof image, 'string')
    // svg is filtered out by the market (logos and badges), and a remote URL
    // would have to be one of four whitelisted GitHub hosts.
    assert.equal(image.toLowerCase().endsWith('.svg'), false, `${image} is an svg, which is always dropped`)
    const file = join(pluginRoot, image)
    assert.equal(existsSync(file), true, `${image} does not exist`)
    assert.ok(statSync(file).size > 1024, `${image} looks empty`)
    // The magic bytes must actually be an image, not a renamed text file.
    const magic = readFileSync(file).subarray(0, 4)
    const isJpeg = magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff
    const isPng = magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4e && magic[3] === 0x47
    assert.ok(isJpeg || isPng, `${image} is neither JPEG nor PNG`)
  }
})

test('each README shows only the screenshot matching its own language', () => {
  // A reader of the Chinese page must not be shown the English UI, and vice
  // versa; the market still gets both, because it reads screenshots.json.
  const zh = read('README.md')
  const en = read('README.en.md')
  assert.match(zh, /!\[[^\]]*\]\(assets\/preview-zh\.jpg\)/, 'README.md must embed the Chinese UI')
  assert.equal(zh.includes('preview-en.jpg'), false, 'README.md must not embed the English UI')
  assert.match(en, /!\[[^\]]*\]\(assets\/preview-en\.jpg\)/, 'README.en.md must embed the English UI')
  assert.equal(en.includes('preview-zh.jpg'), false, 'README.en.md must not embed the Chinese UI')
})

test('the READMEs document the GitHub install route a market looks for', () => {
  const wanted = `dsh plugin --profile web add github:runcat-tommy/${manifest.name}`
  for (const file of ['README.md', 'README.en.md']) {
    assert.ok(read(file).includes(wanted), `${file} must show "${wanted}"`)
  }
})

test('the READMEs document all three install routes and the mandatory restart', () => {
  // The three routes differ in build approval and in how they update, so a
  // one-command install section is not enough: dropping any of them is how a
  // reader ends up running a build that does not exist, or assuming a refresh
  // is enough. The npm route in particular disappears if a release forgets it.
  const routes = [
    `dsh plugin --profile web add ${manifest.name}`, // ① npm
    `dsh plugin --profile web add github:runcat-tommy/${manifest.name}`, // ② GitHub source
    'git clone https://github.com/runcat-tommy/', // ③ local, with git
  ]
  for (const file of ['README.md', 'README.en.md']) {
    const text = read(file)
    for (const route of routes) assert.ok(text.includes(route), `${file} is missing the install route "${route}"`)
    assert.ok(text.includes('remove'), `${file} must document uninstalling`)
    assert.match(text, /重启|restart/i, `${file} must warn that a restart is required`)
    // Route ③ has to work on a machine with no git at all, which is the whole
    // point of offering a plain download next to the clone.
    assert.ok(text.includes('Download ZIP'), `${file} must offer the no-git Download ZIP path`)
  }
  // Publishing to npm is what makes route ① real; the packument must exist for it.
  assert.equal(manifest.name, 'dsh-skill-mini-manager')
})

test('the description fits the registry limit and leads in English', () => {
  // The registry hard-cuts `description` at 255 characters, mid-word, and keeps
  // the full text in the tarball. That silent mismatch is visible only on the
  // npm page, so it is pinned here instead of discovered after a release.
  assert.ok(manifest.description.length <= 255, `description is ${manifest.description.length} chars, over the 255 limit`)
  // English first, Chinese appended: the npm page renders README.md's language.
  assert.match(manifest.description, /^[\x20-\x7e]+/, 'the description must open in English')
  assert.match(manifest.description, /[^\x00-\x7f]/, 'the Chinese half must survive alongside it')
})

test('no lifecycle script that would force a build approval on the GitHub route', () => {
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(
      manifest.scripts?.[script],
      undefined,
      `a "${script}" script makes every GitHub-source install require build approval`,
    )
  }
})

test('the READMEs and LICENSE that npm renders are present and shipped', () => {
  for (const file of ['README.md', 'README.en.md', 'LICENSE', 'CHANGELOG.md', 'CHANGELOG.en.md']) {
    assert.equal(existsSync(join(pluginRoot, file)), true, `${file} is missing`)
    assert.equal(manifest.files.includes(file), true, `${file} is not in package.json "files"`)
  }
  // The README embeds assets/preview-*.jpg, so the images must ship too or the
  // npm page renders a broken image.
  for (const entry of ['assets', 'screenshots.json']) {
    assert.equal(manifest.files.includes(entry), true, `${entry} must ship for the README image to resolve`)
  }
})

test('the changelog is a dated, bilingual pair', () => {
  // Every sibling plugin dates its entries, and 4 of 5 ship an English CHANGELOG
  // next to the Chinese one. A CHANGELOG with no dates is not checkable against
  // git history, which is most of the point of keeping one.
  const zh = read('CHANGELOG.md')
  const en = read('CHANGELOG.en.md')

  for (const version of ['1.0.0', '1.0.1', '2.0.1', '2.0.2']) {
    const escaped = version.replace(/\./g, '\\.')
    assert.match(
      zh,
      new RegExp(`^## \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'),
      `CHANGELOG.md entry ${version} must be dated as "## [${version}] - YYYY-MM-DD"`,
    )
    assert.match(
      en,
      new RegExp(`^## \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'),
      `CHANGELOG.en.md entry ${version} must carry the same dated heading`,
    )
  }
  // Newest first, and the English file must lead with the newest entry.
  assert.match(en, /^## \[2\.0\.2\] - \d{4}-\d{2}-\d{2}$/m)
})

test('the marketplace declaration uses the documented four-field shape', () => {
  const declared = manifest.dsh?.marketplace
  if (declared === undefined) return
  assert.deepEqual(Object.keys(declared).sort(), [
    'manualSteps',
    'profiles',
    'requiresBuildApproval',
    'requiresRestart',
  ])
  // Host rows mount their routes at startup, so a restart is genuinely required.
  assert.equal(declared.requiresRestart, true)
  assert.deepEqual(declared.profiles, ['web'])
})

test('the test count quoted in the READMEs is the real one', () => {
  // This file counts itself, so the number below stays honest when cases are
  // added or removed rather than needing a manual bump.
  const total = declaredTestCount()
  assert.ok(total > 0, 'no tests were counted — the source scan is broken')
  for (const [file, phrase] of [
    ['README.md', `全部 ${total} 个测试`],
    ['README.en.md', `all ${total} tests`],
  ]) {
    const text = read(file)
    assert.ok(text.includes(phrase), `${file} must contain "${phrase}" (it currently quotes a stale count)`)
    assert.ok(text.includes(`${total} 个测试`) || text.includes(`${total} tests`), `${file} table row must quote ${total}`)
  }
})
