import cors from 'cors';
import express, { type Request, type Response } from 'express';
import { apiRouter } from './api.js';

const app = express();

app.use(
  cors({
    origin: [
      'https://frazecc.github.io',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  }),
);

app.use(express.json({ limit: '1mb' }));

app.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    service: 'bellum-penumbrum-api',
    status: 'online',
  });
});

app.use('/', apiRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: 'Endpoint non trovato',
  });
});

const port = Number(process.env.PORT ?? 3000);

app.listen(port, '0.0.0.0', () => {
  console.log(`Bellum Penumbrum API in ascolto sulla porta ${port}`);
});
