// src/db/prisma.js
import { PrismaClient } from '@prisma/client';

/**
 * Singleton Prisma client for serverless environments.
 * - In dev (hot reload): reuse via globalThis
 * - In prod (Vercel functions may be warm): reuse instance to avoid connection storms
 */
const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.__prisma__ ??
  new PrismaClient({
    // uncomment to debug SQL:
    // log: ['query', 'error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma__ = prisma;
}

export default prisma;
