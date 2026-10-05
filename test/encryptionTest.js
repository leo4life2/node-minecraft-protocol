/* eslint-env mocha */
// HF82: the three CFB8 implementations are byte-identical on every input
// and every chunking, and the native-ECB path carries its register across
// chunks and across its own pass cap.
const crypto = require('crypto')
const assert = require('assert')
const encryption = require('../src/transforms/encryption')

const { createCipher, createDecipher, implementationOf, IMPLEMENTATIONS, ECB_PASS_BYTES } = encryption
const hasCfb8 = crypto.getCiphers().includes('aes-128-cfb8')
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')

// every implementation forced through the same constructor option
const FORCE = {
  [IMPLEMENTATIONS.js]: { ciphers: [] },
  [IMPLEMENTATIONS.ecb]: { ciphers: ['aes-128-ecb'] },
  [IMPLEMENTATIONS.cfb8]: { ciphers: ['aes-128-cfb8', 'aes-128-ecb'] }
}
const implementations = [IMPLEMENTATIONS.js, IMPLEMENTATIONS.ecb].concat(hasCfb8 ? [IMPLEMENTATIONS.cfb8] : [])

function through (stream, data, chunks) {
  const outs = []
  let offset = 0
  for (const size of chunks) {
    const piece = data.subarray(offset, offset + size)
    offset += size
    if (stream.update) outs.push(stream.update(piece))
    else stream._transform(piece, null, (err, out) => { if (err) throw err; outs.push(out) })
  }
  assert.strictEqual(offset, data.length)
  return Buffer.concat(outs)
}

function randomChunking (n, max) {
  const chunks = []
  let left = n
  while (left > 0) {
    const size = Math.min(left, 1 + Math.floor(Math.random() * Math.min(left, max)))
    chunks.push(size)
    left -= size
  }
  return chunks
}

describe('encryption', function () {
  this.timeout(60000)
  const secret = crypto.randomBytes(16)

  it('selects native cfb8, then native ecb, then aes-js, from the ciphers the runtime lists', () => {
    assert.strictEqual(implementationOf(['aes-128-cbc', 'aes-128-ecb', 'aes-128-cfb8']), IMPLEMENTATIONS.cfb8)
    assert.strictEqual(implementationOf(['aes-128-cbc', 'aes-128-ecb']), IMPLEMENTATIONS.ecb)
    assert.strictEqual(implementationOf(['aes-128-cbc']), IMPLEMENTATIONS.js)
    assert.strictEqual(implementationOf([]), IMPLEMENTATIONS.js)
    const expected = hasCfb8 ? IMPLEMENTATIONS.cfb8 : (crypto.getCiphers().includes('aes-128-ecb') ? IMPLEMENTATIONS.ecb : IMPLEMENTATIONS.js)
    assert.strictEqual(createCipher(secret).implementation, expected)
    assert.strictEqual(createDecipher(secret).implementation, expected)
    for (const name of implementations) {
      assert.strictEqual(createCipher(secret, FORCE[name]).implementation, name)
      assert.strictEqual(createDecipher(secret, FORCE[name]).implementation, name)
    }
  })

  for (const n of [1, 2, 15, 16, 17, 31, 32, 33, 100, 1000, 65536, ECB_PASS_BYTES + 7, 4 * 1024 * 1024]) {
    it(`is byte-identical across implementations on ${n} bytes in random chunkings`, () => {
      const data = crypto.randomBytes(n)
      const chunks = randomChunking(n, 200000)
      const decrypted = {}
      const encrypted = {}
      for (const name of implementations) {
        decrypted[name] = sha(through(createDecipher(secret, FORCE[name]), data, chunks))
        encrypted[name] = sha(through(createCipher(secret, FORCE[name]), data, randomChunking(n, 200000)))
      }
      for (const name of implementations) {
        assert.strictEqual(decrypted[name], decrypted[IMPLEMENTATIONS.js], `decipher ${name} vs aes-js`)
        assert.strictEqual(encrypted[name], encrypted[IMPLEMENTATIONS.js], `cipher ${name} vs aes-js`)
      }
      // and the chunking never shows on the wire: one chunk == the random chunking
      assert.strictEqual(sha(through(createDecipher(secret, FORCE[IMPLEMENTATIONS.ecb]), data, [n])), decrypted[IMPLEMENTATIONS.js])
    })
  }

  it('carries the native-ecb register across chunk boundaries and across its pass cap', () => {
    const n = 2 * ECB_PASS_BYTES + 37
    const data = crypto.randomBytes(n)
    const chunks = [ECB_PASS_BYTES - 1, 1, 2, 13, ECB_PASS_BYTES, 16, 15, 0, 1, 2, 3, 4]
    chunks.push(n - chunks.reduce((a, b) => a + b, 0))
    const reference = sha(through(createDecipher(secret, FORCE[IMPLEMENTATIONS.js]), data, [n]))
    assert.strictEqual(sha(through(createDecipher(secret, FORCE[IMPLEMENTATIONS.ecb]), data, chunks)), reference)
    assert.strictEqual(sha(through(createDecipher(secret, FORCE[IMPLEMENTATIONS.ecb]), data, [n])), reference)
    const encryptedReference = sha(through(createCipher(secret, FORCE[IMPLEMENTATIONS.js]), data, [n]))
    assert.strictEqual(sha(through(createCipher(secret, FORCE[IMPLEMENTATIONS.ecb]), data, chunks)), encryptedReference)
  })

  it('round-trips between every pair of implementations', () => {
    const data = crypto.randomBytes(70000)
    for (const a of implementations) {
      for (const b of implementations) {
        const wire = through(createCipher(secret, FORCE[a]), data, randomChunking(data.length, 5000))
        const back = through(createDecipher(secret, FORCE[b]), wire, randomChunking(data.length, 5000))
        assert.strictEqual(sha(back), sha(data), `${a} cipher -> ${b} decipher`)
      }
    }
  })

  it('never mutates the shared secret', () => {
    const copy = Buffer.from(secret)
    for (const name of implementations) {
      through(createCipher(secret, FORCE[name]), crypto.randomBytes(100), [100])
      through(createDecipher(secret, FORCE[name]), crypto.randomBytes(100), [100])
    }
    assert.strictEqual(sha(secret), sha(copy))
  })
})
