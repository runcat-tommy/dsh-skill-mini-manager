/**
 * Browser-half structural tests.
 *
 * The client bundle is hand-written and outside every build/type-check pipeline,
 * so these tests are its only gate. They load it exactly the way the DSH module
 * system does (`window.__ModuleLoader__.load`), then assert the things that
 * would otherwise fail silently in the browser: the registered bundle id, the
 * settings-slot contribution and its order, balanced dictionaries, token-only
 * CSS, and the fact that the page never sends a filesystem path to the host.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const clientPath = join(pluginRoot, 'lib', 'client.js')
const source = readFileSync(clientPath, 'utf8')
const manifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
const patch = readFileSync(join(pluginRoot, 'cordis.patch.yml'), 'utf8')

/** A `createElement` stand-in: enough for module-scope element construction. */
function fakeReact() {
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children })
  return {
    createElement,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useId: () => 'test',
  }
}

/** A `document` stand-in covering only what the stylesheet installer touches. */
function fakeDocument() {
  return {
    createElement: () => ({ dataset: {}, textContent: '', parentNode: null, removeChild() {} }),
    head: { appendChild() {} },
    querySelector: () => null,
  }
}

/** Distinct import URLs, so each test gets a freshly evaluated bundle. */
let evaluation = 0

/** Load the bundle the way `dsh-client-modules` does. */
async function loadBundle() {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  let handoff
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        assert.equal(handoff, undefined, 'the bundle must register exactly once')
        handoff = spec
      },
    },
  }
  globalThis.document = fakeDocument()
  try {
    evaluation += 1
    // ESM caches by URL, so a per-test query keeps every case a fresh evaluation.
    await import(`file://${clientPath.replaceAll('\\', '/')}?evaluation=${evaluation}`)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
  assert.ok(handoff, 'the bundle registered nothing through window.__ModuleLoader__')
  return handoff
}

/** A fake client Cordis context that records what `apply` contributes. */
function fakeClientContext() {
  const dictionaries = []
  const sections = []
  const subscriptions = []
  const effects = []
  const injectedSlots = []

  const translate = (ns) => (key) => {
    const entry = dictionaries.find((candidate) => candidate.ns === ns)
    return entry ? (entry.dicts.zh[key] ?? key) : key
  }

  const ctx = {
    effect(callback, label) {
      effects.push(label)
      const disposer = callback()
      return { dispose: () => (typeof disposer === 'function' ? disposer() : undefined) }
    },
    locale: {
      register(ns, dicts) {
        dictionaries.push({ ns, dicts })
        return () => {}
      },
      bind: translate,
      subscribe(listener) {
        subscriptions.push(listener)
        return () => {}
      },
    },
    slots: {
      inject(name, callback) {
        injectedSlots.push(name)
        callback()
      },
      register(options, Component) {
        sections.push({ options, Component })
        return () => {}
      },
    },
    on() {
      return () => {}
    },
  }
  return { ctx, dictionaries, sections, subscriptions, effects, injectedSlots }
}

test('the bundle id matches the loader entry name the patch inserts', async () => {
  const handoff = await loadBundle()
  assert.equal(handoff.id, 'dsh-skill-mini-manager')
  assert.match(patch, /^\s*-\s*id: dsh-skill-mini-manager$/m)
  assert.match(patch, /^\s*name: 'dsh-skill-mini-manager'$/m)
  assert.equal(handoff.id, manifest.name)
})

test('the bundle requires only the react platform seed', async () => {
  const handoff = await loadBundle()
  const requires = []
  const exports = handoff.factory((spec) => {
    requires.push(spec)
    assert.equal(spec, 'react', `unexpected require("${spec}") — a cross-plugin value import`)
    return fakeReact()
  })
  assert.deepEqual(requires, ['react'])
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'locale'])
})

test('apply contributes exactly one settings.section at the Plugins level', async () => {
  const handoff = await loadBundle()
  const exports = handoff.factory(() => fakeReact())
  const fake = fakeClientContext()
  exports.apply(fake.ctx)

  assert.deepEqual(fake.injectedSlots, ['settings.section'])
  assert.equal(fake.sections.length, 1)
  const { options } = fake.sections[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'skill-mini-manager')
  // The built-in 插件 (Plugins) section registers at order 15 and 智能体预设 at
  // 20, so 16 is the same sidebar level as 插件 — adjacent, not nested.
  assert.equal(options.order, 16)
  assert.equal(typeof options.label, 'function')
  assert.equal(options.locale, 'skillMiniManager')
  assert.equal(typeof options.inject, 'function')
})

