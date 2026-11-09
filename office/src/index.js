import { handle } from './worker.js';
import { Office } from './do.js';

export { Office };

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};
