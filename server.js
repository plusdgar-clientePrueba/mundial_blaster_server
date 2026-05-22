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

// 🔑 CLAVE PÚBLICA (completa)
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
    const decoded = jwt.verify(token, LICENSE_PUBLIC_KEY, { algorithms: ['RS256'] })
    console.log('✅ Licencia válida:', decoded.tier)
    return decoded
  } catch (e) {
    console.error('❌ validateLicense error:', e.message)
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
    const config = await prisma.app_config.findUnique({ where: { key: 'license' } })
    if (!config?.value) {
      return res.status(403).json({ error: 'Licencia no activada' })
    }
    const license = validateLicense(config.value)
    if (!license) {
      return res.status(403).json({ error: 'Licencia inválida' })
    }
    req.license = license
    next()
  } catch (e) {
    res.status(500).json({ error: 'Error validando licencia' })
  }
}

const waService = new WAService(prisma, io)
waService.init()

io.on('connection', () => console.log('🟢 Socket conectado'))

app.get('/', (_, res) => res.json({ status: 'OK', service: 'Mundial Blaster' }))

// ========== LICENCIA (con logs de debug) ==========
app.post('/api/setup/activate', async (req, res) => {
  const { licenseKey } = req.body
  console.log('🔑 Activando licencia, key length:', licenseKey?.length)
  
  if (!licenseKey) return res.status(400).json({ error: 'licenseKey required' })

  const license = validateLicense(licenseKey)
  if (!license) {
    console.error('❌ Key inválida al activar')
    return res.status(400).json({ error: 'Licencia inválida' })
  }

  await prisma.app_config.upsert({
    where: { key: 'license' },
    update: { value: licenseKey },
    create: { key: 'license', value: licenseKey }
  })

  console.log('✅ Licencia guardada en DB:', license.tier)
  res.json({ success: true, tier: license.tier, features: license })
})

app.get('/api/license/status', async (req, res) => {
  console.log('📋 Consultando licencia...')
  const config = await prisma.app_config.findUnique({ where: { key: 'license' } })
  
  console.log('📋 Config encontrada:', config ? 'SÍ' : 'NO')
  if (config) {
    console.log('📋 Value length:', config.value?.length)
    console.log('📋 Value primeros 50 chars:', config.value?.substring(0, 50))
  }
  
  if (!config?.value) {
    console.log('❌ No hay value en config')
    return res.json({ active: false })
  }
  
  const license = validateLicense(config.value)
  if (!license) {
    console.log('❌ validateLicense devolvió null')
    return res.json({ active: false, invalid: true })
  }
  
  console.log('✅ Licencia activa:', license.tier)
  res.json({ active: true, tier: license.tier, ...license })
})

// ========== USUARIO (Onboarding) ==========
app.get('/api/user', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.usuarios.findFirst()
    res.json({ user })
  } catch (e) {
    console.error('Error /api/user:', e)
    res.json({ user: null })
  }
})

app.post('/api/user', authMiddleware, async (req, res) => {
  const { nombre, email, avatar } = req.body
  if (!nombre || !email) {
    return res.status(400).json({ error: 'Nombre y email requeridos' })
  }
  try {
    const existing = await prisma.usuarios.findFirst()
    if (existing) {
      const updated = await prisma.usuarios.update({
        where: { id: existing.id },
        data: { nombre, email, avatar }
      })
      return res.json({ success: true, user: updated })
    }
    const user = await prisma.usuarios.create({
      data: { nombre, email, avatar }
    })
    res.json({ success: true, user })
  } catch (e) {
    console.error('Error creando usuario:', e)
    res.status(500).json({ error: 'Error creando usuario' })
  }
})

// ========== LÍNEAS (sin is_archived, sin userId) ==========
app.get('/api/lineas', authMiddleware, async (req, res) => {
  try {
    const lines = await prisma.lineas_whatsapp.findMany({
      orderBy: { fecha_creacion: 'desc' }
    })
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
        error: `Límite alcanzado: ${req.license.maxLines} líneas permitidas`,
        current: activeLines,
        max: req.license.maxLines
      })
    }

    const existing = await prisma.lineas_whatsapp.findUnique({ where: { phone } })
    if (existing) return res.status(409).json({ error: 'Línea ya existe' })

    const line = await prisma.lineas_whatsapp.create({
      data: {
        phone,
        nombre: nombre || 'Nueva Línea',
        status: 'DESCONECTADA'
      }
    })
    res.json({ success: true, line })
  } catch (err) {
    console.error('Error creando línea:', err)
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
      console.log(`🏁 Campaña ${campaignId}: ${sentCount}/${results.length}`)
    }).catch(err => console.error('❌ Error campaña:', err))

  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/campaigns', authMiddleware, async (req, res) => {
  try {
    const campaigns = await prisma.campaigns.findMany({
      orderBy: { created_at: 'desc' }
    })
    res.json({ campaigns })
  } catch (e) {
    res.status(500).json({ error: 'Error listando campañas' })
  }
})

server.listen(PORT, () => console.log(`🚀 Mundial Blaster en puerto ${PORT}`))

process.on('uncaughtException', (err) => console.error('🔥 Uncaught:', err))
process.on('unhandledRejection', (reason) => console.error('🔥 Unhandled:', reason))