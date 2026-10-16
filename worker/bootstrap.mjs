import { readSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Read exactly one bounded header. Never buffer or parse the model's remaining stdin.
export function readCredential(fd) {
  const bytes = Buffer.alloc(8193);
  try {
    for (let length = 0; length < bytes.length; length++) {
      if (readSync(fd, bytes, length, 1, null) !== 1) break;
      const byte = bytes[length];
      if (byte === 10 && length > 0) return bytes.toString('ascii', 0, length);
      if (byte < 33 || byte > 126) break;
    }
    throw new Error('credential_handoff_failed');
  } finally { bytes.fill(0); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const token = readCredential(0);
    process.execve('/usr/local/bin/claude', ['claude', ...process.argv.slice(2)], { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token });
  } catch {
    process.stderr.write('credential_handoff_failed\n');
    process.exitCode = 1;
  }
}
