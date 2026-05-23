require('dotenv').config()
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const { PrismaClient } = require('@prisma/client')
const { WAService } = require('./whatsappService')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')

const PORT = process.env.PORT || 8080
const SECRET = process.env.WHATSAPP_SECRET
const JWT_SECRET = process.env.JWT_SECRET || SECRET || 'cambiar-en-produccion'

const prisma = new PrismaClient()
const app = express()
const server = http.createServer(app)
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
})

app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ limit: '50mb', extended: true }))

// ============================================================
// 🔑 CLAVE PÚBLICA PARA LICENCIAS
// ============================================================
const LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArPfXmFNNzOR7bxsPpJ6V
BdovK3uX6+GVSPcKVZfSJypeJ4PfSWea7ZWi2GzMIaNmQE1yF5McGzbq38NDl1zA
Y9Odn9a9Yol0WRgpo2/C7mMqQlwVzt8yvgG6iWX04Kqw2/ZKESc495jec5AErzBc
kXXXxzGtfyUAzkHeg0Da3CtbPwtBC4TR1QwxT6FE08+yxbdqJzCtW+Sp8jGFmwdX
Zt2U3xmqghpABkD67W4EKAO4RAsHXKrBHCf49QEprQIf0r5csnhVzQ9ZNiM64NLI
HJIeR639aAKAyWeir0j4UUp9VAuEKnzMxz+ERtQ5PdDgVHKQnK/618Qxq7b7m3bc
JwIDAQAB
-----END PUBLIC KEY-----`

// ============================================================
// HELPERS
// ============================================================
function validateLicense(token) {
  try {
    return jwt.verify(token, LICENSE_PUBLIC_KEY, { algorithms: ['RS256'] })
  } catch (e) {
    return null
  }
}

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' })
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET)
  } catch (e) {
    return null
  }
}

// ============================================================
// MIDDLEWARES
// ============================================================

// Middleware original: acepta SECRET por header o body
const authMiddleware = (req, res, next) => {
  const headerSecret = req.headers['x-api-secret']
  const bodySecret = req.body?.secret
  if (headerSecret === SECRET || bodySecret === SECRET) return next()
  return res.status(401).json({ error: 'Unauthorized' })
}

// Middleware: solo JWT válido
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No autenticado' })

  const decoded = verifyToken(token)
  if (!decoded) return res.status(401).json({ error: 'Sesión expirada o inválida' })

  const user = await prisma.usuarios.findUnique({ where: { id: decoded.userId } })
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' })

  req.user = user
  next()
}

// Middleware: SECRET o JWT (para compatibilidad líneas/campañas)
async function authOrSecret(req, res, next) {
  const headerSecret = req.headers['x-api-secret']
  const bodySecret = req.body?.secret

  if (headerSecret === SECRET || bodySecret === SECRET) {
    return next()
  }

  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Unauthorized' })

  const decoded = verifyToken(token)
  if (!decoded) return res.status(401).json({ error: 'Sesión expirada' })

  const user = await prisma.usuarios.findUnique({ where: { id: decoded.userId } })
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' })

  req.user = user
  next()
}

// Middleware: licencia activa requerida
async function requireLicense(req, res, next) {
  try {
    const config = await prisma.app_config.findUnique({ where: { key: 'license' } })
    if (!config?.value) {
      return res.status(403).json({ error: 'Licencia no activada. Andá a /setup' })
    }
    const license = validateLicense(config.value)
    if (!license) {
      return res.status(403).json({ error: 'Licencia inválida o expirada' })
    }
    req.license = license
    next()
  } catch (e) {
    res.status(500).json({ error: 'Error validando licencia' })
  }
}

// ============================================================
// WHATSAPP SERVICE
// ============================================================
const waService = new WAService(prisma, io)
waService.init()

io.on('connection', () => console.log('🟢 Socket conectado'))

// ============================================================
// RUTAS
// ============================================================

app.get('/', (_, res) => res.json({ status: 'OK', service: 'Mundial Blaster', version: '2.0.0' }))

// ========== AUTH (TODO PROTEGIDO POR LICENCIA) ==========

// Registro (onboarding)
app.post('/api/auth/register', requireLicense, async (req, res) => {
  const { nombre, email, password, confirmPassword, avatar, security_question, security_answer, line_phone, line_name } = req.body

  if (!nombre || !email || !password) {
    return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' })
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Las contraseñas no coinciden' })
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' })
  }

  try {
    const existing = await prisma.usuarios.findUnique({ where: { email: email.toLowerCase().trim() } })
    if (existing) {
      return res.status(409).json({ error: 'Ya existe un usuario registrado. Usá el login.' })
    }

    const hashedPassword = await bcrypt.hash(password, 10)
    const hashedSecurity = security_answer ? await bcrypt.hash(security_answer, 10) : null

    const user = await prisma.usuarios.create({
      data: {
        nombre,
        email: email.toLowerCase().trim(),
        password: hashedPassword,
        avatar: avatar || 'avatar1',
        security_question: security_question || null,
        security_answer: hashedSecurity,
        last_login: new Date(),
      }
    })

    // Crear línea opcional desde onboarding
    if (line_phone) {
      await prisma.lineas_whatsapp.create({
        data: {
          phone: line_phone.replace(/\D/g, ''),
          nombre: line_name || nombre + ' - Línea 1',
          status: 'DESCONECTADA'
        }
      }).catch(() => {})
    }

    const token = generateToken({ userId: user.id, email: user.email, role: user.role })

    const { password: _, security_answer: __, ...safeUser } = user

    res.json({
      success: true,
      token,
      user: safeUser,
      message: 'Registro exitoso. Bienvenido a Mundial Blaster.'
    })

  } catch (e) {
    console.error('Error registro:', e)
    res.status(500).json({ error: 'Error creando usuario' })
  }
})

// Login
app.post('/api/auth/login', requireLicense, async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña requeridos' })
  }

  try {
    const user = await prisma.usuarios.findUnique({
      where: { email: email.toLowerCase().trim() }
    })

    if (!user) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos' })
    }

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos' })
    }

    await prisma.usuarios.update({
      where: { id: user.id },
      data: { last_login: new Date() }
    })

    const token = generateToken({ userId: user.id, email: user.email, role: user.role })

    const { password: _, security_answer: __, ...safeUser } = user

    res.json({
      success: true,
      token,
      user: safeUser,
      expiresIn: '8h'
    })

  } catch (e) {
    console.error('Error login:', e)
    res.status(500).json({ error: 'Error en login' })
  }
})

// Recuperar contraseña por pregunta de seguridad
app.post('/api/auth/recover', requireLicense, async (req, res) => {
  const { email, security_answer, new_password } = req.body

  if (!email || !security_answer || !new_password) {
    return res.status(400).json({ error: 'Faltan datos' })
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'Mínimo 6 caracteres' })
  }

  try {
    const user = await prisma.usuarios.findUnique({
      where: { email: email.toLowerCase().trim() }
    })

    if (!user || !user.security_answer) {
      return res.status(404).json({ error: 'Usuario no encontrado o sin pregunta de seguridad configurada' })
    }

    const validAnswer = await bcrypt.compare(security_answer, user.security_answer)
    if (!validAnswer) {
      return res.status(401).json({ error: 'Respuesta de seguridad incorrecta' })
    }

    const hashedPassword = await bcrypt.hash(new_password, 10)
    await prisma.usuarios.update({
      where: { id: user.id },
      data: { password: hashedPassword }
    })

    res.json({ success: true, message: 'Contraseña actualizada. Iniciá sesión con la nueva.' })

  } catch (e) {
    console.error('Error recover:', e)
    res.status(500).json({ error: 'Error recuperando cuenta' })
  }
})

// Get usuario actual
app.get('/api/auth/me', requireLicense, requireAuth, async (req, res) => {
  const { password, security_answer, ...safeUser } = req.user
  res.json({ user: safeUser })
})

// Update perfil (nombre, email, avatar, password)
app.patch('/api/auth/me', requireLicense, requireAuth, async (req, res) => {
  const { nombre, email, avatar, current_password, new_password } = req.body

  try {
    const updateData = {}

    if (nombre) updateData.nombre = nombre
    if (avatar) updateData.avatar = avatar

    // Cambio de email: requiere password actual
    if (email && email !== req.user.email) {
      if (!current_password) {
        return res.status(400).json({ error: 'Se requiere contraseña actual para cambiar el email' })
      }
      const valid = await bcrypt.compare(current_password, req.user.password)
      if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta' })

      const existing = await prisma.usuarios.findUnique({ where: { email } })
      if (existing) return res.status(409).json({ error: 'Ese email ya está en uso' })

      updateData.email = email.toLowerCase().trim()
    }

    // Cambio de password
    if (new_password) {
      if (!current_password) {
        return res.status(400).json({ error: 'Se requiere contraseña actual' })
      }
      const valid = await bcrypt.compare(current_password, req.user.password)
      if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta' })
      if (new_password.length < 6) {
        return res.status(400).json({ error: 'Mínimo 6 caracteres' })
      }
      updateData.password = await bcrypt.hash(new_password, 10)
    }

    const updated = await prisma.usuarios.update({
      where: { id: req.user.id },
      data: updateData
    })

    const { password: pwd, security_answer: sa, ...safeUser } = updated
    res.json({ success: true, user: safeUser })

  } catch (e) {
    console.error('Error update:', e)
    res.status(500).json({ error: 'Error actualizando perfil' })
  }
})

// Logout (client-side, pero dejamos endpoint por consistencia)
app.post('/api/auth/logout', requireLicense, requireAuth, async (req, res) => {
  res.json({ success: true, message: 'Sesión cerrada' })
})

// ========== LEGACY USER (compatibilidad onboarding viejo) ==========
app.get('/api/user', authOrSecret, async (req, res) => {
  try {
    const user = await prisma.usuarios.findFirst()
    res.json({ user })
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo usuario' })
  }
})

app.post('/api/user', authOrSecret, async (req, res) => {
  const { nombre, email, avatar } = req.body
  if (!nombre || !email) {
    return res.status(400).json({ error: 'Nombre y email son requeridos' })
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

// ========== LÍNEAS ==========
app.post('/api/lineas/connect', authOrSecret, requireLicense, async (req, res) => {
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

app.get('/api/lineas', authOrSecret, requireLicense, async (req, res) => {
  try {
    const lines = await prisma.lineas_whatsapp.findMany({
      orderBy: { fecha_creacion: 'desc' }
    })
    res.json({ lines })
  } catch (err) {
    res.status(500).json({ error: 'Error listando líneas' })
  }
})

app.post('/api/lineas', authOrSecret, requireLicense, async (req, res) => {
  const { phone, nombre } = req.body
  if (!phone) return res.status(400).json({ error: 'phone required' })

  try {
    const activeLines = await prisma.lineas_whatsapp.count()

    if (activeLines >= req.license.maxLines) {
      return res.status(403).json({
        error: `Límite alcanzado: tu licencia ${req.license.tier} permite ${req.license.maxLines} línea(s).`,
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

app.post('/api/lineas/logout', authOrSecret, requireLicense, async (req, res) => {
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
app.post('/api/campaign/send', authOrSecret, requireLicense, async (req, res) => {
  try {
    const { lineId, targets, message, delayMin, delayMax, imageUrl } = req.body
    if (!lineId || !targets || !Array.isArray(targets) || !message) {
      return res.status(400).json({ error: 'Faltan datos de campaña' })
    }

    const campaignId = `camp_${Date.now()}`

    await prisma.campaigns.create({
      data: {
        id: campaignId,
        name: `Campaña ${new Date().toLocaleDateString()}`,
        line_id: lineId,
        message,
        image_url: imageUrl,
        total: targets.length,
        status: 'running'
      }
    }).catch(() => {})

    res.json({ success: true, campaignId, message: 'Campaña iniciada', total: targets.length })

    waService.sendCampaign(lineId, targets, message, {
      delayMin: delayMin || 3000,
      delayMax: delayMax || 8000,
      imageUrl
    }).then(async (results) => {
      const sentCount = results.filter(r => r.status === 'sent').length
      const failedCount = results.filter(r => r.status === 'failed').length

      await prisma.campaigns.update({
        where: { id: campaignId },
        data: {
          sent: sentCount,
          failed: failedCount,
          status: 'completed',
          finished_at: new Date()
        }
      }).catch(() => {})

      for (const r of results) {
        await prisma.campaign_logs.create({
          data: {
            campaign_id: campaignId,
            contact_phone: r.phone,
            status: r.status,
            line_id: lineId,
            owner_id: 'system',
            sent_at: r.status === 'sent' ? new Date() : null
          }
        }).catch(() => {})
      }

      console.log(`🏁 Campaña ${campaignId} finalizada. Enviados: ${sentCount}/${results.length}`)
    }).catch(err => {
      console.error('❌ Error campaña:', err)
    })

  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/campaigns', authOrSecret, requireLicense, async (req, res) => {
  try {
    const campaigns = await prisma.campaigns.findMany({
      orderBy: { created_at: 'desc' }
    })
    res.json({ campaigns })
  } catch (e) {
    res.status(500).json({ error: 'Error listando campañas' })
  }
})

// ========== LICENCIA + ANTI-CLONACIÓN ==========

app.post('/api/setup/activate', async (req, res) => {
  const { licenseKey } = req.body
  if (!licenseKey) return res.status(400).json({ error: 'licenseKey required' })

  const license = validateLicense(licenseKey)
  if (!license) return res.status(400).json({ error: 'Licencia inválida' })

  // Anti-clonación: verificar dominio
  const instanceDomain = process.env.RAILWAY_STATIC_URL ||
                         process.env.VERCEL_URL ||
                         req.headers.host

  if (license.domain && license.domain !== instanceDomain) {
    return res.status(403).json({
      error: 'Licencia no válida para este dominio',
      licensedDomain: license.domain,
      currentDomain: instanceDomain
    })
  }

  await prisma.app_config.upsert({
    where: { key: 'license' },
    update: { value: licenseKey },
    create: { key: 'license', value: licenseKey }
  })

  await prisma.app_config.upsert({
    where: { key: 'instance_domain' },
    update: { value: instanceDomain },
    create: { key: 'instance_domain', value: instanceDomain }
  })

  res.json({ success: true, tier: license.tier, features: license })
})

app.get('/api/license/status', async (req, res) => {
  const config = await prisma.app_config.findUnique({ where: { key: 'license' } })
  if (!config?.value) return res.json({ active: false })

  const license = validateLicense(config.value)
  if (!license) return res.json({ active: false, invalid: true })

  // Anti-clonación: verificar dominio vinculado
  const instanceDomain = process.env.RAILWAY_STATIC_URL ||
                         process.env.VERCEL_URL ||
                         req.headers.host
  const savedDomain = await prisma.app_config.findUnique({ where: { key: 'instance_domain' } })

  if (savedDomain?.value && savedDomain.value !== instanceDomain) {
    return res.json({ active: false, domainMismatch: true })
  }

  res.json({ active: true, tier: license.tier, ...license })
})

// ========== ADMIN (nuclear, solo con SECRET) ==========

// Resetear dominio vinculado
app.post('/api/admin/reset-domain', authMiddleware, async (req, res) => {
  const { newDomain } = req.body
  if (!newDomain) return res.status(400).json({ error: 'newDomain requerido' })

  await prisma.app_config.upsert({
    where: { key: 'instance_domain' },
    update: { value: newDomain },
    create: { key: 'instance_domain', value: newDomain }
  })

  res.json({ success: true, domain: newDomain })
})

// Resetear usuario completo (email/password)
app.post('/api/admin/reset-user', authMiddleware, async (req, res) => {
  const { email, new_email, new_password } = req.body
  if (!email) return res.status(400).json({ error: 'Email requerido' })

  try {
    const user = await prisma.usuarios.findUnique({ where: { email: email.toLowerCase().trim() } })
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' })

    const updateData = {}
    if (new_email) updateData.email = new_email.toLowerCase().trim()
    if (new_password) updateData.password = await bcrypt.hash(new_password, 10)

    await prisma.usuarios.update({ where: { id: user.id }, data: updateData })

    res.json({ success: true, message: 'Usuario reseteado' })
  } catch (e) {
    console.error('Admin reset error:', e)
    res.status(500).json({ error: 'Error reseteando usuario' })
  }
})

// ============================================================
// SERVER START
// ============================================================
server.listen(PORT, () => console.log(`🚀 Mundial Blaster v2.0.0 en puerto ${PORT}`))

process.on('uncaughtException', (err) => console.error('🔥 Uncaught:', err))
process.on('unhandledRejection', (reason) => console.error('🔥 Unhandled:', reason))