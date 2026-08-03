'use strict'
const EventEmitter = require('events').EventEmitter
const compression = require('./transforms/compression')
const framing = require('./transforms/framing')
const states = require('./states')
const debug = require('debug')('minecraft-protocol')
const debugSkip = process.env.DEBUG_SKIP?.split(',') ?? []

const createSerializer = require('./transforms/serializer').createSerializer
const createDeserializer = require('./transforms/serializer').createDeserializer
const createCipher = require('./transforms/encryption').createCipher
const createDecipher = require('./transforms/encryption').createDecipher

const closeTimeout = 30 * 1000

// Handler-boundary packet classes (kept in lockstep with the tolerant play
// parser's sets in node-minecraft-protocol-forge/src/client/tolerantPlayParser.js):
// losing one of these zombies the session, so a handler throw on them fails
// loudly; everything else in play state is drop-safe.
const HANDLER_CRITICAL_PACKETS = new Set(['keep_alive', 'login', 'position', 'respawn', 'map_chunk', 'update_health'])
// Play packets whose drop means the bot's inventory view is now wrong.
const HANDLER_INVENTORY_PACKETS = new Set(['window_items', 'set_slot', 'entity_equipment'])

class Client extends EventEmitter {
  constructor (isServer, version, customPackets, hideErrors = false) {
    super()
    this.customPackets = customPackets
    this.version = version
    this.isServer = !!isServer
    this.splitter = framing.createSplitter()
    this.packetsToParse = {}
    this.compressor = null
    this.framer = framing.createFramer()
    this.cipher = null
    this.decipher = null
    this.decompressor = null
    this.ended = true
    this.latency = 0
    this.hideErrors = hideErrors
    this.closeTimer = null
    const mcData = require('minecraft-data')(version)
    this._supportFeature = mcData.supportFeature
    this.state = states.HANDSHAKING
    this._hasBundlePacket = mcData.supportFeature('hasBundlePacket')
  }

  get state () {
    return this.protocolState
  }

