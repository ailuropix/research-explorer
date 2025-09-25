import { prisma } from '../db/prisma.js';

/**
 * Saves faculty and their publications to the database with deduplication
 * @param {Object} data - Faculty data object
 * @param {string} data.name - Faculty full name
 * @param {string} data.college - College name
 * @param {string} data.department - Department name
 * @param {Object} data.externalIds - External IDs from various sources
 * @param {Array} data.publications - Array of publication objects
 * @param {Object} data.metrics - Faculty metrics object
 * @returns {Object} Saved faculty with publications and metrics
 */
export async function saveFacultyAndPublications({
  name,
  college,
  department,
  externalIds = {},
  publications = [],
  metrics = {}
}) {
  try {
    console.log(`[DB] Saving faculty: ${name} from ${college}/${department}`);

    // Upsert faculty
    const faculty = await prisma.faculty.upsert({
      where: {
        fullName_college_department: {
          fullName: name,
          college: college,
          department: department
        }
      },
      update: {
        externalIds: externalIds,
        updatedAt: new Date()
      },
      create: {
        fullName: name,
        college: college,
        department: department,
        externalIds: externalIds
      }
    });

    console.log(`[DB] Faculty ${faculty.id} saved/updated`);

    // Save publications with deduplication
    const savedPublications = [];
    for (const pub of publications) {
      try {
        // Check for existing publication by DOI or title+year
        let existingPub = null;

        if (pub.doi) {
          existingPub = await prisma.publication.findUnique({
            where: {
              facultyId_doi: {
                facultyId: faculty.id,
                doi: pub.doi
              }
            }
          });
        }

        if (!existingPub) {
          // Try to find by title and year as fallback
          existingPub = await prisma.publication.findFirst({
            where: {
              facultyId: faculty.id,
              title: {
                equals: pub.title,
                mode: 'insensitive'
              },
              year: pub.year
            }
          });
        }

        let savedPub;
        if (existingPub) {
          // Update existing publication
          savedPub = await prisma.publication.update({
            where: { id: existingPub.id },
            data: {
              title: pub.title,
              year: pub.year,
              venue: pub.venue,
              doi: pub.doi,
              url: pub.url,
              abstract: pub.abstract,
              externalIds: pub.externalIds || {},
              updatedAt: new Date()
            }
          });
        } else {
          // Create new publication
          savedPub = await prisma.publication.create({
            data: {
              title: pub.title,
              year: pub.year,
              venue: pub.venue,
              doi: pub.doi,
              url: pub.url,
              abstract: pub.abstract,
              externalIds: pub.externalIds || {},
              facultyId: faculty.id
            }
          });
        }

        savedPublications.push(savedPub);
        console.log(`[DB] Publication saved: ${savedPub.title.substring(0, 50)}...`);
      } catch (pubError) {
        console.error(`[DB] Error saving publication "${pub.title}":`, pubError);
      }
    }

    // Upsert faculty metrics
    const facultyMetrics = await prisma.facultyMetrics.upsert({
      where: { facultyId: faculty.id },
      update: {
        hIndex: metrics.hIndex || 0,
        totalPublications: savedPublications.length,
        totalCitations: metrics.totalCitations || 0,
        lastUpdated: new Date()
      },
      create: {
        facultyId: faculty.id,
        hIndex: metrics.hIndex || 0,
        totalPublications: savedPublications.length,
        totalCitations: metrics.totalCitations || 0
      }
    });

    console.log(`[DB] Metrics updated for ${name}: ${savedPublications.length} publications, h-index: ${metrics.hIndex || 0}`);

    return {
      faculty: {
        id: faculty.id,
        fullName: faculty.fullName,
        college: faculty.college,
        department: faculty.department,
        externalIds: faculty.externalIds
      },
      publications: savedPublications,
      metrics: facultyMetrics
    };

  } catch (error) {
    console.error('[DB] Error saving faculty and publications:', error);
    throw error;
  }
}

/**
 * Get faculty by ID
 * @param {string} id - Faculty ID
 * @returns {Object} Faculty with publications and metrics
 */
export async function getFacultyById(id) {
  try {
    const faculty = await prisma.faculty.findUnique({
      where: { id },
      include: {
        publications: {
          orderBy: { year: 'desc' }
        },
        metrics: true
      }
    });

    return faculty;
  } catch (error) {
    console.error('[DB] Error fetching faculty:', error);
    throw error;
  }
}

/**
 * Get publications for a faculty with optional year filtering
 * @param {string} facultyId - Faculty ID
 * @param {number} yearFrom - Optional year from filter
 * @param {number} yearTo - Optional year to filter
 * @returns {Array} Publications array
 */
export async function getFacultyPublications(facultyId, yearFrom = null, yearTo = null) {
  try {
    const where = { facultyId };

    if (yearFrom || yearTo) {
      where.year = {};
      if (yearFrom) where.year.gte = yearFrom;
      if (yearTo) where.year.lte = yearTo;
    }

    const publications = await prisma.publication.findMany({
      where,
      orderBy: { year: 'desc' }
    });

    return publications;
  } catch (error) {
    console.error('[DB] Error fetching faculty publications:', error);
    throw error;
  }
}

/**
 * Get all faculty with optional department filter
 * @param {string} department - Optional department filter
 * @returns {Array} Faculty array
 */
export async function getAllFaculty(department = null) {
  try {
    const where = {};
    if (department) where.department = department;

    const faculty = await prisma.faculty.findMany({
      where,
      include: {
        metrics: true,
        _count: {
          select: { publications: true }
        }
      },
      orderBy: { fullName: 'asc' }
    });

    return faculty;
  } catch (error) {
    console.error('[DB] Error fetching faculty list:', error);
    throw error;
  }
}

/**
 * Get aggregated summary for department
 * @param {string} department - Department name
 * @returns {Object} Aggregated summary
 */
export async function getDepartmentSummary(department) {
  try {
    const faculty = await prisma.faculty.findMany({
      where: { department },
      include: {
        metrics: true,
        publications: {
          select: { year: true }
        }
      }
    });

    const totalFaculty = faculty.length;
    const totalPublications = faculty.reduce((sum, f) => sum + (f.metrics?.totalPublications || 0), 0);
    const totalCitations = faculty.reduce((sum, f) => sum + (f.metrics?.totalCitations || 0), 0);
    const avgHIndex = faculty.length > 0
      ? faculty.reduce((sum, f) => sum + (f.metrics?.hIndex || 0), 0) / faculty.length
      : 0;

    // Get publication years for trend analysis
    const allYears = faculty.flatMap(f =>
      f.publications.map(p => p.year).filter(y => y != null)
    );
    const yearFrom = allYears.length > 0 ? Math.min(...allYears) : null;
    const yearTo = allYears.length > 0 ? Math.max(...allYears) : null;

    return {
      department,
      totalFaculty,
      totalPublications,
      totalCitations,
      averageHIndex: Math.round(avgHIndex * 10) / 10,
      yearRange: yearFrom && yearTo ? { from: yearFrom, to: yearTo } : null
    };
  } catch (error) {
    console.error('[DB] Error getting department summary:', error);
    throw error;
  }
}
