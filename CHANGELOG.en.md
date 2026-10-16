# CHANGELOG

## [2.0.4] - 2026-10-16

### Fixed

- **Fixed "not one preset's skills can be read" — DSH 0.2 replaced the method that reads a scope.**
  From 0.2 on, `AgentPresets.standingKeyFor(id)` is **gone outright**, replaced by
  `acquireScope(id)` — and that is not a rename: it returns a **lease**
  (`{ key } & AsyncDisposable`) which must be disposed once the scoped read is done,
  or that preset revision stays `retain`ed in memory. 1.0.1 called the old name, so on
  a 0.2 host (including the 0.2.0-rc.2 Desktop app) **every preset threw**
  `presets.standingKeyFor is not a function`: all four presets were reported as failed
  and none of their skills were listed.
  - Both API generations are now supported: `acquireScope` is preferred and its lease is
    **released in a `finally`** (so a throwing read releases it too); a 0.1.x host with
    only `standingKeyFor` takes the old path, which has nothing to release; a registry
    exposing neither gets an error that **names both methods** instead of
    `undefined is not a function`.
  - This closes the gap 2.0.3 left open: 2.0.3 declared the range
    `^0.1.0-rc.6 || ^0.2.0-rc.1` while **the code could not actually run on 0.2.x**.
    Declaring support and being able to run are two different things, and 2.0.3 only did
    the first.
  - The lesson: **the tests let this through.** The fake roster in `test/host.test.mjs`
    only ever implemented the old method, so all 64 tests passed while every real host
    failed. Six cases were added — the 0.2 path can read a preset layer; the lease is
    released both after a completed read and after a throwing one; the 0.2 API wins when
    both exist; a registry with neither reports a readable error; the legacy 0.1 path
    still works; and **the default fake now models the 0.2 shape**, so the default test
    path runs against the API current hosts actually provide instead of one that no
    longer exists.

### Notes

- `lib/index.js`: added `acquireView` / `releaseView` / `withViewSlots`, `viewSlots` now
  returns `{ slots, release }`, and the `catalog` and `resolveEverywhere` call sites read
  inside the lease. `lib/client.js` and `lib/catalog.js` are untouched.

### Release

- npm: `dsh-skill-mini-manager@2.0.4`
- GitHub: https://github.com/runcat-tommy/dsh-skill-mini-manager

## [2.0.3] - 2026-10-16

### Fixed

