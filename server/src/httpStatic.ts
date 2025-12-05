import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function mountStatic(app: express.Express) {
  const publicDir = path.resolve(__dirname, '../../public');
  app.use('/', express.static(publicDir));
  const cardsDir = path.resolve(__dirname, '../../cards');
  app.use('/cards', express.static(cardsDir));
}


