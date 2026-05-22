require('dotenv').config()
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const { PrismaClient } = require('@prisma/client')
const { WAService } = require('./whatsappService')
const jwt = require('jsonwebtoken');
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
    return jwt.verify(token, LICENSE_PUBLIC_KEY, { algorithms: ['RS256'] });
  } catch (e) {
    return null;
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
    const config = await prisma.app_config.findUnique({ where: { key: 'license' } });
    if (!config?.value) {
      return res.status(403).json({ error: 'Licencia no activada. Andá a /setup' });
    }
    
    const license = validateLicense(config.value);
    if (!license) {
      return res.status(403).json({ error: 'Licencia inválida o expirada' });
    }
    
    req.license = license;
    next();
  } catch (e) {
    res.status(500).json({ error: 'Error validando licencia' });
  }
}

// Middleware: aplica límites según tier
function limitLines(req, res, next) {
  // Solo aplica en endpoints de crear línea
  next();
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
// CAMPAÑA MASIVA
app.post('/api/campaign/send', authMiddleware, async (req, res) => {
  try {
    const { lineId, targets, message, delayMin, delayMax, imageUrl } = req.body
    if (!lineId || !targets || !Array.isArray(targets) || !message) {
      return res.status(400).json({ error: 'Faltan datos de campaña' })
    }

    const campaignId = `camp_${Date.now()}`

    // 🔥 FIX: Respondemos UNA SOLA VEZ, con el ID de campaña
    res.json({ success: true, campaignId, message: 'Campaña iniciada', total: targets.length })

    // Procesamos en background DESPUÉS de responder
    waService.sendCampaign(lineId, targets, message, {
      delayMin: delayMin || 3000,
      delayMax: delayMax || 8000,
      imageUrl
    }).then(async (results) => {
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
    }).catch(err => {
      console.error('❌ Error procesando campaña en background:', err)
    })

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

// LISTAR LÍNEAS
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

// REEMPLAZÁ tu app.post('/api/lineas', ...) actual por esto:
app.post('/api/lineas', authMiddleware, requireLicense, async (req, res) => {
  const { phone, nombre } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });

  try {
    // 🔥 VALIDACIÓN DE LÍMITE POR TIER
    const activeLines = await prisma.lineas_whatsapp.count({
      where: { is_archived: false }
    });
    
    if (activeLines >= req.license.maxLines) {
      return res.status(403).json({ 
        error: `Límite alcanzado: tu licencia ${req.license.tier} permite ${req.license.maxLines} línea(s).`,
        tier: req.license.tier,
        current: activeLines,
        max: req.license.maxLines
      });
    }

    const existing = await prisma.lineas_whatsapp.findUnique({ where: { phone } });
    if (existing) return res.status(409).json({ error: 'Línea ya existe' });

    const line = await prisma.lineas_whatsapp.create({
      data: {
        userId: req.body.userId || 'usr_default',
        phone,
        nombre: nombre || 'Nueva Línea',
        status: 'DESCONECTADA'
      }
    });
    res.json({ success: true, line });
  } catch (err) {
    console.error('Error creando línea:', err);
    res.status(500).json({ error: 'Error creando línea' });
  }
});

app.post('/api/setup/activate', async (req, res) => {
  const { licenseKey } = req.body;
  if (!licenseKey) return res.status(400).json({ error: 'licenseKey required' });

  const license = validateLicense(licenseKey);
  if (!license) return res.status(400).json({ error: 'Licencia inválida' });

  // Guardamos en DB
  await prisma.app_config.upsert({
    where: { key: 'license' },
    update: { value: licenseKey },
    create: { key: 'license', value: licenseKey }
  });

  res.json({ success: true, tier: license.tier, features: license });
});

// CONSULTAR ESTADO DE LICENCIA
app.get('/api/license/status', async (req, res) => {
  const config = await prisma.app_config.findUnique({ where: { key: 'license' } });
  if (!config?.value) return res.json({ active: false });
  
  const license = validateLicense(config.value);
  if (!license) return res.json({ active: false, invalid: true });
  
  res.json({ active: true, tier: license.tier, ...license });
});

// Al inicio de server.js, antes de todo
async function initDatabase() {
  try {
    await prisma.$executeRaw`SELECT 1`
    console.log('✅ DB conectada')
  } catch (e) {
    console.log('⚠️ DB no inicializada, corriendo prisma db push...')
    const { execSync } = require('child_process')
    execSync('npx prisma db push --accept-data-loss', { stdio: 'inherit' })
    console.log('✅ DB inicializada')
  }
}

// Al final, antes de server.listen
server.listen(PORT, () => console.log(`🚀 Mundial Blaster en puerto ${PORT}`))


process.on('uncaughtException', (err) => console.error('🔥 Uncaught:', err))
process.on('unhandledRejection', (reason) => console.error('🔥 Unhandled:', reason))
