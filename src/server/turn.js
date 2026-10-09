// Credenziali TURN temporanee nel formato "REST API" di coturn (use-auth-secret).
import crypto from 'node:crypto';

export function turnCredentials({ secret, id, ttlSec = 86400, now = Date.now() }) {
  const expiry = Math.floor(now / 1000) + ttlSec;
  const username = `${expiry}:${id}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

export function buildIceServers({ stunUrls = [], turnUrls = [], turnSecret = '', id, ttlSec, now }) {
  const servers = [];
  if (stunUrls.length) servers.push({ urls: [...stunUrls] });
  if (turnUrls.length && turnSecret) {
    servers.push({ urls: [...turnUrls], ...turnCredentials({ secret: turnSecret, id, ttlSec, now }) });
  }
  return servers;
}
