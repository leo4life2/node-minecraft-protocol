// 26.3 (protocol 777): net.minecraft.network.protocol.game.VecDelta, the body of
// ClientboundMoveEntityPacket.Pos / PosRot after the entity id.
//
// Wire (VecDelta.write / ClientboundMoveEntityPacket.packProperties):
//   properties: varint   bit 0 = onGround (ON_GROUND_FLAG), bits 1.. = stepCount (STEP_COUNT_OFFSET = 1)
//   stepCount == 0 -> dX, dY, dZ: i16                       (VecDelta.Linear, 1/4096 block units)
//   stepCount  > 0 -> stepCount x { ticks: varint, dX, dY, dZ: i16 }  (VecDelta.Stepped.DeltaStep)
// The step count is derived by a shift of the flags word, which ProtoDef cannot
// express, so it is a native type (like lpVec3).
const [readVarInt, writeVarInt, sizeOfVarInt] = require('protodef').types.varint
const { PartialReadError } = require('protodef').utils

const ON_GROUND_FLAG = 1
const STEP_COUNT_OFFSET = 1

function readDelta (buffer, offset) {
  if (offset + 6 > buffer.length) throw new PartialReadError()
  return {
    dX: buffer.readInt16BE(offset),
    dY: buffer.readInt16BE(offset + 2),
    dZ: buffer.readInt16BE(offset + 4)
  }
}

function writeDelta (value, buffer, offset) {
  buffer.writeInt16BE(value.dX, offset)
  buffer.writeInt16BE(value.dY, offset + 2)
  buffer.writeInt16BE(value.dZ, offset + 4)
  return offset + 6
}

function readVecDelta (buffer, offset) {
  const { value: properties, size: propertiesSize } = readVarInt(buffer, offset)
  const onGround = (properties & ON_GROUND_FLAG) !== 0
  const stepCount = properties >>> STEP_COUNT_OFFSET
  let cursor = offset + propertiesSize
  if (stepCount === 0) {
    const delta = readDelta(buffer, cursor)
    return { value: { onGround, dX: delta.dX, dY: delta.dY, dZ: delta.dZ }, size: propertiesSize + 6 }
  }
  const steps = []
  for (let i = 0; i < stepCount; i++) {
    const { value: ticks, size: ticksSize } = readVarInt(buffer, cursor)
    cursor += ticksSize
    const delta = readDelta(buffer, cursor)
    cursor += 6
    steps.push({ ticks, dX: delta.dX, dY: delta.dY, dZ: delta.dZ })
  }
  return { value: { onGround, steps }, size: cursor - offset }
}

function isStepped (value) {
  return Array.isArray(value.steps) && value.steps.length > 0
}

function writeVecDelta (value, buffer, offset) {
  const stepCount = isStepped(value) ? value.steps.length : 0
  const properties = (value.onGround ? ON_GROUND_FLAG : 0) | (stepCount << STEP_COUNT_OFFSET)
  offset = writeVarInt(properties, buffer, offset)
  if (stepCount === 0) return writeDelta(value, buffer, offset)
  for (const step of value.steps) {
    offset = writeVarInt(step.ticks, buffer, offset)
    offset = writeDelta(step, buffer, offset)
  }
  return offset
}

function sizeOfVecDelta (value) {
  const stepCount = isStepped(value) ? value.steps.length : 0
  const properties = (value.onGround ? ON_GROUND_FLAG : 0) | (stepCount << STEP_COUNT_OFFSET)
  let size = sizeOfVarInt(properties)
  if (stepCount === 0) return size + 6
  for (const step of value.steps) size += sizeOfVarInt(step.ticks) + 6
  return size
}

module.exports = [readVecDelta, writeVecDelta, sizeOfVecDelta]
