// src/db/prisma.js — serverless-safe Prisma singleton (ESM)
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.__prisma__ ??
  new PrismaClient({
    // log: ['query', 'error', 'warn'], // uncomment to debug
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma__ = prisma;
}

export default prisma;
