// api/index.js (ESM)
import serverless from 'serverless-http';
import app from '../server.js';

export default serverless(app);
