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
const NodeCache = require('node-cache')
const logger = pino({ level: 'silent' })

class WAService {
  constructor(prisma, io) {
    this.prisma = prisma
    this.io = io
    this.clients = new Map()
    this.reconnectTimers = {}
    this.presenceIntervals = {}
    this.sessionsDir = '/app/sessions'
    this.msgRetryCounterCache = new NodeCache()
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
          await new Promise(r => setTimeout(r, 1500)) // espaciado para no saturar Meta
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

      // Cerrar socket viejo si existe
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
        msgRetryCounterCache: this.msgRetryCounterCache,
        getMessage: async (key) => {
          return { conversation: 'Mundial Blaster' }
        },
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
    // 1. Guardar credenciales
    waClient.ev.on('creds.update', saveCreds)

    // 2. Actualizaciones de conexión
    waClient.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      // ─── QR ───
      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr)
          this.io.emit('qr', { lineId, qr: qrDataUrl })
          await this.prisma.lineas_whatsapp.update({
            where: { id: lineId },
            data: { status: 'PENDING' }
          }).catch(() => {})
          console.log(`📱 QR emitido: ${lineId}`)
        } catch (e) {
          console.error('Error QR:', e)
        }
        return
      }

      // ─── OPEN ───
      if (connection === 'open') {
        console.log(`✅ Conectado: ${lineId}`)

        // Limpiar timer de reconexión si existía
        if (this.reconnectTimers[lineId]) {
          clearTimeout(this.reconnectTimers[lineId])
          delete this.reconnectTimers[lineId]
        }

        // 🔥 KEEP-ALIVE: presence cada 3 minutos para evitar que Meta corte por inactividad
        if (this.presenceIntervals[lineId]) {
          clearInterval(this.presenceIntervals[lineId])
          delete this.presenceIntervals[lineId]
        }

        this.presenceIntervals[lineId] = setInterval(async () => {
          try {
            if (waClient?.ws?.readyState === 1) {
              await waClient.sendPresenceUpdate('available')
            }
          } catch (e) {
            // Silencioso: si falla, la reconexión lo maneja
          }
        }, 180000) // 3 minutos

        this.io.emit('status', { lineId, status: 'CONECTADA' })
        await this.prisma.lineas_whatsapp.update({
          where: { id: lineId },
          data: { status: 'CONECTADA' }
        }).catch(() => {})
        return
      }

      // ─── CLOSE ───
      if (connection === 'close') {
        // Limpiar keep-alive
        if (this.presenceIntervals[lineId]) {
          clearInterval(this.presenceIntervals[lineId])
          delete this.presenceIntervals[lineId]
        }

        const statusCode = lastDisconnect?.error?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut

        console.log(`❌ Desconectado ${lineId}. Razón: ${statusCode}`)

        // 401 = Unauthorized: sesión invalidada por WhatsApp. Requiere QR nuevo.
        if (statusCode === 401) {
          console.log(`🔒 Sesión invalidada (401). Requiere reescanear QR.`)
          await fs.remove(path.join(this.sessionsDir, String(lineId))).catch(() => {})
          this.clients.delete(lineId)
          await this.prisma.lineas_whatsapp.update({
            where: { id: lineId },
            data: { status: 'DESCONECTADA' }
          }).catch(() => {})
          this.io.emit('status', { lineId, status: 'DESCONECTADA', reason: 'SESSION_INVALID' })
          return
        }

        // Reconexión inteligente para el resto
        if (shouldReconnect) {
          if (this.reconnectTimers[lineId]) clearTimeout(this.reconnectTimers[lineId])

          let delay = 5000 // default
          if (statusCode === 503 || statusCode === 428 || statusCode === 515) {
            delay = 15000 // errores de servidor/saturación/stream
          } else if (statusCode === 408) {
            delay = 8000  // timeout
          } else if (statusCode === 440) {
            delay = 10000 // connection replaced
          }

          console.log(`⏳ Reconectando ${lineId} en ${delay / 1000}s...`)

          this.reconnectTimers[lineId] = setTimeout(async () => {
            try {
              this.clients.delete(lineId)
              await this.connect(phone)
              delete this.reconnectTimers[lineId]
            } catch (e) {
              console.error(`❌ Falló reconexión ${lineId}:`, e)
            }
          }, delay)
        } else {
          // Logout definitivo
          console.log(`⚠️ Logout permanente ${lineId}`)
          await fs.remove(path.join(this.sessionsDir, String(lineId))).catch(() => {})
          this.clients.delete(lineId)
          await this.prisma.lineas_whatsapp.update({
            where: { id: lineId },
            data: { status: 'DESCONECTADA' }
          }).catch(() => {})
          this.io.emit('status', { lineId, status: 'DESCONECTADA', reason: 'LOGOUT' })
        }
      }
    })

    // 3. Mensajes entrantes: ignoramos todo (modo emisor puro)
    waClient.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue
        // Modo emisor puro: no procesamos nada entrante
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

  

  async sendCampaign(campaignId, lineId, targets, message, options = {}) {
  const { delayMin = 3000, delayMax = 8000, imageUrl = null } = options

  // Marcar como running
  await this.prisma.campaigns.update({
    where: { id: campaignId },
    data: { status: 'running' }
  }).catch(() => {})

  const results = []

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]
    try {
      const resolvedMessage = resolveSpintax(message)
const personalized = resolvedMessage
  .replace(/\{\{nombre\}\}/gi, target.name || 'Cliente')
  .replace(/\{nombre\}/gi, target.name || 'Cliente')
  .replace(/\{\{telefono\}\}/gi, target.phone || '')
  .replace(/\{telefono\}/gi, target.phone || '')

      await this.sendMessage(lineId, target.phone, personalized, {
        type: imageUrl ? 'image' : 'text',
        imageUrl
      })

      results.push({ phone: target.phone, status: 'sent', index: i })

      // Incrementar sent
      await this.prisma.campaigns.update({
        where: { id: campaignId },
        data: { sent: { increment: 1 } }
      }).catch(() => {})

      // Log individual
      await this.prisma.campaign_logs.create({
        data: {
          campaign_id: campaignId,
          contact_phone: target.phone,
          status: 'sent'
        }
      }).catch(() => {})

      console.log(`✅ ${i + 1}/${targets.length} → ${target.phone}`)
    } catch (err) {
      results.push({ phone: target.phone, status: 'failed', error: err.message, index: i })

      await this.prisma.campaigns.update({
        where: { id: campaignId },
        data: { failed: { increment: 1 } }
      }).catch(() => {})

      await this.prisma.campaign_logs.create({
        data: {
          campaign_id: campaignId,
          contact_phone: target.phone,
          status: 'failed',
          error: err.message?.slice(0, 200)
        }
      }).catch(() => {})

      console.error(`❌ ${target.phone}:`, err.message)
    }

    if (i < targets.length - 1) {
      const delay = Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin
      await new Promise(r => setTimeout(r, delay))
    }
  }

  // Finalizar
  await this.prisma.campaigns.update({
    where: { id: campaignId },
    data: { status: 'completed', finished_at: new Date() }
  }).catch(() => {})

  return results
}

  async logout(lineId) {
    // Limpiar timers/intervals antes de todo
    if (this.reconnectTimers[lineId]) {
      clearTimeout(this.reconnectTimers[lineId])
      delete this.reconnectTimers[lineId]
    }
    if (this.presenceIntervals[lineId]) {
      clearInterval(this.presenceIntervals[lineId])
      delete this.presenceIntervals[lineId]
    }

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



// 🧹 Cleanup graceful al recibir SIGTERM (Railway reinicia containers)
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM recibido. Limpiando timers y sockets...')
  // Nota: no podemos acceder a la instancia desde aquí, pero los timers
  // se limpian automáticamente al morir el proceso. Esto es más que nada
  // para logs limpios.
  process.exit(0)
})

module.exports = { WAService }