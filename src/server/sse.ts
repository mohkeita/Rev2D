/**
 * Server-sent events hub for GET /api/events: one long-lived response per editor tab / AI watcher.
 * Every event is `event: <name>\ndata: <single-line JSON>\n\n`; comment lines keep proxies and
 * idle-connection timeouts from closing quiet streams.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export class SseHub {
  private readonly clients = new Set<ServerResponse>();
  private readonly keepAlive: NodeJS.Timeout;

  constructor(keepAliveMs = 15_000) {
    this.keepAlive = setInterval(() => {
      for (const res of this.clients) res.write(': keep-alive\n\n');
    }, keepAliveMs);
    this.keepAlive.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  /** Turn `res` into an event stream and send the first event to it. */
  open(req: IncomingMessage, res: ServerResponse, first: { event: string; data: unknown }): void {
    // The client may have gone while the first event was prepared; its 'close' events already fired.
    if (res.destroyed || req.socket.destroyed || !req.socket.writable) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1000\n\n');
    res.write(frame(first.event, first.data));
    this.clients.add(res);
    const drop = () => this.clients.delete(res);
    req.once('close', drop);
    res.once('close', drop);
  }

  /** Send an event to every connected client; returns how many received it. */
  broadcast(event: string, data: unknown): number {
    const text = frame(event, data);
    for (const res of this.clients) res.write(text);
    return this.clients.size;
  }

  close(): void {
    clearInterval(this.keepAlive);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
