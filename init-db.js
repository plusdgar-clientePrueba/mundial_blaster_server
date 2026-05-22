// init-db.js
const { execSync } = require('child_process')

async function initDatabase() {
  console.log('🔧 Verificando base de datos...')
  try {
    // Intentamos una query simple
    const { PrismaClient } = require('@prisma/client')
    const prisma = new PrismaClient()
    await prisma.$executeRaw`SELECT 1`
    await prisma.$disconnect()
    console.log('✅ Base de datos OK')
  } catch (e) {
    console.log('⚠️ Tablas no encontradas. Ejecutando prisma db push...')
    try {
      execSync('npx prisma db push --accept-data-loss', { 
        stdio: 'inherit',
        timeout: 30000 
      })
      console.log('✅ Tablas creadas correctamente')
    } catch (pushError) {
      console.error('❌ Error creando tablas:', pushError.message)
      process.exit(1)
    }
  }
}

initDatabase()