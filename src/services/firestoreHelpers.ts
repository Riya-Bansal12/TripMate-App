import { DocumentReference, Timestamp, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { OperationType, handleFirestoreError } from './userProfileService';

export { OperationType, handleFirestoreError };

export interface BatchWriteOperation {
  type: 'set' | 'update' | 'delete';
  ref: DocumentReference;
  data?: Record<string, unknown>;
  path: string;
}

export function toValidFirestoreId(rawId: string | undefined, fallbackPrefix: string): string {
  const cleaned = (rawId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 128);
  if (cleaned.length >= 1) return cleaned;
  return `${fallbackPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export function toIsoString(val: unknown, fallback = new Date().toISOString()): string {
  if (val instanceof Timestamp) {
    return val.toDate().toISOString();
  }
  if (typeof val === 'string' && val.trim()) {
    return val;
  }
  return fallback;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (typeof val !== 'object' || val === null || Array.isArray(val)) return false;
  return Object.getPrototypeOf(val) === Object.prototype;
}

/**
 * Recursively strips undefined keys from plain objects while preserving
 * Firestore sentinel values (serverTimestamp, deleteField), GeoPoints, arrays, and nulls.
 */
export function stripUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined) continue;
    if (isPlainObject(val)) {
      out[key] = stripUndefined(val);
    } else if (Array.isArray(val)) {
      out[key] = val.filter((item) => item !== undefined);
    } else {
      out[key] = val;
    }
  }
  return out;
}

export function sanitizeNotesList(notes: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(notes)) return fallback;
  return notes
    .map((n) => (typeof n === 'string' ? n.trim().slice(0, 200) : ''))
    .filter((n) => n.length >= 1)
    .slice(0, 20);
}

export function sanitizeTimeHHMM(val: unknown, fallback = '09:00'): string {
  if (typeof val === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(val.trim())) {
    return val.trim();
  }
  return fallback;
}

export function clampInt(val: unknown, min: number, max: number, fallback: number): number {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

export function clampNumber(val: unknown, min: number, max: number, fallback: number): number {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

export function sanitizeGeoPoint(
  pt: unknown
): { lat: number; lng: number } | undefined {
  if (!pt || typeof pt !== 'object') return undefined;
  const candidate = pt as { lat?: unknown; lng?: unknown };
  const lat = Number(candidate.lat);
  const lng = Number(candidate.lng);
  if (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  ) {
    return { lat, lng };
  }
  return undefined;
}

const CHUNK_SIZE = 400;

export async function commitChunkedOperations(
  operations: BatchWriteOperation[],
  operationType: OperationType
): Promise<void> {
  if (operations.length === 0) return;

  for (let i = 0; i < operations.length; i += CHUNK_SIZE) {
    const chunk = operations.slice(i, i + CHUNK_SIZE);
    const batch = writeBatch(db);
    for (const op of chunk) {
      if (op.type === 'set' && op.data) {
        batch.set(op.ref, stripUndefined(op.data));
      } else if (op.type === 'update' && op.data) {
        batch.update(op.ref, stripUndefined(op.data));
      } else if (op.type === 'delete') {
        batch.delete(op.ref);
      }
    }

    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, operationType, chunk[0]?.path || null);
    }
  }
}
