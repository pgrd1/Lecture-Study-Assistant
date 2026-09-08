import { app } from 'electron';
import { bootstrap } from './bootstrap';

void bootstrap().catch(() => {
  console.error('앱을 시작하지 못했습니다. 코드: BOOTSTRAP_FAILED');
  app.exit(1);
});
