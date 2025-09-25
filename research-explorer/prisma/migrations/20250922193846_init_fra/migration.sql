-- CreateTable
CREATE TABLE "public"."Faculty" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "college" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "externalIds" JSONB DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Faculty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Publication" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "year" INTEGER,
    "venue" TEXT,
    "doi" TEXT,
    "url" TEXT,
    "abstract" TEXT,
    "facultyId" TEXT NOT NULL,
    "externalIds" JSONB DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Publication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."FacultyMetrics" (
    "id" TEXT NOT NULL,
    "facultyId" TEXT NOT NULL,
    "hIndex" INTEGER NOT NULL DEFAULT 0,
    "totalPublications" INTEGER NOT NULL DEFAULT 0,
    "totalCitations" INTEGER NOT NULL DEFAULT 0,
    "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FacultyMetrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Faculty_fullName_college_department_key" ON "public"."Faculty"("fullName", "college", "department");

-- CreateIndex
CREATE UNIQUE INDEX "Publication_doi_key" ON "public"."Publication"("doi");

-- CreateIndex
CREATE INDEX "Publication_facultyId_year_idx" ON "public"."Publication"("facultyId", "year");

-- CreateIndex
CREATE INDEX "Publication_facultyId_idx" ON "public"."Publication"("facultyId");

-- CreateIndex
CREATE UNIQUE INDEX "Publication_facultyId_doi_key" ON "public"."Publication"("facultyId", "doi");

-- CreateIndex
CREATE UNIQUE INDEX "FacultyMetrics_facultyId_key" ON "public"."FacultyMetrics"("facultyId");

-- AddForeignKey
ALTER TABLE "public"."Publication" ADD CONSTRAINT "Publication_facultyId_fkey" FOREIGN KEY ("facultyId") REFERENCES "public"."Faculty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FacultyMetrics" ADD CONSTRAINT "FacultyMetrics_facultyId_fkey" FOREIGN KEY ("facultyId") REFERENCES "public"."Faculty"("id") ON DELETE CASCADE ON UPDATE CASCADE;
