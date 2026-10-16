/**
 * Host-half integration tests.
 *
 * `apply()` is driven through a minimal fake Cordis context, and the four HTTP
 * routes are invoked as plain functions over real temporary directories. That
 * covers the whole removal path — resolve the skill, plan the target, move the
 * bundle, write the trash metadata, list it, restore it — without booting DSH.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'

import { API_BASE, ENDPOINTS, apply, inject, name as pluginName } from '../lib/index.js'
import { SKILL_FILE_NAME, trashRoot, userSkillRoots } from '../lib/catalog.js'

/** Every sandbox created in this file, torn down at the end. */
const sandboxes = []

after(() => {
  for (const directory of sandboxes) rmSync(directory, { recursive: true, force: true })
})

/** Create an isolated `$DSH_HOME`-shaped sandbox with one user skill root. */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'skm-'))
  sandboxes.push(home)
  const homes = { dshHome: home, agentsHome: join(home, '.agents') }
  const roots = userSkillRoots(homes)
  mkdirSync(roots[0], { recursive: true })
  return { home, homes, root: roots[0], trash: trashRoot(homes) }
}

/** Write a directory-bundle skill and describe it the way `ctx.skills` would. */
function writeBundleSkill(root, skillName, extra = {}) {
  const directory = join(root, skillName)
  mkdirSync(join(directory, 'references'), { recursive: true })
  writeFileSync(join(directory, SKILL_FILE_NAME), `---\nname: ${skillName}\ndescription: ${extra.description ?? 'demo'}\n---\n\n# body\n`)
  writeFileSync(join(directory, 'references', 'notes.md'), 'notes')
  return {
    name: skillName,
    description: extra.description ?? 'demo',
    whenToUse: extra.whenToUse,
    source: extra.source ?? 'user-dsh',
    provider: extra.provider ?? 'filesystem',
    invocation: { modelInvocable: true, userInvocable: true },
    path: join(directory, SKILL_FILE_NAME),
    content: '# body',
  }
}

/**
 * A stand-in for the `ctx.skills` registry over a fixed definition list.
 *
 * It models the two behaviours of the real layered registry these tests depend
 * on: a scoped read merges the global layer with the viewing scope's own layer
 * (the nearest entry winning a duplicate name), and a skill stops being
 * discoverable once its file is gone while a path-less (runtime) skill stays.
 * Without the first, the empty-global-layer case a stock web profile actually
 * has could not be reproduced; without the second, a removal could be asserted
 * only against the trash and never against the catalog.
 *
 * @param layers - one definition array (a global layer on its own), or a map
 *   from scope key — `'global'` for the unscoped read — to its definitions.
 */
function fakeRegistry(layers) {
  const byScope = Array.isArray(layers) ? { global: layers } : { ...layers }
  const present = (entry) => (typeof entry.path === 'string' ? existsSync(entry.path) : true)
  const definitions = (options) => {
    const key = (options ?? {}).scope ?? 'global'
    const global = (byScope.global ?? []).filter(present)
    if (key === 'global') return global
    const merged = new Map(global.map((entry) => [entry.name, entry]))
    for (const entry of (byScope[key] ?? []).filter(present)) merged.set(entry.name, entry)
    return [...merged.values()]
  }
  const summarize = (entry) => ({
    name: entry.name,
    description: entry.description,
    whenToUse: entry.whenToUse,
    source: entry.source,
    provider: entry.provider,
    invocation: entry.invocation,
  })
  return {
    async snapshot(options) {
      return { complete: true, skills: definitions(options).map(summarize) }
    },
    async get(skillName, options) {
      return definitions(options).find((candidate) => candidate.name === skillName)
    },
  }
}

/**
 * A stand-in for the `agentPresets` roster service, modelling the CURRENT host.
 *
 * It deliberately exposes the 0.2 `acquireScope` shape rather than the 0.1
 * `standingKeyFor` one. The earlier version of this fake implemented only the
 * old method, which is exactly how a real 0.2 incompatibility shipped with 64
 * green tests: every test exercised an API no current host has. The default
 * fake must therefore look like the host users actually run, and the legacy
 * shape gets its own explicit fake below.
 *
 * @param keys - preset id to the scope key the registry views by.
 * @param broken - preset ids discovery reports as unusable.
 * @param leases - collects every lease handed out, so a test can assert disposal.
 */
