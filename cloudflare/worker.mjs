import { WorkerEntrypoint } from 'cloudflare:workers';
import { gateway, fillPublicCache } from './cache-core.mjs';

export default {
  fetch(request, env, ctx) {
    return gateway(request, ctx);
  },
};

// Native Workers Cache provides shared upper-tier fills and request collapsing.
// The uncached gateway strips irrelevant parameters before this entrypoint runs.
export class PublicCache extends WorkerEntrypoint {
  fetch(request) {
    return fillPublicCache(request, this.ctx);
  }
}
