-- CreateTable
CREATE TABLE "usuarios" (
    "id" VARCHAR(36) NOT NULL DEFAULT ('usr_'::text || substr(md5((random())::text), 1, 24)),
    "nombre" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "fecha_creacion" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lineas_whatsapp" (
    "id" VARCHAR(36) NOT NULL DEFAULT ('line_'::text || substr(md5((random())::text), 1, 24)),
    "userId" VARCHAR(36) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "nombre" VARCHAR(255) NOT NULL DEFAULT 'Línea',
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "fecha_creacion" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lineas_whatsapp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "status" TEXT DEFAULT 'draft',
    "total_targets" INTEGER DEFAULT 0,
    "sent_count" INTEGER DEFAULT 0,
    "failed_count" INTEGER DEFAULT 0,
    "owner_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_logs" (
    "id" SERIAL NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "contact_phone" TEXT NOT NULL,
    "status" TEXT,
    "line_id" TEXT,
    "sent_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "owner_id" TEXT NOT NULL,

    CONSTRAINT "campaign_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_email_key" ON "usuarios"("email");

-- CreateIndex
CREATE UNIQUE INDEX "lineas_whatsapp_phone_key" ON "lineas_whatsapp"("phone");

-- AddForeignKey
ALTER TABLE "lineas_whatsapp" ADD CONSTRAINT "lineas_whatsapp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_logs" ADD CONSTRAINT "campaign_logs_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_logs" ADD CONSTRAINT "campaign_logs_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
