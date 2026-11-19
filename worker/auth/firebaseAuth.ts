import { VerifiedAuthContext, WorkerEnv } from '../types';

export const DEFAULT_FIREBASE_PROJECT_ID = 'tripmate-81b7c';
export const FIREBASE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

export interface FirebaseJwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

export interface FirebaseJwtClaims {
  aud?: unknown;
  iss?: unknown;
  sub?: unknown;
  user_id?: unknown;
  exp?: unknown;
  iat?: unknown;
  auth_time?: unknown;
  email?: unknown;
  email_verified?: unknown;
  [key: string]: unknown;
}

export interface JwkKey extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

export class FirebaseAuthError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'FirebaseAuthError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export type WorkerTokenVerifier = (idToken: string, env: WorkerEnv) => Promise<VerifiedAuthContext>;

export interface FirebaseVerifierDeps {
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

interface JwksCacheEntry {
  keysByKid: Map<string, JwkKey>;
  cryptoKeysByKid: Map<string, CryptoKey>;
  expiresAtMs: number;
}

const isolateJwksCache = new Map<string, JwksCacheEntry>();

function isJwtShape(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((p) => p.length >= 4 && /^[A-Za-z0-9_-]+$/.test(p));
}

function base64UrlToBytes(segment: string): Uint8Array {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLen);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeBase64UrlJson<T>(segment: string): T {
  const bytes = base64UrlToBytes(segment);
  const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(json) as T;
}

function parseMaxAgeMs(cacheControlHeader: string | null): number {
  if (!cacheControlHeader) return 300_000;
  const match = /max-age=(\d+)/i.exec(cacheControlHeader);
  if (!match) return 300_000;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return 60_000;
  return Math.min(seconds * 1000, 6 * 3_600_000);
}

async function fetchJwksKeys(
  jwksUrl: string,
  fetchImpl: typeof fetch,
  nowMs: () => number,
  forceRefresh = false
): Promise<JwksCacheEntry> {
  const now = nowMs();
  const cached = isolateJwksCache.get(jwksUrl);
  if (!forceRefresh && cached && cached.expiresAtMs > now) {
    return cached;
  }

  const res = await fetchImpl(jwksUrl, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new FirebaseAuthError(
      401,
      'AUTH_INVALID',
      'Unable to fetch Google public keys for Firebase token verification.'
    );
  }

  const body = (await res.json()) as { keys?: JwkKey[] };
  if (!body || !Array.isArray(body.keys)) {
    throw new FirebaseAuthError(401, 'AUTH_INVALID', 'Invalid Google public JWKS response.');
  }

  const keysByKid = new Map<string, JwkKey>();
  for (const key of body.keys) {
    if (key && typeof key.kid === 'string' && key.kid.length > 0) {
      keysByKid.set(key.kid, key);
    }
  }

  const entry: JwksCacheEntry = {
    keysByKid,
    cryptoKeysByKid: new Map<string, CryptoKey>(),
    expiresAtMs: now + parseMaxAgeMs(res.headers.get('cache-control')),
  };
  isolateJwksCache.set(jwksUrl, entry);
  return entry;
}

async function getVerificationKey(
  kid: string,
  jwksUrl: string,
  fetchImpl: typeof fetch,
  nowMs: () => number
): Promise<CryptoKey> {
  let entry = await fetchJwksKeys(jwksUrl, fetchImpl, nowMs, false);
  let jwk = entry.keysByKid.get(kid);

  // Support key rotation: refresh JWKS once if kid is not found
  if (!jwk) {
    entry = await fetchJwksKeys(jwksUrl, fetchImpl, nowMs, true);
    jwk = entry.keysByKid.get(kid);
  }

  if (!jwk) {
    throw new FirebaseAuthError(
      401,
      'AUTH_INVALID',
      'Invalid or unverifiable Firebase authentication token.'
    );
  }

  const cachedCryptoKey = entry.cryptoKeysByKid.get(kid);
  if (cachedCryptoKey) return cachedCryptoKey;

  const imported = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  entry.cryptoKeysByKid.set(kid, imported);
  return imported;
}

export function clearFirebaseJwksCache(): void {
  isolateJwksCache.clear();
}

export function createFirebaseTokenVerifier(deps: FirebaseVerifierDeps = {}): WorkerTokenVerifier {
  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const nowMs = deps.nowMs ?? (() => Date.now());

  return async function verifyFirebaseIdToken(
    idToken: string,
    env: WorkerEnv
  ): Promise<VerifiedAuthContext> {
    if (!isJwtShape(idToken) || idToken.length > 8192) {
      throw new FirebaseAuthError(401, 'AUTH_MALFORMED', 'Malformed Firebase ID token.');
    }

    const [headerB64, payloadB64, signatureB64] = idToken.split('.');

    let header: FirebaseJwtHeader;
    let claims: FirebaseJwtClaims;
    let signatureBytes: Uint8Array;
    try {
      header = decodeBase64UrlJson<FirebaseJwtHeader>(headerB64);
      claims = decodeBase64UrlJson<FirebaseJwtClaims>(payloadB64);
      signatureBytes = base64UrlToBytes(signatureB64);
    } catch {
      throw new FirebaseAuthError(401, 'AUTH_MALFORMED', 'Malformed Firebase ID token.');
    }

    if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid.trim()) {
      throw new FirebaseAuthError(
        401,
        'AUTH_INVALID',
        'Invalid or unverifiable Firebase authentication token.'
      );
    }

    const publicKey = await getVerificationKey(
      header.kid,
      FIREBASE_JWKS_URL,
      fetchImpl,
      nowMs
    );

    const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sigBuffer = new Uint8Array(signatureBytes).buffer;
    const validSignature = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      sigBuffer,
      signedData
    );

