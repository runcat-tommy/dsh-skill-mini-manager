/**
 * dsh-skill-mini-manager — host half.
 *
 * Mounts four exact HTTP routes on the host `webServer` service so the browser
 * half can read the skill catalog and remove a skill:
 *
 *   GET  /dsh-skill-mini-manager/api/catalog   list skills + trash
 *   POST /dsh-skill-mini-manager/api/remove    {"name": "<skill>"}
 *   POST /dsh-skill-mini-manager/api/restore   {"id": "<trash entry>"}
 *   POST /dsh-skill-mini-manager/api/purge     empty the trash
 *
 * Three properties this file is built around:
 *
 * 1. **The browser never names a path.** Every request carries a skill NAME or
 *    a trash ENTRY ID; the host re-resolves it through `ctx.skills` and derives
 *    the target with the pure rules in `./catalog.js`. A page cannot ask this
 *    plugin to delete an arbitrary file.
 * 2. **Removal is recoverable.** The bundle is moved — never deleted — into
 *    `<dshHome>/.skill-mini-manager/trash/<stamp>-<name>/payload`, a location
 *    outside every scanned skill root, with a `meta.json` recording where it
 *    came from. `restore` moves it back.
 * 3. **The skill registry stays authoritative.** The catalog is a fresh
 *    `ctx.skills` read on every request (no cache), so a skill the model
 *    cannot currently load is reported as the registry reports it. Deleting a
 *    bundle also trips the filesystem provider's own watcher, which is what
 *    actually withdraws the skill from the model catalog.
 *
 * @module dsh-skill-mini-manager
 */

import { randomBytes } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  SKILL_FILE_NAME,
  isTrashEntryName,
  planRemoval,
  resolveHarnessHomes,
  trashEntryName,
  trashRoot,
  userSkillRoots,
} from './catalog.js'

/** Cordis plugin name; also the loader entry id the client bundle registers under. */
export const name = 'dsh-skill-mini-manager'

/** The plugin is useless without the HTTP carrier that serves its browser half. */
export const inject = ['webServer']

/** Version reported in the catalog payload; kept in step with package.json. */
const VERSION = '2.0.2'

/** Route base. Outside `/api`, which the host's own request fence owns. */
export const API_BASE = '/dsh-skill-mini-manager/api'

/** The exact routes this plugin claims. */
export const ENDPOINTS = Object.freeze({
  catalog: `${API_BASE}/catalog`,
  remove: `${API_BASE}/remove`,
  restore: `${API_BASE}/restore`,
  purge: `${API_BASE}/purge`,
})

/** Upper bound on a JSON request body; every request this page sends is tiny. */
const MAX_BODY_BYTES = 64 * 1024

/** Upper bound on files counted per skill bundle, so a pathological bundle cannot stall a read. */
const MAX_BUNDLE_FILES = 5000

/** The two user roots, labelled with the provider source that scans them. */
function scannedRoots(homes) {
  const [dshRoot, agentsRoot] = userSkillRoots(homes)
  return [
    { path: dshRoot, source: 'user-dsh' },
    { path: agentsRoot, source: 'user-agents' },
  ]
}

/**
 * Count files and bytes under one skill bundle.
 *
 * Bounded and best-effort: an unreadable subdirectory is skipped rather than
 * failing the whole catalog, and hitting {@link MAX_BUNDLE_FILES} reports
 * `truncated` instead of walking forever.
 *
 * @param target - bundle directory, or the flat `.md` file itself.
 * @returns file count, byte total, modification time, and truncation flag.
 */
function measureBundle(target) {
  let stats
  try {
    stats = statSync(target)
  } catch {
    return { files: null, bytes: null, modifiedAt: null, truncated: false }
  }
  if (stats.isFile()) {
    return { files: 1, bytes: stats.size, modifiedAt: stats.mtimeMs, truncated: false }
  }

  let files = 0
  let bytes = 0
  let truncated = false
  const pending = [target]
  while (pending.length > 0) {
    const directory = pending.pop()
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(child)
        continue
      }
      if (!entry.isFile()) continue
      if (files >= MAX_BUNDLE_FILES) {
        truncated = true
        break
      }
      files += 1
      try {
        bytes += statSync(child).size
      } catch {
        /* a file that vanished mid-walk simply contributes no bytes */
      }
    }
    if (truncated) break
  }
  return { files, bytes, modifiedAt: stats.mtimeMs, truncated }
}

