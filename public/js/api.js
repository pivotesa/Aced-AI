import { getIdToken } from './firebase.js';

async function apiFetch(path, body) {
  const token = await getIdToken();
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.code = data.code || null;
    throw err;
  }

  return data;
}

export async function generatePaper(subject, paper, mode, topic) {
  return apiFetch('/api/generate-paper', { subject, paper, mode, topic });
}

export async function markPaper(paperJSON, answers) {
  return apiFetch('/api/mark-paper', { paperJSON, answers });
}

export async function sendTutorMessage(messages, paperJSON, subject, paper) {
  return apiFetch('/api/tutor-message', { messages, paperJSON, subject, paper });
}

export async function createSubscription() {
  return apiFetch('/api/create-subscription', {});
}

export async function subscriptionWebhook(data) {
  return apiFetch('/api/subscription-webhook', data);
}
