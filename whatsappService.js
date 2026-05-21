const {
  makeWASocket,
  useMultiFileAuthState,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys')
const pino = require('pino')
const fs = require('fs-extra')
const path = require('path')
const QRCode = require('qrcode')
const logger = pino({ level: 'silent' })

class WAService {
  constructor(prisma, io) {
    this.prisma = prisma
    this.io = io
    this.clients = new Map()
    this.reconnectTimers = {}
    this.sessionsDir = path.join(process.cwd(), 'sessions')
    fs.ensureDirSync(this.sessionsDir)
  }

  async init() {
    console.log('✅ Mundial Blaster WAService inicializado')
    try {
      const lines = await this.prisma.lineas_whatsapp.findMany({
        where: { status: 'CONECTADA' }
      })
      for (const line of lines) {
        if (line.phone) {
          await this.connect(line.phone).catch(e => console.error(e))
          await new Promise(r => setTimeout(r, 1000))
        }
      }
    } catch (e) {
      console.error('Error init:', e)
    }
  }

  async connect(phone) {
    try {
      let line = await this.prisma.lineas_whatsapp.findUnique({ where: { phone } })
      if (!line) {
        console.warn(`⚠️ Línea no registrada: ${phone}`)
        return
      }
      const lineId = line.id
      const sessionPath = path.join(this.sessionsDir, String(lineId))
      const existing = this.clients.get(lineId)
      if (existing) {
        try { existing.ws?.close() } catch {}
        this.clients.delete(lineId)
      }

      await fs.ensureDir(sessionPath)
      const { state, saveCreds } = await useMultiFileAuthState(sessionPath)
      const { version } = await fetchLatestBaileysVersion()

      const waClient = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: ['MundialBlaster', 'Chrome', '120.0.0'],
        msgRetryCounterCache: new (require('node-cache'))(),
        getMessage: async () => ({ conversation: 'Mundial Blaster' }),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        retryRequestDelayMs: 3000,
        defaultQueryTimeoutMs: 60000,
      })

      this.clients.set(lineId, waClient)
      this.setupEvents(waClient, lineId, phone, saveCreds)
      return line
    } catch (err) {
      console.error('❌ Error connect:', err)
      throw err
    }
  }

  setupEvents(waClient, lineId, phone, saveCreds) {
    waClient.ev.on('creds.update', saveCreds)

    waClient.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr)
          this.io.emit('qr', { lineId, qr: qrDataUrl })
          await this.prisma.lineas_whatsapp.update({
            where: { id: lineId },
            data: { status: 'PENDING' }
          }).catch(() => {})
        } catch (e) {
          console.error('Error QR:', e)
        }
      }

      if (connection === 'open') {
        console.log(`✅ Conectado: ${lineId}`)
        this.io.emit('status', { lineId, status: 'CONECTADA' })
        await this.prisma.lineas_whatsapp.update({
          where: { id: lineId },
          data: { status: 'CONECTADA' }
        }).catch(() => {})
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut
        console.log(`❌ Desconectado ${lineId}. Razón: ${statusCode}`)

        if (shouldReconnect) {
          if (this.reconnectTimers[lineId]) clearTimeout(this.reconnectTimers[lineId])
          const delay = (statusCode === 503 || statusCode === 428) ? 15000 : 5000
          this.reconnectTimers[lineId] = setTimeout(() => {
            this.connect(phone).catch(e => console.error('Reconexión fallida:', e))
            delete this.reconnectTimers[lineId]
          }, delay)
        } else {
          await fs.remove(path.join(this.sessionsDir, String(lineId))).catch(() => {})
          this.clients.delete(lineId)
          await this.prisma.lineas_whatsapp.update({
            where: { id: lineId },
            data: { status: 'DESCONECTADA' }
          }).catch(() => {})
        }
      }
    })

    // Solo log de mensajes entrantes, no procesamos nada (modo emisor puro)
    waClient.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue
        // Ignoramos todo lo entrante. Este es un software de ENVÍO.
      }
    })
  }

  cleanJid(jid) {
    if (!jid) return ''
    return jid.split('@')[0].split(':')[0].replace(/\D/g, '')
  }

  async sendMessage(lineId, contactPhone, content, options = {}) {
    const { type = 'text', imageUrl = null } = options
    let waClient = this.clients.get(lineId) || this.clients.get(String(lineId))
    if (!waClient || !waClient.user) throw new Error('Línea no conectada')

    try {
      const cleanNumber = this.cleanJid(contactPhone)
      const isGroup = cleanNumber.length > 15
      const jid = isGroup ? `${cleanNumber}@g.us` : `${cleanNumber}@s.whatsapp.net`

      let messagePayload = {}
      if (type === 'image' && imageUrl) {
        messagePayload = { image: { url: imageUrl }, caption: content || '' }
      } else {
        messagePayload = { text: content }
      }

      await waClient.sendMessage(jid, messagePayload)
      return { success: true }
    } catch (error) {
      console.error('❌ Error sendMessage:', error)
      throw error
    }
  }

  async sendCampaign(lineId, targets, message, options = {}) {
    const { delayMin = 3000, delayMax = 8000, imageUrl = null } = options
    const results = []
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]
      try {
        const personalized = message
          .replace(/\{nombre\}/gi, target.name || '')
          .replace(/\{telefono\}/gi, target.phone || '')
        await this.sendMessage(lineId, target.phone, personalized, {
          type: imageUrl ? 'image' : 'text',
          imageUrl
        })
        results.push({ phone: target.phone, status: 'sent', index: i })
        console.log(`✅ ${i + 1}/${targets.length} → ${target.phone}`)
      } catch (err) {
        results.push({ phone: target.phone, status: 'failed', error: err.message, index: i })
        console.error(`❌ ${target.phone}:`, err.message)
      }
      if (i < targets.length - 1) {
        const delay = Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin
        await new Promise(r => setTimeout(r, delay))
      }
    }
    return results
  }

  async logout(lineId) {
    const client = this.clients.get(lineId)
    if (client) {
      try { await client.logout() } catch {}
      this.clients.delete(lineId)
    }
    await fs.remove(path.join(this.sessionsDir, String(lineId))).catch(() => {})
    await this.prisma.lineas_whatsapp.update({
      where: { id: lineId },
      data: { status: 'DESCONECTADA' }
    }).catch(() => {})
    return { success: true }
  }
}

module.exports = { WAService }
