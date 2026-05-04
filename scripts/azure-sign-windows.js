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

exports.default = async function (configuration) {
  const isCi = process.env.GITHUB_ACTIONS === 'true';

  if (!isCi && process.env.SIGN_WINDOWS !== 'true') {
    console.log('Skipping Windows signing in local development (SIGN_WINDOWS is not "true")');
    return true;
  }

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

  const file = configuration.path;
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

  return true;
};
