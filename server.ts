import 'dotenv/config';
import express, { Express, NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AiRouterDeps, createAiRouter } from './server/routes/aiRoutes';
import { getConfiguredGeminiModel, isGeminiConfigured } from './server/services/geminiService';

export function resolveAppPort(): number {
  const isProd = process.env.NODE_ENV === 'production';
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      const parsed = Number(argv[i + 1]);
      if (Number.isInteger(parsed) && parsed > 0 && (isProd || parsed !== 8080)) return parsed;
    }
    if (arg.startsWith('--port=')) {
      const parsed = Number(arg.slice('--port='.length));
      if (Number.isInteger(parsed) && parsed > 0 && (isProd || parsed !== 8080)) return parsed;
    }
  }

  const apiPort = Number(process.env.API_PORT);
  if (Number.isInteger(apiPort) && apiPort > 0 && (isProd || apiPort !== 8080)) {
    return apiPort;
  }

  // In Cloud Run production, honor injected PORT (including 8080).
  // In AI Studio dev preview, nginx owns 8080 so dev skips 8080 and falls back to 3000.
  const envPort = Number(process.env.PORT);
  if (Number.isInteger(envPort) && envPort > 0 && (isProd || envPort !== 8080)) {
    return envPort;
  }

  return 3000;
}

export function createApp(deps: AiRouterDeps = {}): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use(express.json({ limit: '64kb' }));

  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: 'tripmate-backend',
      timestamp: new Date().toISOString(),
      geminiConfigured: isGeminiConfigured(),
      geminiModel: getConfiguredGeminiModel(),
    });
  });

  app.use('/api/ai', createAiRouter(deps));

  // Unmatched /api/* routes always return JSON 404 rather than falling through to SPA HTML
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({
      error: 'API endpoint not found.',
      code: 'NOT_FOUND',
    });
  });

  // Central JSON error handler (handles oversized / malformed JSON and unexpected errors safely)
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const anyErr = err as { type?: string; status?: number; statusCode?: number; message?: string };
    if (anyErr?.type === 'entity.too.large') {
      res.status(413).json({
        error: 'Request payload exceeds the 64 KB size limit.',
        code: 'PAYLOAD_TOO_LARGE',
      });
      return;
    }
    if (anyErr?.type === 'entity.parse.failed' || anyErr?.status === 400) {
      res.status(400).json({
        error: 'Invalid JSON request body.',
        code: 'INVALID_JSON',
      });
      return;
    }

    const safeLogMessage = String(anyErr?.message || 'Unknown error')
      .replace(/AIza[0-9A-Za-z_-]+/g, '[REDACTED]')
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
    console.error(`[TripMate API Error] ${req.method} ${req.path}:`, safeLogMessage);
    res.status(500).json({
      error: 'Internal server error while processing request.',
      code: 'INTERNAL_ERROR',
    });
  });

  return app;
}

async function startServer() {
  const app = createApp();
  const isProd = process.env.NODE_ENV === 'production';
  const port = resolveAppPort();
  const rootDir = process.cwd();

  let viteServer: { close: () => Promise<void> } | null = null;

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      root: rootDir,
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    viteServer = vite;
  } else {
    const distDir = path.join(rootDir, 'dist');
    const indexHtml = path.join(distDir, 'index.html');
    app.use(
      express.static(distDir, {
        index: false,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      })
    );
    app.get('*', (_req: Request, res: Response) => {
      if (fs.existsSync(indexHtml)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.sendFile(indexHtml);
      } else {
        res.status(503).send('Production build not found. Run npm run build first.');
      }
    });
  }

  const server: http.Server = app.listen(port, '0.0.0.0', () => {
    console.log(
      `TripMate server listening on http://0.0.0.0:${port} (${isProd ? 'production' : 'development'})`
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down TripMate server gracefully...`);
    server.close(async () => {
      if (viteServer) {
        try {
          await viteServer.close();
        } catch {
          // ignore vite close errors
        }
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

const isMainEntry =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainEntry) {
  startServer().catch((err) => {
    console.error('Failed to start TripMate server:', err);
    process.exit(1);
  });
}
