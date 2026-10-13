/**
 * dsh-skill-mini-manager, browser half.
 *
 * One Settings page — `settings.section` id `skill-mini-manager`, order 16, so
 * it sits in the settings sidebar at the same level as the built-in 插件
 * (Plugins, order 15) section rather than inside it.
 *
 * The page lists every skill the host's `ctx.skills` registry currently serves,
 * with each skill's own summary (its `description` and optional `whenToUse`),
 * where it came from, how much disk it occupies, and which surfaces may invoke
 * it. Every removable skill has one 移除 action; removal is a two-step confirm
 * showing the exact path that moves, and the host moves it to a recoverable
 * trash rather than deleting it.
 *
 * Hand-written ModuleLoader bundle (no build step, no bundler): it requires only
 * `react` from the platform seed and talks to its host half over plain
 * same-origin `fetch`. All copy is localized through the `locale` service and
 * re-registered on locale change, so the DSH UI language drives this page too.
 *
 * The plugin NEVER sends a filesystem path to the host: `remove` carries a
 * skill name and `restore` carries a trash entry id, and the host derives the
 * target itself.
 */

window.__ModuleLoader__.load({
  id: "dsh-skill-mini-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");

    /** Dictionary namespace owned by this plugin. */
    var NS = "skillMiniManager";

    /** Route base served by this package's host half. */
    var API = "/dsh-skill-mini-manager/api";

    /* ------------------------------- styles ------------------------------- */

    var CSS = [
      ".skm-root { display: flex; flex-direction: column; gap: 14px; width: 100%; max-width: 760px; color: var(--dsw-alias-label-primary); }",
      ".skm-head { display: flex; flex-direction: column; gap: 4px; }",
      ".skm-title { margin: 0; font-size: 16px; font-weight: 600; line-height: 24px; }",
      ".skm-sub { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }",
      ".skm-bar { display: flex; align-items: center; gap: 8px; }",
      ".skm-search { flex: 1; min-width: 0; position: relative; display: flex; align-items: center; }",
      ".skm-search input { width: 100%; height: 34px; font: inherit; font-size: 13px; padding: 0 10px 0 30px; border-radius: 8px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); outline: none; }",
      ".skm-search input:focus-visible { border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent); }",
      ".skm-search svg { position: absolute; left: 9px; pointer-events: none; color: var(--dsw-alias-label-tertiary); }",
      ".skm-btn { font: inherit; font-size: 13px; line-height: 20px; padding: 6px 12px; border-radius: 8px; cursor: pointer; color: var(--dsw-alias-label-primary); background: transparent; border: 1px solid var(--dsw-alias-border-l2); white-space: nowrap; }",
      ".skm-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }",
      ".skm-btn:disabled { opacity: 0.5; cursor: default; }",
      ".skm-btn.danger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-border-l2); }",
      ".skm-btn.danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }",
      ".skm-btn.primary { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-label-primary)); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base)); }",
      ".skm-btn.primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-label-secondary)); }",
      ".skm-btn.small { padding: 3px 9px; font-size: 12px; line-height: 18px; }",
      ".skm-list { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }",
      ".skm-card { display: flex; flex-direction: column; gap: 7px; padding: 12px 14px; border-radius: 12px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }",
      ".skm-card:hover { border-color: var(--dsw-alias-border-l2); }",
      ".skm-card.armed { border-color: var(--dsw-alias-state-error-primary); }",
      ".skm-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }",
      ".skm-name { font-family: var(--dsw-alias-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 13px; font-weight: 600; line-height: 20px; }",
      ".skm-tag { font-size: 11px; line-height: 16px; padding: 1px 7px; border-radius: 999px; color: var(--dsw-alias-label-tertiary); border: 1px solid var(--dsw-alias-border-l2); white-space: nowrap; }",
      ".skm-tag.warn { color: var(--dsw-alias-state-warn-primary); }",
      ".skm-tag.scope { color: var(--dsw-alias-state-business-primary); }",
      ".skm-grow { flex: 1; min-width: 0; }",
      ".skm-desc { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }",
      ".skm-when { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }",
      ".skm-meta { margin: 0; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary)); font-family: var(--dsw-alias-font-family-mono, ui-monospace, monospace); overflow-wrap: anywhere; }",
      ".skm-blocked { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-warn-primary); }",
      ".skm-confirm { display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover-danger); border: 1px solid var(--dsw-alias-border-l2); }",
      ".skm-confirm p { margin: 0; font-size: 12px; line-height: 18px; }",
      ".skm-confirm .path { font-family: var(--dsw-alias-font-family-mono, ui-monospace, monospace); overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); }",
      ".skm-actions { display: flex; gap: 8px; justify-content: flex-end; }",
      ".skm-trash { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1); }",
      ".skm-trash-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }",
      ".skm-trash-item .skm-meta { flex: 1; min-width: 0; }",
      ".skm-notice { margin: 0; font-size: 12px; line-height: 18px; padding: 8px 10px; border-radius: 8px; }",
      ".skm-notice.ok { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover); }",
      ".skm-notice.err { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-interactive-bg-hover-danger); }",
      ".skm-foot { display: flex; align-items: center; gap: 8px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1); }",
      ".skm-spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--dsw-alias-border-l3); border-top-color: var(--dsw-alias-brand-primary); animation: skm-spin 0.8s linear infinite; flex: none; }",
      "@keyframes skm-spin { to { transform: rotate(360deg); } }",
    ].join("\n");

    /* ------------------------------ dictionaries ------------------------------ */

    var zh = {
      nav: "skill 极简管理",
      title: "skill 极简管理",
      subtitle: "当前 DSH 装的全部 skill。移除会把整个 skill 目录移入回收站，可随时恢复。",
      search: "搜索 skill",
      searchPlaceholder: "按名称或简介筛选…",
      refresh: "刷新",
      close: "完成",
      loading: "读取 skill 列表…",
      errorTitle: "读取失败",
      retry: "重试",
      empty: "当前没有安装任何 skill。",
      emptySearch: "没有匹配的 skill。",
      count: "共 {0} 个 skill",
      countFiltered: "匹配 {0} / {1} 个",
      countRemovable: "{0} 个可移除",
      remove: "移除",
      removeTitle: "移除 skill「{0}」？",
      removeHint: "将移动到回收站：",
      removeYes: "确认移除",
      cancel: "取消",
      noPermission: "不可移除",
      removed: "已移除「{0}」，可在下方回收站恢复。",
      restored: "已恢复「{0}」。",
      purged: "已清空回收站（{0} 项）。",
      trash: "回收站",
      trashHint: "移除的 skill 暂存在这里，不再被 DSH 发现。",
      trashEmpty: "回收站是空的。",
      restore: "恢复",
      purge: "清空回收站",
      purgeConfirm: "清空回收站会永久删除 {0} 项，无法恢复。",
      purgeYes: "永久删除",
      files: "{0} 个文件",
      filesTruncated: "{0}+ 个文件",
      removedAt: "移除于",
      invocableModel: "模型可调用",
      invocableUser: "用户可调用",
      invocableNone: "不可调用",
      errCrossOrigin: "请求来源不受信任，已拒绝。",
      errUnknownSkill: "这个 skill 已不存在，请刷新。",
      errNotRemovable: "这个 skill 不可移除。",
      errMissing: "skill 文件已经不在了，请刷新。",
      errOccupied: "原位置已被占用，无法恢复。",
      errBadResponse: "响应无法解析。",
      errHostUnreachable: "插件的主机半侧没有响应。装上后需要重启一次 DSH（dsh web）才会挂载路由。",
      errInternal: "主机半侧出错了。",
      errGeneric: "操作失败：{0}",
      "blocked.not-loadable": "无法读取该 skill 的定义。",
      "blocked.runtime-provider": "由运行时注册，没有对应文件。",
      "blocked.bundled-source": "DSH 内置 skill，不建议移除。",
      "blocked.system-owned": "位于系统保留目录（.system）内。",
      "blocked.unsupported-layout": "目录结构不受支持。",
      "blocked.outside-skill-roots": "不在已知的 skill 根目录内。",
      "blocked.missing": "标记文件已丢失。",
      "blocked.ambiguous": "同名 skill 在不同预设里指向不同文件，无法确定该移除哪一个。",
      "scopeGlobal": "全局",
      "scopePreset": "预设 {0}",
      "servedTo": "提供给 {0}",
      "scopesUnavailable": "{0} 个预设的 skill 目录没能读取（{1}），这些预设的 skill 未列出。",
      "scopesGlobalOnly": "当前只有全局层提供 skill。",
      "scopesSummary": "读取范围：{0}",
    };

    var en = {
      nav: "Skill Mini Manager",
      title: "Skill Mini Manager",
      subtitle: "Every skill this DSH installation serves. Removing one moves its whole skill directory to a trash you can restore from.",
      search: "Search skills",
      searchPlaceholder: "Filter by name or summary…",
      refresh: "Refresh",
      close: "Done",
      loading: "Reading the skill catalog…",
      errorTitle: "Could not read the catalog",
      retry: "Retry",
      empty: "No skill is installed right now.",
      emptySearch: "No skill matches that filter.",
      count: "{0} skill(s)",
      countFiltered: "{0} of {1} match",
      countRemovable: "{0} removable",
      remove: "Remove",
      removeTitle: "Remove the skill “{0}”?",
      removeHint: "It will be moved to the trash:",
      removeYes: "Remove it",
      cancel: "Cancel",
      noPermission: "Not removable",
      removed: "Removed “{0}” — restore it from the trash below.",
      restored: "Restored “{0}”.",
      purged: "Trash emptied ({0} item(s)).",
      trash: "Trash",
      trashHint: "Removed skills wait here and are no longer discovered by DSH.",
      trashEmpty: "The trash is empty.",
      restore: "Restore",
      purge: "Empty trash",
      purgeConfirm: "Emptying the trash permanently deletes {0} item(s).",
      purgeYes: "Delete forever",
      files: "{0} file(s)",
      filesTruncated: "{0}+ file(s)",
      removedAt: "Removed",
      invocableModel: "Model",
      invocableUser: "User",
      invocableNone: "Not invocable",
      errCrossOrigin: "The request came from an untrusted origin and was refused.",
      errUnknownSkill: "That skill no longer exists — refresh.",
      errNotRemovable: "That skill is not removable.",
      errMissing: "The skill files are already gone — refresh.",
      errOccupied: "The original location is occupied; cannot restore.",
      errBadResponse: "The response could not be parsed.",
      errHostUnreachable: "The plugin's host half did not answer. It mounts its routes on the next DSH start (dsh web).",
      errInternal: "The host half failed.",
      errGeneric: "Failed: {0}",
      "blocked.not-loadable": "Its definition cannot be read.",
      "blocked.runtime-provider": "Registered at runtime; it has no files.",
      "blocked.bundled-source": "A DSH-bundled skill; removal is not offered.",
      "blocked.system-owned": "It lives in the system-owned .system directory.",
      "blocked.unsupported-layout": "Its directory layout is unsupported.",
      "blocked.outside-skill-roots": "It is outside every known skill root.",
      "blocked.missing": "Its marker file is missing.",
      "blocked.ambiguous": "That name resolves to different files in different presets, so the target is ambiguous.",
      "scopeGlobal": "global",
      "scopePreset": "preset {0}",
      "servedTo": "served to {0}",
      "scopesUnavailable": "{0} preset(s) could not be read ({1}); their skills are not listed.",
      "scopesGlobalOnly": "Only the global layer serves skills here.",
      "scopesSummary": "Read from: {0}",
    };

    /* -------------------------------- helpers -------------------------------- */

    var boundT = null;

    /** Translate `key`, substituting positional `{0}`-style placeholders. */
    function tf(key, args) {
      var text = boundT ? boundT(key) : key;
      if (args) {
        for (var i = 0; i < args.length; i++) text = String(text).split("{" + i + "}").join(String(args[i]));
      }
      return text;
    }

    /** `React.createElement` with variadic children. */
    function el(type, props) {
      var rest = Array.prototype.slice.call(arguments, 2);
      return React.createElement.apply(React, [type, props].concat(rest));
    }

    /** Human-readable byte count. */
    function formatBytes(bytes) {
      if (typeof bytes !== "number" || !isFinite(bytes) || bytes < 0) return null;
      if (bytes < 1024) return bytes + " B";
      var units = ["KB", "MB", "GB"];
      var value = bytes / 1024;
      var index = 0;
      while (value >= 1024 && index < units.length - 1) {
        value = value / 1024;
        index += 1;
      }
      return (value >= 10 ? Math.round(value) : Math.round(value * 10) / 10) + " " + units[index];
    }

    /** Short, locale-aware timestamp for one trash row. */
    function formatStamp(ms) {
      if (typeof ms !== "number" || !isFinite(ms)) return "";
      try {
        return new Date(ms).toLocaleString();
      } catch (error) {
        return String(ms);
      }
    }

    /**
     * One JSON call to the host half.
     *
     * A non-JSON body is reported as `host-unreachable` rather than a parse
     * failure: the SPA fallback answers an unmounted route with index.html and
     * a 200, which is exactly what a not-yet-restarted host looks like.
     */
    function request(path, init) {
      var options = Object.assign(
        { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } },
        init || {},
      );
      return fetch(path, options).then(function (response) {
        var type = response.headers.get("content-type") || "";
        if (type.indexOf("application/json") === -1) throw new Error("host-unreachable");
        return response.json().then(
          function (payload) {
            if (!response.ok) throw new Error(payload && payload.error ? payload.error : "http-" + response.status);
            if (!payload || payload.ok !== true) throw new Error((payload && payload.error) || "bad-response");
            return payload;
          },
          function () {
            throw new Error("bad-response");
          },
        );
      });
    }

    /** POST one JSON body and return the parsed payload. */
    function post(path, body) {
      return request(path, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
    }

    /** Map one failure onto localized copy. */
    function describeError(error) {
      var code = error && error.message ? error.message : "unknown";
      if (code === "cross-origin") return tf("errCrossOrigin");
      if (code === "unknown-skill") return tf("errUnknownSkill");
      if (code === "not-removable") return tf("errNotRemovable");
      if (code === "missing") return tf("errMissing");
      if (code === "occupied") return tf("errOccupied");
      if (code === "bad-response") return tf("errBadResponse");
      if (code === "host-unreachable") return tf("errHostUnreachable");
      if (code === "internal") return tf("errInternal");
      return tf("errGeneric", [code]);
    }

    /** Localized label for one provider source bucket. */
    function sourceLabel(source) {
      var known = {
        "user-dsh": "user-dsh",
        "user-agents": "user-agents",
        "project-dsh": "project-dsh",
        "project-agents": "project-agents",
        custom: "custom",
        bundled: "bundled",
        runtime: "runtime",
      };
      return known[source] || String(source || "unknown");
    }

    /** Localized label for one registry view slot id the host reported. */
    function scopeLabel(scopeId) {
      var text = String(scopeId || "");
      if (text.indexOf("preset:") === 0) return tf("scopePreset", [text.slice(7)]);
      if (text === "global") return tf("scopeGlobal");
      return text;
    }

    /**
     * Who serves one skill.
     *
     * A user-root skill is discovered by every preset that mounts the filesystem
     * provider, so the honest answer is a list; a preset-only root names just
     * the one preset that carries it.
     */
    function servedTo(entry) {
      var scopes = Array.isArray(entry.scopes) ? entry.scopes : [];
      if (scopes.length === 0) return "";
      if (scopes.length === 1) return scopeLabel(scopes[0]);
      return scopes.map(scopeLabel).join(" · ");
    }

    /** The reason copy for a skill this page refuses to offer removal for. */
    function blockedText(entry) {
      if (!entry.blocked) return tf("noPermission");
      var text = tf("blocked." + entry.blocked);
      // An unmapped reason falls back to the generic refusal rather than
      // rendering the raw dictionary key at the user.
      return text === "blocked." + entry.blocked ? tf("noPermission") : text;
    }

    /* ----------------------------- the settings page ----------------------------- */

    var SEARCH_ICON = el(
      "svg",
      { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
      el("circle", { cx: 7, cy: 7, r: 4.5, stroke: "currentColor", strokeWidth: 1.5 }),
      el("path", { d: "M10.5 10.5 14 14", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" }),
    );

    /** One skill row: summary, provenance, footprint, and the removal action. */
    function SkillCard(props) {
      var entry = props.entry;
      var armed = props.armed;
      var busy = props.busy;

      var facts = [];
      if (entry.readable && entry.bundlePath) facts.push(entry.bundlePath);
      else if (entry.filePath) facts.push(entry.filePath);
      if (typeof entry.files === "number") {
        facts.push(tf(entry.truncated ? "filesTruncated" : "files", [entry.files]));
      }
      var size = formatBytes(entry.bytes);
      if (size) facts.push(size);

      var invocable = entry.modelInvocable || entry.userInvocable;
      var served = servedTo(entry);

      return el(
        "li",
        { className: "skm-card" + (armed ? " armed" : "") },
        el(
          "div",
          { className: "skm-row" },
          el("span", { className: "skm-name" }, entry.name),
          el("span", { className: "skm-tag" }, sourceLabel(entry.source)),
          entry.modelInvocable ? el("span", { className: "skm-tag" }, tf("invocableModel")) : null,
          entry.userInvocable ? el("span", { className: "skm-tag" }, tf("invocableUser")) : null,
          !invocable ? el("span", { className: "skm-tag warn" }, tf("invocableNone")) : null,
          served.length > 0 ? el("span", { className: "skm-tag scope" }, tf("servedTo", [served])) : null,
          el("span", { className: "skm-grow" }),
          entry.removable
            ? el(
                "button",
                {
                  type: "button",
                  className: "skm-btn small danger",
                  disabled: busy !== null || armed,
                  onClick: function () {
                    props.onArm(entry.name);
                  },
                },
                tf("remove"),
              )
            : null,
        ),
        el("p", { className: "skm-desc" }, entry.description),
        entry.whenToUse ? el("p", { className: "skm-when" }, entry.whenToUse) : null,
        facts.length > 0 ? el("p", { className: "skm-meta" }, facts.join("  ·  ")) : null,
        !entry.removable ? el("p", { className: "skm-blocked" }, blockedText(entry)) : null,
        armed
          ? el(
              "div",
              { className: "skm-confirm" },
              el("p", null, tf("removeTitle", [entry.name])),
              el("p", null, tf("removeHint")),
              el("p", { className: "path" }, entry.bundlePath || entry.filePath || ""),
              el(
                "div",
                { className: "skm-actions" },
                el(
                  "button",
                  {
                    type: "button",
                    className: "skm-btn small",
                    disabled: busy,
                    onClick: props.onCancel,
                  },
                  tf("cancel"),
                ),
                el(
                  "button",
                  {
                    type: "button",
                    className: "skm-btn small danger",
                    disabled: busy,
                    onClick: function () {
                      props.onConfirm(entry.name);
                    },
                  },
                  tf("removeYes"),
                ),
              ),
            )
          : null,
      );
    }

    /**
     * The Settings page.
     * @param props - the settings shell supplies `close`; the inject face supplies `t`.
     */
    function SkillMiniManagerSection(props) {
      var state = React.useState({ status: "loading", data: null, message: null });
      var snapshot = state[0];
      var setSnapshot = state[1];
      var queryState = React.useState("");
      var query = queryState[0];
      var setQuery = queryState[1];
      var armedState = React.useState(null);
      var armed = armedState[0];
      var setArmed = armedState[1];
      var busyState = React.useState(null);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var noticeState = React.useState(null);
      var notice = noticeState[0];
      var setNotice = noticeState[1];
      var purgeState = React.useState(false);
      var purgeArmed = purgeState[0];
      var setPurgeArmed = purgeState[1];
      var tickState = React.useState(0);
      var tick = tickState[0];
      var setTick = tickState[1];
      // A locale switch only needs a re-render (every label goes through `tf`,
      // which reads the active locale at call time) — never a refetch.
      var localeTickState = React.useState(0);
      var setLocaleTick = localeTickState[1];

      React.useEffect(
        function () {
          var live = true;
          var controller = typeof AbortController === "function" ? new AbortController() : null;
          setSnapshot(function (previous) {
            return { status: previous.data ? "ready" : "loading", data: previous.data, message: null };
          });
          request(API + "/catalog", controller ? { signal: controller.signal } : undefined).then(
            function (data) {
              if (!live) return;
              setSnapshot({ status: "ready", data: data, message: null });
            },
            function (error) {
              if (!live) return;
              setSnapshot({ status: "error", data: null, message: describeError(error) });
            },
          );
          return function () {
            live = false;
            if (controller) controller.abort();
          };
        },
        [tick],
      );

      // A locale switch needs only a re-render: every label goes through `tf`,
      // which reads the active locale at call time, so nothing has to refetch.
      React.useEffect(
        function () {
          if (!props.localeSubscribe) return undefined;
          return props.localeSubscribe(function () {
            setLocaleTick(function (value) {
              return value + 1;
            });
          });
        },
        [],
      );

      var data = snapshot.data;
      var skills = data && Array.isArray(data.skills) ? data.skills : [];
      var trash = data && Array.isArray(data.trash) ? data.trash : [];
      var normalized = query.trim().toLowerCase();
      var filtered = normalized.length === 0
        ? skills
        : skills.filter(function (entry) {
            return [entry.name, entry.description, entry.whenToUse]
              .filter(function (value) {
                return typeof value === "string";
              })
              .some(function (value) {
                return value.toLowerCase().indexOf(normalized) !== -1;
              });
          });
      var removableCount = skills.filter(function (entry) {
        return entry.removable;
      }).length;

      function reload(message) {
        setNotice(message || null);
        setArmed(null);
        setPurgeArmed(false);
        setTick(function (value) {
          return value + 1;
        });
      }

      function confirmRemove(skillName) {
        setBusy(skillName);
        setNotice(null);
        post(API + "/remove", { name: skillName }).then(
          function () {
            setBusy(null);
            reload({ kind: "ok", text: tf("removed", [skillName]) });
          },
          function (error) {
            setBusy(null);
            setArmed(null);
            setNotice({ kind: "err", text: describeError(error) });
          },
        );
      }

      function restore(id, skillName) {
        setBusy(id);
        setNotice(null);
        post(API + "/restore", { id: id }).then(
          function () {
            setBusy(null);
            reload({ kind: "ok", text: tf("restored", [skillName]) });
          },
          function (error) {
            setBusy(null);
            setNotice({ kind: "err", text: describeError(error) });
          },
        );
      }

      function purge() {
        var count = trash.length;
        setBusy("purge");
        setNotice(null);
        post(API + "/purge", {}).then(
          function () {
            setBusy(null);
            reload({ kind: "ok", text: tf("purged", [count]) });
          },
          function (error) {
            setBusy(null);
            setNotice({ kind: "err", text: describeError(error) });
          },
        );
      }

      var children = [];

      children.push(
        el(
          "div",
          { className: "skm-head" },
          el("h2", { className: "skm-title" }, tf("title")),
          el("p", { className: "skm-sub" }, tf("subtitle")),
        ),
      );

      if (snapshot.status === "loading") {
        children.push(
          el(
            "div",
            { className: "skm-row", "aria-busy": "true" },
            el("span", { className: "skm-spin" }),
            el("span", { className: "skm-sub" }, tf("loading")),
          ),
        );
      }

      // A deployment reads skills through one slot per registry view. A preset
      // whose composition failed, or whose layer could not be read, must be
      // visible here: an "empty" catalog with an unreadable preset behind it is
      // exactly the answer this page must not give silently.
      var unreadable = (data && Array.isArray(data.scopes) ? data.scopes : []).filter(function (scope) {
        return scope.unavailable;
      });
      if (unreadable.length > 0) {
        children.push(
          el(
            "p",
            { className: "skm-notice err", role: "status" },
            tf("scopesUnavailable", [
              unreadable.length,
              unreadable
                .map(function (scope) {
                  return scopeLabel(scope.id) + ": " + scope.unavailable;
                })
                .join("; "),
            ]),
          ),
        );
      }

      if (snapshot.status === "error") {
        children.push(
          el(
            "div",
            { className: "skm-confirm" },
            el("p", { role: "alert" }, tf("errorTitle")),
            el("p", { className: "path" }, snapshot.message || ""),
            el(
              "div",
              { className: "skm-actions" },
              el(
                "button",
                {
                  type: "button",
                  className: "skm-btn small",
                  onClick: function () {
                    reload(null);
                  },
                },
                tf("retry"),
              ),
            ),
          ),
        );
      }

      if (snapshot.status === "ready") {
        children.push(
          el(
            "div",
            { className: "skm-bar" },
            el(
              "label",
              { className: "skm-search" },
              SEARCH_ICON,
              el("input", {
                type: "search",
                value: query,
                placeholder: tf("searchPlaceholder"),
                "aria-label": tf("search"),
                onChange: function (event) {
                  setQuery(event.target.value);
                },
              }),
            ),
            el(
              "button",
              {
                type: "button",
                className: "skm-btn",
                disabled: busy !== null,
                onClick: function () {
                  reload(null);
                },
              },
              tf("refresh"),
            ),
          ),
        );

        children.push(
          el(
            "p",
            { className: "skm-sub" },
            tf("count", [skills.length]) +
              (normalized.length > 0 ? "  ·  " + tf("countFiltered", [filtered.length, skills.length]) : "") +
              (removableCount > 0 ? "  ·  " + tf("countRemovable", [removableCount]) : ""),
          ),
        );

        if (skills.length === 0) {
          children.push(el("p", { className: "skm-sub" }, tf("empty")));
        } else if (filtered.length === 0) {
          children.push(el("p", { className: "skm-sub" }, tf("emptySearch")));
        } else {
          children.push(
            el(
              "ul",
              { className: "skm-list" },
              filtered.map(function (entry) {
                return el(SkillCard, {
                  key: entry.name,
                  entry: entry,
                  armed: armed === entry.name,
                  busy: busy !== null,
                  onArm: function (skillName) {
                    setArmed(skillName);
                    setNotice(null);
                  },
                  onCancel: function () {
                    setArmed(null);
                  },
                  onConfirm: confirmRemove,
                });
              }),
            ),
          );
        }
      }

      if (notice) {
        children.push(
          el("p", { className: "skm-notice " + notice.kind, role: notice.kind === "err" ? "alert" : "status" }, notice.text),
        );
      }

      if (trash.length > 0 || purgeArmed) {
        children.push(
          el(
            "div",
            { className: "skm-trash" },
            el(
              "div",
              { className: "skm-row" },
              el("h3", { className: "skm-title" }, tf("trash")),
              el("span", { className: "skm-sub" }, tf("trashHint")),
              el("span", { className: "skm-grow" }),
              purgeArmed
                ? el(
                    "span",
                    { className: "skm-row" },
                    el("span", { className: "skm-sub" }, tf("purgeConfirm", [trash.length])),
                    el(
                      "button",
                      {
                        type: "button",
                        className: "skm-btn small",
                        disabled: busy !== null,
                        onClick: function () {
                          setPurgeArmed(false);
                        },
                      },
                      tf("cancel"),
                    ),
                    el(
                      "button",
                      {
                        type: "button",
                        className: "skm-btn small danger",
                        disabled: busy !== null,
                        onClick: purge,
                      },
                      tf("purgeYes"),
                    ),
                  )
                : el(
                    "button",
                    {
                      type: "button",
                      className: "skm-btn small danger",
                      disabled: busy !== null,
                      onClick: function () {
                        setPurgeArmed(true);
                      },
                    },
                    tf("purge"),
                  ),
            ),
            trash.length === 0 ? el("p", { className: "skm-sub" }, tf("trashEmpty")) : null,
            trash.map(function (item) {
              return el(
                "div",
                { key: item.id, className: "skm-trash-item" },
                el("span", { className: "skm-name" }, item.name),
                el(
                  "span",
                  { className: "skm-meta" },
                  (item.originalPath || "") + (item.removedAt ? "  ·  " + tf("removedAt") + " " + formatStamp(item.removedAt) : ""),
                ),
                el(
                  "button",
                  {
                    type: "button",
                    className: "skm-btn small",
                    disabled: busy !== null,
                    onClick: function () {
                      restore(item.id, item.name);
                    },
                  },
                  tf("restore"),
                ),
              );
            }),
          ),
        );
      }

      children.push(
        el(
          "div",
          { className: "skm-foot" },
          el("span", { className: "skm-grow" }),
          typeof props.close === "function" ? el(
            "button",
            { type: "button", className: "skm-btn primary", onClick: props.close },
            tf("close"),
          ) : null,
        ),
      );

      return el("div", { className: "skm-root" }, children);
    }

    /* --------------------------------- apply --------------------------------- */

    /** Install the page's stylesheet, removed again on teardown. */
    function installStyles() {
      if (typeof document === "undefined") return function () {};
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-skill-mini-manager";
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return function () {
        if (tag.parentNode !== null) tag.parentNode.removeChild(tag);
      };
    }

    function apply(ctx) {
      var removeStyles = installStyles();

      // Both dictionaries are registered at once and `t` reads the active
      // locale at call time, so a locale switch needs no re-registration: the
      // nav label (a function the shell resolves per locale revision) and every
      // rendered string follow the switch on their own.
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "dsh-skill-mini-manager: dictionaries");
      boundT = ctx.locale.bind(NS);

      ctx.effect(function () {
        return removeStyles;
      }, "dsh-skill-mini-manager: stylesheet");

      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          {
            name: "settings.section",
            // Order 16 puts this page directly after 插件 (order 15) and
            // before 智能体预设 (order 20): the same sidebar level, not a tab
            // inside the Plugins section.
            id: "skill-mini-manager",
            order: 16,
            label: function () {
              return tf("nav");
            },
            locale: NS,
            inject: function () {
              return {
                t: ctx.locale.bind(NS),
                localeSubscribe: function (listener) {
                  return ctx.locale.subscribe(listener);
                },
              };
            },
          },
          SkillMiniManagerSection,
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  },
});
