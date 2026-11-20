import http from 'node:http';
import path from 'node:path';

import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';

import { createControlPlaneApp } from './control-plane/server/index.ts';

dotenv.config();

const PORT = Number(process.env.PORT ?? 3000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

async function startServer(): Promise<void> {
  const bundle = createControlPlaneApp({
    stateDir: process.env.TEJAURA_STATE_DIR || '.tejaura-state',
    environment: IS_PRODUCTION ? 'production' : 'development',
  });

  // Recover abandoned worker leases from prior crash/restart and start worker loop.
  bundle.orchestrator.startWorkerLoop(1500);

  if (!IS_PRODUCTION) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'custom',
    });
    bundle.app.use(vite.middlewares);

    bundle.app.use(async (req: Request, res: Response, next) => {
      if (req.path.startsWith('/api')) {
        next();
        return;
      }
      try {
        const fs = await import('node:fs');
        const indexHtml = fs.readFileSync(
          path.resolve(process.cwd(), 'index.html'),
          'utf8',
        );
        const transformed = await vite.transformIndexHtml(
          req.originalUrl,
          indexHtml,
        );
        res.status(200).setHeader('Content-Type', 'text/html').end(transformed);
      } catch (err) {
        vite.ssrFixStacktrace(err as Error);
        next(err);
      }
    });
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    bundle.app.use(express.static(distDir));
    bundle.app.get('*splat', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const server = http.createServer(bundle.app);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[TEJAURA Control Plane] Listening on http://0.0.0.0:${PORT} (mode=${IS_PRODUCTION ? 'production' : 'development'})`,
    );
  });

  const shutdown = (): void => {
    bundle.close();
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startServer().catch((err) => {
  console.error('[TEJAURA Control Plane] Startup failed:', err);
  process.exit(1);
});
