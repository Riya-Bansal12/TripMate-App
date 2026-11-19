import {
  authenticateWorkerRequest,
  createFirebaseTokenVerifier,
  FirebaseAuthError,
  WorkerTokenVerifier,
} from './auth/firebaseAuth';
import { WorkerRateLimitManager } from './middleware/rateLimit';
import {
  RequestValidationError,
  validateEstimateBudgetInput,
  validateGenerateItineraryInput,
  validateRecommendationsInput,
  validateRefineActivityInput,
  validateRegenerateDayInput,
} from './schemas/aiSchemas';
import {
  createWorkerGeminiService,
  GeminiServiceError,
  getConfiguredGeminiModel,
  isGeminiConfigured,
  redactSensitiveText,
  WorkerGeminiService,
} from './services/geminiService';
import { WorkerEnv, WorkerExecutionContext } from './types';
import { MalformedAiOutputError } from './utils/responseNormalizer';

export const MAX_REQUEST_BODY_BYTES = 65_536; // 64 KiB limit matching Express server

class RequestBodyError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'RequestBodyError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface WorkerAppDeps {
  aiService?: WorkerGeminiService;
  verifyToken?: WorkerTokenVerifier;
  rateLimiter?: WorkerRateLimitManager;
}

function withSecurityHeaders(
  response: Response,
  isApiRoute: boolean,
  extraHeaders?: Record<string, string>
): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (isApiRoute) {
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Frame-Options', 'DENY');
  }
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers.set(k, v);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): Response {
  return withSecurityHeaders(
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
    }),
    true,
    extraHeaders
  );
}

async function readJsonBodyWithLimit(request: Request): Promise<unknown> {
  const declaredLenHeader = request.headers.get('content-length');
  if (declaredLenHeader !== null) {
    const declaredLen = Number(declaredLenHeader);
    if (Number.isFinite(declaredLen) && declaredLen > MAX_REQUEST_BODY_BYTES) {
      throw new RequestBodyError(
        413,
        'PAYLOAD_TOO_LARGE',
        'Request payload exceeds the 64 KB size limit.'
      );
    }
  }

  if (!request.body) {
    throw new RequestBodyError(400, 'INVALID_JSON', 'Invalid JSON request body.');
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        totalBytes += value.byteLength;
        if (totalBytes > MAX_REQUEST_BODY_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new RequestBodyError(
            413,
            'PAYLOAD_TOO_LARGE',
            'Request payload exceeds the 64 KB size limit.'
          );
        }
        chunks.push(value);
      }
    }
  } catch (err) {
    if (err instanceof RequestBodyError) throw err;
    throw new RequestBodyError(400, 'INVALID_JSON', 'Unable to read request body.');
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let decodedText: string;
  try {
    decodedText = new TextDecoder('utf-8', { fatal: true }).decode(combined);
  } catch {
    throw new RequestBodyError(400, 'INVALID_JSON', 'Invalid UTF-8 in JSON request body.');
  }

  if (!decodedText.trim()) {
    throw new RequestBodyError(400, 'INVALID_JSON', 'Invalid JSON request body.');
  }

  try {
    return JSON.parse(decodedText) as unknown;
  } catch {
    throw new RequestBodyError(400, 'INVALID_JSON', 'Invalid JSON request body.');
  }
}

