// backend/server.ts

import express from 'express';
import cors from 'cors';
import { apiRouter } from './api';

const app = express();

app.use(cors());
app.use(express.json());

app.use('/', apiRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'bellum-penumbrum-api' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`[Bellum Penumbrum API] in ascolto su porta ${PORT}`);
});
