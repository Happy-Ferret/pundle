/* @flow */

import Path from 'path'
import pundleBrowser from 'pundle-browser'
import { createResolver } from 'pundle-api'
import { MODULE_SEPARATOR_REGEX, getManifest, isModuleRequested, isModuleOnly, promisedResolve } from './helpers'

// Spec:
// Browser field first
// Config aliases later
function resolveAlias(request: string, alias: Object, manifest: Object, packageMains: Array<string>): string {
  let chunks
  const isDirectory = request.slice(-1) === '/'

  if (isModuleRequested(request)) {
    chunks = request.split(MODULE_SEPARATOR_REGEX)
  } else {
    chunks = [request]
  }
  let moduleName = chunks[0]

  for (const packageMain of packageMains) {
    const value = typeof manifest[packageMain] === 'object' ? manifest[packageMain][moduleName] : undefined
    if (typeof value === 'boolean' && value === false) {
      if (isModuleOnly(request)) {
        chunks.length = 1
        moduleName = pundleBrowser.empty
        break
      }
    } else if (typeof value === 'string') {
      moduleName = value
      break
    }
    const manifestInfo = manifest[packageMain]
    // Ignore string type packageMains because this is outgoing resolution
    if (manifestInfo && typeof manifestInfo === 'object') {
      if (manifestInfo[moduleName]) {
        moduleName = manifestInfo[moduleName]
        break
      }
    }
  }

  const aliasValue = alias[moduleName]
  if (typeof aliasValue === 'boolean' && aliasValue === false) {
    chunks.length = 1
    moduleName = pundleBrowser.empty
  } else if (typeof aliasValue === 'string') {
    moduleName = aliasValue
  }
  chunks[0] = moduleName

  let resolved = chunks.join('/')
  if (isDirectory) {
    resolved += '/'
  }
  return resolved
}

// Spec:
//
// Before resolution:
// If module is core, return it's path from pundle-browser
// If module is whole, resolve it with source browser field
// If module is whole, resolve it with config aliases
//
// During resolution:
// Use string browser field for moduly only requests (aka not deep)
//
// After resolution:
// If module was whole, resolve it with target browser field
// If module was relative, resolve it with source browser field

// eslint-disable-next-line no-unused-vars
export default createResolver(async function(config: Object, givenRequest: string, fromFile: ?string, cached: boolean) {
  let request = givenRequest
  let fromDirectory = ''
  const manifest = { rootDirectory: this.config.rootDirectory }
  const targetManifest = {}

  if (fromFile) {
    fromDirectory = Path.dirname(fromFile)
    Object.assign(manifest, await getManifest(fromDirectory, config, cached, this.config))
  }

  if (isModuleRequested(request)) {
    request = resolveAlias(request, config.alias, manifest, config.packageMains)
  }

  // NOTE: Empty is our special property in pundle-browser
  if (isModuleOnly(request) && request !== 'empty' && pundleBrowser[request]) {
    return pundleBrowser[request]
  }
  let resolved = await promisedResolve(request, {
    basedir: fromDirectory || this.config.rootDirectory,
    extensions: (config.extensions || config.knownExtensions).map(i => `.${i}`),
    readFile: (path, callback) => {
      this.config.fileSystem.readFile(path).then(function(result) {
        callback(null, result)
      }, function(error) {
        callback(error, null)
      })
    },
    isFile: (path, callback) => {
      this.config.fileSystem.stat(path).then(function(stats) {
        callback(null, stats.isFile())
      }, function() {
        callback(null, false)
      })
    },
    packageFilter(packageManifest, manifestPath) {
      Object.assign(targetManifest, packageManifest, {
        rootDirectory: Path.dirname(manifestPath),
      })
      if (isModuleOnly(request)) {
        for (const packageMain of config.packageMains) {
          const value = packageManifest[packageMain]
          if (value && typeof value === 'string') {
            packageManifest.main = value
            break
          }
        }
      }
      return packageManifest
    },
    moduleDirectory: config.moduleDirectory,
  })
  if (!resolved) {
    return resolved
  }

  const manifestToUse = isModuleRequested(request) ? targetManifest : manifest
  const relative = Path.relative(manifestToUse.rootDirectory, resolved)
  if (relative.substr(0, 3) !== '../' && relative.substr(0, 3) !== '..\\') {
    resolved = resolveAlias(`./${relative}`, {}, manifestToUse, config.packageMains)
    resolved = Path.resolve(manifestToUse.rootDirectory, resolved)
  }

  return resolved
}, {
  alias: {},
  extensions: null,
  // ^ Set to any non-null value to override "knownExtensions"
  // NOTE: Extensions should not have leading dot
  packageMains: ['browser', 'browserify', 'webpack', 'main'],
  modulesDirectories: ['node_modules'],
})