function fakePresets(keys, broken = [], leases = []) {
  return {
    async list() {
      return [
        ...Object.keys(keys).map((id) => ({ id })),
        ...broken.map((id) => ({ id, broken: 'composition file is unreadable' })),
      ]
    },
    async acquireScope(id) {
      if (keys[id] === undefined) throw new Error(`preset "${id}" has no standing mount`)
      const lease = {
        key: keys[id],
        async [Symbol.asyncDispose]() {
          lease.disposed = true
        },
      }
      leases.push(lease)
      return lease
    },
  }
}

/**
 * The same roster as the 0.1.x host exposed it: a bare key, nothing to dispose.
 * @param keys - preset id to the standing scope key the registry views by.
 */
function fakeLegacyPresets(keys) {
  return {
    async list() {
      return Object.keys(keys).map((id) => ({ id }))
    },
    async standingKeyFor(id) {
      if (keys[id] === undefined) throw new Error(`preset "${id}" has no standing mount`)
      return keys[id]
    },
  }
}

/** Minimal fake Cordis context: `inject` runs its callback, effects run inline. */
function fakeContext(registry, options = {}) {
  const routes = new Map()
  const disposers = []
  const logs = []
  const logger = {
    info: (message) => logs.push(['info', message]),
    warn: (message) => logs.push(['warn', message]),
    error: (message) => logs.push(['error', message]),
  }
  const runtime = {
    skills: registry,
    logger,
    effect(callback, label) {
      const disposer = callback()
      disposers.push([label, disposer])
      return { dispose() {} }
    },
    webServer: {
      register(route) {
        assert.equal(routes.has(route.path), false, `duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  const ctx = {
    logger,
    // Looked up, never injected: the plugin must mount with or without a roster.
    get(name) {
      return name === 'agentPresets' ? options.presets : undefined
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['skills'])
      callback(runtime)
    },
  }
  return { ctx, routes, disposers, logs }
}

/** A request that lets a test push a body after the handler attaches listeners. */
function request(method, headers = {}) {
  const emitter = new EventEmitter()
  emitter.method = method
  emitter.headers = headers
  // Mirrors IncomingMessage#destroy, which the body reader calls on overflow.
  emitter.destroy = () => {}
  return emitter
}

/** A response recorder. */
function response() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? null
    },
    end(chunk) {
      if (typeof chunk === 'string') this.body += chunk
      else if (chunk) this.body += chunk.toString('utf8')
    },
    json() {
      return JSON.parse(this.body)
    },
  }
}

/** Invoke one registered route as the web server would. */
async function call(route, method, body, headers = {}) {
  const req = request(method, headers)
  const res = response()
  const settled = route.handler(req, res)
  if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
  req.emit('end')
  await settled
  return res
}

/** Mount the plugin against a sandbox and return its routes. */
function mount(layers, home, options = {}) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const base = fakeRegistry(layers)
    // `wrapRegistry` lets a test make a scoped read fail, which is the only way
    // to observe that a scope lease is released on the error path too.
    const registry = options.wrapRegistry === undefined ? base : options.wrapRegistry(base)
    const { ctx, routes, logs } = fakeContext(registry, options)
    apply(ctx)
    return { routes, logs }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

test('the plugin advertises only the HTTP carrier it cannot work without', () => {
  assert.equal(pluginName, 'dsh-skill-mini-manager')
  assert.deepEqual(inject, ['webServer'])
  assert.equal(API_BASE, '/dsh-skill-mini-manager/api')
  assert.deepEqual(Object.values(ENDPOINTS), [
    `${API_BASE}/catalog`,
    `${API_BASE}/remove`,
    `${API_BASE}/restore`,
    `${API_BASE}/purge`,
  ])
})

test('mounting registers exactly the four documented routes', () => {
  const box = sandbox()
  const { routes } = mount([], box.home)
  assert.deepEqual([...routes.keys()].sort(), Object.values(ENDPOINTS).sort())
  for (const route of routes.values()) assert.equal(route.kind, 'exact')
})

test('the catalog reports each skill with its summary, footprint and removability', async () => {
  const box = sandbox()
  const definition = writeBundleSkill(box.root, 'lark-cli', { description: '读写飞书 / Lark resources', whenToUse: 'when the user mentions Lark' })
  const { routes } = mount([definition], box.home)

  const res = await call(routes.get(ENDPOINTS.catalog), 'GET')
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  const payload = res.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.complete, true)
  assert.equal(payload.skills.length, 1)

  // The version the page reports must be the version that shipped: the constant
  // is duplicated in lib/index.js and cannot be type-checked into agreement.
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(payload.plugin.version, manifest.version)

  const entry = payload.skills[0]
  assert.equal(entry.name, 'lark-cli')
  assert.equal(entry.description, '读写飞书 / Lark resources')
  assert.equal(entry.whenToUse, 'when the user mentions Lark')
  assert.equal(entry.source, 'user-dsh')
  assert.equal(entry.kind, 'bundle')
  assert.equal(entry.removable, true)
  assert.equal(entry.blocked, null)
  assert.equal(entry.bundlePath, join(box.root, 'lark-cli'))
  assert.equal(entry.rootPath, box.root)
  assert.equal(entry.files, 2)
  assert.ok(entry.bytes > 0)
  assert.equal(entry.modelInvocable, true)
  assert.equal(entry.userInvocable, true)
  assert.deepEqual(payload.trash, [])
  assert.ok(payload.roots.some((root) => root.path === box.root && root.exists))
})

test('removal moves the bundle into the trash and leaves nothing behind', async () => {
  const box = sandbox()
  const definition = writeBundleSkill(box.root, 'demo')
  const { routes } = mount([definition], box.home)

  const res = await call(routes.get(ENDPOINTS.remove), 'POST', { name: 'demo' })
  assert.equal(res.status, 200)
  const payload = res.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.removed.name, 'demo')
  assert.equal(payload.removed.from, join(box.root, 'demo'))

  // Gone from the skill root, present in the trash with recoverable metadata.
  assert.equal(existsSync(join(box.root, 'demo')), false)
  const entryDirectory = join(box.trash, payload.removed.trashId)
  assert.equal(existsSync(join(entryDirectory, 'payload', SKILL_FILE_NAME)), true)
  assert.equal(existsSync(join(entryDirectory, 'payload', 'references', 'notes.md')), true)
  const meta = JSON.parse(readFileSync(join(entryDirectory, 'meta.json'), 'utf8'))
  assert.equal(meta.originalPath, join(box.root, 'demo'))
  assert.equal(meta.name, 'demo')
  assert.equal(meta.kind, 'bundle')

  // The next catalog read reports the skill as removed and the trash as holding it.
  const after = await call(routes.get(ENDPOINTS.catalog), 'GET')
  const afterPayload = after.json()
  assert.equal(afterPayload.skills.length, 0)
  assert.equal(afterPayload.trash.length, 1)
  assert.equal(afterPayload.trash[0].name, 'demo')
  assert.equal(afterPayload.trash[0].originalPath, join(box.root, 'demo'))
})

test('restore puts the bundle back exactly where it was', async () => {
  const box = sandbox()
  const definition = writeBundleSkill(box.root, 'demo')
  const { routes } = mount([definition], box.home)

  const removed = (await call(routes.get(ENDPOINTS.remove), 'POST', { name: 'demo' })).json()
  const restored = await call(routes.get(ENDPOINTS.restore), 'POST', { id: removed.removed.trashId })
  assert.equal(restored.status, 200)
  assert.equal(restored.json().ok, true)

  assert.equal(existsSync(join(box.root, 'demo', SKILL_FILE_NAME)), true)
  assert.equal(existsSync(join(box.root, 'demo', 'references', 'notes.md')), true)
  assert.equal(existsSync(join(box.trash, removed.removed.trashId)), false)
})

test('restore refuses to overwrite a path that has been recreated', async () => {
  const box = sandbox()
  const definition = writeBundleSkill(box.root, 'demo')
  const { routes } = mount([definition], box.home)
  const removed = (await call(routes.get(ENDPOINTS.remove), 'POST', { name: 'demo' })).json()

  writeBundleSkill(box.root, 'demo')
  const res = await call(routes.get(ENDPOINTS.restore), 'POST', { id: removed.removed.trashId })
  assert.equal(res.json().ok, false)
  assert.equal(res.json().error, 'occupied')
})

test('purge deletes every trashed bundle and reports the count', async () => {
  const box = sandbox()
  const definitions = [writeBundleSkill(box.root, 'one'), writeBundleSkill(box.root, 'two')]
  const { routes } = mount(definitions, box.home)

  for (const skillName of ['one', 'two']) await call(routes.get(ENDPOINTS.remove), 'POST', { name: skillName })
  const before = (await call(routes.get(ENDPOINTS.catalog), 'GET')).json()
  assert.equal(before.trash.length, 2)

  const res = await call(routes.get(ENDPOINTS.purge), 'POST', {})
  assert.equal(res.json().purged, 2)
  assert.equal(existsSync(box.trash), true)
  const after = (await call(routes.get(ENDPOINTS.catalog), 'GET')).json()
  assert.deepEqual(after.trash, [])
})

test('a bundled skill is listed but never offered for removal', async () => {
  const box = sandbox()
  const definition = { ...writeBundleSkill(box.root, 'bundled-demo'), source: 'bundled' }
  const { routes } = mount([definition], box.home)

  const entry = (await call(routes.get(ENDPOINTS.catalog), 'GET')).json().skills[0]
  assert.equal(entry.removable, false)
  assert.equal(entry.blocked, 'bundled-source')

  const refused = await call(routes.get(ENDPOINTS.remove), 'POST', { name: 'bundled-demo' })
  assert.equal(refused.json().ok, false)
  assert.equal(refused.json().reason, 'bundled-source')
  assert.equal(existsSync(join(box.root, 'bundled-demo', SKILL_FILE_NAME)), true)
})

test('an unknown or malformed skill name is refused without touching the disk', async () => {
  const box = sandbox()
  const { routes } = mount([writeBundleSkill(box.root, 'demo')], box.home)

  const unknown = await call(routes.get(ENDPOINTS.remove), 'POST', { name: 'nope' })
  assert.equal(unknown.json().error, 'unknown-skill')

  for (const name of ['../../etc/passwd', 'Demo', '', 'a b', 7, null, 'demo/../..']) {
    const res = await call(routes.get(ENDPOINTS.remove), 'POST', { name })
    assert.equal(res.json().ok, false, `expected refusal for ${JSON.stringify(name)}`)
    assert.equal(res.json().error, 'bad-skill-name')
  }
  assert.equal(existsSync(join(box.root, 'demo', SKILL_FILE_NAME)), true)
})

test('a skill whose definition has no path cannot be removed', async () => {
  const box = sandbox()
  const definition = { name: 'virtual-one', description: 'in-process', source: 'runtime', provider: 'runtime', invocation: { modelInvocable: true, userInvocable: true } }
  const { routes } = mount([definition], box.home)

  const entry = (await call(routes.get(ENDPOINTS.catalog), 'GET')).json().skills[0]
  assert.equal(entry.removable, false)
  assert.equal(entry.blocked, 'not-on-disk')
  const refused = await call(routes.get(ENDPOINTS.remove), 'POST', { name: 'virtual-one' })
  assert.equal(refused.json().error, 'not-removable')
})

test('guards reject a wrong verb, a cross-origin request, and a malformed body', async () => {
  const box = sandbox()
  const { routes } = mount([writeBundleSkill(box.root, 'demo')], box.home)
  const catalog = routes.get(ENDPOINTS.catalog)
  const remove = routes.get(ENDPOINTS.remove)

  const wrongVerb = await call(catalog, 'POST', {})
  assert.equal(wrongVerb.status, 405)
  assert.equal(wrongVerb.headers.allow, 'GET')

  const crossOrigin = await call(remove, 'POST', { name: 'demo' }, { origin: 'http://evil.example', host: '127.0.0.1:3080' })
  assert.equal(crossOrigin.status, 403)
  assert.equal(crossOrigin.json().error, 'cross-origin')
  assert.equal(existsSync(join(box.root, 'demo')), true)

  const sameOrigin = await call(catalog, 'GET', undefined, { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' })
  assert.equal(sameOrigin.status, 200)

  const badJson = await call(remove, 'POST', '{not json')
  assert.equal(badJson.status, 400)
  assert.equal(badJson.json().error, 'bad-request')

  const huge = await call(remove, 'POST', JSON.stringify({ name: 'demo', pad: 'x'.repeat(70 * 1024) }))
  assert.equal(huge.status, 400)
  assert.equal(huge.json().error, 'bad-request')
  assert.equal(existsSync(join(box.root, 'demo')), true)
})

test('restore and purge only ever address trash entries this plugin wrote', async () => {
  const box = sandbox()
  const { routes } = mount([], box.home)
  mkdirSync(box.trash, { recursive: true })
  // A stray directory a user (or another tool) dropped into the trash root.
  mkdirSync(join(box.trash, 'not-ours'), { recursive: true })

  const restore = await call(routes.get(ENDPOINTS.restore), 'POST', { id: 'not-ours' })
  assert.equal(restore.json().error, 'bad-trash-id')
  const traversal = await call(routes.get(ENDPOINTS.restore), 'POST', { id: '1750000000000-../../escape' })
  assert.equal(traversal.json().error, 'bad-trash-id')

  const listed = (await call(routes.get(ENDPOINTS.catalog), 'GET')).json()
  assert.deepEqual(listed.trash, [])

  await call(routes.get(ENDPOINTS.purge), 'POST', {})
  assert.equal(existsSync(join(box.trash, 'not-ours')), true, 'purge must not touch foreign directories')
})

/* -------------------------------------------------------------------------- */
/* The empty-global-layer regression.                                          */
/*                                                                             */
/* A stock web profile DISABLES the host `skill-filesystem` row: presets own    */
/* local discovery, so every user skill lands in a preset's layer and the       */
/* global layer is empty. The first shipped version read only the global view   */
/* and therefore reported no skills at all on exactly the profiles that have    */
/* some. These cases pin the layered read that replaced it.                     */
/* -------------------------------------------------------------------------- */

test('a skill that only a preset layer serves is listed, not reported as absent', async () => {
  const box = sandbox()
  const definition = writeBundleSkill(box.root, 'lark-cli')
  const { routes } = mount({ global: [], standard: [definition] }, box.home, {
    presets: fakePresets({ standard: 'standard' }),
  })

  const payload = (await call(routes.get(ENDPOINTS.catalog), 'GET')).json()
  assert.equal(payload.skills.length, 1, 'the global layer is empty, so only the preset read can find this')
  assert.equal(payload.skills[0].name, 'lark-cli')
  assert.equal(payload.skills[0].removable, true)
  assert.deepEqual(payload.skills[0].scopes, ['preset:standard'])
  assert.deepEqual(payload.scopes, [
    { id: 'global', presetId: null, skills: 0, unavailable: null },
    { id: 'preset:standard', presetId: 'standard', skills: 1, unavailable: null },
  ])
})

test('one skill served by several presets is listed once, with every scope named', async () => {
  const box = sandbox()
  const definition = writeBundleSkill(box.root, 'demo')
  const { routes } = mount({ global: [], code: [definition], standard: [definition] }, box.home, {
    presets: fakePresets({ code: 'code', standard: 'standard' }),
  })

  const payload = (await call(routes.get(ENDPOINTS.catalog), 'GET')).json()
  assert.equal(payload.skills.length, 1, 'the same skill discovered twice is still one skill')
  assert.deepEqual(payload.skills[0].scopes, ['preset:code', 'preset:standard'])
})

test('a preset-only root contributes skills the other scopes do not have', async () => {
  const box = sandbox()
  const shared = writeBundleSkill(box.root, 'shared')
  // A preset shipping its own `skills/` directory, like the shipped `cordis` preset.
  const own = join(dirname(box.root), 'preset-cordis', 'skills')
  mkdirSync(own, { recursive: true })
  const privateSkill = writeBundleSkill(own, 'editing-cordis-compositions')
  const { routes } = mount({ global: [], standard: [shared], cordis: [privateSkill] }, box.home, {
    presets: fakePresets({ standard: 'standard', cordis: 'cordis' }),
  })

  const payload = (await call(routes.get(ENDPOINTS.catalog), 'GET')).json()
  const byName = Object.fromEntries(payload.skills.map((entry) => [entry.name, entry]))
  assert.deepEqual(Object.keys(byName).sort(), ['editing-cordis-compositions', 'shared'])
  assert.deepEqual(byName.shared.scopes, ['preset:standard'])
  assert.deepEqual(byName['editing-cordis-compositions'].scopes, ['preset:cordis'])
  assert.equal(byName['editing-cordis-compositions'].removable, true)
})

test('removal reaches a skill the global view cannot see', async () => {
  const box = sandbox()
  const definition = writeBundleSkill(box.root, 'lark-cli')
  const { routes } = mount({ global: [], standard: [definition] }, box.home, {
    presets: fakePresets({ standard: 'standard' }),
  })

  const res = await call(routes.get(ENDPOINTS.remove), 'POST', { name: 'lark-cli' })
  assert.equal(res.status, 200)
  assert.equal(res.json().ok, true)
  assert.equal(existsSync(join(box.root, 'lark-cli')), false)
  const payload = (await call(routes.get(ENDPOINTS.catalog), 'GET')).json()
  assert.deepEqual(payload.skills, [])
  assert.equal(payload.trash.length, 1)
})

test('a name resolving to two different files is listed but never offered for removal', async () => {
  const box = sandbox()
  const first = writeBundleSkill(box.root, 'demo')
  const otherRoot = join(dirname(box.root), 'agents', 'skills')
  mkdirSync(otherRoot, { recursive: true })
  const second = writeBundleSkill(otherRoot, 'demo', { description: 'a different skill with the same name' })

  const { routes } = mount({ global: [], a: [first], b: [second] }, box.home, {
    presets: fakePresets({ a: 'a', b: 'b' }),
  })

  const payload = (await call(routes.get(ENDPOINTS.catalog), 'GET')).json()
  assert.equal(payload.skills.length, 1)
  assert.equal(payload.skills[0].removable, false)
  assert.equal(payload.skills[0].blocked, 'ambiguous')

  // The page only ever sends a name, so the host must refuse rather than pick.
  const res = await call(routes.get(ENDPOINTS.remove), 'POST', { name: 'demo' })
  assert.equal(res.json().error, 'not-removable')
  assert.equal(res.json().reason, 'ambiguous')
  assert.equal(existsSync(join(box.root, 'demo')), true)
  assert.equal(existsSync(join(otherRoot, 'demo')), true)
})

test('a preset that cannot be composed is reported instead of silently dropping its skills', async () => {
  const box = sandbox()
  const definition = writeBundleSkill(box.root, 'demo')
  const { routes } = mount({ global: [], standard: [definition] }, box.home, {
    presets: fakePresets({ standard: 'standard' }, ['broken-preset']),
  })

  const payload = (await call(routes.get(ENDPOINTS.catalog), 'GET')).json()
  assert.equal(payload.skills.length, 1, 'a readable preset still lists its skills')
  const broken = payload.scopes.find((scope) => scope.id === 'preset:broken-preset')
  assert.equal(broken.skills, 0)
  assert.match(broken.unavailable, /unreadable/)
})

test('a preset whose standing mount throws is reported without failing the page', async () => {
  const box = sandbox()
  const definition = writeBundleSkill(box.root, 'demo')
  // `standingKeyFor` throws for any id the fake roster does not key, which is
  // how a preset with an unusable composition behaves.
  const { routes, logs } = mount({ global: [], standard: [definition] }, box.home, {
    presets: {
      async list() {
        return [{ id: 'standard' }, { id: 'mount-fails' }]
      },
      async standingKeyFor(id) {
        if (id !== 'standard') throw new Error('composition file is unreadable')
        return 'standard'
      },
    },
  })

  const payload = (await call(routes.get(ENDPOINTS.catalog), 'GET')).json()
  assert.equal(payload.ok, true)
  assert.equal(payload.skills.length, 1)
  const failed = payload.scopes.find((scope) => scope.id === 'preset:mount-fails')
  assert.equal(failed.unavailable, 'composition file is unreadable')
  // The failure is reported in the payload, so it must not ALSO be a log warning:
  // one unreadable preset is exactly what the `scopes` report is for.
  assert.deepEqual(logs.filter(([level]) => level === 'warn'), [])
})

test('a roster that cannot be listed at all degrades to the global layer', async () => {
  const box = sandbox()
  const definition = writeBundleSkill(box.root, 'demo')
  const { routes, logs } = mount({ global: [definition] }, box.home, {
    presets: {
      async list() {
        throw new Error('roster unreadable')
      },
      async standingKeyFor() {
        throw new Error('unreachable')
      },
    },
  })

  const payload = (await call(routes.get(ENDPOINTS.catalog), 'GET')).json()
  assert.equal(payload.ok, true)
  assert.equal(payload.skills.length, 1)
  assert.deepEqual(payload.skills[0].scopes, ['global'])
  assert.equal(payload.scopes.length, 1)
  assert.ok(logs.some(([level, message]) => level === 'warn' && /roster/.test(message)))
})

test('a deployment with no preset roster at all reads the global layer alone', async () => {
  const box = sandbox()
  const definition = writeBundleSkill(box.root, 'demo')
  const { routes } = mount([definition], box.home)

  const payload = (await call(routes.get(ENDPOINTS.catalog), 'GET')).json()
  assert.equal(payload.skills.length, 1)
  assert.deepEqual(payload.skills[0].scopes, ['global'])
  assert.deepEqual(payload.scopes, [{ id: 'global', presetId: null, skills: 1, unavailable: null }])
})

/* ── DSH 0.2 replaced `standingKeyFor(id)` with `acquireScope(id)` ─────────────
 * 0.2 removed the old name outright and made the new one a *lease*: it returns
 * `{ key } & AsyncDisposable`, and the caller must dispose it once the scoped
 * read is done. This plugin first shipped against the old name, so on a 0.2 host
 * (including the 0.2.0-rc.2 desktop app) every preset failed with
 * "presets.standingKeyFor is not a function" and its skills went unlisted — while
 * every test passed, because the fakes only ever defined the old method.
 * These lock in both shapes and the lease lifecycle.
 */

test('a 0.2 host is read through acquireScope, and the lease is disposed after the read', async () => {
  const box = sandbox()
  const definition = writeBundleSkill(box.root, 'demo')
  const events = []
  const { routes } = mount({ global: [], standard: [definition] }, box.home, {
    presets: {
      async list() {
        return [{ id: 'standard' }]
      },
      // The 0.2 shape only: no `standingKeyFor` anywhere.
      async acquireScope(id) {
        events.push(`acquire:${id}`)
        return {
          key: id,
          async [Symbol.asyncDispose]() {
            events.push(`dispose:${id}`)
          },
        }
      },
    },
  })

  const payload = (await call(routes.get(ENDPOINTS.catalog), 'GET')).json()
  assert.equal(payload.ok, true)
  assert.equal(payload.skills.length, 1, 'the preset layer must be readable through acquireScope')
  assert.deepEqual(payload.skills[0].scopes, ['preset:standard'])
  assert.equal(payload.scopes.find((scope) => scope.id === 'preset:standard').unavailable, null)
  // Acquired before the read, released exactly once afterwards — never stranded.
  assert.deepEqual(events, ['acquire:standard', 'dispose:standard'])
})

test('a scope lease is released even when the scoped read throws', async () => {
  const box = sandbox()
  const events = []
  const { routes } = mount({ global: [] }, box.home, {
    wrapRegistry: (registry) => ({
      ...registry,
      async snapshot(options) {
        if (options?.scope === 'standard') throw new Error('scope read exploded')
        return registry.snapshot(options)
      },
    }),
    presets: {
      async list() {
        return [{ id: 'standard' }]
      },
      async acquireScope(id) {
        events.push(`acquire:${id}`)
        return {
          key: id,
          async [Symbol.asyncDispose]() {
            events.push(`dispose:${id}`)
          },
        }
      },
    },
  })

  const payload = (await call(routes.get(ENDPOINTS.catalog), 'GET')).json()
  assert.equal(payload.ok, true)
  const failed = payload.scopes.find((scope) => scope.id === 'preset:standard')
  assert.equal(failed.skills, 0)
  assert.equal(failed.unavailable, 'scope read exploded')
  assert.deepEqual(events, ['acquire:standard', 'dispose:standard'])
})

test('acquireScope wins on a host that offers both, and a plain dispose() is honoured', async () => {
  const box = sandbox()
  const definition = writeBundleSkill(box.root, 'demo')
  const called = []
  const { routes } = mount({ global: [], standard: [definition] }, box.home, {
    presets: {
      async list() {
        return [{ id: 'standard' }]
      },
      async acquireScope(id) {
        called.push('acquireScope')
        // The other allowed disposer shape: a plain `dispose()` method.
        return { key: id, dispose() { called.push('dispose') } }
      },
      async standingKeyFor() {
        called.push('standingKeyFor')
        return 'standard'
      },
    },
  })

  const payload = (await call(routes.get(ENDPOINTS.catalog), 'GET')).json()
  assert.equal(payload.skills.length, 1)
  assert.deepEqual(called, ['acquireScope', 'dispose'], 'the 0.2 API must be preferred')
})

test('a registry exposing neither scope API reports it instead of listing nothing', async () => {
  const box = sandbox()
  const definition = writeBundleSkill(box.root, 'demo')
  const { routes } = mount({ global: [], standard: [definition] }, box.home, {
    presets: {
      async list() {
        return [{ id: 'standard' }]
      },
      // Neither method: what an unforeseen third version would look like.
    },
  })

  const payload = (await call(routes.get(ENDPOINTS.catalog), 'GET')).json()
  assert.equal(payload.ok, true)
  const failed = payload.scopes.find((scope) => scope.id === 'preset:standard')
  assert.match(failed.unavailable, /acquireScope/)
  assert.match(failed.unavailable, /standingKeyFor/)
  assert.equal(payload.complete, true, 'an unusable preset alone does not make the read incomplete')
})

test('a legacy 0.1 host still works through standingKeyFor', async () => {
  const box = sandbox()
  const definition = writeBundleSkill(box.root, 'demo')
  const { routes } = mount({ global: [], standard: [definition] }, box.home, {
    presets: fakeLegacyPresets({ standard: 'standard' }),
  })

  const payload = (await call(routes.get(ENDPOINTS.catalog), 'GET')).json()
  assert.equal(payload.skills.length, 1)
  assert.deepEqual(payload.skills[0].scopes, ['preset:standard'])
  assert.equal(payload.scopes.find((scope) => scope.id === 'preset:standard').unavailable, null)
})

test('every lease the default 0.2 fake hands out is disposed by the time a read settles', async () => {
  const box = sandbox()
  const definition = writeBundleSkill(box.root, 'demo')
  const leases = []
  const { routes } = mount({ global: [], a: [definition], b: [] }, box.home, {
    presets: fakePresets({ a: 'a', b: 'b' }, [], leases),
  })

  await call(routes.get(ENDPOINTS.catalog), 'GET')
  // The catalog and the removal re-resolution are separate reads, so this also
  // pins that a lease is not reused across them or leaked between requests.
  await call(routes.get(ENDPOINTS.remove), 'POST', { name: 'demo' })

  assert.equal(leases.length, 4, 'two presets, two reads')
  assert.deepEqual(leases.map((lease) => lease.disposed), [true, true, true, true])
})