test('the nav label follows the active locale', async () => {
  const handoff = await loadBundle()
  const exports = handoff.factory(() => fakeReact())
  const fake = fakeClientContext()
  exports.apply(fake.ctx)
  assert.equal(fake.sections[0].options.label(), 'skill 极简管理')
  assert.equal(fake.dictionaries.length, 1)
  assert.equal(fake.dictionaries[0].dicts.en[`nav`], 'Skill Mini Manager')
})

test('the inject face exposes the locale subscription the page re-renders on', async () => {
  const handoff = await loadBundle()
  const exports = handoff.factory(() => fakeReact())
  const fake = fakeClientContext()
  exports.apply(fake.ctx)
  const face = fake.sections[0].options.inject()
  assert.equal(typeof face.localeSubscribe, 'function')
  const off = face.localeSubscribe(() => {})
  assert.equal(typeof off, 'function')
})

test('both dictionaries exist and cover exactly the same keys', async () => {
  const handoff = await loadBundle()
  const exports = handoff.factory(() => fakeReact())
  const fake = fakeClientContext()
  exports.apply(fake.ctx)

  const { dicts } = fake.dictionaries[0]
  assert.deepEqual(Object.keys(dicts).sort(), ['en', 'zh'])
  const zhKeys = Object.keys(dicts.zh).sort()
  const enKeys = Object.keys(dicts.en).sort()
  assert.deepEqual(zhKeys, enKeys, 'a key present in one language and missing in the other')
  assert.ok(zhKeys.length > 40, `expected a substantial dictionary, got ${zhKeys.length} keys`)

  // LocaleDict is Record<string, string>: a nested value would be dropped by the
  // locale service and render as a raw key.
  for (const [locale, dict] of Object.entries(dicts)) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(typeof value, 'string', `${locale}.${key} must be a flat string`)
      assert.notEqual(value.trim().length, 0, `${locale}.${key} must not be empty`)
    }
  }
})

test('every blocked-reason code the host can send has copy in both languages', async () => {
  const handoff = await loadBundle()
  const exports = handoff.factory(() => fakeReact())
  const fake = fakeClientContext()
  exports.apply(fake.ctx)
  const { zh, en } = fake.dictionaries[0].dicts

  // Kept in step with the reasons `planRemoval` and the host's describe() emit.
  const reasons = [
    'not-loadable',
    'runtime-provider',
    'bundled-source',
    'system-owned',
    'unsupported-layout',
    'outside-skill-roots',
    'missing',
    'ambiguous',
  ]
  for (const reason of reasons) {
    assert.equal(typeof zh[`blocked.${reason}`], 'string', `zh is missing blocked.${reason}`)
    assert.equal(typeof en[`blocked.${reason}`], 'string', `en is missing blocked.${reason}`)
  }
})

test('the page never hands a filesystem path to the host', () => {
  // The only POST bodies the page builds are `{ name }`, `{ id }` and `{}`.
  const posts = [...source.matchAll(/post\(API \+ "(\/[a-z]+)", ([^)]*)\)/g)]
  assert.ok(posts.length >= 3, 'expected the remove/restore/purge calls to be statically visible')
  for (const [, endpoint, body] of posts) {
    assert.match(endpoint, /^\/(remove|restore|purge)$/)
    assert.match(body.trim(), /^\{ *(name: [^,}]+|id: [^,}]+)? *\}$/, `unexpected body for ${endpoint}: ${body}`)
  }
  for (const forbidden of ['bundlePath: entry', 'filePath: entry', 'path: entry']) {
    assert.equal(source.includes(forbidden), false, `the page must not send ${forbidden}`)
  }
})

test('the stylesheet styles through DSH design tokens only', () => {
  const css = source.slice(source.indexOf('var CSS = ['), source.indexOf('].join("\\n")'))
  assert.ok(css.length > 1000, 'the CSS block should have been found')
  // Any var() that is not a --dsw-* token, and not this page's own fallback,
  // would be an unstyled property in the shipped UI.
  const vars = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1])
  assert.ok(vars.length > 20, `expected many token reads, got ${vars.length}`)
  for (const token of vars) {
    assert.ok(
      token.startsWith('--dsw-alias-') || token.startsWith('--dsw-'),
      `non-DSH custom property in the stylesheet: ${token}`,
    )
  }
})

test('the page is structured accessibly and localizes its own aria labels', () => {
  assert.match(source, /role: "alert"/, 'failures must be announced')
  assert.match(source, /"aria-label": tf\("search"\)/, 'the search box needs an accessible name')
  assert.match(source, /aria-busy/, 'the loading state must be announced')
  assert.match(source, /type: "search"/, 'the filter should be a search input')
})
