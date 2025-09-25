// api/[...all].js  (ESM)
import serverless from 'serverless-http';
import app from '../server.js';     // uses the app you just exported

export const config = { runtime: 'nodejs20.x' }; // ensure Node runtime (not Edge)

export default serverless(app);
