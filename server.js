require('dotenv').config()
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const { PrismaClient } = require('@prisma/client')
const { WAService } = require('./whatsappService')
const jwt = require('jsonwebtoken')

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

const LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArPfXmFNNzOR7bxsPpJ6V
BdovK3uX6+GVSPcKVZfSJypeJ4PfSWea7ZWi2GzMIaNmQE1yF5McGzbq38NDl1zA
Y9Odn9a9Yol0WRgpo2/C7mMqQlwVzt8yvgG6iWX04Kqw2/ZKESc495jec5AErzBc
kXXXxzGtfyUAzkHeg0Da3CtbPwtBC4TR1QwxT6FE08+yxbdqJzCtW+Sp8jGFmwdX
Zt2U3xmqghpABkD67W4EKAO4RAsHXKrBHCf49QEprQIf0r5csnhVzQ9ZNiM64NLI
HJIeR639aAKAyWeir0j4UUp9VAuEKnzMxz+ERtQ5PdDgVHKQnK/618Qxq7b7m3bc
JwIDAQAB
-----END PUBLIC KEY-----`;

function validateLicense(token) {
  try {
    return jwt.verify(token, LICENSE_PUBLIC_KEY, { algorithms: ['RS256'] })
  } catch (e) {
    console.error('❌ JWT verify error:', e.message)
    return null
  }
}

const authMiddleware = (req, res, next) => {
  const headerSecret = req.headers['x-api-secret']
  const bodySecret = req.body?.secret
  if (headerSecret === SECRET || bodySecret === SECRET) return next()
  return res.status(401).json({ error: 'Unauthorized' })
}

async function requireLicense(req, res, next) {
  try {
    const config = await prisma.app_config.findFirst({ where: { key: 'license' } })
    if (!config?.value) return res.status(403).json({ error: 'Licencia no activada' })
    
    const license = validateLicense(config.value)
    if (!license) return res.status(403).json({ error: 'Licencia inválida' })
    
    req.license = license
    next()
  } catch (e) {
    res.status(500).json({ error: 'Error validando licencia' })
  }
}

const waService = new WAService(prisma, io)
waService.init()

io.on('connection', () => console.log('🟢 Socket conectado'))

app.get('/', (_, res) => res.json({ status: 'OK' }))

// ========== LICENCIA ==========
app.post('/api/setup/activate', async (req, res) => {
  const { licenseKey } = req.body
  if (!licenseKey) return res.status(400).json({ error: 'licenseKey required' })

  console.log('🔑 Activando licencia, length:', licenseKey.length)
  const license = validateLicense(licenseKey)
  
  if (!license) {
    console.error('❌ Key inválida')
    return res.status(400).json({ error: 'Licencia inválida' })
  }

  await prisma.app_config.upsert({
    where: { key: 'license' },
    update: { value: licenseKey },
    create: { key: 'license', value: licenseKey }
  })

  console.log('✅ Guardada:', license.tier)
  res.json({ success: true, tier: license.tier, ...license })
})

app.get('/api/license/status', async (req, res) => {
  console.log('📋 GET /api/license/status called')
  
  try {
    // Usamos findFirst en vez de findUnique por si acaso
    const config = await prisma.app_config.findFirst({ where: { key: 'license' } })
    
    console.log('📋 Config found:', config ? 'YES' : 'NO')
    if (config) {
      console.log('📋 Value length:', config.value?.length)
    }
    
    if (!config?.value) {
      console.log('❌ No value found')
      return res.json({ active: false })
    }
    
    const license = validateLicense(config.value)
    if (!license) {
      console.log('❌ validateLicense returned null')
      return res.json({ active: false, invalid: true })
    }
    
    console.log('✅ Active:', license.tier)
    res.json({ active: true, tier: license.tier, ...license })
    
  } catch (e) {
    console.error('💥 Error in /api/license/status:', e)
    res.json({ active: false, error: e.message })
  }
})

// ========== USUARIO ==========
app.get('/api/user', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.usuarios.findFirst()
    res.json({ user })
  } catch (e) {
    res.json({ user: null })
  }
})

app.post('/api/user', authMiddleware, async (req, res) => {
  const { nombre, email } = req.body
  if (!nombre || !email) return res.status(400).json({ error: 'Faltan datos' })
  
  try {
    const existing = await prisma.usuarios.findFirst()
    if (existing) {
      const updated = await prisma.usuarios.update({
        where: { id: existing.id },
        data: { nombre, email }
      })
      return res.json({ success: true, user: updated })
    }
    const user = await prisma.usuarios.create({ data: { nombre, email } })
    res.json({ success: true, user })
  } catch (e) {
    res.status(500).json({ error: 'Error creando usuario' })
  }
})

// ========== LÍNEAS ==========
app.get('/api/lineas', authMiddleware, async (req, res) => {
  try {
    const lines = await prisma.lineas_whatsapp.findMany({ orderBy: { fecha_creacion: 'desc' } })
    res.json({ lines })
  } catch (err) {
    res.status(500).json({ error: 'Error listando líneas' })
  }
})

app.post('/api/lineas', authMiddleware, requireLicense, async (req, res) => {
  const { phone, nombre } = req.body
  if (!phone) return res.status(400).json({ error: 'phone required' })

  try {
    const activeLines = await prisma.lineas_whatsapp.count()
    if (activeLines >= req.license.maxLines) {
      return res.status(403).json({ 
        error: `Límite alcanzado: ${req.license.maxLines} líneas`,
        current: activeLines,
        max: req.license.maxLines
      })
    }

    const existing = await prisma.lineas_whatsapp.findUnique({ where: { phone } })
    if (existing) return res.status(409).json({ error: 'Línea ya existe' })

    const line = await prisma.lineas_whatsapp.create({
      data: { phone, nombre: nombre || 'Nueva Línea', status: 'DESCONECTADA' }
    })
    res.json({ success: true, line })
  } catch (err) {
    res.status(500).json({ error: 'Error creando línea' })
  }
})

app.post('/api/lineas/connect', authMiddleware, async (req, res) => {
  const { phone } = req.body
  if (!phone) return res.status(400).json({ error: 'phone required' })
  try {
    const line = await waService.connect(phone)
    res.json({ message: 'QR generado', lineId: line.id })
  } catch (err) {
    res.status(500).json({ error: 'Fallo al conectar' })
  }
})

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

// ========== CAMPAÑAS ==========
app.post('/api/campaign/send', authMiddleware, async (req, res) => {
  try {
    const { lineId, targets, message, delayMin, delayMax, imageUrl } = req.body
    if (!lineId || !targets || !Array.isArray(targets) || !message) {
      return res.status(400).json({ error: 'Faltan datos' })
    }

    const campaignId = `camp_${Date.now()}`
    res.json({ success: true, campaignId, total: targets.length })

    waService.sendCampaign(lineId, targets, message, {
      delayMin: delayMin || 3000,
      delayMax: delayMax || 8000,
      imageUrl
    }).then(async (results) => {
      const sentCount = results.filter(r => r.status === 'sent').length
      await prisma.campaigns.create({
        data: {
          id: campaignId,
          name: `Campaña ${new Date().toLocaleDateString()}`,
          line_id: lineId,
          message,
          image_url: imageUrl,
          total: targets.length,
          sent: sentCount,
          failed: results.length - sentCount,
          status: 'completed',
          finished_at: new Date()
        }
      }).catch(() => {})
    }).catch(err => console.error('❌ Error campaña:', err))

  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/campaigns', authMiddleware, async (req, res) => {
  try {
    const campaigns = await prisma.campaigns.findMany({ orderBy: { created_at: 'desc' } })
    res.json({ campaigns })
  } catch (e) {
    res.status(500).json({ error: 'Error listando campañas' })
  }
})

server.listen(PORT, () => console.log(`🚀 Mundial Blaster en puerto ${PORT}`))

process.on('uncaughtException', (err) => console.error('🔥 Uncaught:', err))
process.on('unhandledRejection', (reason) => console.error('🔥 Unhandled:', reason))