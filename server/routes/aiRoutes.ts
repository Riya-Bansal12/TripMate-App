import { NextFunction, Request, Response, Router } from 'express';
import { createAuthMiddleware, TokenVerifierFn } from '../middleware/authMiddleware';
import { RateLimitManager } from '../middleware/rateLimitMiddleware';
import {
  RequestValidationError,
  validateEstimateBudgetInput,
  validateGenerateItineraryInput,
  validateRecommendationsInput,
  validateRefineActivityInput,
  validateRegenerateDayInput,
} from '../schemas/aiSchemas';
import {
  createGeminiAiService,
  GeminiAiService,
  GeminiServiceError,
  getConfiguredGeminiModel,
} from '../services/geminiService';
import { MalformedAiOutputError } from '../utils/responseNormalizer';

export interface AiRouterDeps {
  aiService?: GeminiAiService;
  verifyToken?: TokenVerifierFn;
  rateLimiter?: RateLimitManager;
}

export function createAiRouter(deps: AiRouterDeps = {}): Router {
  const router = Router();
  const aiService = deps.aiService ?? createGeminiAiService();
  const requireAuth = createAuthMiddleware(deps.verifyToken);
  const rateLimiter = deps.rateLimiter ?? new RateLimitManager();

  router.use(requireAuth);
  router.use(rateLimiter.middleware);

  const handleRouteError = (err: unknown, res: Response, next: NextFunction) => {
    if (err instanceof RequestValidationError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof MalformedAiOutputError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof GeminiServiceError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    next(err);
  };

  router.post('/generate-itinerary', async (req: Request, res: Response, next: NextFunction) => {
    const uid = req.auth!.uid;
    let lockKey: string | null = null;
    try {
      const input = validateGenerateItineraryInput(req.body);
      lockKey = rateLimiter.acquireDuplicateLock(uid, 'generate-itinerary', input);
      if (!lockKey) {
        res.status(409).json({
          error: 'An identical itinerary generation request is already in progress.',
          code: 'DUPLICATE_REQUEST',
        });
        return;
      }

      const data = await aiService.generateItinerary(input);
      res.status(200).json({
        ok: true,
        model: getConfiguredGeminiModel(),
        uid,
        data,
      });
    } catch (err) {
      handleRouteError(err, res, next);
    } finally {
      rateLimiter.releaseDuplicateLock(lockKey);
    }
  });

  router.post('/regenerate-day', async (req: Request, res: Response, next: NextFunction) => {
    const uid = req.auth!.uid;
    let lockKey: string | null = null;
    try {
      const input = validateRegenerateDayInput(req.body);
      lockKey = rateLimiter.acquireDuplicateLock(uid, 'regenerate-day', input);
      if (!lockKey) {
        res.status(409).json({
          error: `Day ${input.dayNumber} regeneration is already in progress.`,
          code: 'DUPLICATE_REQUEST',
        });
        return;
      }

      const data = await aiService.regenerateDay(input);
      res.status(200).json({
        ok: true,
        model: getConfiguredGeminiModel(),
        uid,
        data,
      });
    } catch (err) {
      handleRouteError(err, res, next);
    } finally {
      rateLimiter.releaseDuplicateLock(lockKey);
    }
  });

  router.post('/recommendations', async (req: Request, res: Response, next: NextFunction) => {
    const uid = req.auth!.uid;
    let lockKey: string | null = null;
    try {
      const input = validateRecommendationsInput(req.body);
      lockKey = rateLimiter.acquireDuplicateLock(uid, 'recommendations', input);
      if (!lockKey) {
        res.status(409).json({
          error: 'A recommendations request with these parameters is already in progress.',
          code: 'DUPLICATE_REQUEST',
        });
        return;
      }

      const items = await aiService.getRecommendations(input);
      res.status(200).json({
        ok: true,
        model: getConfiguredGeminiModel(),
        uid,
        data: { recommendations: items },
      });
    } catch (err) {
      handleRouteError(err, res, next);
    } finally {
      rateLimiter.releaseDuplicateLock(lockKey);
    }
  });

  router.post('/estimate-budget', async (req: Request, res: Response, next: NextFunction) => {
    const uid = req.auth!.uid;
    let lockKey: string | null = null;
    try {
      const input = validateEstimateBudgetInput(req.body);
      lockKey = rateLimiter.acquireDuplicateLock(uid, 'estimate-budget', input);
      if (!lockKey) {
        res.status(409).json({
          error: 'A budget estimation request is already in progress.',
          code: 'DUPLICATE_REQUEST',
        });
        return;
      }

      const data = await aiService.estimateBudget(input);
      res.status(200).json({
        ok: true,
        model: getConfiguredGeminiModel(),
        uid,
        data,
      });
    } catch (err) {
      handleRouteError(err, res, next);
    } finally {
      rateLimiter.releaseDuplicateLock(lockKey);
    }
  });

  router.post('/refine-activity', async (req: Request, res: Response, next: NextFunction) => {
    const uid = req.auth!.uid;
    let lockKey: string | null = null;
    try {
      const input = validateRefineActivityInput(req.body);
      lockKey = rateLimiter.acquireDuplicateLock(uid, 'refine-activity', input);
      if (!lockKey) {
        res.status(409).json({
          error: 'This activity is already being refined. Please wait.',
          code: 'DUPLICATE_REQUEST',
        });
        return;
      }

      const data = await aiService.refineActivity(input);
      res.status(200).json({
        ok: true,
        model: getConfiguredGeminiModel(),
        uid,
        data,
      });
    } catch (err) {
      handleRouteError(err, res, next);
    } finally {
      rateLimiter.releaseDuplicateLock(lockKey);
    }
  });

  return router;
}
