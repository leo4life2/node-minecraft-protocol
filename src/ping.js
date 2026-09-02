'use strict'

const Client = require('./client')
const states = require('./states')
const tcpDns = require('./client/tcp_dns')

module.exports = cbPing

function cbPing (options, cb) {
  const pingPromise = ping(options)
  if (cb) {
    pingPromise.then((d) => {
      cb(null, d)
    }).catch((err) => {
      cb(err, null)
    })
  }
  return pingPromise
};

function ping (options) {
  options.host = options.host || 'localhost'
  options.port = options.port || 25565
  const optVersion = options.version || require('./version').defaultVersion
  const mcData = require('minecraft-data')(optVersion)
  const version = mcData.version
  options.majorVersion = version.majorVersion
  options.protocolVersion = version.version
  let closeTimer = null
  options.closeTimeout = options.closeTimeout || 120 * 1000
  options.noPongTimeout = options.noPongTimeout || 5 * 1000

  const client = new Client(false, version.minecraftVersion)
  return new Promise((resolve, reject) => {
    let answered = false // server_info seen (or we ended the ping ourselves)
    client.on('error', function (err) {
      clearTimeout(closeTimer)
      answered = true
      client.end()
      reject(err)
    })
    // HF21 (MinePal fork): a peer that ACCEPTS the TCP connection and then
    // closes it before answering the status request (proxy drop, a server
    // still booting behind a front, a port forwarded to nothing) used to
    // leave this promise pending until closeTimeout (120s) — the caller's
    // join sat on "(ping never completed)" for its whole watchdog window.
    // Reject at once with a typed marker so the caller can classify it.
    client.on('end', function () {
      if (answered) return
      answered = true
      clearTimeout(closeTimer)
      const err = new Error('status ping: the connection closed before the server answered')
      err.pingClosed = true
      reject(err)
    })
    client.once('server_info', function (packet) {
      answered = true
      let data
      try {
        data = JSON.parse(packet.response)
      } catch (err) {
        // a throw here would be an uncaught exception, not a rejection
        clearTimeout(closeTimer)
        client.end()
        reject(new Error(`Malformed server status response: ${err.message}`))
        return
      }
      const start = Date.now()
      const maxTime = setTimeout(() => {
        clearTimeout(closeTimer)
        client.end()
        resolve(data)
      }, options.noPongTimeout)
      client.once('ping', function (packet) {
        data.latency = Date.now() - start
        clearTimeout(maxTime)
        clearTimeout(closeTimer)
        client.end()
        resolve(data)
      })
      client.write('ping', { time: [0, 0] })
    })
    client.on('state', function (newState) {
      if (newState === states.STATUS) { client.write('ping_start', {}) }
    })
    // TODO: refactor with src/client/setProtocol.js
    client.on('connect', function () {
      client.write('set_protocol', {
        protocolVersion: options.protocolVersion,
        serverHost: options.host,
        serverPort: options.port,
        nextState: 1
      })
      client.state = states.STATUS
    })
    // timeout against servers that never reply while keeping
    // the connection open and alive.
    closeTimer = setTimeout(function () {
      client.end()
      reject(new Error('ETIMEDOUT'))
    }, options.closeTimeout)
    tcpDns(client, options)
    options.connect(client)
  })
};
