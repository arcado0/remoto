// Limitatori usati dal server (anti-flood) e dall'host (anti brute-force).

export class TokenBucket {
  constructor({ capacity, refillPerSec, now = Date.now }) {
    this.capacity = capacity;
    this.refillPerMs = refillPerSec / 1000;
    this.now = now;
    this.tokens = capacity;
    this.last = now();
  }

  take(n = 1) {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.refillPerMs);
    this.last = t;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/** Conta gli eventi per chiave in una finestra scorrevole. */
export class SlidingWindowCounter {
  constructor({ windowMs, limit, now = Date.now }) {
    this.windowMs = windowMs;
    this.limit = limit;
    this.now = now;
    this.hits = new Map();
  }

  #recent(key) {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) || []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Registra un evento; false se il limite è già stato raggiunto (l'evento non viene contato). */
  hit(key) {
    const list = this.#recent(key);
    if (list.length >= this.limit) return false;
    list.push(this.now());
    this.hits.set(key, list);
    return true;
  }

  count(key) {
    return this.#recent(key).length;
  }

  reset(key) {
    this.hits.delete(key);
  }

  prune() {
    for (const key of [...this.hits.keys()]) this.#recent(key);
  }
}

/** Blocca una chiave dopo `maxFailures` errori entro `windowMs`, per `lockMs`. */
export class Lockout {
  constructor({ maxFailures, windowMs, lockMs, now = Date.now }) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.lockMs = lockMs;
    this.now = now;
    this.failures = new Map();
    this.lockedUntil = new Map();
  }

  /** Millisecondi di blocco rimanenti (0 = libero). */
  remaining(key) {
    const until = this.lockedUntil.get(key) || 0;
    const left = until - this.now();
    if (left <= 0) {
      this.lockedUntil.delete(key);
      return 0;
    }
    return left;
  }

  /** Registra un errore. Restituisce quanti tentativi restano prima del blocco. */
  fail(key) {
    const cutoff = this.now() - this.windowMs;
    const list = (this.failures.get(key) || []).filter((t) => t > cutoff);
    list.push(this.now());
    if (list.length >= this.maxFailures) {
      this.failures.delete(key);
      this.lockedUntil.set(key, this.now() + this.lockMs);
      return 0;
    }
    this.failures.set(key, list);
    return this.maxFailures - list.length;
  }

  success(key) {
    this.failures.delete(key);
  }
}
