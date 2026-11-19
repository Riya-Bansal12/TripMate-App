import { NextFunction, Request, Response } from 'express';
import { App as AdminApp, getApps, initializeApp } from 'firebase-admin/app';
import { DecodedIdToken, getAuth } from 'firebase-admin/auth';

export const FIREBASE_PROJECT_ID = 'tripmate-81b7c';

export interface VerifiedAuthContext {
  uid: string;
  email: string | null;
  emailVerified: boolean;
}

declare global {
  namespace Express {
    interface Request {
      auth?: VerifiedAuthContext;
    }
  }
}

let cachedAdminApp: AdminApp | null = null;

function getFirebaseAdminApp(): AdminApp {
  if (cachedAdminApp) return cachedAdminApp;
  const existing = getApps().find((a) => a.name === 'tripmate-server');
  if (existing) {
    cachedAdminApp = existing;
    return existing;
  }
  cachedAdminApp = initializeApp(
    {
      projectId: FIREBASE_PROJECT_ID,
    },
    'tripmate-server'
  );
  return cachedAdminApp;
}

export type TokenVerifierFn = (idToken: string) => Promise<DecodedIdToken>;

const defaultVerifyToken: TokenVerifierFn = async (idToken: string) => {
  const adminApp = getFirebaseAdminApp();
  // Verifies signature, issuer, audience (projectId), expiration, and subject via Google public certs.
  // Revocation checking (checkRevoked=true) requires service-account IAM permissions not present in preview.
  return getAuth(adminApp).verifyIdToken(idToken);
};

function isJwtShape(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((p) => p.length >= 4 && /^[A-Za-z0-9_-]+$/.test(p));
}

export function createAuthMiddleware(verifier: TokenVerifierFn = defaultVerifyToken) {
  return async function requireVerifiedFirebaseUser(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const rawHeader = req.headers.authorization;
    if (!rawHeader || typeof rawHeader !== 'string') {
      res.status(401).json({
        error: 'Authentication required. Please sign in to use TripMate AI features.',
        code: 'AUTH_MISSING',
      });
      return;
    }

    const match = /^Bearer\s+(.+)$/i.exec(rawHeader.trim());
    if (!match || !match[1]) {
      res.status(401).json({
        error: 'Malformed Authorization header. Expected Bearer token.',
        code: 'AUTH_MALFORMED',
      });
      return;
    }

    const idToken = match[1].trim();
    if (!isJwtShape(idToken) || idToken.length > 8192) {
      res.status(401).json({
        error: 'Malformed Firebase ID token.',
        code: 'AUTH_MALFORMED',
      });
      return;
    }

    try {
      const decoded = await verifier(idToken);
      const expectedIssuer = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
      if (decoded.aud !== FIREBASE_PROJECT_ID || (decoded.iss && decoded.iss !== expectedIssuer)) {
        res.status(401).json({
          error: 'Firebase token project or issuer mismatch.',
          code: 'AUTH_INVALID',
        });
        return;
      }

      if (!decoded.uid || typeof decoded.uid !== 'string') {
        res.status(401).json({
          error: 'Verified token does not contain a valid UID.',
          code: 'AUTH_INVALID',
        });
        return;
      }

      if (decoded.email_verified !== true) {
        res.status(403).json({
          error: 'Please verify your email address before using AI planning features.',
          code: 'EMAIL_NOT_VERIFIED',
        });
        return;
      }

      req.auth = {
        uid: decoded.uid,
        email: typeof decoded.email === 'string' ? decoded.email : null,
        emailVerified: true,
      };
      next();
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
      const isExpired = code === 'auth/id-token-expired';
      res.status(401).json({
        error: isExpired
          ? 'Your session has expired. Please refresh or sign in again.'
          : 'Invalid or unverifiable Firebase authentication token.',
        code: isExpired ? 'AUTH_EXPIRED' : 'AUTH_INVALID',
      });
    }
  };
}