/** Move a file or directory, falling back to copy+delete across volume boundaries. */
function moveEntry(from, to) {
  try {
    renameSync(from, to)
    return
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
  }
  cpSync(from, to, { recursive: true, dereference: false, force: true })
  rmSync(from, { recursive: true, force: true })
}

/** Read one JSON file, answering `undefined` for anything unreadable or malformed. */
function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Write one response as JSON, never cached. */
function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/**
 * Refuse a request a browser sent from another origin.
 *
 * These routes are exact registrations on the bare `webServer`, so the host's
 * own `/api` fence never sees them. `Host` is the one header a hostile page
 * cannot forge, so a cross-origin attempt cannot match it — which is what makes
 * this sufficient for the destructive `remove` verb.
 *
 * @returns whether the request was refused and answered here.
 */
function refuseCrossOrigin(request, response) {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return false
  const host = request.headers.host
  let originHost
  try {
    originHost = new URL(origin).host
  } catch {
    originHost = undefined
  }
  if (typeof host === 'string' && originHost === host) return false
  sendJson(response, 403, { ok: false, error: 'cross-origin' })
  return true
}

/** Read and parse a JSON request body under the size cap. */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(typeof parsed === 'object' && parsed !== null ? parsed : {})
      } catch {
        reject(new Error('body is not valid JSON'))
      }
    })
    request.on('error', reject)
  })
}

