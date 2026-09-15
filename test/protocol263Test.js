/* eslint-env mocha */
// 26.3 (protocol 777) wire pins: the VecDelta native against hand-built bytes
// (net.minecraft.network.protocol.game.VecDelta / ClientboundMoveEntityPacket),
// the stepped PositionPath, and every data component payload 26.3 introduced -
// packetTest.js never exercises component payloads (its Slot value carries no
// components), so they get a round trip of their own here.
const assert = require('assert')
const { createSerializer, createDeserializer, states } = require('minecraft-protocol')
const [readVecDelta, writeVecDelta, sizeOfVecDelta] = require('../src/datatypes/vecDelta')

const VERSION = '26.3'
const nbtText = (text) => ({ type: 'string', value: text })

describe('26.3 wire (protocol 777)', function () {
  let serializer, deserializer
  before(() => {
    serializer = createSerializer({ state: states.PLAY, version: VERSION, isServer: true })
    deserializer = createDeserializer({ state: states.PLAY, version: VERSION })
  })

  function cycle (name, params) {
    const buffer = serializer.createPacketBuffer({ name, params })
    const parsed = deserializer.parsePacketBuffer(buffer)
    assert.strictEqual(parsed.metadata.size, buffer.length, `${name}: the whole frame is consumed`)
    assert.strictEqual(parsed.data.name, name)
    const again = serializer.createPacketBuffer({ name, params: parsed.data.params })
    assert.ok(buffer.equals(again), `${name}: serialize -> parse -> serialize is byte-stable`)
    return parsed.data.params
  }

  describe('VecDelta native', function () {
    it('reads the linear form: properties varint (bit 0 onGround, stepCount 0) then dX, dY, dZ i16', function () {
      // properties 0x01 (onGround, 0 steps), dX 0x1000 (= 1 block), dY 0xfe00 (-512), dZ 0x000c
      const buf = Buffer.from('01 1000 fe00 000c'.replace(/ /g, ''), 'hex')
      const { value, size } = readVecDelta(buf, 0)
      assert.deepStrictEqual(value, { onGround: true, dX: 4096, dY: -512, dZ: 12 })
      assert.strictEqual(size, 7)
      assert.strictEqual(sizeOfVecDelta(value), 7)
      const out = Buffer.alloc(7)
      assert.strictEqual(writeVecDelta(value, out, 0), 7)
      assert.ok(out.equals(buf))
    })
    it('reads the stepped form: stepCount = properties >>> 1, then stepCount x { ticks varint, dX, dY, dZ i16 }', function () {
      // properties 0x04 = onGround false, stepCount 2; step 1: ticks 1, (1, 0, -1); step 2: ticks 0x80 (varint 80 01), (2, 2, 2)
      const buf = Buffer.from('04 01 0001 0000 ffff 8001 0002 0002 0002'.replace(/ /g, ''), 'hex')
      const { value, size } = readVecDelta(buf, 0)
      assert.deepStrictEqual(value, {
        onGround: false,
        steps: [{ ticks: 1, dX: 1, dY: 0, dZ: -1 }, { ticks: 128, dX: 2, dY: 2, dZ: 2 }]
      })
      assert.strictEqual(size, buf.length)
      assert.strictEqual(sizeOfVecDelta(value), buf.length)
      const out = Buffer.alloc(buf.length)
      assert.strictEqual(writeVecDelta(value, out, 0), buf.length)
      assert.ok(out.equals(buf))
    })
    it('packs onGround into bit 0 alongside the step count', function () {
      const value = { onGround: true, steps: [{ ticks: 0, dX: 0, dY: 0, dZ: 0 }] }
      const out = Buffer.alloc(sizeOfVecDelta(value))
      writeVecDelta(value, out, 0)
      assert.strictEqual(out[0], 0x03) // 1 | (1 << 1)
    })
    it('reads a stepped delta from a partial frame as a PartialReadError, not garbage', function () {
      const buf = Buffer.from('04 01 0001 0000'.replace(/ /g, ''), 'hex') // stepCount 2, one and a half steps present
      assert.throws(() => readVecDelta(buf, 0), (e) => e.partialReadError === true)
    })
    it('rel_entity_move and entity_move_look carry the delta on the wire (linear + stepped)', function () {
      const linear = cycle('rel_entity_move', { entityId: 7, delta: { onGround: true, dX: 4096, dY: 0, dZ: -4096 } })
      assert.deepStrictEqual(linear.delta, { onGround: true, dX: 4096, dY: 0, dZ: -4096 })
      const stepped = cycle('entity_move_look', {
        entityId: 7,
        delta: { onGround: false, steps: [{ ticks: 1, dX: 10, dY: 0, dZ: 0 }, { ticks: 2, dX: 0, dY: 10, dZ: 0 }] },
        yaw: -64,
        pitch: 12
      })
      assert.strictEqual(stepped.delta.steps.length, 2)
      assert.strictEqual(stepped.yaw, -64)
      assert.strictEqual(stepped.pitch, 12)
      const bytes = serializer.createPacketBuffer({ name: 'rel_entity_move', params: { entityId: 7, delta: { onGround: true, dX: 4096, dY: 0, dZ: -4096 } } })
      assert.strictEqual(bytes.toString('hex'), '36' + '07' + '01' + '1000' + '0000' + 'f000') // 0x36 = move_entity_pos in 26.3 (Mojang packets.json)
    })
    it('entity_look carries onGround before yaw/pitch', function () {
      const bytes = serializer.createPacketBuffer({ name: 'entity_look', params: { entityId: 7, onGround: true, yaw: 1, pitch: 2 } })
      assert.strictEqual(bytes.toString('hex'), '39' + '07' + '01' + '01' + '02') // 0x39 = move_entity_rot in 26.3
    })
  })

  describe('PositionPath', function () {
    it('linear', function () {
      const p = cycle('sync_entity_position', { entityId: 3, position: { pathType: 'linear', path: { x: 1.5, y: 64, z: -2.25 } }, yaw: 90, pitch: 0, onGround: true })
      assert.deepStrictEqual(p.position, { pathType: 'linear', path: { x: 1.5, y: 64, z: -2.25 } })
    })
    it('stepped', function () {
      const steps = [{ position: { x: 1, y: 2, z: 3 }, tickOffset: 1 }, { position: { x: 2, y: 2, z: 3 }, tickOffset: 3 }]
      const p = cycle('sync_entity_position', { entityId: 3, position: { pathType: 'stepped', path: steps }, yaw: 0, pitch: 0, onGround: false })
      assert.deepStrictEqual(p.position.path, steps)
    })
  })

  describe('packets reshaped in 26.3', function () {
    it('world_particles: particle first, three velocity offsets, varint count, randomization', function () {
      const p = cycle('world_particles', {
        particle: { particleId: 5, data: null },
        longDistance: false,
        alwaysShow: true,
        x: 1,
        y: 2,
        z: 3,
        offsetX: 0.5,
        offsetY: 0.5,
        offsetZ: 0.5,
        velocityOffsetX: 0.25,
        velocityOffsetY: 0,
        velocityOffsetZ: 0,
        amount: 300,
        randomization: 'alternative_with_speed'
      })
      assert.strictEqual(p.amount, 300)
      assert.strictEqual(p.randomization, 'alternative_with_speed')
    })
    it('swing_animation, add_transient_block, post_effects, explosion.playSound', function () {
      assert.deepStrictEqual(cycle('swing_animation', { entityId: 9, hand: 1, animation: { type: 'stab', duration: 4 } }).animation, { type: 'stab', duration: 4 })
      assert.strictEqual(cycle('add_transient_block', { location: { x: 1, y: 2, z: 3 }, blockState: 28 }).blockState, 28)
      assert.deepStrictEqual(cycle('post_effects', { postEffects: ['minecraft:spider', 'minecraft:creeper'] }).postEffects, ['minecraft:spider', 'minecraft:creeper'])
      const explosion = cycle('explosion', {
        center: { x: 0, y: 0, z: 0 }, radius: 4, blockCount: 0, playerKnockback: undefined, explosionParticle: { particleId: 0, data: null }, sound: { soundId: 1 }, blockParticles: [], playSound: true
      })
      assert.strictEqual(explosion.playSound, true)
    })
    it('serverbound: punch is empty, update_sign carries the slot after the lines, teleport_confirm echoes the position', function () {
      const s = createSerializer({ state: states.PLAY, version: VERSION, isServer: false })
      const d = createDeserializer({ state: states.PLAY, version: VERSION, isServer: true })
      const punch = s.createPacketBuffer({ name: 'punch', params: {} })
      assert.strictEqual(punch.toString('hex'), '2e')
      const sign = s.createPacketBuffer({ name: 'update_sign', params: { location: { x: 0, y: 0, z: 0 }, text1: 'a', text2: '', text3: '', text4: '', isFrontText: true } })
      assert.strictEqual(sign.toString('hex').slice(-2), '01', 'the SignTextSlot varint (1 = front) is the last byte')
      const tc = s.createPacketBuffer({ name: 'teleport_confirm', params: { teleportId: 5, x: 1, y: 2, z: 3, yaw: 0, pitch: 0 } })
      assert.strictEqual(tc.length, 1 + 1 + 24 + 8)
      assert.strictEqual(d.parsePacketBuffer(tc).data.params.z, 3)
    })
  })

  describe('data components new in 26.3', function () {
    function slotWith (components) {
      return { itemCount: 1, itemId: 1, addedComponentCount: components.length, removedComponentCount: 0, components, removeComponents: [] }
    }
    function roundTrip (components) {
      const p = cycle('set_slot', { windowId: 0, stateId: 1, slot: 0, item: slotWith(components) })
      return p.item.components
    }
    it('attack_animation / interact_animation (SwingAnimation)', function () {
      const c = roundTrip([{ type: 'attack_animation', data: { type: 'whack', duration: 6 } }, { type: 'interact_animation', data: { type: 'none', duration: 0 } }])
      assert.deepStrictEqual(c.map(x => x.data), [{ type: 'whack', duration: 6 }, { type: 'none', duration: 0 }])
    })
    it('villager_food, compostable, cooking_fuel, brewing_fuel (Resolvable either: true = constant, false = reference key)', function () {
      const c = roundTrip([
        { type: 'villager_food', data: { nutrition: 4 } },
        { type: 'compostable', data: { layers: { isConstant: true, value: 3 } } },
        { type: 'cooking_fuel', data: { burnTime: { isConstant: false, value: 'minecraft:fuel/coal' }, speedMultiplier: { isConstant: true, value: 1.5 } } },
        { type: 'brewing_fuel', data: { uses: { isConstant: true, value: 20 }, speedMultiplier: { isConstant: false, value: 'minecraft:brewing/fast' } } }
      ])
      assert.deepStrictEqual(c[1].data, { layers: { isConstant: true, value: 3 } })
      assert.deepStrictEqual(c[2].data.burnTime, { isConstant: false, value: 'minecraft:fuel/coal' })
      assert.strictEqual(c[3].data.uses.value, 20)
    })
    it('mob_visibility, provides_pottery_pattern, waxed, cushion/color', function () {
      const c = roundTrip([
        { type: 'mob_visibility', data: { targetingEntityTypes: { ids: [2, 5] }, visibility: 0.5 } },
        { type: 'provides_pottery_pattern', data: 7 },
        { type: 'waxed', data: undefined },
        { type: 'cushion/color', data: 'lime' }
      ])
      assert.deepStrictEqual(c[0].data.targetingEntityTypes, { ids: [2, 5] })
      assert.strictEqual(c[1].data, 7)
      assert.strictEqual(c[3].data, 'lime')
    })
    it('sign_text_front / sign_text_back (SignText)', function () {
      const text = { messages: [nbtText('a'), nbtText('b'), nbtText('c'), nbtText('d')], filteredMessages: undefined, color: 'red', hasGlowingText: true }
      const c = roundTrip([{ type: 'sign_text_front', data: text }, { type: 'sign_text_back', data: { ...text, filteredMessages: [nbtText(''), nbtText(''), nbtText(''), nbtText('')] } }])
      assert.strictEqual(c[0].data.color, 'red')
      assert.strictEqual(c[0].data.hasGlowingText, true)
      assert.strictEqual(c[0].data.messages[1].value, 'b')
      assert.strictEqual(c[1].data.filteredMessages.length, 4)
    })
    it('block_transformer is a registry id (ByteBufCodecs.holderRegistry: the block_transformer dynamic registry, no inline form)', function () {
      const c = roundTrip([{ type: 'block_transformer', data: 2 }])
      assert.strictEqual(c[0].data, 2)
      const slot = serializer.createPacketBuffer({ name: 'set_slot', params: { windowId: 0, stateId: 1, slot: 0, item: slotWith([{ type: 'block_transformer', data: 0 }]) } })
      assert.strictEqual(slot.toString('hex').slice(-4), '2b00', 'component id 43 then the varint registry id')
    })
    it('the component table has 122 ids in the 26.3 DataComponents order', function () {
      const mcData = require('minecraft-data')(VERSION)
      const mappings = mcData.protocol.types.SlotComponentType[1].mappings
      assert.strictEqual(Object.keys(mappings).length, 122)
      assert.strictEqual(mappings[40], 'attack_animation')
      assert.strictEqual(mappings[41], 'interact_animation')
      assert.strictEqual(mappings[43], 'block_transformer')
      assert.strictEqual(mappings[87], 'mob_visibility')
      assert.strictEqual(mappings[121], 'cushion/color')
      assert.ok(!Object.values(mappings).includes('map_color'))
    })
  })

  describe('payloads that changed shape in 26.3 (found on a live 26.3 server, javap-verified on the release jar)', function () {
    function slotWith (components) {
      return { itemCount: 1, itemId: 1, addedComponentCount: components.length, removedComponentCount: 0, components, removeComponents: [] }
    }
    const template = (itemId) => ({ itemId, count: 1, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] })
    // the decorated-pot advancement icon as the server wrote it: ItemStackTemplate { decorated_pot (392), count 1, +1 component: pot_decorations
    // { back: none, left: sherd 1609, right: none, front: sherd 1605 } } - PotDecorations.STREAM_CODEC is four optional ItemStackTemplate sides
    const realIcon = '880301010' + '04c' + '00' + '01c90c010000' + '00' + '01c50c010000'
    const potSides = { back: undefined, left: template(1609), right: undefined, front: template(1605) }
    it('pot_decorations: four optional ItemStackTemplate sides (back, left, right, front), no longer a varint id list', function () {
      const buffer = serializer.createPacketBuffer({ name: 'set_slot', params: { windowId: 0, stateId: 1, slot: 0, item: slotWith([{ type: 'pot_decorations', data: potSides }]) } })
      assert.ok(buffer.toString('hex').endsWith('4c' + '00' + '01c90c010000' + '00' + '01c50c010000'), 'component id 76 then the four optional sides as the 26.3 server writes them')
      const parsed = deserializer.parsePacketBuffer(buffer)
      assert.strictEqual(parsed.metadata.size, buffer.length)
      assert.deepStrictEqual(parsed.data.params.item.components[0].data, potSides)
    })
    it('advancements: DisplayInfo.icon is an ItemStackTemplate (item id, count, component patch), the tree position rides the entry', function () {
      const entry = {
        key: 'minecraft:adventure/craft_decorated_pot_using_only_sherds',
        value: {
          parentId: 'minecraft:adventure/salvage_sherd',
          displayData: {
            title: nbtText('t'),
            description: nbtText('d'),
            icon: { ...template(392), addedComponentCount: 1, components: [{ type: 'pot_decorations', data: potSides }] },
            frameType: 0,
            flags: { unused: 0, hidden: 0, show_toast: 1, has_background_texture: 0 },
            backgroundTexture: undefined
          },
          requirements: [['pot_crafted_using_only_sherds']],
          sendsTelemtryData: true
        },
        xCord: 2,
        yCord: 16.5
      }
      const params = { reset: true, advancementMapping: [entry], identifiers: [], progressMapping: [], showAdvancements: false }
      const buffer = serializer.createPacketBuffer({ name: 'advancements', params })
      assert.ok(buffer.toString('hex').includes(realIcon), 'the icon bytes are the server\'s: 8803 (decorated_pot) 01 (count) 01 00 (patch counts) 4c (pot_decorations) + sides')
      // ... followed by frame 00, flags 00000002, requirements, telemetry, then x/y as f32 at the ENTRY level (PositionedAdvancement)
      assert.ok(buffer.toString('hex').includes(realIcon + '00' + '00000002' + '01' + '01' + '1d' + Buffer.from('pot_crafted_using_only_sherds').toString('hex') + '01' + '40000000' + '41840000'))
      const back = cycle('advancements', params)
      assert.deepStrictEqual(back.advancementMapping[0].value.displayData.icon.components[0].data, potSides)
      assert.strictEqual(back.advancementMapping[0].xCord, 2)
      assert.strictEqual(back.advancementMapping[0].value.displayData.xCord, undefined, 'x/y no longer live in DisplayInfo')
    })
    it('trim: the inline TrimMaterial is one asset id + description (26.2 carried a MaterialAssetGroup with per-armor overrides)', function () {
      const material = { data: { assetId: 'minecraft:quartz', description: nbtText('Quartz') } } // registryEntryHolder: no materialId = inline (id byte 0) followed by the data
      const buffer = serializer.createPacketBuffer({ name: 'set_slot', params: { windowId: 0, stateId: 1, slot: 0, item: slotWith([{ type: 'trim', data: { material, pattern: { patternId: 3 } } }]) } })
      const hex = buffer.toString('hex')
      assert.ok(hex.includes('00' + '10' + Buffer.from('minecraft:quartz').toString('hex') + '08' + '0006' + Buffer.from('Quartz').toString('hex') + '04'), 'inline id 0, the asset id string, the description NBT string, then the pattern as registry id + 1')
      const parsed = deserializer.parsePacketBuffer(buffer)
      assert.strictEqual(parsed.metadata.size, buffer.length)
      assert.deepStrictEqual(parsed.data.params.item.components[0].data.material, material)
    })
  })
})
