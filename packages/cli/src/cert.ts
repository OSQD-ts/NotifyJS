import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces, hostname } from 'node:os';

export interface CertResult {
  certPath: string;
  keyPath: string;
  hosts: string[];
}

/**
 * Generates a self-signed certificate for the hub.
 *
 * SECURITY.md says to run TLS, which is easy advice to give and tedious to
 * follow - so this does the tedious part. It shells out to openssl rather than
 * hand-rolling ASN.1: certificate generation is not something to improvise,
 * and openssl is present nearly everywhere.
 *
 * The certificate is self-signed, so clients must be told to trust it. That is
 * still meaningfully better than plaintext, which lets anyone on the path read
 * your alerts and race you to a live pairing code.
 */
export async function generateSelfSigned(
  outDir: string,
  extraHosts: string[] = [],
  days = 825,
): Promise<CertResult> {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });

  const certPath = join(outDir, 'notifyjs-cert.pem');
  const keyPath = join(outDir, 'notifyjs-key.pem');

  // A phone connects by IP, so the address has to be in the SAN list or the
  // handshake fails no matter how the certificate is trusted.
  const hosts = [...new Set(['localhost', hostname(), ...localAddresses(), ...extraHosts])];
  const san = hosts
    .map((host, i) => (isIp(host) ? `IP.${i} = ${host}` : `DNS.${i} = ${host}`))
    .join('\n');

  const configPath = join(outDir, 'openssl.cnf');
  writeFileSync(
    configPath,
    `[req]
distinguished_name = dn
x509_extensions = v3
prompt = no

[dn]
CN = NotifyJS

[v3]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt

[alt]
${san}
`,
    { mode: 0o600 },
  );

  await openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    String(days),
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-config',
    configPath,
  ]);

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    throw new Error('openssl reported success but produced no certificate');
  }

  // The private key must not be world-readable; openssl's umask is not tight
  // enough to rely on.
  chmodSync(keyPath, 0o600);
  return { certPath, keyPath, hosts };
}

function openssl(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('openssl', args, (err, _stdout, stderr) => {
      if (!err) return resolve();
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      reject(
        new Error(
          missing
            ? 'openssl was not found. Install it, or supply your own certificate with --tls-cert and --tls-key.'
            : `openssl failed: ${String(stderr).trim() || err.message}`,
        ),
      );
    });
  });
}

function localAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4') out.push(entry.address);
    }
  }
  return out;
}

function isIp(value: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
}
