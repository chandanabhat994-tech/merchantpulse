import { createApp } from './app.js';
import { CaseStore } from './agent/store.js';

const port = Number(process.env.PORT || 3000);
const store = new CaseStore({ file: process.env.CASES_FILE || 'data/cases.json' });
const { app } = createApp({ store, retryDelayMs: Number(process.env.RETRY_DELAY_MS ?? 200) });

app.listen(port, () => {
  console.log(`MerchantPulse AI running at http://localhost:${port}  (synthetic data, mock APIs)`);
});
