import assert from 'node:assert/strict';
import test from 'node:test';
import * as serverSchemas from '../../server/schemas/aiSchemas';
import * as serverNormalizer from '../../server/utils/responseNormalizer';
import {
  clearFirebaseJwksCache,
  createFirebaseTokenVerifier,
  FIREBASE_JWKS_URL,
} from '../auth/firebaseAuth';
import { createWorkerHandler, MAX_REQUEST_BODY_BYTES } from '../app';
import { WorkerRateLimitManager } from '../middleware/rateLimit';
import * as workerSchemas from '../schemas/aiSchemas';
import { createRestGeminiAdapter, createWorkerGeminiService } from '../services/geminiService';
import { WorkerEnv } from '../types';
import * as workerNormalizer from '../utils/responseNormalizer';

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function jsonToBase64Url(obj: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function generateRsaTestKeyPair(kid = 'test-key-1') {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );

  const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey & {
    kid?: string;
    alg?: string;
    use?: string;
  };
  publicJwk.kid = kid;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  return {
    privateKey: keyPair.privateKey,
    publicJwk,
    kid,
  };
}

async function signJwt(
  privateKey: CryptoKey,
  header: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<string> {
  const signingInput = `${jsonToBase64Url(header)}.${jsonToBase64Url(payload)}`;
  const sigBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(sigBuffer))}`;
}

function createValidClaims(nowSec: number, overrides: Record<string, unknown> = {}) {
  const defaultSub = typeof overrides.sub === 'string' ? overrides.sub : 'user-uid-123';
  return {
    aud: 'tripmate-81b7c',
    iss: 'https://securetoken.google.com/tripmate-81b7c',
    sub: defaultSub,
    user_id: defaultSub,
    email: 'traveler@example.com',
    email_verified: true,
    iat: nowSec - 60,
    auth_time: nowSec - 60,
    exp: nowSec + 3600,
    ...overrides,
  };
}

function createMockFetchForJwks(jwksByCall: Array<{ keys: unknown[] }>) {
  let jwksCallIndex = 0;
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === FIREBASE_JWKS_URL) {
      const payload = jwksByCall[Math.min(jwksCallIndex, jwksByCall.length - 1)];
      jwksCallIndex++;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }
    throw new Error(`Unexpected fetch URL in JWKS mock: ${url}`);
  };
}

const VALID_GENERATE_PAYLOAD = {
  origin: 'Bengaluru',
  destination: 'Udaipur',
  daysCount: 2,
  startDate: '2026-12-01',
  endDate: '2026-12-02',
  adults: 2,
  children: 0,
  budget: { total: 20000, daily: 10000, food: 6000, transport: 4000, attraction: 10000 },
  travelStyle: 'Balanced',
  dayPlans: [
    { dayNumber: 1, title: 'Lakes & Palaces', pace: 'Relaxed', notes: [] },
    { dayNumber: 2, title: 'Old City Heritage', pace: 'Balanced', notes: [] },
  ],
  generalNotes: [],
  stayMode: 'without-hotel',
  commuteMode: 'DRIVING',
};

const VALID_BUDGET_PAYLOAD = {
  destination: 'Jaipur',
  origin: 'Delhi',
  daysCount: 3,
  adults: 2,
  children: 1,
  travelStyle: 'Balanced',
  accommodationPreference: 'Mid-range heritage hotel',
  currency: 'INR',
  userBudgetTotal: 35000,
  plannedActivities: [{ title: 'Amber Fort', category: 'Attraction', cost: 1000, day: 1 }],
};

test('Schema Parity: all 5 Worker Gemini response schemas match Express server schemas 1:1', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(workerSchemas.GENERATE_ITINERARY_SCHEMA)),
    JSON.parse(JSON.stringify(serverSchemas.GENERATE_ITINERARY_SCHEMA))
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(workerSchemas.REGENERATE_DAY_SCHEMA)),
    JSON.parse(JSON.stringify(serverSchemas.REGENERATE_DAY_SCHEMA))
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(workerSchemas.RECOMMENDATIONS_SCHEMA)),
    JSON.parse(JSON.stringify(serverSchemas.RECOMMENDATIONS_SCHEMA))
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(workerSchemas.ESTIMATE_BUDGET_SCHEMA)),
    JSON.parse(JSON.stringify(serverSchemas.ESTIMATE_BUDGET_SCHEMA))
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(workerSchemas.REFINE_ACTIVITY_SCHEMA)),
    JSON.parse(JSON.stringify(serverSchemas.REFINE_ACTIVITY_SCHEMA))
  );
});

test('Auth: Firebase Web Crypto RS256 verifies valid tokens, supports kid rotation, and rejects invalid/unverified tokens', async () => {
  clearFirebaseJwksCache();
  const key1 = await generateRsaTestKeyPair('kid-1');
  const key2 = await generateRsaTestKeyPair('kid-2');
  const fixedNowMs = 1_795_000_000_000;
  const nowSec = Math.floor(fixedNowMs / 1000);

  const mockFetch = createMockFetchForJwks([
    { keys: [key1.publicJwk] },
    { keys: [key1.publicJwk, key2.publicJwk] },
  ]);

  const verifier = createFirebaseTokenVerifier({
    fetchImpl: mockFetch,
    nowMs: () => fixedNowMs,
  });

  const env: WorkerEnv = { FIREBASE_PROJECT_ID: 'tripmate-81b7c' };

  // 1. Valid verified token with kid-1
  const validToken = await signJwt(
    key1.privateKey,
    { alg: 'RS256', kid: 'kid-1', typ: 'JWT' },
    createValidClaims(nowSec)
  );
  const verified = await verifier(validToken, env);
  assert.equal(verified.uid, 'user-uid-123');
  assert.equal(verified.emailVerified, true);

  // 2. Unknown kid triggers single JWKS refresh and succeeds with kid-2
  const rotatedToken = await signJwt(
    key2.privateKey,
    { alg: 'RS256', kid: 'kid-2', typ: 'JWT' },
    createValidClaims(nowSec, { sub: 'rotated-uid' })
  );
  const verifiedRotated = await verifier(rotatedToken, env);
  assert.equal(verifiedRotated.uid, 'rotated-uid');

  // 3. Rejection cases
  const unverifiedEmailToken = await signJwt(
    key1.privateKey,
    { alg: 'RS256', kid: 'kid-1', typ: 'JWT' },
    createValidClaims(nowSec, { email_verified: false })
  );
  await assert.rejects(
    () => verifier(unverifiedEmailToken, env),
    (err: { statusCode: number; code: string }) =>
      err.statusCode === 403 && err.code === 'EMAIL_NOT_VERIFIED'
  );

  const expiredToken = await signJwt(
    key1.privateKey,
    { alg: 'RS256', kid: 'kid-1', typ: 'JWT' },
    createValidClaims(nowSec, { exp: nowSec - 1 })
  );
  await assert.rejects(
    () => verifier(expiredToken, env),
    (err: { statusCode: number; code: string }) => err.statusCode === 401 && err.code === 'AUTH_EXPIRED'
  );

  const wrongAudToken = await signJwt(
    key1.privateKey,
    { alg: 'RS256', kid: 'kid-1', typ: 'JWT' },
    createValidClaims(nowSec, { aud: 'other-firebase-project' })
  );
  await assert.rejects(
    () => verifier(wrongAudToken, env),
    (err: { statusCode: number; code: string }) => err.statusCode === 401 && err.code === 'AUTH_INVALID'
  );

  const wrongIssToken = await signJwt(
    key1.privateKey,
    { alg: 'RS256', kid: 'kid-1', typ: 'JWT' },
    createValidClaims(nowSec, { iss: 'https://securetoken.google.com/other-firebase-project' })
  );
  await assert.rejects(
    () => verifier(wrongIssToken, env),
    (err: { statusCode: number; code: string }) => err.statusCode === 401 && err.code === 'AUTH_INVALID'
  );

  const futureIatToken = await signJwt(
    key1.privateKey,
    { alg: 'RS256', kid: 'kid-1', typ: 'JWT' },
    createValidClaims(nowSec, { iat: nowSec + 900 })
  );
  await assert.rejects(
    () => verifier(futureIatToken, env),
    (err: { statusCode: number; code: string }) => err.statusCode === 401 && err.code === 'AUTH_INVALID'
  );

  const missingSubToken = await signJwt(
    key1.privateKey,
    { alg: 'RS256', kid: 'kid-1', typ: 'JWT' },
    createValidClaims(nowSec, { sub: '', user_id: '' })
  );
  await assert.rejects(
    () => verifier(missingSubToken, env),
    (err: { statusCode: number; code: string }) => err.statusCode === 401 && err.code === 'AUTH_INVALID'
  );

  const mismatchedUidToken = await signJwt(
    key1.privateKey,
    { alg: 'RS256', kid: 'kid-1', typ: 'JWT' },
    createValidClaims(nowSec, { sub: 'uid-a', user_id: 'uid-b' })
  );
  await assert.rejects(
    () => verifier(mismatchedUidToken, env),
    (err: { statusCode: number; code: string }) => err.statusCode === 401 && err.code === 'AUTH_INVALID'
  );

  const algNoneToken = `${jsonToBase64Url({ alg: 'none', kid: 'kid-1' })}.${jsonToBase64Url(
    createValidClaims(nowSec)
  )}.fakeSig`;
  await assert.rejects(
    () => verifier(algNoneToken, env),
    (err: { statusCode: number; code: string }) => err.statusCode === 401 && err.code === 'AUTH_INVALID'
  );

  // Tampered payload fails Web Crypto RS256 signature verification
  const [h, , s] = validToken.split('.');
  const tamperedPayload = jsonToBase64Url(createValidClaims(nowSec, { sub: 'attacker-uid' }));
  await assert.rejects(
    () => verifier(`${h}.${tamperedPayload}.${s}`, env),
    (err: { statusCode: number; code: string }) => err.statusCode === 401 && err.code === 'AUTH_INVALID'
  );

  // Unknown kid fails cleanly
  const unknownKidToken = await signJwt(
    key1.privateKey,
    { alg: 'RS256', kid: 'kid-unknown', typ: 'JWT' },
    createValidClaims(nowSec)
  );
  await assert.rejects(
    () => verifier(unknownKidToken, env),
    (err: { statusCode: number; code: string }) => err.statusCode === 401 && err.code === 'AUTH_INVALID'
  );
});

test('HTTP Auth, Oversized Payloads (Content-Length & Chunked), Malformed JSON, and Methods', async () => {
  clearFirebaseJwksCache();
  const key = await generateRsaTestKeyPair('kid-http');
  const nowSec = Math.floor(Date.now() / 1000);
  const token = await signJwt(
    key.privateKey,
    { alg: 'RS256', kid: 'kid-http', typ: 'JWT' },
    createValidClaims(nowSec)
  );

  const worker = createWorkerHandler({
    verifyToken: createFirebaseTokenVerifier({
      fetchImpl: createMockFetchForJwks([{ keys: [key.publicJwk] }]),
    }),
  });
  const env: WorkerEnv = { FIREBASE_PROJECT_ID: 'tripmate-81b7c', GEMINI_API_KEY: 'dummy-test-key' };

  // Health endpoint
  const healthRes = await worker.fetch(new Request('https://example.workers.dev/api/health'), env);
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.headers.get('cache-control'), 'no-store');
  assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
  const healthJson = (await healthRes.json()) as {
    service: string;
    geminiConfigured: boolean;
    geminiModel: string;
  };
  assert.equal(healthJson.service, 'tripmate-worker-backend');
  assert.equal(healthJson.geminiConfigured, true);
  assert.equal(healthJson.geminiModel, 'gemini-4-hydrogen');

  // Missing Auth -> 401 AUTH_MISSING
  const unauthRes = await worker.fetch(
    new Request('https://example.workers.dev/api/ai/estimate-budget', {
      method: 'POST',
      body: JSON.stringify(VALID_BUDGET_PAYLOAD),
    }),
    env
  );
  assert.equal(unauthRes.status, 401);
  assert.equal(((await unauthRes.json()) as { code: string }).code, 'AUTH_MISSING');

  // Malformed Bearer header -> 401 AUTH_MALFORMED
  const badHeaderRes = await worker.fetch(
    new Request('https://example.workers.dev/api/ai/estimate-budget', {
      method: 'POST',
      headers: { Authorization: 'Basic abc123' },
      body: JSON.stringify(VALID_BUDGET_PAYLOAD),
    }),
    env
  );
  assert.equal(badHeaderRes.status, 401);
  assert.equal(((await badHeaderRes.json()) as { code: string }).code, 'AUTH_MALFORMED');

  // Non-POST on AI route -> 405 METHOD_NOT_ALLOWED
  const getAiRes = await worker.fetch(
    new Request('https://example.workers.dev/api/ai/estimate-budget', { method: 'GET' }),
    env
  );
  assert.equal(getAiRes.status, 405);

  // Unknown API endpoint -> 404 JSON
  const notFoundRes = await worker.fetch(new Request('https://example.workers.dev/api/unknown'), env);
  assert.equal(notFoundRes.status, 404);
  assert.equal(((await notFoundRes.json()) as { code: string }).code, 'NOT_FOUND');

  // Oversized via Content-Length header -> 413 PAYLOAD_TOO_LARGE
  const headerOversizedRes = await worker.fetch(
    new Request('https://example.workers.dev/api/ai/estimate-budget', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Length': String(MAX_REQUEST_BODY_BYTES + 1),
      },
      body: '{}',
    }),
    env
  );
  assert.equal(headerOversizedRes.status, 413);
  assert.equal(((await headerOversizedRes.json()) as { code: string }).code, 'PAYLOAD_TOO_LARGE');

  // Oversized streaming body WITHOUT Content-Length header -> 413 PAYLOAD_TOO_LARGE
  const bigChunk = new Uint8Array(MAX_REQUEST_BODY_BYTES + 500).fill(97);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bigChunk.slice(0, 40000));
      controller.enqueue(bigChunk.slice(40000));
      controller.close();
    },
  });
  const streamOversizedRes = await worker.fetch(
    new Request('https://example.workers.dev/api/ai/estimate-budget', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: stream,
      // @ts-expect-error duplex required in Node Request init for ReadableStream
      duplex: 'half',
    }),
    env
  );
  assert.equal(streamOversizedRes.status, 413);
  assert.equal(((await streamOversizedRes.json()) as { code: string }).code, 'PAYLOAD_TOO_LARGE');

  // Malformed JSON -> 400 INVALID_JSON
  const badJsonRes = await worker.fetch(
    new Request('https://example.workers.dev/api/ai/estimate-budget', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{"destination": ',
    }),
    env
  );
  assert.equal(badJsonRes.status, 400);
  assert.equal(((await badJsonRes.json()) as { code: string }).code, 'INVALID_JSON');

  // JSON array instead of object -> 400 VALIDATION_ERROR
  const arrayBodyRes = await worker.fetch(
    new Request('https://example.workers.dev/api/ai/estimate-budget', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '[]',
    }),
    env
  );
  assert.equal(arrayBodyRes.status, 400);
  assert.equal(((await arrayBodyRes.json()) as { code: string }).code, 'VALIDATION_ERROR');
});

test('Validation & Normalization: calendar dates, overflow packing, positional day fallback, 23:50 clamping, and parity', () => {
  // Invalid calendar date rejected
  assert.throws(
    () =>
      workerSchemas.validateGenerateItineraryInput({
        ...VALID_GENERATE_PAYLOAD,
        startDate: '2026-02-30',
      }),
    (err: { code: string }) => err.code === 'VALIDATION_ERROR'
  );

  // endDate < startDate rejected on recommendations
  assert.throws(
    () =>
      workerSchemas.validateRecommendationsInput({
        destination: 'Goa',
        category: 'places_to_visit',
        startDate: '2026-12-10',
        endDate: '2026-12-05',
      }),
    (err: { code: string }) => err.code === 'VALIDATION_ERROR'
  );

  // Positional day fallback must NOT mask explicit dayNumber mismatch
  const validatedGen = workerSchemas.validateGenerateItineraryInput(VALID_GENERATE_PAYLOAD);
  const badDaysRaw = JSON.stringify({
    tripTitle: 'Bad Day Numbers',
    overview: 'Test',
    practicalNotes: [],
    days: [
      { dayNumber: 1, title: 'D1', pace: 'Relaxed', notes: [], activities: [{ title: 'A1' }] },
      { dayNumber: 3, title: 'D3', pace: 'Relaxed', notes: [], activities: [{ title: 'A3' }] },
    ],
  });
  assert.throws(
    () => workerNormalizer.normalizeGeneratedItinerary(badDaysRaw, validatedGen),
    (err: { code: string }) => err.code === 'AI_MALFORMED_OUTPUT'
  );

  // Overflow re-packing preserves chronological non-overlapping schedule
  const overflowRaw = JSON.stringify({
    tripTitle: 'Packed Day',
    overview: 'Test',
    practicalNotes: [],
    days: [
      {
        dayNumber: 1,
        title: 'D1',
        pace: 'Activity-heavy',
        notes: [],
        activities: [
          { title: 'Stop 1', startTime: '09:00', durationMinutes: 300, estimatedCost: 100 },
          { title: 'Stop 2', startTime: '15:00', durationMinutes: 300, estimatedCost: 200 },
          { title: 'Stop 3', startTime: '21:00', durationMinutes: 300, estimatedCost: 300 },
        ],
      },
      {
        dayNumber: 2,
        title: 'D2',
        pace: 'Relaxed',
        notes: [],
        activities: [{ title: 'Stop 4', startTime: '10:00', durationMinutes: 90, estimatedCost: 0 }],
      },
    ],
  });
  const workerPacked = workerNormalizer.normalizeGeneratedItinerary(overflowRaw, validatedGen);
  const serverPacked = serverNormalizer.normalizeGeneratedItinerary(
    overflowRaw,
    serverSchemas.validateGenerateItineraryInput(VALID_GENERATE_PAYLOAD)
  );
  const wDay1 = workerPacked.activities.filter((a) => a.day === 1);
  for (let i = 0; i < wDay1.length; i++) {
    assert.ok(wDay1[i].startTime < wDay1[i].endTime);
    if (i > 0) {
      assert.ok(wDay1[i].startTime >= wDay1[i - 1].endTime, 'Activities must not overlap');
    }
  }
  assert.deepEqual(
    workerPacked.activities.map((a) => ({ s: a.startTime, e: a.endTime, d: a.durationMinutes })),
    serverPacked.activities.map((a) => ({ s: a.startTime, e: a.endTime, d: a.durationMinutes }))
  );

  // Late-night refine-activity clamps startTime <= 23:30 so startTime < endTime
  const refineInput = workerSchemas.validateRefineActivityInput({
    destination: 'Goa',
    daysCount: 2,
    dayNumber: 1,
    instruction: 'Move to late evening slot',
    activity: {
      id: 'act-1',
      title: 'Night Market',
      description: 'Market walk',
      category: 'Leisure',
      location: 'Anjuna',
      startTime: '21:00',
      endTime: '22:00',
      durationMinutes: 60,
      cost: 500,
      day: 1,
    },
  });
  const refined = workerNormalizer.normalizeRefinedActivity(
    JSON.stringify({
      title: 'Anjuna Night Market',
      startTime: '23:55',
      durationMinutes: 60,
      estimatedCost: 600,
    }),
    refineInput
  );
  assert.equal(refined.activity.startTime, '23:30');
  assert.equal(refined.activity.endTime, '23:55');
  assert.equal(refined.activity.durationMinutes, 25);
});

test('Rate Limiting & Duplicate-Request Protection (Cloudflare Binding + Isolate Fallback)', async () => {
  clearFirebaseJwksCache();
  const key = await generateRsaTestKeyPair('kid-rl');
  const nowSec = Math.floor(Date.now() / 1000);
  const token = await signJwt(
    key.privateKey,
    { alg: 'RS256', kid: 'kid-rl', typ: 'JWT' },
    createValidClaims(nowSec, { sub: 'rl-user' })
  );

  // 1. Cloudflare binding denies when limit returns { success: false }
  let limitCalls = 0;
  const bindingDeniedEnv: WorkerEnv = {
    FIREBASE_PROJECT_ID: 'tripmate-81b7c',
    GEMINI_API_KEY: 'dummy-test-key',
    AI_RATE_LIMITER: {
      async limit({ key: rateKey }) {
        limitCalls++;
        assert.equal(rateKey, 'ai:min:rl-user');
        return { success: false };
      },
    },
  };

  const worker1 = createWorkerHandler({
    verifyToken: createFirebaseTokenVerifier({
      fetchImpl: createMockFetchForJwks([{ keys: [key.publicJwk] }]),
    }),
  });
  const deniedRes = await worker1.fetch(
    new Request('https://example.workers.dev/api/ai/estimate-budget', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BUDGET_PAYLOAD),
    }),
    bindingDeniedEnv
  );
  assert.equal(limitCalls, 1);
  assert.equal(deniedRes.status, 429);
  assert.equal(deniedRes.headers.get('retry-after'), '60');
  assert.equal(((await deniedRes.json()) as { code: string }).code, 'RATE_LIMIT_EXCEEDED');

  // 2. Isolate sliding-window enforces limit when binding is absent
  const isolateLimiter = new WorkerRateLimitManager({ maxPerMinute: 2, maxPerHour: 10 });
  const envNoBinding: WorkerEnv = { FIREBASE_PROJECT_ID: 'tripmate-81b7c', GEMINI_API_KEY: 'dummy' };
  assert.equal((await isolateLimiter.checkLimit('u1', envNoBinding)).allowed, true);
  assert.equal((await isolateLimiter.checkLimit('u1', envNoBinding)).allowed, true);
  const third = await isolateLimiter.checkLimit('u1', envNoBinding);
  assert.equal(third.allowed, false);
  assert.ok((third.retryAfterSec ?? 0) >= 1);

  // 3. Duplicate lock rejects concurrent identical requests with 409, then releases cleanly
  let resolveSlowCall!: (v: string) => void;
  const slowAdapter = {
    generateJson: () =>
      new Promise<string>((resolve) => {
        resolveSlowCall = resolve;
      }),
  };
  const workerSlow = createWorkerHandler({
    verifyToken: createFirebaseTokenVerifier({
      fetchImpl: createMockFetchForJwks([{ keys: [key.publicJwk] }]),
    }),
    aiService: createWorkerGeminiService(slowAdapter),
  });

  const p1 = workerSlow.fetch(
    new Request('https://example.workers.dev/api/ai/estimate-budget', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BUDGET_PAYLOAD),
    }),
    envNoBinding
  );
  await new Promise((r) => setTimeout(r, 20));
  const p2 = await workerSlow.fetch(
    new Request('https://example.workers.dev/api/ai/estimate-budget', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BUDGET_PAYLOAD),
    }),
    envNoBinding
  );
  assert.equal(p2.status, 409);
  assert.equal(((await p2.json()) as { code: string }).code, 'DUPLICATE_REQUEST');

  resolveSlowCall(
    JSON.stringify({
      currency: 'INR',
      categories: {
        accommodation: 12000,
        food: 6000,
        localTransport: 3000,
        intercityTransport: 5000,
        activitiesAndAttractions: 4000,
        shopping: 2000,
        miscellaneous: 1000,
        contingency: 2000,
      },
      categoryNotes: {},
      assumptions: ['Mid-range hotel stay'],
      disclaimer: 'Planning estimate only.',
    })
  );
  const res1 = await p1;
  assert.equal(res1.status, 200);
});

test('All Five AI Endpoints + Gemini REST Security (Header Key, thinkingConfig, Redaction, Timeout)', async () => {
  clearFirebaseJwksCache();
  const key = await generateRsaTestKeyPair('kid-e2e');
  const nowSec = Math.floor(Date.now() / 1000);
  const token = await signJwt(
    key.privateKey,
    { alg: 'RS256', kid: 'kid-e2e', typ: 'JWT' },
    createValidClaims(nowSec, { sub: 'e2e-user' })
  );

  const geminiCalls: Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [];

  const mockGeminiFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headersObj = Object.fromEntries(new Headers(init?.headers).entries());
    const parsedBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    geminiCalls.push({ url, headers: headersObj, body: parsedBody });

    let responseJson: unknown;
    if (parsedBody.generationConfig && (parsedBody.generationConfig as { responseSchema?: { properties?: Record<string, unknown> } }).responseSchema?.properties?.days) {
      responseJson = {
        tripTitle: 'Royal Udaipur Escape',
        overview: '2-day heritage and lakes plan.',
        practicalNotes: ['Carry light cottons'],
        days: [
          {
            dayNumber: 1,
            title: 'Lakes & Palaces',
            pace: 'Relaxed',
            notes: ['Evening boat ride'],
            activities: [
              {
                title: 'City Palace Visit',
                description: 'Explore royal courtyards.',
                category: 'Culture',
                location: 'Old City, Udaipur',
                startTime: '09:30',
                durationMinutes: 120,
                estimatedCost: 800,
                isChildFriendly: true,
                crowdLevel: 'Moderate',
                notes: 'Book morning entry.',
              },
            ],
          },
          {
            dayNumber: 2,
            title: 'Gardens & Cafes',
            pace: 'Balanced',
            notes: [],
            activities: [
              {
                title: 'Saheliyon Ki Bari',
                description: 'Stroll historic fountains.',
                category: 'Nature',
                location: 'Panchwati, Udaipur',
                startTime: '09:00',
                durationMinutes: 90,
                estimatedCost: 200,
                isChildFriendly: true,
                crowdLevel: 'Low',
                notes: 'Peaceful morning walk.',
              },
            ],
          },
        ],
      };
    } else if (parsedBody.generationConfig && (parsedBody.generationConfig as { responseSchema?: { properties?: Record<string, unknown> } }).responseSchema?.properties?.recommendations) {
      responseJson = {
        recommendations: [
          {
            name: 'Bagore Ki Haveli',
            category: 'Culture',
            locationHint: 'Gangaur Ghat',
            shortExplanation: 'Lakefront mansion museum.',
            whyItSuitsTrip: 'Great heritage stop.',
            approxCostMin: 100,
            approxCostMax: 300,
            suggestedDurationMinutes: 90,
            importantCaveats: 'Verify evening show timings.',
            isChildFriendly: true,
            crowdLevel: 'Moderate',
            tags: ['Similar'],
          },
        ],
      };
    } else if (parsedBody.generationConfig && (parsedBody.generationConfig as { responseSchema?: { properties?: Record<string, unknown> } }).responseSchema?.properties?.categories) {
      responseJson = {
        currency: 'INR',
        categories: {
          accommodation: 10000,
          food: 5000,
          localTransport: 2000,
          intercityTransport: 4000,
          activitiesAndAttractions: 3000,
          shopping: 1500,
          miscellaneous: 1000,
          contingency: 1500,
        },
        categoryNotes: { accommodation: 'Mid-range stay' },
        assumptions: ['2 adults'],
        disclaimer: 'AI estimate only.',
      };
    } else if (parsedBody.generationConfig && (parsedBody.generationConfig as { responseSchema?: { properties?: Record<string, unknown> } }).responseSchema?.properties?.changeSummary) {
      responseJson = {
        title: 'Sunset Lake Boat Ride',
        description: 'Relaxing evening ferry.',
        category: 'Leisure',
        location: 'Lake Pichola',
        startTime: '17:00',
        durationMinutes: 60,
        estimatedCost: 900,
        isChildFriendly: true,
        crowdLevel: 'Moderate',
        notes: 'Arrive 15m early.',
        changeSummary: 'Shifted to sunset slot.',
      };
    } else {
      responseJson = {
        dayNumber: 2,
        title: 'Refreshed Day 2',
        pace: 'Relaxed',
        notes: ['Relaxed pace'],
        activities: [
          {
            title: 'Fateh Sagar Promenade',
            description: 'Evening lakeside stroll.',
            category: 'Nature',
            location: 'Fateh Sagar Lake',
            startTime: '16:30',
            durationMinutes: 90,
            estimatedCost: 150,
            isChildFriendly: true,
            crowdLevel: 'Low',
            notes: 'Try local kulhad coffee.',
          },
        ],
      };
    }

    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(responseJson) }] } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const worker = createWorkerHandler({
    verifyToken: createFirebaseTokenVerifier({
      fetchImpl: createMockFetchForJwks([{ keys: [key.publicJwk] }]),
    }),
    aiService: createWorkerGeminiService(createRestGeminiAdapter(mockGeminiFetch)),
  });

  const env: WorkerEnv = {
    FIREBASE_PROJECT_ID: 'tripmate-81b7c',
    GEMINI_API_KEY: 'AIzaTestSecretShouldOnlyStayInHeader123456',
    GEMINI_MODEL: 'gemini-4-hydrogen',
  };

  const endpoints: Array<{ path: string; body: unknown }> = [
    { path: '/api/ai/generate-itinerary', body: VALID_GENERATE_PAYLOAD },
    {
      path: '/api/ai/regenerate-day',
      body: {
        destination: 'Udaipur',
        origin: 'Bengaluru',
        daysCount: 2,
        dayNumber: 2,
        instruction: 'Make it relaxed near the lake',
        dayPlan: { dayNumber: 2, title: 'Day 2', pace: 'Relaxed', notes: [] },
      },
    },
    {
      path: '/api/ai/recommendations',
      body: { destination: 'Udaipur', category: 'places_to_visit', daysCount: 2 },
    },
    { path: '/api/ai/estimate-budget', body: VALID_BUDGET_PAYLOAD },
    {
      path: '/api/ai/refine-activity',
      body: {
        destination: 'Udaipur',
        daysCount: 2,
        dayNumber: 1,
        instruction: 'Move to sunset',
        activity: {
          id: 'act-1',
          title: 'Boat Ride',
          description: 'Lake cruise',
          category: 'Leisure',
          location: 'Lake Pichola',
          startTime: '15:00',
          endTime: '16:00',
          durationMinutes: 60,
          cost: 800,
          day: 1,
        },
      },
    },
  ];

  for (const ep of endpoints) {
    const res = await worker.fetch(
      new Request(`https://example.workers.dev${ep.path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(ep.body),
      }),
      env
    );
    assert.equal(res.status, 200, `Expected 200 for ${ep.path}`);
    const json = (await res.json()) as { ok: boolean; model: string; uid: string; data: unknown };
    assert.equal(json.ok, true);
    assert.equal(json.model, 'gemini-4-hydrogen');
    assert.equal(json.uid, 'e2e-user');
    assert.ok(json.data);
  }

  assert.equal(geminiCalls.length, 5);
  for (const call of geminiCalls) {
    assert.equal(
      call.url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent'
    );
    assert.ok(!call.url.includes('AIza'), 'API key must NEVER appear in query string URL');
    assert.equal(call.headers['x-goog-api-key'], 'AIzaTestSecretShouldOnlyStayInHeader123456');
  }
  assert.deepEqual(
    (geminiCalls[0].body.generationConfig as { thinkingConfig?: unknown }).thinkingConfig,
    { thinkingLevel: 'MEDIUM' }
  );
  assert.deepEqual(
    (geminiCalls[1].body.generationConfig as { thinkingConfig?: unknown }).thinkingConfig,
    { thinkingLevel: 'LOW' }
  );

  // Verify non-Gemini-3/4 fallback omits thinkingConfig
  const fallbackAdapter = createRestGeminiAdapter(mockGeminiFetch);
  await fallbackAdapter.generateJson({
    env: { ...env, GEMINI_MODEL: 'gemini-2.5-flash' },
    systemInstruction: 'sys',
    prompt: 'hi',
    responseSchema: workerSchemas.ESTIMATE_BUDGET_SCHEMA,
    thinkingLevel: 'LOW',
  });
  const fallbackCall = geminiCalls[geminiCalls.length - 1];
  assert.equal(
    (fallbackCall.body.generationConfig as { thinkingConfig?: unknown }).thinkingConfig,
    undefined
  );

  // Verify secret redaction if upstream echoes key
  const leakyAdapter = createRestGeminiAdapter(async () => {
    return new Response(
      JSON.stringify({
        error: { message: 'Invalid key AIzaLeakedKey1234567890abcdef in request' },
      }),
      { status: 400 }
    );
  });
  await assert.rejects(
    () =>
      leakyAdapter.generateJson({
        env,
        systemInstruction: 'sys',
        prompt: 'prompt',
        responseSchema: workerSchemas.ESTIMATE_BUDGET_SCHEMA,
        thinkingLevel: 'LOW',
      }),
    (err: Error) => !err.message.includes('AIzaLeakedKey') && err.message.includes('[REDACTED]')
  );

  // Verify missing GEMINI_API_KEY -> 503 GEMINI_NOT_CONFIGURED
  await assert.rejects(
    () =>
      fallbackAdapter.generateJson({
        env: { FIREBASE_PROJECT_ID: 'tripmate-81b7c' },
        systemInstruction: 'sys',
        prompt: 'prompt',
        responseSchema: workerSchemas.ESTIMATE_BUDGET_SCHEMA,
        thinkingLevel: 'LOW',
      }),
    (err: { statusCode: number; code: string }) =>
      err.statusCode === 503 && err.code === 'GEMINI_NOT_CONFIGURED'
  );

  // Verify timeout does NOT trigger 3x retries
  let timeoutAttempts = 0;
  const timeoutAdapter = createRestGeminiAdapter(async (_input, init) => {
    timeoutAttempts++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        reject(abortErr);
      });
    });
  });
  await assert.rejects(
    () =>
      timeoutAdapter.generateJson({
        env,
        systemInstruction: 'sys',
        prompt: 'prompt',
        responseSchema: workerSchemas.ESTIMATE_BUDGET_SCHEMA,
        thinkingLevel: 'LOW',
        timeoutMs: 30,
      }),
    (err: { statusCode: number; code: string }) =>
      err.statusCode === 504 && err.code === 'GEMINI_TIMEOUT'
  );
  assert.equal(timeoutAttempts, 1, 'GEMINI_TIMEOUT must not trigger 3x retries');
});
