const Transform = require('readable-stream').Transform
const crypto = require('crypto')
const aesjs = require('aes-js')

// The wire cipher is AES-128-CFB8 keyed and seeded with the shared secret.
// Three implementations, chosen ONCE at construction from what the runtime's
// crypto actually lists (a BoringSSL-backed runtime has no cfb8 but has ecb):
//   native-cfb8  the runtime's own stream cipher (first choice)
//   native-ecb   CFB8 driven through the runtime's AES-ECB block cipher
//   aes-js       the pure-JS cipher (only when neither native cipher exists)
// The choice is readable as `.implementation` on every stream.
const NATIVE_CFB8 = 'aes-128-cfb8'
const NATIVE_ECB = 'aes-128-ecb'
const BLOCK = 16
// One native call decrypts at most this much ciphertext: its windows are 16x
// the bytes, so a pass holds 16 MiB of scratch, never 16x a whole burst.
const ECB_PASS_BYTES = 1024 * 1024
const IMPLEMENTATIONS = Object.freeze({ cfb8: 'native-cfb8', ecb: 'native-ecb', js: 'aes-js' })

function implementationOf (ciphers) {
  const list = Array.isArray(ciphers) ? ciphers : crypto.getCiphers()
  if (list.includes(NATIVE_CFB8)) return IMPLEMENTATIONS.cfb8
  if (list.includes(NATIVE_ECB)) return IMPLEMENTATIONS.ecb
  return IMPLEMENTATIONS.js
}

function createCipher (secret, options) {
  const implementation = implementationOf(options && options.ciphers)
  if (implementation === IMPLEMENTATIONS.cfb8) {
    const cipher = crypto.createCipheriv(NATIVE_CFB8, secret, secret)
    cipher.implementation = implementation
    return cipher
  }
  if (implementation === IMPLEMENTATIONS.ecb) return new EcbCipher(secret)
  return new Cipher(secret)
}

function createDecipher (secret, options) {
  const implementation = implementationOf(options && options.ciphers)
  if (implementation === IMPLEMENTATIONS.cfb8) {
    const decipher = crypto.createDecipheriv(NATIVE_CFB8, secret, secret)
    decipher.implementation = implementation
    return decipher
  }
  if (implementation === IMPLEMENTATIONS.ecb) return new EcbDecipher(secret)
  return new Decipher(secret)
}

class Cipher extends Transform {
  constructor (secret) {
    super()
    this.implementation = IMPLEMENTATIONS.js
    this.aes = new aesjs.ModeOfOperation.cfb(secret, secret, 1) // eslint-disable-line new-cap
  }

  _transform (chunk, enc, cb) {
    try {
      const res = this.aes.encrypt(chunk)
      cb(null, res)
    } catch (e) {
      cb(e)
    }
  }
}

class Decipher extends Transform {
  constructor (secret) {
    super()
    this.implementation = IMPLEMENTATIONS.js
    this.aes = new aesjs.ModeOfOperation.cfb(secret, secret, 1) // eslint-disable-line new-cap
  }

  _transform (chunk, enc, cb) {
    try {
      const res = this.aes.decrypt(chunk)
      cb(null, res)
    } catch (e) {
      cb(e)
    }
  }
}

// The raw AES block function from the runtime: ECB with no padding over
// whole blocks is exactly E_k applied to each block.
function createBlockCipher (secret) {
  const ecb = crypto.createCipheriv(NATIVE_ECB, secret, null)
  ecb.setAutoPadding(false)
  return ecb
}

// CFB8 encryption is sequential: ciphertext byte i feeds the register of
// byte i + 1. Serverbound traffic is small, so one block call per byte.
class EcbCipher extends Transform {
  constructor (secret) {
    super()
    this.implementation = IMPLEMENTATIONS.ecb
    this.ecb = createBlockCipher(secret)
    this.register = Buffer.from(secret)
  }

  _transform (chunk, enc, cb) {
    try {
      const out = Buffer.allocUnsafe(chunk.length)
      const register = this.register
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i] ^ this.ecb.update(register)[0]
        out[i] = c
        register.copyWithin(0, 1)
        register[BLOCK - 1] = c
      }
      cb(null, out)
    } catch (e) {
      cb(e)
    }
  }
}

// CFB8 decryption is parallel: the register before ciphertext byte i is the
// 16 ciphertext bytes before it (the IV-seeded register for the first 16),
// all known up front, so plaintext byte i = C[i] XOR E_k(window i)[0] with
// every window encrypted in ONE native call over their concatenation.
class EcbDecipher extends Transform {
  constructor (secret) {
    super()
    this.implementation = IMPLEMENTATIONS.ecb
    this.ecb = createBlockCipher(secret)
    this.register = Buffer.from(secret)
    this.scratch = null
  }

  _transform (chunk, enc, cb) {
    try {
      const out = Buffer.allocUnsafe(chunk.length)
      for (let offset = 0; offset < chunk.length; offset += ECB_PASS_BYTES) {
        const slice = chunk.subarray(offset, Math.min(chunk.length, offset + ECB_PASS_BYTES))
        this._decryptPass(slice, out, offset)
      }
      cb(null, out)
    } catch (e) {
      cb(e)
    }
  }

  _scratchFor (n) {
    // stream = register || slice (n + 16 bytes, 4 slack bytes for the word
    // reads), four copies of it shifted by 0..3 bytes so every window word
    // is an aligned 32-bit read, and the windows themselves (16 bytes each).
    const streamLength = n + BLOCK + 4
    if (this.scratch === null || this.scratch.capacity < n) {
      const words = Math.ceil(streamLength / 4)
      this.scratch = {
        capacity: n,
        stream: new Uint8Array(streamLength),
        shifted: [0, 1, 2, 3].map(() => new Uint32Array(words)),
        windows: new Uint32Array(n * 4)
      }
    }
    return this.scratch
  }

  _decryptPass (slice, out, offset) {
    const n = slice.length
    const { stream, shifted, windows } = this._scratchFor(n)
    stream.set(this.register, 0)
    stream.set(slice, BLOCK)
    const streamLength = n + BLOCK
    for (let k = 0; k < 4; k++) {
      const bytes = new Uint8Array(shifted[k].buffer)
      bytes.set(stream.subarray(k, streamLength), 0)
    }
    // window i = stream[i .. i + 16): the four words at byte offsets i + 4m
    // share the alignment i & 3 and sit at word index (i >> 2) + m of that copy.
    for (let i = 0; i < n; i++) {
      const words = shifted[i & 3]
      const q = i >> 2
      const w = i * 4
      windows[w] = words[q]
      windows[w + 1] = words[q + 1]
      windows[w + 2] = words[q + 2]
      windows[w + 3] = words[q + 3]
    }
    const encrypted = this.ecb.update(Buffer.from(windows.buffer, 0, n * BLOCK))
    for (let i = 0; i < n; i++) out[offset + i] = slice[i] ^ encrypted[i * BLOCK]
    // the register after the pass = the last 16 bytes of the stream
    this.register.set(stream.subarray(streamLength - BLOCK, streamLength), 0)
  }
}

module.exports = {
  createCipher,
  createDecipher,
  implementationOf,
  IMPLEMENTATIONS,
  ECB_PASS_BYTES
}