  setSerializer (state) {
    this.serializer = createSerializer({ isServer: this.isServer, version: this.version, state, customPackets: this.customPackets })
    this.deserializer = createDeserializer({
      isServer: this.isServer,
      version: this.version,
      state,
      packetsToParse:
      this.packetsToParse,
      customPackets: this.customPackets,
      noErrorLogging: this.hideErrors
    })

    this.splitter.recognizeLegacyPing = state === states.HANDSHAKING

    this.serializer.on('error', (e) => {
      let parts
      if (e.field) {
        parts = e.field.split('.')
        parts.shift()
      } else { parts = [] }
      const serializerDirection = !this.isServer ? 'toServer' : 'toClient'
      e.field = [this.protocolState, serializerDirection].concat(parts).join('.')
      e.message = `Serialization error for ${e.field} : ${e.message}`
      if (!this.compressor) { this.serializer.pipe(this.framer) } else { this.serializer.pipe(this.compressor) }
      this.emit('error', e)
    })

    this.deserializer.on('error', (e) => {
      let parts = []
      if (e.field) {
        parts = e.field.split('.')
        parts.shift()
      }
      const deserializerDirection = this.isServer ? 'toServer' : 'toClient'
      e.field = [this.protocolState, deserializerDirection].concat(parts).join('.')
      e.message = e.buffer ? `Parse error for ${e.field} (${e.buffer?.length} bytes, ${e.buffer?.toString('hex').slice(0, 6)}...) : ${e.message}` : `Parse error for ${e.field}: ${e.message}`
      if (!this.compressor) { this.splitter.pipe(this.deserializer) } else { this.decompressor.pipe(this.deserializer) }
      this.emit('error', e)
    })
    // Degrade-gracefully guard (capability-fruit F1): a PARSE failure on an
    // inventory-class play packet used to be swallowed whole by protodef's
    // FullPacketParser (partialReadError -> log + drop) — one unparseable
    // slot blacked out an entire window_items/login sync with no signal.
    // Wrap the parser so the failure is re-parsed leniently: every slot
    // before the poison point is delivered intact, the poisoned slot
    // degrades to id+count (components flagged unknown), slots after it are
    // unrecoverable in principle (component payloads carry no length
    // prefix) and degrade to empty — and the same inventory-staleness
    // signal the tolerant forge parser uses tells the embedder the view is
    // partial. Anything non-inventory (or unsalvageable) keeps the old path.
    //
    // Data-driven: walks the packet's own container definition from
    // minecraft-data with the compiled protocol reader — no per-version or
    // per-component special cases.
    const salvageInventoryParseError = (buffer) => {
      try {
        if (this.isServer || state !== states.PLAY || !buffer || buffer.length === 0) return null
        const proto = this.deserializer.proto
        if (!proto || typeof proto.read !== 'function') return null
        const pdata = require('minecraft-data')(this.version)
        const toClient = pdata?.protocol?.play?.toClient
        const mappings = toClient?.types?.packet?.[1]?.[0]?.type?.[1]?.mappings
        if (!mappings) return null
        const idRead = proto.read(buffer, 0, 'varint')
        let name = null
        for (const [k, v] of Object.entries(mappings)) {
          if (parseInt(k, 16) === idRead.value) { name = v; break }
        }
        if (!name || !HANDLER_INVENTORY_PACKETS.has(name)) return null
        const def = toClient.types['packet_' + name]
        if (!Array.isArray(def) || def[0] !== 'container' || !Array.isArray(def[1])) return null
        // id+count prefix stub is only meaningful when the Slot layout starts
        // with itemCount/itemId varints (the components era, 1.20.5+)
        const slotDef = pdata.protocol.types?.Slot
        const slotPrefixOk = Array.isArray(slotDef) && slotDef[0] === 'container' &&
          slotDef[1]?.[0]?.name === 'itemCount' && slotDef[1]?.[0]?.type === 'varint'
        const readSlotStub = (buffer, offset) => {
          const c = proto.read(buffer, offset, 'varint')
          if (c.value === 0) return { itemCount: 0 }
          const id = proto.read(buffer, offset + c.size, 'varint')
          return {
            itemCount: c.value,
            itemId: id.value,
            addedComponentCount: 0,
            removedComponentCount: 0,
            components: [],
            removeComponents: [],
            componentsTruncated: true
          }
        }
        const params = {}
        const degraded = { firstUnreadable: null, slotsSalvaged: 0, slotsStubbed: 0, slotsUnknown: 0 }
        let offset = idRead.size
        for (const field of def[1]) {
          if (degraded.firstUnreadable !== null) break // boundary lost — later fields get defaults below
          if (typeof field.type === 'string') {
            try {
              const r = proto.read(buffer, offset, field.type)
              params[field.name] = r.value
              offset += r.size
            } catch (err) {
              if (field.type !== 'Slot') return null // unknown boundary on a non-slot field — nothing trustworthy to deliver
              degraded.firstUnreadable = field.name
              if (slotPrefixOk) {
                try { params[field.name] = readSlotStub(buffer, offset); degraded.slotsStubbed++ } catch { params[field.name] = { itemCount: 0 }; degraded.slotsUnknown++ }
              } else { params[field.name] = { itemCount: 0 }; degraded.slotsUnknown++ }
            }
          } else if (Array.isArray(field.type) && field.type[0] === 'array' &&
                     field.type[1]?.type === 'Slot' && field.type[1]?.countType === 'varint') {
            let cnt
            try { const c = proto.read(buffer, offset, 'varint'); cnt = c.value; offset += c.size } catch { return null }
            if (cnt < 0 || cnt > 4096) return null
            const items = []
            for (let i = 0; i < cnt; i++) {
              try {
                const r = proto.read(buffer, offset, 'Slot')
                items.push(r.value)
                offset += r.size
                degraded.slotsSalvaged++
              } catch (err) {
                degraded.firstUnreadable = `${field.name}[${i}]`
                if (slotPrefixOk) {
                  try { items.push(readSlotStub(buffer, offset)); degraded.slotsStubbed++ } catch { items.push({ itemCount: 0 }); degraded.slotsUnknown++ }
                } else { items.push({ itemCount: 0 }); degraded.slotsUnknown++ }
                while (items.length < cnt) { items.push({ itemCount: 0 }); degraded.slotsUnknown++ }
                break
              }
            }
            params[field.name] = items
          } else {
            return null // container shape we don't know how to walk
          }
        }
        if (degraded.firstUnreadable === null) return null // strict parse failed but the walk didn't? — keep the loud path
        // fields past the poison point that never got a value: safe defaults
        for (const field of def[1]) {
          if (field.name in params) continue
          if (field.type === 'Slot') params[field.name] = { itemCount: 0 }
          else if (Array.isArray(field.type) && field.type[0] === 'array') params[field.name] = []
          else params[field.name] = 0
        }
        this._invParseErrorCounts = this._invParseErrorCounts || {}
        const n = (this._invParseErrorCounts[name] = (this._invParseErrorCounts[name] || 0) + 1)
        if (n === 1 || n % 100 === 0) {
          console.warn(`[mc-parse] '${name}' parse failed at ${degraded.firstUnreadable} — salvaged ${degraded.slotsSalvaged} slot(s), ${degraded.slotsStubbed} degraded to id+count, ${degraded.slotsUnknown} unknown (${n} so far)`)
        }
        this.emit('forge_inventory_unreliable', { packet: name, id: idRead.value, parseError: true, salvaged: degraded })
        // Same shape FullPacketParser.parsePacketBuffer returns, so the
        // normal stream delivery path applies (size set to the full chunk
        // length so the partial-packet log stays quiet — the degradation is
        // already reported through the signal above).
        return {
          data: { name, params },
          metadata: { size: buffer.length, salvagedFromParseError: degraded },
          buffer,
          fullBuffer: buffer
        }
      } catch (err) {
        return null
      }
    }
    // FullPacketParser swallows partialReadErrors (log + drop) before any
    // 'error' event fires, so the guard must sit inside the parse call
    // itself.
    const originalParsePacketBuffer = this.deserializer.parsePacketBuffer.bind(this.deserializer)
    this.deserializer.parsePacketBuffer = (chunk) => {
      try {
        return originalParsePacketBuffer(chunk)
      } catch (err) {
        const salvaged = salvageInventoryParseError(chunk)
        if (salvaged) return salvaged
        throw err
      }
    }
    this._mcBundle = []
    // Packet-handler error boundary (MinePal crash hardening, Mechanism A):
    // protodef's FullPacketParser pushes OUTSIDE its try/catch, so a throw
    // inside any packet listener used to propagate to uncaughtException and
    // kill the whole process mid-session. Split identical to the tolerant
    // play parser (node-minecraft-protocol-forge tolerantPlayParser):
    // degradable play packets are dropped with a throttled log (+ a
    // staleness signal for inventory-class packets); critical packets and
    // every non-play state convert the throw into a client 'error' so the
    // embedder's classified disconnect/recovery path runs instead of a raw
    // process death.
    const emitPacket = (parsed) => {
      try {
        this.emit('packet', parsed.data, parsed.metadata, parsed.buffer, parsed.fullBuffer)
        this.emit(parsed.metadata.name, parsed.data, parsed.metadata)
        this.emit('raw.' + parsed.metadata.name, parsed.buffer, parsed.metadata)
        this.emit('raw', parsed.buffer, parsed.metadata)
      } catch (err) {
        const name = parsed.metadata.name
        if (state !== states.PLAY || HANDLER_CRITICAL_PACKETS.has(name)) {
          // A handler failure on a session-critical packet (or during
          // handshake/login/config) leaves the session unusable — fail
          // loudly through the classified error path, never zombie.
          err.message = `Error in '${name}' packet handler (${state} state): ${err.message}`
          this.emit('error', err)
          return
        }
        this._handlerErrorCounts = this._handlerErrorCounts || {}
        const count = (this._handlerErrorCounts[name] = (this._handlerErrorCounts[name] || 0) + 1)
        if (count === 1 || count % 100 === 0) {
          console.warn(`[mc-handler] '${name}' packet handler threw (packet dropped, ${count} so far): ${err.message}`)
        }
        if (HANDLER_INVENTORY_PACKETS.has(name)) {
          // Same signal the tolerant parser emits for unparseable inventory
          // packets: the bot's item view is now stale; MinePal listens and
          // reports it through its governed channel.
          this.emit('forge_inventory_unreliable', { packet: name, id: -1, handlerError: true })
        }
      }
    }
    this.deserializer.on('data', (parsed) => {
      parsed.metadata.name = parsed.data.name
      parsed.data = parsed.data.params
      parsed.metadata.state = state
      if (debug.enabled && !debugSkip.includes(parsed.metadata.name)) {
        debug('read packet ' + state + '.' + parsed.metadata.name)
        const s = JSON.stringify(parsed.data, null, 2)
        debug(s && s.length > 10000 ? parsed.data : s)
      }
      if (this._hasBundlePacket && parsed.metadata.name === 'bundle_delimiter') {
        if (this._mcBundle.length) { // End bundle
          this._mcBundle.forEach(emitPacket)
          emitPacket(parsed)
          this._mcBundle = []
        } else { // Start bundle
          this._mcBundle.push(parsed)
        }
      } else if (this._mcBundle.length) {
        this._mcBundle.push(parsed)
        if (this._mcBundle.length > 32) {
          this._mcBundle.forEach(emitPacket)
          this._mcBundle = []
          this._hasBundlePacket = false
        }
      } else {
        emitPacket(parsed)
      }
    })
  }

