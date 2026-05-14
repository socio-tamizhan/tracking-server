import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import trackRouter from './routes/track.js';
import { browserManager } from './scraper/browser.js';
import { ALL_COURIERS } from './couriers/index.js';
import { openApiSpec } from './openapi.js';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(cors());
app.use(express.json());

// ── Swagger UI ────────────────────────────────────────────────────────────
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, {
  customSiteTitle: 'Courier Tracking API',
  swaggerOptions: { defaultModelsExpandDepth: -1, tryItOutEnabled: true },
}));

// ── Health ────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', couriers: ALL_COURIERS.map((c) => c.slug) });
});

// ── Couriers list ─────────────────────────────────────────────────────────
app.get('/couriers', (_req, res) => {
  res.json(
    ALL_COURIERS.map((c) => ({
      slug: c.slug,
      name: c.name,
      patterns: c.patterns.map((p) => p.toString()),
    })),
  );
});

// ── Tracking ──────────────────────────────────────────────────────────────
app.use('/track', trackRouter);

// ── 404 ───────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: 'Route not found' });
});

// ── Start ─────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`Courier Tracking API listening on http://localhost:${PORT}`);
  console.log(`Swagger UI: http://localhost:${PORT}/docs`);
  console.log(`Supported couriers: ${ALL_COURIERS.map((c) => c.name).join(', ')}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────
async function shutdown() {
  console.log('\nShutting down...');
  await browserManager.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export default app;
