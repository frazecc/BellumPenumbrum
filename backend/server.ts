import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { apiRouter } from './api.js';

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use('/', apiRouter);

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: 'bellum-penumbrum-api' });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, '0.0.0.0', () => {
  console.log(`Bellum Penumbrum API listening on ${port}`);
});
