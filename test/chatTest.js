/* eslint-env mocha */
// The unsigned client's chat bookkeeping against the 1.19.3+ server-side
// LastSeenMessagesValidator (offset / acknowledged bitset / 1.21.5+ checksum).
// Driven through the chat plugin on a fake client emitter - no wire, no keys:
// the client under test never signs (no profileKeys / _session), exactly the
// offline-auth shape that the server still validates the bookkeeping of.
const assert = require('assert')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const chatPlugin = require('../src/client/chat')
const { computeChatChecksum } = require('../src/datatypes/checksums')

function fakeClient (version) {
  const client = new EventEmitter()
  client.version = version
  client.writes = []
  client.write = (name, params) => { client.writes.push({ name, params }) }
  chatPlugin(client, {})
  return client
}

function signatureOf (n) {
  // deterministic 256-byte signatures, distinct per n (hash-derived: an affine-in-n fixture hashes the same
  // byte in either order), with high bytes so the signed-byte hashing is exercised
  return Buffer.concat(Array.from({ length: 8 }, (_, k) => crypto.createHash('sha256').update(`sig-${n}-${k}`).digest()))
}

let index = 0
function signedPlayerChat (client, n) {
  client.emit('player_chat', {
    globalIndex: index,
    senderUuid: '11111111-2222-3333-4444-555555555555',
    index: index++,
    signature: signatureOf(n),
    plainMessage: `hello ${n}`,
    unsignedChatContent: undefined,
    timestamp: BigInt(Date.now()),
    salt: 1n,
    previousMessages: [],
    filterType: 0,
    type: 1,
    networkName: { type: 'string', value: 'Host' },
    networkTargetName: undefined
  })
}

// Vanilla LastSeenMessages.computeChecksum (1.21.5+): Java int arithmetic over
// Arrays.hashCode of each signature (signed bytes), oldest acknowledged first.
function vanillaChecksum (signatures) {
  let hash = 1
  for (const sig of signatures) {
    let sigHash = 1
    for (const b of sig) sigHash = (31 * sigHash + ((b << 24) >> 24)) | 0
    hash = (31 * hash + sigHash) | 0
  }
  const byte = hash & 0xff
  return byte === 0 ? 1 : byte
}

function bitsOf (acknowledged) {
  return acknowledged[0] | (acknowledged[1] << 8) | (acknowledged[2] << 16)
}

const last = (client, name) => client.writes.filter(w => w.name === name).pop()

