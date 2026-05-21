require('dotenv').config()
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const { PrismaClient } = require('@prisma/client')
const { WAService } = require('./whatsappService')

const PORT = process.env.PORT || 8080
const SECRET = process.env.WHATSAPP_SECRET

const prisma = new PrismaClient()
const app = express()
const server = http.createServer(app)
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
})

app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ limit: '50mb', extended: true }))

const authMiddleware = (req, res, next) => {
  const headerSecret = req.headers['x-api-secret']
  const bodySecret = req.body?.secret
  if (headerSecret === SECRET || bodySecret === SECRET) return next()
  return res.status(401).json({ error: 'Unauthorized' })
}

const waService = new WAService(prisma, io)
waService.init()

io.on('connection', () => console.log('🟢 Socket conectado'))

app.get('/', (_, res) => res.json({ status: 'OK', service: 'Mundial Blaster' }))

// Conectar línea (genera QR)
app.post('/api/lineas/connect', authMiddleware, async (req, res) => {
  const { phone } = req.body
  if (!phone) return res.status(400).json({ error: 'phone required' })
  try {
    const line = await waService.connect(phone)
    res.json({ message: 'QR generado. Escanea desde el panel.', lineId: line.id })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Fallo al conectar' })
  }
})

// Enviar mensaje individual (test)
app.post('/api/send-message', authMiddleware, async (req, res) => {
  try {
    const { lineId, contactPhone, content, type, imageUrl } = req.body
    if (!lineId || !contactPhone || !content) {
      return res.status(400).json({ error: 'Faltan datos' })
    }
    const result = await waService.sendMessage(lineId, contactPhone, content, { type, imageUrl })
    res.json(result)
  } catch (error) {
    console.error('❌ Error enviando:', error)
    res.status(500).json({ error: error.message })
  }
})

// CAMPAÑA MASIVA
app.post('/api/campaign/send', authMiddleware, async (req, res) => {
  try {
    const { lineId, targets, message, delayMin, delayMax, imageUrl } = req.body
    if (!lineId || !targets || !Array.isArray(targets) || !message) {
      return res.status(400).json({ error: 'Faltan datos de campaña' })
    }
    const campaignId = `camp_${Date.now()}`
    res.json({ success: true, campaignId, message: 'Campaña iniciada', total: targets.length })

    // Procesamos en background
    const results = await waService.sendCampaign(lineId, targets, message, {
      delayMin: delayMin || 3000,
      delayMax: delayMax || 8000,
      imageUrl
    })

    // Guardar logs en DB
    try {
      for (const r of results) {
        await prisma.campaign_logs.create({
          data: {
            campaign_id: campaignId,
            contact_phone: r.phone,
            status: r.status,
            line_id: lineId,
            owner_id: req.body.userId || 'system',
            sent_at: r.status === 'sent' ? new Date() : null
          }
        }).catch(() => {})
      }
    } catch (e) {
      console.error('Error guardando logs:', e)
    }

    const sentCount = results.filter(r => r.status === 'sent').length
    console.log(`🏁 Campaña ${campaignId} finalizada. Enviados: ${sentCount}/${results.length}`)
  } catch (error) {
    console.error('❌ Error campaña:', error)
    res.status(500).json({ error: error.message })
  }
})

// Logout
app.post('/api/lineas/logout', authMiddleware, async (req, res) => {
  const { lineId } = req.body
  if (!lineId) return res.status(400).json({ error: 'lineId required' })
  try {
    await waService.logout(lineId)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// LISTAR LÍNEAS (para el frontend)
app.get('/api/lineas', authMiddleware, async (req, res) => {
  try {
    const lines = await prisma.lineas_whatsapp.findMany({
      orderBy: { fecha_creacion: 'desc' }
    })
    res.json({ lines })
  } catch (err) {
    console.error('Error listando líneas:', err)
    res.status(500).json({ error: 'Error listando líneas' })
  }
})

server.listen(PORT, () => console.log(`🚀 Mundial Blaster en puerto ${PORT}`))

process.on('uncaughtException', (err) => console.error('🔥 Uncaught:', err))
process.on('unhandledRejection', (reason) => console.error('🔥 Unhandled:', reason))