    if (!validSignature) {
      throw new FirebaseAuthError(
        401,
        'AUTH_INVALID',
        'Invalid or unverifiable Firebase authentication token.'
      );
    }

    const nowSec = Math.floor(nowMs() / 1000);
    const clockSkewSec = 300;
    const projectId = env.FIREBASE_PROJECT_ID?.trim() || DEFAULT_FIREBASE_PROJECT_ID;
    const expectedIssuer = `https://securetoken.google.com/${projectId}`;

    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= nowSec) {
      throw new FirebaseAuthError(
        401,
        'AUTH_EXPIRED',
        'Your session has expired. Please refresh or sign in again.'
      );
    }

    if (
      typeof claims.iat !== 'number' ||
      !Number.isFinite(claims.iat) ||
      claims.iat > nowSec + clockSkewSec
    ) {
      throw new FirebaseAuthError(
        401,
        'AUTH_INVALID',
        'Invalid or unverifiable Firebase authentication token.'
      );
    }

    if (
      claims.auth_time !== undefined &&
      (typeof claims.auth_time !== 'number' ||
        !Number.isFinite(claims.auth_time) ||
        claims.auth_time > nowSec + clockSkewSec)
    ) {
      throw new FirebaseAuthError(
        401,
        'AUTH_INVALID',
        'Invalid or unverifiable Firebase authentication token.'
      );
    }

    if (claims.aud !== projectId || claims.iss !== expectedIssuer) {
      throw new FirebaseAuthError(
        401,
        'AUTH_INVALID',
        'Firebase token project or issuer mismatch.'
      );
    }

    const uid = typeof claims.sub === 'string' ? claims.sub.trim() : '';
    if (!uid || uid.length > 128) {
      throw new FirebaseAuthError(
        401,
        'AUTH_INVALID',
        'Verified token does not contain a valid UID.'
      );
    }

    if (typeof claims.user_id === 'string' && claims.user_id !== uid) {
      throw new FirebaseAuthError(
        401,
        'AUTH_INVALID',
        'Verified token subject mismatch.'
      );
    }

    if (claims.email_verified !== true) {
      throw new FirebaseAuthError(
        403,
        'EMAIL_NOT_VERIFIED',
        'Please verify your email address before using AI planning features.'
      );
    }

    return {
      uid,
      email: typeof claims.email === 'string' ? claims.email : null,
      emailVerified: true,
    };
  };
}

export async function authenticateWorkerRequest(
  request: Request,
  env: WorkerEnv,
  verifier: WorkerTokenVerifier = createFirebaseTokenVerifier()
): Promise<VerifiedAuthContext> {
  const rawHeader = request.headers.get('authorization');
  if (!rawHeader) {
    throw new FirebaseAuthError(
      401,
      'AUTH_MISSING',
      'Authentication required. Please sign in to use TripMate AI features.'
    );
  }

  const match = /^Bearer\s+(.+)$/i.exec(rawHeader.trim());
  if (!match || !match[1]) {
    throw new FirebaseAuthError(
      401,
      'AUTH_MALFORMED',
      'Malformed Authorization header. Expected Bearer token.'
    );
  }

  const idToken = match[1].trim();
  return verifier(idToken, env);
}