describe('unsigned client chat bookkeeping (1.19.3+ last-seen tracker)', function () {
  it('1.20.5+: an unsigned command leaves the tracker alone, the next chat_message still acknowledges the seen message (offset 1)', () => {
    const client = fakeClient('1.21.4')
    signedPlayerChat(client, 1)
    assert.strictEqual(client._lastSeenMessages.pending, 1)

    client._signedChat('/tellraw @a "hi"')
    const command = last(client, 'chat_command')
    assert.ok(command, 'the unsigned 1.20.5+ command is written as chat_command')
    assert.deepStrictEqual(Object.keys(command.params), ['command'], 'vanilla sendUnsignedCommand: the command string only')
    assert.strictEqual(command.params.command, 'tellraw @a "hi"')
    assert.strictEqual(client.writes.some(w => w.name === 'chat_command_signed'), false)
    assert.strictEqual(client._lastSeenMessages.pending, 1, 'the pending count survives the unsigned command')
    assert.strictEqual(client._lastSeenMessages[0].pending, true, 'the entry is still pending (never acknowledged by a packet that carries no acknowledgement)')

    client._signedChat('hi')
    const chat = last(client, 'chat_message')
    assert.ok(chat)
    assert.strictEqual(chat.params.offset, 1, 'one signed message seen since the last acknowledgement the server received')
    assert.strictEqual(bitsOf(chat.params.acknowledged), 1 << 19, 'the seen message sits in the newest slot of the 20-wide window')
    assert.strictEqual(chat.params.signature, undefined)
    assert.strictEqual(client._lastSeenMessages.pending, 0)
  })

  it('1.20.5+: a signing client still writes chat_command_signed with the acknowledgement (messageCount) and resets pending', () => {
    const client = fakeClient('1.21.4')
    client.profileKeys = {}
    client._session = {}
    client.signMessage = () => Buffer.alloc(256)
    signedPlayerChat(client, 2)
    client._signedChat('/tellraw @a "hi"')
    const signed = last(client, 'chat_command_signed')
    assert.ok(signed, 'a client that can sign uses the signed command packet')
    assert.strictEqual(signed.params.messageCount, 1)
    assert.strictEqual(bitsOf(signed.params.acknowledged), 1 << 19)
    assert.strictEqual(client._lastSeenMessages.pending, 0)
    assert.strictEqual(client.writes.some(w => w.name === 'chat_command'), false)
  })

  it('1.19.3 - 1.20.4: the chat_command packet carries the acknowledgement itself, so it consumes the pending count (unchanged)', () => {
    const client = fakeClient('1.20.4')
    signedPlayerChat(client, 3)
    client._signedChat('/tellraw @a "hi"')
    const command = last(client, 'chat_command')
    assert.ok(command)
    assert.strictEqual(command.params.messageCount, 1)
    assert.strictEqual(bitsOf(command.params.acknowledged), 1 << 19)
    assert.deepStrictEqual(command.params.argumentSignatures, [])
    assert.strictEqual(client._lastSeenMessages.pending, 0)

    client._signedChat('hi')
    const chat = last(client, 'chat_message')
    assert.strictEqual(chat.params.offset, 0, 'already acknowledged by the command')
    assert.strictEqual(bitsOf(chat.params.acknowledged), 1 << 19, 'still inside the window, so still reported as seen')
  })

  it('1.21.5+: after the ring wraps (25 signed messages) the checksum matches the vanilla oldest-to-newest order', () => {
    const client = fakeClient('1.21.5')
    for (let n = 1; n <= 25; n++) signedPlayerChat(client, n)
    assert.strictEqual(client._lastSeenMessages.pending, 25)

    client._signedChat('hi')
    const chat = last(client, 'chat_message')
    assert.strictEqual(chat.params.offset, 25)
    assert.strictEqual(bitsOf(chat.params.acknowledged), 0xfffff, 'all 20 tracked slots acknowledged')
    const expected = vanillaChecksum([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25].map(signatureOf))
    assert.strictEqual(chat.params.checksum, expected, 'the server hashes the acknowledged signatures oldest first')
    assert.strictEqual(computeChatChecksum(client._lastSeenMessages), expected)
    // sanity: the storage-order walk is a different byte for this fixture (the defect this pins)
    const storageOrder = vanillaChecksum(Array.from({ length: 20 }, (_, i) => client._lastSeenMessages[i].signature))
    assert.notStrictEqual(storageOrder, expected, 'fixture must tell the two orders apart')
  })

  it('1.21.5+: the checksum over a partly filled window equals the vanilla reference (no wrap)', () => {
    const client = fakeClient('1.21.5')
    for (let n = 1; n <= 3; n++) signedPlayerChat(client, n)
    client._signedChat('hi')
    const chat = last(client, 'chat_message')
    assert.strictEqual(chat.params.offset, 3)
    assert.strictEqual(chat.params.checksum, vanillaChecksum([1, 2, 3].map(signatureOf)))
    assert.strictEqual(bitsOf(chat.params.acknowledged), (1 << 17) | (1 << 18) | (1 << 19))
  })

  it('hide_message nulls the matching pending entry in place - offset and pending survive, the checksum walk skips the hole', () => {
    const client = fakeClient('1.21.5')
    for (let n = 1; n <= 3; n++) signedPlayerChat(client, n)
    const ring = client._lastSeenMessages
    client.emit('hide_message', { signature: Buffer.from(signatureOf(2)) })
    assert.strictEqual(client._lastSeenMessages, ring, 'the ring object is the same one (no re-instantiation)')
    assert.strictEqual(ring[1], null)
    assert.ok(ring[0] && ring[2])
    assert.strictEqual(ring.offset, 3)
    assert.strictEqual(ring.pending, 3)

    client._signedChat('hi')
    const chat = last(client, 'chat_message')
    assert.strictEqual(chat.params.offset, 3)
    assert.strictEqual(bitsOf(chat.params.acknowledged), (1 << 17) | (1 << 19), 'the hidden message is reported as not seen')
    assert.strictEqual(chat.params.checksum, vanillaChecksum([1, 3].map(signatureOf)))
  })

  it('hide_message for an unknown or already-acknowledged signature changes nothing', () => {
    const client = fakeClient('1.21.4')
    signedPlayerChat(client, 4)
    client._signedChat('hi') // acknowledges (pending=false)
    const ring = client._lastSeenMessages
    client.emit('hide_message', { signature: Buffer.from(signatureOf(4)) })
    assert.ok(ring[0], 'an acknowledged entry is not a pending one (vanilla ignorePending)')
    client.emit('hide_message', { signature: signatureOf(99) })
    client.emit('hide_message', { id: 5 })
    assert.strictEqual(ring.offset, 1)
    assert.strictEqual(client._lastSeenMessages, ring)
  })
})