- **The package declared no host requirement at all, so the marketplace could only read it as `unknown`**: there were no `peerDependencies`, and the market's verdict only considers three kinds of declaration — `engines.dsh`, plus any `peerDependencies` entry that is both in the **host package inventory** and matches `@deepseek-ai/dsh*` (`deriveHostCompatibility` in `dshmarket/lib/discovery-compatibility.js`). With none of them, the plugin cannot say "I support 0.2.x".
  - Added 3 host peers — exactly the packages `dsh.client.inject` already lists: `@deepseek-ai/dsh-client-runtime` / `dsh-client-locale` / `dsh-client-ui-settings`, all ranged **`^0.1.0-rc.6 || ^0.2.0-rc.1`**.
  - Why two segments instead of `^0.2.0-rc.1` alone: declaring only 0.2.x would mark users still on a 0.1.x host as `incompatible`. The two-segment range covers `0.1.0-rc.6` / `0.1.0-rc.8` / `0.1.1-rc.2` / `0.2.0-rc.2` / `0.2.1-alpha.4`. **If the two lines ever cannot coexist, 0.2.x wins and 0.1.x is dropped.**
  - ⚠️ **This version is itself flawed (fixed in 2.0.4).** It only added declarations, so its
    runtime logic really was identical to 2.0.2 — and 2.0.2 cannot run on a 0.2 host (see
    2.0.4). The peer declaration in 2.0.3 was therefore an empty promise.
  - ⚠️ **Measured (2026-10-16, running dshmarket's own `corePackageNames` + `deriveHostCompatibility`)**: the verdict **depends on the deployment layout**, because the market counts only directories under the host's `node_modules/@deepseek-ai` whose name starts with `dsh`/`cordis`.
    - **Desktop**: the host packs its packages inside `app.asar` (`dsh/node_modules/@deepseek-ai/*`), inventory 285 names → `dsh-client-locale` and `dsh-client-ui-settings` are **in**, `dsh-client-runtime` is **not** (it exists only as a staged `@deepseek-ai/.dsh-5pHextoZ/…` directory in a CLI install) → **2 declarations count, verdict `compatible`**.
    - **CLI install**: packages are nested under `dsh/node_modules/`, so the host's `@deepseek-ai` root holds only the `dsh` directory → **none of the three peers counts** and the verdict stays `unknown`. So a CLI user seeing `unknown` is expected — **do not read it as breakage**.
    - `dsh-client-runtime` counts under **neither** layout, so it is a redundant declaration (all three exist on npm, so it causes no install error).

### Notes

- `lib/` changes only in its `VERSION` constant (`2.0.2` → `2.0.3`); runtime logic is identical to 2.0.2.
- The "dated, bilingual changelog pair" case in `test/release.test.mjs` now includes `2.0.3`, so both files must carry a dated entry.
- Evidence: host `0.2.0-rc.2`. The peer verdict, run through dshmarket's own functions, goes `unknown` → `compatible` (Desktop layout); all 64 tests pass.

### Release

- npm: `dsh-skill-mini-manager@2.0.3` (2026-10-16T03:50:32Z)
- GitHub: https://github.com/runcat-tommy/dsh-skill-mini-manager

## [2.0.2] - 2026-10-13

**A documentation-only release**, whose sole purpose is to sync the install
instructions from the repository to the npm page. npm renders the `README.md`
that existed **at the moment of publishing**, so a doc fix that is not
republished leaves the npm page permanently stale.

### Documentation

- The install section now includes the **download-without-`git` path**
  (Code → Download ZIP → unzip, then `add`), and warns that the unzipped folder
  keeps a `-main` suffix. Route ③ previously showed only `git clone`, which shut
  out anyone without `git` installed.
- Each of the three routes gained a "best for" description, that column was added
  to the table, and a one-line summary was added (prefer npm when you can).
- A test now asserts that both READMEs offer the Download ZIP path.

### Notes

- **Zero code change**: all three files under `lib/` are byte-identical to 2.0.1;
  only the `VERSION` constant moved up one notch.
- The npm page still renders the English README (the "English first" convention
  this package has followed since 2.0.1).

## [2.0.1] - 2026-10-13

**The first version published to npm.** `1.0.x` only ever existed on GitHub and
was never published to npmjs, so this is version zero as far as npm is concerned;
landing directly on `2.0.1` is a deliberate choice and does not imply a breaking
change.

### Release

- Published to npmjs: <https://www.npmjs.com/package/dsh-skill-mini-manager>
- The README install section now documents all three routes (GitHub source /
  download locally / npm) with a comparison table: the routes differ in **build
  approval** and in **how they update**, so a single-command list is not enough.
- The npm page renders the English `README` (first release of this package,
  following the majority of this repository's plugins and the last two releases).

### Notes

- This plugin **has no build step**: `lib/client.js` is a hand-written
  `__ModuleLoader__` bundle committed to the repository, and `package.json`
  declares no `prepare` script. So none of the three routes needs a build first,
  and a GitHub-source install does not normally trigger a build approval.

## [1.0.1] - 2026-10-13

### Fixed

- **Fixed "not a single skill shows up".** The first version read only the
  **global layer** of `ctx.skills`, but DSH's skill registry is host + per-scope
  layered, and `dsh-web-app`'s patch **explicitly disables the host's
  `skill-filesystem` row** (the original comment reads "presets own local
  discovery"). The consequence: on a standard web profile the global layer is
  **empty by construction**, and every user skill lives in **the layer of each
  agent preset** — so reading the global layer alone necessarily yields an empty
  catalog, precisely on the deployments that most need content. It now reads
  "the global layer + the layer of every preset in the roster" and merges by
  name; preset reads go through `AgentPresets.standingKeyFor(id)`, the read scope
  DSH provides for a host reader with no agent.
- Each row now carries a "**served to**" marker naming which presets (or the
  global layer) hand that skill to an agent; a skill private to a preset's own
  `skills/` directory names only that preset.
- A preset that cannot be read (broken composition file, failed standing mount, a
  roster that cannot be listed at all) is **reported on the page** instead of
  silently dropping a few skills; a wholly unusable roster degrades to reading
  the global layer alone.
- New refusal reason `ambiguous`: when the same skill name points at different
  files in different preset layers, the page lists it but offers no removal
  (the browser sends only a name, and with no unique target nothing is guessed).
- Tests grew from 42 to **51**; the 9 new ones are regressions for the empty
  catalog bug above.

### Release

- First push to GitHub: <https://github.com/runcat-tommy/dsh-skill-mini-manager>
- `package.json` gained `repository` / `homepage` / `bugs`.
- The README install section gained the "straight from GitHub" and "from a local
  directory" routes (including updating and uninstalling).
- Added `screenshots.json` plus two UI preview images,
  `assets/preview-zh.jpg` and `assets/preview-en.jpg`. `screenshots.json` is the
  **deterministic source** of market preview images — without it the market falls
  back to scraping the README, and that heuristic drops svg, accepts only 4
  GitHub hosts, and requires a semantic score of at least 20; in practice only 18%
  of market entries have a preview. Each README embeds only the screenshot
  matching its own language, while `screenshots.json` keeps both (the market does
  not vary by browser language).

## [1.0.0] - 2026-10-13

First version.

### Features

- Registers its own page under DSH Web Settings' `settings.section` — id
  `skill-mini-manager`, order `16`, at the **same level as** the built-in
  Plugins section (order `15`) rather than a tab inside it.
- Lists every skill the installation serves: its name, **the skill's own summary**
  (`description`), the optional `whenToUse`, its source, its model/user
  invocation surface, its directory path, file count and byte total.
- Filters the catalog by name / summary / when-to-use, with refresh and counts.
- Removes skills one at a time: a second confirmation showing the exact path to
  be moved. Removal **moves the bundle to a trash** rather than deleting it; the
  trash can restore an entry or be explicitly emptied (also double-confirmed).
- Chinese and English copy, following the DSH interface language.

### Security constraints

- The browser sends only a skill name or a trash entry id, **never a path**; the
  host re-resolves the target with its own rules every time.
- Refused removals: `bundled` source, `runtime` provider, inside `.system`, no
  file path, outside every known skill root, unsupported layout, missing
  `SKILL.md`.
- The removal target is never a skill root itself.
- Trash restore and purge only ever touch entries this plugin wrote (the trash
  directory name is strictly validated).
- All four HTTP routes accept same-origin requests only; the request body limit
  is 64 KiB.
- Per-skill accounting scans at most 5000 files, then marks the row truncated
  instead of continuing to walk.

### What ships

- `lib/index.js`: the host half (four routes + trash + refusal rules).
- `lib/catalog.js`: the pure-function core, testable without Cordis or a real
  filesystem.
- `lib/client.js`: a hand-written `__ModuleLoader__` bundle, no build step,
  depending only on the `react` platform seed.
- `test/`: 42 tests, all passing.
- `scripts/inspect-live-catalog.mjs`: a read-only probe that validates catalog
  reading and removal planning against this machine's real skills.