/** A skill name as this plugin accepts it: the registry's own kebab-case grammar. */
function isSkillName(value) {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

/**
 * Register this plugin against the host context.
 * @param ctx - host context carrying `webServer`.
 */
/** One-line description of a thrown value, for logs and per-slot reports. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The registry views this deployment actually serves skills through.
 *
 * `ctx.skills` is host+per-scope layered. Deployment-level providers register
 * into its GLOBAL layer, while each agent preset's `skill-filesystem` row
 * registers into THAT preset's own layer, and a read merges only the layers the
 * viewing scope selects.
 *
 * This matters because a stock web profile DISABLES the host `skill-filesystem`
 * row — `dsh-web-app/cordis.patch.yml` turns it off explicitly, with the note
 * that "presets own local discovery" — so the global layer is empty and every
 * user skill lives in a preset layer. Reading the global layer alone therefore
 * reports an empty catalog on exactly the deployments that have skills.
 *
 * `AgentPresets.standingKeyFor` is the documented read scope for a host reader
 * with no agent, and ensuring it composes that preset's plugins without
 * starting an agent, a session, or a turn. A preset that cannot be composed is
 * reported as unavailable rather than failing the whole page, and a host with
 * no preset roster at all degrades to the global layer alone.
 *
 * @param ctx - the plugin's context, used only to look the roster service up.
 * @returns one slot per readable view, global first and in roster order after.
 */
async function viewSlots(ctx) {
  const slots = [{ id: 'global', presetId: null, scope: undefined, unavailable: null }]

  // Looked up rather than injected: a profile without the roster (or with the
  // row disabled) must still get a Settings page, not a plugin that never mounts.
  const presets = ctx.get('agentPresets')
  if (presets === undefined) return slots

  let roster
  try {
    roster = await presets.list()
  } catch (error) {
    ctx.logger.warn(`skill-mini-manager: reading the preset roster failed: ${messageOf(error)}`)
    return slots
  }

  for (const preset of roster ?? []) {
    const id = `preset:${preset.id}`
    if (preset.broken !== undefined) {
      slots.push({ id, presetId: preset.id, scope: undefined, unavailable: String(preset.broken) })
      continue
    }
    try {
      slots.push({ id, presetId: preset.id, scope: await presets.standingKeyFor(preset.id), unavailable: null })
    } catch (error) {
      slots.push({ id, presetId: preset.id, scope: undefined, unavailable: messageOf(error) })
    }
  }
  return slots
}

/** The read options that select one slot's view of the registry. */
function slotOptions(slot) {
  return slot.scope === undefined ? {} : { scope: slot.scope }
}

export function apply(ctx) {
  const homes = resolveHarnessHomes()
  const roots = userSkillRoots(homes)
  const trash = trashRoot(homes)
  const scanned = scannedRoots(homes)

  // `skills` is injected late rather than declared statically: the Settings page
  // should still appear (and explain itself) on a host whose skill registry
  // never arrives, instead of the whole plugin going silently absent.
  ctx.inject(['skills'], (runtime) => {
    const registry = runtime.skills

    /** Describe one skill summary, as seen through one registry view. */
    const describe = async (summary, options) => {
      const entry = {
        name: summary.name,
        description: summary.description,
        whenToUse: summary.whenToUse ?? null,
        source: summary.source,
        provider: summary.provider,
        modelInvocable: summary.invocation?.modelInvocable !== false,
        userInvocable: summary.invocation?.userInvocable !== false,
        kind: 'virtual',
        filePath: null,
        bundlePath: null,
        rootPath: null,
        files: null,
        bytes: null,
        modifiedAt: null,
        truncated: false,
        readable: false,
        removable: false,
        blocked: null,
      }

      let definition
      try {
        definition = await registry.get(summary.name, options)
      } catch (error) {
        ctx.logger.warn(`skill-mini-manager: loading "${summary.name}" failed: ${messageOf(error)}`)
        definition = undefined
      }
      if (definition === undefined) {
        entry.blocked = 'not-loadable'
        return entry
      }

      entry.readable = true
      entry.filePath = definition.path ?? null
      entry.kind = 'virtual'

      const plan = planRemoval({
        filePath: definition.path,
        source: definition.source,
        provider: definition.provider,
        roots,
      })
      if (!plan.ok) {
        entry.blocked = plan.reason
        return entry
      }

      entry.kind = plan.kind
      entry.bundlePath = plan.bundle
      entry.rootPath = plan.root
      const facts = measureBundle(plan.bundle)
      entry.files = facts.files
      entry.bytes = facts.bytes
      entry.modifiedAt = facts.modifiedAt
      entry.truncated = facts.truncated
      // A bundle whose marker file has gone missing is not something this page
      // should offer to remove: the report would name a skill the registry is
      // about to forget anyway.
      const intact = plan.kind !== 'bundle' || existsSync(join(plan.bundle, SKILL_FILE_NAME))
      if (!intact) {
        entry.blocked = 'missing'
        return entry
      }
      entry.removable = true
      return entry
    }

    /** The trash as the browser renders it, newest first. */
    const listTrash = () => {
      if (!existsSync(trash)) return []
      let names
      try {
        names = readdirSync(trash)
      } catch {
        return []
      }
      const entries = []
      for (const id of names) {
        // Only entries this plugin wrote are addressable by restore/purge.
        if (!isTrashEntryName(id)) continue
        const directory = join(trash, id)
        const meta = readJson(join(directory, 'meta.json'))
        if (meta === undefined) continue
        const facts = measureBundle(join(directory, 'payload'))
        entries.push({
          id,
          name: typeof meta.name === 'string' ? meta.name : id,
          kind: typeof meta.kind === 'string' ? meta.kind : 'bundle',
          originalPath: typeof meta.originalPath === 'string' ? meta.originalPath : null,
          removedAt: typeof meta.removedAt === 'number' ? meta.removedAt : null,
          files: facts.files,
          bytes: facts.bytes,
        })
      }
      return entries.sort((a, b) => (b.removedAt ?? 0) - (a.removedAt ?? 0))
    }

    /**
     * Build the full catalog payload. No caching: the registry is the truth.
     *
     * Every slot is read and the results merged by name, because the same skill
     * that a preset's filesystem provider discovers in a user root is one skill
     * however many presets serve it, while a preset-only root (a preset shipping
     * its own `skills/` directory) contributes skills no other slot has.
     */
    const catalog = async () => {
      const slots = await viewSlots(ctx)
      const byName = new Map()
      const scopes = []
      let complete = true

      for (const slot of slots) {
        if (slot.unavailable !== null) {
          scopes.push({ id: slot.id, presetId: slot.presetId, skills: 0, unavailable: slot.unavailable })
          continue
        }
        const options = slotOptions(slot)
        let snapshot
        try {
          snapshot = await registry.snapshot(options)
        } catch (error) {
          scopes.push({ id: slot.id, presetId: slot.presetId, skills: 0, unavailable: messageOf(error) })
          continue
        }
        if (snapshot.complete === false) complete = false
        scopes.push({ id: slot.id, presetId: slot.presetId, skills: snapshot.skills.length, unavailable: null })

        for (const summary of snapshot.skills) {
          const entry = await describe(summary, options)
          const existing = byName.get(summary.name)
          if (existing === undefined) {
            entry.scopes = [slot.id]
            entry.paths = new Set([entry.filePath])
            byName.set(summary.name, entry)
            continue
          }
          existing.scopes.push(slot.id)
          existing.paths.add(entry.filePath)
          // A slot that could load the skill outranks one that could not: the
          // same name resolved differently is exactly the ambiguity reported
          // below, and reporting it through the loadable definition is clearer
          // than through a `not-loadable` stub from a sibling slot.
          if (existing.readable === false && entry.readable) {
            entry.scopes = existing.scopes
            entry.paths = existing.paths
            byName.set(summary.name, entry)
          }
        }
      }

      const skills = []
      for (const entry of byName.values()) {
        // One name pointing at two different files cannot be removed from this
        // page: the report would have to pick a winner, and the browser only
        // ever sends the name. Refuse rather than guess.
        if (entry.paths.size > 1) {
          entry.blocked = 'ambiguous'
          entry.removable = false
        } else if (entry.removable) {
          entry.blocked = null
        }
        delete entry.paths
        skills.push(entry)
      }
      skills.sort((a, b) => a.name.localeCompare(b.name))

      return {
        ok: true,
        plugin: { name, version: VERSION, endpoint: ENDPOINTS.catalog },
        generatedAt: Date.now(),
        complete,
        roots: scanned.map((root) => ({ ...root, exists: existsSync(root.path) })),
        trashRoot: trash,
        scopes,
        skills,
        trash: listTrash(),
      }
    }

    /**
     * Every definition the registry serves under one name, one per view slot.
     *
     * Removal re-resolves through this rather than the global view, because on a
     * profile whose host `skill-filesystem` row is disabled the global view
     * cannot see the skill the page is showing.
     *
     * @param skillName - the skill to look up.
     * @returns the resolutions that found something, in slot order.
     */
    const resolveEverywhere = async (skillName) => {
      const found = []
      for (const slot of await viewSlots(ctx)) {
        if (slot.unavailable !== null) continue
        try {
          const definition = await registry.get(skillName, slotOptions(slot))
          if (definition !== undefined) found.push({ slot: slot.id, definition })
        } catch (error) {
          ctx.logger.warn(`skill-mini-manager: resolving "${skillName}" in ${slot.id} failed: ${messageOf(error)}`)
        }
      }
      return found
    }

    /**
     * Remove one skill by moving its bundle into the trash.
     * @param skillName - the skill to remove, as the registry names it.
     */
    const remove = async (skillName) => {
      if (!isSkillName(skillName)) return { ok: false, error: 'bad-skill-name' }

      // Re-resolve now: the page may be acting on a stale catalog, and the
      // definition — not the catalog row — is what the target is derived from.
      const found = await resolveEverywhere(skillName)
      if (found.length === 0) return { ok: false, error: 'unknown-skill' }

      // The browser sends only a name, so a name that resolves to two different
      // files has no single honest target. Refuse instead of picking one.
      const targets = new Set(found.map((candidate) => candidate.definition.path ?? null))
      if (targets.size > 1) return { ok: false, error: 'not-removable', reason: 'ambiguous' }

      const definition = found[0].definition
      const plan = planRemoval({
        filePath: definition.path,
        source: definition.source,
        provider: definition.provider,
        roots,
      })
      if (!plan.ok) return { ok: false, error: 'not-removable', reason: plan.reason }

      if (!existsSync(plan.bundle)) return { ok: false, error: 'missing' }
      if (plan.kind === 'bundle' && !existsSync(join(plan.bundle, SKILL_FILE_NAME))) {
        return { ok: false, error: 'missing' }
      }

      const id = trashEntryName(skillName, Date.now(), randomBytes(3).toString('hex'))
      const entryDirectory = join(trash, id)
      mkdirSync(entryDirectory, { recursive: true })
      try {
        moveEntry(plan.bundle, join(entryDirectory, 'payload'))
      } catch (error) {
        rmSync(entryDirectory, { recursive: true, force: true })
        throw error
      }
      writeFileSync(
        join(entryDirectory, 'meta.json'),
        `${JSON.stringify(
          {
            schema: 1,
            name: skillName,
            kind: plan.kind,
            originalPath: plan.bundle,
            rootPath: plan.root,
            source: definition.source,
            provider: definition.provider,
            removedAt: Date.now(),
            pluginVersion: VERSION,
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
      ctx.logger.info(`skill-mini-manager: removed "${skillName}" (${plan.bundle}) -> ${id}`)
      return { ok: true, removed: { name: skillName, kind: plan.kind, from: plan.bundle, trashId: id } }
    }

    /**
     * Restore one trashed skill to the exact path it was removed from.
     * @param id - trash entry directory name.
     */
    const restore = (id) => {
      if (!isTrashEntryName(id)) return { ok: false, error: 'bad-trash-id' }
      const entryDirectory = join(trash, id)
      const meta = readJson(join(entryDirectory, 'meta.json'))
      if (meta === undefined) return { ok: false, error: 'unknown-trash-entry' }
      const originalPath = meta.originalPath
      if (typeof originalPath !== 'string' || originalPath.length === 0) {
        return { ok: false, error: 'unknown-trash-entry' }
      }
      const payload = join(entryDirectory, 'payload')
      if (!existsSync(payload)) return { ok: false, error: 'unknown-trash-entry' }
      if (existsSync(originalPath)) return { ok: false, error: 'occupied' }

      mkdirSync(dirname(originalPath), { recursive: true })
      moveEntry(payload, originalPath)
      rmSync(entryDirectory, { recursive: true, force: true })
      ctx.logger.info(`skill-mini-manager: restored "${meta.name}" -> ${originalPath}`)
      return { ok: true, restored: { name: meta.name, to: originalPath } }
    }

    /** Delete every trashed bundle. The only irreversible verb in this plugin. */
    const purge = () => {
      if (!existsSync(trash)) return { ok: true, purged: 0 }
      let purged = 0
      for (const id of readdirSync(trash)) {
        if (!isTrashEntryName(id)) continue
        rmSync(join(trash, id), { recursive: true, force: true })
        purged += 1
      }
      ctx.logger.info(`skill-mini-manager: purged ${purged} trashed skill(s)`)
      return { ok: true, purged }
    }

    /** One guarded JSON route. `body` handlers receive the parsed request body. */
    const route = (path, handler) => {
      runtime.effect(
        () =>
          runtime.webServer.register({
            kind: 'exact',
            path,
            handler: async (request, response) => {
              if (refuseCrossOrigin(request, response)) return
              if (request.method !== handler.method) {
                response.writeHead(405, { allow: handler.method })
                response.end()
                return
              }
              try {
                const withBody = handler.body === true
                const body = withBody ? await readJsonBody(request) : {}
                sendJson(response, 200, await handler.run(body))
              } catch (error) {
                if (error?.message === 'body too large' || error?.message === 'body is not valid JSON') {
                  sendJson(response, 400, { ok: false, error: 'bad-request', detail: error.message })
                  return
                }
                ctx.logger.error(error)
                sendJson(response, 500, { ok: false, error: 'internal', detail: String(error?.message ?? error) })
              }
            },
          }),
        `skill-mini-manager: route ${path}`,
      )
    }

    route(ENDPOINTS.catalog, { method: 'GET', run: catalog })
    route(ENDPOINTS.remove, {
      method: 'POST',
      body: true,
      run: (body) => remove(body.name),
    })
    route(ENDPOINTS.restore, {
      method: 'POST',
      body: true,
      run: (body) => restore(body.id),
    })
    route(ENDPOINTS.purge, { method: 'POST', body: true, run: () => purge() })

    ctx.logger.info(`skill-mini-manager: mounted ${API_BASE}/* (roots: ${roots.join(', ')})`)
  })
}
