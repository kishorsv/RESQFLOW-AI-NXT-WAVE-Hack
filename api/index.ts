import type { IncomingMessage, ServerResponse } from 'node:http';
import app from '../server.ts';

export default function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.url) {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      const forwardedPath = parsed.searchParams.get('__vercel_path');
      if (forwardedPath) {
        parsed.searchParams.delete('__vercel_path');
        const safePath = forwardedPath.startsWith('/') ? forwardedPath : `/${forwardedPath}`;
        const qs = parsed.searchParams.toString();
        const restoredUrl = qs ? `${safePath}?${qs}` : safePath;
        req.url = restoredUrl;
        (req as IncomingMessage & { originalUrl?: string }).originalUrl = restoredUrl;
      }
    } catch {
      // Leave req.url intact if URL parsing fails
    }
  }
  return app(req as any, res as any);
}
