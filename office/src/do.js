import { migrate, ingestRecord, snapshot, resolveRequest, sessionGeneration, bumpSession } from './store.js';

export class Office {
  constructor(ctx) {
    this.sql = ctx.storage.sql;
    const ready = () => migrate(this.sql);
    if (typeof ctx.blockConcurrencyWhile === 'function') ctx.blockConcurrencyWhile(ready);
    else ready();
  }

  async fetch(input, init) {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    try {
      if (url.pathname === '/ingest' && request.method === 'POST') {
        const { rec, at } = await request.json();
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return Response.json({ error: 'bad_json' }, { status: 400 });
        const result = ingestRecord(this.sql, rec, typeof at === 'string' ? at : new Date().toISOString());
        return Response.json(result, { status: 202 });
      }
      if (url.pathname === '/session-gen' && request.method === 'GET') {
        return Response.json({ gen: sessionGeneration(this.sql) });
      }
      if (url.pathname === '/session-gen' && request.method === 'POST') {
        return Response.json({ gen: bumpSession(this.sql) });
      }
      if (url.pathname === '/snapshot') {
        return Response.json(snapshot(this.sql, Date.now()));
      }
      if (url.pathname === '/resolve' && request.method === 'POST') {
        const { id, by, at } = await request.json();
        const result = resolveRequest(this.sql, id, by, typeof at === 'string' ? at : new Date().toISOString());
        return Response.json(result, { status: result.resolved ? 200 : 404 });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    } catch {
      return Response.json({ error: 'server' }, { status: 500 });
    }
  }
}
