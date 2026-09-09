import { readStdin } from './relay-stdin.ts';
import type { StdinLike } from './relay-stdin.ts';
import { postPayload } from './loopback-post.ts';

async function main(
  argv: string[] = process.argv.slice(2),
  stdin: StdinLike = process.stdin,
): Promise<number> {
  const [postUrl] = argv;
  const body = await readStdin(stdin);
  if (!postUrl) return 0;
  await postPayload(postUrl, body);
  return 0;
}

if (process.argv[1] === import.meta.filename) {
  main().then((code) => process.exit(code)).catch(() => process.exit(0));
}

export { main };
