-- CreateTable
CREATE TABLE "ModulePlcIoMapping" (
    "id" UUID NOT NULL,
    "processModuleInstanceId" UUID NOT NULL,
    "moduleSignalDefinitionId" UUID NOT NULL,
    "plcInstanceId" UUID NOT NULL,
    "tagId" UUID NOT NULL,
    "metadataJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModulePlcIoMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModulePlcIoMapping_tagId_key" ON "ModulePlcIoMapping"("tagId");

-- CreateIndex
CREATE INDEX "ModulePlcIoMapping_plcInstanceId_idx" ON "ModulePlcIoMapping"("plcInstanceId");

-- CreateIndex
CREATE UNIQUE INDEX "ModulePlcIoMapping_processModuleInstanceId_moduleSignalDefi_key" ON "ModulePlcIoMapping"("processModuleInstanceId", "moduleSignalDefinitionId");

-- AddForeignKey
ALTER TABLE "ModulePlcIoMapping" ADD CONSTRAINT "ModulePlcIoMapping_processModuleInstanceId_fkey" FOREIGN KEY ("processModuleInstanceId") REFERENCES "ProcessModuleInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModulePlcIoMapping" ADD CONSTRAINT "ModulePlcIoMapping_moduleSignalDefinitionId_fkey" FOREIGN KEY ("moduleSignalDefinitionId") REFERENCES "ModuleSignalDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModulePlcIoMapping" ADD CONSTRAINT "ModulePlcIoMapping_plcInstanceId_fkey" FOREIGN KEY ("plcInstanceId") REFERENCES "PlcInstanceProfile"("deviceInstanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModulePlcIoMapping" ADD CONSTRAINT "ModulePlcIoMapping_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