export function createWorkerHandler(deps: WorkerAppDeps = {}) {
  const aiService = deps.aiService ?? createWorkerGeminiService();
  const verifyToken = deps.verifyToken ?? createFirebaseTokenVerifier();
  const rateLimiter = deps.rateLimiter ?? new WorkerRateLimitManager();

  return {
    async fetch(
      request: Request,
      env: WorkerEnv,
      _ctx?: WorkerExecutionContext
    ): Promise<Response> {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const isApi = pathname === '/api' || pathname.startsWith('/api/');

      if (!isApi) {
        if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
          const assetRes = await env.ASSETS.fetch(request);
          return withSecurityHeaders(assetRes, false);
        }
        return withSecurityHeaders(new Response('Not Found', { status: 404 }), false);
      }

      if (pathname === '/api/health') {
        if (request.method !== 'GET') {
          return jsonResponse(405, {
            error: 'Method not allowed.',
            code: 'METHOD_NOT_ALLOWED',
          });
        }
        return jsonResponse(200, {
          status: 'ok',
          service: 'tripmate-worker-backend',
          timestamp: new Date().toISOString(),
          geminiConfigured: isGeminiConfigured(env),
          geminiModel: getConfiguredGeminiModel(env),
        });
      }

      const aiEndpoints = new Set([
        '/api/ai/generate-itinerary',
        '/api/ai/regenerate-day',
        '/api/ai/recommendations',
        '/api/ai/estimate-budget',
        '/api/ai/refine-activity',
      ]);

      if (!aiEndpoints.has(pathname)) {
        return jsonResponse(404, {
          error: 'API endpoint not found.',
          code: 'NOT_FOUND',
        });
      }

      if (request.method !== 'POST') {
        return jsonResponse(
          405,
          { error: 'Method not allowed. Use POST.', code: 'METHOD_NOT_ALLOWED' },
          { Allow: 'POST' }
        );
      }

      let lockKey: string | null = null;
      try {
        const auth = await authenticateWorkerRequest(request, env, verifyToken);

        const rateCheck = await rateLimiter.checkLimit(auth.uid, env);
        if (!rateCheck.allowed) {
          return jsonResponse(
            429,
            {
              error: rateCheck.message || 'AI request limit reached. Please try again later.',
              code: 'RATE_LIMIT_EXCEEDED',
            },
            rateCheck.retryAfterSec
              ? { 'Retry-After': String(rateCheck.retryAfterSec) }
              : undefined
          );
        }

        const rawBody = await readJsonBodyWithLimit(request);
        const model = getConfiguredGeminiModel(env);

        if (pathname === '/api/ai/generate-itinerary') {
          const input = validateGenerateItineraryInput(rawBody);
          lockKey = await rateLimiter.acquireDuplicateLock(auth.uid, 'generate-itinerary', input);
          if (!lockKey) {
            return jsonResponse(409, {
              error: 'An identical itinerary generation request is already in progress.',
              code: 'DUPLICATE_REQUEST',
            });
          }
          const data = await aiService.generateItinerary(env, input);
          return jsonResponse(200, { ok: true, model, uid: auth.uid, data });
        }

        if (pathname === '/api/ai/regenerate-day') {
          const input = validateRegenerateDayInput(rawBody);
          lockKey = await rateLimiter.acquireDuplicateLock(auth.uid, 'regenerate-day', input);
          if (!lockKey) {
            return jsonResponse(409, {
              error: `Day ${input.dayNumber} regeneration is already in progress.`,
              code: 'DUPLICATE_REQUEST',
            });
          }
          const data = await aiService.regenerateDay(env, input);
          return jsonResponse(200, { ok: true, model, uid: auth.uid, data });
        }

        if (pathname === '/api/ai/recommendations') {
          const input = validateRecommendationsInput(rawBody);
          lockKey = await rateLimiter.acquireDuplicateLock(auth.uid, 'recommendations', input);
          if (!lockKey) {
            return jsonResponse(409, {
              error: 'A recommendations request with these parameters is already in progress.',
              code: 'DUPLICATE_REQUEST',
            });
          }
          const items = await aiService.getRecommendations(env, input);
          return jsonResponse(200, {
            ok: true,
            model,
            uid: auth.uid,
            data: { recommendations: items },
          });
        }

        if (pathname === '/api/ai/estimate-budget') {
          const input = validateEstimateBudgetInput(rawBody);
          lockKey = await rateLimiter.acquireDuplicateLock(auth.uid, 'estimate-budget', input);
          if (!lockKey) {
            return jsonResponse(409, {
              error: 'A budget estimation request is already in progress.',
              code: 'DUPLICATE_REQUEST',
            });
          }
          const data = await aiService.estimateBudget(env, input);
          return jsonResponse(200, { ok: true, model, uid: auth.uid, data });
        }

        // /api/ai/refine-activity
        const input = validateRefineActivityInput(rawBody);
        lockKey = await rateLimiter.acquireDuplicateLock(auth.uid, 'refine-activity', input);
        if (!lockKey) {
          return jsonResponse(409, {
            error: 'This activity is already being refined. Please wait.',
            code: 'DUPLICATE_REQUEST',
          });
        }
        const data = await aiService.refineActivity(env, input);
        return jsonResponse(200, { ok: true, model, uid: auth.uid, data });
      } catch (err) {
        if (
          err instanceof FirebaseAuthError ||
          err instanceof RequestBodyError ||
          err instanceof RequestValidationError ||
          err instanceof MalformedAiOutputError ||
          err instanceof GeminiServiceError
        ) {
          return jsonResponse(err.statusCode, { error: err.message, code: err.code });
        }

        const safeLogMessage = redactSensitiveText(
          err instanceof Error ? err.message : 'Unknown error'
        );
        console.error(`[TripMate Worker Error] ${request.method} ${pathname}:`, safeLogMessage);
        return jsonResponse(500, {
          error: 'Internal server error while processing request.',
          code: 'INTERNAL_ERROR',
        });
      } finally {
        rateLimiter.releaseDuplicateLock(lockKey);
      }
    },
  };
}
