import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Case + audit persistence. In-memory, optionally mirrored to a JSON file. */
export class CaseStore {
  constructor({ file = null } = {}) {
    this.file = file;
    this.cases = new Map();
    this.counter = 0;
    if (file && existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      this.counter = data.counter || 0;
      for (const c of data.cases || []) this.cases.set(c.id, c);
    }
  }

  nextId() {
    this.counter += 1;
    return `CASE-${String(this.counter).padStart(4, '0')}`;
  }

  put(c) {
    this.cases.set(c.id, c);
    this._persist();
    return c;
  }

  get(id) {
    return this.cases.get(id) ?? null;
  }

  list() {
    return [...this.cases.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  clear() {
    this.cases.clear();
    this.counter = 0;
    this._persist();
  }

  _persist() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ counter: this.counter, cases: [...this.cases.values()] }, null, 2));
  }
}
