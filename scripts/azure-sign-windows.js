const fs = require('fs');
const { execFileSync } = require('child_process');

function runSigntool(args) {
  return execFileSync('signtool.exe', args, { stdio: 'pipe', encoding: 'utf8' });
}

function logProcessError(label, error) {
  console.error(`${label} failed: ${error.message}`);
  if (error.stdout) console.error(`${label} stdout:\n${error.stdout.toString()}`);
  if (error.stderr) console.error(`${label} stderr:\n${error.stderr.toString()}`);
}

// signtool only signs Windows PE files. Some packages ship native modules for
// every OS (get-windows bundles its macOS .node), so those are skipped.
function isWindowsBinary(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(2);
    return fs.readSync(fd, header, 0, 2, 0) === 2 && header.toString('latin1') === 'MZ';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function shouldSkipSigning(file) {
  const isCi = process.env.GITHUB_ACTIONS === 'true';

  if (!isCi && process.env.SIGN_WINDOWS !== 'true') {
    console.log('Skipping Windows signing in local development (SIGN_WINDOWS is not "true")');
    return true;
  }

  if (process.env.SKIP_WINDOWS_SIGNING === 'true') {
    console.warn(
      `WARNING: Skipping Azure Trusted Signing for ${file} ` +
        '(SKIP_WINDOWS_SIGNING=true). The artifact will be unsigned and trigger SmartScreen warnings on install.',
    );
    return true;
  }

  return false;
}

function signFile(file) {
  const dlibPath = process.env.AZURE_SIGN_DLIB;
  const metadataPath = process.env.AZURE_SIGN_METADATA;

  if (!dlibPath) {
    throw new Error('Build failed: AZURE_SIGN_DLIB environment variable is not set');
  }
  if (!metadataPath) {
    throw new Error('Build failed: AZURE_SIGN_METADATA environment variable is not set');
  }
  if (!fs.existsSync(dlibPath)) {
    throw new Error(`Build failed: Azure Trusted Signing dlib not found at ${dlibPath}`);
  }
  if (!fs.existsSync(metadataPath)) {
    throw new Error(`Build failed: Signing metadata file not found at ${metadataPath}`);
  }
  if (!fs.existsSync(file)) {
    throw new Error(`Build failed: file to sign not found at ${file}`);
  }
  if (!isWindowsBinary(file)) {
    console.log(`Skipping signing for a non-Windows binary: ${file}`);
    return;
  }

  console.log(`Signing via Azure Trusted Signing: ${file}`);

  try {
    const output = runSigntool([
      'sign',
      '/v',
      '/debug',
      '/fd', 'SHA256',
      '/tr', 'http://timestamp.acs.microsoft.com',
      '/td', 'SHA256',
      '/dlib', dlibPath,
      '/dmdf', metadataPath,
      file,
    ]);
    if (output) console.log(output);
  } catch (error) {
    logProcessError('signtool sign', error);
    throw new Error(`Build failed: signtool sign failed for ${file}`);
  }

  try {
    const output = runSigntool(['verify', '/pa', '/v', file]);
    if (output) console.log(output);
  } catch (error) {
    logProcessError('signtool verify', error);
    throw new Error(`Build failed: signtool verify failed for ${file}`);
  }
}

async function signConfiguration(configuration) {
  const file = configuration.path;

  if (shouldSkipSigning(file)) {
    return true;
  }

  signFile(file);

  return true;
}

exports.signFile = signFile;
exports.isWindowsBinary = isWindowsBinary;
exports.default = signConfiguration;

if (require.main === module) {
  const files = process.argv.slice(2);

  if (files.length === 0) {
    console.error('Usage: node scripts/azure-sign-windows.js <file> [file...]');
    process.exit(1);
  }

  try {
    for (const file of files) {
      if (!shouldSkipSigning(file)) {
        signFile(file);
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