  set state (newProperty) {
    const oldProperty = this.protocolState
    this.protocolState = newProperty

    if (this.serializer) {
      if (!this.compressor) {
        this.serializer.unpipe()
        this.splitter.unpipe(this.deserializer)
      } else {
        this.serializer.unpipe(this.compressor)
        this.decompressor.unpipe(this.deserializer)
      }

      this.serializer.removeAllListeners()
      this.deserializer.removeAllListeners()
    }
    this.setSerializer(this.protocolState)

    if (!this.compressor) {
      this.serializer.pipe(this.framer)
      this.splitter.pipe(this.deserializer)
    } else {
      this.serializer.pipe(this.compressor)
      if (globalThis.debugNMP) this.decompressor.on('data', (data) => { console.log('DES>', data.toString('hex')) })
      this.decompressor.pipe(this.deserializer)
    }

    this.emit('state', newProperty, oldProperty)
  }

  get compressionThreshold () {
    return this.compressor == null ? -2 : this.compressor.compressionThreshold
  }

  set compressionThreshold (threshold) {
    this.setCompressionThreshold(threshold)
  }

  setSocket (socket) {
    this.ended = false

    // TODO : A lot of other things needs to be done.
    const endSocket = () => {
      if (this.ended) return
      this.ended = true
      clearTimeout(this.closeTimer)
      this.socket.removeListener('close', endSocket)
      this.socket.removeListener('end', endSocket)
      this.socket.removeListener('timeout', endSocket)
      this.emit('end', this._endReason || 'socketClosed')
    }

    const onFatalError = (err) => {
      this.emit('error', err)
      endSocket()
    }

    const onError = (err) => this.emit('error', err)

    this.socket = socket

    if (this.socket.setNoDelay) { this.socket.setNoDelay(true) }

    this.socket.on('connect', () => this.emit('connect'))

    this.socket.on('error', onFatalError)
    this.socket.on('close', endSocket)
    this.socket.on('end', endSocket)
    this.socket.on('timeout', endSocket)
    this.framer.on('error', onError)
    this.splitter.on('error', onError)

    this.socket.pipe(this.splitter)
    this.framer.pipe(this.socket)
  }

