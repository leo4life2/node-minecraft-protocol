// Compute chat checksum using Java's Arrays.hashCode algorithm to match vanilla client
// (LastSeenMessages.computeChecksum, 1.21.5+): the hash runs over the acknowledged signatures in the order the
// acknowledgement bitset reports them - from the OLDEST tracked slot to the newest - which for the client's
// LastSeenMessagesWithInvalidation ring means walking from its write cursor (`offset`, the next slot to overwrite =
// the oldest entry) around the ring, exactly as getAcknowledgements does. Walking the ring in storage order instead
// diverged from the server's checksum as soon as the ring had wrapped (the 21st signed message onwards).
function computeChatChecksum (lastSeenMessages) {
  if (!lastSeenMessages || lastSeenMessages.length === 0) return 1

  const ring = Number.isInteger(lastSeenMessages.capacity) && Number.isInteger(lastSeenMessages.offset)
  const count = ring ? lastSeenMessages.capacity : lastSeenMessages.length
  let checksum = 1
  for (let i = 0; i < count; i++) {
    const message = ring
      ? lastSeenMessages[(lastSeenMessages.offset + i) % lastSeenMessages.capacity]
      : lastSeenMessages[i]
    if (message && message.signature) {
      let sigHash = 1
      for (let j = 0; j < message.signature.length; j++) {
        sigHash = (31 * sigHash + message.signature[j]) & 0xffffffff
      }
      checksum = (31 * checksum + sigHash) & 0xffffffff
    }
  }
  // Convert to byte
  const result = checksum & 0xff
  return result === 0 ? 1 : result
}

module.exports = { computeChatChecksum }
