import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import generatePaperHandler from './api/generate-paper.js';
import markPaperHandler from './api/mark-paper.js';
import tutorMessageHandler from './api/tutor-message.js';
import createSubscriptionHandler from './api/create-subscription.js';
import subscriptionWebhookHandler from './api/subscription-webhook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/generate-paper',       generatePaperHandler);
app.post('/api/mark-paper',           markPaperHandler);
app.post('/api/tutor-message',        tutorMessageHandler);
app.post('/api/create-subscription',  createSubscriptionHandler);
app.post('/api/subscription-webhook', subscriptionWebhookHandler);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Aced AI running on port ${PORT}`));
