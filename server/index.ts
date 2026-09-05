import { recoverHandoff } from '../scripts/recover-handoff.mjs';
import { packageRoot } from './runtime-paths.ts';

recoverHandoff(packageRoot);

await import('./main.ts');
