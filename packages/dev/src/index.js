/* @flow */

import FS from 'sb-fs'
import Path from 'path'
import unique from 'lodash.uniq'
import express from 'express'
import promiseDefer from 'promise.defer'
import { CompositeDisposable } from 'sb-event-kit'
import { getRelativeFilePath, createWatcher, MessageIssue } from 'pundle-api'
import type Pundle from 'pundle'
import type { File, Context } from 'pundle-api'
import type { FileChunk, GeneratorResult } from 'pundle-api/types'

import * as Helpers from './helpers'
import type { ServerConfig, ServerState, ServerConfigInput } from '../types'

const WssServer = Helpers.getWssServer()
const cliReporter: Object = require('pundle-reporter-default')

class Server {
  state: ServerState;
  cache: Object;
  config: ServerConfig;
  pundle: Pundle;
  context: Context;
  connections: Set<Object>;
  subscriptions: CompositeDisposable;
  constructor(pundle: Pundle, config: ServerConfigInput) {
    if (Helpers.isPundleRegistered(pundle)) {
      throw new Error('Cannot create two middlewares on one Pundle instance')
    }

    this.state = {
      queue: Promise.resolve(),
      files: new Map(),
      chunks: [],
      changed: new Map(),
      lastChunk: new Map(),
    }
    this.pundle = pundle
    this.context = this.pundle.context.clone()
    this.config = Helpers.fillConfig(config)
    this.connections = new Set()
    this.subscriptions = new CompositeDisposable()

    Helpers.registerPundle(pundle, this.config)
  }
  async activate() {
    const app = express()
    const oldFiles = new Map()

    this.cache = await this.pundle.getCache()
    if (this.config.useCache) {
      const state = await this.cache.get('state')
      if (state) {
        await this.context.unserialize(state)
      }
      await this.pundle.getCachedFiles(this.cache, oldFiles)
      this.report(`Number of files in cache pool: ${oldFiles.size}`)
    }

    await this.attachRoutes(app)
    await this.attachComponents()

    const server = app.listen(this.config.port)
    if (this.config.hmrPath) {
      const wss = new WssServer({ server, path: this.config.hmrPath })
      wss.on('connection', (connection) => {
        connection.on('close', () => this.connections.delete(connection))
        this.connections.add(connection)
      })
    }
    try {
      this.subscriptions.add(await this.pundle.compilation.watch(this.context, this.config.useCache, oldFiles))
    } catch (error) {
      server.close()
      throw error
    }
    this.subscriptions.add(function() {
      server.close()
    })
  }
  async generateChunkForUrl(url: string): Promise<?GeneratorResult> {
    const chunk = await this.generateChunk(url)
    if (chunk) {
      this.state.lastChunk.set(url, chunk)
    }
    return chunk
  }
  attachRoutes(app: Object): void {
    const bundlePathExt = Path.extname(this.config.bundlePath)
    app.get([this.config.bundlePath, `${this.config.bundlePath.slice(0, -1 * bundlePathExt.length)}*`], async (req, res, next) => {
      try {
        // TODO: Use lastChunk here for caching
        // const lastChunk = this.state.lastChunk.get(req.url)
        const chunk = await this.generateChunkForUrl(req.url)
        if (!chunk) {
          next()
          return
        }
        if (req.url.endsWith('.js.map')) {
          res.set('content-type', 'application/json')
          res.end(JSON.stringify(chunk.sourceMap))
        } else {
          res.set('content-type', 'application/javascript')
          res.end(chunk.contents)
        }
      } catch (e) {
        next()
      }
    })

    const serveFilledHtml = (req, res, next) => {
      this.state.queue.then(() => FS.readFile(Path.join(this.pundle.config.rootDirectory, 'index.html'), 'utf8')).then((contents) => {
        res.set('content-type', 'text/html')
        res.end(this.pundle.fill(contents, this.state.chunks, {
          publicRoot: Path.dirname(this.config.bundlePath),
          bundlePath: Path.basename(this.config.bundlePath),
        }))
      }, function(error) {
        if (error.code === 'ENOENT') {
          next()
        } else next(error)
      })
    }
    app.get('/', serveFilledHtml)

    app.use('/', express.static(this.config.rootDirectory))
    if (this.config.redirectNotFoundToIndex) {
      app.use(serveFilledHtml)
    }
  }
  async attachComponents(): Promise<void> {
    let booted = false
    const boot = promiseDefer()
    this.enqueue(() => boot.promise)
    this.subscriptions.add(await this.pundle.loadComponents([
      [cliReporter, {
        log: (text, error) => {
          if (this.config.hmrReports && error.severity && error.severity !== 'info') {
            this.writeToConnections({ type: 'report', text, severity: error.severity || 'error' })
          }
        },
      }],
      createWatcher({
        tick: (_: Object, __: Object, file: File) => {
          if (booted && file.filePath !== Helpers.browserFile) {
            this.state.changed.set(file.filePath, file)
          }
        },
        ready: () => {
          this.report('Server initialized successfully')
        },
        compile: async (_: Object, __: Object, chunks: Array<FileChunk>, files: Map<string, File>) => {
          this.state.files = files
          this.state.chunks = chunks
          if (this.connections.size && this.state.changed.size) {
            await this.generateForHMR()
          }
          boot.resolve()
          booted = true
        },
      }),
    ]))
  }
  // NOTE: Stuff below this line is called at will and not excuted on activate or whatever
  async generate(chunk: FileChunk, config: Object = {}): Promise<GeneratorResult> {
    const merged = {
      wrapper: 'hmr',
      bundlePath: Path.basename(this.config.bundlePath),
      publicRoot: Path.dirname(this.config.bundlePath),
      sourceMap: this.config.sourceMap,
      sourceMapPath: this.config.sourceMapPath,
      sourceNamespace: 'app',
      ...config,
    }

    this.state.changed.clear()
    const generated = await this.pundle.generate([chunk], merged)
    const output = generated[0]
    if (merged.sourceMap && merged.sourceMapPath !== 'inline') {
      const bundlePathExt = Path.extname(this.config.bundlePath)
      const bundlePathPrefix = this.config.bundlePath.slice(0, -1 * bundlePathExt.length)
      output.contents += `\n//# sourceMappingURL=${bundlePathPrefix}.${output.chunk.getIdOrLabel()}${bundlePathExt}.map\n`
    }
    return output
  }
  async generateForHMR() {
    const rootDirectory = this.pundle.config.rootDirectory

    const changedFilePaths = unique(Array.from(this.state.changed.keys()))
    const relativeChangedFilePaths = changedFilePaths.map(i => getRelativeFilePath(i, rootDirectory))
    this.report(`Sending HMR to ${this.connections.size} client${this.connections.size > 1 ? 's' : ''} of [ ${
      relativeChangedFilePaths.length > 4 ? `${relativeChangedFilePaths.length} files` : relativeChangedFilePaths.join(', ')
    } ]`)
    this.writeToConnections({ type: 'report-clear' })

    const label = `hmr-${Date.now()}`
    const chunk = await this.pundle.context.getChunk(label)
    chunk.files = new Map(this.state.changed)
    const generated = await this.generate(chunk, {
      sourceMapPath: 'inline',
      sourceMapNamespace: label,
    })
    this.writeToConnections({ type: 'hmr', contents: generated.contents, files: generated.filesGenerated })
  }
  async generateChunk(url: string): Promise<?GeneratorResult> {
    await this.state.queue

    const chunkId = Helpers.getChunkId(url, this.config.bundlePath)
    const chunk = this.state.chunks.find(entry => entry.id.toString() === chunkId || entry.label === chunkId)
    if (!chunk) {
      return null
    }

    let generated
    this.enqueue(() => this.generate(chunk).then((result) => {
      generated = result
    }))
    await this.state.queue
    return generated
  }
  report(contents: string, severity: 'info' | 'error' | 'warning' = 'info') {
    this.pundle.context.report(new MessageIssue(contents, severity))
  }
  enqueue(callback: Function): void {
    this.state.queue = this.state.queue.then(callback).catch(e => this.pundle.context.report(e))
  }
  writeToConnections(contents: Object): void {
    const stringifiedContents = JSON.stringify(contents)
    this.connections.forEach(connection => connection.send(stringifiedContents))
  }
  dispose() {
    if (!this.subscriptions.disposed) {
      if (this.context) {
        this.cache.setSync('state', this.context.serialize())
        this.pundle.setCachedFiles(this.cache, this.state.files)
      }
      Helpers.unregisterPundle(this.pundle)
    }
    this.subscriptions.dispose()
  }
}

module.exports = Server
