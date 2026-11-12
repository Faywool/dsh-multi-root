/**
 * Client-bundle hot reload for local development.
 *
 * The host fingerprints a client bundle by `mtime`, `ctime` and `size` and
 * bakes that revision into the URL it advertises (`/plugins/??…&rev=<hash>`).
 * Those URLs are served with `cache-control: public, max-age=31536000,
 * immutable`, so a browser refreshes them for a year. Editing the file on disk
 * does not move the revision on its own: the host only re-stats a package when
 * its Loader row restarts, or when something calls
 * `ctx.clientModules.rebuilt(id)`.
 *
 * That second path is what this module uses. It watches our own bundle and
 * asks the host to publish a new generation, which mints a new revision, mints
 * a new URL, and lets the open page pick the new code up without a restart.
 * Everything here is optional: no client bundle, no watch, or a failed watch
 * only means "reload by hand".
 */

import { watch } from 'node:fs'

import { describeError, noteDiagnostic, report } from './util.js'

/**
 * Absolute path of the client bundle the host serves for `id`.
 *
 * @param {unknown} clientModules the `clientModules` service, possibly absent.
 * @param {string} id package name this plugin is registered under.
 * @returns {string | undefined} the path, or undefined when there is none.
 */
export function clientBundlePath(clientModules, id) {
  try {
    const path = clientModules?.clientPath?.(id)
    return typeof path === 'string' && path !== '' ? path : undefined
  } catch {
    return undefined
  }
}

/**
 * Watch this plugin's client bundle and republish it after every write.
 *
 * The watcher is deliberately best-effort: it is non-persistent, debounced,
 * closed by the caller's effect, and every failure is reported once and then
 * ignored. A missing `clientModules` service, a package without a client half,
 * or a filesystem that refuses the watch all degrade to "no hot reload".
 *
 * @param {object} options
 * @param {object} options.ctx owning Cordis context, used for its effect scope.
 * @param {string} options.id package name this plugin is registered under.
 * @param {unknown} options.clientModules the `clientModules` service.
 * @param {{ info?: Function, warn?: Function, error?: Function }} [options.logger]
 * @param {number} [options.debounceMs] quiet period before republishing.
 * @returns {boolean} whether a watcher was installed.
 */
export function startDevReload({ ctx, id, clientModules, logger, debounceMs = 120 }) {
  const path = clientBundlePath(clientModules, id)
  if (path === undefined) {
        noteDiagnostic('client hot reload is off: this build serves no client bundle')
    report(logger, 'info', 'client hot reload is off: this build serves no client bundle')
    return false
  }
  if (typeof clientModules?.rebuilt !== 'function') {
    report(logger, 'info', 'client hot reload is off: the host cannot republish client bundles')
    return false
  }
  let timer
  let closed = false
  const republish = () => {
    if (closed) return
    try {
      const rev = clientModules.rebuilt(id)
      noteDiagnostic(`client bundle changed; published revision ${rev ?? '(none)'}`)
      report(logger, 'info', `client bundle changed; published revision ${rev ?? '(none)'}`)
    } catch (error) {
      noteDiagnostic(`client bundle could not be republished: ${describeError(error)}`)
      report(logger, 'warn', `client bundle could not be republished: ${describeError(error)}`)
    }
  }
  let watcher
  try {
    watcher = watch(path, { persistent: false }, () => {
      if (closed) return
      clearTimeout(timer)
      timer = setTimeout(republish, debounceMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    watcher.on('error', (error) => {
      report(logger, 'warn', `client hot reload stopped: ${describeError(error)}`)
    })
  } catch (error) {
    report(logger, 'warn', `client hot reload cannot watch ${path}: ${describeError(error)}`)
    return false
  }
  try {
    ctx.effect(() => () => {
      closed = true
      clearTimeout(timer)
      watcher.close()
    })
  } catch (error) {
    closed = true
    clearTimeout(timer)
    try {
      watcher.close()
    } catch {}
    report(logger, 'warn', `client hot reload could not be scoped: ${describeError(error)}`)
    return false
  }
  noteDiagnostic(`client hot reload is watching ${path}`)
  report(logger, 'info', `client hot reload is watching ${path}`)
  return true
}