  end (reason) {
    this._endReason = reason
    /* ending the serializer will end the whole chain
    serializer -> framer -> socket -> splitter -> deserializer */
    if (this.serializer) {
      this.serializer.end()
    } else {
      if (this.socket) this.socket.end()
    }
    if (this.socket) {
      this.closeTimer = setTimeout(
        this.socket.destroy.bind(this.socket),
        closeTimeout
      )
    }
  }

  setEncryption (sharedSecret) {
    if (this.cipher != null) { this.emit('error', new Error('Set encryption twice!')) }
    this.cipher = createCipher(sharedSecret)
    this.cipher.on('error', (err) => this.emit('error', err))
    this.framer.unpipe(this.socket)
    this.framer.pipe(this.cipher).pipe(this.socket)
    this.decipher = createDecipher(sharedSecret)
    this.decipher.on('error', (err) => this.emit('error', err))
    this.socket.unpipe(this.splitter)
    this.socket.pipe(this.decipher).pipe(this.splitter)
  }

  setCompressionThreshold (threshold) {
    if (this.compressor == null) {
      this.compressor = compression.createCompressor(threshold)
      this.compressor.on('error', (err) => this.emit('error', err))
      this.serializer.unpipe(this.framer)
      this.serializer.pipe(this.compressor).pipe(this.framer)
      this.decompressor = compression.createDecompressor(threshold, this.hideErrors)
      this.decompressor.on('error', (err) => this.emit('error', err))
      this.splitter.unpipe(this.deserializer)
      this.splitter.pipe(this.decompressor).pipe(this.deserializer)
    } else {
      this.decompressor.threshold = threshold
      this.compressor.threshold = threshold
    }
  }

  write (name, params) {
    if (!this.serializer.writable) { return }
    if (debug.enabled && !debugSkip.includes(name)) {
      debug('writing packet ' + this.state + '.' + name)
      debug(params)
    }
    this.serializer.write({ name, params })
  }

  writeBundle (packets) {
    if (this._hasBundlePacket) this.write('bundle_delimiter', {})
    for (const [name, params] of packets) this.write(name, params)
    if (this._hasBundlePacket) this.write('bundle_delimiter', {})
  }

  writeRaw (buffer) {
    const stream = this.compressor === null ? this.framer : this.compressor
    if (!stream.writable) { return }
    stream.write(buffer)
  }

  // TCP/IP-specific (not generic Stream) method for backwards-compatibility
  connect (port, host) {
    const options = { port, host }
    if (!this.options) this.options = options
    require('./client/tcp_dns')(this, options)
    options.connect(this)
  }
}

module.exports = Client
