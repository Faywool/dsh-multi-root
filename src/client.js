/**
 * The browser half of dsh-multi-root.
 *
 * It is one dialog and one settings page over the same table of extra roots:
 * pick a workspace, see what is mounted on it, mount a directory the native
 * picker returns, drop one, or rename / reorder / retarget it. The dialog opens
 * from a single entry at the sidebar foot, which is where the original plugin
 * put its Folders action.
 *
 * Everything here follows the same rule as the host half — nothing may throw
 * outside its own guard. A missing slot service, a failed fetch, an unexpected
 * payload: each one degrades this plugin to "no panel" and leaves DSH running.
 *
 * The bundle is loaded through `window.__ModuleLoader__.load`, which only
 * registers the factory; the module body runs on first import.
 */

/* global window, document */
;(function () {
  'use strict'

  var ROUTE = '/dsh-multi-root/state'
  var SETTINGS_ID = 'dsh-multi-root'
  var OVERLAY_ID = 'dsh-multi-root-modal'
  var FOOTER_ID = 'dsh-multi-root-footer'

  var loader = window.__ModuleLoader__
  if (loader === undefined || typeof loader.load !== 'function') return

  loader.load({
    id: 'dsh-multi-root',
    factory: function (require) {
      var module = { exports: {} }
      var exports = module.exports

      var React = require('react')
      var h = React.createElement

      /** Slots are the only hard need: without them there is nowhere to render. */
      var inject = ['slots']

      /**
       * Whether the dialog is open.
       *
       * The button lives in the sidebar and the dialog lives in the frame-wide
       * overlay slot, so the two components are separate trees. A tiny external
       * store keeps them in step without depending on any host state.
       */
      var dialog = { open: false, listeners: [] }

      function subscribe(listener) {
        dialog.listeners.push(listener)
        return function () {
          var index = dialog.listeners.indexOf(listener)
          if (index >= 0) dialog.listeners.splice(index, 1)
        }
      }

      function setDialogOpen(next) {
        if (dialog.open === next) return
        dialog.open = next
        dialog.listeners.slice().forEach(function (listener) {
          try {
            listener(next)
          } catch (error) {
            // A listener that throws must not stop the others.
          }
        })
      }

      function useDialogOpen() {
        var pair = React.useState(dialog.open)
        var open = pair[0]
        var setOpen = pair[1]
        React.useEffect(function () {
          setOpen(dialog.open)
          return subscribe(setOpen)
        }, [])
        return open
      }

      var STYLE = [
        '.mr-wrap{display:flex;flex-direction:column;gap:14px;padding:18px 20px;box-sizing:border-box;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary,#e6e6e6)}',
        '.mr-head{display:flex;flex-direction:column;gap:4px}',
        '.mr-title{margin:0;font-size:14px;font-weight:600}',
        '.mr-sub{margin:0;color:var(--dsw-alias-label-secondary,#9a9a9a);font-size:12px;line-height:1.6}',
        '.mr-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.mr-ws{display:flex;align-items:center;gap:8px;min-width:0}',
        '.mr-ws-path{margin-top:4px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary,#9a9a9a);word-break:break-all}',
        '.mr-check{display:inline-flex;align-items:center;gap:6px;height:var(--mr-btn-h);padding:0 10px;border-radius:var(--mr-btn-radius);border:1px solid var(--mr-btn-border);color:var(--mr-btn-fg);font-size:12px;cursor:pointer;user-select:none;white-space:nowrap;transition:var(--mr-btn-ease)}',
        '.mr-check:hover{background:var(--mr-btn-bg-hover);border-color:var(--mr-btn-border-hover)}',
        '.mr-check input{width:13px;height:13px;margin:0;accent-color:var(--dsw-alias-brand-primary,#4a8fd6);cursor:pointer}',
        '.mr-check:has(input:not(:checked)){color:var(--mr-btn-fg-dim)}',
        '.mr-select{min-width:200px;max-width:100%;height:30px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#3a3a3a);background:var(--dsw-alias-bg-layer-2,#1e1e1e);color:inherit;font:inherit;font-size:12px}',
        '.mr-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1,#333);border-radius:8px}',
        '.mr-item{position:relative;display:flex;align-items:center;gap:12px;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1,#333)}',
        '.mr-item:first-child{border-top:none;border-radius:7px 7px 0 0}',
        '.mr-item:last-child{border-radius:0 0 7px 7px}',
        '.mr-item:only-child{border-radius:7px}',
        '.mr-item:hover{background:var(--dsw-alias-bg-layer-2,#191919)}',
        '.mr-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
        '.mr-line{display:flex;align-items:center;gap:8px;min-width:0}',
        '.mr-alias{font-size:14.5px;font-weight:600;letter-spacing:.01em;color:var(--dsw-alias-label-primary,#f0f0f0);white-space:nowrap}',
        '.mr-path{min-width:0;color:var(--dsw-alias-label-secondary,#8f8f8f);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mr-command{min-width:0;color:var(--dsw-alias-label-secondary,#8f8f8f);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85}',
        '.mr-badge{flex:none;font-size:11px;line-height:16px;padding:0 7px;border-radius:99px;border:1px solid var(--dsw-alias-border-l1,#3a3a3a);color:var(--dsw-alias-label-secondary,#9a9a9a)}',
        '.mr-badge[data-mode="readwrite"]{color:var(--dsw-alias-state-success-primary,#7fd1a0)}',
        '.mr-badge[data-mode="readonly"]{color:var(--dsw-alias-state-warn-primary,#d9b06a)}',
        '.mr-git{flex:none;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#8f8f8f)}',
        '.mr-actions{flex:none;display:flex;align-items:center;gap:6px}',
        ':root{--mr-btn-h:30px;--mr-btn-pad:0 10px;--mr-btn-radius:6px;--mr-btn-fg:var(--dsw-alias-label-primary,#e6e6e6);--mr-btn-fg-dim:var(--dsw-alias-label-secondary,#9a9a9a);--mr-btn-border:var(--dsw-alias-border-l1,#3a3a3a);--mr-btn-border-hover:var(--dsw-alias-border-l2,#4a4a4a);--mr-btn-bg-hover:var(--dsw-alias-bg-layer-2,#242424);--mr-btn-bg-active:rgba(255,255,255,.10);--mr-btn-ease:background-color .12s ease,border-color .12s ease,color .12s ease}',
        '.mr-btn{display:inline-flex;align-items:center;justify-content:center;height:var(--mr-btn-h);padding:var(--mr-btn-pad);border-radius:var(--mr-btn-radius);border:1px solid var(--mr-btn-border);background:transparent;color:var(--mr-btn-fg);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;appearance:none;-webkit-appearance:none;transition:var(--mr-btn-ease)}',
        '.mr-btn:hover{background:var(--mr-btn-bg-hover);border-color:var(--mr-btn-border-hover)}',
        '.mr-btn:active{background:var(--mr-btn-bg-active);border-color:var(--mr-btn-border-hover)}',
        '.mr-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4a8fd6);outline-offset:1px}',
        '.mr-btn:disabled{opacity:.45;cursor:default;background:transparent;border-color:var(--mr-btn-border)}',
        '.mr-primary{font-weight:600;color:var(--mr-btn-fg);border-color:var(--mr-btn-border)}',
        '.mr-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:var(--mr-btn-h);height:var(--mr-btn-h);padding:0;border-radius:var(--mr-btn-radius);border:1px solid transparent;background:transparent;color:var(--mr-btn-fg-dim);font:inherit;font-size:15px;line-height:1;cursor:pointer;appearance:none;-webkit-appearance:none;transition:var(--mr-btn-ease)}',
        '.mr-icon-btn:hover{background:var(--mr-btn-bg-hover);border-color:var(--mr-btn-border);color:var(--mr-btn-fg)}',
        '.mr-icon-btn:active{background:var(--mr-btn-bg-active);border-color:var(--mr-btn-border-hover);color:var(--mr-btn-fg)}',
        '.mr-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4a8fd6);outline-offset:1px}',
        '.mr-icon-btn[aria-expanded="true"]{background:var(--mr-btn-bg-hover);border-color:var(--mr-btn-border);color:var(--mr-btn-fg)}',
        '.mr-icon-btn:disabled{opacity:.45;cursor:default}',
        '.mr-menu{position:fixed;z-index:1200;min-width:196px;display:flex;flex-direction:column;gap:1px;padding:5px;border:1px solid var(--mr-btn-border);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#1b1b1b);box-shadow:0 16px 40px rgba(0,0,0,.55)}',
        '.mr-menu-item{display:flex;align-items:center;height:30px;padding:0 10px;border-radius:var(--mr-btn-radius);border:1px solid transparent;background:transparent;color:var(--mr-btn-fg);font:inherit;font-size:12.5px;line-height:1;text-align:left;white-space:nowrap;cursor:pointer;user-select:none;outline:none;transition:var(--mr-btn-ease)}',
        '.mr-menu-item:hover,.mr-menu-item:focus-visible{background:var(--mr-btn-bg-hover);border-color:var(--mr-btn-border-hover)}',
        '.mr-menu-item:active{background:var(--mr-btn-bg-active)}',
        '.mr-menu-item[aria-disabled="true"]{opacity:.38;cursor:default;background:transparent;border-color:transparent}',
        '.mr-menu-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1,#333)}',
        '.mr-danger{color:var(--dsw-alias-state-error-primary,#e08b8b)}',
        '.mr-empty{padding:18px 12px;color:var(--dsw-alias-label-secondary,#9a9a9a);text-align:center;font-size:12px}',
        '.mr-overlay--nested{z-index:1100;background:rgba(0,0,0,.45)}',
        '.mr-sheet{display:flex;flex-direction:column;gap:12px;width:min(468px,92vw);padding:18px 18px 16px;border:1px solid rgba(128,128,128,.28);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#1b1b1b);box-shadow:0 24px 64px rgba(0,0,0,.55)}',
        '.mr-sheet-title{font-size:14px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary,#f0f0f0)}',
        '.mr-sheet-hint{margin-top:-4px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
        '.mr-sheet-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:6px}',
        '.mr-sheet .mr-input{display:block;box-sizing:border-box;width:100%;height:36px;padding:0 12px;border-radius:8px;border:1px solid rgba(128,128,128,.34);background:var(--dsw-alias-bg-base,#141414);color:var(--dsw-alias-label-primary,#f2f2f2);font:inherit;font-size:13.5px;line-height:1.4;outline:none;appearance:none;-webkit-appearance:none;transition:border-color .12s ease,box-shadow .12s ease}',
        '.mr-sheet .mr-input:focus{border-color:var(--mr-btn-border-hover);box-shadow:0 0 0 2px rgba(255,255,255,.10)}',
        '.mr-edit-error{color:var(--dsw-alias-state-error-primary,#e08b8b);font-size:12px}',
        '.mr-note{margin:0;color:var(--dsw-alias-label-secondary,#9a9a9a);font-size:12px;line-height:1.6}',
        '.mr-error{margin:0;color:var(--dsw-alias-state-error-primary,#e08b8b);font-size:12px}',
        '.mr-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#9a9a9a);word-break:break-all}',
        '.mr-table{border-collapse:collapse;font-size:12px}',
        '.mr-table td{padding:3px 12px 3px 0;vertical-align:top}',
        '.mr-table td:first-child{color:var(--dsw-alias-label-secondary,#9a9a9a);white-space:nowrap}',
        '.mr-browse{margin-top:4px;border:1px solid var(--dsw-alias-border-l1,#333);border-radius:8px;overflow:hidden}',
        '.mr-crumb{display:flex;gap:6px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,#333);font-size:12px}',
        '.mr-crumb .mr-crumb-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
        '.mr-entries{max-height:240px;overflow:auto}',
        '.mr-entry{display:flex;gap:10px;align-items:center;padding:4px 10px;font-size:12px;cursor:pointer;background:transparent;border:0;color:inherit;width:100%;text-align:left;transition:var(--mr-btn-ease)}',
        '.mr-entry:hover{background:var(--mr-btn-bg-hover)}',
        '.mr-entry:active{background:var(--mr-btn-bg-active)}',
        '.mr-entry:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4a8fd6);outline-offset:-2px}',
        '.mr-entry[data-kind="dir"] .mr-entry-name{color:var(--dsw-alias-label-primary,#e6e6e6)}',
        '.mr-entry-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
        '.mr-entry-size{color:var(--dsw-alias-label-secondary,#9a9a9a);font-size:11px;white-space:nowrap}',
        '.mr-preview{margin:0;padding:8px 10px;max-height:260px;overflow:auto;border-top:1px solid var(--dsw-alias-border-l1,#333);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.45;white-space:pre;color:var(--dsw-alias-label-primary,#e6e6e6)}',
        '.mr-footer-btn{display:flex;align-items:center;justify-content:flex-start;gap:9px;width:100%;box-sizing:border-box;height:34px;padding:0 10px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--mr-btn-fg);font:inherit;font-size:13px;font-weight:500;line-height:1;cursor:pointer;text-align:left;white-space:nowrap;overflow:hidden;appearance:none;-webkit-appearance:none;transition:var(--mr-btn-ease)}',
        '.mr-footer-btn:hover{background:var(--mr-btn-bg-hover);border-color:var(--mr-btn-border);color:var(--mr-btn-fg)}',
        '.mr-footer-btn:active{background:var(--mr-btn-bg-active);border-color:var(--mr-btn-border-hover);color:var(--mr-btn-fg)}',
        '.mr-footer-btn:focus-visible{outline:2px solid var(--mr-btn-border-hover);outline-offset:1px}',
        '.mr-footer-btn[data-rail="true"]{justify-content:center;padding:0}',
        '.mr-footer-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mr-footer-label{overflow:hidden;text-overflow:ellipsis}',
        '.mr-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);pointer-events:auto}',
        '.mr-dialog{display:flex;flex-direction:column;width:min(820px,92vw);max-height:82vh;background:var(--dsw-alias-bg-layer-1,#1b1b1b);border:1px solid var(--dsw-alias-border-l1,#3a3a3a);border-radius:12px;box-shadow:0 24px 70px rgba(0,0,0,.55);overflow:hidden}',
        '.mr-dialog-bar{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,#333)}',
        '.mr-dialog-bar .mr-title{flex:1;min-width:0;font-size:13.5px;font-weight:600}',
        '.mr-dialog-body{flex:1;min-height:0;overflow:auto}',
        '.mr-dialog-body .mr-wrap{padding:16px}',
        '.mr-close{display:inline-flex;align-items:center;justify-content:center;height:var(--mr-btn-h);padding:var(--mr-btn-pad);border-radius:var(--mr-btn-radius);border:1px solid var(--mr-btn-border);background:transparent;color:var(--mr-btn-fg-dim);font:inherit;font-size:12px;cursor:pointer;appearance:none;-webkit-appearance:none;transition:var(--mr-btn-ease)}',
        '.mr-close:hover{background:var(--mr-btn-bg-hover);border-color:var(--mr-btn-border-hover);color:var(--mr-btn-fg)}',
        '.mr-close:active{background:var(--mr-btn-bg-active);border-color:var(--mr-btn-border-hover);color:var(--mr-btn-fg)}',
        '.mr-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4a8fd6);outline-offset:1px}',
      ].join('\n')

      var styleElement = null
      var styleSheetApplied = false

      // Two independent paths so the modal can never lose its styles: a
      // constructable stylesheet (unaffected by inline-style CSP) and a plain
      // <style> element (unaffected by a missing adoptedStyleSheets API).
      function insertStyles(ctx) {
        // Best effort through the client styles service as well: when it works
        // it is the sanctioned path, and a duplicate copy of the same rules is
        // harmless. Its disposer is deliberately not registered anywhere, so a
        // reload can never leave the modal unstyled.
        try {
          var styles = ctx.get('styles')
          if (styles !== undefined && styles !== null && typeof styles.insert === 'function') styles.insert(STYLE)
        } catch (error) {
          // The two paths below are the dependable ones.
        }
        try {
          if (!styleSheetApplied && typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document) {
            var sheet = new CSSStyleSheet()
            sheet.replaceSync(STYLE)
            document.adoptedStyleSheets = document.adoptedStyleSheets.concat(sheet)
            styleSheetApplied = true
          }
        } catch (error) {
          // Fall back to the element below.
        }
        try {
          if (styleElement !== null && document.contains(styleElement)) return undefined
          styleElement = document.createElement('style')
          styleElement.setAttribute('data-dsh-multi-root', '')
          styleElement.textContent = STYLE
          ;(document.head || document.documentElement).appendChild(styleElement)
        } catch (error) {
          // Styles are cosmetic; a failure here must not stop the registrations.
        }
        return undefined
      }

      function request(method, body) {
        var target = ROUTE
        var sessionId = selectionSessionId()
        if (sessionId !== '') target += '?session=' + encodeURIComponent(sessionId)
        var options = {
          method: method,
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        }
        if (body !== undefined) {
          options.headers['content-type'] = 'application/json'
          options.body = JSON.stringify(body)
        }
        return fetch(target, options).then(
          function (response) {
            return response.json().then(
              function (payload) { return payload },
              function () { throw new Error('the server answered with ' + response.status) },
            )
          },
          function (error) {
            throw new Error('could not reach the plugin: ' + (error && error.message ? error.message : String(error)))
          },
        )
      }

      function useState() {
        return React.useState.apply(React, arguments)
      }

      /**
       * GET one of the plugin's read-only routes.
       *
       * The panel keeps its own error text: a browse failure must not replace
       * the root table with an error page.
       */
      function readRoute(path, params) {
        var query = []
        Object.keys(params || {}).forEach(function (key) {
          var value = params[key]
          if (value === undefined || value === null) return
          query.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
        })
        var url = new URL(String(path).replace(/^\/+/, ''), document.baseURI)
        url.search = query.join('&')
        return fetch(url.pathname + url.search, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        }).then(function (response) {
          return response.json().then(
            function (payload) { return payload },
            function () { throw new Error('the server answered with ' + response.status) },
          )
        })
      }

      function formatMode(mode) {
        return mode === 'readonly' ? '只读' : '可写'
      }

      function formatSize(bytes) {
        var value = typeof bytes === 'number' ? bytes : 0
        if (value < 1024) return value + ' B'
        if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
        return (value / (1024 * 1024)).toFixed(1) + ' MB'
      }

      // Which workspace the sidebar is showing right now.
      //
      // No client service reports the sidebar selection, but the shell persists
      // the open session under `dsh.sessions.current`, and the workspace
      // controller's snapshot carries each workspace's session ids. Reading
      // both gives the workspace of the session the user is looking at, without
      // depending on any private field of the shell.
      /**
       * The id of the session the shell is showing, as it persists it.
       *
       * The host resolves this id to a working directory, which is how the
       * dialog learns which workspace to preselect.
       */
      function selectionSessionId() {
        try {
          var raw = null
          try {
            raw = globalThis.localStorage ? globalThis.localStorage.getItem('dsh.sessions.current') : null
          } catch (error) {
            raw = null
          }
          if (typeof raw !== 'string' || raw === '') return ''
          var parsed
          try {
            parsed = JSON.parse(raw)
          } catch (error) {
            return ''
          }
          var sessionId = parsed && parsed.sessionId
          return typeof sessionId === 'string' ? sessionId : ''
        } catch (error) {
          return ''
        }
      }

      function selectionWorkspacePath(ctx) {
        try {
          var sessionId = selectionSessionId()
          if (sessionId === '') return ''
          var service
          try {
            service = ctx.get('workspaces')
          } catch (error) {
            service = undefined
          }
          var store = service === undefined ? undefined : service.list
          var snapshot = store !== undefined && typeof store.getSnapshot === 'function' ? store.getSnapshot() : undefined
          var items = snapshot !== undefined && Array.isArray(snapshot.items) ? snapshot.items : []
          for (var i = 0; i < items.length; i += 1) {
            var item = items[i]
            var ids = item === null || item === undefined ? undefined : item.sessionIds
            if (Array.isArray(ids) && ids.indexOf(sessionId) >= 0 && typeof item.path === 'string') return item.path
          }
        } catch (error) {
          /* any unexpected shape simply means "no preference" */
        }
        return ''
      }

      function pickWorkspace(state, preferred) {
        var workspaces = (state && state.workspaces) || []
        if (workspaces.length === 0) return undefined
        var wanted = preferred
        if ((wanted === undefined || wanted === '') && state && state.current && typeof state.current.path === 'string') {
          wanted = state.current.path
        }
        for (var i = 0; i < workspaces.length; i += 1) {
          if (workspaces[i].path === wanted) return workspaces[i]
        }
        return workspaces[0]
      }

      /**
       * The name a workspace is switched by: the registry title when the GUI has
       * one, otherwise the last path segment. The full path is always shown next
       * to the picker, so two workspaces sharing a name are still distinguishable.
       *
       * @param {{ path?: string, title?: string } | undefined} item
       * @returns {string}
       */
      function workspaceName(item) {
        var title = item === undefined || item === null ? undefined : item.title
        if (typeof title === 'string' && title.trim() !== '') return title.trim()
        var path = item === undefined || item === null || typeof item.path !== 'string' ? '' : item.path
        var parts = path.split(/[\\/]/).filter(function (part) { return part !== '' })
        return parts.length > 0 ? parts[parts.length - 1] : path
      }

      function keyActivate(disabled, run) {
        return function (event) {
          if (disabled) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            run()
          }
        }
      }

      function Manager(props) {
        var ctx = props.ctx
        var statePair = useState(null)
        var state = statePair[0]
        var setState = statePair[1]
        var errorPair = useState('')
        var error = errorPair[0]
        var setError = errorPair[1]
        var busyPair = useState(false)
        var busy = busyPair[0]
        var setBusy = busyPair[1]
        var workspacePair = useState('')
        var workspace = workspacePair[0]
        var setWorkspace = workspacePair[1]
        var browsePair = useState(null)
        var browse = browsePair[0]
        var setBrowse = browsePair[1]
        var previewPair = useState(null)
        var preview = previewPair[0]
        var setPreview = previewPair[1]
        var menuPair = useState(null)
        var menuFor = menuPair[0]
        var setMenuFor = menuPair[1]
        var editPair = useState(null)
        var edit = editPair[0]
        var setEdit = editPair[1]

        // A row menu closes on Escape or on any press outside a row. Rows carry
        // their own toggle, so a press inside the list never auto-closes twice.
        React.useEffect(function () {
          if (menuFor === null) return undefined
          function onDown(event) {
            var target = event && event.target
            if (target && typeof target.closest === 'function' && target.closest('.mr-item') !== null) return
            setMenuFor(null)
          }
          function onKey(event) {
            if (event && event.key === 'Escape') setMenuFor(null)
          }
          document.addEventListener('mousedown', onDown)
          document.addEventListener('keydown', onKey)
          return function () {
            document.removeEventListener('mousedown', onDown)
            document.removeEventListener('keydown', onKey)
          }
        }, [menuFor])

        function loadDirectory(alias, path) {
          return readRoute('/dsh-multi-root/browse', { workspace: focusPath, alias: alias, path: path }).then(
            function (payload) {
              if (!payload || payload.ok === false) {
                setError(String((payload && payload.error) || 'could not list that directory'))
                return
              }
              setPreview(null)
              setBrowse({
                alias: alias,
                root: payload.root,
                path: payload.relative || '',
                entries: payload.entries || [],
                truncated: payload.truncated === true,
              })
            },
            function (failure) { setError(failure.message) },
          )
        }

        function openFile(alias, path) {
          return readRoute('/dsh-multi-root/file', { workspace: focusPath, alias: alias, path: path }).then(
            function (payload) {
              if (!payload || payload.ok === false) {
                setError(String((payload && payload.error) || 'could not read that file'))
                return
              }
              setPreview({
                name: payload.relative || path,
                text: typeof payload.text === 'string' ? payload.text : '',
                binary: payload.binary === true,
                truncated: payload.truncated === true,
                bytes: payload.bytes || 0,
              })
            },
            function (failure) { setError(failure.message) },
          )
        }

        function goUp() {
          if (browse === null) return
          var parts = browse.path === '' ? [] : browse.path.split('/')
          parts.pop()
          return loadDirectory(browse.alias, parts.join('/'))
        }

        function load() {
          return request('GET').then(
            function (payload) {
              setState(payload)
              setError(payload && payload.ok === false ? String(payload.error || '') : '')
            },
            function (failure) { setError(failure.message) },
          )
        }

        React.useEffect(function () {
          var alive = true
          request('GET').then(
            function (payload) {
              if (!alive) return
              setState(payload)
            },
            function (failure) {
              if (!alive) return
              setError(failure.message)
            },
          )
          return function () { alive = false }
        }, [])

        function send(body) {
          setBusy(true)
          return request('POST', body).then(
            function (payload) {
              setBusy(false)
              if (payload && payload.ok === false) {
                setError(String(payload.error || 'the change was refused'))
                return payload
              }
              setError('')
              if (payload && payload.workspaces) setState(payload)
              return payload
            },
            function (failure) {
              setBusy(false)
              setError(failure.message)
              return undefined
            },
          )
        }

        var focus = pickWorkspace(state, workspace !== '' ? workspace : selectionWorkspacePath(ctx))
        var focusPath = focus ? focus.path : ''
        var roots = (focus && focus.roots) || []
        var searchEnabled = !focus || focus.searchEnabled !== false
        var maxRoots = state && state.config ? state.config.maxRoots : 16
        var full = roots.length >= maxRoots

        function onPick() {
          var uiWorkspace
          try {
            uiWorkspace = ctx.get('uiWorkspace')
          } catch (failure) {
            uiWorkspace = undefined
          }
          if (uiWorkspace === undefined || typeof uiWorkspace.pickDirectory !== 'function') {
            setError('this build has no directory picker; add the path with the workspace_roots tool instead')
            return
          }
          setBusy(true)
          Promise.resolve(uiWorkspace.pickDirectory()).then(
            function (picked) {
              var path = typeof picked === 'string' ? picked : (picked && picked.path) || ''
              if (path === '') {
                setBusy(false)
                return
              }
              return send({ action: 'attach', workspace: focusPath, path: path })
            },
            function () { setBusy(false) },
          ).then(
            function (result) { if (result === undefined) setBusy(false) },
            function () { setBusy(false) },
          )
        }

        function onDetach(root) {
          return send({ action: 'detach', workspace: focusPath, id: root.id })
        }

        function onMode(root) {
          var mode = root.mode === 'readonly' ? 'readwrite' : 'readonly'
          return send({ action: 'mode', workspace: focusPath, id: root.id, mode: mode })
        }

        function onSkills(root) {
          return send({ action: 'skills', workspace: focusPath, id: root.id, skillsEnabled: root.skillsEnabled !== true })
        }

        function onMove(root, position) {
          return send({ action: 'move', workspace: focusPath, id: root.id, position: position })
        }

        function onReveal(root) {
          return send({ action: 'reveal', workspace: focusPath, id: root.id })
        }

        // Inline editors instead of `window.prompt`: the desktop renderer does
        // not support modal prompts, so a prompt-based edit silently did nothing.
        function startEdit(root, field) {
          var current
          if (field === 'alias') current = root.alias
          else if (field === 'namespace') current = root.aliasId || root.alias
          else current = root[field] || ''
          setMenuFor(null)
          setError('')
          setEdit({ id: root.id, field: field, label: root.alias, value: String(current), error: '' })
        }

        function submitEdit() {
          if (edit === null) return undefined
          var value = String(edit.value).trim()
          if (value === '' && edit.field !== 'build' && edit.field !== 'test') {
            setEdit({ id: edit.id, field: edit.field, label: edit.label, value: edit.value, error: '不能为空' })
            return undefined
          }
          var body = { workspace: focusPath, id: edit.id }
          if (edit.field === 'build' || edit.field === 'test') {
            body.action = 'build'
            body[edit.field] = value
          } else {
            body.action = edit.field === 'alias' ? 'alias' : 'namespace'
            if (edit.field === 'alias') body.alias = value
            else body.aliasId = value
          }
          return send(body).then(function (payload) {
            if (payload && payload.ok !== false) setEdit(null)
            else setEdit({ id: edit.id, field: edit.field, label: edit.label, value: edit.value, error: String((payload && payload.error) || '保存失败') })
          })
        }

        function onCopyPath(root) {
          var text = String(root.path)
          var clipboard = typeof navigator === 'object' && navigator !== null ? navigator.clipboard : undefined
          if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
            setError('this build has no clipboard access; the path is shown in the row')
            return undefined
          }
          setError('')
          return Promise.resolve(clipboard.writeText(text)).catch(function () {
            setError('could not copy the path to the clipboard')
          })
        }

        var children = [
          h('div', { className: 'mr-head', key: 'head' },
            h('h2', { className: 'mr-title' }, props.title || '多仓库工作区'),
            h('p', { className: 'mr-sub' },
              '给一个工作区挂载额外的仓库目录。挂上的目录会写进模型的系统提示词，模型用绝对路径读写；'
              + '工作区目录（当前会话的 cwd）本身不变。'),
          ),
        ]

        if (state === null) {
          children.push(h('p', { className: 'mr-note', key: 'loading' }, '正在读取根表…'))
        } else {
          var workspaceOptions = ((state && state.workspaces) || []).map(function (item) {
            return h('option', { key: item.key, value: item.path, title: item.path }, workspaceName(item))
          })
          children.push(h('div', { className: 'mr-ws', key: 'ws' },
            h('span', { className: 'mr-note' }, '工作区'),
            h('select', {
              className: 'mr-select',
              value: focusPath,
              'aria-label': '切换工作区',
              onChange: function (event) { setWorkspace(event.target.value) },
            }, workspaceOptions.length > 0 ? workspaceOptions : h('option', { value: '' }, '（尚未记录任何工作区）')),
            h('label', {
              className: 'mr-check',
              key: 'search',
              title: '是否允许模型在这个工作区里跨仓库搜索文件内容（workspace_grep）',
            },
              h('input', {
                type: 'checkbox',
                checked: searchEnabled,
                onChange: function (event) {
                  return send({ action: 'search', workspace: focusPath, enabled: event.target.checked })
                },
              }),
              h('span', null, '内容搜索'),
            ),
          ))
          children.push(h('div', { className: 'mr-ws-path', key: 'ws-path', title: focusPath },
            focusPath === '' ? '（未选择工作区）' : focusPath))

          var items = []
          if (roots.length === 0) {
            items.push(h('div', { className: 'mr-empty', key: 'empty' },
              '这个工作区还没有挂载任何额外仓库。点「添加仓库目录」，或让模型调用 workspace_roots。'))
          } else {
            roots.forEach(function (root, index) {
              var git = root.git
              var menuOpen = menuFor !== null && menuFor.id === root.id
              items.push(h('div', { className: 'mr-item', key: root.id },
                h('div', { className: 'mr-main' },
                  h('div', { className: 'mr-line' },
                    h('span', { className: 'mr-alias', title: 'id ' + root.id + (root.aliasId ? ' · 技能命名空间 ' + root.aliasId : '') }, root.alias),
                    h('span', { className: 'mr-badge', 'data-mode': root.mode }, formatMode(root.mode)),
                    h('span', { className: 'mr-badge', 'data-mode': root.skillsEnabled === true ? 'readwrite' : 'readonly' },
                      root.skillsEnabled === true ? 'skills' : 'no skills'),
                    root.git === null || root.git === undefined
                      ? null
                      : h('span', { className: 'mr-git' },
                        (root.git.branch || '（无分支）') + (root.git.dirty ? ' *' : '')),
                  ),
                  h('span', { className: 'mr-path', title: root.path }, root.path),
                  root.build === undefined && root.test === undefined
                    ? null
                    : h('span', {
                      className: 'mr-command',
                      title: (root.build !== undefined ? 'build: ' + root.build : '')
                        + (root.test !== undefined ? '\ntest: ' + root.test : ''),
                    },
                    (root.build !== undefined ? 'build: ' + root.build : '')
                      + (root.build !== undefined && root.test !== undefined ? '  ·  ' : '')
                      + (root.test !== undefined ? 'test: ' + root.test : '')),
                ),
                h('div', { className: 'mr-actions' },
                  h('button', {
                    className: 'mr-btn',
                    type: 'button',
                    disabled: busy,
                    title: '只读地浏览这个仓库的目录与文件',
                    onClick: function () { loadDirectory(root.alias, '') },
                  }, '浏览'),
                  h('button', {
                    className: 'mr-btn',
                    type: 'button',
                    disabled: busy,
                    title: '在可写 / 只读之间切换（只影响提示词，不改变沙箱权限）',
                    onClick: function () { onMode(root) },
                  }, root.mode === 'readonly' ? '设为可写' : '设为只读'),
                  h('button', {
                    className: 'mr-icon-btn',
                    type: 'button',
                    title: '更多操作',
                    'aria-haspopup': 'menu',
                    'aria-expanded': menuOpen ? 'true' : 'false',
                    onClick: function (event) {
                      if (menuOpen) {
                        setMenuFor(null)
                        return
                      }
                      var rect = event && event.currentTarget ? event.currentTarget.getBoundingClientRect() : null
                      var viewport = typeof window === 'object' && window !== null ? window.innerHeight : 0
                      var below = rect === null ? 320 : viewport - rect.bottom
                      setMenuFor({
                        id: root.id,
                        up: below < 340,
                        right: rect === null ? 16 : Math.max(8, Math.round((window.innerWidth || 0) - rect.right)),
                        top: rect === null ? 0 : Math.round(rect.bottom + 6),
                        bottom: rect === null ? 16 : Math.round((window.innerHeight || 0) - rect.top + 6),
                      })
                    },
                  }, '⋯'),
                ),
                menuOpen ? h('div', {
                  className: 'mr-menu',
                  role: 'menu',
                  style: {
                    right: menuFor.right + 'px',
                    top: menuFor.up ? 'auto' : menuFor.top + 'px',
                    bottom: menuFor.up ? menuFor.bottom + 'px' : 'auto',
                  },
                },
                  h('div', { className: 'mr-menu-item', role: 'menuitem', tabIndex: busy ? -1 : 0, 'aria-disabled': busy ? 'true' : 'false', onClick: function () { if (!busy) { setMenuFor(null); startEdit(root, 'alias') } }, onKeyDown: keyActivate(busy, function () { setMenuFor(null); startEdit(root, 'alias') }) }, '重命名'),
                  h('div', { className: 'mr-menu-item', role: 'menuitem', tabIndex: busy ? -1 : 0, 'aria-disabled': busy ? 'true' : 'false', onClick: function () { if (!busy) { setMenuFor(null); startEdit(root, 'namespace') } }, onKeyDown: keyActivate(busy, function () { setMenuFor(null); startEdit(root, 'namespace') }) }, 'Skill Namespace'),
                  h('div', { className: 'mr-menu-item', role: 'menuitem', tabIndex: busy ? -1 : 0, 'aria-disabled': busy ? 'true' : 'false', onClick: function () { if (!busy) { setMenuFor(null); startEdit(root, 'build') } }, onKeyDown: keyActivate(busy, function () { setMenuFor(null); startEdit(root, 'build') }) }, '构建命令'),
                  h('div', { className: 'mr-menu-item', role: 'menuitem', tabIndex: busy ? -1 : 0, 'aria-disabled': busy ? 'true' : 'false', onClick: function () { if (!busy) { setMenuFor(null); startEdit(root, 'test') } }, onKeyDown: keyActivate(busy, function () { setMenuFor(null); startEdit(root, 'test') }) }, '测试命令'),
                  h('div', { className: 'mr-menu-item', role: 'menuitem', tabIndex: busy ? -1 : 0, 'aria-disabled': busy ? 'true' : 'false', onClick: function () { if (!busy) { setMenuFor(null); onCopyPath(root) } }, onKeyDown: keyActivate(busy, function () { setMenuFor(null); onCopyPath(root) }) }, '复制路径'),
                  h('div', { className: 'mr-menu-item', role: 'menuitem', tabIndex: busy ? -1 : 0, 'aria-disabled': busy ? 'true' : 'false', onClick: function () { if (!busy) { setMenuFor(null); onSkills(root) } }, onKeyDown: keyActivate(busy, function () { setMenuFor(null); onSkills(root) }) }, root.skillsEnabled === true ? '停用技能' : '启用技能'),
                  h('div', { className: 'mr-menu-item', role: 'menuitem', tabIndex: busy ? -1 : 0, 'aria-disabled': busy ? 'true' : 'false', onClick: function () { if (!busy) { setMenuFor(null); onReveal(root) } }, onKeyDown: keyActivate(busy, function () { setMenuFor(null); onReveal(root) }) }, '在文件管理器中打开'),
                  h('div', { className: 'mr-menu-sep' }),
                  h('div', { className: 'mr-menu-item', role: 'menuitem', tabIndex: busy || index === 0 ? -1 : 0, 'aria-disabled': busy || index === 0 ? 'true' : 'false', onClick: function () { if (!busy && index !== 0) { setMenuFor(null); onMove(root, 'up') } }, onKeyDown: keyActivate(busy || index === 0, function () { setMenuFor(null); onMove(root, 'up') }) }, '上移'),
                  h('div', { className: 'mr-menu-item', role: 'menuitem', tabIndex: busy || index === roots.length - 1 ? -1 : 0, 'aria-disabled': busy || index === roots.length - 1 ? 'true' : 'false', onClick: function () { if (!busy && index !== roots.length - 1) { setMenuFor(null); onMove(root, 'down') } }, onKeyDown: keyActivate(busy || index === roots.length - 1, function () { setMenuFor(null); onMove(root, 'down') }) }, '下移'),
                  h('div', { className: 'mr-menu-sep' }),
                  h('div', { className: 'mr-menu-item mr-danger', role: 'menuitem', tabIndex: busy ? -1 : 0, 'aria-disabled': busy ? 'true' : 'false', onClick: function () { if (!busy) { setMenuFor(null); onDetach(root) } }, onKeyDown: keyActivate(busy, function () { setMenuFor(null); onDetach(root) }) }, '移除'),
                ) : null,
              ))
            })
          }
          children.push(h('div', { className: 'mr-list', key: 'list' }, items))

          if (edit !== null) {
            var sheetSkin = {
              border: '1px solid rgba(128,128,128,.28)',
              borderRadius: '12px',
              background: 'var(--dsw-alias-bg-layer-1, #1b1b1b)',
              boxShadow: '0 24px 64px rgba(0,0,0,.55)',
            }
            var fieldSkin = {
              display: 'block',
              boxSizing: 'border-box',
              width: '100%',
              height: '36px',
              padding: '0 12px',
              borderRadius: '8px',
              border: '1px solid rgba(128,128,128,.34)',
              background: 'rgba(0,0,0,.24)',
              color: 'var(--dsw-alias-label-primary, #f2f2f2)',
              fontFamily: 'inherit',
              fontSize: '13.5px',
              lineHeight: '34px',
              outline: 'none',
              appearance: 'none',
            }
            children.push(h('div', {
              className: 'mr-overlay mr-overlay--nested',
              key: 'edit',
              onMouseDown: function (event) { if (event.target === event.currentTarget) setEdit(null) },
            },
              h('div', { className: 'mr-sheet', role: 'dialog', 'aria-modal': 'true', style: sheetSkin },
                h('div', { className: 'mr-sheet-title' },
                  edit.field === 'alias' ? '重命名 ' + edit.label
                    : edit.field === 'namespace' ? 'Skill Namespace：' + edit.label
                      : (edit.field === 'build' ? '构建命令：' : '测试命令：') + edit.label),
                h('input', {
                  className: 'mr-input',
                  style: fieldSkin,
                  value: edit.value,
                  autoFocus: true,
                  spellCheck: false,
                  onChange: function (event) {
                    setEdit({ id: edit.id, field: edit.field, label: edit.label, value: event.target.value, error: '' })
                  },
                  onKeyDown: function (event) {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      submitEdit()
                    } else if (event.key === 'Escape') {
                      setEdit(null)
                    }
                  },
                  onFocus: function (event) {
                    event.target.style.borderColor = 'var(--mr-btn-border-hover, #4a4a4a)'
                    event.target.style.boxShadow = '0 0 0 2px rgba(255,255,255,.10)'
                  },
                  onBlur: function (event) {
                    event.target.style.borderColor = ''
                    event.target.style.boxShadow = ''
                  },
                }),
                h('div', { className: 'mr-sheet-hint' },
                  edit.field === 'alias'
                    ? '显示名，可以含大写字母和空格。技能命名空间不会跟着变。'
                    : edit.field === 'namespace'
                      ? '技能名的前缀，只能用小写字母、数字、点、下划线和短横线。'
                      : '自动检测出来的命令会显示成默认值。清空这一格即回到自动检测。'),
                edit.error === '' ? null : h('div', { className: 'mr-edit-error' }, edit.error),
                h('div', { className: 'mr-sheet-actions' },
                  h('button', {
                    key: 'cancel',
                    type: 'button',
                    className: 'mr-btn',
                    onClick: function () { setEdit(null) },
                  }, '取消'),
                  h('button', {
                    key: 'save',
                    type: 'button',
                    className: 'mr-btn mr-primary',
                    disabled: busy,
                    onClick: submitEdit,
                  }, '保存'),
                ),
              ),
            ))
          }

          if (browse !== null) {
            var entryNodes = (browse.entries || []).map(function (entry) {
              var childPath = browse.path === '' ? entry.name : browse.path + '/' + entry.name
              return h('button', {
                className: 'mr-entry',
                key: entry.name,
                type: 'button',
                'data-kind': entry.kind,
                title: childPath,
                onClick: function () {
                  if (entry.kind === 'dir') loadDirectory(browse.alias, childPath)
                  else openFile(browse.alias, childPath)
                },
              },
                h('span', { className: 'mr-entry-name' }, entry.kind === 'dir' ? entry.name + '/' : entry.name),
                entry.kind === 'file'
                  ? h('span', { className: 'mr-entry-size' }, formatSize(entry.size))
                  : null,
              )
            })
            if (entryNodes.length === 0) {
              entryNodes.push(h('p', { className: 'mr-note', key: 'browse-empty' }, '这个目录是空的。'))
            }
            var browserChildren = [
              h('div', { className: 'mr-crumb', key: 'crumb' },
                h('button', {
                  className: 'mr-btn',
                  type: 'button',
                  disabled: browse.path === '',
                  title: '上一级',
                  onClick: goUp,
                }, '↑'),
                h('span', { className: 'mr-crumb-path' }, browse.alias + ' / ' + (browse.path === '' ? '.' : browse.path)),
                h('button', {
                  className: 'mr-btn',
                  type: 'button',
                  onClick: function () { setBrowse(null); setPreview(null) },
                }, '关闭'),
              ),
              h('div', { className: 'mr-entries', key: 'entries' }, entryNodes),
            ]
            if (browse.truncated === true) {
              browserChildren.push(h('p', { className: 'mr-note', key: 'browse-more' }, '目录条目过多，只显示了前 500 项。'))
            }
            if (preview !== null) {
              var previewNote = preview.binary === true
                ? '（二进制文件，未预览；' + formatSize(preview.bytes) + '）'
                : (preview.truncated === true ? preview.text + '\n\n… 文件较大，只预览了前 256 KB。' : preview.text)
              browserChildren.push(h('pre', { className: 'mr-preview', key: 'preview' },
                preview.name + '\n' + '─'.repeat(24) + '\n' + previewNote))
            }
            children.push(h('div', { className: 'mr-browse', key: 'browse' }, browserChildren))
          }

          children.push(h('div', { className: 'mr-row', key: 'actions' },
            h('button', {
              className: 'mr-btn',
              type: 'button',
              disabled: busy || focusPath === '' || full,
              title: full ? '已达到上限 ' + maxRoots : '选择一个目录并挂到当前工作区',
              onClick: onPick,
            }, '添加仓库目录'),
            h('button', {
              className: 'mr-btn',
              type: 'button',
              disabled: busy,
              onClick: function () { load() },
            }, '刷新'),
            h('span', { className: 'mr-note' }, roots.length + ' / ' + maxRoots),
          ))
        }

        if (error !== '') children.push(h('p', { className: 'mr-error', key: 'error' }, error))

        if (props.footer === true) {
          children.push(h('p', { className: 'mr-note', key: 'footer' },
            '面板里的改动会立即写进根表并进入下一次提示词装配；会话已经发出去的那一轮不受影响。'))
        }

        return h('div', { className: 'mr-wrap' }, children)
      }

      function SettingsSection(props) {
        var statePair = useState(null)
        var state = statePair[0]
        var setState = statePair[1]

        React.useEffect(function () {
          var alive = true
          request('GET').then(
            function (payload) { if (alive) setState(payload) },
            function () { /* the manager below shows the error */ },
          )
          return function () { alive = false }
        }, [])

        var config = (state && state.config) || {}
        var rows = [
          ['插件状态', config.enabled === false ? '已关闭（插件不注册工具、不注入提示词）' : '已启用'],
          ['每个工作区的上限', config.maxRoots === undefined ? '16' : String(config.maxRoots)],
          ['注入提示词', config.injectPrompt === false ? '否' : '是'],
          ['提示词预算', (config.promptMaxChars === undefined ? 4000 : config.promptMaxChars) + ' 字符'],
          ['显示 git 状态', config.showGit === false ? '否' : '是'],
        ]
        var cells = rows.map(function (row) {
          return h('tr', { key: row[0] },
            h('td', null, row[0]),
            h('td', null, row[1]),
          )
        })

        return h('div', { className: 'mr-wrap' },
          h(Manager, { ctx: props.ctx, title: '多仓库工作区', footer: true }),
          h('div', { className: 'mr-head' },
            h('h2', { className: 'mr-title' }, '配置'),
            h('p', { className: 'mr-sub' },
              '这些开关写在 profile 的 cordis.patch.yml 里（设置 → 打开配置文件），改完即生效，不需要重启。'),
          ),
          h('table', { className: 'mr-table' }, h('tbody', null, cells)),
          state && state.store
            ? h('p', { className: 'mr-note' },
              '根表文件：', h('span', { className: 'mr-code' }, String(state.store)))
            : null,
          h('p', { className: 'mr-note' },
            '卸载或停用：设置 → 内置插件 → multi-root 关闭；或从 profile 的 dsh.profile.bundles 删掉 dsh-multi-root 一行。'
            + '两种做法都只停用本插件，不影响 DSH 的其它功能。'),
        )
      }

      function PanelIcon(props) {
        var size = typeof props.size === 'number' ? props.size : 18
        // Three stacked layers: "several repositories on top of one workspace".
        // Stroked paths keep it legible at 16px and inherit the button colour.
        return h('svg', {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', flex: 'none' },
        },
          h('path', { d: 'M12 3.2 3.6 7.1 12 11l8.4-3.9L12 3.2Z' }),
          h('path', { d: 'm3.6 12 8.4 3.9 8.4-3.9' }),
          h('path', { d: 'm3.6 16.6 8.4 3.9 8.4-3.9' }),
        )
      }

      /**
       * Dialog buttons reuse the same `.mr-btn` rules as the list rows, so
       * hover feedback (subtle layer-2 fill plus a stronger border) matches the
       * rest of the panel and the host's own ghost buttons.
       */

      /**
       * The bottom-left entry in the sidebar: an icon in the 56px rail, an
       * icon plus a label when the sidebar is wide. It opens the dialog.
       */
      function FooterButton(props) {
        var wide = !!(props && props.wide)
        return h('button', {
          type: 'button',
          className: 'mr-footer-btn',
          'data-rail': wide ? 'false' : 'true',
          title: '多仓库工作区',
          onClick: function () { setDialogOpen(true) },
        },
          h(PanelIcon, { size: wide ? 16 : 18 }),
          wide ? h('span', { className: 'mr-footer-label' }, '多仓库工作区') : null,
        )
      }

      /**
       * The dialog itself, rendered in the frame-wide overlay slot.
       *
       * `shell.overlay` is click-through by design, so the backdrop opts back
       * into pointer events and closes on a click outside the card; Escape does
       * the same. Nothing is rendered while closed, so a closed dialog costs no
       * DOM at all.
       */
      function Dialog(props) {
        var open = useDialogOpen()

        React.useEffect(function () {
          if (!open) return undefined
          function onKey(event) {
            if (event && event.key === 'Escape') setDialogOpen(false)
          }
          document.addEventListener('keydown', onKey)
          return function () { document.removeEventListener('keydown', onKey) }
        }, [open])

        if (!open) return null
        return h('div', {
          className: 'mr-overlay',
          role: 'presentation',
          onMouseDown: function (event) {
            if (event.target === event.currentTarget) setDialogOpen(false)
          },
        },
          h('div', {
            className: 'mr-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': '多仓库工作区',
          },
            h('div', { className: 'mr-dialog-bar' },
              h(PanelIcon, { size: 18 }),
              h('h2', { className: 'mr-title' }, '多仓库工作区'),
              h('button', {
                className: 'mr-close',
                type: 'button',
                title: '关闭（Esc）',
                onClick: function () { setDialogOpen(false) },
              }, '关闭'),
            ),
            h('div', { className: 'mr-dialog-body' }, h(Manager, { ctx: props.ctx })),
          ),
        )
      }

      /**
       * Register everything, one guard at a time: a slot we cannot reach is a
       * missing panel, never a broken page.
       *
       * @param {any} ctx - the restricted client context.
       */
      function apply(ctx) {
        var disposeStyles
        try {
          disposeStyles = insertStyles(ctx)
        } catch (error) {
          disposeStyles = undefined
        }
        if (typeof disposeStyles === 'function' && typeof ctx.effect === 'function') {
          try {
            ctx.effect(disposeStyles)
          } catch (error) {
            // Styles are cosmetic; nothing here is worth failing over.
          }
        }

        var slots
        try {
          slots = ctx.get('slots')
        } catch (error) {
          slots = undefined
        }
        if (slots === undefined || slots === null) return

        function register(slotName, id, order, label, Component, key) {
          try {
            slots.inject(slotName, function () {
              var definition = { name: slotName, id: id, order: order, label: label }
              if (key !== undefined) {
                definition.key = key
                delete definition.id
                delete definition.order
              }
              return slots.register(definition, Component)
            })
          } catch (error) {
            try {
              console.error('[dsh-multi-root] could not register ' + slotName, error)
            } catch (ignored) {
              // Nothing left to do.
            }
          }
        }

        // Settings keeps its own section; the sidebar keeps one bottom-left
        // entry. Deliberately no `sidebar.panellist` (a new top-level icon) and
        // no `main` page: the original plugin opens a dialog instead, and the
        // dialog is also where the plugin's own settings live.
        register('settings.section', SETTINGS_ID, 60, function () { return '多仓库工作区' }, function () {
          return h(SettingsSection, { ctx: ctx })
        })
        register('settings.section.icon', SETTINGS_ID + '-icon', 60, function () { return '多仓库工作区' }, function (props) {
          var size = props && typeof props.size === 'number' ? props.size : 16
          return h(PanelIcon, { size: size })
        })
        register('sidebar.footer.action', FOOTER_ID, 40, function () { return '多仓库工作区' }, function (props) {
          return h(FooterButton, props)
        })
        register('shell.overlay', OVERLAY_ID, 40, function () { return '多仓库工作区' }, function () {
          return h(Dialog, { ctx: ctx })
        })
      }

      exports.apply = apply
      exports.inject = inject
      return module.exports
    },
  })
})()
